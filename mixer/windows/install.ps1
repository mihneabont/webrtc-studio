# Installs or updates the Studio Mixer for the current user, starts it, and starts it again at every sign-in.
# The studio page's "Install the mixer" button downloads a small .cmd that fetches and runs this file:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Source https://<site>/mixer/ [-Uninstall]
param([Parameter(Mandatory = $true)][string]$Source, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is many times slower with the progress bar
$Source = $Source.TrimEnd('/') + '/'
$Data = Join-Path $env:LOCALAPPDATA 'StudioMixer'
$App = Join-Path $Data 'app'
$Py = Join-Path $App '.venv\Scripts\python.exe'
$Startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Studio Mixer.lnk'
$Port = 8788
$MtxVersion = 'v1.21.2'
$CfVersion = '2026.9.3' # cloudflared: the mixer's https address (Cloudflare quick tunnel)
$Files = 'studio_mixer/__init__.py', 'studio_mixer/__main__.py', 'studio_mixer/config.py', 'studio_mixer/host.py',
    'studio_mixer/ingest.py', 'studio_mixer/media.py', 'studio_mixer/mtx.py', 'studio_mixer/outputs.py',
    'studio_mixer/program.py', 'studio_mixer/publisher.py', 'studio_mixer/scene.py', 'studio_mixer/server.py',
    'studio_mixer/tunnel.py', 'windows/requirements.txt', 'windows/firewall.ps1'

function Stop-Mixer {
    Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe' OR Name='mediamtx.exe' OR Name='cloudflared.exe'" |
        Where-Object { $_.CommandLine -like '*studio_mixer*' -or $_.ExecutablePath -like "$App\*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Find-Python {
    foreach ($v in '3.13', '3.12') {
        try {
            $exe = & py "-$v" -c 'import sys; print(sys.executable)' 2>$null
            if ($LASTEXITCODE -eq 0 -and $exe) { return $exe.Trim() }
        } catch {}
    }
    foreach ($dir in "$env:LOCALAPPDATA\Programs\Python\Python313", "$env:LOCALAPPDATA\Programs\Python\Python312") {
        if (Test-Path "$dir\python.exe") { return "$dir\python.exe" }
    }
    return $null
}

function Find-Ffmpeg {
    $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $wg = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet'
    if (Test-Path "$wg\Links\ffmpeg.exe") { return "$wg\Links\ffmpeg.exe" }
    $found = Get-ChildItem "$wg\Packages" -Directory -Filter '*FFmpeg*' -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ChildItem $_.FullName -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue } | Select-Object -First 1
    if ($found) { return $found.FullName }
    return $null
}

if ($Uninstall) {
    Write-Host '== Removing the Studio Mixer ==' -ForegroundColor Cyan
    Stop-Mixer
    Remove-Item -Force -ErrorAction SilentlyContinue $Startup
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue 'HKCU:\Software\Classes\studio-mixer'
    if (Test-Path "$App\windows\firewall.ps1") { & "$App\windows\firewall.ps1" -Remove }
    Start-Sleep -Seconds 2
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $App
    Write-Host "Removed. Your settings and logs are kept in $Data (delete that folder to remove them too)."
    exit 0
}

Write-Host '== Studio Mixer setup ==' -ForegroundColor Cyan
Stop-Mixer

# The mixer replaces the older helper, which used the same port.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*WebRTCStudioHelper*' -or $_.CommandLine -like '*signaling-server*server.mjs*' } |
    ForEach-Object { Write-Host 'Stopping the old WebRTC Studio helper (the mixer replaces it)...'; Stop-Process -Id $_.ProcessId -Force }
$oldHelper = Join-Path ([Environment]::GetFolderPath('Startup')) 'WebRTC Studio helper.vbs'
if (Test-Path $oldHelper) { Remove-Item -Force $oldHelper }

Write-Host "Downloading the mixer from $Source"
foreach ($f in $Files) {
    $dest = Join-Path $App ($f -replace '/', '\')
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    Invoke-WebRequest -UseBasicParsing ($Source + $f) -OutFile $dest
}

$python = Find-Python
if (-not $python) {
    Write-Host 'Installing Python 3.13 (for your user only)...'
    winget install --id Python.Python.3.13 --scope user --silent --accept-package-agreements --accept-source-agreements
    $python = Find-Python
    if (-not $python) { throw 'Python did not install. Install Python 3.13 from python.org and run this setup again.' }
}
Write-Host "Python: $python"
if (-not (Test-Path $Py)) {
    Write-Host 'Creating the Python environment...'
    & $python -m venv (Join-Path $App '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python environment.' }
}
Write-Host 'Installing GStreamer (about 400 MB the first time)...'
& $Py -m pip install --disable-pip-version-check --quiet --upgrade pip
& $Py -m pip install --disable-pip-version-check -r (Join-Path $App 'windows\requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Installing the Python packages failed (see the messages above).' }

$mtx = Join-Path $App 'bin\mediamtx.exe'
$mtxStamp = Join-Path $App "bin\mediamtx-$MtxVersion"
if (-not (Test-Path $mtxStamp)) {
    Write-Host "Downloading MediaMTX $MtxVersion..."
    New-Item -ItemType Directory -Force -Path (Split-Path $mtx) | Out-Null
    $zip = Join-Path $env:TEMP "mediamtx_$MtxVersion.zip"
    Invoke-WebRequest -UseBasicParsing "https://github.com/bluenviron/mediamtx/releases/download/$MtxVersion/mediamtx_${MtxVersion}_windows_amd64.zip" -OutFile $zip
    $tmp = Join-Path $env:TEMP "mediamtx_$MtxVersion"
    Expand-Archive -Force $zip $tmp
    Copy-Item -Force "$tmp\mediamtx.exe" $mtx
    New-Item -ItemType File -Force -Path $mtxStamp | Out-Null
}

# Studio pages are on https and can't call a plain http mixer on another address, so the
# mixer opens a free Cloudflare quick tunnel at start and shows its https address.
$cf = Join-Path $App 'bin\cloudflared.exe'
$cfStamp = Join-Path $App "bin\cloudflared-$CfVersion"
if (-not (Test-Path $cfStamp)) {
    Write-Host "Downloading cloudflared $CfVersion (gives the mixer an https address)..."
    Invoke-WebRequest -UseBasicParsing "https://github.com/cloudflare/cloudflared/releases/download/$CfVersion/cloudflared-windows-amd64.exe" -OutFile $cf
    Get-ChildItem (Join-Path $App 'bin') -Filter 'cloudflared-*' | Remove-Item -Force -ErrorAction SilentlyContinue
    New-Item -ItemType File -Force -Path $cfStamp | Out-Null
}

if (-not (Find-Ffmpeg)) {
    Write-Host 'Installing ffmpeg (sends RTMP, SRT and WHIP outputs)...'
    winget install --id Gyan.FFmpeg.Essentials -e --silent --accept-source-agreements --accept-package-agreements
    if (-not (Find-Ffmpeg)) { Write-Host 'ffmpeg did not install. Mixing works; outputs need it (winget install Gyan.FFmpeg.Essentials).' -ForegroundColor Yellow }
}

Write-Host 'Checking the media engine...'
$check = @'
import gi
gi.require_version("Gst", "1.0")
from gi.repository import Gst
Gst.init(None)
need = ["x264enc", "avdec_h264", "rtspsrc", "decodebin", "srtsink", "mpegtsmux", "compositor", "audiomixer", "level",
        "intervideosrc", "intervideosink", "interaudiosrc", "interaudiosink", "opusenc", "avenc_aac", "pngdec", "imagefreeze", "smptealpha"]
missing = [n for n in need if not Gst.ElementFactory.find(n)]
hw = [n for n in ("qsvh264enc", "nvh264enc", "amfh264enc", "mfh264enc") if Gst.ElementFactory.find(n)]
print("GStreamer", Gst.version_string(), "| hardware encoders:", ", ".join(hw) or "none", "| missing:", ", ".join(missing) or "none")
raise SystemExit(1 if missing else 0)
'@
$checkFile = Join-Path $env:TEMP 'studio-mixer-check.py'
Set-Content -Path $checkFile -Value $check -Encoding ASCII
& $Py $checkFile
if ($LASTEXITCODE -ne 0) { throw 'The media engine is missing parts (see above).' }

# Runs without a window. PYTHONPATH points at the app folder so "-m studio_mixer" finds the code.
$vbs = Join-Path $App 'start.vbs'
Set-Content -Path $vbs -Encoding ASCII -Value @"
Set sh = CreateObject("WScript.Shell")
sh.Environment("Process")("PYTHONPATH") = "$App"
sh.CurrentDirectory = "$App"
sh.Run """$App\.venv\Scripts\pythonw.exe"" -m studio_mixer", 0, False
"@
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($Startup)
$lnk.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$lnk.Arguments = "`"$vbs`""
$lnk.WorkingDirectory = $App
$lnk.Save()
# Lets the studio page start the mixer (it opens studio-mixer://start).
$key = 'HKCU:\Software\Classes\studio-mixer'
New-Item -Force -Path "$key\shell\open\command" | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value 'URL:Studio Mixer'
Set-ItemProperty -Path $key -Name 'URL Protocol' -Value ''
Set-ItemProperty -Path "$key\shell\open\command" -Name '(default)' -Value "`"$env:SystemRoot\System32\wscript.exe`" `"$vbs`""

Write-Host 'Allowing the studio, OBS and phones on your network to connect (Windows asks for admin once)...'
try { & (Join-Path $App 'windows\firewall.ps1') } catch { Write-Host 'Firewall rules were not added. Devices on this computer still work.' -ForegroundColor Yellow }

Write-Host 'Starting the mixer...'
& "$env:SystemRoot\System32\wscript.exe" $vbs
$up = $false
for ($i = 0; $i -lt 40 -and -not $up; $i++) {
    Start-Sleep -Milliseconds 500
    try { Invoke-WebRequest -UseBasicParsing "http://localhost:$Port/api/info" | Out-Null; $up = $true } catch {}
}
if ($up) {
    Write-Host ''
    Write-Host 'The Studio Mixer is running.' -ForegroundColor Green
    Write-Host 'Go back to the studio page: Settings, Studio Mixer, Connect to it.'
    Start-Process "http://localhost:$Port/"
} else {
    Write-Host "The mixer did not answer yet. Its log is in $Data\mixer.log." -ForegroundColor Yellow
}
