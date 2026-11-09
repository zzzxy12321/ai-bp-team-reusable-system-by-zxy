$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $ProjectRoot

$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) {
  throw "Node.js was not found. Install Node.js 24 or newer first."
}

$NodeVersion = (& $Node.Source --version).Trim()
$NodeMajor = [int]$NodeVersion.Substring(1).Split(".")[0]
if ($NodeMajor -lt 24) {
  throw "Node.js $NodeVersion is installed. This prototype requires Node.js 24 or newer."
}

$HealthUrl = "http://127.0.0.1:4173/api/health"
$Running = $false
try {
  $Health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 1
  $Running = [bool]$Health.ok
} catch {
  $Running = $false
}

if (-not $Running) {
  $serverProcess = Start-Process `
    -FilePath $Node.Source `
    -ArgumentList "server.mjs" `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden `
    -PassThru
  Set-Content -LiteralPath (Join-Path $ProjectRoot ".aidt.pid") -Value $serverProcess.Id -Encoding ascii

  $Ready = $false
  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 200
    try {
      $Health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 1
      if ($Health.ok) {
        $Ready = $true
        break
      }
    } catch {}
  }
  if (-not $Ready) {
    throw "AIDT local service did not start. Run 'node server.mjs' to inspect the error."
  }
} else {
  Write-Host "AIDT local service is already running."
}

Start-Process "http://127.0.0.1:4173/"
Write-Host ""
Write-Host "AIDT local prototype: http://127.0.0.1:4173/"
Write-Host "Demo database: $ProjectRoot\data\aidt.db"
Write-Host "Stop service: powershell -ExecutionPolicy Bypass -File .\stop.ps1"
Write-Host ""
