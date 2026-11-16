#!/usr/bin/env bash
set -euo pipefail

BASE="${PDF_GATEWAY_URL:-http://127.0.0.1:8090}"
KEY="${PDF_GATEWAY_API_KEY:-}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

python3 - <<'PY' "$WORKDIR"
from pathlib import Path
import sys
from reportlab.pdfgen import canvas

out = Path(sys.argv[1])
for name, text in [("a.pdf", "Page A content"), ("b.pdf", "Page B content")]:
    p = out / name
    c = canvas.Canvas(str(p))
    c.drawString(100, 750, text)
    c.showPage()
    c.save()
PY

auth=()
if [ -n "$KEY" ]; then
  auth=(-H "X-API-Key: $KEY")
fi

curl -sf "$BASE/health" | grep -q ok
curl -sf "${auth[@]}" -F "file=@$WORKDIR/a.pdf" "$BASE/v1/pdf/info" | grep -q pageCount
if [ -n "$KEY" ]; then
  test "$(curl -s -o /dev/null -w "%{http_code}" -F "file=@$WORKDIR/a.pdf" "$BASE/v1/pdf/info")" = "401"
fi
curl -sf "${auth[@]}" -F "files=@$WORKDIR/a.pdf" -F "files=@$WORKDIR/b.pdf" "$BASE/v1/pdf/merge" -o "$WORKDIR/merged.pdf"
curl -sf "${auth[@]}" -F "file=@$WORKDIR/merged.pdf" -F "pages=1" -F "unify=true" "$BASE/v1/pdf/split" -o "$WORKDIR/split.pdf"
curl -sf "${auth[@]}" -F "file=@$WORKDIR/merged.pdf" "$BASE/v1/pdf/extract" | grep -q "Page A content"
curl -sf "${auth[@]}" -F "file=@$WORKDIR/a.pdf" -F "text=note" -F "page_index=0" "$BASE/v1/pdf/annotate" -o "$WORKDIR/annotated.pdf"
curl -sf "${auth[@]}" -F "file=@$WORKDIR/a.pdf" -F "languages=eng" "$BASE/v1/pdf/ocr" -o "$WORKDIR/ocr.pdf"
curl -sf "${auth[@]}" -F "file=@$WORKDIR/a.pdf" -F "text=Hello" -F "page_index=0" "$BASE/v1/pdf/draw-text" -o "$WORKDIR/drawn.pdf"
curl -sf "${auth[@]}" -F "file=@$WORKDIR/a.pdf" -F "user_password=secret" "$BASE/v1/pdf/encrypt" -o "$WORKDIR/locked.pdf"
curl -sf "${auth[@]}" -F "file=@$WORKDIR/locked.pdf" -F "password=secret" "$BASE/v1/pdf/unlock" -o "$WORKDIR/unlocked.pdf"
curl -sf "${auth[@]}" -F "file=@$WORKDIR/annotated.pdf" "$BASE/v1/pdf/flatten" -o "$WORKDIR/flat.pdf"

echo "E2E passed: merge, split, extract, annotate, ocr, draw-text, encrypt/unlock, flatten"
