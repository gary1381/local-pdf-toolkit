#!/usr/bin/env bash
# Start OpenPDF. Reuses existing containers (seconds); builds everything only
# the first time or when containers are missing. Waits until the editor answers.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8090}"
NAMES=(pdf-gateway-pdfbox pdf-gateway-qpdf pdf-gateway-gateway)

# Fingerprint of the service sources (gateway/, services/), so a start after
# the code changed rebuilds the containers instead of running the old build.
# Empty outside a git checkout (an unpacked release never changes).
STAMP="${XDG_STATE_HOME:-$HOME/.local/state}/openpdf/containers-source"
source_fingerprint() {
  command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || return 0
  (cd "$ROOT" && git ls-files -z -co --exclude-standard -- gateway services \
    | xargs -0 sha1sum 2>/dev/null | sha1sum | cut -d' ' -f1)
}

health() { curl -fsS -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; }

FINGERPRINT="$(source_fingerprint)"
outdated() { [[ -n "$FINGERPRINT" && "$FINGERPRINT" != "$(cat "$STAMP" 2>/dev/null)" ]]; }

if health && ! { command -v podman >/dev/null 2>&1 && outdated; }; then
  echo "OpenPDF is already running at http://127.0.0.1:$PORT"
  exit 0
fi

if command -v podman >/dev/null 2>&1; then
  missing=0
  for name in "${NAMES[@]}"; do
    podman container exists "$name" || missing=1
  done
  # An install from before Gotenberg was dropped: rebuild once, so merge and
  # split use the new qpdf service (this also removes the old container).
  if podman container exists pdf-gateway-gotenberg; then
    missing=1
  fi
  if [[ $missing -eq 0 ]] && outdated; then
    echo "The code changed since the containers were built: rebuilding (a few minutes)..."
    missing=1
  fi
  if [[ $missing -eq 0 ]]; then
    podman start "${NAMES[@]}" >/dev/null
    # optional OCR component, if installed
    if podman container exists pdf-gateway-ocr; then podman start pdf-gateway-ocr >/dev/null; fi
    if podman container exists pdf-gateway-structure; then podman start pdf-gateway-structure >/dev/null; fi
  else
    "$ROOT/scripts/run-podman.sh"
  fi
elif command -v docker >/dev/null 2>&1; then
  docker compose -f "$ROOT/docker-compose.yml" up -d
else
  echo "Neither podman nor docker is installed." >&2
  exit 1
fi

for _ in $(seq 1 120); do
  if health; then
    echo "OpenPDF running at http://127.0.0.1:$PORT"
    exit 0
  fi
  sleep 1
done
echo "OpenPDF did not answer within 2 minutes; check: podman logs pdf-gateway-gateway" >&2
exit 1
