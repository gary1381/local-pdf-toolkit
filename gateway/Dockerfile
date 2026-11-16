FROM docker.io/library/python:3.12-slim-bookworm

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin openpdf \
    && mkdir -p /data/sessions \
    && chown openpdf /data/sessions
COPY app ./app

ENV SESSION_DIR=/data/sessions
VOLUME ["/data/sessions"]
USER openpdf
EXPOSE 8090
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8090", "--workers", "1"]
