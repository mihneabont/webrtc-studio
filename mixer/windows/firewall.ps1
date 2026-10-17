# Lets other devices reach the Studio Mixer: the studio page on another computer, OBS, phones (SRT, RTMP, WHIP).
# Default: devices on your local network only (on any network profile, since home Wi-Fi is often marked Public).
#   -Internet  also allow connections from outside, for a mixer you publish on the internet (forward the ports on your router too)
#   -Remove    delete the rules
param([switch]$Remove, [switch]$Internet)
$ErrorActionPreference = 'Stop'
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($Remove) { $argList += '-Remove' }
    if ($Internet) { $argList += '-Internet' }
    Start-Process powershell -Verb RunAs -ArgumentList $argList
    exit
}
Get-NetFirewallRule -DisplayName 'Studio Mixer*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if (-not $Remove) {
    $common = @{ Direction = 'Inbound'; Action = 'Allow'; Profile = 'Any'; RemoteAddress = $(if ($Internet) { 'Any' } else { 'LocalSubnet' }) }
    # 8788 control and WHIP, 8792 WebRTC media (TCP fallback), 8794 RTMP
    New-NetFirewallRule @common -DisplayName 'Studio Mixer (control, WHIP, RTMP)' -Protocol TCP -LocalPort 8788, 8792, 8794 | Out-Null
    # 8792 WebRTC media, 8793 SRT
    New-NetFirewallRule @common -DisplayName 'Studio Mixer (WebRTC media, SRT)' -Protocol UDP -LocalPort 8792, 8793 | Out-Null
    Write-Host "Firewall rules added ($(if ($Internet) { 'any address' } else { 'local network only' }))." -ForegroundColor Green
} else {
    Write-Host 'Firewall rules removed.'
}
Start-Sleep -Seconds 2
