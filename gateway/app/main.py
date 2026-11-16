import logging
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app import document_store
from app.config import settings
from app.routers.pdf import router as pdf_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

STATIC_DIR = Path(__file__).resolve().parent / "static"

CONTENT_SECURITY_POLICY = "; ".join(
    [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "worker-src 'self' blob:",
        "connect-src 'self'",
        "frame-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ]
)

app = FastAPI(
    title="OpenPDF Gateway",
    description="PDF editor and REST API: OCR (OCRmyPDF + RapidOCR), editing and signatures (PDFBox), "
    "merge/split and page tools (qpdf).",
    version="0.2.0",
)


@app.middleware("http")
async def guard_requests(request: Request, call_next):
    # Reject cross-site API calls (a web page in the user's browser posting to
    # the local gateway). Same-origin requests and non-browser clients pass.
    if request.url.path.startswith("/v1/"):
        origin = request.headers.get("origin")
        if origin and urlsplit(origin).netloc.lower() != request.headers.get("host", "").lower():
            return JSONResponse({"detail": "Cross-site request refused"}, status_code=403)
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > settings.max_upload_bytes * 2 + 1024 * 1024:
            return JSONResponse(
                {"detail": f"Upload too large (limit {settings.max_upload_mb} MB per file)"}, status_code=413
            )

    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    if request.url.path.startswith("/ui/") or request.url.path == "/":
        response.headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY
        response.headers["Cache-Control"] = "no-cache"
    return response


app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_host_list or ["127.0.0.1"])


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, exc: RequestValidationError):
    fields = []
    for err in exc.errors():
        loc = [str(p) for p in err.get("loc", []) if p not in ("body", "query", "path")]
        if loc:
            fields.append(".".join(loc))
    message = "Invalid request parameters" + (f": {', '.join(fields)}" if fields else "")
    return JSONResponse({"detail": message}, status_code=422)


app.include_router(pdf_router)
app.mount("/ui", StaticFiles(directory=STATIC_DIR), name="ui")


@app.get("/")
async def home():
    return RedirectResponse(url="/ui/index.html")


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return RedirectResponse(url="/ui/favicon.svg")


@app.get("/health")
async def health():
    return {"status": "ok", **document_store.stats()}
