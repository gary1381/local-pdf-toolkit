#!/usr/bin/env python3
"""The editor's side of saving in the desktop app, simulated in a browser.

Usage: python scripts/check_desktop_save.py BASE FIXTURES OUT [chromium|firefox]

In the desktop app a save is a download that the app writes to disk; it then
calls window.__openpdfSaved(path, url) or __openpdfSaveFailed(url). Checked:
the document counts as saved only once the write is confirmed, only if
nothing changed meanwhile, and a failure marks the document that was being
saved, not whichever tab is open.
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


def main():
    base, fixtures, out = sys.argv[1].rstrip("/"), Path(sys.argv[2]), Path(sys.argv[3])
    browser_name = sys.argv[4] if len(sys.argv) > 4 else "chromium"
    out.mkdir(parents=True, exist_ok=True)
    results = []

    def check(name, ok, detail=""):
        results.append({"name": name, "passed": bool(ok), "detail": detail})
        print(f'{"PASS" if ok else "FAIL"} {name}{": " + str(detail) if detail else ""}', flush=True)

    with sync_playwright() as pw:
        browser = getattr(pw, browser_name).launch()
        ctx = browser.new_context(accept_downloads=True, viewport={"width": 1280, "height": 900})
        ctx.add_init_script("window.__openpdfDesktop = true")
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base)

        def open_pdf(path):
            page.set_input_files("#fileInput", str(path))
            page.wait_for_function("name => activeDoc()?.name === name && activeDoc()?.documentId", arg=path.name)
            page.evaluate("() => activeDoc()._registerPromise")

        def save():
            with page.expect_download() as download:
                page.keyboard.press("Control+s")
            page.wait_for_function("() => !activeDoc()._saving")
            return download.value.url

        def dirty(name):
            return page.evaluate("name => state.docs.find((d) => d.name === name).dirty", name)

        def edit():
            page.evaluate("() => { activeDoc().dirty = true; }")

        open_pdf(fixtures / "contract.pdf")
        edit()
        url = save()
        check("not marked saved before the app confirms", dirty("contract.pdf") is True)
        page.evaluate("url => window.__openpdfSaved('/tmp/contract.pdf', url)", url)
        check("marked saved once the app confirms", dirty("contract.pdf") is False)

        edit()
        url = save()
        edit()  # typed on while the file was being written
        page.evaluate("url => window.__openpdfSaved('/tmp/contract.pdf', url)", url)
        check("a change made during the write keeps it unsaved", dirty("contract.pdf") is True)

        url = save()
        open_pdf(fixtures / "form.pdf")  # another tab is in front when the result comes
        page.wait_for_timeout(2000)  # let the opening finish and say so in the status bar first
        page.evaluate("url => window.__openpdfSaveFailed(url)", url)
        check("a failed write marks the document that was saved",
              dirty("contract.pdf") is True and dirty("form.pdf") is False)
        status = page.locator("#statusMessage").inner_text()
        check("and names it", "contract.pdf" in status, status)
        page.evaluate("() => window.__openpdfSaveFailed('blob:not-a-save')")
        check("a failed export marks no document", dirty("form.pdf") is False)
        # another port than last time: the editor says its settings may be missing
        page.goto(base + "/ui/index.html?portChanged=1" if "/ui" not in base else base + "?portChanged=1")
        page.wait_for_selector(".toast")
        check("a changed port is reported", "port" in page.locator(".toast").inner_text().lower()
              and "portChanged" not in page.url, page.url)
        check("no uncaught JavaScript errors", not errors, errors)
        ctx.close()
        browser.close()
    (out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if all(r["passed"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
