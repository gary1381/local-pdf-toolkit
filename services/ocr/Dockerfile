FROM docker.io/library/python:3.12-slim-bookworm

# OCR = OCRmyPDF (pages, text layer) + RapidOCR (recognition, PaddleOCR models
# on ONNX Runtime). No Tesseract, no Ghostscript.
WORKDIR /app
# ONNX Runtime 1.31 ships Microsoft "1DS" usage telemetry that uploads to
# mobile.events.data.microsoft.com. A local PDF tool sends nothing: this turns
# it off before the library loads (rapid_engine also calls
# onnxruntime.disable_telemetry_events()).
ENV ORT_DISABLE_TELEMETRY=1
COPY requirements.txt .
COPY app/__init__.py app/ocr_models.py ./app/
# One layer, so what is deleted here really leaves the image: fetch the models
# the service uses (RapidOCR would otherwise download them on first use), drop
# the bundled model it doesn't use, and parts of the packages never imported
# (ONNX Runtime's training/conversion tools, test suites).
RUN pip install --no-cache-dir -r requirements.txt \
    && python -m app.ocr_models \
    && cd /usr/local/lib/python3.12/site-packages \
    && rm -rf onnxruntime/transformers onnxruntime/tools onnxruntime/quantization onnxruntime/datasets \
    && find . -depth -type d -name tests -exec rm -rf {} +
COPY app ./app
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin openpdf
USER openpdf

EXPOSE 8091
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8091"]
