#!/usr/bin/env python3
"""Browser check of Edit text on a paragraph, through to the saved file.

Usage: python scripts/check_paragraph_edit.py BASE OUT [chromium|firefox|webkit]
Needs Playwright, reportlab and Liberation Serif (/usr/share/fonts/truetype/liberation).

A click on a line of a justified paragraph opens the whole paragraph,
prefilled; after a change the saved file has the paragraph rewritten in the
same font, wrapped to the same width, lines at the same spacing, and the
paragraph below untouched.

OPENPDF_CHECK_API: where the test's own helper requests go (finding text,
preparing and inspecting files); default BASE. Set it to a gateway to check
the browser version (web/dist), which has no server.
"""
import io
import json
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright
from reportlab.lib.enums import TA_JUSTIFY
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

SERIF = "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf"
FIRST = ("The supplier shall deliver the goods described in Schedule A to the buyer's warehouse "
         "within thirty days of the order date. Delivery is complete when the buyer signs the "
         "receipt, and the risk passes to the buyer at that moment. Late delivery entitles the "
         "buyer to a reduction of the price agreed in the order.")
SECOND = "Payment is due within sixty days of the invoice date, without any deduction."


def make(path):
    pdfmetrics.registerFont(TTFont("LibSerif", SERIF))
    style = ParagraphStyle("body", fontName="LibSerif", fontSize=12, leading=16, alignment=TA_JUSTIFY, firstLineIndent=18)
    doc = SimpleDocTemplate(str(path), pagesize=letter, leftMargin=72, rightMargin=180, topMargin=72)
    doc.build([Paragraph(FIRST, style), Spacer(1, 18), Paragraph(SECOND, style)])


def main():
    base, out = sys.argv[1].rstrip("/"), Path(sys.argv[2])
    api = os.environ.get("OPENPDF_CHECK_API", base).rstrip("/")
    browser_name = sys.argv[3] if len(sys.argv) > 3 else "chromium"
    out.mkdir(parents=True, exist_ok=True)
    if not Path(SERIF).exists():
        print("SKIP: no Liberation Serif here")
        return 0
    source = out / "paragraph.pdf"
    make(source)
    results = []

    def check(name, ok, detail=""):
        results.append({"name": name, "passed": bool(ok), "detail": detail})
        print(f'{"PASS" if ok else "FAIL"} {name}{": " + str(detail) if detail else ""}', flush=True)

    with sync_playwright() as pw:
        browser = getattr(pw, browser_name).launch()
        ctx = browser.new_context(accept_downloads=True, viewport={"width": 1280, "height": 900})
        ctx.add_init_script("localStorage.setItem('openpdf_save_mode', 'download')")
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        def layout(blob):
            r = ctx.request.post(api + "/v1/pdf/text-layout", multipart={
                "file": {"name": "x.pdf", "mimeType": "application/pdf", "buffer": blob}, "pages": "1"})
            assert r.ok, r.text()
            return r.json()["pages"][0]["phrases"]

        def text(blob):
            return " ".join(p["text"] for p in layout(blob))

        src = source.read_bytes()
        before = layout(src)
        lines = sorted([p for p in before if p["x"] < 100 and p["y"] < min(q["y"] for q in before if "Payment is due" in q["text"]) - 1], key=lambda p: p["y"])
        page.goto(base)
        page.set_input_files("#fileInput", str(source))
        page.wait_for_function("() => activeDoc()?.documentId && activeDoc()?.pdfDoc")
        page.evaluate("() => activeDoc()._registerPromise")
        page.click('[data-mode="cover-text"]')
        middle = lines[1]
        shell = page.locator('.page-shell[data-page="1"]')
        scale = float(shell.get_attribute("data-scale"))
        box = shell.bounding_box()
        page.mouse.click(box["x"] + (middle["x"] + 40) * scale, box["y"] + (middle["y"] + middle["height"] / 2) * scale)
        editor = page.locator(".inline-text-editor")
        editor.wait_for()
        prefilled = editor.inner_text()
        check("a click opens the whole paragraph", "supplier" in prefilled and "price agreed" in prefilled
              and "Payment is due" not in prefilled, prefilled[:80])
        check("as a paragraph editor", "paragraph-editor" in (editor.get_attribute("class") or ""))
        page.keyboard.press("Control+a")
        page.keyboard.type(prefilled.replace("thirty days", "forty-five days").replace("\n", " "))
        page.keyboard.press("Enter")
        page.wait_for_function("() => activeDoc().placedTexts?.length === 1")
        para = page.evaluate("activeDoc().placedTexts[0].paragraph")
        check("paragraph layout noted", para and para["align"] == "justify" and abs(para["lineHeight"] - 16) < 0.6
              and abs(para.get("indent", 0) - 18) < 1, para)

        with page.expect_download() as download:
            page.keyboard.press("Control+s")
        saved = out / "paragraph-edited.pdf"
        download.value.save_as(saved)
        page.wait_for_function("() => !activeDoc()._saving")
        blob = saved.read_bytes()
        after = layout(blob)
        all_text = text(blob)
        check("old words gone, new ones there", "thirty days" not in all_text and "forty-five" in all_text)
        check("the rest of the paragraph there", "supplier" in all_text and "price agreed in the order" in all_text)
        check("the paragraph below untouched", SECOND[:40] in all_text)
        below = min(p["y"] for p in after if "Payment is due" in p["text"])
        new_lines = sorted([p for p in after if p["x"] < 100 and p["y"] < below - 1], key=lambda p: p["y"])
        left_ok = abs(new_lines[0]["x"] - lines[0]["x"]) < 1.5 and all(abs(p["x"] - lines[1]["x"]) < 1.5 for p in new_lines[1:])
        right = max(p["x"] + p["width"] for p in lines[:-1])
        width_ok = all(p["x"] + p["width"] <= right + 1.5 for p in new_lines)
        gaps = [round(b["y"] - a["y"], 1) for a, b in zip(new_lines, new_lines[1:])]
        check("wrapped to the same width, same left edge", left_ok and width_ok,
              [(round(p["x"], 1), round(p["x"] + p["width"], 1)) for p in new_lines])
        check("lines at the same spacing", gaps and all(abs(g - 16) < 0.8 for g in gaps), gaps)
        justified = new_lines[:-1]  # the last line of a justified paragraph stays left
        check("justified like the original", all(abs(p["x"] + p["width"] - right) < 2 for p in justified),
              [round(p["x"] + p["width"], 1) for p in justified])
        check("no uncaught JavaScript errors", not errors, errors)
        ctx.close()
        browser.close()
    (out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if all(r["passed"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
