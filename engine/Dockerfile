# PDF engine for AI agents: every PDF service plus the MCP server, one image.
# Build from the repository root:
#   podman build -f engine/Dockerfile -t pdf-engine .
# Use (MCP over stdio, the folder shared at the same path inside):
#   docker run -i --rm -v "$HOME/Documents:$HOME/Documents" pdf-engine mcp
# With the document structure add-on (Docling: pdf_outline, pdf_read_markdown,
# pdf_structure; about 1.5 GB more):
#   podman build -f engine/Dockerfile --build-arg WITH_STRUCTURE=1 -t pdf-engine:structure .

# ---- PDFBox service (Java) and a Java runtime cut down to what it uses
FROM docker.io/library/maven:3.9.9-eclipse-temurin-17 AS java
WORKDIR /src
COPY services/pdfbox/pom.xml .
RUN mvn -q dependency:go-offline
COPY services/pdfbox/src ./src
RUN mvn -q -DskipTests package \
 && mods=$(jdeps --ignore-missing-deps --print-module-deps --multi-release 17 target/pdfbox-service-0.1.0.jar) \
 && jlink --add-modules "$mods,jdk.crypto.ec,jdk.charsets,jdk.zipfs,jdk.naming.dns" \
      --strip-debug --no-man-pages --no-header-files --compress=2 --output /jre

# ---- the engine
FROM docker.io/library/python:3.12-slim-bookworm
ARG WITH_STRUCTURE=0
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    ORT_DISABLE_TELEMETRY=1 \
    OPENPDF_STRUCTURE_MODELS=/opt/structure-models \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 \
    PDF_ENGINE_CONTAINER=1 \
    HOME=/tmp \
    CJK_FONT_PATH=/usr/share/fonts/truetype/wqy/wqy-microhei.ttc
# qpdf (page tools), Latin + Chinese fonts (also what Docling draws pages with
# when a PDF does not embed its fonts), the font libraries Java draws with
RUN apt-get update \
 && apt-get install -y --no-install-recommends qpdf fonts-wqy-microhei fonts-liberation2 fontconfig libfreetype6 tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=java /jre /opt/jre
WORKDIR /app
COPY gateway/requirements.txt req-gateway.txt
COPY services/qpdf/requirements.txt req-qpdf.txt
COPY services/ocr/requirements.txt req-ocr.txt
COPY services/structure/requirements.txt req-structure.txt
COPY services/ocr/app/__init__.py services/ocr/app/ocr_models.py ./ocr/app/
COPY services/structure/app/__init__.py services/structure/app/models.py ./structure/app/
# One layer, so what is deleted really leaves the image: the OCR models (and
# with WITH_STRUCTURE=1 Docling and its models) are fetched now (nothing is
# downloaded at run time), unused parts of ONNX Runtime and PyTorch and test
# suites go.
RUN if [ "$WITH_STRUCTURE" = 1 ]; then extra="-r req-structure.txt"; else extra=""; fi \
 && pip install --no-cache-dir -r req-gateway.txt -r req-qpdf.txt -r req-ocr.txt $extra mcp==1.30.0 \
 && (cd ocr && python -m app.ocr_models) \
 && if [ "$WITH_STRUCTURE" = 1 ]; then \
      (cd structure && HF_HUB_OFFLINE=0 TRANSFORMERS_OFFLINE=0 python -m app.models); fi \
 && cd /usr/local/lib/python3.12/site-packages \
 && rm -rf onnxruntime/transformers onnxruntime/tools onnxruntime/quantization onnxruntime/datasets \
      torch/include torch/share \
 && find . -depth -type d -name tests -exec rm -rf {} + \
 && rm -f /app/req-*.txt
COPY --from=java /src/target/pdfbox-service-0.1.0.jar /app/pdfbox/app.jar
COPY gateway/app /app/gateway/app
COPY services/qpdf/app /app/qpdf/app
COPY services/ocr/app /app/ocr/app
COPY services/structure/app /app/structure/app
COPY engine/pdf_engine /app/engine/pdf_engine
COPY THIRD-PARTY-NOTICES.md /app/
ENV PYTHONPATH=/app/engine
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin engine \
 && python -c "import pdf_engine.server" \
 && fc-cache -f >/dev/null
USER engine
# MCP Registry ownership check: must equal "name" in server.json
LABEL io.modelcontextprotocol.server.name="io.github.gary1381/pdf-engine" \
      org.opencontainers.image.title="PDF Engine" \
      org.opencontainers.image.description="Local PDF tools for AI agents (MCP)" \
      org.opencontainers.image.licenses="Apache-2.0"
EXPOSE 8090 8765
ENTRYPOINT ["/usr/bin/tini", "--", "python", "-m", "pdf_engine.launcher"]
CMD ["mcp"]
