# Start OpenPDF on Windows (Podman Desktop or Docker Desktop).
# Reuses existing containers; the first start builds the images, which takes a few minutes.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Port = if ($env:PORT) { $env:PORT } else { "8090" }
$Compose = Join-Path $Root "docker-compose.yml"

function Test-OpenPdf {
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/health" | Out-Null
    return $true
  } catch { return $false }
}

if (Test-OpenPdf) { Write-Output "OpenPDF is already running"; exit 0 }

if (Get-Command docker -ErrorAction SilentlyContinue) {
  docker compose -f $Compose up -d
} elseif (Get-Command podman -ErrorAction SilentlyContinue) {
  podman compose -f $Compose up -d
} else {
  Write-Error "Install Docker Desktop or Podman Desktop first."
  exit 1
}

for ($i = 0; $i -lt 300; $i++) {
  if (Test-OpenPdf) { Write-Output "OpenPDF running at http://127.0.0.1:$Port"; exit 0 }
  Start-Sleep -Seconds 1
}
Write-Error "OpenPDF did not answer within 5 minutes."
exit 1
