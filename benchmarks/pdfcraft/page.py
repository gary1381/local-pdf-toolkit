"""PDFCraft's own code in headless Chrome: the harness page that build.sh makes.

    page = PdfCraftPage()                       # the page at PDFCRAFT_URL (serve.py)
    page.redact(pdf_bytes, name, terms, regions) -> {"ok", "pdf" (bytes), "error", "matches"}
    page.markdown(pdf_bytes, name)              -> {"ok", "md", "error"}
"""
import base64
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get("PDFCRAFT_URL", "http://127.0.0.1:28390")


def version():
    try:
        import subprocess  # noqa: PLC0415
        clone = Path.home() / ".cache/openpdf-bench/pdfcraft/pdfcraft"
        return "git " + subprocess.run(["git", "-C", str(clone), "rev-parse", "--short", "HEAD"],
                                       capture_output=True, text=True).stdout.strip()
    except OSError:
        return "?"


class PdfCraftPage:
    def __init__(self, port=9344):
        sys.path.insert(0, str(ROOT / "web" / "test"))
        from cdp import Chrome  # noqa: PLC0415
        self.chrome = Chrome(port=port)
        self.chrome.goto(f"{URL}/index.html")
        if not self.chrome.wait_for("window.__PCH === true", 30):
            raise RuntimeError(f"the PDFCraft harness did not load from {URL} (build.sh, then serve.py)")

    def _call(self, fn, pdf, name, *args):
        b64 = base64.b64encode(pdf).decode()
        rest = "".join(", " + json.dumps(a) for a in args)
        return self.chrome.js(f"{fn}('{b64}', {json.dumps(name)}{rest})")

    def redact(self, pdf, name, terms, regions):
        out = self._call("pcRedact", pdf, name, terms, regions)
        if out.get("ok"):
            out["pdf"] = base64.b64decode(out["pdf"])
        return out

    def markdown(self, pdf, name):
        return self._call("pcMarkdown", pdf, name)

    def close(self):
        self.chrome.close()
