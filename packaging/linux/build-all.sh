#!/usr/bin/env bash
# Build the Linux installers: .deb and AppImage, with the services bundled.
#
#   packaging/linux/build-all.sh            everything
#   SKIP_SERVICES=1 packaging/linux/build-all.sh   reuse packaging/build/{server,pdfbox}
#
# Needs: podman (service builds run in containers), Rust (cargo), Node (npm).
# Output: desktop/src-tauri/target/release/bundle/{deb,appimage}/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
B="$ROOT/packaging/build"
QPDF_VERSION=12.4.2

if [[ "${SKIP_SERVICES:-}" != "1" ]]; then
  "$ROOT/packaging/linux/build-server.sh"
  "$ROOT/packaging/linux/build-pdfbox.sh"
fi

# qpdf: the official Linux build, checked against the release's SHA-256 list.
Q="$B/dl-qpdf"
mkdir -p "$Q"
zip="qpdf-$QPDF_VERSION-bin-linux-x86_64.zip"
if [[ ! -f "$Q/$zip" ]]; then
  curl -fsSL -o "$Q/$zip" "https://github.com/qpdf/qpdf/releases/download/v$QPDF_VERSION/$zip"
  curl -fsSL -o "$Q/qpdf-$QPDF_VERSION.sha256" "https://github.com/qpdf/qpdf/releases/download/v$QPDF_VERSION/qpdf-$QPDF_VERSION.sha256"
fi
(cd "$Q" && grep " $zip\$" "qpdf-$QPDF_VERSION.sha256" | sha256sum -c -)

# Assemble the resource folder the app looks for (see desktop/src-tauri/src/backend.rs).
R="$B/backend"
rm -rf "$R" && mkdir -p "$R/qpdf"
cp -a "$B/server/openpdf-server" "$R/server"
cp -a "$B/pdfbox" "$R/pdfbox"
unzip -q "$Q/$zip" -d "$R/qpdf"
# Tauri copies resources file by file: replace symlinks with the files they point to.
find "$R" -type l | while read -r link; do
  target="$(readlink -f "$link")"; rm "$link"; cp -a "$target" "$link"
done
cp "$ROOT/THIRD-PARTY-NOTICES.md" "$R/"
# jlink leaves some files read-only; Tauri must be able to copy over them next build.
chmod -R u+w "$R"
rm -rf "$ROOT/desktop/src-tauri/target/release/backend"
du -sh "$R"/*

# The OCR add-on's SHA-256 is built into the app, so a download can be checked.
if [[ -f "$B/ocr/openpdf-ocr.tar.gz" ]]; then
  export OPENPDF_OCR_SHA256="$(sha256sum "$B/ocr/openpdf-ocr.tar.gz" | cut -d' ' -f1)"
  echo "OCR add-on SHA-256: $OPENPDF_OCR_SHA256"
fi
# Likewise the document reading add-ons (build-structure.sh, build-llama.sh); the
# model files themselves are checked against services/model/catalog.json.
if [[ -f "$B/structure/openpdf-structure.tar.gz" ]]; then
  export OPENPDF_STRUCTURE_SHA256="$(sha256sum "$B/structure/openpdf-structure.tar.gz" | cut -d' ' -f1)"
  echo "structure add-on SHA-256: $OPENPDF_STRUCTURE_SHA256"
fi
if [[ -f "$B/llama/openpdf-llama.tar.gz" ]]; then
  export OPENPDF_LLAMA_SHA256="$(sha256sum "$B/llama/openpdf-llama.tar.gz" | cut -d' ' -f1)"
  echo "model runtime SHA-256: $OPENPDF_LLAMA_SHA256"
fi

[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"
# The AppImage step (linuxdeploy) checks every program it packs for missing
# libraries. Java (libjvm.so) and the PyInstaller program (_internal/) find
# their own libraries at run time, so show linuxdeploy where they are.
APPDIR="$ROOT/desktop/src-tauri/target/release/bundle/appimage/OpenPDF.AppDir/usr/lib/OpenPDF/backend"
export LD_LIBRARY_PATH="$APPDIR/pdfbox/jre/lib/server:$APPDIR/pdfbox/jre/lib:$APPDIR/server/_internal${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
cd "$ROOT/desktop"
[[ -d node_modules ]] || npm install
npx tauri build --config "$ROOT/packaging/linux/tauri.bundle.json" --bundles deb,appimage
ls -la "$ROOT/desktop/src-tauri/target/release/bundle/deb/" "$ROOT/desktop/src-tauri/target/release/bundle/appimage/" 2>/dev/null
