#!/usr/bin/env bash
# A printed DONE line is not enough: all checks must have passed.
set -euo pipefail
awk '
  /\[installed-test\] FAIL / { failed = 1 }
  match($0, /\[installed-test\] DONE [0-9]+\/[0-9]+/) {
    summary = substr($0, RSTART, RLENGTH)
    sub(/^.*DONE /, "", summary)
    split(summary, counts, "/")
    done++
    passed = counts[1] + 0
    total = counts[2] + 0
  }
  END {
    if (done != 1 || failed || total < 1 || passed != total) {
      print "Package probe failed or did not complete" > "/dev/stderr"
      exit 1
    }
  }
' "${1:?probe log required}"
