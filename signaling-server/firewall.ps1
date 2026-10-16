# Lets devices on your local network reach the WebRTC Studio helper and send media to the studio page.
# Run as admin (the helper installer does this for you). -Remove deletes the rules again.
param([int]$Port = 8788, [switch]$Remove)
Get-NetFirewallRule -DisplayName 'WebRTC Studio helper*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($Remove) { return }
$common = @{ Direction = 'Inbound'; Action = 'Allow'; Profile = 'Any'; RemoteAddress = 'LocalSubnet' }
# The helper only receives the encoder's HTTP request (WHIP).
New-NetFirewallRule @common -DisplayName "WebRTC Studio helper (TCP $Port)" -Protocol TCP -LocalPort $Port | Out-Null
# The media goes straight from OBS or the phone to the browser running the studio.
$browsers = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
foreach ($b in $browsers) {
    if (Test-Path $b) {
        New-NetFirewallRule @common -DisplayName "WebRTC Studio helper (UDP $(Split-Path $b -Leaf))" -Protocol UDP -Program $b | Out-Null
    }
}
