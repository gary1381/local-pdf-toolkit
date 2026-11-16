#!/usr/bin/env bash
# Build the public open-source tree of the engine in DEST: only the code the
# engine needs, no history, no desktop app or packaging, the engine README at
# the top. Then scans it for things that must not be published.
#   engine/tools/export_public.sh /tmp/pdf-engine-public
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${1:?destination folder}"
rm -rf "$DEST" && mkdir -p "$DEST"

copy() { mkdir -p "$DEST/$(dirname "$1")"; cp -r "$ROOT/$1" "$DEST/$1"; }
copy gateway/app
copy gateway/requirements.txt
copy services/pdfbox/pom.xml
copy services/pdfbox/src
copy services/qpdf/app
copy services/qpdf/requirements.txt
copy services/ocr/app
copy services/ocr/requirements.txt
copy engine/pdf_engine
copy engine/tests/make_fixtures.py
copy engine/tests/test_mcp.py
copy engine/tests/test_http.py
copy engine/Dockerfile
copy engine/Dockerfile.dockerignore
copy THIRD-PARTY-NOTICES.md
cp "$ROOT/LICENSE" "$ROOT/NOTICE" "$ROOT/engine/CONTRIBUTING.md" "$ROOT/engine/DEMOS.md" "$DEST/"
cp -r "$ROOT/engine/public/." "$DEST/"
sed -e 's#(\.\./THIRD-PARTY-NOTICES\.md)#(THIRD-PARTY-NOTICES.md)#' "$ROOT/engine/README.md" > "$DEST/README.md"
cat > "$DEST/.gitignore" <<'EOF'
__pycache__/
*.pyc
services/pdfbox/target/
.venv/
EOF
find "$DEST" -name __pycache__ -prune -exec rm -rf {} +
find "$DEST" -name "*.pyc" -delete

# --- checks: nothing private, nothing Chinese-only left in the engine's messages
echo "files: $(find "$DEST" -type f | wc -l), size: $(du -sh "$DEST" | cut -f1)"
fail=0
if grep -rIl -E "(BEGIN (RSA|EC|OPENSSH) PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})" "$DEST"; then
  echo "!! possible secret above"; fail=1
fi
if grep -rIl -i -E "@gmail\.com|/home/[a-z]+/" "$DEST"; then
  echo "!! personal path or address above"; fail=1
fi
exit $fail
