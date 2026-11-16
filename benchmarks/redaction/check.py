"""Looks for what a redacted PDF still gives away, with tools independent of
the ones under test.

A secret counts as left in the file when any of these finds it:
  - text extraction: poppler (pdftotext), pdfminer.six, pypdf
  - every object of the file, streams decompressed: page content, form
    XObjects, annotations, bookmarks, form fields, document properties, XMP,
    attached files; reported by where it was found
  - OCR (RapidOCR) of every picture in the file, so pixels left under a box
    count too

Matching ignores case, spaces and punctuation ("078 05 1120" is the same as
"078-05-1120"); in page content only the text strings are searched. A secret
counts as partly left when a long piece of it (60 %, at least 5 characters)
can still be read. The words that should survive are looked for in the same
extracted text and OCR.
"""
import io
import re
import subprocess
import unicodedata
from pathlib import Path

import pikepdf
from pikepdf import Dictionary, Array, Name, Stream, String

ANNOT_TYPES = {"/Text", "/FreeText", "/Link", "/Highlight", "/Square", "/Redact", "/Stamp", "/Ink", "/Popup", "/Widget",
               "/Underline", "/StrikeOut", "/Squiggly", "/Caret", "/FileAttachment", "/Line", "/Polygon", "/PolyLine", "/Circle"}
_ocr = None


def norm(s):
    s = unicodedata.normalize("NFKC", s).lower()
    return "".join(ch for ch in s if ch.isalnum())


def squeeze(s):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", s).lower())


def ocr_engine():
    global _ocr
    if _ocr is None:
        from rapidocr_onnxruntime import RapidOCR
        _ocr = RapidOCR()
    return _ocr


# --------------------------------------------------------------- text tools

def poppler_text(path):
    r = subprocess.run(["pdftotext", "-q", str(path), "-"], capture_output=True, timeout=120)
    return r.stdout.decode("utf-8", "replace")


def pdfminer_text(path):
    from pdfminer.high_level import extract_text
    return extract_text(str(path))


def pypdf_text(path):
    from pypdf import PdfReader
    return "\n".join(p.extract_text() or "" for p in PdfReader(str(path)).pages)


TEXT_TOOLS = {"poppler": poppler_text, "pdfminer": pdfminer_text, "pypdf": pypdf_text}


# ------------------------------------------------------------- the objects

def _strings(obj, out, depth=0):
    if depth > 40:
        return
    if isinstance(obj, String):
        out.append(str(obj))
    elif isinstance(obj, (Dictionary, Stream)):
        for k in obj.keys():
            v = obj.get(k)
            if isinstance(v, (Dictionary, Array, String)) and not getattr(v, "is_indirect", False):
                _strings(v, out, depth + 1)
    elif isinstance(obj, Array):
        for v in obj:
            if isinstance(v, (Dictionary, Array, String)) and not getattr(v, "is_indirect", False):
                _strings(v, out, depth + 1)


def _kinds(pdf):
    """What each indirect object is, by how the document uses it."""
    kinds = {}

    def mark(obj, kind):
        if isinstance(obj, (Dictionary, Stream, Array)) and getattr(obj, "is_indirect", False):
            kinds.setdefault(obj.objgen, kind)

    info = pdf.trailer.get("/Info")
    if info is not None:
        mark(info, "document properties")
    root = pdf.Root
    if "/Metadata" in root:
        mark(root.Metadata, "XMP metadata")
    seen = set()

    def walk_xobjects(res, kind):
        if not isinstance(res, Dictionary):
            return
        for xo in (res.get("/XObject") or {}).values() if isinstance(res.get("/XObject"), Dictionary) else []:
            if getattr(xo, "is_indirect", False) and xo.objgen in seen:
                continue
            if getattr(xo, "is_indirect", False):
                seen.add(xo.objgen)
            if xo.get("/Subtype") == Name.Form:
                mark(xo, kind)
                walk_xobjects(xo.get("/Resources"), kind)

    for page in pdf.pages:
        contents = page.obj.get("/Contents")
        for c in (contents if isinstance(contents, Array) else [contents] if contents is not None else []):
            mark(c, "page content")
        walk_xobjects(page.obj.get("/Resources"), "page content (form XObject)")
        for a in page.obj.get("/Annots") or []:
            # a form field and its widget are often one dictionary
            mark(a, "form field" if "/FT" in a or "/Parent" in a else "annotation")
            ap = a.get("/AP")
            if isinstance(ap, Dictionary):
                for v in ap.values():
                    for s in (v.values() if isinstance(v, Dictionary) else [v]):
                        mark(s, "annotation appearance")
            for k in ("/Popup", "/A"):
                if k in a:
                    mark(a[k], "annotation")
    acro = root.get("/AcroForm")
    if isinstance(acro, Dictionary):
        stack = list(acro.get("/Fields") or [])
        while stack:
            f = stack.pop()
            mark(f, "form field")
            stack.extend(f.get("/Kids") or [])
    if "/Outlines" in root:
        stack = [root.Outlines]
        while stack:
            o = stack.pop()
            mark(o, "bookmark")
            for k in ("/First", "/Next"):
                if k in o:
                    stack.append(o[k])
    for name, spec in pdf.attachments.items():
        mark(spec.obj, "attached file")
        for f in (spec.obj.get("/EF") or {}).values():
            mark(f, "attached file")
    return kinds


CONTENT_KINDS = {"page content", "page content (form XObject)", "annotation appearance"}


def _content_strings(stream):
    """The strings of a content stream (shown text, and strings in marked-content
    properties such as /ActualText), joined; None if it doesn't parse as content."""
    out = []

    def collect(v):
        if isinstance(v, String):
            out.append(bytes(v).decode("latin-1"))
            raw = bytes(v)
            if raw[:2] == b"\xfe\xff":
                out.append(raw[2:].decode("utf-16-be", "replace"))
        elif isinstance(v, Array):
            for x in v:
                collect(x)
        elif isinstance(v, Dictionary):
            for k in v.keys():
                collect(v[k])

    try:
        for operands, _op in pikepdf.parse_content_stream(stream):
            for v in operands:
                collect(v)
    except Exception:  # noqa: BLE001
        return None
    return "".join(out)


def _reachable(pdf):
    """Indirect objects the document still uses (reachable from the trailer)."""
    seen, stack = set(), [pdf.trailer]
    while stack:
        obj = stack.pop()
        if isinstance(obj, (Dictionary, Stream)):
            values = [obj.get(k) for k in obj.keys()]
        elif isinstance(obj, Array):
            values = list(obj)
        else:
            continue
        for v in values:
            if not isinstance(v, (Dictionary, Array, Stream)):
                continue
            if getattr(v, "is_indirect", False):
                if v.objgen in seen:
                    continue
                seen.add(v.objgen)
            stack.append(v)
    return seen


def object_hits(path, secrets):
    """{secret: set of places} for secrets found in the objects. Objects no
    longer used by the document but still stored in the file count too (anyone
    reading the file finds them); they are reported as "unreferenced"."""
    hits = {s: set() for s in secrets}
    with pikepdf.open(path) as pdf:
        kinds = _kinds(pdf)
        used = _reachable(pdf)
        trailer_strings = []
        _strings(pdf.trailer, trailer_strings)
        objs = [(None, "\n".join(trailer_strings))]
        for obj in pdf.objects:
            if not isinstance(obj, (Dictionary, Stream, Array)):
                if isinstance(obj, String):
                    objs.append(("other object", str(obj)))
                continue
            parts = []
            _strings(obj, parts)
            kind = kinds.get(obj.objgen) or _guess(obj)
            if obj.objgen not in used:
                kind = f"unreferenced {kind}"
            if isinstance(obj, Stream) and obj.get("/Subtype") != Name.Image:
                try:
                    data = obj.read_bytes()
                except Exception:  # noqa: BLE001 - unreadable filter: look at the raw bytes
                    data = obj.read_raw_bytes()
                text = _content_strings(obj) if kind in CONTENT_KINDS or obj.get("/Subtype") == Name.Form else None
                if text is not None:
                    parts.append(text)
                else:  # XMP, attached files...: the whole stream as text
                    parts.append(data.decode("latin-1"))
                    if data[:2] in (b"\xfe\xff", b"\xff\xfe"):
                        parts.append(data.decode("utf-16", "replace"))
                    else:
                        try:
                            parts.append(data.decode("utf-8"))
                        except UnicodeDecodeError:
                            pass
            objs.append((kind, "\n".join(parts)))
        for kind, text in objs:
            n = norm(text)
            for s in secrets:
                if norm(s) and norm(s) in n:
                    hits[s].add(kind or "trailer")
    return hits


def _guess(obj):
    if not isinstance(obj, (Dictionary, Stream)):
        return "other object"
    t, st = obj.get("/Type"), obj.get("/Subtype")
    if t == Name.Metadata:
        return "XMP metadata"
    if t == Name.EmbeddedFile or t == Name.Filespec:
        return "attached file"
    if st is not None and str(st) in ANNOT_TYPES and "/Rect" in obj:
        return "annotation"
    if "/FT" in obj or ("/T" in obj and "/V" in obj):
        return "form field"
    if "/Title" in obj and ("/Parent" in obj or "/Dest" in obj or "/A" in obj):
        return "bookmark"
    if st == Name.Form:
        return "form XObject (unused)"
    return "other object"


# ----------------------------------------------------------------- pictures

def picture_text(path, min_side=40):
    """OCR of every picture in the file (pixels left under a box are found)."""
    texts = []
    with pikepdf.open(path) as pdf:
        for obj in pdf.objects:
            if not isinstance(obj, Stream) or obj.get("/Subtype") != Name.Image:
                continue
            if obj.get("/ImageMask") or int(obj.get("/Width", 0)) < min_side or int(obj.get("/Height", 0)) < min_side:
                continue
            try:
                img = pikepdf.PdfImage(obj).as_pil_image().convert("RGB")
            except Exception:  # noqa: BLE001 - a filter Pillow can't read
                continue
            result, _ = ocr_engine()(img)
            texts.append(" ".join(r[1] for r in result or []))
    return "\n".join(texts)


def _long_piece(secret, hay):
    size = max(5, -(-len(secret) * 6 // 10))
    for i in range(len(secret) - size + 1):
        if secret[i:i + size] in hay:
            return secret[i:i + size]
    return None


def validity(path):
    qpdf = Path(__file__).resolve().parents[2] / "packaging/build/backend/qpdf/bin/qpdf"
    cmd = [str(qpdf) if qpdf.exists() else "qpdf", "--check", str(path)]
    r = subprocess.run(cmd, capture_output=True, timeout=120)
    return {0: "ok", 3: "warnings", 2: "errors"}.get(r.returncode, f"exit {r.returncode}")


# ------------------------------------------------------------------ verdict

def check(path, case):
    secrets = case["secrets"]
    texts = {}
    for name, fn in TEXT_TOOLS.items():
        try:
            texts[name] = fn(path)
        except Exception as exc:  # noqa: BLE001 - a reader that fails on the file is reported, not fatal
            texts[name] = ""
            texts.setdefault("_errors", []).append(f"{name}: {exc}")
    errors = texts.pop("_errors", [])
    pictures = picture_text(path)
    objects = object_hits(path, secrets)
    leaks, partial = [], []
    for s in secrets:
        found = [n for n, t in texts.items() if norm(s) in norm(t)]
        if norm(s) in norm(pictures):
            found.append("OCR of a picture")
        where = sorted(objects[s])
        if found or where:
            leaks.append({"secret": s, "found_by": found + (["objects"] if where else []), "where": where})
            continue
        hay = norm(" ".join(texts.values()) + pictures)
        piece = next((p for p in case["parts"].get(s, []) if norm(p) in hay), None) or _long_piece(norm(s), hay)
        if piece:
            partial.append({"secret": s, "piece": piece})
    every = squeeze(" ".join(texts.values()) + " " + pictures)
    missing = [k for k in case["keep"] if squeeze(k) not in every]
    as_text = squeeze(" ".join(texts.values()))
    return {
        # of the words that should survive, those still text (searchable, selectable)
        "keep_as_text": sum(1 for k in case["keep"] if squeeze(k) in as_text),
        "leaks": leaks,
        "partial": partial,
        "keep_found": len(case["keep"]) - len(missing),
        "keep_total": len(case["keep"]),
        "keep_missing": missing,
        "has_text": bool(norm(texts.get("poppler", ""))),
        "valid": validity(path),
        "reader_errors": errors,
    }


if __name__ == "__main__":
    import json
    import sys
    cases = {c["id"]: c for c in json.loads(Path(sys.argv[2]).read_text())}
    p = Path(sys.argv[1])
    print(json.dumps(check(p, cases[sys.argv[3] if len(sys.argv) > 3 else p.stem]), indent=1, ensure_ascii=False))
