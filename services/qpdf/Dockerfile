FROM docker.io/library/python:3.12-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends qpdf \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin openpdf
USER openpdf

EXPOSE 8093
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8093"]
