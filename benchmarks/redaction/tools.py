"""The redaction tools under test, each asked the way its documentation shows.

Every tool gets the same request: the secrets as words to find ("terms"), or
boxes on the page ("regions", points from the top left of the page as
displayed). run(src, case, dst) writes the redacted PDF to dst and returns
{"status": "ok" | "refused" | "error" | "n/a", "note": ...}. "refused" means
the tool declined to produce a file and said why (not a leak).
"""
import base64
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
GATEWAY = os.environ.get("OPENPDF_GATEWAY", "http://127.0.0.1:28090")
WEB = os.environ.get("OPENPDF_WEB", "http://127.0.0.1:28300")
STIRLING = os.environ.get("STIRLING_URL", "http://127.0.0.1:28380")


def _git_rev():
    try:
        return subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
    except OSError:
        return "?"


def _openpdf_answer(status, body, dst):
    if status != 200:
        try:
            msg = json.loads(body).get("detail", "")
        except Exception:  # noqa: BLE001
            msg = body[:300].decode("utf-8", "replace") if isinstance(body, bytes) else str(body)[:300]
        return {"status": "refused" if 400 <= status < 500 else "error", "note": f"HTTP {status}: {msg}"}
    head, rest = body.split(b"\n", 1)
    n = int(head.split()[1])
    report, pdf = json.loads(rest[:n]), rest[n:]
    dst.write_bytes(pdf)
    return {"status": "ok", "note": "", "report": report}


class OpenPdfServer:
    key, label = "openpdf-server", "OpenPDF (desktop / server, PDFBox)"
    terms = regions = True

    def version(self):
        return f"git {_git_rev()}"

    def run(self, src, case, dst):
        r = httpx.post(f"{GATEWAY}/v1/pdf/redact", files={"file": (src.name, src.read_bytes(), "application/pdf")},
                       data={"terms": json.dumps(case["terms"]), "regions": json.dumps(case["regions"])}, timeout=600)
        return _openpdf_answer(r.status_code, r.content, dst)


class OpenPdfBrowser:
    """The browser version, in headless Chrome: the same request the editor makes, answered in the page."""
    key, label = "openpdf-browser", "OpenPDF (browser, PDFium WASM)"
    terms = regions = True
    chrome = None

    def version(self):
        return f"git {_git_rev()}"

    def _page(self):
        if OpenPdfBrowser.chrome is None:
            sys.path.insert(0, str(ROOT / "web" / "test"))
            from cdp import Chrome  # noqa: PLC0415
            c = Chrome(port=9343)
            c.goto(f"{WEB}/ui/index.html")
            if not c.wait_for("window.__OPENPDF_WEB === true", 30):
                raise RuntimeError("the browser version did not load")
            OpenPdfBrowser.chrome = c
        return OpenPdfBrowser.chrome

    def run(self, src, case, dst):
        c = self._page()
        b64 = base64.b64encode(src.read_bytes()).decode()
        out = c.js(f"""(async () => {{
          const bytes = Uint8Array.from(atob('{b64}'), (ch) => ch.charCodeAt(0));
          const fd = new FormData();
          fd.append('file', new File([bytes], {json.dumps(src.name)}, {{type: 'application/pdf'}}));
          fd.append('terms', {json.dumps(json.dumps(case["terms"]))});
          fd.append('regions', {json.dumps(json.dumps(case["regions"]))});
          const r = await fetch('/v1/pdf/redact', {{method: 'POST', body: fd}});
          const buf = new Uint8Array(await r.arrayBuffer());
          let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          return {{status: r.status, body: btoa(s)}};
        }})()""")
        return _openpdf_answer(out["status"], base64.b64decode(out["body"]), dst)

    @classmethod
    def close(cls):
        if cls.chrome:
            cls.chrome.close()
            cls.chrome = None


def _fitz():
    import pymupdf  # noqa: PLC0415 - AGPL; only run here as a tool under test, never bundled
    return pymupdf


def _pymupdf_marks(doc, case, add):
    pymupdf = _fitz()
    for page in doc:
        for t in case["terms"]:
            for rect in page.search_for(t):
                add(page, rect)
        for r in case["regions"]:
            if r["page"] == page.number + 1:
                # regions are in displayed points from the top left; PyMuPDF's
                # page coordinates are unrotated, top left (no rotated page here)
                add(page, pymupdf.Rect(r["x"], r["y"], r["x"] + r["width"], r["y"] + r["height"]))


class PyMuPdf:
    """The recipe of PyMuPDF's documentation: search_for, add_redact_annot, apply_redactions."""
    key, label = "pymupdf", "PyMuPDF (apply_redactions)"
    terms = regions = True
    scrub = False

    def version(self):
        return _fitz().VersionBind

    def run(self, src, case, dst):
        doc = _fitz().open(src)
        _pymupdf_marks(doc, case, lambda page, rect: page.add_redact_annot(rect, fill=(0, 0, 0)))
        for page in doc:
            page.apply_redactions()
        if self.scrub:
            doc.scrub()
        doc.save(dst, garbage=3, deflate=True)
        return {"status": "ok", "note": ""}


class PyMuPdfScrub(PyMuPdf):
    """The same, then Document.scrub() (PyMuPDF's clean-up of metadata, attachments, links, hidden text...)."""
    key, label = "pymupdf-scrub", "PyMuPDF + scrub()"
    scrub = True


class BlackBox:
    """Control: black rectangles drawn over the secrets, nothing removed (what a 'redaction' by drawing does)."""
    key, label = "black-box", "Black box drawn on top (control)"
    terms = regions = True

    def version(self):
        return "-"

    def run(self, src, case, dst):
        doc = _fitz().open(src)
        _pymupdf_marks(doc, case, lambda page, rect: page.draw_rect(rect, color=(0, 0, 0), fill=(0, 0, 0)))
        doc.save(dst)
        return {"status": "ok", "note": ""}


class Stirling:
    """Stirling-PDF's API (self-hosted, in a container): automatic redaction of the words, or of boxes."""
    key, label = "stirling", "Stirling-PDF (auto-redact, keep text)"
    terms = regions = True
    to_image = False

    def version(self):
        try:
            r = httpx.get(f"{STIRLING}/api/v1/info/status", timeout=10)
            return r.json().get("version", "?")
        except Exception:  # noqa: BLE001
            return "?"

    def run(self, src, case, dst):
        files = {"fileInput": (src.name, src.read_bytes(), "application/pdf")}
        if case["terms"]:
            data = {"listOfText": "\n".join(case["terms"]), "useRegex": "false", "wholeWordSearch": "false",
                    "redactColor": "#000000", "customPadding": "0", "convertPDFToImage": str(self.to_image).lower()}
            r = httpx.post(f"{STIRLING}/api/v1/security/auto-redact", files=files, data=data, timeout=600)
        else:
            # a list of RedactionArea objects, bound by Spring from indexed form fields
            data = {"convertPDFToImage": str(self.to_image).lower()}
            for i, g in enumerate(case["regions"]):
                for k in ("x", "y", "width", "height", "page"):
                    data[f"redactions[{i}].{k}"] = str(g[k])
                data[f"redactions[{i}].color"] = "000000"
            r = httpx.post(f"{STIRLING}/api/v1/security/redact", files=files, data=data, timeout=600)
        if r.status_code != 200 or not r.content.startswith(b"%PDF"):
            return {"status": "refused" if 400 <= r.status_code < 500 else "error", "note": f"HTTP {r.status_code}: {r.text[:300]}"}
        dst.write_bytes(r.content)
        return {"status": "ok", "note": ""}


class StirlingImage(Stirling):
    """Stirling-PDF with its 'convert PDF to image' option: the pages become pictures."""
    key, label = "stirling-image", "Stirling-PDF (convert to image)"
    to_image = True


class StirlingSanitized(Stirling):
    """Stirling-PDF's redaction, then its Sanitize tool with every option that keeps the text
    (JavaScript, attached files, XMP, document properties, links; not the fonts)."""
    key, label = "stirling-sanitize", "Stirling-PDF (auto-redact + sanitize)"

    def run(self, src, case, dst):
        res = super().run(src, case, dst)
        if res["status"] != "ok":
            return res
        data = {"removeJavaScript": "true", "removeEmbeddedFiles": "true", "removeXMPMetadata": "true",
                "removeMetadata": "true", "removeLinks": "true", "removeFonts": "false"}
        r = httpx.post(f"{STIRLING}/api/v1/security/sanitize-pdf", files={"fileInput": (src.name, dst.read_bytes(), "application/pdf")},
                       data=data, timeout=600)
        if r.status_code != 200 or not r.content.startswith(b"%PDF"):
            return {"status": "error", "note": f"sanitize: HTTP {r.status_code}: {r.text[:300]}"}
        dst.write_bytes(r.content)
        return {"status": "ok", "note": ""}


class PdfRedactor:
    """JoshData/pdf-redactor: regular expressions over the text of the content streams (and metadata)."""
    key, label = "pdf-redactor", "pdf-redactor (regex on text)"
    terms, regions = True, False

    def version(self):
        try:
            from importlib.metadata import version  # noqa: PLC0415
            return version("pdf-redactor")
        except Exception:  # noqa: BLE001
            return "?"

    def run(self, src, case, dst):
        import io  # noqa: PLC0415
        import pdf_redactor  # noqa: PLC0415
        pattern = re.compile("|".join(re.escape(t) for t in case["terms"]))
        options = pdf_redactor.RedactorOptions()
        options.content_filters = [(pattern, lambda m: "X" * len(m.group(0)))]
        # as its README shows: the document properties filtered too, XMP dropped
        options.metadata_filters = {"ALL": [lambda v: None if v is None else pattern.sub(lambda m: "X" * len(m.group(0)), v.decode() if hasattr(v, "decode") else str(v))]}
        options.xmp_filters = [lambda xml: None]
        options.input_stream = io.BytesIO(src.read_bytes())
        options.output_stream = io.BytesIO()
        pdf_redactor.redactor(options)
        dst.write_bytes(options.output_stream.getvalue())
        return {"status": "ok", "note": ""}


class PdfCraft:
    """PDFCraft's Find & Redact (its own code, in headless Chrome: benchmarks/pdfcraft): pages with a
    redaction become pictures; document properties, XMP, comments and form fields are removed."""
    key, label = "pdfcraft", "PDFCraft (find & redact)"
    terms = regions = True
    page = None

    def version(self):
        sys.path.insert(0, str(ROOT / "benchmarks" / "pdfcraft"))
        import page  # noqa: PLC0415
        return page.version()

    def run(self, src, case, dst):
        if PdfCraft.page is None:
            sys.path.insert(0, str(ROOT / "benchmarks" / "pdfcraft"))
            from page import PdfCraftPage  # noqa: PLC0415
            PdfCraft.page = PdfCraftPage()
        out = PdfCraft.page.redact(src.read_bytes(), src.name, case["terms"], case["regions"])
        if not out.get("ok"):
            return {"status": "refused" if "No matches" in out.get("error", "") else "error", "note": out.get("error", "")}
        dst.write_bytes(out["pdf"])
        return {"status": "ok", "note": f"{out['matches']} boxes"}

    @classmethod
    def close(cls):
        if cls.page:
            cls.page.close()
            cls.page = None


PDFCRAFT_RS = os.environ.get("PDFCRAFT_RS_CLI", str(Path.home() / ".cache/openpdf-bench/pdfcraft-rs/bin/pdfcraft-cli-0.18.2-linux-x86_64/pdfcraft-cli"))


class PdfCraftRs:
    """PdfCraft (storytold, Rust): its CLI's automation tools, as its README shows: redact_mark (the words,
    or a rect per region), redact_apply, doc_save."""
    key, label = "pdfcraft-rs", "PdfCraft (Rust, redact)"
    terms = regions = True
    sanitize = False

    def version(self):
        try:
            return subprocess.run([PDFCRAFT_RS, "--version"], capture_output=True, text=True).stdout.split()[1]
        except (OSError, IndexError):
            return "?"

    def run(self, src, case, dst):
        import shutil  # noqa: PLC0415
        import tempfile  # noqa: PLC0415
        with tempfile.TemporaryDirectory() as work:
            shutil.copy(src, Path(work) / "in.pdf")
            steps = [{"tool": "doc_open", "args": {"path": "in.pdf"}}]
            if case["terms"]:
                steps.append({"tool": "redact_mark", "args": {"doc": 1, "words": case["terms"]}})
            for r in case["regions"]:
                steps.append({"tool": "redact_mark", "args": {"doc": 1, "page": r["page"],
                              "rect": [r["x"], r["y"], r["x"] + r["width"], r["y"] + r["height"]]}})
            steps.append({"tool": "redact_apply", "args": {"doc": 1}})
            if self.sanitize:
                steps.append({"tool": "doc_remove_hidden", "args": {"doc": 1}})
            steps.append({"tool": "doc_save", "args": {"doc": 1, "path": "out.pdf"}})
            (Path(work) / "steps.json").write_text(json.dumps(steps))
            p = subprocess.run([PDFCRAFT_RS, "run", "--script", "steps.json", "--root", work, "--report"],
                               capture_output=True, text=True, cwd=work, timeout=600)
            try:
                report = json.loads(p.stdout)
            except ValueError:
                return {"status": "error", "note": (p.stderr or p.stdout)[:300]}
            if not report.get("ok"):
                bad = next((s for s in report.get("steps", []) if s.get("status") != "ok"), {})
                return {"status": "refused", "note": f"{bad.get('tool')}: {json.dumps(bad.get('error', bad))[:300]}"}
            marked = [s["result"][0].get("marked", 0) for s in report["steps"] if s["tool"] == "redact_mark"]
            shutil.copy(Path(work) / "out.pdf", dst)
        return {"status": "ok", "note": f"{sum(marked)} marks"}


class PdfCraftRsSanitized(PdfCraftRs):
    """The same, then Remove Hidden Information with every category (its Sanitize Document)."""
    key, label = "pdfcraft-rs-sanitize", "PdfCraft (Rust, redact + sanitize)"
    sanitize = True


ALL = [OpenPdfServer(), OpenPdfBrowser(), PyMuPdf(), PyMuPdfScrub(), Stirling(), StirlingSanitized(), StirlingImage(), PdfCraft(),
       PdfCraftRs(), PdfCraftRsSanitized(), PdfRedactor(), BlackBox()]
