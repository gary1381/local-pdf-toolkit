"""The test documents: secrets placed where redaction tools tend to miss them.

    python corpus.py OUT_DIR      -> OUT_DIR/<case>.pdf and OUT_DIR/cases.json

Every case lists the secrets (what a user asks to redact), the words that must
survive (to see what a tool removes beyond what was asked), and how the tools
are asked: by the words ("terms") or by boxes drawn on the page ("regions",
in points from the top left of the page as displayed).

The documents are made here, with reportlab, Pillow and pikepdf, so anyone can
rebuild them and check how each one is put together.
"""
import json
import sys
from pathlib import Path

import pikepdf
from PIL import Image, ImageDraw, ImageFont
from pikepdf import Array, Dictionary, Name, String
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

NAME = "Margaret Hollister"
SSN = "078-05-1120"
EMAIL = "m.hollister@example.com"
CN_NAME = "张伟明"
CN_ID = "110105199003078812"

W, H = letter  # 612 x 792
HEADER = "Riverside Dental Group - Service Agreement"
BODY = [
    "This agreement covers quarterly payment terms for the clinic.",
    "Section 4 explains how records are signed and stored.",
]
KEEP = ["Riverside", "agreement", "quarterly", "payment", "Section", "records", "signed", "stored"]

LATIN_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
CJK_FONTS = [
    Path(__file__).resolve().parents[2] / "packaging/build/backend/pdfbox/fonts/wqy-microhei.ttc",
    Path("/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"),
]

cases = []


def case(cid, title, where, secrets, *, terms=None, regions=None, keep=KEEP, parts=None):
    cases.append({
        "id": cid, "title": title, "where": where, "secrets": secrets,
        # a secret also counts as partly left when one of these pieces is found
        "parts": parts or {},
        "terms": terms if terms is not None else secrets,
        "regions": regions or [],
        "keep": keep,
    })


# ------------------------------------------------------------ low-level pages

def esc(s):
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def text_op(x, y, s, size=11):
    return f"BT /F1 {size} Tf {x} {y} Td ({esc(s)}) Tj ET\n"


def body_ops(top=740):
    ops = text_op(72, top, HEADER, 14)
    for i, line in enumerate(BODY):
        ops += text_op(72, top - 30 - i * 18, line)
    return ops


def helvetica(pdf):
    return pdf.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding))


def new_pdf():
    pdf = pikepdf.new()
    return pdf, helvetica(pdf)


def add_page(pdf, font, ops, resources=None, **extra):
    res = Dictionary(Font=Dictionary(F1=font))
    for k, v in (resources or {}).items():
        res[k] = v
    page = Dictionary(Type=Name.Page, MediaBox=Array([0, 0, W, H]), Resources=res,
                      Contents=pdf.make_stream(ops.encode("latin-1")), **extra)
    pdf.pages.append(pikepdf.Page(page))
    return pdf.pages[-1]


def save(pdf, out, cid):
    pdf.save(out / f"{cid}.pdf")


# ---------------------------------------------------------------------- cases

def page_text(out):
    pdf, f = new_pdf()
    add_page(pdf, f, body_ops() + text_op(72, 650, f"Patient: {NAME}") + text_op(72, 632, f"SSN: {SSN}")
             + text_op(72, 600, "Payment is due within 30 days of the signed agreement."))
    save(pdf, out, "page-text")
    case("page-text", "Plain text on the page", "page text", [NAME, SSN], parts={NAME: ["Hollister"]})


def split_text(out):
    # the SSN written with kerning inside one TJ, the name one letter at a time
    pdf, f = new_pdf()
    ops = body_ops()
    ops += "BT /F1 11 Tf 72 650 Td [(SSN: 07) -20 (8-05) 15 (-11) -10 (20)] TJ ET\n"
    ops += "BT /F1 11 Tf 72 632 Td (Patient:) Tj ET\n"
    x = 120.0
    widths = pdfmetrics.stringWidth
    for ch in NAME:
        ops += f"BT /F1 11 Tf {x:.2f} 632 Td ({esc(ch)}) Tj ET\n"
        x += widths(ch, "Helvetica", 11)
    add_page(pdf, f, ops)
    save(pdf, out, "split-text")
    case("split-text", "Text split up: kerning, one letter at a time", "page text (TJ arrays, separate letters)", [NAME, SSN],
         parts={NAME: ["Hollister"]})


def rotated(out):
    pdf, f = new_pdf()
    add_page(pdf, f, body_ops() + text_op(72, 650, f"SSN: {SSN}"), Rotate=90)
    save(pdf, out, "rotated")
    case("rotated", "Rotated page", "page text, page /Rotate 90", [SSN])


def chinese(out):
    font = next((p for p in CJK_FONTS if p.exists()), None)
    if not font:
        raise SystemExit("WenQuanYi Micro Hei not found (packaging/build/backend/pdfbox/fonts or /usr/share/fonts/truetype/wqy)")
    pdfmetrics.registerFont(TTFont("WQY", str(font), subfontIndex=0))
    c = canvas.Canvas(str(out / "chinese.pdf"), pagesize=letter)
    c.setFont("WQY", 14)
    c.drawString(72, 740, "河畔牙科集团 服务协议")
    c.setFont("WQY", 11)
    c.drawString(72, 710, "本协议规定诊所的季度付款条款。")
    c.drawString(72, 680, f"患者姓名：{CN_NAME}")
    c.drawString(72, 662, f"身份证号：{CN_ID}")
    c.drawString(72, 630, "第四节说明病历的签署和保存方式。")
    c.save()
    case("chinese", "Chinese text (embedded font, no readable bytes)", "page text, CJK font", [CN_NAME, CN_ID],
         keep=["河畔牙科集团", "服务协议", "季度付款", "患者姓名", "身份证号", "病历"])


def neighbours(out):
    # secrets touching other words: what else disappears?
    pdf, f = new_pdf()
    add_page(pdf, f, body_ops() + text_op(72, 650, f"ID:{SSN};Phone 555-0100") + text_op(72, 632, f"Client {NAME}, Riverside branch"))
    save(pdf, out, "neighbours")
    case("neighbours", "Secrets right next to other words", "page text", [NAME, SSN],
         keep=KEEP + ["ID:", "Phone", "555-0100", "Client", "branch"], parts={NAME: ["Hollister"]})


def shared_form(out):
    # a footer drawn by one form XObject on two pages
    pdf, f = new_pdf()
    footer = pdf.make_stream(text_op(72, 40, f"Prepared for {NAME}", 9).encode("latin-1"))
    footer.Type, footer.Subtype, footer.BBox = Name.XObject, Name.Form, Array([0, 0, W, 80])
    footer.Resources = Dictionary(Font=Dictionary(F1=f))
    for i in range(2):
        add_page(pdf, f, body_ops() + text_op(72, 600, f"Page {i + 1} of the agreement.") + "/Foot Do\n",
                 resources={"/XObject": Dictionary(Foot=footer)})
    save(pdf, out, "shared-form")
    case("shared-form", "Footer shared by two pages (form XObject)", "form XObject used on 2 pages", [NAME], parts={NAME: ["Hollister"]})


def annotations(out):
    pdf, f = new_pdf()
    page = add_page(pdf, f, body_ops() + text_op(72, 650, f"Contact: {NAME}"))
    page.obj.Annots = pdf.make_indirect(Array([
        pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Text, Rect=Array([400, 640, 420, 660]),
                                     Contents=String(f"Call {NAME} about SSN {SSN}"), T=String("Reviewer"))),
        pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.FreeText, Rect=Array([72, 500, 400, 530]),
                                     Contents=String(f"Note: SSN {SSN} on file"), DA=String("/Helv 10 Tf 0 g"))),
        pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Link, Rect=Array([72, 645, 250, 660]), Border=Array([0, 0, 0]),
                                     A=Dictionary(S=Name.URI, URI=String(f"mailto:{EMAIL}")))),
    ]))
    save(pdf, out, "annotations")
    case("annotations", "Comments and links", "sticky note, text box comment, link address", [NAME, SSN, EMAIL],
         parts={NAME: ["Hollister"]})


def metadata(out):
    pdf, f = new_pdf()
    add_page(pdf, f, body_ops() + text_op(72, 650, f"Patient: {NAME}") + text_op(72, 632, f"SSN: {SSN}"))
    pdf.docinfo["/Title"] = f"Review of {NAME}"
    pdf.docinfo["/Subject"] = f"SSN {SSN}"
    with pdf.open_metadata(set_pikepdf_as_editor=False) as meta:
        meta["dc:title"] = f"Review of {NAME}"
        meta["dc:description"] = f"SSN {SSN}"
    with pdf.open_outline() as outline:
        outline.root.append(pikepdf.OutlineItem(f"{NAME} - SSN {SSN}", 0))
    save(pdf, out, "metadata")
    case("metadata", "Document properties, XMP and bookmarks", "Info dictionary, XMP, outline", [NAME, SSN],
         parts={NAME: ["Hollister"]})


def actual_text(out):
    # what screen readers and copy-paste use instead of the glyphs
    pdf, f = new_pdf()
    ops = body_ops() + f"/Span <</ActualText ({SSN})>> BDC\n" + text_op(72, 650, SSN) + "EMC\n"
    ops += f"/Span <</Alt ({NAME})>> BDC\n" + text_op(72, 632, NAME) + "EMC\n"
    add_page(pdf, f, ops)
    save(pdf, out, "actual-text")
    case("actual-text", "Replacement text for screen readers (/ActualText, /Alt)", "marked content in the page", [NAME, SSN],
         parts={NAME: ["Hollister"]})


def attachment(out):
    pdf, f = new_pdf()
    add_page(pdf, f, body_ops() + text_op(72, 650, f"SSN: {SSN} (details attached)"))
    pdf.attachments["notes.txt"] = pikepdf.AttachedFileSpec(pdf, f"Patient {NAME}, SSN {SSN}\n".encode(), mime_type="text/plain")
    save(pdf, out, "attachment")
    case("attachment", "Attached file", "embedded file", [SSN], parts={})


def form_field(out):
    c = canvas.Canvas(str(out / "form-field.pdf"), pagesize=letter)
    c.setFont("Helvetica-Bold", 14)
    c.drawString(72, 740, HEADER)
    c.setFont("Helvetica", 11)
    for i, line in enumerate(BODY):
        c.drawString(72, 710 - i * 18, line)
    c.drawString(72, 655, "Patient:")
    c.acroForm.textfield(name="patient", value=NAME, x=130, y=648, width=200, height=20, borderWidth=0, fontSize=11)
    c.drawString(72, 625, "SSN:")
    c.acroForm.textfield(name="ssn", value=SSN, x=130, y=618, width=200, height=20, borderWidth=0, fontSize=11)
    c.save()
    case("form-field", "Filled form fields", "AcroForm values and their appearances", [NAME, SSN], parts={NAME: ["Hollister"]})


def scan_image(path_png, lines, size=(1700, 2200), font_px=34):
    """A page picture at 200 dpi; returns the box of each line (pixels)."""
    img = Image.new("L", size, 255)
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(LATIN_FONT, font_px)
    boxes = []
    for i, line in enumerate(lines):
        xy = (200, 200 + i * 70)
        d.text(xy, line, font=font, fill=0)
        boxes.append(d.textbbox(xy, line, font=font))
    img = img.rotate(0.3, fillcolor=255)
    img.save(path_png)
    return boxes


SCAN_LINES = ["RIVERSIDE DENTAL GROUP", "Invoice for quarterly services", f"Patient SSN {SSN}", "Payment received with thanks"]


def picture(out):
    # a scanned page, redacted by drawing a box over the number
    png = out / "_picture.png"
    boxes = scan_image(png, SCAN_LINES)
    c = canvas.Canvas(str(out / "picture.pdf"), pagesize=letter)
    c.drawImage(str(png), 0, 0, W, H)
    c.save()
    png.unlink()
    x0, y0, x1, y1 = boxes[2]
    k = 72 / 200
    region = {"page": 1, "x": x0 * k - 3, "y": y0 * k - 4, "width": (x1 - x0) * k + 6, "height": (y1 - y0) * k + 8}
    case("picture", "Scanned page, box drawn over the number", "picture pixels", [SSN], terms=[], regions=[region],
         keep=["RIVERSIDE", "DENTAL", "quarterly", "services", "Payment", "thanks"])


def ocr_layer(out):
    # a scanned page with an invisible text layer, as OCR software writes it
    png = out / "_ocr.png"
    boxes = scan_image(png, SCAN_LINES)
    c = canvas.Canvas(str(out / "ocr-layer.pdf"), pagesize=letter)
    c.drawImage(str(png), 0, 0, W, H)
    k = 72 / 200
    for line, (x0, y0, x1, y1) in zip(SCAN_LINES, boxes):
        t = c.beginText()
        t.setTextRenderMode(3)
        size = (y1 - y0) * k
        t.setFont("Helvetica", size)
        t.setHorizScale(100 * (x1 - x0) * k / pdfmetrics.stringWidth(line, "Helvetica", size))
        t.setTextOrigin(x0 * k, H - y1 * k)
        t.textOut(line)
        c.drawText(t)
    c.save()
    png.unlink()
    case("ocr-layer", "Scanned page with an invisible OCR text layer", "invisible text and picture pixels", [SSN],
         keep=["RIVERSIDE", "DENTAL", "quarterly", "services", "Payment", "thanks"])


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for make in (page_text, split_text, rotated, chinese, neighbours, shared_form, annotations, metadata,
                 actual_text, attachment, form_field, picture, ocr_layer):
        make(out)
    (out / "cases.json").write_text(json.dumps(cases, ensure_ascii=False, indent=1))
    print(f"{len(cases)} cases in {out}")


if __name__ == "__main__":
    main()
