#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
check() {
  local expected=$1 text=$2 code=0
  printf '%s\n' "$text" > "$TMP/probe.log"
  bash "$HERE/check-probe.sh" "$TMP/probe.log" >/dev/null 2>&1 || code=$?
  [[ $code == "$expected" ]] || { echo "Unexpected status $code (expected $expected): $text"; exit 1; }
}
check 0 $'[installed-test] PASS open\n[installed-test] DONE 1/1'
check 1 $'[installed-test] FAIL open\n[installed-test] DONE 0/1'
check 1 '[installed-test] DONE 10/11'
check 1 '[installed-test] PASS open'
check 1 '[installed-test] DONE 0/0'
check 1 $'[installed-test] FAIL open\n[installed-test] DONE 1/1'
check 1 $'[installed-test] DONE 1/1\n[installed-test] DONE 1/1'
check 1 ''
echo '8/8 package result gate checks passed'
