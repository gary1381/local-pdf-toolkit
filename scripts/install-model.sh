#!/usr/bin/env bash
# Install the optional document reading model (docs/OCR-MODELS.md):
#
#   scripts/install-model.sh            # fast: PaddleOCR-VL 1.6 (0.9 GB), GPU or CPU
#   scripts/install-model.sh best       # best: Unlimited-OCR 3B (2.8 GB), needs a GPU; experimental
#
# Builds the model server (llama.cpp; with CUDA when an NVIDIA GPU is found),
# downloads the model on first start (checked against services/model/catalog.json)
# and restarts the document structure component so it uses the model for tables,
# formulas and scanned pages. Needs the structure component (install-structure.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NETWORK=pdf-gateway-net
PORT="${PORT:-8090}"
TIER="${1:-fast}"
case "$TIER" in
  fast) PROFILE=paddleocr-vl ;;
  best) PROFILE=unlimited-ocr ;;
  *) echo "Usage: $0 [fast|best]" >&2; exit 1 ;;
esac
BACKEND=cpu
GPU=()
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  BACKEND=cuda
  GPU=(--device nvidia.com/gpu=all)
fi
if [[ $TIER == best && $BACKEND != cuda ]]; then
  echo "The best model needs an NVIDIA GPU here (on a CPU it takes minutes per page); use: $0 fast" >&2
  exit 1
fi
command -v podman >/dev/null 2>&1 || { echo "This script uses podman (docker: docker compose --profile model up -d)" >&2; exit 1; }
podman network create "$NETWORK" >/dev/null 2>&1 || true

echo "STEP 1/3 Building the model server ($BACKEND; takes several minutes)…"
podman build -t pdf-gateway-model:latest --build-arg BACKEND=$BACKEND "$ROOT/services/model"
echo "STEP 2/3 Starting it; the model is downloaded on first start and checked…"
podman rm -f pdf-gateway-model >/dev/null 2>&1 || true
podman run -d --restart always --network "$NETWORK" --name pdf-gateway-model "${GPU[@]}" \
  -e MODEL_TIER="$TIER" -v pdf-gateway-models:/models pdf-gateway-model:latest >/dev/null
for _ in $(seq 1 900); do
  podman exec pdf-gateway-model curl -fsS -m 3 http://127.0.0.1:8080/health >/dev/null 2>&1 && break
  if [[ "$(podman inspect -f '{{.State.Running}}' pdf-gateway-model 2>/dev/null)" != true ]]; then
    podman logs --tail 20 pdf-gateway-model >&2; exit 1
  fi
  sleep 2
done

echo "STEP 3/3 Restarting the document structure component with the model…"
podman rm -f pdf-gateway-structure >/dev/null 2>&1 || true
podman run -d --restart always --network "$NETWORK" --name pdf-gateway-structure \
  -e OPENPDF_VLM_URL=http://pdf-gateway-model:8080 -e OPENPDF_VLM_MODEL="$PROFILE" pdf-gateway-structure:latest >/dev/null

auth=()
[[ -n "${API_KEY:-}" ]] && auth=(-H "X-API-Key: $API_KEY")
for _ in $(seq 1 120); do
  if curl -fsS -m 3 "${auth[@]}" "http://127.0.0.1:$PORT/v1/pdf/structure/model" 2>/dev/null | grep -q '"ready":true'; then
    echo "DONE document reading model ($TIER) installed"
    exit 0
  fi
  sleep 1
done
echo "The model started, but the editor cannot reach it yet; try again in a moment" >&2
exit 1
