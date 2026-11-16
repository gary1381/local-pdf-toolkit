# Install the optional text recognition (OCR) component on Windows
# (Docker Desktop or Podman Desktop). About 190 MB to download (620 MB installed); takes a few minutes.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Compose = Join-Path $Root "docker-compose.yml"
$Tool = if (Get-Command docker -ErrorAction SilentlyContinue) { "docker" } elseif (Get-Command podman -ErrorAction SilentlyContinue) { "podman" } else { $null }
if (-not $Tool) { Write-Error "Install Docker Desktop or Podman Desktop first."; exit 1 }
Write-Output "STEP 1/2 Downloading and building the OCR component (about 190 MB, takes a few minutes)…"
& $Tool compose -f $Compose --profile ocr build ocr
Write-Output "STEP 2/2 Starting the OCR component…"
& $Tool compose -f $Compose --profile ocr up -d ocr
Write-Output "DONE OCR component installed"
