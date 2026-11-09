$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$PidFile = Join-Path $ProjectRoot ".aidt.pid"

if (-not (Test-Path -LiteralPath $PidFile)) {
  Write-Host ".aidt.pid was not found. The service may not have been started by start.ps1."
  exit 0
}

$ServerPid = [int](Get-Content -LiteralPath $PidFile -Raw).Trim()
$ProcessInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ServerPid" -ErrorAction SilentlyContinue
if (-not $ProcessInfo) {
  Remove-Item -LiteralPath $PidFile -Force
  Write-Host "The process no longer exists. PID file was removed."
  exit 0
}

$ExpectedScript = Join-Path $ProjectRoot "server.mjs"
if ($ProcessInfo.CommandLine -notlike "*server.mjs*") {
  throw "PID $ServerPid is not the AIDT server.mjs process. Refusing to stop it."
}

Stop-Process -Id $ServerPid
Remove-Item -LiteralPath $PidFile -Force
Write-Host "AIDT local service stopped."
