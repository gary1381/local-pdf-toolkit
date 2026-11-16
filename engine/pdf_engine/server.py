"""MCP server: PDF tools for AI agents that work on files on this computer.

Everything runs locally: files are read from disk, processed by the bundled
services on 127.0.0.1 and written back next to the original. Nothing is
uploaded anywhere.
"""
from __future__ import annotations

import functools
import json
import logging
import os
import re
import struct
from pathlib import Path
from typing import Annotated, Any

from mcp.server.fastmcp import Context, FastMCP, Image
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import BaseModel, Field

from . import PRODUCT, SERVER_NAME, __version__
from . import extract as grounding
from .client import EngineError, pdf_part, post
from .paths import PathError, PathPolicy, write_atomic

INSTRUCTIONS = f"""{PRODUCT} {__version__}: read, search, OCR, fill, redact, sign and
rearrange PDF files on this computer. Nothing leaves the machine.

- Paths are absolute paths of files on the user's computer.
- Tools that change a PDF never touch the original: they write a new file next
  to it (report.pdf -> report.redacted.pdf) unless you pass `output`. They
  refuse to replace an existing file unless overwrite=true.
- Start with pdf_info. Pages with 0 text characters are scans.
- To read a PDF, prefer pdf_outline then pdf_read_markdown (headings, columns in
  reading order, tables, no running headers) over pdf_read_text; they OCR scanned
  pages themselves and need the optional document structure add-on. To search
  or redact scans, or to keep a searchable copy, run pdf_ocr.
- Positions (x, y, width, height) are PDF points (1/72 inch) on the page as it
  is displayed, measured from the top-left corner. pdf_render_page shows a
  page and says how its pixels convert to points; pdf_find_text and
  pdf_form_fields return boxes in the same units.
- pdf_redact removes content for real (the text is gone, not covered) and
  checks the result; prefer it over drawing boxes.
- To pull data out (an invoice's fields, a contract's parties and dates), read
  the document, then pass your values with a JSON Schema to pdf_extract: it
  checks them and gives each value's page and box, so every value can be cited.
- Page numbers start at 1. Page ranges look like "1-3,5,8-".
"""

mcp = FastMCP(SERVER_NAME, instructions=INSTRUCTIONS,
              log_level=os.environ.get("PDF_ENGINE_LOG_LEVEL", "WARNING"))
logging.getLogger("httpx").setLevel(logging.WARNING)
mcp._mcp_server.version = __version__  # reported to clients as serverInfo.version
policy = PathPolicy()

READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)

PathArg = Annotated[str, Field(description="Absolute path of the PDF file")]
OutputArg = Annotated[str, Field(description="Where to write the result (absolute .pdf path). Empty: next to the input, e.g. name.<step>.pdf")]
OverwriteArg = Annotated[bool, Field(description="Allow replacing an existing output file")]
PasswordArg = Annotated[str, Field(description="Password, if the PDF is encrypted")]
PagesArg = Annotated[str, Field(description='1-based pages like "1-3,5,8-"; empty for all pages')]

MAX_TEXT_CHARS = 200_000


def guard(fn):
    """Turn known failures into tool errors with the message the agent should see."""

    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        except (PathError, EngineError) as exc:
            raise ToolError(str(exc)) from exc

    return wrapper


def tool(annotations: ToolAnnotations):
    def deco(fn):
        return mcp.tool(annotations=annotations)(guard(fn))

    return deco


# ---------------------------------------------------------------- helpers


def _read(path: str) -> tuple[Path, bytes]:
    src = policy.readable(path)
    data = src.read_bytes()
    if b"%PDF-" not in data[:1024]:
        raise PathError(f"{path} is not a PDF file")
    return src, data


def _file(src: Path, data: bytes) -> dict:
    return {"file": pdf_part(src.name, data)}


def _save(src: Path, label: str, output: str, overwrite: bool, content: bytes) -> str:
    target = policy.output_for(src, label, output, overwrite=overwrite)
    write_atomic(target, content, overwrite=overwrite)
    return policy.to_host(target)


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=1)


def _expand_pages(spec: str, what: str = "pages") -> list[int]:
    spec = (spec or "").replace(" ", "")
    if not re.fullmatch(r"\d+(-\d+)?(,\d+(-\d+)?)*", spec):
        raise PathError(f'Invalid {what}: use page numbers and ranges like "3,1,2" or "1-4,6"')
    out: list[int] = []
    for part in spec.split(","):
        if "-" in part:
            a, b = (int(x) for x in part.split("-"))
            out.extend(range(a, b + 1) if a <= b else range(a, b - 1, -1))
        else:
            out.append(int(part))
    return out


async def _page_info(src: Path, data: bytes, password: str = "") -> dict:
    return (await post("/page-info", files=_file(src, data), data={"password": password})).json()


def _one_based_signatures(result: dict) -> dict:
    """The service numbers pages from 0; tools speak in page numbers from 1."""
    for sig in result.get("signatures", []):
        if isinstance(sig.get("page"), int):
            sig["page"] += 1
    return result


# Public RFC 3161 timestamp authorities. Any other address needs
# PDF_ENGINE_ALLOW_ANY_TSA=1, so a document's text cannot steer the agent
# into making requests to arbitrary hosts.
KNOWN_TSA_HOSTS = {
    "timestamp.digicert.com", "timestamp.sectigo.com", "timestamp.comodoca.com", "freetsa.org",
    "timestamp.globalsign.com", "rfc3161timestamp.globalsign.com", "time.certum.pl", "timestamp.entrust.net",
    "tsa.swisssign.net", "timestamp.apple.com", "ts.ssl.com",
}


def _check_timestamp_url(url: str) -> None:
    if not url:
        return
    from urllib.parse import urlsplit

    host = (urlsplit(url).hostname or "").lower()
    if os.environ.get("PDF_ENGINE_ALLOW_ANY_TSA") == "1":
        return
    if host not in KNOWN_TSA_HOSTS:
        raise ToolError(
            f"{host or url} is not a known public timestamp server. Use one of: {', '.join(sorted(KNOWN_TSA_HOSTS))} "
            "(or start the engine with PDF_ENGINE_ALLOW_ANY_TSA=1)."
        )


def _png_size(png: bytes) -> tuple[int, int]:
    return struct.unpack(">II", png[16:24]) if png[:8] == b"\x89PNG\r\n\x1a\n" else (0, 0)


# ---------------------------------------------------------------- reading


@tool(READ)
async def pdf_info(path: PathArg, password: PasswordArg = "") -> str:
    """Overview of a PDF: page count, metadata, form fields, signatures, and for each
    page its displayed size in points, rotation and amount of text (0 = a scan that
    needs pdf_ocr). Call this first on an unfamiliar PDF."""
    src, data = _read(path)
    info = await _page_info(src, data, password)
    info = {"file": policy.to_host(src), "fileBytes": len(data), **info}
    pages = info.get("pages", [])
    if len(pages) > 200:
        info["pages"] = pages[:200]
        info["pagesTruncated"] = f"showing 200 of {len(pages)} pages"
    hints = []
    if info.get("pagesWithoutText"):
        hints.append(f"{info['pagesWithoutText']} page(s) have no text layer (scanned): pdf_read_markdown OCRs them "
                     "for reading; run pdf_ocr to search or redact them")
    if info.get("formFieldCount"):
        hints.append("This PDF has fillable form fields: see pdf_form_fields and pdf_fill_form")
    if info.get("signatureCount"):
        hints.append("This PDF is digitally signed: any change breaks the signature; see pdf_verify_signatures")
    if hints:
        info["hints"] = hints
    return _dump(info)


@tool(READ)
async def pdf_read_text(
    path: PathArg,
    pages: PagesArg = "",
    reading_order: Annotated[bool, Field(description="Sort the text by position, top to bottom and left to right across the "
                                                     "whole page. Can help forms laid out in rows; do not use it for "
                                                     "multi-column pages, whose columns it mixes (pdf_read_markdown "
                                                     "reads columns in order)")] = False,
    password: PasswordArg = "",
) -> str:
    """Text of a PDF, page by page. Scanned pages have no text: run pdf_ocr first."""
    src, data = _read(path)
    result = (await post("/page-text", files=_file(src, data),
                         data={"pages": pages, "sort_by_position": reading_order, "password": password})).json()
    parts, total = [], 0
    for p in result.get("pages", []):
        text = (p.get("text") or "").strip()
        body = text if text else "[no text on this page: it is probably a scan; run pdf_ocr]"
        chunk = f"=== Page {p['page']} of {result.get('pageCount')} ===\n{body}\n"
        if total + len(chunk) > MAX_TEXT_CHARS:
            parts.append(f"[stopped at {MAX_TEXT_CHARS} characters; ask for later pages with the pages argument]")
            break
        parts.append(chunk)
        total += len(chunk)
    return "\n".join(parts) if parts else "No pages in that range."


STRUCTURE_HINT = ("The document structure add-on is not installed in this engine (it is optional: about 2 GB). "
                  "Use pdf_read_text meanwhile; to add it, run scripts/install-structure.sh, or use the engine "
                  "image built with --build-arg WITH_STRUCTURE=1.")


OcrArg = Annotated[bool, Field(description="OCR the pages without a text layer (scans) and the pictures on "
                                           "text pages first, when the OCR add-on is installed; the file "
                                           "itself is not changed")]


ModelArg = Annotated[str, Field(description='"auto" (default): tables, formulas, mathematics and scanned pages '
                                            'are read again by the document reading model when one is installed; '
                                            '"on" (an error without one) or "off"')]


async def _structure(src: Path, data: bytes, pages: str, password: str, ocr: bool = True,
                     model: str = "auto") -> dict:
    try:
        return (await post("/structure", files=_file(src, data),
                           data={"pages": pages, "password": password, "ocr": str(ocr).lower(), "model": model},
                           timeout=1800.0)).json()
    except EngineError as exc:
        if "structure component is not installed" in str(exc):
            raise EngineError(STRUCTURE_HINT) from exc
        raise


def _pages_word(pages: list[int]) -> str:
    return f"Page {pages[0]}" if len(pages) == 1 else f"Pages {','.join(map(str, pages))}"


def _scan_note(result: dict) -> str:
    notes = []
    reread = result.get("rereadPages") or []
    if ocred := [p for p in result.get("ocrPages") or [] if p not in reread]:
        notes.append(f"{_pages_word(ocred)} had no text layer and {'was' if len(ocred) == 1 else 'were'} OCR'd "
                     "for this reading (the file is unchanged); recognised text can contain errors.")
    if reread:
        notes.append(f"The text of {_pages_word(reread).lower()} could not be decoded (a font without a "
                     "Unicode map), so it was read from the page image with OCR; recognised text can contain errors.")
    elif garbled := result.get("garbledPages"):
        notes.append(f"The text of {_pages_word(garbled).lower()} cannot be decoded (a font without a Unicode "
                     "map) and reads as nonsense; with the OCR add-on it is read from the page image instead.")
    if pictures := result.get("pictureOcrPages"):
        notes.append(f"The pictures on {_pages_word(pictures).lower()} were read with OCR; the text in a "
                     "picture is quoted under it.")
    if result.get("modelUsed"):
        notes.append("Tables, formulas and scanned text were read by the document reading model "
                     "(formulas as LaTeX); check numbers you rely on against the page.")
    if scans := result.get("pagesWithoutText"):
        why = result.get("ocrNote") or "they hold no recognisable text"
        notes.append(f"{_pages_word(scans)} still {'has' if len(scans) == 1 else 'have'} no text: {why}.")
    return " ".join(notes)


@tool(READ)
async def pdf_outline(path: PathArg, password: PasswordArg = "", ocr: OcrArg = True) -> str:
    """Table of contents of a PDF as it is printed: the title and the headings
    found on the pages, each with its level, page and how much text its section
    holds (characters). Read a long document part by part: outline first, then
    pdf_read_markdown for the pages of the sections you need. Scanned pages are
    OCR'd first. Needs the document structure add-on; converting takes a few
    seconds per page on first use."""
    src, data = _read(path)
    result = await _structure(src, data, "", password, ocr, model="off")  # headings need no model
    outline = result.get("outline", [])
    elements = result.get("elements", [])
    index = {e["id"]: i for i, e in enumerate(elements)}
    for n, entry in enumerate(outline):
        start = index.get(entry.pop("element", ""), 0)
        # the section runs until the next heading of the same or a higher level
        end = len(elements)
        for later in outline[n + 1:]:
            if later["level"] <= entry["level"]:
                end = index.get(later.get("element", ""), end)
                break
        chars = sum(len(e.get("text", "")) + sum(len(c) for row in e.get("rows", []) for c in row)
                    for e in elements[start + 1:end])
        entry["chars"] = chars
        last = elements[end - 1]["page"] if end > start else entry["page"]
        entry["pages"] = f"{entry['page']}-{last}" if last > entry["page"] else str(entry["page"])
    out: dict[str, Any] = {"file": policy.to_host(src), "pageCount": result.get("pageCount"),
                           "outline": outline[:500]}
    if len(outline) > 500:
        out["note"] = f"showing 500 of {len(outline)} headings"
    if not outline:
        out["note"] = "No headings found: the document has no visible structure; read it with pdf_read_markdown."
    out["tables"] = sum(1 for e in elements if e["type"] == "table")
    out["pictures"] = sum(1 for e in elements if e["type"] == "picture")
    if note := _scan_note(result):
        out["hint"] = note
    return _dump(out)


@tool(READ)
async def pdf_read_markdown(
    path: PathArg,
    pages: PagesArg = "",
    password: PasswordArg = "",
    ocr: OcrArg = True,
    model: ModelArg = "auto",
) -> str:
    """The PDF as Markdown, in reading order: headings (#), paragraphs, lists and
    tables as Markdown tables; columns are read one after the other and running
    page headers and footers are left out. Each page starts with
    <!-- page N of M --> so you can cite pages. Prefer this over pdf_read_text for
    reports, papers, contracts and anything with columns or tables. Scanned pages
    (no text layer) are OCR'd first when the OCR add-on is installed. Needs the
    document structure add-on (a few seconds per page on CPU)."""
    src, data = _read(path)
    result = await _structure(src, data, pages, password, ocr, model)
    total = result.get("pageCount")
    parts, size = [], 0
    if note := _scan_note(result):
        parts.append(f"<!-- {note} -->")
    for p in result.get("pages", []):
        body = (p.get("markdown") or "").strip()
        if not body:
            body = ("[no text on this page: it is a scan with no recognisable text]" if not p.get("textChars")
                    else "[nothing but page headers, footers or pictures on this page]")
        chunk = f"<!-- page {p['page']} of {total} -->\n{body}\n"
        if size + len(chunk) > MAX_TEXT_CHARS:
            parts.append(f"<!-- stopped at {MAX_TEXT_CHARS} characters; ask for pages from {p['page']} "
                         "with the pages argument -->")
            break
        parts.append(chunk)
        size += len(chunk)
    return "\n".join(parts) if parts else "No pages in that range."


@tool(READ)
async def pdf_structure(
    path: PathArg,
    pages: PagesArg = "1",
    types: Annotated[list[str], Field(description='Only these kinds, e.g. ["table"] or ["section_header", "title"]; '
                                                  'empty for all. Kinds: title, section_header, text, list_item, '
                                                  'table, picture, caption, footnote, formula, code')] = [],
    password: PasswordArg = "",
    ocr: OcrArg = True,
    model: ModelArg = "auto",
) -> str:
    """The blocks of the pages in reading order, as JSON: kind, page, box (points
    from the top-left, the same units as pdf_find_text and pdf_highlight), the
    section it belongs to, and its text; tables come as rows of cells. Use it to
    pull out tables or to point at a passage you quote. Scanned pages are OCR'd
    first. Needs the document structure add-on."""
    src, data = _read(path)
    result = await _structure(src, data, pages, password, ocr, model)
    elements = result.get("elements", [])
    if types:
        elements = [e for e in elements if e["type"] in set(types)]
    out: dict[str, Any] = {"file": policy.to_host(src), "pageCount": result.get("pageCount"),
                           "pages": [{k: p[k] for k in ("page", "width", "height")} for p in result.get("pages", [])]}
    kept, size = [], 0
    for e in elements:
        size += len(json.dumps(e, ensure_ascii=False))
        if size > MAX_TEXT_CHARS:
            out["note"] = (f"stopped after {len(kept)} of {len(elements)} elements; "
                           "ask for fewer pages or filter with types")
            break
        kept.append(e)
    out["elements"] = kept
    if note := _scan_note(result):
        out["hint"] = note
    return _dump(out)


@tool(READ)
async def pdf_find_text(
    path: PathArg,
    terms: Annotated[list[str], Field(description="Words or phrases to find (whitespace and line breaks inside a phrase are ignored)")],
    case_sensitive: bool = False,
    pages: PagesArg = "",
    password: PasswordArg = "",
) -> str:
    """Find where words appear: page number and boxes (points from the top-left) for
    every match. Use the boxes with pdf_redact, pdf_highlight or pdf_add_text."""
    src, data = _read(path)
    result = (await post("/find-text", files=_file(src, data), data={
        "terms": terms, "case_sensitive": case_sensitive, "pages": pages, "password": password,
    })).json()
    matches = result.get("matches", [])
    if len(matches) > 300:
        result["matches"] = matches[:300]
        result["note"] = f"showing 300 of {len(matches)} matches"
    return _dump(result)


@tool(READ)
async def pdf_render_page(
    path: PathArg,
    page: Annotated[int, Field(description="Page number, from 1", ge=1)] = 1,
    dpi: Annotated[int, Field(description="Resolution, 30-200; 100 is enough to read normal text", ge=30, le=200)] = 100,
    password: PasswordArg = "",
):
    """Look at a page: returns it as a PNG image, with the factor that converts its
    pixels to the point coordinates the other tools use."""
    src, data = _read(path)
    png = (await post("/render-page", files=_file(src, data), data={
        "page_index": page - 1, "scale": round(dpi / 72, 4), "password": password,
    })).content
    w, h = _png_size(png)
    note = (f"Page {page} of {policy.to_host(src)}: {w} x {h} px at {dpi} dpi. "
            f"To get points (top-left origin) multiply pixels by {72 / dpi:.4f}.")
    return [Image(data=png, format="png"), note]


def _label_for(field: dict, phrases: list[dict]) -> tuple[str | None, list[str]]:
    """The printed caption of a field: the nearest text left of it on the same row,
    right of it for checkboxes and radio buttons, or just above it. Also returns
    the next nearest texts, for when the layout is ambiguous."""
    x, y, w, h = field["x"], field["y"], field["width"], field["height"]
    words = [p for p in phrases if len(p["text"].strip()) > 1 and any(c.isalnum() for c in p["text"])]
    found: list[tuple[float, dict, str]] = []
    for p in words:
        px, py, pw, ph = p["x"], p["y"], p["width"], p["height"]
        pr, pb = px + pw, py + ph
        if px >= x - 1 and pr <= x + w + 1 and py >= y - 1 and pb <= y + h + 1:
            continue  # text inside the field: its own value
        if ph > pw * 1.5:
            continue  # vertical margin text
        v_overlap = min(pb, y + h) - max(py, y)
        h_overlap = min(pr, x + w) - max(px, x)
        cands = []
        if v_overlap > 0.4 * min(ph, h):
            if pr <= x + 2 and x - pr < 220:
                cands.append((x - pr, "left"))
            elif px >= x + w - 2 and px - (x + w) < 60 and field.get("kind") in ("checkbox", "radio"):
                cands.append(((px - (x + w)) * 0.8, "right"))
        if h_overlap > 0 and pb <= y + 2 and y - pb < 30:
            # same-row captions win when close; captions above are usually left-aligned with the field
            cands.append((max(y - pb, 0) * 2 + 4 + abs(px - x) * 0.3, "above"))
        if cands:
            d, where = min(cands)
            found.append((d, p, where))
    if not found:
        return None, []
    found.sort(key=lambda t: t[0])

    def caption(p: dict, where: str) -> str:
        lines = [p["text"].strip()]
        if where == "above":  # a caption may run over several lines: collect those stacked above
            cur = p
            for _ in range(4):
                if re.match(r"^\(?\d+[a-z]?\)?\s", cur["text"].strip()):
                    break  # "5  Address ...": the caption starts here
                # the line above belongs to the caption if it starts at the same indent or further
                # left (first lines hang out), right above this one
                up = [q for q in words if q is not cur and -16 <= q["x"] - cur["x"] <= 2
                      and -3 <= cur["y"] - (q["y"] + q["height"]) < 6 and q["y"] < cur["y"]]
                if not up:
                    break
                cur = max(up, key=lambda q: q["y"])
                lines.insert(0, cur["text"].strip())
        text = " ".join(lines)
        return text if len(text) <= 160 else text[:157] + "..."

    label = caption(found[0][1], found[0][2])
    others: list[str] = []
    for _, p, where in found[1:]:
        t = caption(p, where)
        if t != label and t not in others:
            others.append(t if len(t) <= 80 else t[:77] + "...")
        if len(others) == 2:
            break
    return label, others


@tool(READ)
async def pdf_form_fields(path: PathArg, password: PasswordArg = "") -> str:
    """Fillable form fields: name, kind (text, checkbox, radio, choice, signature),
    current value, options, position, and the printed label next to each field (so
    cryptic names like f1_01 can be matched to "Name"). Use the names with pdf_fill_form."""
    src, data = _read(path)
    fields = (await post("/form-fields", files=_file(src, data), data={"password": password})).json().get("fields", [])
    if not fields:
        return "This PDF has no fillable form fields. To write on it, use pdf_text_layout and pdf_add_text."
    for f in fields:
        if "pageIndex" in f:
            f["page"] = f.pop("pageIndex") + 1
    pages = sorted({f["page"] for f in fields if "page" in f})
    if pages:
        layout = (await post("/text-layout", files=_file(src, data), data={
            "pages": ",".join(map(str, pages)), "password": password,
        })).json()
        by_page = {p["page"]: p["phrases"] for p in layout.get("pages", [])}
        for f in fields:
            if "page" in f and "x" in f:
                label, others = _label_for(f, by_page.get(f["page"], []))
                if label:
                    f["label"] = label
                if others:
                    f["alsoNear"] = others
            for k in ("x", "y", "width", "height"):
                if isinstance(f.get(k), float):
                    f[k] = round(f[k], 1)
    return _dump({"fieldCount": len(fields), "fields": fields})


@tool(READ)
async def pdf_text_layout(path: PathArg, pages: PagesArg = "1", password: PasswordArg = "") -> str:
    """The text of pages as phrases with positions (points from the top-left): labels,
    table cells, lines. Use it to find where to write on forms that have no fillable
    fields ("Date: ____") or to read tables cell by cell."""
    src, data = _read(path)
    layout = (await post("/text-layout", files=_file(src, data), data={"pages": pages, "password": password})).json()
    count = 0
    for p in layout.get("pages", []):
        if count >= 3000:
            p["phrases"] = []
            p["note"] = "omitted: too much text; ask for fewer pages"
        count += len(p.get("phrases", []))
    return _dump(layout)


@tool(READ)
async def pdf_verify_signatures(path: PathArg, password: PasswordArg = "") -> str:
    """Check the digital signatures in a PDF: who signed, when, whether the document
    changed after signing, and whether the certificate is trusted or self-signed."""
    src, data = _read(path)
    result = (await post("/verify-signatures", files=_file(src, data), data={"password": password})).json()
    return _dump(_one_based_signatures(result))


# ---------------------------------------------------------------- changing a PDF


@tool(WRITE)
async def pdf_ocr(
    path: PathArg,
    output: OutputArg = "",
    languages: Annotated[str, Field(description='"eng" or "eng,chi_sim" (English, simplified Chinese)')] = "eng",
    pictures: Annotated[bool, Field(description="Also read the pictures on pages that have text (charts, "
                                                "photos, scanned inserts)")] = True,
    overwrite: OverwriteArg = False,
) -> str:
    """Make a scanned PDF searchable: recognise the text on pages that have none and,
    with pictures, in the pictures on the other pages, and add it as an invisible
    layer (the pages look the same; their own text is not touched). Runs locally."""
    src, data = _read(path)
    resp = await post("/ocr", files=_file(src, data), data={"languages": languages, "pictures": pictures},
                      timeout=1800.0)
    out = resp.content
    after = await _page_info(src, out)
    saved = _save(src, "ocr", output, overwrite, out)
    pages = lambda h: [int(p) for p in resp.headers.get(h, "").split(",") if p.strip().isdigit()]  # noqa: E731
    return _dump({
        "output": saved,
        "pages": after.get("pageCount"),
        "scannedPagesRead": pages("X-OCR-Pages"),
        "pagesWithPicturesRead": pages("X-Picture-OCR-Pages"),
        "pagesStillWithoutText": after.get("pagesWithoutText"),
    })


class Region(BaseModel):
    page: int = Field(ge=1, description="Page number, from 1")
    x: float = Field(description="Left edge, points from the left")
    y: float = Field(description="Top edge, points from the top")
    width: float = Field(gt=0)
    height: float = Field(gt=0)


@tool(WRITE)
async def pdf_redact(
    path: PathArg,
    terms: Annotated[list[str], Field(description="Words or phrases to remove everywhere they appear")] = [],  # noqa: B006
    regions: Annotated[list[Region], Field(description="Areas to remove, in points from the top-left")] = [],  # noqa: B006
    output: OutputArg = "",
    case_sensitive: bool = False,
    restore_text: Annotated[bool, Field(description="OCR pages rebuilt as images so their other words stay searchable")] = True,
    remove_metadata: Annotated[bool, Field(description="Also clear title, author and other document metadata")] = False,
    keep_text: Annotated[bool, Field(description="Keep redacted pages as text where the removal can be checked; false rebuilds every such page as an image")] = True,
    overwrite: OverwriteArg = False,
    password: PasswordArg = "",
) -> str:
    """Remove text or areas for real. On every page with something to redact, the
    characters, picture pixels, shapes and annotations under the boxes are taken out
    of the page and black boxes drawn; the rest of the page stays text. A page where
    that cannot be done or checked is rewritten as an image with the boxes burnt in
    (the report gives each page's method); forms (and digital signatures) are
    flattened and removed; annotations, bookmarks and metadata mentioning a term,
    attachments, scripts and accessibility tags are removed; other visible annotations
    on all pages are flattened into the page so their text can be checked (reported
    as annotationsFlattened); scanned pages are OCR'd first so terms on them are
    found. The whole file is scanned afterwards and nothing is written if a term
    remains, or if no term was found at all. Read the
    report (termsNotFound, otherPagesWithPictures) and look at the output with
    pdf_render_page."""
    if not terms and not regions:
        raise ToolError("Give terms or regions to redact")
    src, data = _read(path)
    resp = await post("/redact", files=_file(src, data), data={
        "terms": terms,
        "regions": [r.model_dump() for r in regions],
        "case_sensitive": case_sensitive,
        "restore_text": restore_text,
        "remove_metadata": remove_metadata,
        "keep_text": keep_text,
        "password": password,
    })
    head, _, rest = resp.content.partition(b"\n")
    size = int(head.split(b" ")[1])
    report, pdf = json.loads(rest[:size]), rest[size:]
    saved = _save(src, "redacted", output, overwrite, pdf)
    return _dump({"output": saved, **report})


@tool(WRITE)
async def pdf_fill_form(
    path: PathArg,
    values: Annotated[dict[str, Any], Field(description="Field name -> value. Checkboxes take true/false; choices take one of the options")],
    output: OutputArg = "",
    flatten: Annotated[bool, Field(description="Make the filled form final (no longer editable)")] = False,
    overwrite: OverwriteArg = False,
    password: PasswordArg = "",
) -> str:
    """Fill a PDF form's fields by name (see pdf_form_fields), then read the values
    back to confirm them."""
    src, data = _read(path)
    fields = (await post("/form-fields", files=_file(src, data), data={"password": password})).json().get("fields", [])
    if not fields:
        raise ToolError("This PDF has no fillable form fields. To write on it, use pdf_add_text.")
    by_name = {f["name"]: f for f in fields}
    unknown = [k for k in values if k not in by_name]
    if unknown:
        raise ToolError(f"Unknown field(s): {', '.join(unknown)}. Fields in this form: {', '.join(by_name)}")
    prepared: dict[str, str] = {}
    problems: list[str] = []
    for name, value in values.items():
        f = by_name[name]
        if f.get("readOnly"):
            problems.append(f"{name} is read-only and was skipped")
            continue
        if f.get("kind") == "checkbox":
            on = value is True or str(value).lower() in ("true", "yes", "on", "1", "x", str(f.get("onValue", "")).lower())
            prepared[name] = str(f.get("onValue") or "Yes") if on else "Off"
        elif f.get("kind") in ("choice", "radio") and f.get("options") and str(value) not in map(str, f["options"]):
            raise ToolError(f"{name} must be one of: {', '.join(map(str, f['options']))}")
        else:
            prepared[name] = "" if value is None else str(value)
    if not prepared:
        raise ToolError("Nothing to fill: " + "; ".join(problems))
    resp = await post("/fill-form", files=_file(src, data), data={"values": prepared, "password": password})
    out = resp.content
    # read back what the file now says
    after = (await post("/form-fields", files=_file(src, out), data={"password": password})).json().get("fields", [])
    now = {f["name"]: f for f in after}
    for name, want in prepared.items():
        f = now.get(name, {})
        got = ("Yes" if f.get("checked") else "Off") if f.get("kind") == "checkbox" else str(f.get("value", ""))
        if f.get("kind") == "choice" and got.startswith("[") and got.endswith("]"):
            got = got[1:-1]  # list boxes report their selection as a list
        if f.get("kind") == "checkbox":
            if (want != "Off") != bool(f.get("checked")):
                problems.append(f"{name}: expected {'checked' if want != 'Off' else 'unchecked'}, file says {got}")
        elif got != want:
            problems.append(f"{name}: expected {want!r}, file says {got!r}")
    if flatten:
        out = (await post("/flatten", files=_file(src, out), data={"engine": "pdfbox"})).content
    saved = _save(src, "filled", output, overwrite, out)
    result = {"output": saved, "filled": len(prepared), "flattened": flatten}
    if problems:
        result["problems"] = problems
    return _dump(result)


@tool(WRITE)
async def pdf_add_text(
    path: PathArg,
    page: Annotated[int, Field(ge=1)],
    x: Annotated[float, Field(description="Left edge, points from the left")],
    y: Annotated[float, Field(description="Top of the text, points from the top")],
    text: str,
    font_size: Annotated[float, Field(gt=0, le=200)] = 11,
    output: OutputArg = "",
    overwrite: OverwriteArg = False,
    password: PasswordArg = "",
) -> str:
    """Write text onto a page (for forms without fillable fields, or notes on the page
    itself). Supports Latin and Chinese characters."""
    src, data = _read(path)
    out = (await post("/draw-text", files=_file(src, data), data={
        "page_index": page - 1, "x": x, "y": y, "text": text, "font_size": font_size,
        "height": font_size * 1.2, "width": max(20.0, len(text) * font_size * 0.6), "password": password,
    })).content
    return _dump({"output": _save(src, "edited", output, overwrite, out)})


@tool(WRITE)
async def pdf_add_note(
    path: PathArg,
    page: Annotated[int, Field(ge=1)],
    x: float,
    y: float,
    text: str,
    output: OutputArg = "",
    overwrite: OverwriteArg = False,
    password: PasswordArg = "",
) -> str:
    """Add a sticky-note comment at a point on a page (shown as an icon in PDF viewers)."""
    src, data = _read(path)
    out = (await post("/annotate", files=_file(src, data), data={
        "page_index": page - 1, "x": x, "y": y, "text": text, "password": password,
    })).content
    return _dump({"output": _save(src, "annotated", output, overwrite, out)})


@tool(WRITE)
async def pdf_highlight(
    path: PathArg,
    terms: Annotated[list[str], Field(description="Words or phrases to highlight wherever they appear")],
    case_sensitive: bool = False,
    output: OutputArg = "",
    overwrite: OverwriteArg = False,
    password: PasswordArg = "",
) -> str:
    """Highlight words (yellow highlight annotations) wherever they appear."""
    src, data = _read(path)
    found = (await post("/find-text", files=_file(src, data), data={
        "terms": terms, "case_sensitive": case_sensitive, "password": password,
    })).json()
    boxes = [(m["page"], b) for m in found.get("matches", []) for b in m["boxes"]]
    if not boxes:
        raise ToolError("None of the terms appear in the text of this PDF (scanned pages need pdf_ocr first)")
    if len(boxes) > 300:
        raise ToolError(f"{len(boxes)} places to highlight; narrow the terms (limit 300)")
    out = data
    for page_no, b in boxes:
        out = (await post("/highlight", files=_file(src, out), data={
            "page_index": page_no - 1, "x": b["x"], "y": b["y"], "width": b["width"], "height": b["height"],
            "password": password,
        })).content
    return _dump({"output": _save(src, "highlighted", output, overwrite, out), "highlights": len(boxes)})


# ---------------------------------------------------------------- extracting data

EXTRACT_PROMPT = """Extract data from the document below into JSON that matches this JSON Schema.
Copy values exactly as they are written in the document (numbers and dates may be
normalised to the schema's format). Leave out fields the document does not give;
do not guess. Answer with the JSON only.

JSON Schema:
{schema}

Document ({name}):
{text}"""


async def _sample_values(ctx: Context | None, src: Path, data: bytes, schema: dict, pages: str, password: str) -> Any:
    """Ask the client's model to fill the schema from the document (MCP sampling)."""
    from mcp import types

    if ctx is None or not ctx.session.check_client_capability(types.ClientCapabilities(sampling=types.SamplingCapability())):
        raise ToolError("Pass the values: read the document (pdf_read_markdown or pdf_read_text), fill the schema "
                        "yourself and call pdf_extract again with values=...; this tool then checks them against "
                        "the schema and finds where each one is. (This client does not let the engine ask its model.)")
    try:
        result = await _structure(src, data, pages, password)
        text = "\n".join(f"<!-- page {p['page']} -->\n{p.get('markdown') or ''}" for p in result.get("pages", []))
    except EngineError:
        result = (await post("/page-text", files=_file(src, data), data={"pages": pages, "password": password})).json()
        text = "\n".join(f"<!-- page {p['page']} -->\n{p.get('text') or ''}" for p in result.get("pages", []))
    prompt = EXTRACT_PROMPT.format(schema=json.dumps(schema, ensure_ascii=False), name=src.name,
                                   text=text[:MAX_TEXT_CHARS])
    reply = await ctx.session.create_message(
        messages=[types.SamplingMessage(role="user", content=types.TextContent(type="text", text=prompt))],
        max_tokens=8000,
    )
    answer = getattr(reply.content, "text", "") or ""
    answer = re.sub(r"^```(?:json)?\s*|\s*```$", "", answer.strip())
    try:
        return json.loads(answer)
    except ValueError as exc:
        raise ToolError("The model's answer was not JSON; pass the values yourself") from exc


@tool(READ)
async def pdf_extract(
    path: PathArg,
    json_schema: Annotated[dict, Field(description="JSON Schema of the data to pull out, e.g. "
                                                   '{"type":"object","properties":{"invoice_number":{"type":"string"},'
                                                   '"total":{"type":"number"},"due_date":{"type":"string","format":"date"}}}')],
    values: Annotated[dict | list | None, Field(description="The data as you read it from the document, in the shape "
                                                            "of the schema. Leave empty to have the client's model "
                                                            "fill it (only if the client supports MCP sampling)")] = None,
    pages: PagesArg = "",
    password: PasswordArg = "",
    ctx: Context | None = None,
) -> str:
    """Pull data out of a PDF in the shape of a JSON Schema, with a source for every
    value: its page, its box (points from the top-left, as pdf_find_text and
    pdf_highlight use) and the line of text it is on. Read the document first
    (pdf_read_markdown), fill the schema and pass it as values: they are checked
    against the schema and each one is looked up in the PDF, also when written
    differently (1,234.50 for 1234.5; October 13, 2026 for 2026-10-13). Values not
    found in the text are listed in notFound: check them again, they may be
    misread or not in the document."""
    from jsonschema import validators
    from jsonschema.exceptions import SchemaError

    src, data = _read(path)
    try:
        checker = validators.validator_for(json_schema)
        checker.check_schema(json_schema)
    except SchemaError as exc:
        raise ToolError(f"The JSON Schema is not valid: {exc.message}") from exc
    if values is None:
        values = await _sample_values(ctx, src, data, json_schema, pages, password)
    errors = [{"path": "/".join(map(str, e.absolute_path)) or "$", "message": e.message}
              for e in list(checker(json_schema).iter_errors(values))[:50]]

    leaves = grounding.leaves(values, json_schema)
    for leaf in leaves:
        leaf.terms = grounding.search_terms(leaf)
    terms = list(dict.fromkeys(t for leaf in leaves for t in leaf.terms))
    matches: list[dict] = []
    for i in range(0, len(terms), 200):
        found = (await post("/find-text", files=_file(src, data), data={
            "terms": terms[i:i + 200], "pages": pages, "password": password})).json()
        matches.extend(found.get("matches", []))
    layout = (await post("/text-layout", files=_file(src, data), data={"pages": pages, "password": password})).json()
    phrases = {p["page"]: p.get("phrases", []) for p in layout.get("pages", [])}

    by_term: dict[str, list[dict]] = {}
    for m in matches:
        if m.get("boxes"):
            by_term.setdefault(m["term"].casefold(), []).append(
                {"page": m["page"], "box": grounding.union(m["boxes"]), "text": m.get("text", "")})
    focus: dict[int, int] = {}
    for leaf in leaves:
        for page in {c["page"] for t in leaf.terms for c in by_term.get(t.casefold(), [])}:
            focus[page] = focus.get(page, 0) + 1

    sources, missing = [], []
    for leaf in leaves:
        item: dict[str, Any] = {"path": leaf.path, "value": leaf.value}
        candidates = [dict(c, term=t) for t in leaf.terms for c in by_term.get(t.casefold(), [])]
        if isinstance(leaf.value, bool):
            item.update(found=None, note="a yes/no value: not looked up in the text")
        elif candidates:
            words = grounding.label_words(leaf.path, leaf.schema)
            labels = [dict(p, page=page) for page, items in phrases.items() for p in items
                      if words & set(re.findall(r"\w+", p["text"].casefold()))]
            best = grounding.pick(candidates, labels, focus)
            item.update(found=True, match="exact" if best["term"] == leaf.terms[0] else "reformatted",
                        page=best["page"], box=best["box"], text=best["text"],
                        line=grounding.quote(phrases.get(best["page"], []), best["box"]))
            if len(candidates) > 1:
                item["otherPlaces"] = len(candidates) - 1
        elif isinstance(leaf.value, str) and (hit := grounding.fuzzy_find(leaf.value, phrases)):
            item.update(found=True, match="approximate", similarity=hit["score"], page=hit["page"], box=hit["box"],
                        line=hit["text"])
        else:
            item["found"] = False
            missing.append(leaf.path)
        sources.append(item)
    looked = [s for s in sources if s["found"] is not None]
    return _dump({
        "file": policy.to_host(src),
        "valid": not errors,
        **({"schemaErrors": errors} if errors else {}),
        "values": values,
        "summary": f"{sum(1 for s in looked if s['found'])} of {len(looked)} values found in the text",
        "sources": sources,
        **({"notFound": missing} if missing else {}),
    })


# ---------------------------------------------------------------- pictures

IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png", ".tif", ".tiff", ".gif", ".bmp")
OutputDirArg = Annotated[str, Field(description="Folder to write into (absolute path; created, must not exist or be "
                                                "empty). Empty: a new folder next to the PDF")]


def _output_dir(src: Path, label: str, output_dir: str) -> Path:
    """A new (or empty) folder for several files: the given one, or <name>.<label>/ next to the PDF."""
    if output_dir and output_dir.strip():
        # inside the shared folders, its parent exists, not a symbolic link
        folder = policy.writable(output_dir.strip().rstrip("/\\"), suffixes=(), overwrite=True)
        if folder.exists():
            if not folder.is_dir() or any(folder.iterdir()):
                raise PathError(f"{output_dir} must be a new or empty folder")
        else:
            folder.mkdir()
        return folder
    stem = src.name[: -len(src.suffix)] if src.suffix else src.name
    candidate, n = src.with_name(f"{stem}.{label}"), 2
    while candidate.exists() or candidate.is_symlink():
        candidate, n = src.with_name(f"{stem}.{label}-{n}"), n + 1
    if not policy._inside_roots(candidate):
        raise PathError(f"{policy.to_host(candidate)} is outside the folders this engine may use")
    candidate.mkdir()
    return candidate


def _unpack(zipped: bytes, folder: Path) -> list[str]:
    import io
    import zipfile

    written = []
    with zipfile.ZipFile(io.BytesIO(zipped)) as z:
        for name in z.namelist():
            parts = Path(name).parts
            if not parts or name.endswith("/") or any(p in ("..", "") or ":" in p for p in parts) or Path(name).is_absolute():
                continue
            target = folder.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            write_atomic(target, z.read(name))
            written.append(name)
    return written


def _picture_summary(manifest: dict, limit: int = 200) -> list[dict]:
    out = []
    for img in manifest.get("images", [])[:limit]:
        item = {k: img[k] for k in ("page", "x", "y", "width", "height", "pixelWidth", "pixelHeight") if k in img}
        item["file"] = img.get("sameAs") or img.get("file")
        if img.get("text"):
            item["text"] = img["text"][:300] + ("…" if len(img["text"]) > 300 else "")
        out.append(item)
    return out


@tool(WRITE)
async def pdf_extract_images(
    path: PathArg,
    output_dir: OutputDirArg = "",
    pages: PagesArg = "",
    ocr: Annotated[bool, Field(description="Read the text in each picture (OCR when the add-on is installed)")] = True,
    min_size: Annotated[int, Field(ge=1, description="Leave out pictures smaller than this many pixels a side")] = 32,
    password: PasswordArg = "",
) -> str:
    """Save the pictures in a PDF as image files (JPEGs keep their original bytes,
    others are PNG) in a new folder, with manifest.json: each picture's page and
    box (points from the top-left), pixel size, and the text read in it (also in a
    .txt beside the picture). A picture used several times is saved once."""
    src, data = _read(path)
    resp = await post("/extract-images", files=_file(src, data),
                      data={"pages": pages, "ocr": ocr, "min_size": min_size, "password": password}, timeout=1800.0)
    import io
    import zipfile

    with zipfile.ZipFile(io.BytesIO(resp.content)) as z:
        manifest = json.loads(z.read("manifest.json"))
    if not manifest.get("images"):
        return _dump({"pictures": 0, "note": "No pictures on these pages (drawings made of lines and text are not pictures)"})
    folder = _output_dir(src, "images", output_dir)
    _unpack(resp.content, folder)
    out = {"folder": policy.to_host(folder), "pictures": len(manifest["images"]), "files": manifest.get("files"),
           "images": _picture_summary(manifest)}
    if manifest.get("ocrNote"):
        out["note"] = manifest["ocrNote"]
    return _dump(out)


@tool(WRITE)
async def pdf_from_images(
    images: Annotated[list[str], Field(description="Absolute paths of the pictures (JPEG, PNG, TIFF, GIF, BMP), "
                                                   "one page each, in this order")],
    output: Annotated[str, Field(description="Absolute .pdf path. Empty: next to the first picture, with its name")] = "",
    ocr: Annotated[bool, Field(description="Recognise the text in the pictures so the PDF can be searched and read "
                                           "(needs the OCR add-on)")] = True,
    languages: Annotated[str, Field(description='"eng,chi_sim" (both), "eng" or "chi_sim"')] = "eng,chi_sim",
    overwrite: OverwriteArg = False,
) -> str:
    """Make a PDF from photos or scans: one page per picture (every page of a
    multi-page TIFF), each page the size of its picture; JPEGs are kept as they
    are and a photo's orientation is respected. With ocr the text is recognised,
    so the other tools can read and search it."""
    if not images:
        raise ToolError("Give at least one picture")
    parts, sources = [], []
    for p in images:
        src = policy.readable(p, suffixes=IMAGE_SUFFIXES)
        sources.append(src)
        parts.append(("files", (src.name, src.read_bytes(), "application/octet-stream")))
    if output and output.strip():
        target = policy.writable(output, overwrite=overwrite, inputs=tuple(sources))
    else:
        first = sources[0]
        target, n = first.with_suffix(".pdf"), 2
        while target.exists() or target.is_symlink():
            target, n = first.with_name(f"{first.stem}-{n}.pdf"), n + 1
        target = policy.writable(policy.to_host(target))
    resp = await post("/from-images", files=parts, data={"ocr": ocr, "languages": languages}, timeout=1800.0)
    write_atomic(target, resp.content, overwrite=overwrite)
    info = await _page_info(target, resp.content)
    out = {"output": policy.to_host(target), "pages": info.get("pageCount"),
           "textRecognised": resp.headers.get("X-OCR") == "1"}
    if resp.headers.get("X-OCR-Note"):
        out["note"] = resp.headers["X-OCR-Note"]
    return _dump(out)


@tool(WRITE)
async def pdf_export(
    path: PathArg,
    format: Annotated[str, Field(description='"markdown" (a .md file) or "json" (the structure: blocks with '
                                             'kinds, pages, boxes, tables as rows)')] = "markdown",
    output_dir: OutputDirArg = "",
    pages: PagesArg = "",
    ocr: OcrArg = True,
    model: ModelArg = "auto",
    password: PasswordArg = "",
) -> str:
    """Save the PDF as Markdown or JSON in a new folder, together with its pictures
    (images/, with manifest.json): in the Markdown each figure that is a picture
    links to its file, and the text read in a picture follows it. Use it to keep a
    readable copy of a document with its pictures. Needs the document structure
    add-on."""
    src, data = _read(path)
    try:
        resp = await post("/export", files=_file(src, data),
                          data={"format": format, "pages": pages, "ocr": ocr, "model": model, "password": password},
                          timeout=1800.0)
    except EngineError as exc:
        if "structure component is not installed" in str(exc):
            raise EngineError(STRUCTURE_HINT) from exc
        raise
    folder = _output_dir(src, "markdown" if format == "markdown" else "json", output_dir)
    written = _unpack(resp.content, folder)
    main = next((n for n in written if "/" not in n), None)
    return _dump({"folder": policy.to_host(folder), "file": policy.to_host(folder / main) if main else None,
                  "pictures": sum(1 for n in written if n.startswith("images/") and not n.endswith((".json", ".txt")))})


# ---------------------------------------------------------------- pages


@tool(WRITE)
async def pdf_merge(
    paths: Annotated[list[str], Field(description="PDF files to join, in order (at least two)")],
    output: Annotated[str, Field(description="Absolute .pdf path for the merged file")],
    overwrite: OverwriteArg = False,
) -> str:
    """Join several PDFs into one, in the given order."""
    if len(paths) < 2:
        raise ToolError("Give at least two PDF files")
    parts, sources = [], []
    for p in paths:
        src, data = _read(p)
        sources.append(src)
        parts.append(("files", pdf_part(src.name, data)))
    target = policy.writable(output, overwrite=overwrite, inputs=tuple(sources))
    out = (await post("/merge", files=parts)).content
    write_atomic(target, out, overwrite=overwrite)
    info = await _page_info(target, out)
    return _dump({"output": policy.to_host(target), "pages": info.get("pageCount")})


@tool(WRITE)
async def pdf_extract_pages(
    path: PathArg,
    pages: Annotated[str, Field(description='Pages to copy into a new PDF, like "1-3,7"')],
    output: OutputArg = "",
    overwrite: OverwriteArg = False,
) -> str:
    """Copy some pages into a new PDF (the original is unchanged)."""
    src, data = _read(path)
    out = (await post("/split", files=_file(src, data), data={"pages": pages, "unify": True})).content
    return _dump({"output": _save(src, "pages", output, overwrite, out)})


@tool(WRITE)
async def pdf_select_pages(
    path: PathArg,
    order: Annotated[str, Field(description='The pages to keep, in their new order, like "3,1,2" or "1-4,6"; pages left out are dropped')],
    output: OutputArg = "",
    overwrite: OverwriteArg = False,
    password: PasswordArg = "",
) -> str:
    """Reorder or delete pages: give the pages to keep in the order you want them."""
    src, data = _read(path)
    numbers = _expand_pages(order, "order")
    out = (await post("/pages", files=_file(src, data), data={
        "order": ",".join(map(str, numbers)), "password": password,
    })).content
    return _dump({"output": _save(src, "reordered", output, overwrite, out), "pages": len(numbers)})


@tool(WRITE)
async def pdf_rotate_pages(
    path: PathArg,
    angle: Annotated[int, Field(description="Clockwise: 90, 180 or 270")] = 90,
    pages: PagesArg = "",
    output: OutputArg = "",
    overwrite: OverwriteArg = False,
    password: PasswordArg = "",
) -> str:
    """Rotate pages clockwise (all pages, or a range)."""
    src, data = _read(path)
    out = (await post("/rotate", files=_file(src, data), data={
        "angle": angle, "pages": pages, "password": password,
    })).content
    return _dump({"output": _save(src, "rotated", output, overwrite, out)})


@tool(WRITE)
async def pdf_flatten(
    path: PathArg,
    output: OutputArg = "",
    overwrite: OverwriteArg = False,
    password: PasswordArg = "",
) -> str:
    """Make form fields and annotations part of the page, so they can no longer be edited."""
    src, data = _read(path)
    out = (await post("/flatten", files=_file(src, data), data={"engine": "pdfbox", "password": password})).content
    return _dump({"output": _save(src, "flattened", output, overwrite, out)})


# ---------------------------------------------------------------- security


@tool(WRITE)
async def pdf_sign(
    path: PathArg,
    certificate: Annotated[str, Field(description="Absolute path of a .p12 or .pfx certificate with its private key")],
    certificate_password: str,
    output: OutputArg = "",
    reason: str = "",
    location: str = "",
    visible: Annotated[bool, Field(description="Show a signature box on the page")] = True,
    page: Annotated[int, Field(description="Page for the visible box; 0 = last page", ge=0)] = 0,
    x: Annotated[float | None, Field(description="Box left edge in points; empty = bottom-right corner")] = None,
    y: Annotated[float | None, Field(description="Box top edge in points from the top")] = None,
    width: float = 200,
    height: float = 60,
    timestamp_url: Annotated[str, Field(description="RFC 3161 timestamp server, e.g. http://timestamp.digicert.com (the only network call this engine can make)")] = "",
    overwrite: OverwriteArg = False,
    password: PasswordArg = "",
) -> str:
    """Digitally sign a PDF with a certificate (PAdES-style CMS signature), then
    verify the result. Any later change to the file will show as breaking it."""
    _check_timestamp_url(timestamp_url)
    src, data = _read(path)
    cert = policy.readable(certificate, suffixes=(".p12", ".pfx"))
    info = await _page_info(src, data, password)
    count = info.get("pageCount", 1)
    page_no = count if page == 0 else page
    if page_no > count:
        raise ToolError(f"Page {page_no} is outside the document (1-{count})")
    size = info["pages"][page_no - 1]
    bx = x if x is not None else max(0.0, size["width"] - 36 - width)
    by = y if y is not None else max(0.0, size["height"] - 36 - height)
    files = {**_file(src, data), "cert": (cert.name, cert.read_bytes(), "application/x-pkcs12")}
    out = (await post("/digital-sign", files=files, data={
        "cert_password": certificate_password, "reason": reason, "location": location,
        "visible": visible, "page_index": page_no - 1, "x": bx, "y": by, "width": width, "height": height,
        "tsa_url": timestamp_url, "password": password,
    }, timeout=120)).content
    check = _one_based_signatures((await post("/verify-signatures", files=_file(src, out),
                                              data={"password": password})).json())
    saved = _save(src, "signed", output, overwrite, out)
    return _dump({"output": saved, "verification": check})


@tool(WRITE)
async def pdf_create_certificate(
    name: Annotated[str, Field(description="Signer name shown in the signature")],
    password: Annotated[str, Field(description="Password protecting the certificate file (at least 4 characters)")],
    output: Annotated[str, Field(description="Absolute path for the new .p12 file")],
    email: str = "",
    organization: str = "",
    years: Annotated[int, Field(ge=1, le=10)] = 3,
    overwrite: OverwriteArg = False,
) -> str:
    """Create a self-signed signing certificate (.p12) for pdf_sign. Fine for internal
    use and tests; recipients will see the signer as unverified, unlike a certificate
    from a trusted authority."""
    target = policy.writable(output, overwrite=overwrite, suffixes=(".p12", ".pfx"))
    out = (await post("/generate-cert", data={
        "name": name, "email": email, "organization": organization, "cert_password": password, "years": years,
    })).content
    write_atomic(target, out, overwrite=overwrite)
    return _dump({"output": policy.to_host(target)})


@tool(WRITE)
async def pdf_encrypt(
    path: PathArg,
    password: Annotated[str, Field(description="Password needed to open the file")],
    output: OutputArg = "",
    overwrite: OverwriteArg = False,
) -> str:
    """Password-protect a PDF (AES-256)."""
    src, data = _read(path)
    out = (await post("/encrypt", files=_file(src, data), data={"user_password": password, "key_length": 256})).content
    return _dump({"output": _save(src, "encrypted", output, overwrite, out)})


@tool(WRITE)
async def pdf_decrypt(
    path: PathArg,
    password: Annotated[str, Field(description="The PDF's password")],
    output: OutputArg = "",
    overwrite: OverwriteArg = False,
) -> str:
    """Remove the password from a PDF you have the password for."""
    src, data = _read(path)
    out = (await post("/unlock", files=_file(src, data), data={"password": password})).content
    return _dump({"output": _save(src, "decrypted", output, overwrite, out)})


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(prog=SERVER_NAME)
    parser.add_argument("--transport", choices=["stdio", "http"], default="stdio")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    if args.transport == "http":
        mcp.settings.host = args.host
        mcp.settings.port = args.port
        mcp.run(transport="streamable-http")
    else:
        mcp.run()


if __name__ == "__main__":
    main()
