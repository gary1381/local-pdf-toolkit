#!/usr/bin/env bash
# Install the .deb (or run the AppImage) in a clean distribution container,
# open the app on a virtual display and run probe-installed.js against the
# services it brought along. Nothing else is installed: no Python, Java,
# qpdf or podman in the container. Then (test-open-file.sh) the app is started
# with PDF paths, as "Open with OpenPDF" does; that part adds dbus.
#
#   test-package.sh deb      docker.io/library/ubuntu:24.04
#   test-package.sh appimage docker.io/library/debian:12
set -euo pipefail
KIND=$1
IMAGE=$2
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BUNDLE="$ROOT/desktop/src-tauri/target/release/bundle"
SAMPLE="${SAMPLE:-$ROOT/packaging/linux/test/sample.pdf}"

# OCR=1: test installing the OCR add-on instead (needs a scanned SAMPLE and
# packaging/build/ocr/openpdf-ocr.tar.gz, offered as a local file).
# OCR=net: the same, but the app downloads the add-on from its published URL
# (checks the real release; set AUTOTEST_SECS high enough for the download).
# READING=1: test the document reading add-ons instead (the structure component and
# the model runtime from packaging/build/{structure,llama} as local files; the Fast
# model is downloaded from its pinned address). Use a SAMPLE with a table and a
# large AUTOTEST_SECS (the model download).
PROBE=probe-installed.js
EXTRA=()
if [[ -n "${READING:-}" ]]; then
  PROBE=probe-reading-install.js
  EXTRA=(-v "$ROOT/packaging/build/structure/openpdf-structure.tar.gz:/structure-pack.tar.gz:ro,Z" -e OPENPDF_STRUCTURE_PACK=/structure-pack.tar.gz
         -v "$ROOT/packaging/build/llama/openpdf-llama.tar.gz:/llama-pack.tar.gz:ro,Z" -e OPENPDF_LLAMA_PACK=/llama-pack.tar.gz)
elif [[ "${OCR:-}" == net ]]; then
  PROBE=probe-ocr-install.js
elif [[ -n "${OCR:-}" ]]; then
  PROBE=probe-ocr-install.js
  EXTRA=(-v "$ROOT/packaging/build/ocr/openpdf-ocr.tar.gz:/ocr-pack.tar.gz:ro,Z" -e OPENPDF_OCR_PACK=/ocr-pack.tar.gz)
fi

podman run --rm -v "$BUNDLE:/pkg:ro,Z" -v "$ROOT/packaging/linux/test:/t:ro,Z" -v "$SAMPLE:/sample.pdf:ro,Z" \
  "${EXTRA[@]}" -e PROBE="$PROBE" -e AUTOTEST_SECS="${AUTOTEST_SECS:-40}" -e KIND="$KIND" -e VERBOSE="${VERBOSE:-}" "$IMAGE" bash -euo pipefail -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  if [[ $KIND == deb ]]; then
    apt-get install -y -qq /pkg/deb/*.deb xvfb xauth >/dev/null
    APP=$(dpkg -L "$(dpkg-deb -f /pkg/deb/*.deb Package)" | grep "^/usr/bin/" | head -1)
  else
    # an AppImage needs FUSE, which containers lack: extract and run it instead.
    # It also uses the system graphics libraries (EGL/GL, tied to the GPU
    # driver) that every desktop has but a bare container lacks.
    apt-get install -y -qq xvfb xauth libgtk-3-0 libegl1 libgl1 libgles2 libgbm1 >/dev/null
    cp /pkg/appimage/*.AppImage /tmp/app.AppImage && chmod +x /tmp/app.AppImage
    (cd /tmp && ./app.AppImage --appimage-extract >/dev/null)
    APP=/tmp/squashfs-root/AppRun
  fi
  echo "system: $(. /etc/os-release; echo $PRETTY_NAME), glibc $(ldd --version | head -1 | grep -o "[0-9.]*$")"
  for p in python3 java qpdf podman docker; do command -v $p >/dev/null && echo "  has $p" || echo "  no $p"; done
  echo "app: $APP"
  export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1   # no user namespaces inside the test container
  export OPENPDF_AUTOTEST_OPEN=/sample.pdf OPENPDF_AUTOTEST_PRE=/t/$PROBE OPENPDF_AUTOTEST_SECS=${AUTOTEST_SECS:-40}
  start=$(date +%s)
  timeout $(( ${AUTOTEST_SECS:-40} + 90 )) xvfb-run -a "$APP" > /tmp/app.log 2>&1 || true
  grep -a -E "installed-test|openpdf-autotest\] (opened|first|cannot)" /tmp/app.log | sed "s/^.*\[installed-test\]/[installed-test]/" | head -30 || true
  grep -a -q "installed-test\] DONE" /tmp/app.log || echo "NO TEST RESULT (app output follows)"
  if [[ -n "${VERBOSE:-}" ]] || ! grep -a -q "installed-test\] DONE" /tmp/app.log; then
    echo "--- app output"; grep -a -v "installed-test" /tmp/app.log | head -60 || true
  fi
  bash /t/check-probe.sh /tmp/app.log
  echo "ran $(( $(date +%s) - start ))s"
  sleep 2
  left=$(ps -eo args | grep -E "openpdf-server|openpdf-ocr|openpdf-structure|llama-server|bin/java" | grep -v grep || true)
  [[ -z $left ]] && echo "services stopped with the app: yes" || { echo "LEFT RUNNING:"; echo "$left"; exit 1; }
  if [[ $PROBE == probe-installed.js ]]; then
    # "Open with OpenPDF": the launcher takes PDF files and pictures, then paths on the
    # command line open, also when given to the running app
    if [[ $KIND == deb ]]; then launcher=$(dpkg -L "$(dpkg-deb -f /pkg/deb/*.deb Package)" | grep "^/usr/share/applications/.*\.desktop$" | head -1)
    else launcher=$(ls /tmp/squashfs-root/*.desktop | head -1); fi
    grep -E "^(Exec|MimeType)=" "$launcher" | sed "s|^|[open-test] $launcher: |"
    grep -q "^Exec=.* %F$" "$launcher" && grep -q "^MimeType=application/pdf;image/jpeg;image/png;image/tiff;image/gif;image/bmp;$" "$launcher"
    # the extracted AppImage runs without the AppImage runtime: set what it would
    if [[ $KIND == appimage ]]; then
      APPIMAGE=/tmp/app.AppImage APPDIR=/tmp/squashfs-root bash /t/test-open-file.sh "$APP" /sample.pdf
    else
      bash /t/test-open-file.sh "$APP" /sample.pdf
    fi
    sleep 2
    left=$(ps -eo args | grep -E "openpdf-server|openpdf-ocr|openpdf-structure|llama-server|bin/java" | grep -v grep || true)
    [[ -z $left ]] || { echo "LEFT RUNNING after the open-file test:"; echo "$left"; exit 1; }
  fi
  if [[ $PROBE == probe-ocr-install.js ]]; then
    # 2nd start: the installed add-on comes up with the app
    OPENPDF_AUTOTEST_PRE=/t/probe-installed.js OPENPDF_AUTOTEST_SECS=40 timeout 130 xvfb-run -a "$APP" > /tmp/app2.log 2>&1 || true
    bash /t/check-probe.sh /tmp/app2.log
    grep -a -o "ocr status: installed=[a-z]*" /tmp/app2.log | sed "s/^/[restart] /" || echo "[restart] no result"
    grep -a -q "ocr status: installed=true" /tmp/app2.log
    # a tampered pack is refused (fresh data folder, so OCR is not installed)
    [[ -f /ocr-pack.tar.gz ]] || exit 0
    data=$(find / -path /proc -prune -o -type d -name "com.pdfgateway.desktop" -print 2>/dev/null | grep -v "^/usr" | head -1)
    rm -rf "$data"
    cp /ocr-pack.tar.gz /tmp/bad.tar.gz && printf "x" | dd of=/tmp/bad.tar.gz bs=1 seek=1000000 conv=notrunc 2>/dev/null
    OPENPDF_OCR_PACK=/tmp/bad.tar.gz OPENPDF_AUTOTEST_SECS=60 timeout 150 xvfb-run -a "$APP" > /tmp/app3.log 2>&1 || true
    grep -a -E "install: |OCR installed afterwards" /tmp/app3.log | sed "s/^.*\[installed-test\]/[tampered pack]/" || echo "[tampered pack] no result"
    grep -a -q "install: error" /tmp/app3.log
    [[ ! -d "$data/ocr" ]] && echo "[tampered pack] nothing installed" || { echo "[tampered pack] INSTALLED ANYWAY"; exit 1; }
  fi
  logs=$(find / -path /proc -prune -o -type d -name logs -path "*com.pdfgateway.desktop*" -print 2>/dev/null | head -1)
  if [[ -n $logs ]]; then grep -h -i -E "error|exception|traceback" "$logs"/*.log | head -8 || true; fi
'
