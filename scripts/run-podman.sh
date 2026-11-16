#!/usr/bin/env bash
# Build all OpenPDF images and (re)create the containers with Podman.
# Use scripts/start.sh for everyday starts: it only rebuilds when needed.
#
# Settings (environment variables):
#   BIND_ADDR      address the editor listens on (default 127.0.0.1 = this computer only).
#                  Set to 0.0.0.0 to serve your network, and then also set API_KEY.
#   API_KEY        require this key on every API call (empty = no key).
#   ALLOWED_HOSTS  host names the gateway answers to (default 127.0.0.1,localhost).
#   MAX_UPLOAD_MB  largest file accepted (default 200).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NETWORK=pdf-gateway-net
BIND_ADDR="${BIND_ADDR:-127.0.0.1}"
API_KEY="${API_KEY:-}"
ALLOWED_HOSTS="${ALLOWED_HOSTS:-127.0.0.1,localhost}"
MAX_UPLOAD_MB="${MAX_UPLOAD_MB:-200}"
PORT="${PORT:-8090}"

# Fingerprint of the service sources (gateway/, services/), so a start after
# the code changed rebuilds the containers instead of running the old build.
# Empty outside a git checkout (an unpacked release never changes).
STAMP="${XDG_STATE_HOME:-$HOME/.local/state}/openpdf/containers-source"
source_fingerprint() {
  command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || return 0
  (cd "$ROOT" && git ls-files -z -co --exclude-standard -- gateway services \
    | xargs -0 sha1sum 2>/dev/null | sha1sum | cut -d' ' -f1)
}

if [[ "$BIND_ADDR" != "127.0.0.1" && "$BIND_ADDR" != "localhost" && -z "$API_KEY" ]]; then
  echo "Refusing to listen on $BIND_ADDR without API_KEY: anyone on the network could use the editor." >&2
  echo "Set API_KEY=... (and ALLOWED_HOSTS to include this machine's name or IP)." >&2
  exit 1
fi

podman network create "$NETWORK" 2>/dev/null || true
podman volume create pdf-gateway-sessions >/dev/null 2>&1 || true

podman build -t pdf-gateway-pdfbox:latest "$ROOT/services/pdfbox"
# OCR is optional (about 620 MB installed): built only when already installed or asked
# for with INSTALL_OCR=1. The editor offers to install it on first use
# (scripts/install-ocr.sh).
WITH_OCR=0
if [[ "${INSTALL_OCR:-}" == "1" ]] || podman image exists pdf-gateway-ocr:latest; then
  WITH_OCR=1
  podman build -t pdf-gateway-ocr:latest "$ROOT/services/ocr"
fi
# Document structure (Docling, about 2 GB) is optional too: built when already
# installed or asked for with INSTALL_STRUCTURE=1 (scripts/install-structure.sh).
WITH_STRUCTURE=0
if [[ "${INSTALL_STRUCTURE:-}" == "1" ]] || podman image exists pdf-gateway-structure:latest; then
  WITH_STRUCTURE=1
  podman build -t pdf-gateway-structure:latest "$ROOT/services/structure"
fi
podman build -t pdf-gateway-qpdf:latest "$ROOT/services/qpdf"
podman build -t pdf-gateway-gateway:latest "$ROOT/gateway"

# pdf-gateway-gotenberg: no longer used (merge and split run on qpdf); removed if left over.
podman rm -f pdf-gateway-gotenberg pdf-gateway-ocr pdf-gateway-structure pdf-gateway-pdfbox pdf-gateway-qpdf \
  pdf-gateway-gateway 2>/dev/null || true

# "always" so the services come back after a reboot (via podman-restart.service).
RUN=(podman run -d --restart always --network "$NETWORK")
if [[ $WITH_OCR == 1 ]]; then
  "${RUN[@]}" --name pdf-gateway-ocr pdf-gateway-ocr:latest
fi
if [[ $WITH_STRUCTURE == 1 ]]; then
  "${RUN[@]}" --name pdf-gateway-structure pdf-gateway-structure:latest
fi
"${RUN[@]}" --name pdf-gateway-pdfbox pdf-gateway-pdfbox:latest
"${RUN[@]}" --name pdf-gateway-qpdf pdf-gateway-qpdf:latest
"${RUN[@]}" --name pdf-gateway-gateway -p "$BIND_ADDR:$PORT:8090" \
  -v pdf-gateway-sessions:/data/sessions \
  -e OCR_URL=http://pdf-gateway-ocr:8091 \
  -e PDFBOX_URL=http://pdf-gateway-pdfbox:8092 \
  -e QPDF_URL=http://pdf-gateway-qpdf:8093 \
  -e STRUCTURE_URL=http://pdf-gateway-structure:8094 \
  -e API_KEY="$API_KEY" \
  -e ALLOWED_HOSTS="$ALLOWED_HOSTS" \
  -e MAX_UPLOAD_MB="$MAX_UPLOAD_MB" \
  pdf-gateway-gateway:latest

FINGERPRINT="$(source_fingerprint)"
if [[ -n "$FINGERPRINT" ]]; then
  mkdir -p "$(dirname "$STAMP")" && echo "$FINGERPRINT" > "$STAMP"
fi

# Rootless Podman restarts "always" containers at boot through this user service.
if command -v systemctl >/dev/null 2>&1 && systemctl --user list-unit-files podman-restart.service >/dev/null 2>&1; then
  systemctl --user enable podman-restart.service >/dev/null 2>&1 \
    && echo "Enabled podman-restart.service: OpenPDF will start again after a reboot." \
    || echo "Note: could not enable podman-restart.service; run: systemctl --user enable podman-restart.service"
  if command -v loginctl >/dev/null 2>&1 && [[ "$(loginctl show-user "$USER" -p Linger 2>/dev/null)" != "Linger=yes" ]]; then
    echo "Note: to start OpenPDF at boot before you log in, run: loginctl enable-linger $USER"
  fi
fi

echo "OpenPDF running at http://127.0.0.1:$PORT (listening on $BIND_ADDR, API_KEY ${API_KEY:+set}${API_KEY:-disabled})"
