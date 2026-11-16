"""OpenPDF document structure service: PDF in, the document's structure out.

Docling finds what each block on a page is (title, heading, paragraph, list
item, table, figure, caption, page header or footer), puts the blocks in
reading order (columns one after the other) and reads the tables' rows and
columns. This service returns that as Markdown (what a language model reads
best) and as a list of elements with their page, box and section, so an agent
can quote a passage and point at it in the PDF.

Boxes are PDF points on the page as displayed, from the top-left corner: the
same units as the other services. OCR is not done here: pages without a text
layer are reported, and the caller OCRs them first with the OCR service.
Everything runs on the CPU, on this computer; the models are in the image.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import threading
import unicodedata
from collections import OrderedDict
from io import BytesIO

import httpx
import pypdfium2 as pdfium
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool

from app import vlm
from docling.utils.locks import pypdfium2_lock

log = logging.getLogger("openpdf.structure")
app = FastAPI(title="OpenPDF Document Structure Service", version="0.1.0")

PAGES_RE = re.compile(r"^\d+(-\d*)?(,\d+(-\d*)?)*$")
# Documents converted at the same time; more would only compete for the CPU.
_slots = threading.BoundedSemaphore(int(os.environ.get("OPENPDF_STRUCTURE_DOCS", "1")))
_converter = None
_converter_lock = threading.Lock()
# Recent results, so an agent reading a document part by part (outline first,
# then some pages) does not wait for the same conversion twice.
_cache: OrderedDict[tuple, dict] = OrderedDict()
_cache_lock = threading.Lock()
CACHE_SIZE = 6
# Options (environment): formulas read as LaTeX by Docling's formula model
# (slower; the model must be in OPENPDF_STRUCTURE_MODELS or downloadable),
# Docling's own OCR of bitmap areas, OpenPDF's reading-order fix, and the
# layout model (heron, heron-101, egret-medium, egret-large, egret-xlarge).
FORMULAS = os.environ.get("OPENPDF_STRUCTURE_FORMULAS", "0") == "1"
DOCLING_OCR = os.environ.get("OPENPDF_STRUCTURE_OCR", "0") == "1"
FIX_ORDER = os.environ.get("OPENPDF_STRUCTURE_FIX_ORDER", "1") == "1"
LAYOUT = os.environ.get("OPENPDF_STRUCTURE_LAYOUT", "heron")


def converter():
    global _converter
    with _converter_lock:
        if _converter is None:
            from docling.datamodel.base_models import InputFormat
            from docling.datamodel.pipeline_options import PdfPipelineOptions, TableFormerMode
            from docling.document_converter import DocumentConverter, PdfFormatOption

            opts = PdfPipelineOptions(do_ocr=DOCLING_OCR, do_table_structure=True)
            opts.table_structure_options.mode = TableFormerMode.ACCURATE
            opts.do_formula_enrichment = FORMULAS
            if LAYOUT != "heron":  # heron: Docling's default
                from docling.datamodel import layout_model_specs
                from docling.datamodel.pipeline_options import LayoutOptions
                spec = getattr(layout_model_specs, "DOCLING_LAYOUT_" + LAYOUT.upper().replace("-", "_"))
                opts.layout_options = LayoutOptions(model_spec=spec)
            models = os.environ.get("OPENPDF_STRUCTURE_MODELS")
            if models:
                opts.artifacts_path = models
            # More threads than 4 made the layout model slower in tests (they contend).
            opts.accelerator_options.num_threads = int(os.environ.get("OPENPDF_STRUCTURE_THREADS",
                                                                      min(4, os.cpu_count() or 4)))
            conv = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)})
            conv.initialize_pipeline(InputFormat.PDF)
            _converter = conv
        return _converter


@app.on_event("startup")
def _warm_up() -> None:
    # Load the models in the background so the first request doesn't wait.
    threading.Thread(target=converter, daemon=True).start()
    if vlm.enabled():
        threading.Thread(target=vlm.warm_up, daemon=True).start()


@app.get("/model")
def model_status():
    """Whether a document OCR model is configured and answering."""
    if not vlm.enabled():
        return {"configured": False}
    try:
        ok = httpx.get(f"{vlm.URL}/health", timeout=5).status_code == 200
    except httpx.HTTPError:
        ok = False
    return {"configured": True, "model": vlm.MODEL, "ready": ok}


@app.get("/health")
def health():
    return {"status": "ok"}


def _page_set(spec: str, count: int) -> list[int]:
    pages: set[int] = set()
    for part in spec.split(","):
        if "-" in part:
            a, b = part.split("-")
            first, last = int(a), int(b) if b else count
        else:
            first = last = int(part)
        if first < 1 or first > count or last < first:
            raise HTTPException(400, f"USER:Page {part} is outside the document ({count} pages)")
        pages.update(range(first, min(last, count) + 1))
    return sorted(pages)


def _page_facts(data: bytes) -> list[tuple[int, float, float, float]]:
    """Per page: characters in its text layer (0 = a scan: nothing to read without
    OCR), its size as displayed (rotation applied) and the share of its text that
    is not text (_junk_share)."""
    with pypdfium2_lock:  # PDFium is not thread-safe; Docling renders with it too
        pdf = pdfium.PdfDocument(data)
        try:
            facts = []
            for i in range(len(pdf)):
                page = pdf[i]
                w, h = page.get_size()
                if page.get_rotation() in (90, 270):
                    w, h = h, w
                text = page.get_textpage()
                facts.append((text.count_chars(), round(w, 1), round(h, 1), _junk_share(text.get_text_range())))
            return facts
        finally:
            pdf.close()


# Text that cannot be decoded (a font without a Unicode map): PDFium gives
# private-use or control characters, Docling (its own parser) the same, glyph
# codes as numbers ("104 69 80") or glyph names run together. Such a page is
# read again by OCR (the gateway), but only when both readers fail: Docling
# often decodes what PDFium cannot.
GARBLED_JUNK = 0.2      # PDFium: share of characters that are not text
GARBLED_WORDS = 0.4     # Docling: share of characters in word-like tokens
GARBLED_MIN_CHARS = 20
WORDLIKE = re.compile(r"[^\W\d_]{1,20}")
# Scripts written without spaces: a line is one token
UNSPACED = re.compile(r"[\u0e00-\u0e7f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]")
HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)
TOKEN_EDGE = "\"'()[]{}<>.,;:!?*_#|-–—“”‘’«»"


def _junk_share(text: str) -> float:
    chars = [c for c in text if not c.isspace()]
    if not chars:
        return 0.0
    return sum(c == "\ufffd" or unicodedata.category(c) in ("Co", "Cc", "Cn", "Cs") for c in chars) / len(chars)


def _garbled(markdown: str) -> bool:
    if _junk_share(markdown) > GARBLED_JUNK:
        return True
    total = words = 0
    for token in HTML_COMMENT.sub(" ", markdown).split():
        # combining marks (Indic vowel signs, Arabic vowels) are not letters to re
        core = "".join(c for c in token.strip(TOKEN_EDGE) if not unicodedata.category(c).startswith("M"))
        if not any(c.isalnum() for c in core):
            continue  # table rules, bullets, punctuation
        total += len(core)
        if WORDLIKE.fullmatch(core) or UNSPACED.search(core):
            words += len(core)
    return total >= GARBLED_MIN_CHARS and words < GARBLED_WORDS * total


# Strokes of a chart (axes, ticks, grid lines) that OCR reads as one of these
# Chinese characters; dropped when they stand alone in a picture without other Chinese.
LINE_ART = re.compile(r"(?<!\S)[一二十丨口田日]{1,2}(?!\S)")
CJK = re.compile(r"[\u3400-\u9fff]")


def _clean_picture_text(text: str) -> str:
    if CJK.search(LINE_ART.sub("", text)):
        return text
    lines = [" ".join(LINE_ART.sub("", line).split()) for line in text.split("\n")]
    return "\n".join(line for line in lines if line)


def _picture_text(data: bytes, boxes: dict[int, list[dict]]) -> dict[tuple[int, int], str]:
    """The text layer inside each picture's box (labels of a chart, or what OCR
    read in a photo or a scanned insert), by (page, index of the box on the page).
    Boxes are in points from the top-left of the page as displayed."""
    out: dict[tuple[int, int], str] = {}
    with pypdfium2_lock:  # PDFium is not thread-safe; Docling renders with it too
        pdf = pdfium.PdfDocument(data)
        try:
            for page_no, rects in boxes.items():
                page = pdf[page_no - 1]
                l, b, r, t = page.get_cropbox()
                rot = page.get_rotation()
                text = page.get_textpage()

                def shown(ux: float, uy: float) -> tuple[float, float]:
                    if rot == 90:
                        return uy - b, ux - l
                    if rot == 180:
                        return r - ux, uy - b
                    if rot == 270:
                        return t - uy, r - ux
                    return ux - l, t - uy

                hits = [[] for _ in rects]
                for i in range(text.count_chars()):
                    cl, cb, cr, ct = text.get_charbox(i)
                    x, y = shown((cl + cr) / 2, (cb + ct) / 2)
                    for k, rect in enumerate(rects):
                        if rect["x"] <= x <= rect["x"] + rect["width"] and rect["y"] <= y <= rect["y"] + rect["height"]:
                            if hits[k] and hits[k][-1][0] != i - 1:
                                hits[k].append((i, "\n"))
                            hits[k].append((i, text.get_text_range(i, 1)))
                for k, chars in enumerate(hits):
                    lines = [" ".join(line.split()) for line in "".join(c for _, c in chars).replace("\r", "\n").split("\n")]
                    joined = _clean_picture_text("\n".join(line for line in lines if line))
                    if joined:
                        out[(page_no, k)] = joined
        finally:
            pdf.close()
    return out


# A picture wholly in the top or bottom band of the page is a letterhead, logo or
# footer: its text is kept on the element but not quoted in the Markdown, which
# leaves running headers and footers out (on olmOCR-Bench quoting them cost 4.6
# points of the headers/footers checks).
MARGIN_BAND = 0.12


def _add_picture_text(data: bytes, elements: list[dict], markdown: dict[int, str],
                      heights: dict[int, float] | None = None) -> None:
    """Put the text read inside pictures into their elements ("text") and under
    the picture's place in the Markdown, as a quote (not for pictures in the
    page's top or bottom band)."""
    pictures: dict[int, list[dict]] = {}
    for el in elements:
        if el["type"] == "picture" and el.get("box"):
            pictures.setdefault(el["page"], []).append(el)
    if not pictures:
        return
    found = _picture_text(data, {p: [el["box"] for el in els] for p, els in pictures.items()})
    for page_no, els in pictures.items():
        parts = markdown.get(page_no, "").split("<!-- image -->")
        patch = len(parts) - 1 == len(els)
        if not patch:
            log.info("page %s: pictures and image marks differ; its Markdown is left as it is", page_no)
        rebuilt = parts[0]
        for k, el in enumerate(els):
            text = found.get((page_no, k))
            mark = "<!-- image -->"
            height = (heights or {}).get(page_no) or 0
            box = el["box"]
            in_margin = height > 0 and (box["y"] + box["height"] <= height * MARGIN_BAND
                                        or box["y"] >= height * (1 - MARGIN_BAND))
            if text:
                el["text"] = text
            if text and not in_margin:
                mark += "\n\n> *Text in the picture:*\n" + "\n".join("> " + line for line in text.split("\n"))
            if patch:
                rebuilt += mark + parts[k + 1]
        if patch:
            markdown[page_no] = rebuilt


def _box(prov, page) -> dict | None:
    """A Docling box as points from the top-left of the page as displayed."""
    if prov is None or page is None:
        return None
    bb = prov.bbox.to_top_left_origin(page_height=page.size.height)
    return {"x": round(bb.l, 1), "y": round(bb.t, 1), "width": round(bb.r - bb.l, 1), "height": round(bb.b - bb.t, 1)}


def _place(doc, node) -> tuple[int, float, float, float, float] | None:
    """Page and top-left box (x0, y0, x1, y1) of a block, or of everything in a group."""
    provs = list(getattr(node, "prov", None) or [])
    if not provs:
        for ref in getattr(node, "children", []) or []:
            child = ref.resolve(doc)
            provs.extend(getattr(child, "prov", None) or [])
    provs = [p for p in provs if doc.pages.get(p.page_no)]
    if not provs:
        return None
    page = provs[0].page_no
    boxes = [p.bbox.to_top_left_origin(page_height=doc.pages[page].size.height) for p in provs if p.page_no == page]
    return page, min(b.l for b in boxes), min(b.t for b in boxes), max(b.r for b in boxes), max(b.b for b in boxes)


def _above(a, b) -> bool:
    """Block a sits above block b in the same column: read first."""
    if a is None or b is None or a[0] != b[0] or a[4] > b[2] + 2:
        return False
    overlap = min(a[3], b[3]) - max(a[1], b[1])
    return overlap > 0.3 * min(a[3] - a[1], b[3] - b[1])


def _fix_order(doc) -> None:
    """Docling sometimes reads a centred title or heading after the text under it.
    When a block sits above one of the same column that was read earlier, move it
    back before the first block of its page that starts below it."""
    children = list(doc.body.children)
    places = [_place(doc, ref.resolve(doc)) for ref in children]
    i = 1
    while i < len(children):
        here = places[i]
        target = None
        if here and any(_above(here, places[j]) for j in range(i)):
            target = next(j for j in range(i) if places[j] and places[j][0] == here[0]
                          and places[j][2] >= here[4] - 2)
        if target is not None:
            children.insert(target, children.pop(i))
            places.insert(target, places.pop(i))
        i += 1
    doc.body.children = children


CN_NUM = "一二三四五六七八九十百"
# Numbering schemes: (family, depth) of a heading's number. Families rank in the
# order they first appear in the document: IEEE papers number sections "I." and
# subsections "A."; Chinese documents "一、" then "（一）".
SCHEMES = [
    (re.compile(r"^\s*(chapter|part|appendix|annex)\s+\w+", re.I), lambda m: ("chapter", 0)),
    (re.compile(rf"^\s*第[{CN_NUM}\d]+[章部篇]"), lambda m: ("chapter", 0)),
    (re.compile(rf"^\s*第[{CN_NUM}\d]+节"), lambda m: ("chapter", 1)),
    (re.compile(r"^\s*((?:\d{1,2}|[A-Z])(?:\.\d{1,3})+)\.?\s+\S"), lambda m: ("number", m.group(1).count("."))),
    (re.compile(r"^\s*(\d{1,2})\.?\s+\S"), lambda m: ("number", 0)),
    (re.compile(r"^\s*[IVXLC]+\.\s+\S"), lambda m: ("roman", 0)),
    (re.compile(r"^\s*[A-Z][.)]\s+\S"), lambda m: ("letter", 0)),
    (re.compile(rf"^\s*[{CN_NUM}]+[、.]"), lambda m: ("cn", 0)),
    (re.compile(rf"^\s*[（(][{CN_NUM}]+[）)]"), lambda m: ("cn-paren", 0)),
]


def _scheme(text: str) -> tuple[str, int] | None:
    for pattern, kind in SCHEMES:
        m = pattern.match(text)
        if m:
            return kind(m)
    return None


def _size_classes(sizes: list[float]) -> list[float]:
    """Distinct type sizes, largest first; sizes within about 12% are one size."""
    classes: list[float] = []
    for s in sorted(sizes, reverse=True):
        if not classes or s < classes[-1] * 0.88:
            classes.append(s)
    return classes


def _font_sizes(data: bytes, items) -> dict[int, float]:
    """Type size (points) of the first characters of each item, read from the PDF."""
    import pypdfium2.raw as raw

    sizes: dict[int, float] = {}
    with pypdfium2_lock:  # PDFium is not thread-safe; Docling renders with it too
        pdf = pdfium.PdfDocument(data)
        try:
            textpages: dict[int, object] = {}
            for item in items:
                prov = item.prov[0] if item.prov else None
                if prov is None or not 1 <= prov.page_no <= len(pdf):
                    continue
                if prov.page_no not in textpages:
                    textpages[prov.page_no] = pdf[prov.page_no - 1].get_textpage()
                tp = textpages[prov.page_no]
                page_h = pdf[prov.page_no - 1].get_size()[1]
                bb = prov.bbox.to_bottom_left_origin(page_height=page_h)
                # a point inside the first line, a little in from the top-left corner
                x = bb.l + min(4.0, (bb.r - bb.l) / 4)
                y = bb.t - min(4.0, (bb.t - bb.b) / 4)
                index = raw.FPDFText_GetCharIndexAtPos(tp.raw, x, y, 6.0, 6.0)
                if index >= 0:
                    size = raw.FPDFText_GetFontSize(tp.raw, index)
                    if size > 0:
                        sizes[id(item)] = round(size, 1)
        finally:
            pdf.close()
    return sizes


def _fix_headings(doc, data: bytes) -> None:
    """Docling marks headings but gives them all level 1. Take the level from the
    numbering ("1.2" is level 2, "A." under "I." is level 2), else from the size of
    the type compared with the numbered headings (or, with none, among the
    headings themselves). An unnumbered first heading at the top of the document
    becomes its title."""
    from docling_core.types.doc import SectionHeaderItem, TitleItem

    heads = [item for item, _ in doc.iterate_items() if isinstance(item, (SectionHeaderItem, TitleItem))]
    if not heads:
        return
    try:
        font = _font_sizes(data, heads)
    except Exception:  # noqa: BLE001 - sizes only refine the levels
        log.warning("could not read heading type sizes", exc_info=True)
        font = {}

    def size(h) -> float:
        return font.get(id(h)) or (h.prov[0].bbox.height * 0.8 if h.prov else 0.0)

    families: list[str] = []
    found: dict[int, tuple[str, int]] = {}
    last_letter = ""
    for h in heads:
        scheme = _scheme(h.text) if isinstance(h, SectionHeaderItem) else None
        mark = h.text.strip()[:1]
        if scheme and scheme[0] == "roman" and h.text.strip()[1:2] == "." and last_letter \
                and ord(mark) == ord(last_letter) + 1:
            scheme = ("letter", 0)  # "C." right after "B." is a letter, not 100
        if scheme and scheme[0] == "letter":
            last_letter = mark
        if scheme:
            found[id(h)] = scheme
            if scheme[0] not in families:
                families.append(scheme[0])
    if "chapter" in families:  # chapters outrank every other numbering
        families.remove("chapter")
        families.insert(0, "chapter")
    ranks = {key: families.index(family) + depth + 1 for key, (family, depth) in found.items()}
    by_rank: dict[int, list[float]] = {}
    for h in heads:
        if id(h) in ranks:
            by_rank.setdefault(ranks[id(h)], []).append(size(h))
    mean = {r: sum(v) / len(v) for r, v in by_rank.items()}
    first = heads[0]
    others = [size(h) for h in heads[1:]]
    title_like = (isinstance(first, SectionHeaderItem) and id(first) not in ranks and first.prov
                  and first.prov[0].page_no == 1 and not any(isinstance(h, TitleItem) for h in heads)
                  and (bool(ranks) or size(first) > 1.1 * max(others or [0])))
    classes = _size_classes([size(h) for h in heads if isinstance(h, SectionHeaderItem)
                             and not (h is first and title_like)])
    for h in heads:
        if not isinstance(h, SectionHeaderItem) or (h is first and title_like):
            continue
        rank = ranks.get(id(h))
        if rank is None:
            if mean:
                # the highest numbered level set in the same size, else the closest size
                same = [r for r, m in mean.items() if abs(m - size(h)) <= 0.12 * max(m, size(h))]
                rank = min(same) if same else min(mean, key=lambda r: (abs(mean[r] - size(h)), r))
            else:
                rank = next(i for i, c in enumerate(classes, 1) if size(h) >= c * 0.88)
        h.level = max(1, min(rank, 6))
    if title_like:
        doc.insert_title(sibling=first, text=first.text, orig=first.orig, prov=first.prov[0], after=False)
        doc.delete_items(node_items=[first])


def _table_rows(item) -> tuple[list[list[str]], int]:
    rows = [[cell.text for cell in row] for row in item.data.grid]
    header = 0
    for row in item.data.grid:
        if row and all(cell.column_header for cell in row):
            header += 1
        else:
            break
    return rows, header


def _structure(doc, wanted: list[int]) -> tuple[list[dict], list[dict], dict[int, str]]:
    from docling_core.types.doc import DocItemLabel, ListItem, PictureItem, SectionHeaderItem, TableItem, TitleItem

    keep = set(wanted)
    elements: list[dict] = []
    outline: list[dict] = []
    path: list[tuple[int, str]] = []  # (level, heading) of the section being read
    for item, _depth in doc.iterate_items():
        if item.label in (DocItemLabel.PAGE_HEADER, DocItemLabel.PAGE_FOOTER):
            continue
        prov = item.prov[0] if getattr(item, "prov", None) else None
        page_no = prov.page_no if prov else None
        heading = None
        if isinstance(item, TitleItem):
            heading = 0
        elif isinstance(item, SectionHeaderItem):
            heading = max(1, item.level)
        if heading is not None:
            text = item.text.strip()
            while path and path[-1][0] >= heading:
                path.pop()
            path.append((heading, text))
            if page_no in keep:
                outline.append({"level": heading, "title": text, "page": page_no, "element": f"e{len(elements) + 1}"})
        if page_no not in keep:
            continue
        el: dict = {"id": f"e{len(elements) + 1}", "type": str(item.label.value), "page": page_no}
        box = _box(prov, doc.pages.get(page_no))
        if box:
            el["box"] = box
        if heading is not None:
            el["level"] = heading
            el["section"] = [h for _, h in path[:-1]]
        else:
            el["section"] = [h for _, h in path]
        if isinstance(item, TableItem):
            rows, header = _table_rows(item)
            el["rows"] = rows
            el["headerRows"] = header
            caption = item.caption_text(doc)
            if caption:
                el["caption"] = caption
        elif isinstance(item, PictureItem):
            caption = item.caption_text(doc)
            if caption:
                el["caption"] = caption
        else:
            el["text"] = getattr(item, "text", "")
            if isinstance(item, ListItem):
                el["marker"] = item.marker
        elements.append(el)
    markdown = {p: doc.export_to_markdown(page_no=p) for p in wanted}
    return elements, outline, markdown


def _convert(data: bytes, filename: str, spec: str, picture_text: bool = False, model: bool = False,
             scan_pages: frozenset = frozenset()) -> dict:
    from docling.datamodel.base_models import DocumentStream

    try:
        facts = _page_facts(data)
    except pdfium.PdfiumError as exc:
        msg = str(exc).lower()
        if "password" in msg:
            raise HTTPException(422, "The PDF is encrypted, or the password is wrong") from exc
        raise HTTPException(422, "USER:Cannot read this PDF: the file may be damaged or not a PDF") from exc
    chars = [f[0] for f in facts]
    count = len(facts)
    wanted = _page_set(spec, count) if spec else list(range(1, count + 1))
    first, last = wanted[0], wanted[-1]
    key = (hashlib.sha256(data).hexdigest(), first, last)
    with _cache_lock:
        doc = _cache.get(key)
        if doc is not None:
            _cache.move_to_end(key)
    if doc is None:
        with _slots:
            result = converter().convert(DocumentStream(name=filename or "document.pdf", stream=BytesIO(data)),
                                         page_range=(first, last), raises_on_error=False)
        if result.document is None or not result.document.pages and any(chars[p - 1] for p in wanted):
            errors = "; ".join(e.error_message for e in (result.errors or []))
            log.warning("conversion failed: %s %s", result.status, errors[:800])
            raise HTTPException(500, f"Conversion failed: {errors or result.status}"[:2000])
        doc = result.document
        if FIX_ORDER:
            _fix_order(doc)
        _fix_headings(doc, data)
        with _cache_lock:
            _cache[key] = doc
            while len(_cache) > CACHE_SIZE:
                _cache.popitem(last=False)

    elements, outline, markdown = _structure(doc, wanted)
    garbled = [p for p in wanted if chars[p - 1] >= GARBLED_MIN_CHARS and facts[p - 1][3] > GARBLED_JUNK
               and _garbled(markdown[p])]
    if picture_text:
        _add_picture_text(data, elements, markdown, {p: facts[p - 1][2] for p in wanted})
    model_stats = vlm.enhance(data, elements, markdown, scan_pages=scan_pages) if model and vlm.enabled() else None
    pages = [{"page": p, "width": facts[p - 1][1], "height": facts[p - 1][2], "textChars": chars[p - 1],
              "markdown": markdown[p]} for p in wanted]
    return {
        "pageCount": count,
        "pages": pages,
        "pagesWithoutText": [p for p in wanted if chars[p - 1] == 0],
        "garbledPages": garbled,
        "outline": outline,
        "elements": elements,
        **({"model": model_stats} if model_stats is not None else {}),
    }


@app.post("/convert")
async def convert(file: UploadFile = File(...), pages: str = Form(""), picture_text: str = Form("false", alias="pictureText"),
                  model: str = Form("false"), scan_pages: str = Form("", alias="scanPages")):
    """pictureText=true: add the text inside pictures (a chart's labels, what OCR
    read in a photo) to their elements and to the Markdown. model=true: read the
    tables and formulas again with the document OCR model (app/vlm.py), when one
    is configured; scanPages (1-based, comma-separated): pages that were scans
    before OCR, whose text the model reads again too."""
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty PDF file")
    spec = pages.replace(" ", "")
    if spec and not PAGES_RE.match(spec):
        raise HTTPException(400, "USER:Invalid page range; use a form like 1-3,5,8-")
    try:
        return await run_in_threadpool(_convert, data, file.filename or "document.pdf", spec,
                                       picture_text.lower() == "true", model.lower() == "true",
                                       frozenset(int(p) for p in scan_pages.split(",") if p.strip().isdigit()))
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        log.exception("structure failed")
        raise HTTPException(500, f"Conversion failed: {exc}"[:2000]) from exc
