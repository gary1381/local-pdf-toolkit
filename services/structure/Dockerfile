FROM docker.io/library/python:3.12-slim-bookworm

# Document structure = Docling (layout and reading order, tables) on the CPU.
# No OCR here: pages without text are reported, the OCR service handles them.
# Docling draws each page for its layout model itself; fonts a PDF does not
# embed (Helvetica, Times, SimSun...) come from the system. Without any, the
# page shows empty boxes instead of letters and the layout is misread.
# Liberation matches Helvetica/Times/Courier metrics; WenQuanYi covers Chinese.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fontconfig fonts-liberation2 fonts-wqy-microhei \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Models come with the image; nothing is fetched at run time.
ENV OPENPDF_STRUCTURE_MODELS=/models \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    PYTHONDONTWRITEBYTECODE=1
COPY requirements.txt .
COPY app/__init__.py app/models.py ./app/
# One layer, so what is deleted here really leaves the image: fetch the models,
# drop test suites and the bundled PyTorch headers and static libraries.
RUN pip install --no-cache-dir -r requirements.txt \
    && HF_HUB_OFFLINE=0 TRANSFORMERS_OFFLINE=0 python -m app.models \
    && cd /usr/local/lib/python3.12/site-packages \
    && rm -rf torch/include torch/share torch/lib/*.a \
    && find . -depth -type d -name tests -exec rm -rf {} +
COPY app ./app
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin openpdf
USER openpdf

EXPOSE 8094
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8094", "--log-level", "warning"]
