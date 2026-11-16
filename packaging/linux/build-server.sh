#!/usr/bin/env bash
# Build openpdf-server: the gateway and the qpdf service as one PyInstaller
# program (onedir). Built in Debian bullseye (glibc 2.31) so the result runs
# on older distributions too. Output: packaging/build/server/openpdf-server/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/packaging/build/server"
rm -rf "$OUT" && mkdir -p "$OUT"

podman run --rm -v "$ROOT:/src:ro,Z" -v "$OUT:/out:Z" docker.io/library/python:3.12-slim-bullseye bash -euo pipefail -c '
  apt-get update -qq && apt-get install -y -qq --no-install-recommends binutils >/dev/null
  mkdir -p /b && cd /b
  cp -r /src/gateway/app ./app
  cp /src/services/qpdf/app/main.py ./qpdf_service.py
  cp /src/packaging/linux/server/openpdf_server.py .
  find . -name __pycache__ -prune -exec rm -rf {} +
  pip install -q --no-cache-dir --root-user-action=ignore \
      -r /src/gateway/requirements.txt -r /src/services/qpdf/requirements.txt "pyinstaller==6.22.3"
  pyinstaller --noconfirm --clean --log-level WARN --onedir --name openpdf-server \
      --distpath /out --workpath /b/work --specpath /b \
      --add-data /b/app/static:app/static \
      --collect-submodules app --hidden-import qpdf_service \
      --exclude-module uvloop --exclude-module httptools --exclude-module watchfiles \
      --exclude-module websockets --exclude-module tkinter \
      openpdf_server.py
  # Licence texts and source pointers of every bundled Python package.
  python /src/packaging/linux/collect-licenses.py /out/openpdf-server
  pip list 2>/dev/null | grep -i -E "^(pyinstaller|fastapi|uvicorn|httpx|pydantic) " || true
'
du -sh "$OUT/openpdf-server"
