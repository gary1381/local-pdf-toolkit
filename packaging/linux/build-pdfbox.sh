#!/usr/bin/env bash
# Build the PDFBox service for the desktop installer:
#   packaging/build/pdfbox/app.jar      the service
#   packaging/build/pdfbox/jre/         a Java runtime cut down to the modules it uses (jlink)
#   packaging/build/pdfbox/fonts/       WenQuanYi Micro Hei (Chinese text written into PDFs)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/packaging/build/pdfbox"
M2="$ROOT/packaging/build/m2"          # Maven download cache, kept between builds
rm -rf "$OUT" && mkdir -p "$OUT/fonts" "$M2"

podman run --rm -v "$ROOT/services/pdfbox:/src:ro,Z" -v "$OUT:/out:Z" -v "$M2:/root/.m2:Z" \
    docker.io/library/maven:3.9.9-eclipse-temurin-17 bash -euo pipefail -c '
  cp -r /src /b && cd /b && rm -rf target
  mvn -q -DskipTests package
  cp target/pdfbox-service-0.1.0.jar /out/app.jar
'

# The runtime comes from the newest Java 17 (security fixes), not the JDK in the
# Maven image.
podman run --rm --pull=newer -v "$OUT:/out:Z" docker.io/library/eclipse-temurin:17-jdk bash -euo pipefail -c '
  mods=$(jdeps --ignore-missing-deps --print-module-deps --multi-release 17 /out/app.jar)
  # Added by hand: EC keys/certificates (signatures), extra charsets, zip file
  # system and DNS lookups for time-stamp servers, which jdeps cannot see.
  mods="$mods,jdk.crypto.ec,jdk.charsets,jdk.zipfs,jdk.naming.dns"
  echo "modules: $mods"
  jlink --add-modules "$mods" --strip-debug --no-man-pages --no-header-files \
        --compress=2 --output /out/jre
  /out/jre/bin/java -version 2>&1 | head -1
'

# The font, and its licence, from the Debian package.
podman run --rm -v "$OUT/fonts:/out:Z" docker.io/library/python:3.12-slim-bullseye bash -euo pipefail -c '
  cd /tmp && apt-get update -qq && apt-get download -qq fonts-wqy-microhei
  dpkg -x fonts-wqy-microhei_*.deb x
  cp x/usr/share/fonts/truetype/wqy/wqy-microhei.ttc /out/
  cp x/usr/share/doc/fonts-wqy-microhei/copyright /out/wqy-microhei.copyright
'
du -sh "$OUT"/*
