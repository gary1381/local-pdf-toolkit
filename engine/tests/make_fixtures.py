"""Build the test PDFs used by the engine tests and demos.

    python engine/tests/make_fixtures.py OUT_DIR

contract.pdf  2 pages of text with personal data; page 2 is rotated 90 degrees,
              has a sticky note and a bookmark naming the client.
form.pdf      a vendor intake form with text fields, a checkbox and a choice.
scan.pdf      one page that is only a picture of text (needs OCR).
shared.pdf    two pages sharing one resources dictionary (redaction must not
              leave page 1's form behind through page 2).
report.pdf    2 pages with structure: title, sections, a list, a table, a
              two-column page, running header and footer.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader, PdfWriter
from pypdf.annotations import Text
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

out = Path(sys.argv[1] if len(sys.argv) > 1 else "fixtures")
out.mkdir(parents=True, exist_ok=True)

# ------------------------------------------------------------------ contract
c = canvas.Canvas(str(out / "contract.pdf"), pagesize=letter)
c.setTitle("Services agreement - John Smith")
c.setAuthor("Acme Legal")
c.bookmarkPage("p1")
c.addOutlineEntry("Agreement with John Smith", "p1", level=0)
c.setFont("Helvetica-Bold", 16)
c.drawString(72, 720, "Services Agreement")
c.setFont("Helvetica", 11)
lines = [
    "This agreement is made between Acme Corp and John Smith (the Client).",
    "Client SSN: 123-45-6789. Client email: john.smith@example.com",
    "The Client will pay USD 4,500 per month, due on the first business day.",
    "Payment goes to account 000123456789 at First Example Bank.",
    "Either party may end this agreement with 30 days written notice.",
]
y = 690
for line in lines:
    c.drawString(72, y, line)
    y -= 18
# letter-spaced text: extractors see "J o h n  S m i t h"
t = c.beginText(72, y - 10)
t.setFont("Helvetica", 11)
t.textOut("Witness: ")
t.setCharSpace(4)
t.textOut("John Smith")
c.drawText(t)
c.showPage()
# Page 2: a landscape page (792 x 612) shown rotated 90 degrees, so it displays upright-portrait.
c.setPageSize((792, 612))
c.setPageRotation(90)
c.setFont("Helvetica", 11)
c.drawString(72, 540, "Schedule A. Contact for notices: John Smith, 42 Example Road, Springfield.")
c.drawString(72, 520, "Signed copies are kept by Acme Corp for seven years.")
c.drawString(72, 500, "Reference SSN 123-45-6789 appears again on this page.")
c.showPage()
c.save()

# a sticky note naming the client
r = PdfReader(str(out / "contract.pdf"))
w = PdfWriter(clone_from=r)
w.add_annotation(page_number=1, annotation=Text(rect=(400, 600, 420, 620), text="Call John Smith before filing"))
# things that keep page 1 referenced from outside the page tree
from pypdf.generic import ArrayObject, NameObject  # noqa: E402
w._root_object[NameObject("/OpenAction")] = ArrayObject([w.pages[0].indirect_reference, NameObject("/Fit")])
w.write(str(out / "contract.pdf"))

# ------------------------------------------------------------------ form
c = canvas.Canvas(str(out / "form.pdf"), pagesize=letter)
c.setFont("Helvetica-Bold", 15)
c.drawString(72, 730, "Vendor Intake Form")
c.setFont("Helvetica", 10)
form = c.acroForm
rows = [
    ("Legal name", "legal_name"),
    ("Business name (if different)", "business_name"),
    ("Street address", "address"),
    ("City, state and ZIP", "city_state_zip"),
    ("Taxpayer ID (EIN or SSN)", "tin"),
    ("Email", "email"),
]
y = 690
for label, name in rows:
    c.drawString(72, y + 4, label)
    form.textfield(name=name, x=250, y=y - 2, width=290, height=18, borderWidth=0.5, fontSize=10)
    y -= 34
c.drawString(72, y + 4, "Tax classification")
form.choice(name="tax_class", x=250, y=y - 2, width=200, height=18, fontSize=10,
            options=["Individual", "C Corporation", "S Corporation", "Partnership", "LLC"],
            value="Individual")
y -= 34
c.drawString(72, y + 4, "I certify the information above is correct")
form.checkbox(name="certify", x=320, y=y, size=14, checked=False)
y -= 34
c.drawString(72, y + 4, "Date")
form.textfield(name="date", x=250, y=y - 2, width=120, height=18, borderWidth=0.5, fontSize=10)
c.showPage()
c.save()

# ------------------------------------------------------------------ scan
W, H = 1700, 2200  # 200 dpi letter
img = Image.new("RGB", (W, H), "white")
d = ImageDraw.Draw(img)
font = None
for path in ("/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
             "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf"):
    try:
        font = ImageFont.truetype(path, 44)
        break
    except OSError:
        pass
font = font or ImageFont.load_default()
text = [
    "INVOICE  No. 2026-0417",
    "Bill to: Riverside Dental Clinic",
    "Patient account: 88-2231",
    "Cleaning and exam ........ $180.00",
    "X-ray, two views ......... $95.00",
    "Total due ................ $275.00",
    "Please pay within 30 days.",
]
y = 200
for line in text:
    d.text((160, y), line, fill="black", font=font)
    y += 110
img = img.rotate(0.6, fillcolor="white")  # a slightly skewed scan
img_path = out / "_scan.png"
img.save(img_path)
c = canvas.Canvas(str(out / "scan.pdf"), pagesize=letter)
c.drawImage(str(img_path), 0, 0, width=letter[0], height=letter[1])
c.showPage()
c.save()
img_path.unlink()

# ------------------------------------------------------------------ shared
# Two pages sharing one resources dictionary. Page 1 draws form FmA (which names
# "account 7731") and mentions Jane Doe, once split as "Ja ne Doe"; page 2 only
# draws FmB. After redacting page 1, FmA must not survive through page 2's
# resources. FmA's own resources point back at the shared dictionary (a cycle).
from pypdf.generic import DecodedStreamObject, DictionaryObject, NumberObject  # noqa: E402


def form(writer, text, resources=None):
    s = DecodedStreamObject()
    s.set_data(f"BT /F1 12 Tf 72 600 Td ({text}) Tj ET".encode())
    s.update({NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Form"),
              NameObject("/BBox"): ArrayObject([NumberObject(0), NumberObject(0), NumberObject(612), NumberObject(792)])})
    if resources is not None:
        s[NameObject("/Resources")] = resources
    return writer._add_object(s)


w = PdfWriter()
font = w._add_object(DictionaryObject({
    NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"),
    NameObject("/BaseFont"): NameObject("/Helvetica"),
}))
shared = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
shared_ref = w._add_object(shared)
xobjects = DictionaryObject()
shared[NameObject("/XObject")] = xobjects
xobjects[NameObject("/FmA")] = form(w, "Jane Doe, account 7731", shared_ref)
xobjects[NameObject("/FmB")] = form(w, "Public notice for all residents")
for content in (b"q /FmA Do Q BT /F1 12 Tf 72 700 Td (Page one mentions Jane Doe.) Tj ET "
                b"BT /F1 12 Tf 72 680 Td (Witness: Ja ne Doe) Tj ET",
                b"q /FmB Do Q BT /F1 12 Tf 72 700 Td (Page two is public.) Tj ET"):
    page = w.add_blank_page(612, 792)
    page[NameObject("/Resources")] = shared_ref
    cs = DecodedStreamObject()
    cs.set_data(content)
    page[NameObject("/Contents")] = w._add_object(cs)
w.write(str(out / "shared.pdf"))

# ------------------------------------------------------------------ report
# A report with structure: a title, numbered sections, a bulleted list, a
# table, a two-column page, and a running header and footer on every page.
from reportlab.lib import colors  # noqa: E402
from reportlab.lib.styles import getSampleStyleSheet  # noqa: E402
from reportlab.platypus import (BaseDocTemplate, Frame, FrameBreak, ListFlowable, NextPageTemplate,  # noqa: E402
                                PageTemplate, Paragraph, Spacer, Table, TableStyle)


def running_header(canv, doc):
    canv.setFont("Helvetica", 8)
    canv.drawString(72, 760, "Northwind Ltd - Annual Report 2025")
    canv.drawRightString(540, 30, f"Page {doc.page}")


styles = getSampleStyleSheet()
body = styles["BodyText"]
filler = ("Demand for repairs grew steadily through the year, and the service teams handled more calls "
          "with the same headcount by planning routes a day ahead. ")
doc = BaseDocTemplate(str(out / "report.pdf"), pagesize=letter, title="Annual Report 2025")
doc.addPageTemplates([
    PageTemplate(id="one", frames=[Frame(72, 60, 468, 680)], onPage=running_header),
    PageTemplate(id="two", frames=[Frame(72, 60, 222, 680, id="left"), Frame(318, 60, 222, 680, id="right")],
                 onPage=running_header),
])
story = [
    Paragraph("Annual Report 2025", styles["Title"]),
    Paragraph("1 Summary", styles["Heading1"]),
    Paragraph("Revenue reached 12.4 million, up 8 percent. Three things drove the year:", body),
    ListFlowable([Paragraph(t, body) for t in ("New contracts in the north region",
                                               "Lower fuel costs", "Fewer missed appointments")],
                 bulletType="bullet"),
    Paragraph("1.1 Revenue by region", styles["Heading2"]),
    Table([["Region", "Revenue (million)", "Growth"],
           ["North", "5.1", "+14%"],
           ["South", "4.2", "+3%"],
           ["West", "3.1", "+6%"]],
          style=TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black),
                            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold")])),
    Spacer(1, 12),
    Paragraph("The north region also had the shortest response time.", body),
    NextPageTemplate("two"),
    FrameBreak(),
    Paragraph("2 Operations", styles["Heading1"]),
    Paragraph("LEFT-COLUMN-START " + filler * 6 + "LEFT-COLUMN-END", body),
    FrameBreak(),
    Paragraph("RIGHT-COLUMN-START " + filler * 6 + "RIGHT-COLUMN-END", body),
]
doc.build(story)
print("fixtures in", out)
