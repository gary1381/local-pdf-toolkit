#!/usr/bin/env bash
# Install the optional document structure component: builds the structure
# service (Docling: headings, reading order, tables; CPU only, about 2 GB
# installed) and starts it next to the other services. Agents use it through
# POST /v1/pdf/structure and the engine's pdf_outline / pdf_read_markdown tools.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NETWORK=pdf-gateway-net
PORT="${PORT:-8090}"

if command -v podman >/dev/null 2>&1; then
  podman network create "$NETWORK" >/dev/null 2>&1 || true
  echo "STEP 1/2 Downloading and building the document structure component (about 1 GB, takes a few minutes)…"
  podman build -t pdf-gateway-structure:latest "$ROOT/services/structure"
  echo "STEP 2/2 Starting the document structure component…"
  podman rm -f pdf-gateway-structure >/dev/null 2>&1 || true
  # with the reading model when one is installed (install-model.sh); without it the model is simply not used
  podman run -d --restart always --network "$NETWORK" --name pdf-gateway-structure \
    -e OPENPDF_VLM_URL=http://pdf-gateway-model:8080 -e OPENPDF_VLM_MODEL="${MODEL_PROFILE:-paddleocr-vl}" pdf-gateway-structure:latest >/dev/null
elif command -v docker >/dev/null 2>&1; then
  echo "STEP 1/2 Downloading and building the document structure component (about 1 GB, takes a few minutes)…"
  docker compose -f "$ROOT/docker-compose.yml" --profile structure build structure
  echo "STEP 2/2 Starting the document structure component…"
  docker compose -f "$ROOT/docker-compose.yml" --profile structure up -d structure
else
  echo "Neither podman nor docker is installed." >&2
  exit 1
fi

# Wait until the editor can reach it (the models load in the background).
auth=()
[[ -n "${API_KEY:-}" ]] && auth=(-H "X-API-Key: $API_KEY")
for _ in $(seq 1 90); do
  if curl -fsS -m 3 "${auth[@]}" "http://127.0.0.1:$PORT/v1/pdf/structure/status" 2>/dev/null | grep -q '"installed":true'; then
    echo "DONE document structure component installed"
    exit 0
  fi
  sleep 1
done
echo "The document structure component started, but the editor cannot reach it yet; try again in a moment" >&2
exit 1
