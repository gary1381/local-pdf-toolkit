#!/usr/bin/env bash
# Start the services, then the desktop window (development build).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/start.sh"

# rustup installs cargo in ~/.cargo/bin, which is not always on PATH.
if ! command -v cargo >/dev/null 2>&1; then
  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  fi
  export PATH="$HOME/.cargo/bin:$PATH"
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "Rust is not installed. Install it from https://rustup.rs/ and run this again." >&2
  exit 1
fi

cd "$ROOT/desktop"
if [[ ! -d node_modules ]]; then
  npm install
fi
# Keep a copy of the output: the app prints one timing line per opened file.
LOG="${XDG_CACHE_HOME:-$HOME/.cache}/openpdf/desktop.log"
mkdir -p "$(dirname "$LOG")"
npm run dev 2>&1 | tee "$LOG"
