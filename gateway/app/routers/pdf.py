"""REST API for the PDF gateway.

Every editing endpoint accepts either an uploaded ``file`` (stateless: the
edited PDF is returned) or a ``document_id`` from ``/register`` (the edit is
applied to the server-side session under a per-document lock and a small JSON
result with the new revision number is returned).
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Awaitable, Callable

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response

from app import document_store
from app.auth import require_api_key
from app.clients import ocr, pdfbox, qpdf, structure
from app.config import settings

log = logging.getLogger("openpdf.api")

router = APIRouter(
    prefix="/v1/pdf",
    tags=["pdf"],
    dependencies=[Depends(require_api_key)],
)

SESSION_EXPIRED_MESSAGE = "The editing session has expired or does not exist; open the file again"
MAX_IMAGE_BYTES = 20 * 1024 * 1024
PAGE_LIST_RE = re.compile(r"^\s*\d+\s*(,\s*\d+\s*)*$")
PAGE_RANGE_RE = re.compile(r"^\s*(\d+\s*(-\s*\d*)?)(\s*,\s*\d+\s*(-\s*\d*)?)*\s*$")
OCR_LANGUAGES = {"eng", "chi_sim"}

OpResult = bytes | tuple[bytes, dict]
Operation = Callable[[bytes, str], Awaitable[OpResult]]


# ---------------------------------------------------------------- errors


def session_expired() -> HTTPException:
    return HTTPException(
        status_code=404,
        detail=SESSION_EXPIRED_MESSAGE,
        headers={"X-Error-Code": "session_expired"},
    )


def _upstream_detail(resp: httpx.Response) -> str:
    try:
        data = resp.json()
        if isinstance(data, dict) and "detail" in data:
            return str(data["detail"])
    except ValueError:
        pass
    return resp.text or ""


def upstream_error(action: str, exc: Exception) -> HTTPException:
    """Turn a failure from a helper service into a short message for people.

    The raw upstream text (which can name internal hosts) only goes to the log.
    """
    if isinstance(exc, HTTPException):
        return exc
    if isinstance(exc, httpx.TimeoutException):
        return HTTPException(504, f"{action} timed out: the file may be too large; try again later")
    raw = None
    status = None
    if isinstance(exc, httpx.HTTPStatusError):
        raw = _upstream_detail(exc.response)
        status = exc.response.status_code
        if raw.startswith("USER:"):
            # a message written for people by the helper service (e.g. wrong certificate password)
            return HTTPException(400, raw[5:])
        log.warning("%s failed upstream (%s): %s", action, exc.response.status_code, raw[:800])
    elif isinstance(exc, RuntimeError):  # client helpers that read the error body themselves
        raw = str(exc)
        log.warning("%s failed upstream: %s", action, raw[:800])
    if raw is not None:
        low = raw.lower()
        if any(k in low for k in ("password", "encrypt", "decrypt")):
            return HTTPException(400, "The PDF is encrypted, or the password is wrong")
        if "out of range" in low or "page range" in low or "invalid page" in low:
            return HTTPException(400, "Page number is outside the document")
        if "no glyph" in low or "is not available in the font" in low or "cjk font" in low:
            return HTTPException(422, f"{action} failed: the font has no glyphs for some of the characters")
        if "language" in low and "ocr" in action.lower():
            return HTTPException(400, "OCR language not available; supported: eng (English) and chi_sim (Chinese)")
        if "image" in low and any(k in low for k in ("unsupported", "decode", "format")):
            return HTTPException(400, "Unsupported image format; use PNG or JPEG")
        if "no fields were filled" in low:
            return HTTPException(422, "No field was updated: the fields may not exist or are read-only")
        if "no acroform" in low:
            return HTTPException(400, "This PDF has no fillable form fields")
        if "no module named" in low:
            # a component built without one of its parts: not the file's fault
            missing = re.search(r"no module named '?([\w.]+)", raw, re.I)
            return HTTPException(500, f"{action} failed: the component that does this is incomplete"
                                      f"{f' (missing {missing.group(1)})' if missing else ''}; reinstall it or update OpenPDF")
        if status is not None and status >= 500:
            # the service itself failed: say so, with its reason when it names nothing internal
            reason = raw.split(":", 1)[-1].strip() if ":" in raw[:60] else raw.strip()
            safe = reason and len(reason) < 200 and not re.search(r"https?://|/home/|/tmp/|\\", reason)
            return HTTPException(500, f"{action} failed: error in the background component{f' ({reason})' if safe else ''}")
        return HTTPException(422, f"{action} failed: the PDF could not be processed (it may be damaged or unsupported)")
    if isinstance(exc, httpx.HTTPError):
        log.warning("%s failed, service unreachable: %r", action, exc)
        return HTTPException(503, f"{action} failed: a background service is not running or is restarting; try again shortly")
    log.exception("%s failed", action)
    return HTTPException(500, f"{action} failed: internal server error")


# ---------------------------------------------------------------- inputs


async def read_pdf_upload(file: UploadFile) -> bytes:
    content = await file.read(settings.max_upload_bytes + 1)
    if not content:
        raise HTTPException(400, "The file is empty")
    if len(content) > settings.max_upload_bytes:
        raise HTTPException(413, f"File too large (limit {settings.max_upload_mb} MB)")
    if b"%PDF-" not in content[:1024]:
        raise HTTPException(400, f"'{file.filename or 'file'}' is not a valid PDF file")
    return content


async def read_image_upload(image: UploadFile) -> bytes:
    content = await image.read(MAX_IMAGE_BYTES + 1)
    if not content:
        raise HTTPException(400, "The image is empty")
    if len(content) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "Image too large (limit 20 MB)")
    if not (content.startswith(b"\x89PNG") or content.startswith(b"\xff\xd8")):
        raise HTTPException(400, "Unsupported image format; use PNG or JPEG")
    return content


async def load_document(file: UploadFile | None, document_id: str) -> tuple[bytes, str]:
    """Read-only access to either an upload or the current session revision."""
    if document_id:
        entry = document_store.get(document_id)
        if entry is None:
            raise session_expired()
        try:
            return await document_store.read(document_id), entry.filename
        except (document_store.SessionNotFound, FileNotFoundError):
            raise session_expired()
    if file is None:
        raise HTTPException(400, "Provide a PDF file or a document_id")
    return await read_pdf_upload(file), file.filename or "document.pdf"


async def _run(action: str, op: Operation, content: bytes, filename: str) -> tuple[bytes, dict]:
    try:
        result = await op(content, filename)
    except Exception as exc:  # noqa: BLE001 - mapped to a user-facing message
        raise upstream_error(action, exc) from exc
    if isinstance(result, tuple):
        return result
    return result, {}


async def mutate(
    action: str,
    op: Operation,
    *,
    file: UploadFile | None,
    document_id: str,
    lightweight: bool = False,
    new_filename: str | None = None,
    response_headers: Callable[[dict], dict] | None = None,
):
    """Apply an edit to a session (locked) or to an uploaded file (stateless)."""
    if document_id:
        if document_store.get(document_id) is None:
            raise session_expired()
        async with document_store.lock(document_id):
            entry = document_store.get(document_id)
            if entry is None:
                raise session_expired()
            content = await document_store.read(document_id)
            out, info = await _run(action, op, content, entry.filename)
            previous, revision = await document_store.update(document_id, out, new_filename)
        return {
            "ok": True,
            "document_id": document_id,
            "revision": revision,
            "previous_revision": previous,
            **info,
        }

    content, filename = await load_document(file, "")
    out, info = await _run(action, op, content, filename)
    if lightweight:
        doc_id = await document_store.create(out, new_filename or filename)
        return {"ok": True, "document_id": doc_id, "revision": 1, "previous_revision": None, **info}
    headers = response_headers(info) if response_headers else {}
    return Response(content=out, media_type="application/pdf", headers=headers)


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


# ---------------------------------------------------------------- sessions


@router.post("/register")
async def register_document(file: UploadFile = File(...)):
    content = await read_pdf_upload(file)
    doc_id = await document_store.create(content, file.filename or "document.pdf")
    return {"document_id": doc_id, "revision": 1}


@router.get("/document/{document_id}/meta")
async def get_document_meta(document_id: str):
    entry = document_store.get(document_id)
    if entry is None:
        raise session_expired()
    return {
        "document_id": document_id,
        "revision": entry.revision,
        "revisions": entry.revisions,
        "size": entry.size,
        "etag": entry.etag,
        "filename": entry.filename,
    }


@router.get("/document/{document_id}")
async def get_document(document_id: str, request: Request):
    entry = document_store.get(document_id)
    if entry is None:
        raise session_expired()
    # Capture the revision first: an edit may finish while the file is read.
    revision = entry.revision
    try:
        content = await document_store.read(document_id, revision)
    except (document_store.SessionNotFound, document_store.RevisionNotFound, FileNotFoundError):
        raise session_expired()
    headers = {
        "ETag": f'"{document_store.content_etag(content)}"',
        "X-Document-Revision": str(revision),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
    }
    range_header = request.headers.get("range")
    if range_header:
        match = re.fullmatch(r"bytes=(\d+)-(\d*)", range_header.strip())
        if match:
            start = int(match.group(1))
            end = int(match.group(2)) if match.group(2) else len(content) - 1
            end = min(end, len(content) - 1)
            if start <= end and start < len(content):
                chunk = content[start : end + 1]
                headers["Content-Range"] = f"bytes {start}-{end}/{len(content)}"
                return Response(content=chunk, status_code=206, media_type="application/pdf", headers=headers)
    return Response(content=content, media_type="application/pdf", headers=headers)


@router.post("/document/{document_id}/restore")
async def restore_revision(document_id: str, revision: int = Form(...)):
    """Make a kept revision current again (used for undo and redo)."""
    if document_store.get(document_id) is None:
        raise session_expired()
    async with document_store.lock(document_id):
        try:
            previous, current = await document_store.restore(document_id, revision)
        except document_store.RevisionNotFound:
            raise HTTPException(410, "That step is beyond the undo history")
        except document_store.SessionNotFound:
            raise session_expired()
    return {"ok": True, "document_id": document_id, "revision": current, "previous_revision": previous}


@router.delete("/document/{document_id}")
async def close_document(document_id: str):
    if document_store.get(document_id) is not None:
        async with document_store.lock(document_id):
            await document_store.delete(document_id)
    return {"ok": True}


# ---------------------------------------------------------------- read-only


@router.post("/render-page")
async def render_page(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    page_index: int = Form(0),
    scale: float = Form(1.5),
    password: str = Form(""),
):
    content, filename = await load_document(file, document_id)
    try:
        png = await pdfbox.render_page(
            settings.pdfbox_url,
            filename,
            content,
            page_index=page_index,
            scale=clamp(scale, 0.1, 4.0),
            password=password,
        )
    except Exception as exc:
        raise upstream_error("Rendering the page", exc) from exc
    return Response(content=png, media_type="image/png")


@router.post("/merge")
async def merge(files: list[UploadFile] = File(...)):
    if len(files) < 2:
        raise HTTPException(400, "Merging needs at least two PDF files")
    payloads: list[tuple[str, bytes]] = []
    total = 0
    for f in files:
        content = await read_pdf_upload(f)
        total += len(content)
        if total > settings.max_upload_bytes * 2:
            raise HTTPException(413, f"Total size is over the limit ({settings.max_upload_mb * 2} MB)")
        payloads.append((f.filename or "document.pdf", content))
    try:
        merged = await qpdf.merge_pdfs(settings.qpdf_url, payloads)
    except Exception as exc:
        raise upstream_error("Merge", exc) from exc
    return Response(content=merged, media_type="application/pdf")


@router.post("/split")
async def split(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    pages: str = Form("1"),
    unify: bool = Form(True),
):
    if not PAGE_RANGE_RE.match(pages or ""):
        raise HTTPException(400, "Invalid page range; use a form like 1-3,5,8-")
    content, filename = await load_document(file, document_id)
    try:
        result = await qpdf.split_pdf(
            settings.qpdf_url,
            filename,
            content,
            pages=pages.replace(" ", ""),
            unify=unify,
        )
    except Exception as exc:
        raise upstream_error("Split", exc) from exc
    if not result:
        raise HTTPException(400, "The page range is outside the document; nothing to split")
    media_type = "application/pdf" if unify else "application/zip"
    return Response(content=result, media_type=media_type)


@router.post("/extract")
async def extract(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    password: str = Form(""),
):
    content, filename = await load_document(file, document_id)
    try:
        return await pdfbox.extract_text(settings.pdfbox_url, filename, content, password=password)
    except Exception as exc:
        raise upstream_error("Text extraction", exc) from exc


@router.post("/info")
async def info(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    password: str = Form(""),
):
    content, filename = await load_document(file, document_id)
    try:
        return await pdfbox.pdf_info(settings.pdfbox_url, filename, content, password=password)
    except Exception as exc:
        raise upstream_error("Reading document info", exc) from exc


@router.post("/form-fields")
async def form_fields(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    password: str = Form(""),
):
    content, filename = await load_document(file, document_id)
    try:
        return await pdfbox.list_form_fields(settings.pdfbox_url, filename, content, password=password)
    except Exception as exc:
        raise upstream_error("Reading form fields", exc) from exc


@router.post("/read-placements")
async def read_placements(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    password: str = Form(""),
):
    content, filename = await load_document(file, document_id)
    try:
        return await pdfbox.read_placements(settings.pdfbox_url, filename, content, password=password)
    except Exception as exc:
        raise upstream_error("Reading text boxes", exc) from exc


@router.post("/encrypt")
async def encrypt(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    user_password: str = Form(...),
    owner_password: str = Form(""),
    key_length: int = Form(256),
):
    """Returns an encrypted copy; a session is left unencrypted so editing can continue."""
    if not user_password:
        raise HTTPException(400, "Enter a password")
    if key_length not in (128, 256):
        raise HTTPException(400, "Key length must be 128 or 256")
    content, filename = await load_document(file, document_id)
    try:
        out = await qpdf.encrypt_pdf(
            settings.qpdf_url,
            filename,
            content,
            user_password=user_password,
            owner_password=owner_password,
            key_length=key_length,
        )
    except Exception as exc:
        raise upstream_error("Encryption", exc) from exc
    return Response(content=out, media_type="application/pdf")


# ---------------------------------------------------------------- edits


@router.post("/annotate")
async def annotate(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    lightweight: bool = Form(False),
    page_index: int = Form(0),
    text: str = Form(...),
    x: float = Form(72),
    y: float = Form(720),
    password: str = Form(""),
):
    async def op(content: bytes, filename: str) -> bytes:
        return await pdfbox.annotate_pdf(
            settings.pdfbox_url, filename, content, page_index=page_index, text=text, x=x, y=y, password=password
        )

    return await mutate("Adding a note", op, file=file, document_id=document_id, lightweight=lightweight)


@router.post("/callout")
async def callout(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    lightweight: bool = Form(False),
    page_index: int = Form(0),
    text: str = Form(...),
    anchor_x: float = Form(72),
    anchor_y: float = Form(720),
    x: float = Form(72),
    y: float = Form(720),
    width: float = Form(160),
    height: float = Form(48),
    font_size: float = Form(0),
    line_style: str = Form("arrow"),
    password: str = Form(""),
):
    async def op(content: bytes, filename: str) -> bytes:
        return await pdfbox.callout_pdf(
            settings.pdfbox_url,
            filename,
            content,
            page_index=page_index,
            text=text,
            anchor_x=anchor_x,
            anchor_y=anchor_y,
            x=x,
            y=y,
            width=width,
            height=height,
            font_size=font_size,
            line_style=line_style,
            password=password,
        )

    return await mutate("Adding a callout", op, file=file, document_id=document_id, lightweight=lightweight)


@router.post("/draw-text")
async def draw_text(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    lightweight: bool = Form(False),
    page_index: int = Form(0),
    text: str = Form(...),
    x: float = Form(72),
    y: float = Form(720),
    width: float = Form(160),
    height: float = Form(18),
    font_size: float = Form(0),
    password: str = Form(""),
):
    async def op(content: bytes, filename: str) -> bytes:
        return await pdfbox.draw_text(
            settings.pdfbox_url,
            filename,
            content,
            page_index=page_index,
            text=text,
            x=x,
            y=y,
            width=width,
            height=height,
            font_size=font_size,
            password=password,
        )

    return await mutate("Writing text", op, file=file, document_id=document_id, lightweight=lightweight)


@router.post("/fill-form")
async def fill_form(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    lightweight: bool = Form(False),
    values: str = Form(...),
    password: str = Form(""),
):
    try:
        parsed = json.loads(values)
        if not isinstance(parsed, dict):
            raise ValueError
        values_map = {str(k): str(v) for k, v in parsed.items()}
    except ValueError as exc:
        raise HTTPException(400, "Invalid form data: values must be a JSON object") from exc

    async def op(content: bytes, filename: str) -> tuple[bytes, dict]:
        out, filled = await pdfbox.fill_form(
            settings.pdfbox_url, filename, content, values=values_map, password=password
        )
        return out, {"filled_count": filled}

    return await mutate(
        "Filling the form",
        op,
        file=file,
        document_id=document_id,
        lightweight=lightweight,
        response_headers=lambda info: {"X-Filled-Count": str(info.get("filled_count", 0))},
    )


@router.post("/highlight")
async def highlight(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    lightweight: bool = Form(False),
    page_index: int = Form(0),
    x: float = Form(72),
    y: float = Form(720),
    width: float = Form(120),
    height: float = Form(18),
    password: str = Form(""),
    points: str = Form(""),
    stroke_width: float = Form(12),
    rects: str = Form(""),
):
    """A highlight over the box; with ``rects`` (a JSON array of [x, y, width,
    height] on the page), one highlight over all of them (the lines of a text
    selection: one annotation, one undo step); or, with ``points`` (a JSON array
    of strokes, each an array of [x, y] in displayed points), a highlighter
    stroke drawn by hand, ``stroke_width`` points wide. Erase highlight removes
    them all."""
    async def op(content: bytes, filename: str) -> bytes:
        return await pdfbox.highlight_pdf(
            settings.pdfbox_url,
            filename,
            content,
            page_index=page_index,
            x=x,
            y=y,
            width=width,
            height=height,
            password=password,
            points=points,
            stroke_width=stroke_width,
            rects=rects,
        )

    return await mutate("Highlight", op, file=file, document_id=document_id, lightweight=lightweight)


@router.post("/remove-highlight")
async def remove_highlight(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    lightweight: bool = Form(False),
    page_index: int = Form(0),
    x: float = Form(72),
    y: float = Form(720),
    width: float = Form(120),
    height: float = Form(18),
    password: str = Form(""),
):
    async def op(content: bytes, filename: str) -> tuple[bytes, dict]:
        out, removed = await pdfbox.remove_highlight_pdf(
            settings.pdfbox_url,
            filename,
            content,
            page_index=page_index,
            x=x,
            y=y,
            width=width,
            height=height,
            password=password,
        )
        return out, {"removed": True, "removed_count": removed}

    return await mutate(
        "Removing highlights",
        op,
        file=file,
        document_id=document_id,
        lightweight=lightweight,
        response_headers=lambda info: {"X-Removed-Count": str(info.get("removed_count", 0))},
    )


@router.post("/replace-text")
async def replace_text(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    lightweight: bool = Form(False),
    page_index: int = Form(0),
    text: str = Form(...),
    x: float = Form(72),
    y: float = Form(720),
    width: float = Form(160),
    height: float = Form(18),
    font_size: float = Form(0),
    cover_mode: str = Form("none"),
    erase_x: float = Form(0),
    erase_y: float = Form(0),
    erase_width: float = Form(0),
    erase_height: float = Form(0),
    password: str = Form(""),
):
    async def op(content: bytes, filename: str) -> bytes:
        return await pdfbox.replace_text(
            settings.pdfbox_url,
            filename,
            content,
            page_index=page_index,
            text=text,
            x=x,
            y=y,
            width=width,
            height=height,
            font_size=font_size,
            cover_mode=cover_mode,
            erase_x=erase_x,
            erase_y=erase_y,
            erase_width=erase_width,
            erase_height=erase_height,
            password=password,
        )

    return await mutate("Replacing text", op, file=file, document_id=document_id, lightweight=lightweight)


@router.post("/erase-region")
async def erase_region(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    lightweight: bool = Form(False),
    page_index: int = Form(0),
    x: float = Form(72),
    y: float = Form(720),
    width: float = Form(160),
    height: float = Form(18),
    password: str = Form(""),
):
    async def op(content: bytes, filename: str) -> bytes:
        return await pdfbox.erase_region(
            settings.pdfbox_url,
            filename,
            content,
            page_index=page_index,
            x=x,
            y=y,
            width=width,
            height=height,
            password=password,
        )

    return await mutate("Erasing a region", op, file=file, document_id=document_id, lightweight=lightweight)


@router.post("/move-text")
async def move_text(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    lightweight: bool = Form(False),
    page_index: int = Form(0),
    text: str = Form(...),
    new_x: float = Form(72),
    new_y: float = Form(720),
    new_width: float = Form(0),
    new_height: float = Form(0),
    erase_x: float = Form(0),
    erase_y: float = Form(0),
    erase_width: float = Form(0),
    erase_height: float = Form(0),
    font_size: float = Form(0),
    password: str = Form(""),
):
    async def op(content: bytes, filename: str) -> bytes:
        return await pdfbox.move_text(
            settings.pdfbox_url,
            filename,
            content,
            page_index=page_index,
            text=text,
            new_x=new_x,
            new_y=new_y,
            new_width=new_width,
            new_height=new_height,
            erase_x=erase_x,
            erase_y=erase_y,
            erase_width=erase_width,
            erase_height=erase_height,
            font_size=font_size,
            password=password,
        )

    return await mutate("Moving text", op, file=file, document_id=document_id, lightweight=lightweight)


@router.post("/embed-placements")
async def embed_placements(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    placements: str = Form(...),
    password: str = Form(""),
):
    try:
        if not isinstance(json.loads(placements), list):
            raise ValueError
    except ValueError as exc:
        raise HTTPException(400, "Invalid text box data: placements must be a JSON array") from exc

    async def op(content: bytes, filename: str) -> tuple[bytes, dict]:
        # Also draws them into the pages, and Cover boxes erase what they cover.
        out, report = await pdfbox.embed_placements(
            settings.pdfbox_url, filename, content, placements=placements, password=password
        )
        return out, {"edits": report}

    return await mutate("Saving text boxes", op, file=file, document_id=document_id)


@router.post("/sign")
async def sign(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    lightweight: bool = Form(False),
    image: UploadFile = File(...),
    page_index: int = Form(0),
    x: float = Form(72),
    y: float = Form(720),
    width: float = Form(120),
    height: float = Form(48),
    password: str = Form(""),
):
    image_content = await read_image_upload(image)
    image_name = image.filename or "image.png"

    async def op(content: bytes, filename: str) -> bytes:
        return await pdfbox.sign_image(
            settings.pdfbox_url,
            filename,
            content,
            image_name,
            image_content,
            page_index=page_index,
            x=x,
            y=y,
            width=width,
            height=height,
            password=password,
        )

    return await mutate("Placing an image", op, file=file, document_id=document_id, lightweight=lightweight)


MAX_SIGNATURE_PLACEMENTS = 2000
MAX_CERT_BYTES = 1024 * 1024
SIGN_MODES = {"flatten", "annotation"}


@router.post("/stamp-signatures")
async def stamp_signatures(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    images: list[UploadFile] = File(...),
    placements: str = Form(...),
    mode: str = Form("flatten"),
    password: str = Form(""),
):
    """Place picture signatures (several images, several pages) in one edit."""
    try:
        items = json.loads(placements)
        if not isinstance(items, list) or not items:
            raise ValueError
        if len(items) > MAX_SIGNATURE_PLACEMENTS:
            raise HTTPException(400, "Too many signatures in one request")
        for item in items:
            if not isinstance(item, dict):
                raise ValueError
            if not 0 <= int(item.get("image", 0)) < len(images):
                raise ValueError
            for key in ("page", "x", "y", "width", "height"):
                float(item[key])
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(400, "Invalid signature placement data") from exc
    if mode not in SIGN_MODES:
        raise HTTPException(400, "Invalid signature mode")
    image_bytes = [await read_image_upload(image) for image in images]

    async def op(content: bytes, filename: str):
        return await pdfbox.stamp_images(
            settings.pdfbox_url, filename, content, image_bytes,
            placements=json.dumps(items), mode=mode, password=password,
        )

    return await mutate("Placing signatures", op, file=file, document_id=document_id)


async def read_cert_upload(cert: UploadFile) -> bytes:
    content = await cert.read(MAX_CERT_BYTES + 1)
    if not content:
        raise HTTPException(400, "The certificate file is empty")
    if len(content) > MAX_CERT_BYTES:
        raise HTTPException(413, "The certificate file is too large")
    return content


@router.post("/digital-sign")
async def digital_sign(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    cert: UploadFile = File(...),
    cert_password: str = Form(""),
    reason: str = Form(""),
    location: str = Form(""),
    contact: str = Form(""),
    field_name: str = Form(""),
    visible: bool = Form(True),
    page_index: int = Form(0),
    x: float = Form(72),
    y: float = Form(72),
    width: float = Form(200),
    height: float = Form(60),
    image: UploadFile | None = File(default=None),
    tsa_url: str = Form(""),
    password: str = Form(""),
):
    """Digitally sign with a .p12/.pfx certificate (written as an incremental update)."""
    cert_bytes = await read_cert_upload(cert)
    image_bytes = await read_image_upload(image) if image is not None and image.filename else None
    tsa_url = tsa_url.strip()
    if tsa_url and not re.match(r"^https?://[^\s]+$", tsa_url):
        raise HTTPException(400, "The timestamp server URL must start with http:// or https://")
    if visible and not field_name and (width < 20 or height < 10):
        raise HTTPException(400, "The signature box is too small")
    fields = {
        "certPassword": cert_password,
        "reason": reason.strip()[:200],
        "location": location.strip()[:200],
        "contact": contact.strip()[:200],
        "fieldName": field_name.strip(),
        "visible": "1" if visible else "0",
        "pageIndex": page_index,
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "tsaUrl": tsa_url,
    }

    async def op(content: bytes, filename: str) -> bytes:
        return await pdfbox.digital_sign(
            settings.pdfbox_url, filename, content, cert_bytes,
            fields=fields, image=image_bytes, password=password,
        )

    return await mutate("Digital signing", op, file=file, document_id=document_id)


@router.post("/verify-signatures")
async def verify_signatures(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    password: str = Form(""),
):
    content, filename = await load_document(file, document_id)
    try:
        return await pdfbox.verify_signatures(settings.pdfbox_url, filename, content, password=password)
    except Exception as exc:
        raise upstream_error("Signature verification", exc) from exc


@router.post("/cert-info")
async def cert_info(cert: UploadFile = File(...), cert_password: str = Form("")):
    cert_bytes = await read_cert_upload(cert)
    try:
        return await pdfbox.cert_info(settings.pdfbox_url, cert_bytes, cert_password)
    except Exception as exc:
        raise upstream_error("Reading the certificate", exc) from exc


@router.post("/generate-cert")
async def generate_cert(
    name: str = Form(...),
    email: str = Form(""),
    organization: str = Form(""),
    cert_password: str = Form(...),
    years: int = Form(3),
):
    """A self-signed certificate for personal use, as a password-protected .p12 file."""
    name = name.strip()[:100]
    if not name:
        raise HTTPException(400, "Enter a name")
    if len(cert_password) < 4:
        raise HTTPException(400, "The certificate password needs at least 4 characters")
    try:
        p12 = await pdfbox.generate_cert(
            settings.pdfbox_url,
            {
                "name": name,
                "email": email.strip()[:200],
                "organization": organization.strip()[:200],
                "certPassword": cert_password,
                "years": max(1, min(10, years)),
            },
        )
    except Exception as exc:
        raise upstream_error("Creating the certificate", exc) from exc
    return Response(content=p12, media_type="application/x-pkcs12")


# ---------------------------------------------------------------- whole-file tools


@router.post("/rotate")
async def rotate(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    lightweight: bool = Form(False),
    angle: int = Form(90),
    pages: str = Form(""),
    password: str = Form(""),
):
    """Rotate clockwise by ``angle``. ``pages`` is a 1-based range like ``1,3-5``; empty means all."""
    angle = angle % 360
    if angle not in (0, 90, 180, 270):
        raise HTTPException(400, "Rotation must be 90, 180 or 270 degrees")
    if pages and not PAGE_RANGE_RE.match(pages):
        raise HTTPException(400, "Invalid page range; use a form like 1,3-5")

    async def op(content: bytes, filename: str) -> bytes:
        return await qpdf.rotate_pdf(
            settings.qpdf_url, filename, content, angle=angle, pages=pages.replace(" ", ""), password=password
        )

    return await mutate("Rotation", op, file=file, document_id=document_id, lightweight=lightweight)


@router.post("/pages")
async def select_pages(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    lightweight: bool = Form(False),
    order: str = Form(...),
    password: str = Form(""),
):
    """Keep, drop and reorder pages: ``order`` lists the 1-based pages to keep, in order."""
    if not PAGE_LIST_RE.match(order or ""):
        raise HTTPException(400, "Invalid page order; use a form like 3,1,2")
    numbers = [int(n) for n in order.replace(" ", "").split(",")]
    if any(n < 1 for n in numbers):
        raise HTTPException(400, "Page numbers start at 1")
    if len(set(numbers)) != len(numbers):
        raise HTTPException(400, "The page order repeats a page")

    async def op(content: bytes, filename: str) -> bytes:
        return await qpdf.select_pages(
            settings.qpdf_url, filename, content, order=",".join(map(str, numbers)), password=password
        )

    return await mutate("Reordering pages", op, file=file, document_id=document_id, lightweight=lightweight)


@router.post("/flatten")
async def flatten(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    lightweight: bool = Form(False),
    password: str = Form(""),
    mode: str = Form("all"),
    engine: str = Form("qpdf"),
):
    if mode not in ("all", "print", "screen"):
        raise HTTPException(400, "mode must be all, print or screen")

    async def op(content: bytes, filename: str) -> bytes:
        if engine == "pdfbox":
            return await pdfbox.flatten_pdfbox(settings.pdfbox_url, filename, content, password=password)
        return await qpdf.flatten_pdf(settings.qpdf_url, filename, content, password=password, mode=mode)

    return await mutate("Flattening", op, file=file, document_id=document_id, lightweight=lightweight)


@router.post("/unlock")
async def unlock(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    lightweight: bool = Form(False),
    password: str = Form(""),
):
    async def op(content: bytes, filename: str) -> bytes:
        return await qpdf.decrypt_pdf(settings.qpdf_url, filename, content, password=password)

    return await mutate("Unlocking", op, file=file, document_id=document_id, lightweight=lightweight)


OCR_NOT_INSTALLED = "The OCR (text recognition) component is not installed"

# A picture worth reading on a page that has text: at least an inch wide and
# half an inch high as shown, not most of the page (that is a scan, read as one)
# and not wholly in the top or bottom band (a letterhead or logo: its words would
# come back as running headers and footers; structure service: MARGIN_BAND).
# A scan with only a few words of text (a stamped page or Bates number, a
# heading OCR'd earlier) is read too: the scans pass would skip it for its text.
PICTURE_MIN_WIDTH = 72
PICTURE_MIN_HEIGHT = 36
SCAN_COVER = 0.8
MARGIN_BAND = 0.12
SPARSE_TEXT = 200


async def _pictures_on_text_pages(filename: str, content: bytes, text_chars: dict[int, int], pages: str) -> list[int]:
    found = await pdfbox.extract_images(settings.pdfbox_url, filename, content, pages=pages, manifest_only=True)
    sizes = {p["page"]: (p["width"], p["height"]) for p in found.get("pageSizes", [])}
    out = set()
    for img in found.get("images", []):
        page, w, h, y = img["page"], img.get("width", 0), img.get("height", 0), img.get("y", 0)
        pw, ph = sizes.get(page, (float("inf"), float("inf")))
        in_margin = y + h <= ph * MARGIN_BAND or y >= ph * (1 - MARGIN_BAND)
        scan = w * h >= SCAN_COVER * pw * ph
        if (page in text_chars and w >= PICTURE_MIN_WIDTH and h >= PICTURE_MIN_HEIGHT and not in_margin
                and (not scan or text_chars[page] < SPARSE_TEXT)):
            out.add(page)
    return sorted(out)


async def ocr_scans_and_pictures(
    filename: str, content: bytes, *, languages: list[str], pictures: bool = True, pages: str = "",
    deskew: bool = False, clean: bool = False,
) -> tuple[bytes, list[int], list[int]]:
    """OCR in two passes: the pages without a text layer (scans), then, with
    ``pictures``, the pictures on pages that have text (charts, photos, scanned
    inserts, scans with a few words of text; the page's own text is kept as it
    is). Returns the document and the pages of each pass; nothing is sent to the
    OCR service when neither has any."""
    text = await pdfbox.page_text(settings.pdfbox_url, filename, content, pages=pages)
    chars = {p["page"]: len("".join((p.get("text") or "").split())) for p in text.get("pages", [])}
    has_text = {page: n for page, n in chars.items() if n}
    scans = [page for page in chars if page not in has_text]
    picture_pages = []
    if pictures and await ocr.reads_pictures(settings.ocr_url):
        picture_pages = await _pictures_on_text_pages(filename, content, has_text, pages)
    out = content
    if scans:
        out = await ocr.ocr_pdf(settings.ocr_url, filename, out, languages=languages, deskew=deskew, clean=clean,
                                pages=scans if pages else None)
    if picture_pages:
        out = await ocr.ocr_pdf(settings.ocr_url, filename, out, languages=languages, pictures=True,
                                pages=picture_pages)
    return out, scans, picture_pages


@router.get("/ocr/status")
async def ocr_status():
    """Whether the optional OCR component is installed and running."""
    return {"installed": await ocr.is_available(settings.ocr_url)}


@router.post("/ocr")
async def run_ocr(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    lightweight: bool = Form(False),
    languages: str = Form("eng"),
    deskew: bool = Form(False),
    clean: bool = Form(False),
    pictures: bool = Form(True),
):
    """Make scanned pages searchable: OCR the pages without a text layer and,
    with ``pictures`` (the default), the pictures on pages that have text too.
    The pages read are in ``ocrPages`` and ``pictureOcrPages`` (X-OCR-Pages and
    X-Picture-OCR-Pages for an uploaded file)."""
    langs = [lang.strip() for lang in languages.split(",") if lang.strip()]
    if not langs:
        raise HTTPException(400, "Choose at least one OCR language")
    unknown = [lang for lang in langs if lang not in OCR_LANGUAGES]
    if unknown:
        raise HTTPException(400, f"Unsupported OCR language: {', '.join(unknown)} (available: eng, chi_sim)")

    if not await ocr.is_available(settings.ocr_url):
        raise HTTPException(503, OCR_NOT_INSTALLED, headers={"X-Error-Code": "ocr_not_installed"})

    async def op(content: bytes, filename: str) -> tuple[bytes, dict]:
        out, scans, picture_pages = await ocr_scans_and_pictures(
            filename, content, languages=langs, pictures=pictures, deskew=deskew, clean=clean
        )
        return out, {"ocrPages": scans, "pictureOcrPages": picture_pages}

    def headers(info: dict) -> dict:
        return {"X-OCR-Pages": ",".join(map(str, info["ocrPages"])),
                "X-Picture-OCR-Pages": ",".join(map(str, info["pictureOcrPages"]))}

    return await mutate("OCR", op, file=file, document_id=document_id, lightweight=lightweight,
                        response_headers=headers)


# ---------------------------------------------------------------- agent tools
#
# Coordinates in these endpoints are PDF points on the page as displayed
# (crop box, rotation applied), origin top-left, y downwards: a rendered page
# image divided by its scale.

MAX_TERMS = 200


def _json_list(raw: str, what: str) -> list:
    if not raw or not raw.strip():
        return []
    try:
        value = json.loads(raw)
    except ValueError as exc:
        raise HTTPException(400, f"{what} must be a JSON array") from exc
    if not isinstance(value, list):
        raise HTTPException(400, f"{what} must be a JSON array")
    return value


def _terms(raw: str) -> list[str]:
    terms = [str(t) for t in _json_list(raw, "terms") if str(t).strip()]
    if len(terms) > MAX_TERMS:
        raise HTTPException(400, f"Too many terms (limit {MAX_TERMS})")
    return terms


@router.post("/page-info")
async def page_info(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    password: str = Form(""),
):
    """Page count, metadata, form/signature counts, and per page: displayed size, rotation, text characters."""
    content, filename = await load_document(file, document_id)
    try:
        return await pdfbox.page_info(settings.pdfbox_url, filename, content, password=password)
    except Exception as exc:
        raise upstream_error("Reading document info", exc) from exc


@router.post("/page-text")
async def page_text(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    pages: str = Form(""),
    sort_by_position: bool = Form(False),
    password: str = Form(""),
):
    """Text per page. ``pages`` is a 1-based range like ``1-3,5``; empty means all."""
    if pages and not PAGE_RANGE_RE.match(pages):
        raise HTTPException(400, "Invalid page range; use a form like 1-3,5,8-")
    content, filename = await load_document(file, document_id)
    try:
        return await pdfbox.page_text(
            settings.pdfbox_url, filename, content, pages=pages.replace(" ", ""),
            sort_by_position=sort_by_position, password=password,
        )
    except Exception as exc:
        raise upstream_error("Text extraction", exc) from exc


@router.post("/text-layout")
async def text_layout(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    pages: str = Form(""),
    password: str = Form(""),
):
    """The text of each page as phrases with their boxes (labels, cells, lines)."""
    if pages and not PAGE_RANGE_RE.match(pages):
        raise HTTPException(400, "Invalid page range; use a form like 1-3,5,8-")
    content, filename = await load_document(file, document_id)
    try:
        return await pdfbox.text_layout(
            settings.pdfbox_url, filename, content, pages=pages.replace(" ", ""), password=password
        )
    except Exception as exc:
        raise upstream_error("Reading the text layout", exc) from exc


STRUCTURE_NOT_INSTALLED = "The document structure component is not installed"


@router.get("/structure/status")
async def structure_status():
    """Whether the optional document structure component is installed and running."""
    return {"installed": await structure.is_available(settings.structure_url)}


# OCR'd copies of documents read through /structure, so an agent reading a
# scanned document part by part (the outline, then some pages) waits for OCR once.
_structure_ocr_cache: dict[tuple, tuple[bytes, list[int], list[int], str]] = {}
STRUCTURE_OCR_CACHE = 4


async def _ocr_for_structure(
    filename: str, content: bytes, pages: str, pictures: bool = True
) -> tuple[bytes, list[int], list[int], str]:
    """The document with its scanned pages OCR'd and, with ``pictures``, the
    pictures on its text pages; the pages of each, and why there was no OCR when
    it could not run."""
    import hashlib

    key = (hashlib.sha256(content).hexdigest(), pages, pictures)
    if key in _structure_ocr_cache:
        return _structure_ocr_cache[key]
    if not await ocr.is_available(settings.ocr_url):
        text = await pdfbox.page_text(settings.pdfbox_url, filename, content, pages=pages)
        if any(not (p.get("text") or "").strip() for p in text.get("pages", [])):
            return content, [], [], "OCR is not installed: pages without a text layer stay empty"
        return content, [], [], ""
    try:
        done = (*await ocr_scans_and_pictures(filename, content, languages=list(OCR_LANGUAGES),
                                              pictures=pictures, pages=pages), "")
    except Exception as exc:  # noqa: BLE001 - the text pages are still worth returning
        return content, [], [], upstream_error("OCR", exc).detail
    _structure_ocr_cache[key] = done
    while len(_structure_ocr_cache) > STRUCTURE_OCR_CACHE:
        _structure_ocr_cache.pop(next(iter(_structure_ocr_cache)))
    return done


# Documents whose undecodable pages were read again by OCR, by content and pages
_reread_cache: dict[tuple, bytes] = {}


async def _convert_rereading_garbled(
    filename: str, read: bytes, *, pages: str, picture_text: bool, model: bool, scan_pages: list[int],
    ocr_allowed: bool,
) -> tuple[bytes, dict, list[int]]:
    """structure.convert, then once more when some pages' text cannot be decoded
    (``garbledPages``: a font without a Unicode map) and OCR may run: those pages
    are read from their image instead. Returns the document read, the result and
    the pages OCR'd (scans and those)."""
    import hashlib

    result = await structure.convert(settings.structure_url, filename, read, pages=pages,
                                     picture_text=picture_text, model=model, scan_pages=scan_pages)
    garbled = result.get("garbledPages") or []
    if not garbled or not ocr_allowed or not await ocr.reads_again(settings.ocr_url):
        return read, result, scan_pages
    key = (hashlib.sha256(read).hexdigest(), tuple(garbled))
    try:
        if key not in _reread_cache:
            _reread_cache[key] = await ocr.ocr_pdf(settings.ocr_url, filename, read, languages=list(OCR_LANGUAGES),
                                                   force=True, pages=garbled)
            while len(_reread_cache) > STRUCTURE_OCR_CACHE:
                _reread_cache.pop(next(iter(_reread_cache)))
    except Exception as exc:  # noqa: BLE001 - the first reading is still worth returning
        result["ocrNote"] = upstream_error("OCR", exc).detail
        return read, result, scan_pages
    read = _reread_cache[key]
    scan_pages = sorted({*scan_pages, *garbled})
    result = await structure.convert(settings.structure_url, filename, read, pages=pages,
                                     picture_text=picture_text, model=model, scan_pages=scan_pages)
    result["rereadPages"] = garbled
    return read, result, scan_pages


MODEL_CHOICES = {"auto", "on", "off", "true", "false"}


async def _use_model(choice: str) -> bool:
    """model=auto|on|off as a yes or no: auto is on when a reading model answers."""
    choice = (choice or "auto").strip().lower()
    if choice not in MODEL_CHOICES:
        raise HTTPException(400, "model must be auto, on or off")
    if choice in ("off", "false"):
        return False
    ready = await structure.model_ready(settings.structure_url)
    if choice in ("on", "true") and not ready:
        raise HTTPException(503, "No document reading model is installed or running",
                            headers={"X-Error-Code": "model_not_installed"})
    return ready


@router.get("/structure/model")
async def structure_model():
    """Whether a document reading model is installed and answering, and which."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{settings.structure_url.rstrip('/')}/model")
            return resp.json() if resp.status_code == 200 else {"configured": False}
    except (httpx.HTTPError, ValueError):
        return {"configured": False}


@router.post("/structure")
async def document_structure(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    pages: str = Form(""),
    password: str = Form(""),
    ocr_scans: bool = Form(True, alias="ocr"),
    pictures: bool = Form(True),
    model: str = Form("auto"),
):
    """The document as headings, paragraphs, lists, tables and figures in reading
    order (page headers and footers left out), with their pages and boxes, plus
    the same as Markdown. ``pages`` is a 1-based range like ``1-3,5``; empty means all.
    Pages without a text layer (scans) are OCR'd first when the OCR component is
    installed (``ocr=false`` to skip it): they are listed in ``ocrPages``; pages
    still without text are in ``pagesWithoutText``, and ``ocrNote`` says why.
    Pages whose text cannot be decoded (``garbledPages``: a font without a
    Unicode map) are read again from their image (``rereadPages``, also in
    ``ocrPages``).
    With ``pictures`` (the default) the text in pictures is read too (OCR'd on the
    pages in ``pictureOcrPages``): it is the picture's ``text``, and in the
    Markdown a quote under the picture. ``model`` (``auto``, the default: whenever
    a reading model is installed and answering; ``on``; ``off``): tables, formulas,
    paragraphs with mathematics and scanned pages are read again by the document
    reading model (their elements then say ``"readBy": "model"``; formulas come as
    LaTeX); ``modelUsed`` says whether it was."""
    if pages and not PAGE_RANGE_RE.match(pages):
        raise HTTPException(400, "Invalid page range; use a form like 1-3,5,8-")
    if not await structure.is_available(settings.structure_url):
        raise HTTPException(503, STRUCTURE_NOT_INSTALLED, headers={"X-Error-Code": "structure_not_installed"})
    content, filename = await load_document(file, document_id)
    spec = pages.replace(" ", "")
    use_model = await _use_model(model)
    try:
        if password:
            content = await qpdf.decrypt_pdf(settings.qpdf_url, filename, content, password=password)
        ocr_pages, picture_pages, note = [], [], ""
        if ocr_scans:
            content, ocr_pages, picture_pages, note = await _ocr_for_structure(filename, content, spec, pictures)
        _, result, ocr_pages = await _convert_rereading_garbled(
            filename, content, pages=spec, picture_text=pictures, model=use_model, scan_pages=ocr_pages,
            ocr_allowed=ocr_scans and not note)
        result["modelUsed"] = use_model
        result["ocrPages"] = ocr_pages
        result["pictureOcrPages"] = picture_pages
        if note:
            result["ocrNote"] = note
        return result
    except Exception as exc:
        raise upstream_error("Reading the document structure", exc) from exc


# ---------------------------------------------------------------- pictures

IMAGE_FORMATS = (
    (b"\xff\xd8", "JPEG"), (b"\x89PNG", "PNG"), (b"II*\x00", "TIFF"), (b"MM\x00*", "TIFF"),
    (b"GIF8", "GIF"), (b"BM", "BMP"),
)
MAX_PICTURES = 500


def _zip_name(filename: str, suffix: str) -> str:
    stem = re.sub(r"\.pdf$", "", filename or "document", flags=re.I) or "document"
    return f"{stem}{suffix}"


def _attachment(name: str) -> dict:
    from urllib.parse import quote

    ascii_name = re.sub(r'[^A-Za-z0-9._ -]', "_", name)
    return {"Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"}


# Strokes of a chart that OCR reads as these Chinese characters (structure service: LINE_ART)
LINE_ART = re.compile(r"(?<!\S)[一二十丨口田日]{1,2}(?!\S)")


def _clean_picture_text(text: str) -> str:
    """Drop lone line-art glyphs from a picture's text, unless it holds other Chinese."""
    if re.search(r"[\u3400-\u9fff]", LINE_ART.sub("", text)):
        return text
    return "\n".join(line for line in (" ".join(LINE_ART.sub("", ln).split()) for ln in text.split("\n")) if line)


def _text_in_box(phrases: list[dict], box: dict) -> str:
    """The phrases whose middle lies in the box, as lines top to bottom."""
    inside = []
    for ph in phrases:
        cx, cy = ph["x"] + ph["width"] / 2, ph["y"] + ph["height"] / 2
        if box["x"] - 1 <= cx <= box["x"] + box["width"] + 1 and box["y"] - 1 <= cy <= box["y"] + box["height"] + 1:
            inside.append(ph)
    inside.sort(key=lambda ph: (ph["y"] + ph["height"] / 2, ph["x"]))
    lines: list[list[dict]] = []
    for ph in inside:
        mid = ph["y"] + ph["height"] / 2
        if lines and abs(mid - (lines[-1][0]["y"] + lines[-1][0]["height"] / 2)) < max(2.0, ph["height"] * 0.5):
            lines[-1].append(ph)
        else:
            lines.append([ph])
    return _clean_picture_text(
        "\n".join(" ".join(p["text"] for p in sorted(line, key=lambda p: p["x"])) for line in lines))


async def _read_pictures(filename: str, read: bytes, manifest: dict) -> None:
    """Each picture's text (from the text layer of ``read``, the OCR'd document) into the manifest."""
    pages = sorted({img["page"] for img in manifest.get("images", [])})
    if not pages:
        return
    layout = await pdfbox.text_layout(settings.pdfbox_url, filename, read, pages=",".join(map(str, pages)))
    phrases = {p["page"]: p.get("phrases", []) for p in layout.get("pages", [])}
    for img in manifest["images"]:
        text = _text_in_box(phrases.get(img["page"], []), img)
        if text:
            img["text"] = text


async def _ocr_for_pictures(filename: str, content: bytes, pages: str) -> tuple[bytes, str]:
    """The document with its scans and pictures OCR'd, or as it is and why not."""
    if not await ocr.is_available(settings.ocr_url):
        return content, "OCR is not installed: only text already in the PDF was read"
    try:
        out, _, _ = await ocr_scans_and_pictures(filename, content, languages=list(OCR_LANGUAGES), pages=pages)
        return out, ""
    except Exception as exc:  # noqa: BLE001 - the pictures are still worth returning
        return content, upstream_error("OCR", exc).detail


def _rezip(files: dict[str, bytes], manifest: dict, manifest_name: str = "manifest.json") -> bytes:
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            # pictures are compressed already
            z.writestr(name, data, zipfile.ZIP_STORED if name.endswith((".jpg", ".png", ".jp2")) else zipfile.ZIP_DEFLATED)
        z.writestr(manifest_name, json.dumps(manifest, ensure_ascii=False, indent=1))
    return buf.getvalue()


def _unzip(data: bytes) -> tuple[dict[str, bytes], dict]:
    import io
    import zipfile

    with zipfile.ZipFile(io.BytesIO(data)) as z:
        files = {n: z.read(n) for n in z.namelist() if n != "manifest.json"}
        return files, json.loads(z.read("manifest.json"))


def _picture_files(files: dict[str, bytes], manifest: dict) -> None:
    """A .txt beside each picture with the text read in it."""
    for img in manifest.get("images", []):
        if img.get("text") and img.get("file") and not img.get("sameAs"):
            files[img["file"].rsplit(".", 1)[0] + ".txt"] = img["text"].encode()


@router.post("/extract-images")
async def extract_images(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    pages: str = Form(""),
    min_size: int = Form(32),
    password: str = Form(""),
    read_text: bool = Form(True, alias="ocr"),
):
    """The pictures in the document as a ZIP: images/page003-01.jpg (or .png,
    .jp2) and manifest.json, which gives each picture's page, box (points from the
    top-left of the page as displayed), pixel size and resolution. JPEG and JPEG
    2000 pictures keep their original bytes; the others are PNG. A picture drawn
    several times is written once (``sameAs``). Pictures smaller than ``min_size``
    pixels (icons, rules) are left out. With ``ocr`` (the default) the text in each
    picture is read (OCR when installed) into the manifest and a .txt beside it."""
    if pages and not PAGE_RANGE_RE.match(pages):
        raise HTTPException(400, "Invalid page range; use a form like 1-3,5,8-")
    content, filename = await load_document(file, document_id)
    spec = pages.replace(" ", "")
    try:
        if password:
            content = await qpdf.decrypt_pdf(settings.qpdf_url, filename, content, password=password)
        zipped = await pdfbox.extract_images(settings.pdfbox_url, filename, content, pages=spec,
                                             min_size=int(clamp(min_size, 1, 10000)))
        files, manifest = _unzip(zipped)
        if read_text and manifest.get("images"):
            read, note = await _ocr_for_pictures(filename, content, spec)
            await _read_pictures(filename, read, manifest)
            if note:
                manifest["ocrNote"] = note
            _picture_files(files, manifest)
            zipped = _rezip(files, manifest)
    except Exception as exc:
        raise upstream_error("Extracting pictures", exc) from exc
    return Response(content=zipped, media_type="application/zip",
                    headers={**_attachment(_zip_name(filename, "-images.zip")),
                             "X-Image-Count": str(len(manifest.get("images", [])))})


@router.post("/from-images")
async def from_images(
    files: list[UploadFile] = File(...),
    read_text: bool = Form(True, alias="ocr"),
    languages: str = Form("eng,chi_sim"),
    lightweight: bool = Form(False),
    filename: str = Form(""),
):
    """Pictures (JPEG, PNG, TIFF, GIF, BMP) to a PDF: one page per picture, in
    order (every page of a TIFF), each page the size of its picture at its
    resolution; JPEGs are embedded unchanged and a photo's orientation is kept.
    With ``ocr`` (the default) the text in them is recognised, so the PDF can be
    searched, copied from and read by the other tools. ``lightweight`` opens the
    result as an editing session instead of returning it."""
    if not files:
        raise HTTPException(400, "Choose at least one picture")
    if len(files) > MAX_PICTURES:
        raise HTTPException(400, f"At most {MAX_PICTURES} pictures at a time")
    langs = [lang.strip() for lang in languages.split(",") if lang.strip()]
    if not langs or any(lang not in OCR_LANGUAGES for lang in langs):
        raise HTTPException(400, "Unsupported OCR language (available: eng, chi_sim)")
    pictures: list[tuple[str, bytes]] = []
    total = 0
    for f in files:
        name = f.filename or "picture"
        data = await f.read(settings.max_upload_bytes + 1)
        if not data:
            raise HTTPException(400, f"'{name}' is empty")
        total += len(data)
        if len(data) > settings.max_upload_bytes or total > settings.max_upload_bytes * 2:
            raise HTTPException(413, f"The pictures are too large (limit {settings.max_upload_mb} MB each, "
                                     f"{settings.max_upload_mb * 2} MB together)")
        if not any(data.startswith(magic) for magic, _ in IMAGE_FORMATS):
            kind = "HEIC" if data[4:12] in (b"ftypheic", b"ftypheix", b"ftypmif1") else (
                "WebP" if data[:4] == b"RIFF" and data[8:12] == b"WEBP" else "")
            raise HTTPException(400, f"'{name}' is {'a ' + kind + ' picture' if kind else 'not a picture OpenPDF can read'}; "
                                     "use JPEG, PNG, TIFF, GIF or BMP")
        pictures.append((name, data))
    out_name = filename or (re.sub(r"\.[A-Za-z0-9]+$", "", pictures[0][0]) + ".pdf")
    try:
        pdf = await pdfbox.images_to_pdf(settings.pdfbox_url, pictures)
        note = ""
        did_ocr = False
        if read_text:
            if await ocr.is_available(settings.ocr_url):
                pdf = await ocr.ocr_pdf(settings.ocr_url, out_name, pdf, languages=langs)
                did_ocr = True
            else:
                note = OCR_NOT_INSTALLED
    except Exception as exc:
        raise upstream_error("Making a PDF from the pictures", exc) from exc
    info = {"ocr": did_ocr, **({"ocrNote": note} if note else {})}
    if lightweight:
        doc_id = await document_store.create(pdf, out_name)
        return {"ok": True, "document_id": doc_id, "revision": 1, "previous_revision": None,
                "filename": out_name, **info}
    return Response(content=pdf, media_type="application/pdf",
                    headers={**_attachment(out_name), "X-OCR": "1" if did_ocr else "0",
                             **({"X-OCR-Note": note} if note else {})})


def _overlap(a: dict, b: dict) -> float:
    w = min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"])
    h = min(a["y"] + a["height"], b["y"] + b["height"]) - max(a["y"], b["y"])
    return max(0.0, w) * max(0.0, h)


def _link_pictures(result: dict, manifest: dict) -> None:
    """Each picture element gets the file of the picture it shows (the one it
    covers most of), and its Markdown mark becomes a link to that file."""
    by_page: dict[int, list[dict]] = {}
    for img in manifest.get("images", []):
        if img.get("file"):
            by_page.setdefault(img["page"], []).append(img)
    pictures: dict[int, list[dict]] = {}
    for el in result.get("elements", []):
        if el["type"] != "picture":
            continue
        pictures.setdefault(el["page"], []).append(el)
        box = el.get("box")
        best, score = None, 0.5
        for img in by_page.get(el["page"], []) if box else []:
            area = img["width"] * img["height"]
            if area > 0 and _overlap(box, img) / area > score:
                best, score = img, _overlap(box, img) / area
        if best:
            el["image"] = best.get("sameAs") or best["file"]
    for page in result.get("pages", []):
        els = pictures.get(page["page"], [])
        parts = (page.get("markdown") or "").split("<!-- image -->")
        if len(parts) - 1 != len(els):
            continue
        out = parts[0]
        for el, rest in zip(els, parts[1:]):
            label = (el.get("caption") or "Picture").replace("]", ")").replace("\n", " ")[:120]
            out += (f"![{label}]({el['image']})" if el.get("image") else "<!-- image -->") + rest
        page["markdown"] = out


@router.post("/export")
async def export_document(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    format: str = Form("markdown"),
    pages: str = Form(""),
    password: str = Form(""),
    read_text: bool = Form(True, alias="ocr"),
    model: str = Form("auto"),
):
    """The document as Markdown (``format=markdown``) or as its structure in JSON
    (``format=json``), in a ZIP with its pictures: <name>.md or <name>.json, and
    images/ with every picture and images/manifest.json. In the Markdown each
    figure that is a picture links to its file. With ``ocr`` (the default) scanned
    pages and the pictures on text pages are OCR'd first (when OCR is installed),
    and the text in each picture follows it as a quote. ``model`` as for
    /structure. Needs the document structure component."""
    if format not in ("markdown", "json"):
        raise HTTPException(400, "format must be markdown or json")
    if pages and not PAGE_RANGE_RE.match(pages):
        raise HTTPException(400, "Invalid page range; use a form like 1-3,5,8-")
    if not await structure.is_available(settings.structure_url):
        raise HTTPException(503, STRUCTURE_NOT_INSTALLED, headers={"X-Error-Code": "structure_not_installed"})
    content, filename = await load_document(file, document_id)
    spec = pages.replace(" ", "")
    try:
        if password:
            content = await qpdf.decrypt_pdf(settings.qpdf_url, filename, content, password=password)
        read, ocr_pages, picture_pages, note = content, [], [], ""
        if read_text:
            read, ocr_pages, picture_pages, note = await _ocr_for_structure(filename, content, spec, True)
        use_model = await _use_model(model)
        read, result, ocr_pages = await _convert_rereading_garbled(
            filename, read, pages=spec, picture_text=True, model=use_model, scan_pages=ocr_pages,
            ocr_allowed=read_text and not note)
        files, manifest = _unzip(await pdfbox.extract_images(settings.pdfbox_url, filename, content, pages=spec))
        await _read_pictures(filename, read, manifest)
        _picture_files(files, manifest)
    except Exception as exc:
        raise upstream_error("Exporting the document", exc) from exc
    _link_pictures(result, manifest)
    result["ocrPages"], result["pictureOcrPages"] = ocr_pages, picture_pages
    if note:
        result["ocrNote"] = manifest["ocrNote"] = note
    total = result.get("pageCount")
    if format == "markdown":
        body = "\n".join(f"<!-- page {p['page']} of {total} -->\n{(p.get('markdown') or '').strip()}\n"
                         for p in result.get("pages", []))
        main_name, main_data = _zip_name(filename, ".md"), body.encode()
    else:
        result["images"] = manifest.get("images", [])
        main_name, main_data = _zip_name(filename, ".json"), json.dumps(result, ensure_ascii=False, indent=1).encode()
    zipped = _rezip({main_name: main_data, **files}, manifest, "images/manifest.json")
    return Response(content=zipped, media_type="application/zip",
                    headers=_attachment(_zip_name(filename, f"-{format}.zip")))


@router.post("/find-text")
async def find_text(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    terms: str = Form(...),
    case_sensitive: bool = Form(False),
    pages: str = Form(""),
    password: str = Form(""),
):
    """Where words are: ``terms`` is a JSON array; each match has its page and boxes."""
    term_list = _terms(terms)
    if not term_list:
        raise HTTPException(400, "Give at least one search term")
    if pages and not PAGE_RANGE_RE.match(pages):
        raise HTTPException(400, "Invalid page range; use a form like 1-3,5,8-")
    content, filename = await load_document(file, document_id)
    try:
        return await pdfbox.find_text(
            settings.pdfbox_url, filename, content, terms=term_list, case_sensitive=case_sensitive,
            pages=pages.replace(" ", ""), password=password,
        )
    except Exception as exc:
        raise upstream_error("Text search", exc) from exc


@router.post("/redact")
async def redact(
    file: UploadFile | None = File(default=None),
    document_id: str = Form(""),
    terms: str = Form(""),
    regions: str = Form(""),
    case_sensitive: bool = Form(False),
    remove_metadata: bool = Form(False),
    restore_text: bool = Form(True),
    dpi: int = Form(200),
    password: str = Form(""),
    edits: str = Form(""),
    keep_text: bool = Form(True),
):
    """Redaction that removes the content, not a box drawn on top.

    On pages with something to redact, the characters touching a box, the
    image pixels under it, the shapes mostly inside it and the annotations
    over it are taken out of the page, which otherwise stays text; then a black
    box is drawn. A page where that cannot be done or checked (or every page,
    with ``keep_text=false``) is rewritten as an image of the page with the
    boxes burnt in. Form fields, matching annotations, attachments, scripts,
    tags and matching metadata are removed. Scanned pages are OCR'd first so
    terms on them are found. With ``restore_text`` (and OCR) the other words on
    pages rebuilt as images stay searchable. The result is checked (page text
    and every object in the file) and refused if any term can still be found.
    ``regions`` is a JSON array of ``{page, x, y, width, height}`` (1-based page).
    ``edits`` (the editor's text boxes and comments, as for embed-placements) are
    first drawn into the pages for good, so they are redacted like the rest.

    Without ``document_id`` the answer is ``PDFREDACT1 <n>\\n``, then n bytes of
    JSON report, then the PDF.
    """
    term_list = _terms(terms)
    region_list = _json_list(regions, "regions")
    if not term_list and not region_list:
        raise HTTPException(400, "Give terms or regions to redact")
    for r in region_list:
        if not isinstance(r, dict) or not all(k in r for k in ("page", "x", "y", "width", "height")):
            raise HTTPException(400, "Each region needs page, x, y, width and height")
    dpi = int(clamp(dpi, 72, 400))
    if edits:
        try:
            if not isinstance(json.loads(edits), list):
                raise ValueError
        except ValueError as exc:
            raise HTTPException(400, "edits must be a JSON array") from exc

    async def op(content: bytes, filename: str) -> tuple[bytes, dict]:
        ocr_up = await ocr.is_available(settings.ocr_url)
        if edits:
            # 0. The editor's boxes become ordinary page content (and Edit text boxes remove what they cover).
            content, _ = await pdfbox.embed_placements(
                settings.pdfbox_url, filename, content, placements=edits, password=password, flatten=True
            )
        # 1. Forms, signatures and their validation data out; encryption removed (OCR refuses signed files).
        #    Annotations that mention a term are removed here too, with their popups and replies.
        content, prep = await pdfbox.prepare_redaction(
            settings.pdfbox_url, filename, content, terms=term_list, case_sensitive=case_sensitive, password=password
        )
        # 2. The other visible annotations (stamps, text boxes, highlights) on every page become page
        #    content, where the search can read them whatever their font. Without this, text drawn by
        #    an annotation in an embedded font could not be checked, so a failure stops the redaction.
        flattened_annotations = int(prep.get("annotationsToFlatten", 0) or 0)
        if term_list and flattened_annotations:
            try:
                content = await qpdf.flatten_pdf(settings.qpdf_url, filename, content, mode="all")
            except Exception as exc:  # noqa: BLE001
                log.warning("annotation flattening before redaction failed: %r", exc)
                raise HTTPException(
                    422,
                    "Could not flatten the document's annotations into the page, which is needed to search "
                    "their text. Nothing was redacted and no file was written.",
                ) from exc
            # Check that it worked (and drop popups left without their parent).
            content, again = await pdfbox.prepare_redaction(
                settings.pdfbox_url, filename, content, terms=term_list, case_sensitive=case_sensitive
            )
            if int(again.get("annotationsToFlatten", 0) or 0):
                raise HTTPException(
                    422,
                    f"{again['annotationsToFlatten']} annotation(s) could not be flattened into the page, so their "
                    "text cannot be searched. Nothing was redacted and no file was written; flatten the file "
                    "(pdf_flatten) or remove those annotations first.",
                )
        # 3. Words on scanned pages are only pixels: OCR those pages so the terms are found there too.
        scanned_pages = 0
        ocr_first = False
        if term_list:
            info = await pdfbox.page_info(settings.pdfbox_url, filename, content)
            scanned_pages = int(info.get("pagesWithoutText", 0) or 0)
            if scanned_pages and ocr_up:
                content = await ocr.ocr_pdf(settings.ocr_url, filename, content, languages=["eng"])
                ocr_first = True
        # 4. The redaction.
        out, report = await pdfbox.redact(
            settings.pdfbox_url, filename, content, terms=term_list, regions=region_list,
            case_sensitive=case_sensitive, remove_metadata=remove_metadata, dpi=dpi, keep_text=keep_text,
        )
        report["encryptionRemoved"] = bool(prep.get("encryptionRemoved"))
        extra = []
        if prep.get("fieldsFlattened"):
            extra.append(f"{prep['fieldsFlattened']} form field(s), flattened into the page")
        if prep.get("signaturesRemoved"):
            extra.append(f"{prep['signaturesRemoved']} digital signature(s) (redaction invalidates them)")
        if prep.get("fieldsDropped"):
            extra.append(f"{prep['fieldsDropped']} form field value(s) not shown on the page (hidden or without an appearance), removed")
        if prep.get("annotationsRemoved"):
            extra.append(f"{prep['annotationsRemoved']} annotation(s) mentioning a term or holding an attachment, "
                         "with their popups and replies")
        report["alsoRemoved"] = extra + list(report.get("alsoRemoved", []))
        if term_list and flattened_annotations:
            # Not a removal, but a change to every page: say so.
            report["annotationsFlattened"] = flattened_annotations
            report.setdefault("changes", []).append(
                f"{flattened_annotations} visible annotation(s) (comments, stamps, highlights) on all pages were "
                "flattened into the page content so their text could be searched; they are no longer editable"
            )
        if scanned_pages:
            report["scannedPages"] = scanned_pages
            report["scannedPagesSearched"] = ocr_first
            if not ocr_first:
                report["warning"] = (
                    f"{scanned_pages} page(s) are images without text and OCR is not installed: "
                    "terms printed on them could not be found. Check those pages and redact them by region."
                )
        found = sum(report.get("termMatches", {}).values())
        found += int(prep.get("annotationTermMatches", 0) or 0)
        if term_list and not found and not region_list:
            raise HTTPException(
                422,
                "None of the terms were found in the document, so nothing was redacted and no file was written. "
                "Check the spelling; text inside pictures is only found on pages without any text layer.",
            )
        report["textRestored"] = False
        pictures = [p for p in report.get("redactedPages", []) if p.get("method", "picture") == "picture"]
        if restore_text and pictures:
            if ocr_up:
                out = await ocr.ocr_pdf(settings.ocr_url, filename, out, languages=["eng"])
                report["textRestored"] = True
                # OCR must not have brought a redacted word back: check the final file again
                report.update(await pdfbox.verify_redaction(
                    settings.pdfbox_url, filename, out, terms=term_list, case_sensitive=case_sensitive
                ))
            else:
                report["note"] = "OCR is not installed, so the redacted pages are images without searchable text"
        if term_list and not report.get("verified", False):
            # Never hand back a file that still contains what was asked to be removed.
            where = ", ".join(report.get("rawObjectHits", [])[:5])
            raise HTTPException(
                422,
                f"Redaction check failed: a term can still be found ({report.get('remainingMatches', 0)} in page text"
                + (f"; also in {where}" if where else "") + "). Nothing was written.",
            )
        return out, {"report": report}

    if document_id:
        return await mutate("Redaction", op, file=file, document_id=document_id)
    content, filename = await load_document(file, "")
    out, info = await _run("Redaction", op, content, filename)
    report = json.dumps(info["report"], ensure_ascii=True).encode()
    # Same framing as the PDFBox service: "PDFREDACT1 <n>\n" + JSON report + PDF (no base64 copy).
    return Response(content=b"PDFREDACT1 %d\n" % len(report) + report + out,
                    media_type="application/x-pdf-redaction")


@router.get("/engine/ready")
async def engine_ready():
    """Whether the helper services answer (the MCP server waits for this)."""

    async def up(url: str) -> bool:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                return (await client.get(f"{url.rstrip('/')}/health")).status_code == 200
        except httpx.HTTPError:
            return False

    pdfbox_up = await up(settings.pdfbox_url)
    qpdf_up = await up(settings.qpdf_url)
    ocr_up = await ocr.is_available(settings.ocr_url)
    structure_up = await structure.is_available(settings.structure_url)
    return {"ready": pdfbox_up and qpdf_up, "pdfbox": pdfbox_up, "qpdf": qpdf_up, "ocr": ocr_up,
            "structure": structure_up}
