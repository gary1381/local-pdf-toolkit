"""Reading tables, formulas and charts again with a document OCR model.

Docling finds the blocks of a page and reads ordinary text exactly from the
PDF; where it is weak (tables in scans or without rules, formulas, which it
leaves out, the numbers of a chart) a small vision-language OCR model reads
the block's picture instead: PaddleOCR-VL 1.6 or GLM-OCR (0.9B each), served
by llama.cpp's llama-server (OpenAI-style chat API with images), on CPU or GPU.

Each block keeps the page and box Docling gave it, so quotes can still be
located. A table the model reads is kept only when its words are found in the
page's text layer (the PDF's own text, or the OCR layer of a scan) well
enough; otherwise Docling's reading stays: a model can invent cells, the PDF
cannot.

OPENPDF_VLM_URL     the model server (e.g. http://127.0.0.1:28400); unset: off
OPENPDF_VLM_MODEL   paddleocr-vl (default), glm-ocr or unlimited-ocr: their prompts
                    and outputs (services/model/catalog.json's "profile")
"""
from __future__ import annotations

import base64
import html
import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO

import httpx
import pypdfium2 as pdfium
from docling.utils.locks import pypdfium2_lock

log = logging.getLogger("openpdf.structure.vlm")

URL = os.environ.get("OPENPDF_VLM_URL", "").rstrip("/")
MODEL = os.environ.get("OPENPDF_VLM_MODEL", "paddleocr-vl")
PROMPTS = {
    "paddleocr-vl": {"table": "Table Recognition:", "formula": "Formula Recognition:", "chart": "Chart Recognition:",
                     "text": "OCR:"},
    "glm-ocr": {"table": "Table Recognition:", "formula": "Formula Recognition:", "chart": "Table Recognition:",
                "text": "Text Recognition:"},
}
# Models that read a whole page at once (and say where each block is): asked
# once per page, their blocks matched to Docling's by position.
PAGE_PROMPTS = {"unlimited-ocr": "document parsing."}
PAGE_SIDE = 1600  # longest side of the page picture, pixels
DPI = 200
PAD = 4  # points around a block
MIN_WORD_MATCH = 0.5  # share of a table's words that must be in the text layer
TIMEOUT = float(os.environ.get("OPENPDF_VLM_TIMEOUT", "120"))
WORKERS = int(os.environ.get("OPENPDF_VLM_WORKERS", "2"))


def enabled() -> bool:
    return bool(URL)


def _crop(pdf: pdfium.PdfDocument, page_no: int, box: dict, pages: dict) -> bytes:
    """The block as PNG, rendered as displayed (rotation applied); `pages` keeps
    each rendered page for the next block on it."""
    scale = DPI / 72
    if page_no not in pages:
        pages[page_no] = pdf[page_no - 1].render(scale=scale, may_draw_forms=True).to_pil()
    image = pages[page_no]
    x0 = max(0, (box["x"] - PAD) * scale)
    y0 = max(0, (box["y"] - PAD) * scale)
    x1 = min(image.width, (box["x"] + box["width"] + PAD) * scale)
    y1 = min(image.height, (box["y"] + box["height"] + PAD) * scale)
    buf = BytesIO()
    image.crop((int(x0), int(y0), int(x1), int(y1))).save(buf, format="PNG")
    return buf.getvalue()


def _page_png(pdf: pdfium.PdfDocument, page_no: int) -> tuple[bytes, float, float]:
    """The whole page as PNG, and its displayed size in points."""
    page = pdf[page_no - 1]
    w, h = page.get_size()
    if page.get_rotation() in (90, 270):
        w, h = h, w
    image = page.render(scale=PAGE_SIDE / max(w, h), may_draw_forms=True).to_pil()
    buf = BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue(), w, h


# "<|det|>table [x1, y1, x2, y2]<|/det|>..." (the marks are special tokens: without
# llama-server's --special they come back as "table [x1, y1, x2, y2]...")
DET = re.compile(r"(?:<\|det\|>)?\b(title|sub_title|text|table|image|figure|equation|formula|header|footer|caption|"
                 r"table_caption|image_caption|footnote|list|code|page_number|\w+)\s*\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]"
                 r"(?:<\|/det\|>)?(.*?)(?=(?:<\|det\|>)?\b\w+\s*\[\d+,\s*\d+,\s*\d+,\s*\d+\]|\Z)", re.S)
END_TOKENS = re.compile(r"<[｜|][^<>]{0,40}[｜|]>")


def page_blocks(text: str, width: float, height: float) -> list[dict]:
    """A whole-page reading with <|det|>label [x1, y1, x2, y2]<|/det|> marks (coordinates
    0-999 of the page) as blocks with boxes in points from the top-left."""
    blocks = []
    for label, x1, y1, x2, y2, body in DET.findall(END_TOKENS.sub(lambda m: "" if "det" not in m.group(0) else m.group(0), text)):
        x1, y1, x2, y2 = (int(v) / 999 for v in (x1, y1, x2, y2))
        blocks.append({"label": label.lower(), "text": body.strip(),
                       "box": {"x": x1 * width, "y": y1 * height, "width": (x2 - x1) * width,
                               "height": (y2 - y1) * height}})
    return blocks


def _iou(a: dict, b: dict) -> float:
    w = min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"])
    h = min(a["y"] + a["height"], b["y"] + b["height"]) - max(a["y"], b["y"])
    inter = max(0.0, w) * max(0.0, h)
    union = a["width"] * a["height"] + b["width"] * b["height"] - inter
    return inter / union if union > 0 else 0.0


def match_blocks(jobs: list[dict], blocks: list[dict]) -> dict[int, str]:
    """For each element, the text of the page block in its place: a table only from a
    table block, the others from any block but a table or picture; each block used once."""
    out: dict[int, str] = {}
    used: set[int] = set()
    for el in sorted(jobs, key=lambda e: -e["box"]["width"] * e["box"]["height"]):
        best, score = None, 0.3
        for i, b in enumerate(blocks):
            if i in used:
                continue
            fits = b["label"] == "table" if el["type"] == "table" else b["label"] not in ("table", "image", "figure")
            if fits and _iou(el["box"], b["box"]) > score:
                best, score = i, _iou(el["box"], b["box"])
        if best is not None:
            used.add(best)
            out[id(el)] = blocks[best]["text"]
    return out


_marker: list[str] = []


def _ask_page(png: bytes, prompt: str) -> str:
    """A whole-page model through llama-server's raw /completion: its chat template
    (deepseek-ocr) adds nothing, and the chat endpoint loses the picture's place."""
    if not _marker:
        _marker.append(httpx.get(f"{URL}/props", timeout=TIMEOUT).json().get("media_marker", "<__media__>"))
    body = {"prompt": {"prompt_string": _marker[0] + prompt, "multimodal_data": [base64.b64encode(png).decode()]},
            "temperature": 0, "n_predict": 8192}
    r = httpx.post(f"{URL}/completion", json=body, timeout=TIMEOUT)
    r.raise_for_status()
    return r.json().get("content") or ""


def _ask(png: bytes, prompt: str) -> str:
    body = {
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(png).decode()}},
            {"type": "text", "text": prompt},
        ]}],
        "temperature": 0,
        "max_tokens": 8192 if MODEL in PAGE_PROMPTS else 4096,
    }
    r = httpx.post(f"{URL}/v1/chat/completions", json=body, timeout=TIMEOUT)
    r.raise_for_status()
    return (r.json()["choices"][0]["message"].get("content") or "").strip()


def warm_up(wait_seconds: int = 600) -> None:
    """Once the model server answers, send it one small picture: a GPU backend
    (Vulkan) compiles its programs on the first request, which would otherwise
    make the first real table wait 10-15 s."""
    import time

    from PIL import Image

    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        try:
            if httpx.get(f"{URL}/health", timeout=5).status_code == 200:
                break
        except httpx.HTTPError:
            pass
        time.sleep(2)
    else:
        return
    buf = BytesIO()
    Image.new("RGB", (96, 48), "white").save(buf, format="PNG")
    try:
        if MODEL in PAGE_PROMPTS:
            _ask_page(buf.getvalue(), PAGE_PROMPTS[MODEL])
        else:
            _ask(buf.getvalue(), PROMPTS.get(MODEL, PROMPTS["paddleocr-vl"])["formula"])
        log.info("reading model warmed up")
    except Exception as exc:  # noqa: BLE001 - only a head start
        log.info("warm-up skipped: %s", exc)


# ---------------------------------------------------------------- tables

OTSL = re.compile(r"<(fcel|ecel|lcel|ucel|xcel|nl)>")


def otsl_rows(text: str) -> list[list[str]]:
    """PaddleOCR-VL's table tokens (OTSL) as rows of cells; a spanned cell repeats
    its text in every cell it covers, as Docling's rows do."""
    rows: list[list[str]] = []
    row: list[str] = []
    parts = OTSL.split(text)
    i = 1
    while i < len(parts):
        tag, content = parts[i], parts[i + 1] if i + 1 < len(parts) else ""
        i += 2
        if tag == "nl":
            if row:
                rows.append(row)
            row = []
            continue
        cell = " ".join(content.replace("\\n", " ").split())
        if tag == "lcel" and row:
            cell = row[-1]
        elif tag in ("ucel", "xcel") and rows and len(rows[-1]) > len(row):
            cell = rows[-1][len(row)]
        row.append(cell)
    if row:
        rows.append(row)
    width = max((len(r) for r in rows), default=0)
    return [r + [""] * (width - len(r)) for r in rows]


def html_rows(text: str) -> list[list[str]]:
    """An HTML table (GLM-OCR) as rows of cells, spans repeated."""
    rows: list[list[str]] = []
    pending: dict[int, tuple[str, int]] = {}  # column -> (text, rows left) from rowspan
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", text, re.S | re.I):
        row: list[str] = []
        col = 0
        for m in re.finditer(r"<t([dh])([^>]*)>(.*?)</t[dh]>", tr, re.S | re.I):
            while col in pending:
                t, left = pending[col]
                row.append(t)
                pending[col] = (t, left - 1)
                if left - 1 <= 0:
                    del pending[col]
                col += 1
            attrs, inner = m.group(2), m.group(3)
            cell = " ".join(html.unescape(re.sub(r"<[^>]+>", " ", inner)).split())
            cs = int((re.search(r"colspan=\"?(\d+)", attrs) or [0, 1])[1])
            rs = int((re.search(r"rowspan=\"?(\d+)", attrs) or [0, 1])[1])
            for _ in range(cs):
                row.append(cell)
                if rs > 1:
                    pending[col] = (cell, rs - 1)
                col += 1
        while col in pending:
            t, left = pending[col]
            row.append(t)
            pending[col] = (t, left - 1)
            if left - 1 <= 0:
                del pending[col]
            col += 1
        rows.append(row)
    width = max((len(r) for r in rows), default=0)
    return [r + [""] * (width - len(r)) for r in rows]


def markdown_rows(text: str) -> list[list[str]]:
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("|") and not re.fullmatch(r"\|[\s:|-]+\|?", line):
            rows.append([c.strip() for c in line.strip("|").split("|")])
    width = max((len(r) for r in rows), default=0)
    return [r + [""] * (width - len(r)) for r in rows]


def table_rows(text: str) -> list[list[str]]:
    if OTSL.search(text):
        return otsl_rows(text)
    if "<tr" in text.lower():
        return html_rows(text)
    return markdown_rows(text)


def table_markdown(rows: list[list[str]]) -> str:
    if not rows:
        return ""
    esc = [[c.replace("|", "\\|") for c in r] for r in rows]
    lines = ["| " + " | ".join(esc[0]) + " |", "|" + "---|" * len(esc[0])]
    lines += ["| " + " | ".join(r) + " |" for r in esc[1:]]
    return "\n".join(lines)


WORD = re.compile(r"\w+", re.U)


def words_found(rows: list[list[str]], layer: str) -> float:
    """Share of the table's words that the page's text layer has inside the block."""
    words = [w.casefold() for r in rows for c in r for w in WORD.findall(c)]
    if not words:
        return 0.0
    have = {w.casefold() for w in WORD.findall(layer)}
    return sum(1 for w in words if w in have) / len(words)


# ---------------------------------------------------------------- formulas


def latex(text: str) -> str:
    t = text.strip()
    for a, b in (("\\[", "\\]"), ("$$", "$$"), ("\\(", "\\)"), ("$", "$")):
        if t.startswith(a) and t.endswith(b) and len(t) > len(a) + len(b):
            t = t[len(a):-len(b)].strip()
            break
    return t


# ---------------------------------------------------------------- paragraphs with mathematics

# Characters that only mathematics puts in running text: Greek letters, operators,
# relations, arrows, sub/superscript digits. A paragraph with a few of them is read
# again so its inline formulas come out as LaTeX ($...$).
MATH_CHARS = re.compile(r"[\u0391-\u03a9\u03b1-\u03c9\u2200-\u22ff\u2190-\u21ff\u2070-\u209f\u27c0-\u27ef\u2980-\u29ff"
                        r"\U0001d400-\U0001d7ffµ±×÷∞≈≠≤≥]")
# variables with a digit subscript (L2, f1) and equations between terms (a = b)
MATH_TOKENS = re.compile(r"(?<![\w.])[A-Za-z]\d{1,2}(?![\w.])|\w\s[=<>]\s\w")
MIN_MATH_CHARS = 2


def has_math(text: str) -> bool:
    text = text or ""
    return len(MATH_CHARS.findall(text)) + len(MATH_TOKENS.findall(text)) >= MIN_MATH_CHARS


def dollar_math(text: str) -> str:
    """\\( \\) and \\[ \\] as $ $ and $$ $$, the form Markdown readers know."""
    text = re.sub(r"\\\[(.+?)\\\]", lambda m: "$$" + m.group(1).strip() + "$$", text, flags=re.S)
    return re.sub(r"\\\((.+?)\\\)", lambda m: "$" + m.group(1).strip() + "$", text, flags=re.S)


def plain_words(text: str) -> list[str]:
    """The words of a model's reading outside its LaTeX, to check against the PDF."""
    outside = re.sub(r"\$\$.*?\$\$|\$[^$]*\$|\\\(.*?\\\)|\\\[.*?\\\]", " ", text, flags=re.S)
    return [w.casefold() for w in WORD.findall(outside) if len(w) > 2]


ALIGNED = re.compile(r"^\\begin\{(align\*?|aligned|gather\*?|gathered|eqnarray\*?)\}(.*)\\end\{\1\}$", re.S)


def formula_lines(tex: str) -> list[str]:
    """A block of aligned equations as one formula per line (a reader, and a search,
    looks for one equation at a time); other formulas as they are."""
    m = ALIGNED.match(tex.strip())
    if not m:
        return [tex]
    lines = [" ".join(line.replace("&", " ").split()) for line in re.split(r"\\\\(?:\[[^\]]*\])?", m.group(2))]
    lines = [line for line in lines if line]
    return lines or [tex]


# ---------------------------------------------------------------- the pass


def _layer_text(pdf: pdfium.PdfDocument, page_no: int, box: dict) -> str:
    page = pdf[page_no - 1]
    rot = page.get_rotation()
    l, b, r, t = page.get_cropbox()
    # displayed top-left box -> PDF user space (as structure's _picture_text, the other way round)
    x0, y0, x1, y1 = box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]
    if rot == 90:
        rect = (l + y0, b + x0, l + y1, b + x1)
    elif rot == 180:
        rect = (r - x1, b + y0, r - x0, b + y1)
    elif rot == 270:
        rect = (r - y1, t - x1, r - y0, t - x0)
    else:
        rect = (l + x0, t - y1, l + x1, t - y0)
    return page.get_textpage().get_text_bounded(*rect)


TEXT_KINDS = ("text", "list_item", "section_header", "title", "caption", "footnote")


def enhance(data: bytes, elements: list[dict], markdown: dict[int, str], kinds=("table", "formula"),
            scan_pages: set[int] | frozenset = frozenset()) -> dict:
    """Read the tables and formulas of `elements` with the model, and the paragraphs
    with mathematics in them, and put the results into the elements (rows / text,
    "readBy": "model") and the per-page Markdown. On `scan_pages` (pages that had
    no text layer before OCR) every block of text is read again: the model reads
    scans better than the OCR layer it would otherwise keep. Returns counts of what
    was read and kept."""
    def wanted(el):
        if el["type"] in kinds:
            return True
        if el["type"] in TEXT_KINDS and el["page"] in scan_pages:
            return True
        return el["type"] in ("text", "list_item") and has_math(el.get("text", ""))

    jobs = [el for el in elements if el.get("box") and wanted(el)]
    stats = {"tables": 0, "tablesKept": 0, "formulas": 0, "paragraphs": 0, "paragraphsKept": 0, "failed": 0}
    if not jobs:
        return stats
    prompts = PROMPTS.get(MODEL, PROMPTS["paddleocr-vl"])
    # PDFium is not thread-safe: pictures and text layers are read under the lock
    # Docling's renderer uses too, the model is asked outside it
    with pypdfium2_lock:
        pdf = pdfium.PdfDocument(data)
        try:
            rendered: dict = {}
            page_mode = MODEL in PAGE_PROMPTS
            if page_mode:
                pages = {n: _page_png(pdf, n) for n in sorted({el["page"] for el in jobs})}
                crops = []
            else:
                crops = [(el, _crop(pdf, el["page"], el["box"], rendered)) for el in jobs]
            layers = {id(el): _layer_text(pdf, el["page"], el["box"]) for el in jobs if el["type"] != "formula"}
        finally:
            pdf.close()
            rendered.clear()
    def run(item):
        el, png = item
        try:
            kind = el["type"] if el["type"] in ("table", "formula") else "text"
            return el, _ask(png, prompts[kind])
        except Exception as exc:  # noqa: BLE001 - the block keeps Docling's reading
            log.warning("model failed on page %s %s: %s", el["page"], el["type"], exc)
            return el, None

    if page_mode:
        answers = []
        for n, (png, width, height) in pages.items():
            try:
                blocks = page_blocks(_ask_page(png, PAGE_PROMPTS[MODEL]), width, height)
            except Exception as exc:  # noqa: BLE001 - the page keeps Docling's reading
                log.warning("model failed on page %s: %s", n, exc)
                blocks = []
            found = match_blocks([el for el in jobs if el["page"] == n], blocks)
            answers += [(el, found.get(id(el))) for el in jobs if el["page"] == n]
    else:
        with ThreadPoolExecutor(WORKERS) as pool:
            answers = list(pool.map(run, crops))
    for el, answer in answers:
        if answer is None:
            stats["failed"] += 1
            continue
        if el["type"] == "table":
            rows = table_rows(answer)
            stats["tables"] += 1
            # on a scan the text layer is OCR, only roughly right: a looser check
            need = 0.4 if el["page"] in scan_pages else MIN_WORD_MATCH
            if rows and words_found(rows, layers.get(id(el), "")) >= need:
                el["rows"], el["readBy"] = rows, "model"
                stats["tablesKept"] += 1
        elif el["type"] in TEXT_KINDS:
            stats["paragraphs"] += 1
            words = plain_words(answer)
            have = {w.casefold() for w in WORD.findall(layers.get(id(el), ""))}
            answer = dollar_math(answer)
            scan = el["page"] in scan_pages
            # a scan's OCR layer is only roughly right: a looser check, and plain text is worth taking
            need = 0.4 if scan else 0.7
            if words and (scan or "$" in answer) and sum(1 for w in words if w in have) / len(words) >= need:
                el["original"], el["text"], el["readBy"] = el.get("text", ""), " ".join(answer.split()), "model"
                stats["paragraphsKept"] += 1
        elif el["type"] == "formula":
            tex = latex(answer)
            if tex:
                el["text"], el["latex"], el["readBy"] = tex, True, "model"
                stats["formulas"] += 1
    _patch_markdown(elements, markdown)
    return stats


TABLE_BLOCK = re.compile(r"(?:^\|.*\|[ \t]*\n?)+", re.M)
FORMULA_MARK = "<!-- formula-not-decoded -->"


def _patch_markdown(elements: list[dict], markdown: dict[int, str]) -> None:
    """Swap the model's tables and formulas into each page's Markdown, in order,
    when the page has as many Markdown tables / formula marks as elements."""
    by_page: dict[int, dict[str, list[dict]]] = {}
    for el in elements:
        if el["type"] in ("table", "formula"):
            by_page.setdefault(el["page"], {}).setdefault(el["type"], []).append(el)
    for page_no, groups in by_page.items():
        md = markdown.get(page_no, "")
        tables = groups.get("table", [])
        blocks = list(TABLE_BLOCK.finditer(md))
        if tables and len(blocks) == len(tables):
            out, last = [], 0
            for m, el in zip(blocks, tables):
                out.append(md[last:m.start()])
                out.append(table_markdown(el["rows"]) + "\n" if el.get("readBy") == "model" else m.group(0))
                last = m.end()
            md = "".join(out) + md[last:]
        formulas = groups.get("formula", [])
        if formulas and md.count(FORMULA_MARK) == len(formulas):
            parts = md.split(FORMULA_MARK)
            md = parts[0] + "".join(
                ("\n\n".join(f"$$\n{line}\n$$" for line in formula_lines(el["text"]))
                 if el.get("readBy") == "model" else FORMULA_MARK) + rest
                for el, rest in zip(formulas, parts[1:]))
        markdown[page_no] = md
    for el in elements:
        if el.get("readBy") == "model" and el["type"] in TEXT_KINDS:
            md = markdown.get(el["page"], "")
            for old in (el["original"], el["original"].replace("_", "\\_")):
                if old and md.count(old) == 1:
                    markdown[el["page"]] = md.replace(old, el["text"])
                    break
