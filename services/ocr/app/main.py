"""OpenPDF OCR service: scanned PDF in, searchable PDF out.

OCRmyPDF does the page work (skips pages that already have text, renders,
deskews, writes the invisible text layer); RapidOCR does the recognition
(app/rapid_engine.py). OCR runs inside this process so the models load once,
at start-up, instead of once per request.
"""
import logging
import os
import re
import shutil
import tempfile
import threading
from pathlib import Path

import ocrmypdf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

from app import rapid_engine

log = logging.getLogger("openpdf.ocr")
app = FastAPI(title="OpenPDF OCR Service", version="0.6.0")

LANG_RE = re.compile(r"^[a-z_]{3,10}$")
PAGES_RE = re.compile(r"^\d+(-\d*)?(,\d+(-\d*)?)*$")
# Plugins by module name: imported once, so the loaded models are kept.
PLUGINS = ["app.pdfium_nosmooth", "app.rapid_engine"]
# Pages of one document OCRed in parallel (threads; ONNX Runtime releases the
# GIL). rapid_engine gives each page cpu_count / OCR_JOBS compute threads.
OCR_JOBS = int(os.environ.get("OPENPDF_OCR_JOBS", "4"))
# Documents OCRed at the same time; more would only compete for the CPU.
_slots = threading.BoundedSemaphore(int(os.environ.get("OPENPDF_OCR_DOCS", "1")))


@app.on_event("startup")
def _warm_up() -> None:
    # Load the models in the background so the first request doesn't wait.
    threading.Thread(target=rapid_engine.warm_up, daemon=True).start()


@app.get("/health")
def health():
    # "pictures": reads the pictures on pages with text (mode=images); "force":
    # reads pages again from their image (mode=force). Older builds have neither.
    return {"status": "ok", "pictures": True, "force": True}


def _user_message(exc: Exception) -> str:
    errors = ocrmypdf.exceptions
    if isinstance(exc, errors.DigitalSignatureError):
        return "USER:This PDF is digitally signed; OCR would change it and break the signature, so it was left as it is"
    if isinstance(exc, errors.InputFileError):
        return "USER:Cannot read this PDF: the file may be damaged or not a PDF"
    return str(exc) or type(exc).__name__


def _run(in_file: Path, out_file: Path, langs: list[str], deskew: bool, clean: bool,
         mode: str = "scans", pages: str = "") -> None:
    # images: also read the pictures on pages that have text (charts, photos of
    # signs, scanned inserts). OCRmyPDF's redo mode hides the page's own text
    # while it recognises, so only what is not already text is added (and an
    # earlier OCR layer is replaced). It cannot deskew or clean.
    # force: the pages become their image plus the text read from it, for text
    # that cannot be decoded (fonts without a Unicode map).
    options = {
        "images": {"redo_ocr": True},
        "force": {"force_ocr": True},
    }.get(mode, {"skip_text": True, "deskew": deskew, "clean": clean})
    with _slots:
        try:
            ocrmypdf.ocr(
                in_file, out_file,
                language=langs, pages=pages or None, **options,
                # Plain PDF + pypdfium rasterizer: no Ghostscript (AGPL).
                # optimize=1 is lossless.
                output_type="pdf", rasterizer="pypdfium", optimize=1, pdf_renderer="fpdf2",
                jobs=OCR_JOBS, use_threads=True, plugins=PLUGINS, progress_bar=False,
            )
        except ocrmypdf.exceptions.ExitCodeException as exc:
            # Bad input. "USER:" messages are shown to people as they are by
            # the gateway; the others (e.g. "encrypted") it words itself.
            raise HTTPException(status_code=422, detail=_user_message(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            log.exception("OCR failed")
            raise HTTPException(status_code=500, detail=f"OCR failed: {exc}"[:2000]) from exc


@app.post("/ocr")
async def ocr(
    file: UploadFile = File(...),
    languages: str = Form("eng"),
    deskew: str = Form("false"),
    clean: str = Form("false"),
    mode: str = Form("scans"),
    pages: str = Form(""),
):
    """mode=scans: pages without text only (the default). mode=images: also the
    pictures on pages with text. mode=force: the pages read again from their
    image, their text replaced (use with pages). pages: 1-based, like 1-3,5
    (empty: all)."""
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty PDF file")

    langs = [lang.strip() for lang in languages.split(",") if lang.strip()]
    if not langs or not all(LANG_RE.match(lang) for lang in langs):
        raise HTTPException(status_code=400, detail="Invalid OCR language list")
    unknown = sorted(set(langs) - rapid_engine.LANGUAGES)
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unsupported OCR language: {', '.join(unknown)}")
    # One model reads Chinese and English together, so the choice only needs
    # to be valid; it doesn't change the result.

    if mode not in ("scans", "images", "force"):
        raise HTTPException(status_code=400, detail="mode must be scans, images or force")
    if pages and not PAGES_RE.match(pages):
        raise HTTPException(status_code=400, detail="Invalid page range")

    want_clean = clean.lower() == "true"
    if want_clean and shutil.which("unpaper") is None:
        # --clean needs unpaper, left out on purpose (it pulls in ffmpeg,
        # ~100 packages). The UI never asks for it.
        raise HTTPException(
            status_code=400,
            detail="The 'clean' option is not available in this build (unpaper is not installed).",
        )

    with tempfile.TemporaryDirectory(prefix="openpdf-ocr-") as tmp:
        in_file = Path(tmp) / "input.pdf"
        out_file = Path(tmp) / "output.pdf"
        in_file.write_bytes(content)
        await run_in_threadpool(_run, in_file, out_file, langs, deskew.lower() == "true", want_clean,
                                mode, pages)
        if not out_file.exists():
            raise HTTPException(status_code=500, detail="OCR output file missing")
        return Response(content=out_file.read_bytes(), media_type="application/pdf")
