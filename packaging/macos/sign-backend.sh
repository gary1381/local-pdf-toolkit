#!/usr/bin/env bash
# Sign every program and library in the services folder with a Developer ID
# (hardened runtime, secure timestamp), before Tauri signs and bundles the app.
# Notarization rejects an app with any unsigned or ad-hoc signed code inside.
#
#   APPLE_SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)" \
#     packaging/macos/sign-backend.sh packaging/build/backend
set -euo pipefail
DIR="${1:?services folder}"
: "${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY}"
ENT="$(cd "$(dirname "$0")" && pwd)/entitlements.plist"

# Mach-O files: libraries first, then programs (a program's signature covers
# nothing else, but sign inner code before outer as Apple recommends).
libs=() progs=()
while IFS= read -r -d '' f; do
  case "$(file -b "$f")" in
    *Mach-O*dynamically\ linked\ shared\ library*|*Mach-O*bundle*) libs+=("$f") ;;
    *Mach-O*executable*) progs+=("$f") ;;
  esac
done < <(find "$DIR" -type f -print0)
echo "signing ${#libs[@]} libraries and ${#progs[@]} programs"
for f in "${libs[@]}"; do
  codesign --force --timestamp --options runtime --sign "$APPLE_SIGNING_IDENTITY" "$f"
done
for f in "${progs[@]}"; do
  codesign --force --timestamp --options runtime --entitlements "$ENT" --sign "$APPLE_SIGNING_IDENTITY" "$f"
done
codesign --verify --strict "${progs[@]}"
