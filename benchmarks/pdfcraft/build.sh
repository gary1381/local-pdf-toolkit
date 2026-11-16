#!/bin/bash
# Builds a page that runs PDFCraft's own redaction and PDF-to-Markdown code, for the
# redaction and parsing benchmarks. PDFCraft (AGPL-3.0) is only downloaded and run here
# as a tool under test, never bundled with OpenPDF. Its install scripts are not run:
# its source is bundled with the pdf-lib and pdf.js versions its lockfile pins.
#
#   benchmarks/pdfcraft/build.sh [DIR]     (default ~/.cache/openpdf-bench/pdfcraft)
#   python3 benchmarks/pdfcraft/serve.py DIR/www 28390
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DIR=${1:-$HOME/.cache/openpdf-bench/pdfcraft}
COMMIT=${PDFCRAFT_COMMIT:-e3b231b}   # 2026-11-05
mkdir -p "$DIR"
cd "$DIR"
if [ ! -d pdfcraft ]; then
  git clone -q https://github.com/PDFCraftTool/pdfcraft.git pdfcraft
fi
git -C pdfcraft checkout -q "$COMMIT"
[ -f package.json ] || echo '{"name": "pdfcraft-harness", "private": true, "type": "module"}' > package.json
npm install --ignore-scripts --no-audit --no-fund pdf-lib@1.17.1 pdfjs-dist@4.8.69 esbuild@0.24.0 > /dev/null
cp "$HERE/entry.ts" entry.ts
mkdir -p www/workers www/pdfjs-viewer
cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs www/workers/pdf.worker.min.mjs
cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs www/workers/pdf.worker.min.js
cp -r node_modules/pdfjs-dist/cmaps node_modules/pdfjs-dist/standard_fonts www/pdfjs-viewer/
echo '<!doctype html><meta charset="utf-8"><script type="module" src="bundle.js"></script>' > www/index.html
NODE_PATH="$DIR/node_modules" ./node_modules/.bin/esbuild entry.ts --bundle --format=esm --outfile=www/bundle.js \
  --tsconfig=pdfcraft/tsconfig.json --define:process.env.NEXT_PUBLIC_BASE_PATH='""' \
  --define:process.env.NODE_ENV='"production"' --log-level=warning
echo "built $DIR/www (PDFCraft $(git -C pdfcraft rev-parse --short HEAD))"
