// Builds the Windows setup file for the Studio Mixer (mixer/ in this repository).
import { el } from '../util.js';

export const MIXER_PORT = 8788;

// A web page can't install software, so this hands the user a small setup file.
// It fetches mixer/windows/install.ps1 from the site this page came from and runs it;
// that script installs Python, GStreamer, MediaMTX and ffmpeg as needed, and the mixer.
export function downloadMixerInstaller() {
  const src = new URL('mixer/', location.href).href;
  const cmd = [
    '@echo off',
    'rem Studio Mixer: mixes, encodes and streams for the studio page, and takes SRT, RTMP and WHIP senders.',
    'rem Runs in the background and starts again at every sign-in. Run with /uninstall to remove it.',
    'setlocal',
    `set "SRC=${src}"`,
    'set "ARGS="',
    'if /i "%~1"=="/uninstall" set "ARGS=-Uninstall"',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference=\'Stop\'; $ProgressPreference=\'SilentlyContinue\'; $f=Join-Path $env:TEMP \'studio-mixer-install.ps1\'; Invoke-WebRequest -UseBasicParsing \'%SRC%windows/install.ps1\' -OutFile $f; & $f -Source \'%SRC%\' %ARGS%"',
    'if errorlevel 1 echo Setup did not finish. The messages above say why.',
    'pause',
  ].join('\r\n') + '\r\n';
  const a = el('a', { href: URL.createObjectURL(new Blob([cmd], { type: 'application/octet-stream' })), download: 'studio-mixer-setup.cmd' });
  document.body.append(a); a.click(); a.remove();
}
