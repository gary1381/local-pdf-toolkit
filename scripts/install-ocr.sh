#!/usr/bin/env bash
# Install the optional text recognition (OCR) component: builds the OCR
# service (RapidOCR + OCRmyPDF: about 190 MB to download, 620 MB installed) and starts it next to the
# other services. The editor offers this the first time OCR is used.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NETWORK=pdf-gateway-net
PORT="${PORT:-8090}"

if command -v podman >/dev/null 2>&1; then
  podman network create "$NETWORK" >/dev/null 2>&1 || true
  echo "STEP 1/2 Downloading and building the OCR component (about 190 MB, takes a few minutes)…"
  podman build -t pdf-gateway-ocr:latest "$ROOT/services/ocr"
  echo "STEP 2/2 Starting the OCR component…"
  podman rm -f pdf-gateway-ocr >/dev/null 2>&1 || true
  podman run -d --restart always --network "$NETWORK" --name pdf-gateway-ocr pdf-gateway-ocr:latest >/dev/null
elif command -v docker >/dev/null 2>&1; then
  echo "STEP 1/2 Downloading and building the OCR component (about 190 MB, takes a few minutes)…"
  docker compose -f "$ROOT/docker-compose.yml" --profile ocr build ocr
  echo "STEP 2/2 Starting the OCR component…"
  docker compose -f "$ROOT/docker-compose.yml" --profile ocr up -d ocr
else
  echo "Neither podman nor docker is installed." >&2
  exit 1
fi

# Wait until the editor can reach it.
auth=()
[[ -n "${API_KEY:-}" ]] && auth=(-H "X-API-Key: $API_KEY")
for _ in $(seq 1 60); do
  if curl -fsS -m 3 "${auth[@]}" "http://127.0.0.1:$PORT/v1/pdf/ocr/status" 2>/dev/null | grep -q '"installed":true'; then
    echo "DONE OCR component installed"
    exit 0
  fi
  sleep 1
done
echo "The OCR component started, but the editor cannot reach it yet; try again in a moment" >&2
exit 1
