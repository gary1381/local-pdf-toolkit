#!/usr/bin/env python3
"""Checks redaction that keeps pages as text (and when it must not).

Usage: python scripts/check_redaction_text.py GATEWAY_URL FIXTURES OUT
GATEWAY_URL e.g. http://127.0.0.1:28090; FIXTURES from engine/tests/make_fixtures.py.
Needs httpx, pypdf, reportlab and Pillow.

A redacted page keeps its other text (selectable, searchable), but nothing of
what was marked may stay anywhere in the file: not the characters, not the
words given again as /ActualText, not shapes or picture pixels under the box,
not an annotation over it. Pages with patterns are rebuilt as pictures.
"""
import io
import json
import sys
from pathlib import Path

import httpx
from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.annotations import FreeText
from pypdf.generic import DictionaryObject, NameObject
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

BASE = sys.argv[1].rstrip("/")
FIX, OUT = Path(sys.argv[2]), Path(sys.argv[3])
OUT.mkdir(parents=True, exist_ok=True)
results = []


def check(ok, what):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'} {what}", flush=True)


def redact(pdf, terms=(), regions=(), **extra):
    data = {"terms": json.dumps(list(terms)), "regions": json.dumps(list(regions)), "restore_text": "false"}
    data.update({k: str(v).lower() for k, v in extra.items()})
    r = httpx.post(f"{BASE}/v1/pdf/redact", files={"file": ("in.pdf", pdf, "application/pdf")}, data=data, timeout=300)
    assert r.status_code == 200, r.text
    head, rest = r.content.split(b"\n", 1)
    n = int(head.split()[1])
    return rest[n:], json.loads(rest[:n])


def text_of(pdf, page=None):
    reader = PdfReader(io.BytesIO(pdf))
    pages = reader.pages if page is None else [reader.pages[page]]
    return "\n".join(p.extract_text() or "" for p in pages)


def raw(pdf, *needles):
    """Needles found anywhere in the file (every object, streams decompressed, spaces ignored)."""
    reader = PdfReader(io.BytesIO(pdf))
    hay = []
    for num in range(1, int(reader.trailer["/Size"])):
        try:
            obj = reader.get_object(num)
        except Exception:  # noqa: BLE001
            continue
        if obj is None:
            continue
        if hasattr(obj, "get_data"):
            try:
                hay.append(obj.get_data().decode("latin-1"))
            except Exception:  # noqa: BLE001
                pass
        hay.append(str(obj))
    hay = "".join(hay).lower().replace(" ", "")
    return [n for n in needles if n.lower().replace(" ", "") in hay]


def methods(report):
    return [p.get("method") for p in report.get("redactedPages", [])]


# ---------------------------------------------------------------- a made-up page
def fixture():
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    c.setFont("Helvetica", 12)
    c.drawString(72, 720, "Keep this line. Remove: Secret 42 here.")
    c._code.append("/Span <</ActualText (Hidden Label 77)>> BDC")
    c.drawString(72, 690, "Shown label")
    c._code.append("EMC")
    c._code.append("/Span <</ActualText (Code 9131)>> BDC")  # the same text given again
    c.drawString(72, 630, "Code 9131")
    c._code.append("EMC")
    c.drawString(72, 660, "Area line: ALPHA BRAVO CHARLIE")
    c.rect(400, 600, 20, 20, stroke=0, fill=1)  # a shape inside the area (y 600..620)
    c.rect(72, 560, 468, 2, stroke=0, fill=1)  # a rule crossing the whole page width
    img = Image.new("RGB", (100, 100), (200, 30, 30))
    c.drawInlineImage(img, 72, 440, 100, 100)  # an inline picture (y 440..540)
    c.drawString(72, 400, "Footer stays")
    c.showPage()
    c.setFont("Helvetica", 12)
    c.drawString(72, 720, "Page two mentions Secret 42 too.")
    c.showPage()
    c.save()
    w = PdfWriter(clone_from=io.BytesIO(buf.getvalue()))
    w.add_annotation(0, FreeText(text="Note over the area", rect=(390, 590, 430, 630)))
    w.add_annotation(0, FreeText(text="Note elsewhere", rect=(450, 150, 560, 180)))
    # page 2 gets a (tiling) pattern resource: such a page is rebuilt as a picture
    res = w.pages[1]["/Resources"]
    res[NameObject("/Pattern")] = DictionaryObject({NameObject("/P0"): DictionaryObject()})
    out = io.BytesIO()
    w.write(out)
    return out.getvalue()


src = fixture()
(OUT / "made-up.pdf").write_bytes(src)
# displayed coordinates: top-left origin, so PDF y -> 792 - y
area = {"page": 1, "x": 380, "y": 792 - 640, "width": 60, "height": 60}       # shape + annotation
picture = {"page": 1, "x": 72, "y": 792 - 540, "width": 50, "height": 100}    # left half of the image
line = {"page": 1, "x": 140, "y": 792 - 672, "width": 200, "height": 16}      # "BRAVO CHARLIE" part
out, report = redact(src, terms=["Secret 42", "Hidden Label 77", "Code 9131"], regions=[area, picture, line])
(OUT / "made-up.redacted.pdf").write_bytes(out)
print("report:", json.dumps(report)[:400])
check(report.get("verified") is True, "verified")
check(methods(report) == ["text", "picture"], f"page 1 kept as text, page 2 (pattern) rebuilt: {methods(report)}")
t1 = text_of(out, 0)
check("Keep this line" in t1 and "Footer stays" in t1 and "here." in t1, "other text of page 1 still text")
check(not raw(out, "Secret 42"), "term gone from the whole file")
check(not raw(out, "Hidden Label 77"), "ActualText with the term gone")
# PDFBox reads an /ActualText span as one character at its first glyph: every glyph must go
check("hown label" not in t1 and "9131" not in t1,
      "every glyph under a matching ActualText gone, not only the first")
check("BRAVO" not in t1 and "CHARLIE" not in t1 and "Area line" in t1, "text in the marked area gone, the rest of the line kept")
check(not raw(out, "Note over the area") and raw(out, "Note elsewhere"), "annotation over the area removed, the other kept")
reader = PdfReader(io.BytesIO(out))
content = " ".join(reader.pages[0].get_contents().get_data().decode("latin-1").split())
check("400 600 20 20 re n" in content, "shape inside the area not painted")
check("72 560 468 2 re f*" in content, "rule reaching beyond the area kept")
images = [img for img in reader.pages[0].images]
ok_img = False
for im in images:
    pic = im.image.convert("RGB")
    left = pic.getpixel((10, 50))
    right = pic.getpixel((90, 50))
    ok_img = ok_img or (left == (255, 255, 255) and right[0] > 150 and right[1] < 100)
check(ok_img, "picture: the marked half painted, the other half kept")

# keep_text=false: the old behaviour, page rebuilt
out2, report2 = redact(src, terms=["Secret 42"], keep_text=False)
check(methods(report2) == ["picture", "picture"] and report2.get("verified"), f"keep_text=false rebuilds pages: {methods(report2)}")

# scanned page (OCR'd first by the gateway): picture pixels and the OCR text go
scan = (FIX / "scan.pdf").read_bytes()
out3, report3 = redact(scan, terms=["Riverside Dental"])
check(report3.get("verified") and methods(report3) == ["text"], f"scan redacted as text: {methods(report3)}")
check(not raw(out3, "Riverside Dental") and "Riverside" not in text_of(out3), "scan: term gone from the OCR text")

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
