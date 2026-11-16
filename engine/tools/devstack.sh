#!/usr/bin/env bash
# Development stack on 127.0.0.1 (no containers): gateway 28090, ocr 28091,
# pdfbox 28092, qpdf 28093, structure 28094 (base port overridable with DEVSTACK_PORT_BASE;
# 18090-18099 are left alone because smallmesh serves its model on 18093).
# Uses the Python venv ~/.venvs/pdfengine, the
# jlink JRE / qpdf / font from packaging/build/backend, and the OCR pack
# unpacked at /tmp/ocrpack, and the document structure service when the venv
# ~/.venvs/docling exists. Logs in /tmp/devstack/.
#   engine/tools/devstack.sh start|stop
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PY="$HOME/.venvs/pdfengine/bin"
B="$ROOT/packaging/build/backend"
LOG=/tmp/devstack
mkdir -p "$LOG" /tmp/devstack/sessions
BASE="${DEVSTACK_PORT_BASE:-28090}"
GATEWAY_PORT=$BASE OCR_PORT=$((BASE + 1)) PDFBOX_PORT=$((BASE + 2)) QPDF_PORT=$((BASE + 3))
STRUCTURE_PORT=$((BASE + 4))

stop() {
  # Only this stack's own processes: exact ports, never a range other
  # services might share.
  pkill -f "uvicorn app.main:app --host 127.0.0.1 --port ($GATEWAY_PORT|$QPDF_PORT|$STRUCTURE_PORT)( |\$)" || true
  pkill -f "services/pdfbox/target/pdfbox-service-0.1.0.ja[r]|-jar target/pdfbox-service-0.1.0.ja[r]" || true
  pkill -f "openpdf-ocr --port $OCR_PORT( |\$)" || true
  rm -f "$LOG"/*.pid
  for i in $(seq 1 20); do
    curl -sf 127.0.0.1:$GATEWAY_PORT/health >/dev/null 2>&1 || curl -sf 127.0.0.1:$PDFBOX_PORT/health >/dev/null 2>&1 || return 0
    sleep 0.5
  done
}

start() {
  stop
  (cd "$ROOT/services/pdfbox" && PORT=$PDFBOX_PORT CJK_FONT_PATH="$B/pdfbox/fonts/wqy-microhei.ttc" \
    setsid nohup "$B/pdfbox/jre/bin/java" -Djava.awt.headless=true --add-opens=java.base/java.nio=ALL-UNNAMED \
    --add-opens=java.base/jdk.internal.ref=ALL-UNNAMED -jar target/pdfbox-service-0.1.0.jar \
    > "$LOG/pdfbox.log" 2>&1 < /dev/null & echo $! > "$LOG/pdfbox.pid")
  (cd "$ROOT/services/qpdf" && QPDF_BIN="$B/qpdf/bin/qpdf" setsid nohup "$PY/uvicorn" app.main:app \
    --host 127.0.0.1 --port $QPDF_PORT > "$LOG/qpdf.log" 2>&1 < /dev/null & echo $! > "$LOG/qpdf.pid")
  if [[ -x /tmp/ocrpack/openpdf-ocr/openpdf-ocr ]]; then
    (setsid nohup /tmp/ocrpack/openpdf-ocr/openpdf-ocr --port $OCR_PORT > "$LOG/ocr.log" 2>&1 < /dev/null & echo $! > "$LOG/ocr.pid")
  fi
  if [[ -x "$HOME/.venvs/docling/bin/uvicorn" ]]; then
    (cd "$ROOT/services/structure" && setsid nohup "$HOME/.venvs/docling/bin/uvicorn" app.main:app \
      --host 127.0.0.1 --port $STRUCTURE_PORT > "$LOG/structure.log" 2>&1 < /dev/null & echo $! > "$LOG/structure.pid")
  fi
  (cd "$ROOT/gateway" && PDFBOX_URL=http://127.0.0.1:$PDFBOX_PORT QPDF_URL=http://127.0.0.1:$QPDF_PORT \
    OCR_URL=http://127.0.0.1:$OCR_PORT STRUCTURE_URL=http://127.0.0.1:$STRUCTURE_PORT SESSION_DIR=/tmp/devstack/sessions \
    ALLOWED_HOSTS=127.0.0.1,localhost setsid nohup "$PY/uvicorn" app.main:app --host 127.0.0.1 --port $GATEWAY_PORT \
    > "$LOG/gateway.log" 2>&1 < /dev/null & echo $! > "$LOG/gateway.pid")
  for i in $(seq 1 60); do
    if curl -sf 127.0.0.1:$PDFBOX_PORT/health >/dev/null && curl -sf 127.0.0.1:$GATEWAY_PORT/health >/dev/null; then
      echo "up after ${i}s (gateway http://127.0.0.1:$GATEWAY_PORT)"; return 0
    fi
    sleep 1
  done
  echo "not up; see $LOG"; return 1
}

"${1:-start}"
