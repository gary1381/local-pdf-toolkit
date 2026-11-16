#!/usr/bin/env python3
"""Browser check of Edit text on forms that are not real PDF forms (a table of
labels with blanks after them, as Word exports them).

Usage: python scripts/check_edit_text_forms.py BASE OUT [chromium|firefox|webkit]
Requires Playwright and reportlab.

- A click on the blank after a label opens a box there, on the label's line,
  in the label's size; the text typed there removes nothing from the page (a
  label right next to it stays).
- In the box, the mouse places the caret and selects text (it does not start
  another box); a click on the page's text puts the caret where it was.
- The size and font menus act on the box being typed, without closing it; a
  new size keeps the text on the label's line.
- A box typed on empty space can be picked up again with Edit text.

OPENPDF_CHECK_API: where the test's own helper requests go; default BASE.
"""
import io
import json
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

H = letter[1]
LABEL_SIZE = 9


def fixture(path):
    """One row of a form: two labels with blanks after them, inside table lines."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    c.setLineWidth(0.6)
    for y in (180, 200, 220):
        c.line(40, H - y, 572, H - y)
    for x in (40, 306, 572):
        c.line(x, H - 180, x, H - 220)
    c.setFont("Helvetica", LABEL_SIZE)
    c.drawString(48, H - 194, "1. ADULT NAME")
    c.drawString(312, H - 194, "ADDRESS (if different)")
    c.drawString(48, H - 214, "WORK NUMBER")
    c.drawString(200, H - 214, "HOME NUMBER")
    c.save()
    path.write_bytes(buf.getvalue())


def main():
    base, out = sys.argv[1].rstrip("/"), Path(sys.argv[2])
    api = os.environ.get("OPENPDF_CHECK_API", base).rstrip("/")
    browser_name = sys.argv[3] if len(sys.argv) > 3 else "chromium"
    out.mkdir(parents=True, exist_ok=True)
    source = out / "form-row.pdf"
    fixture(source)
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

        def phrases(blob):
            r = ctx.request.post(api + "/v1/pdf/text-layout", multipart={
                "file": {"name": "x.pdf", "mimeType": "application/pdf", "buffer": blob}, "pages": "1"})
            assert r.ok, r.text()
            return r.json()["pages"][0]["phrases"]

        def open_pdf(path):
            page.set_input_files("#fileInput", str(path))
            page.wait_for_function(
                "name => activeDoc()?.name === name && activeDoc()?.documentId && activeDoc()?.pdfDoc", arg=path.name)
            page.evaluate("() => activeDoc()._registerPromise")
            page.wait_for_function("() => activeDoc()._editorSnapshot !== undefined")

        def point(x, y):
            """A point of page 1 (PDF points from the top left) on the screen."""
            shell = page.locator('.page-shell[data-page="1"]')
            scale = float(shell.get_attribute("data-scale"))
            box = shell.bounding_box()
            return box["x"] + x * scale, box["y"] + y * scale

        def save(name):
            with page.expect_download() as download:
                page.keyboard.press("Control+s")
            path = out / name
            download.value.save_as(path)
            page.wait_for_function("() => !activeDoc()._saving")
            return path

        editor = page.locator(".inline-text-editor")
        page.goto(base)
        open_pdf(source)
        page.click('[data-mode="cover-text"]')

        # 1. the blank after "ADDRESS (if different)": a box on that line, in its size
        label_end = 312 + 9 * 0.5 * len("ADDRESS (if different)")  # about where the label ends
        page.mouse.click(*point(label_end + 12, 190))
        editor.wait_for()
        box = page.evaluate("""() => { const c = state.inlineTextEditor; return {
            mode: c.mode, size: c.fontSize, y: c.region.y, x: c.region.x }; }""")
        check("a click on the blank after a label opens a box that removes nothing", box["mode"] == "plain", box)
        check("the box takes the label's size", abs(box["size"] - LABEL_SIZE) < 0.6, box)
        baseline = box["y"] + 1 + box["size"] * 0.947
        check("the box sits on the label's line", abs(baseline - 194) < 1.2, round(baseline, 2))
        page.keyboard.type("123 Main St")

        # 2. the mouse selects text in the box; it does not start another box
        b = editor.bounding_box()
        page.mouse.move(b["x"] + 3, b["y"] + b["height"] / 2)
        page.mouse.down()
        page.mouse.move(b["x"] + b["width"] * 0.45, b["y"] + b["height"] / 2, steps=5)
        page.mouse.up()
        selected = page.evaluate("String(getSelection())")
        check("dragging in the box selects its text", selected.strip() != "" and "123" in selected, selected)
        check("and does not start another box", page.locator(".inline-text-editor").count() == 1
              and page.evaluate("activeDoc().placedTexts?.length || 0") == 0)

        # 3. the size and font menus act on the box, which stays open; the text stays on the line
        page.locator("#textFontSizeSelect").focus()
        check("opening the size menu keeps the box open", page.locator(".inline-text-editor").count() == 1)
        page.select_option("#textFontSizeSelect", "12")
        page.wait_for_timeout(200)
        state = page.evaluate("""() => { const c = state.inlineTextEditor; return c && {
            size: c.fontSize, y: c.region.y, focused: document.activeElement === c.editor }; }""")
        check("a new size applies to the box being typed", state and state["size"] == 12, state)
        check("typing goes on in the box after choosing a size", state and state["focused"], state)
        check("a new size keeps the text on the label's line",
              state and abs(state["y"] + 1 + 12 * 0.947 - 194) < 1.2, state)
        page.locator("#textFontFamilySelect").focus()
        page.select_option("#textFontFamilySelect", "Times New Roman")
        page.wait_for_timeout(200)
        page.keyboard.press("End")
        page.keyboard.press("Enter")
        page.wait_for_function("() => activeDoc().placedTexts?.length === 1")
        placed = page.evaluate("() => { const p = activeDoc().placedTexts[0]; return {kind: p.kind, text: p.text, size: p.fontSize, font: p.fontFamily}; }")
        check("saved with the chosen size and font, removing nothing",
              placed == {"kind": "plain", "text": "123 Main St", "size": 12, "font": "Times New Roman"}, placed)

        # 4. the blank between two labels: a box used to be 98 pt wide there and erase
        #    the start of "HOME NUMBER"; what is typed now removes nothing
        page.mouse.click(*point(118, 210))
        editor.wait_for()
        page.keyboard.type("515-0100")
        page.keyboard.press("Enter")
        page.wait_for_function("() => activeDoc().placedTexts?.length === 2")

        # 5. a box typed on empty space can be picked up again with Edit text
        page.mouse.click(*point(label_end + 20, 190))
        editor.wait_for()
        again = page.evaluate("() => ({text: state.inlineTextEditor.editor.textContent, mode: state.inlineTextEditor.mode})")
        check("the typed text is picked up again by Edit text", again == {"text": "123 Main St", "mode": "plain"}, again)
        page.keyboard.press("Escape")

        # 6. a click in the middle of the page's text puts the caret there
        page.mouse.click(*point(48 + 9 * 0.6 * 3, 190))  # inside "1. ADULT NAME", after "1. A"
        editor.wait_for()
        page.keyboard.type("#")
        typed = editor.text_content()
        check("the caret is where the text was clicked", typed.startswith("1.") and not typed.endswith("#") and "#" in typed, typed)
        page.keyboard.press("Escape")

        saved = save("form-row-filled.pdf")
        texts = [p["text"] for p in phrases(saved.read_bytes())]
        check("the labels are all still there",
              all(any(label in t for t in texts) for label in ("ADDRESS (if different)", "HOME NUMBER", "WORK NUMBER", "1. ADULT NAME")),
              texts)
        check("the typed text is in the saved file",
              any("123 Main St" in t for t in texts) and any("515-0100" in t for t in texts), texts)

        check("no uncaught JavaScript errors", not errors, errors)
        ctx.close()
        browser.close()
    (out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if all(r["passed"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
