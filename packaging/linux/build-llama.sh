#!/usr/bin/env bash
# Build the reading-model runtime for the desktop app: llama.cpp's llama-server
# (services/model/catalog.json's pinned commit), packed as
# packaging/build/llama/openpdf-llama.tar.gz. Built in Ubuntu 22.04 (glibc 2.35,
# the desktop app's minimum) with every CPU variant (the best one for the
# computer is picked at start) and the Vulkan backend, so NVIDIA, AMD and Intel
# GPUs work without CUDA. No OpenMP (llama.cpp's own thread pool): libgomp is
# not on every system. The models themselves are downloaded by the app.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/packaging/build/llama"
COMMIT="$(python3 -c "import json; print(json.load(open('$ROOT/services/model/catalog.json'))['llama_cpp']['commit'])")"
rm -rf "$OUT" && mkdir -p "$OUT"

podman run --rm -v "$ROOT:/src:ro,Z" -v "$OUT:/out:Z" -e COMMIT="$COMMIT" docker.io/library/ubuntu:22.04 bash -euo pipefail -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates cmake ninja-build g++ \
    curl xz-utils patchelf >/dev/null
  # Ubuntu 22.04 has no glslc and older Vulkan headers: LunarG Vulkan SDK, for
  # building only (the computer running OpenPDF supplies its own Vulkan loader;
  # without one the Vulkan part does not load and the model runs on the CPU)
  SDK=1.4.321.1
  curl -fsSL "https://sdk.lunarg.com/sdk/download/$SDK/linux/vulkansdk-linux-x86_64-$SDK.tar.xz" | tar -xJ -C /opt
  export VULKAN_SDK=/opt/$SDK/x86_64 PATH=/opt/$SDK/x86_64/bin:$PATH LD_LIBRARY_PATH=/opt/$SDK/x86_64/lib
  glslc --version | head -1
  git init -q /b/llama.cpp && cd /b/llama.cpp
  git fetch -q --depth 1 https://github.com/ggml-org/llama.cpp "$COMMIT" && git checkout -q FETCH_HEAD
  cmake -G Ninja -B build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DGGML_NATIVE=OFF \
    -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON -DGGML_VULKAN=ON -DGGML_OPENMP=OFF -DCMAKE_INSTALL_RPATH="\$ORIGIN" \
    -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON >/dev/null
  cmake --build build -j"$(nproc)" --target llama-server >/dev/null
  D=/b/openpdf-llama && mkdir -p $D
  cp build/bin/llama-server build/bin/*.so* $D/
  for f in $D/llama-server $D/*.so*; do patchelf --set-rpath "\$ORIGIN" "$f" 2>/dev/null || true; done
  cp LICENSE $D/LICENSE-llama.cpp
  cp /src/services/model/catalog.json $D/
  echo "$COMMIT" > $D/LLAMA_CPP_COMMIT
  cd /b && tar -czf /out/openpdf-llama.tar.gz openpdf-llama
  du -sh $D; ls $D
'
ls -la "$OUT"
sha256sum "$OUT/openpdf-llama.tar.gz"
