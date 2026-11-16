#!/usr/bin/env python3
"""Checks that saved text boxes reach other readers and that Cover erases.

Usage: python scripts/check_baked_edits.py PDFBOX_URL FIXTURES
PDFBOX_URL is the PDFBox service (devstack: http://127.0.0.1:28092); FIXTURES
is made by engine/tests/make_fixtures.py. Needs httpx, pypdf and Pillow.

What /embed-placements must do with the editor's boxes:
- draw them into the pages, in the layer "OpenPDF edits", so any reader
  (and text extraction) sees the new text;
- remove the text under a Cover box (also on rotated pages and inside forms
  shared with other pages, which must stay as they were) and paint images
  under it white;
- replace its earlier drawing on the next save, and remove it when the
  boxes are gone.
"""
import io
import json
import sys
from pathlib import Path

import httpx
from PIL import Image
from pypdf import PdfReader

BASE = sys.argv[1].rstrip("/")
FIX = Path(sys.argv[2])
results = []


def check(ok, what):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'} {what}", flush=True)


def post(path, pdf, **data):
    r = httpx.post(f"{BASE}{path}", files={"file": ("in.pdf", pdf, "application/pdf")}, data=data, timeout=120)
    r.raise_for_status()
    return r


def embed(pdf, items):
    r = post("/embed-placements", pdf, placements=json.dumps(items))
    return r.content, json.loads(r.headers.get("X-Edits-Report", "{}"))


def find(pdf, *terms, pages=""):
    return post("/find-text", pdf, terms=json.dumps(list(terms)), pages=pages).json()["matches"]


def box_of(pdf, term, page):
    for m in find(pdf, term, pages=str(page)):
        b = m["boxes"][0]
        return {"pageIndex": page - 1, "x": b["x"] - 1, "y": b["y"] - 1,
                "width": b["width"] + 2, "height": b["height"] + 2}
    raise SystemExit(f"{term!r} not found on page {page}")


def ours(pdf):
    """(tagged content streams per page, our layers in the file's layer list)."""
    r = PdfReader(io.BytesIO(pdf))
    streams = []
    for page in r.pages:
        c = page.get("/Contents")
        c = c.get_object() if c is not None else None
        items = c if isinstance(c, list) else ([c] if c is not None else [])
        streams.append(sum(1 for s in items if s.get_object().get("/OpenPDFEdits")))
    layers = []
    oc = r.trailer["/Root"].get("/OCProperties")
    if oc is not None:
        for g in oc.get_object()["/OCGs"]:
            if g.get_object().get("/OpenPDFEdits"):
                layers.append(g)
    return streams, layers


def dark_pixels(pdf, page, rect):
    png = post("/render-page", pdf, pageIndex=str(page), scale="1").content
    img = Image.open(io.BytesIO(png)).convert("L")
    x, y, w, h = (int(v) for v in rect)
    return sum(1 for p in img.crop((x, y, x + w, y + h)).getdata() if p < 128)


# ---------------------------------------------------------------- contract.pdf
src = (FIX / "contract.pdf").read_bytes()
cover1 = {"id": "c1", "kind": "cover", **box_of(src, "123-45-6789", 1), "text": "XXX-XX-0000", "fontSize": 10}
cover2 = {"id": "c2", "kind": "cover", **box_of(src, "123-45-6789", 2), "text": "YYY-YY-0000", "fontSize": 10}
plain = {"id": "p1", "kind": "plain", "pageIndex": 0, "x": 300, "y": 60, "width": 160, "height": 16,
         "text": "Added by OpenPDF 中文", "fontSize": 12, "fontFamily": "Helvetica"}
callout = {"id": "k1", "kind": "callout", "pageIndex": 0, "x": 380, "y": 300, "width": 150, "height": 44,
           "anchorX": 340, "anchorY": 200, "text": "Please check this clause", "fontSize": 11}
items = [cover1, cover2, plain, callout]
before_other = len(find(src, "Reference SSN"))

out, report = embed(src, items)
print("report:", report)
check(report.get("glyphsErased", 0) >= 22 and report.get("textLeft") == 0,
      f"cover removed the covered characters on both pages: {report.get('glyphsErased')}")
check(not find(out, "123-45-6789"), "covered number no longer found anywhere")
check(len(find(out, "Reference SSN")) == before_other, "text next to the cover kept")
check(find(out, "XXX-XX-0000") and find(out, "YYY-YY-0000"), "cover text (normal and rotated page) readable by others")
check(find(out, "Added by OpenPDF") and find(out, "中文"), "'Edit text' box readable by others (with Chinese)")
check(find(out, "Please check this clause"), "comment readable by others")
streams, layers = ours(out)
check(streams[0] == 2 and streams[1] == 2 and len(layers) == 1, f"one layer, drawn on both pages: {streams} {len(layers)}")
form_oc = PdfReader(io.BytesIO(out)).pages[0]["/Resources"]["/XObject"]["/OpenPDFEdits"].get_object().raw_get("/OC")
check(getattr(form_oc, "idnum", None) == getattr(layers[0], "idnum", -1), "drawing belongs to the listed layer")
meta = PdfReader(io.BytesIO(out)).metadata.get("/PdfGatewayPlacements")
check(meta and len(json.loads(meta)) == 4, "boxes kept in the metadata for editing again")

# a second save with the cover moved: the drawing is replaced, not added
moved = dict(plain, x=320, text="Moved box")
out2, report2 = embed(out, [cover1, cover2, moved, callout])
streams2, layers2 = ours(out2)
check(streams2 == streams and len(layers2) == 1, f"second save replaces the drawing: {streams2}")
check(not find(out2, "Added by OpenPDF") and find(out2, "Moved box"), "old drawing gone, new one there")
check(report2.get("glyphsErased") == 0, "nothing left to erase the second time")

# all boxes deleted: no drawing, no layer; what was erased stays erased
out3, _ = embed(out2, [])
streams3, layers3 = ours(out3)
check(streams3 == [0, 0] and not layers3, f"no boxes: drawing and layer removed {streams3}")
check(not find(out3, "Moved box") and not find(out3, "123-45-6789"), "no box text; covered number still gone")
check(len(find(out3, "Reference SSN")) == before_other, "page text intact after three saves")

# ---------------------------------------------------------------- shared.pdf
src = (FIX / "shared.pdf").read_bytes()
cover = {"id": "s1", "kind": "cover", **box_of(src, "7731", 1), "text": "####", "fontSize": 10}
out, report = embed(src, [cover])
check(not find(out, "7731") and find(out, "Jane Doe, account", pages="1"), "cover inside a form removes only the covered part")
check(find(out, "Public notice for all residents", pages="2") and find(out, "Page two is public", pages="2"),
      "the other page sharing the resources is unchanged")

# ---------------------------------------------------------------- scan.pdf
src = (FIX / "scan.pdf").read_bytes()
area = (60, 60, 300, 60)
cover = {"id": "i1", "kind": "cover", "pageIndex": 0, "x": area[0], "y": area[1], "width": area[2],
         "height": area[3], "text": "Replaced", "fontSize": 12}
dark_before = dark_pixels(src, 0, (area[0] + 75, area[1] + 4, area[2] - 80, area[3] - 8))
out, report = embed(src, [cover])
dark_after = dark_pixels(out, 0, (area[0] + 75, area[1] + 4, area[2] - 80, area[3] - 8))
check(report.get("imagesErased") == 1, f"scanned image under the cover repainted: {report}")
check(dark_before > 50 and dark_after == 0, f"scan pixels under the cover are white ({dark_before} -> {dark_after})")
check(dark_pixels(out, 0, (60, 200, 400, 300)) > 50, "rest of the scan kept")

# ---------------------------------------------------------------- the page's own font
# Edit text on the page's text (matchStyle) writes the new text in that text's
# embedded font when it has the characters, with its size, colour and position.
SERIF = "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf"
if Path(SERIF).exists():
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    pdfmetrics.registerFont(TTFont("LibSerif", SERIF))
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    c.setFont("LibSerif", 14)
    c.setFillColorRGB(0.1, 0.2, 0.6)
    c.drawString(72, 700, "Invoice total: 1234.50 EUR")
    c.setFillColorRGB(0, 0, 0)
    c.setFont("Helvetica", 11)
    c.drawString(72, 660, "Payment within 30 days.")
    c.save()
    src = buf.getvalue()
    line = find(src, "Invoice total: 1234.50 EUR")[0]["boxes"][0]

    def edit_item(text):
        return {"id": "e1", "kind": "cover", "pageIndex": 0, "x": line["x"] - 3, "y": line["y"] - 1,
                "width": line["width"] + 6, "height": line["height"] + 2, "text": text, "fontSize": 14,
                "matchStyle": True, "origin": {"x": line["x"] - 3, "y": line["y"] - 1,
                                               "width": line["width"] + 6, "height": line["height"] + 2}}

    def box_style(pdf):
        r = PdfReader(io.BytesIO(pdf))
        drawing = r.pages[0]["/Resources"]["/XObject"]["/OpenPDFEdits"].get_object()
        for ref in drawing["/Resources"]["/XObject"].values():
            box = ref.get_object()
            if "/OpenPDFStyle" in box:
                font = box["/Resources"]["/Font"]["/F0"].get_object()
                return str(font["/BaseFont"]), box["/OpenPDFStyle"]
        return "", {}

    def phrase_at(pdf, words):
        layout = httpx.post(f"{BASE}/text-layout", files={"file": ("x.pdf", pdf)}, data={"pages": "1"}).json()
        for p in layout["pages"][0]["phrases"]:
            if words in p["text"]:
                return p
        return None

    out, _ = embed(src, [edit_item("Invoice total: 1243.05 EUR")])
    font, style = box_style(out)
    check("LibSerif" in font or "Liberation" in font, f"new text in the page's own embedded font: {font}")
    color = [round(float(v), 2) for v in style.get("/Color", [])]
    check(color == [0.1, 0.2, 0.6] and abs(float(style.get("/Size", 0)) - 14) < 0.01, f"its colour and size: {color} {style.get('/Size')}")
    old, new = phrase_at(src, "Invoice total"), phrase_at(out, "Invoice total")
    check(new and "1243.05" in new["text"] and abs(new["x"] - old["x"]) < 0.6 and abs(new["y"] - old["y"]) < 0.6,
          f"in the old text's place: {old and (old['x'], old['y'])} -> {new and (new['x'], new['y'], new['text'])}")
    check(not find(out, "1234.50"), "old number gone")
    out2, _ = embed(out, [edit_item("Invoice total: 1243.05 EUR (paid)")])
    font2, style2 = box_style(out2)
    check("LibSerif" in font2 or "Liberation" in font2 or font2 == "/Times-Roman",
          f"a second save keeps the look after the old text is gone: {font2}")
    out3, _ = embed(src, [edit_item("Zürich ½ — Quote")])
    font3, _ = box_style(out3)
    check(font3 == "/Times-Roman", f"characters the font lacks: a standard font of the same kind: {font3}")
else:
    print("SKIP the page's own font (no Liberation Serif here)")

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
