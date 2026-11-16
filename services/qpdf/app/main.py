import io
import json
import os
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

app = FastAPI(title="OpenPDF qpdf Service", version="0.2.0")

QPDF_TIMEOUT_SECONDS = 180
# The qpdf program: from PATH, or the copy bundled with the desktop app.
QPDF_BIN = os.environ.get("QPDF_BIN", "qpdf")
PAGE_RANGE_RE = re.compile(r"^\d+(-\d*)?(,\d+(-\d*)?)*$")
PAGE_LIST_RE = re.compile(r"^\d+(,\d+)*$")


def _run_qpdf(args: list[str]) -> str:
    try:
        done = subprocess.run(
            [QPDF_BIN, *args],
            check=True,
            capture_output=True,
            text=True,
            timeout=QPDF_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="qpdf timed out") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "qpdf failed").strip()
        raise HTTPException(status_code=422, detail=detail) from exc
    return done.stdout


def _qpdf_ranges(pages: str) -> str:
    """Our range syntax ("1-3,5,8-") in qpdf's ("1-3,5,8-z")."""
    return ",".join(part + "z" if part.endswith("-") else part for part in pages.split(","))


def _expand_ranges(pages: str, count: int) -> list[int]:
    out: list[int] = []
    for part in pages.split(","):
        if "-" in part:
            start_s, end_s = part.split("-", 1)
            start, end = int(start_s), int(end_s) if end_s else count
        else:
            start = end = int(part)
        if start < 1 or end > count or start > end:
            raise HTTPException(status_code=400, detail=f"page range {part} is out of range ({count} pages)")
        out.extend(range(start, end + 1))
    return out


async def _process(file: UploadFile, password: str, build_args) -> Response:
    """Write the upload to a temp dir, run qpdf, return the output PDF.

    The password goes through a file so it never shows up in the process list.
    """
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty PDF file")
    with tempfile.TemporaryDirectory(prefix="openpdf-qpdf-") as tmp:
        tmp_path = Path(tmp)
        in_file = tmp_path / "input.pdf"
        out_file = tmp_path / "output.pdf"
        in_file.write_bytes(content)
        args = ["--warning-exit-0"]
        if password:
            pw_file = tmp_path / "password.txt"
            pw_file.write_text(password, encoding="utf-8")
            args.append(f"--password-file={pw_file}")
        args.extend(build_args(str(in_file), str(out_file)))
        await run_in_threadpool(_run_qpdf, args)
        return Response(content=out_file.read_bytes(), media_type="application/pdf")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/decrypt")
async def decrypt(file: UploadFile = File(...), password: str = Form("")):
    return await _process(file, password, lambda i, o: ["--decrypt", i, o])


@app.post("/flatten")
async def flatten(
    file: UploadFile = File(...),
    password: str = Form(""),
    mode: str = Form("all"),
):
    if mode not in {"all", "print", "screen"}:
        raise HTTPException(status_code=400, detail="mode must be all, print, or screen")
    return await _process(file, password, lambda i, o: [f"--flatten-annotations={mode}", i, o])


@app.post("/rotate")
async def rotate(
    file: UploadFile = File(...),
    angle: int = Form(90),
    pages: str = Form(""),
    password: str = Form(""),
):
    """Rotate clockwise. ``pages`` uses qpdf range syntax (``1,3-5``); empty means every page."""
    if angle not in {0, 90, 180, 270}:
        raise HTTPException(status_code=400, detail="angle must be 0, 90, 180, or 270")
    pages = pages.replace(" ", "")
    if pages and not PAGE_RANGE_RE.match(pages):
        raise HTTPException(status_code=400, detail="invalid page range")
    # qpdf writes an open range "5-" as "5-z" (z = last page).
    qpdf_pages = _qpdf_ranges(pages) if pages else ""

    def build(i: str, o: str) -> list[str]:
        if not angle:
            return [i, o]
        spec = f"+{angle}" + (f":{qpdf_pages}" if qpdf_pages else "")
        return [f"--rotate={spec}", i, o]

    return await _process(file, password, build)


@app.post("/pages")
async def select_pages(
    file: UploadFile = File(...),
    order: str = Form(...),
    password: str = Form(""),
):
    """Keep only the listed 1-based pages, in the given order (delete + reorder)."""
    order = order.replace(" ", "")
    if not PAGE_LIST_RE.match(order):
        raise HTTPException(status_code=400, detail="order must look like 3,1,2")
    # "." means "the primary input file", so document metadata, outlines and
    # form fields from the original are kept.
    return await _process(file, password, lambda i, o: [i, "--pages", ".", order, "--", o])


@app.post("/encrypt")
async def encrypt(
    file: UploadFile = File(...),
    user_password: str = Form(...),
    owner_password: str = Form(""),
    key_length: int = Form(256),
):
    if key_length not in {128, 256}:
        raise HTTPException(status_code=400, detail="key_length must be 128 or 256")
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty PDF file")
    owner = owner_password or user_password
    with tempfile.TemporaryDirectory(prefix="openpdf-qpdf-") as tmp:
        tmp_path = Path(tmp)
        in_file = tmp_path / "input.pdf"
        out_file = tmp_path / "output.pdf"
        in_file.write_bytes(content)
        # A job file keeps passwords out of the process list and lets them
        # start with "-" without being read as options. 128-bit uses AES.
        key = "256bit" if key_length == 256 else "128bit"
        job = {
            "inputFile": str(in_file),
            "outputFile": str(out_file),
            "warningExit0": "",
            "encrypt": {
                "userPassword": user_password,
                "ownerPassword": owner,
                key: {} if key_length == 256 else {"useAes": "y"},
            },
        }
        job_file = tmp_path / "job.json"
        job_file.write_text(json.dumps(job), encoding="utf-8")
        await run_in_threadpool(_run_qpdf, [f"--job-json-file={job_file}"])
        return Response(content=out_file.read_bytes(), media_type="application/pdf")


@app.post("/merge")
async def merge(files: list[UploadFile] = File(...)):
    """Join PDFs in the given order. The first file's document-level data
    (metadata, outlines) is kept; form fields from every file are carried over."""
    if len(files) < 2:
        raise HTTPException(status_code=400, detail="merge needs at least two files")
    with tempfile.TemporaryDirectory(prefix="openpdf-qpdf-") as tmp:
        tmp_path = Path(tmp)
        paths = []
        for index, upload in enumerate(files):
            content = await upload.read()
            if not content:
                raise HTTPException(status_code=400, detail="Empty PDF file")
            path = tmp_path / f"in-{index}.pdf"
            path.write_bytes(content)
            paths.append(str(path))
        out_file = tmp_path / "merged.pdf"
        args = ["--warning-exit-0", paths[0], "--pages", ".", *paths[1:], "--", str(out_file)]
        await run_in_threadpool(_run_qpdf, args)
        return Response(content=out_file.read_bytes(), media_type="application/pdf")


@app.post("/split")
async def split(
    file: UploadFile = File(...),
    pages: str = Form(...),
    unify: bool = Form(True),
    password: str = Form(""),
):
    """Pages "1-3,5,8-": one PDF holding them (unify) or a ZIP with one PDF per page."""
    pages = pages.replace(" ", "")
    if not PAGE_RANGE_RE.match(pages):
        raise HTTPException(status_code=400, detail="invalid page range")
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty PDF file")
    stem = Path(file.filename or "document.pdf").stem or "document"
    with tempfile.TemporaryDirectory(prefix="openpdf-qpdf-") as tmp:
        tmp_path = Path(tmp)
        in_file = tmp_path / "input.pdf"
        in_file.write_bytes(content)
        base = ["--warning-exit-0"]
        if password:
            pw_file = tmp_path / "password.txt"
            pw_file.write_text(password, encoding="utf-8")
            base.append(f"--password-file={pw_file}")
        count = int((await run_in_threadpool(_run_qpdf, [*base, "--show-npages", str(in_file)])).strip() or 0)
        selected = _expand_ranges(pages, count)
        subset = tmp_path / "subset.pdf"
        await run_in_threadpool(
            _run_qpdf, [*base, str(in_file), "--pages", ".", ",".join(map(str, selected)), "--", str(subset)]
        )
        if unify:
            return Response(content=subset.read_bytes(), media_type="application/pdf")
        parts_dir = tmp_path / "parts"
        parts_dir.mkdir()
        await run_in_threadpool(_run_qpdf, ["--warning-exit-0", "--split-pages", str(subset), str(parts_dir / "p.pdf")])
        parts = sorted(parts_dir.glob("p-*.pdf"))
        if len(parts) != len(selected):
            raise HTTPException(status_code=500, detail="split produced an unexpected number of files")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            width = len(str(count))
            used: dict[int, int] = {}
            for page, part in zip(selected, parts):
                used[page] = used.get(page, 0) + 1
                extra = f"-{used[page]}" if used[page] > 1 else ""
                zf.write(part, f"{stem}-page-{page:0{width}d}{extra}.pdf")
        return Response(content=buf.getvalue(), media_type="application/zip")
