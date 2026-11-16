# Document reading model server: llama.cpp's llama-server with one model from
# catalog.json (MODEL_TIER=fast|best), downloaded on first start into /models
# and checked against its SHA-256. docs/OCR-MODELS.md.
#
#   podman build -t pdf-gateway-model services/model                      # CPU
#   podman build -t pdf-gateway-model --build-arg BACKEND=cuda services/model   # NVIDIA
ARG BACKEND=cpu
ARG LLAMA_COMMIT=1725dcab4baac46c4eb197afc96af7b57a81882a

FROM docker.io/library/ubuntu:22.04 AS build-cpu
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates cmake ninja-build g++ >/dev/null
FROM docker.io/nvidia/cuda:12.6.3-devel-ubuntu22.04 AS build-cuda
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates cmake ninja-build >/dev/null

FROM build-${BACKEND} AS build
ARG BACKEND
ARG LLAMA_COMMIT
WORKDIR /src
# a commit of llama.cpp pull request #24975's branch (Unlimited-OCR), pinned
RUN git init -q llama.cpp && cd llama.cpp \
 && git fetch -q --depth 1 https://github.com/ggml-org/llama.cpp "$LLAMA_COMMIT" \
 && git checkout -q FETCH_HEAD \
 && cmake -G Ninja -B build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DGGML_NATIVE=OFF \
      -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON \
      $( [ "$BACKEND" = cuda ] && echo "-DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=75;80;86;89" ) \
 && cmake --build build -j"$(nproc)" --target llama-server \
 && mkdir /out && cp build/bin/llama-server build/bin/*.so* /out/ && cp LICENSE /out/LICENSE-llama.cpp

FROM docker.io/library/ubuntu:22.04 AS run-cpu
FROM docker.io/nvidia/cuda:12.6.3-runtime-ubuntu22.04 AS run-cuda
FROM run-${BACKEND}
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends python3 ca-certificates libgomp1 curl >/dev/null \
 && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 --create-home openpdf && mkdir /models && chown openpdf /models
COPY --from=build /out/ /opt/llama/
COPY catalog.json serve.py /opt/model/
ENV LD_LIBRARY_PATH=/opt/llama MODEL_TIER=fast MODELS_DIR=/models PORT=8080
USER openpdf
EXPOSE 8080
CMD ["python3", "/opt/model/serve.py"]
