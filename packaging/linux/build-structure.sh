#!/usr/bin/env bash
# Build the document structure add-on pack: services/structure (Docling, CPU
# PyTorch, its layout and table models) as one PyInstaller program, packed as
# packaging/build/structure/openpdf-structure.tar.gz. Built in Debian bullseye
# (glibc 2.31), like the other services. The desktop app downloads it when the
# user turns on document reading (Markdown/JSON export, the reading model).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/packaging/build/structure"
rm -rf "$OUT" && mkdir -p "$OUT"

podman run --rm -v "$ROOT:/src:ro,Z" -v "$OUT:/out:Z" docker.io/library/python:3.12-slim-bullseye bash -euo pipefail -c '
  apt-get update -qq && apt-get install -y -qq --no-install-recommends binutils >/dev/null
  mkdir -p /b && cd /b
  cp -r /src/services/structure/app ./app
  cp /src/packaging/linux/structure/openpdf_structure.py .
  find . -name __pycache__ -prune -exec rm -rf {} +
  pip install -q --no-cache-dir --root-user-action=ignore -r /src/services/structure/requirements.txt "pyinstaller==6.22.3"
  # the models, inside the program (app/models.py keeps only the ones the service runs)
  OPENPDF_STRUCTURE_MODELS=/b/structure-models python -m app.models
  # PyTorch headers and static libraries are only for building extensions
  SP=$(python -c "import site; print(site.getsitepackages()[0])")
  rm -rf "$SP/torch/include" "$SP/torch/share" "$SP"/torch/lib/*.a
  pyinstaller --noconfirm --clean --log-level WARN --onedir --name openpdf-structure \
      --distpath /b/dist --workpath /b/work --specpath /b \
      --add-data /b/structure-models:structure-models \
      --collect-all docling --collect-all docling_core --collect-all docling_parse --collect-all docling_ibm_models \
      --collect-submodules app --hidden-import app.vlm \
      --collect-all transformers --collect-data latex2mathml --collect-submodules torchvision \
      --copy-metadata docling-slim --copy-metadata docling-core --copy-metadata docling-parse \
      --copy-metadata docling-ibm-models --copy-metadata torch --copy-metadata transformers --copy-metadata pypdfium2 \
      --exclude-module tkinter --exclude-module matplotlib --exclude-module IPython \
      openpdf_structure.py
  python /src/packaging/linux/collect-licenses.py /b/dist/openpdf-structure
  cp /src/THIRD-PARTY-NOTICES.md /b/dist/openpdf-structure/
  cd /b/dist && tar -czf /out/openpdf-structure.tar.gz openpdf-structure
  du -sh /b/dist/openpdf-structure
'
ls -la "$OUT"
sha256sum "$OUT/openpdf-structure.tar.gz"
