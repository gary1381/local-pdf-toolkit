#!/usr/bin/env bash
# Build the OCR add-on pack: services/ocr (OCRmyPDF + RapidOCR + models) as one
# PyInstaller program, packed as packaging/build/ocr/openpdf-ocr.tar.gz.
# Built in Debian bullseye (glibc 2.31), like the other services.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/packaging/build/ocr"
rm -rf "$OUT" && mkdir -p "$OUT"

podman run --rm -v "$ROOT:/src:ro,Z" -v "$OUT:/out:Z" docker.io/library/python:3.12-slim-bullseye bash -euo pipefail -c '
  apt-get update -qq && apt-get install -y -qq --no-install-recommends binutils >/dev/null
  mkdir -p /b && cd /b
  cp -r /src/services/ocr/app ./app
  cp /src/packaging/linux/ocr/openpdf_ocr.py .
  find . -name __pycache__ -prune -exec rm -rf {} +
  export ORT_DISABLE_TELEMETRY=1
  pip install -q --no-cache-dir --root-user-action=ignore -r /src/services/ocr/requirements.txt "pyinstaller==6.22.3"
  # pikepdf loads some of its modules only when a PDF needs them (pikepdf.jbig2 for
  # JBIG2 scans): --collect-submodules pikepdf keeps them in the program.
  # The models the service uses, into rapidocr/models (unused bundled ones removed).
  python -m app.ocr_models
  pyinstaller --noconfirm --clean --log-level WARN --onedir --name openpdf-ocr \
      --distpath /b/dist --workpath /b/work --specpath /b \
      --collect-all rapidocr \
      --collect-submodules ocrmypdf --collect-data ocrmypdf \
      --collect-submodules pikepdf \
      --collect-submodules app --hidden-import app.rapid_engine --hidden-import app.pdfium_nosmooth \
      --copy-metadata ocrmypdf --copy-metadata rapidocr --copy-metadata pikepdf --copy-metadata pypdfium2 \
      --copy-metadata img2pdf --copy-metadata fpdf2 --copy-metadata pdfminer.six --copy-metadata onnxruntime \
      --exclude-module tkinter --exclude-module onnxruntime.transformers --exclude-module onnxruntime.quantization \
      --exclude-module onnxruntime.tools \
      openpdf_ocr.py
  # Licence texts and source pointers of every bundled Python package.
  python /src/packaging/linux/collect-licenses.py /b/dist/openpdf-ocr
  cp /src/THIRD-PARTY-NOTICES.md /b/dist/openpdf-ocr/
  cd /b/dist && tar -czf /out/openpdf-ocr.tar.gz openpdf-ocr
  du -sh /b/dist/openpdf-ocr
'
ls -la "$OUT"
sha256sum "$OUT/openpdf-ocr.tar.gz"
