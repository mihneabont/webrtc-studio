// Builds the Windows setup file for the optional helper (signaling-server/server.mjs).
import { el } from '../util.js';

// 8787 is often taken by a local web server, so the installed helper uses 8788.
export const HELPER_PORT = 8788;

// A web page can't install software, so this hands the user a setup file that
// installs Node.js and ffmpeg (for RTMP output and SRT input) if needed, fetches the helper
// from the site this page came from, and starts it on HELPER_PORT.
export function downloadHelperInstaller() {
  const src = new URL('signaling-server/server.mjs', location.href).href;
  const fwSrc = new URL('signaling-server/firewall.ps1', location.href).href;
  const ps = (c) => `powershell -NoProfile -Command "${c}"`;
  const stopOld = ps(`Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -like '*WebRTCStudioHelper*' -or $_.CommandLine -like '*signaling-server*server.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
  const cmd = [
    '@echo off',
    'rem WebRTC Studio helper: lets OBS and phone apps (WHIP) send into the studio page,',
    'rem receives SRT senders, and sends the programme to RTMP servers (both with ffmpeg).',
    'rem Runs in the background and starts again at every sign-in. Run with /uninstall to remove it.',
    'setlocal',
    'set "DIR=%LOCALAPPDATA%\\WebRTCStudioHelper"',
    'set "STARTUP=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\WebRTC Studio helper.vbs"',
    'if /i "%~1"=="/uninstall" goto uninstall',
    'echo == WebRTC Studio helper ==',
    'set "NODE="',
    'for /f "delims=" %%N in (\'where node 2^>nul\') do if not defined NODE set "NODE=%%N"',
    'if not defined NODE if exist "%ProgramFiles%\\nodejs\\node.exe" set "NODE=%ProgramFiles%\\nodejs\\node.exe"',
    'if defined NODE goto havenode',
    'echo Installing Node.js LTS. Windows may ask for permission...',
    'winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements',
    'if exist "%ProgramFiles%\\nodejs\\node.exe" set "NODE=%ProgramFiles%\\nodejs\\node.exe"',
    'if defined NODE goto havenode',
    'echo Node.js did not install. Install it from https://nodejs.org and run this file again.',
    'pause',
    'exit /b 1',
    ':havenode',
    'set "FF="',
    'for /f "delims=" %%F in (\'where ffmpeg 2^>nul\') do if not defined FF set "FF=%%F"',
    'if not defined FF if exist "%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\ffmpeg.exe" set "FF=1"',
    'if not defined FF for /d %%D in ("%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\*FFmpeg*") do set "FF=1"',
    'if defined FF goto haveff',
    'echo Installing ffmpeg (used for RTMP output and SRT input)...',
    'winget install --id Gyan.FFmpeg.Essentials -e --silent --accept-source-agreements --accept-package-agreements',
    'if errorlevel 1 echo ffmpeg did not install. Everything else works; RTMP output and SRT input need ffmpeg (winget install Gyan.FFmpeg.Essentials).',
    ':haveff',
    'if not exist "%DIR%" mkdir "%DIR%"',
    `echo Downloading the helper from ${src}`,
    ps(`Invoke-WebRequest -UseBasicParsing '${src}' -OutFile '%DIR%\\server.mjs'`),
    'if not exist "%DIR%\\server.mjs" (echo Download failed. & pause & exit /b 1)',
    `> "%STARTUP%" echo CreateObject("WScript.Shell").Run """%NODE%"" ""%DIR%\\server.mjs"" --port ${HELPER_PORT}", 0, False`,
    stopOld,
    'wscript "%STARTUP%"',
    'echo Allowing your phone and OBS on this network to connect (Windows asks for admin once)...',
    ps(`Invoke-WebRequest -UseBasicParsing '${fwSrc}' -OutFile '%DIR%\\firewall.ps1'`),
    ps(`Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \\"%DIR%\\firewall.ps1\\" -Port ${HELPER_PORT}'`),
    'timeout /t 3 /nobreak >nul',
    ps(`try { Invoke-WebRequest -UseBasicParsing http://localhost:${HELPER_PORT}/helper | Out-Null; Write-Host 'The helper is running. Go back to the studio page and click Check again.' -ForegroundColor Green } catch { Write-Host 'The helper did not answer yet. Wait a few seconds, then click Check again in the studio.' -ForegroundColor Yellow }`),
    'pause',
    'exit /b 0',
    ':uninstall',
    stopOld,
    'del "%STARTUP%" 2>nul',
    'if exist "%DIR%\\firewall.ps1" powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList \'-NoProfile -ExecutionPolicy Bypass -File \\\"%DIR%\\firewall.ps1\\\" -Remove\'"',
    'timeout /t 3 /nobreak >nul',
    'rmdir /s /q "%DIR%" 2>nul',
    'echo The helper is removed.',
    'pause',
  ].join('\r\n') + '\r\n';
  const a = el('a', { href: URL.createObjectURL(new Blob([cmd], { type: 'application/octet-stream' })), download: 'webrtc-studio-helper-setup.cmd' });
  document.body.append(a); a.click(); a.remove();
}
