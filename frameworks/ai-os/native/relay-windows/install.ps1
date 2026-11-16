# Installs the relay on Windows (PowerShell 7, elevated session), with no password or interaction:
#   service "AphrodyRelay" (aphrody-relay-svc.exe, CI artifact relay-service) as LocalSystem; it launches `bun relay serve`
#   in the active console session with the user's token (WTSQueryUserToken), hence with their agy sessions,
#   Claude Code, gcloud, ssh and Chrome. The relay's Chrome is started on demand by the relay itself.
# Usage : pwsh -File install.ps1 -ServiceExe <chemin\aphrody-relay-svc.exe> [-Uninstall]
param([string]$ServiceExe, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$name = 'AphrodyRelay'
if ($Uninstall) {
  if (Get-Service $name -ErrorAction SilentlyContinue) { Stop-Service $name -ErrorAction SilentlyContinue; sc.exe delete $name | Out-Null }
  return
}
if (-not $ServiceExe -or -not (Test-Path $ServiceExe)) { throw 'ServiceExe not found (CI relay-service artifact)' }
$bun = (Get-Command bun -ErrorAction Stop).Source
$cli = Join-Path $PSScriptRoot '..\..\src\relay\cli.ts' | Resolve-Path | Select-Object -ExpandProperty Path
$home_ = Join-Path $env:LOCALAPPDATA 'aphrody\relay'
New-Item -ItemType Directory -Force $home_ | Out-Null
if (Get-Service $name -ErrorAction SilentlyContinue) { Stop-Service $name }
else { New-Service -Name $name -BinaryPathName "`"$ServiceExe`"" -DisplayName 'Aphrody relay (Claude Code <-> Gemini)' -StartupType Automatic | Out-Null }
sc.exe config $name binPath= "`"$ServiceExe`"" | Out-Null
$env_ = @("RELAY_BUN=$bun", "RELAY_CLI=$cli", "RELAY_HOME=$home_", 'RELAY_PORT=8790', 'RELAY_TCP_PORT=8791', 'RELAY_CDP_PORT=9333',
  "SRC_ROOT=$((Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path)")
$tls = Join-Path $home_ 'tls'
if ((Test-Path "$tls\cert.pem") -and (Test-Path "$tls\key.pem")) { $env_ += @("RELAY_TLS_CERT=$tls\cert.pem", "RELAY_TLS_KEY=$tls\key.pem", 'RELAY_TLS_PORT=8792') }
Set-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$name" -Name Environment -Type MultiString -Value $env_
# Failures: restart after 5 s, 10 s then 30 s; counter reset every day.
sc.exe failure $name reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
Unregister-ScheduledTask -TaskName 'AphrodyRelayBrowser' -Confirm:$false -ErrorAction SilentlyContinue
Start-Service $name
Get-Service $name | Select-Object Name, Status
