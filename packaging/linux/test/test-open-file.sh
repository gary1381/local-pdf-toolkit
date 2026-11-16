#!/usr/bin/env bash
# "Open with OpenPDF", inside the test container (called by test-package.sh):
# start the installed app with a PDF path the way the system's launcher does
# (Exec=... %F), then start it again with a second PDF while it runs, which
# must hand the file to the running window. probe-open-file.js checks that
# both open in the editor and that Save writes back to them; here the files on
# disk are checked too. A third start hands over a picture, which must open as
# a new PDF and stay as it is on disk.
#
#   test-open-file.sh /usr/bin/pdf-gateway-desktop /sample.pdf
set -euo pipefail
APP=$1
SAMPLE=$2
D=/tmp/open-test   # the probe expects the files here

# A second start finds the running one over the session bus, as on any desktop.
command -v dbus-run-session >/dev/null || apt-get install -y -qq dbus >/dev/null
rm -rf "$D" && mkdir -p "$D"
cp "$SAMPLE" "$D/open me.pdf"
cp "$SAMPLE" "$D/second.pdf"
# a 64 x 48 grey checkerboard
echo "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAAAAACEICPDAAAAP0lEQVR4nO3MsREAMAzCQI+T/RdMGjNAKHWiU8HP2d3db48AAmiPaQEG0B7TAgygPaYFGEB7TAswgPaYFkAAD3RM6lukaxg/AAAAAElFTkSuQmCC" | base64 -d > "$D/photo.png"
touch -d 2001-01-01 "$D"/*.pdf "$D/photo.png"
unset OPENPDF_AUTOTEST_OPEN OPENPDF_AUTOTEST_PRE

cd "$D"   # relative paths, as a file manager or a shell may pass them
[[ -z ${APPIMAGE:-} ]] || export OWD=$D   # the AppImage runtime's note of where it was started
OPENPDF_AUTOTEST_RUN=/t/probe-open-file.js OPENPDF_AUTOTEST_SECS=${AUTOTEST_SECS:-60} \
  timeout $(( ${AUTOTEST_SECS:-60} + 180 )) dbus-run-session -- xvfb-run -a bash -c '
  "$0" "open me.pdf" > /tmp/open.log 2>&1 &
  for _ in $(seq 150); do grep -a -q "ready for the second start" /tmp/open.log && break; sleep 1; done
  start=$(date +%s)
  env -u OPENPDF_AUTOTEST_RUN "$0" second.pdf > /tmp/second.log 2>&1 && echo "[open-test] second start handed over its file and quit after $(( $(date +%s) - start ))s" \
    || echo "[open-test] SECOND START FAILED (exit $?)"
  for _ in $(seq 120); do grep -a -q "ready for the picture" /tmp/open.log && break; sleep 1; done
  env -u OPENPDF_AUTOTEST_RUN "$0" photo.png > /tmp/third.log 2>&1 || echo "[open-test] PICTURE START FAILED (exit $?)"
  wait' "$APP" || true
cd /

grep -a -E "installed-test\]|\[openpdf\] (opening|cannot open|saved to)" /tmp/open.log | sed "s/^.*\[installed-test\]/[open-test]/" | head -20 || true
if ! grep -a -q "installed-test\] DONE" /tmp/open.log; then
  echo "--- app output"; head -60 /tmp/open.log; echo "--- second start"; head -20 /tmp/second.log
fi
bash /t/check-probe.sh /tmp/open.log
# the second start must not have started its own services or window
! grep -a -q "installed-test" /tmp/second.log

ok=1
for f in "open me.pdf" second.pdf; do
  if [[ $(stat -c %Y "$D/$f") -gt $(date -d 2001-01-02 +%s) && $(head -c 5 "$D/$f") == %PDF- ]]; then
    echo "[open-test] written back: $f ($(stat -c %s "$D/$f") bytes)"
  else
    echo "[open-test] NOT WRITTEN BACK: $f"; ok=0
  fi
done
copies=$(find "$D" /tmp "$HOME" -maxdepth 2 -name "*.pdf" \( -name "open me*" -o -name "second*" \) ! -path "$D/open me.pdf" ! -path "$D/second.pdf" 2>/dev/null || true)
[[ -z $copies ]] || { echo "[open-test] SAVED AS A COPY INSTEAD:"; echo "$copies"; ok=0; }
if [[ $(stat -c %Y "$D/photo.png") -lt $(date -d 2001-01-02 +%s) ]]; then
  echo "[open-test] picture left as it was"
else
  echo "[open-test] PICTURE WAS CHANGED"; ok=0
fi
[[ $ok == 1 ]]
