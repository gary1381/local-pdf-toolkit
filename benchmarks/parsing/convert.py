"""Turn the benchmark's PDFs into Markdown (or text) with one system, the way an
agent would get them, for olmOCR-Bench to score.

    python convert.py SYSTEM BENCH_DATA [--workers N]

BENCH_DATA is olmOCR-Bench's bench_data folder (pdfs/ and the *.jsonl tests).
Writes BENCH_DATA/SYSTEM/<pdf path>_pg<N>_repeat1.md, one per page; files already
written are kept, so a run can be resumed. Timing per page goes to
BENCH_DATA/SYSTEM/_timing.json.

Systems:
  openpdf-text          OpenPDF page text (PDFBox), as pdf_read_text
  openpdf-text-ordered  the same sorted top-to-bottom, left-to-right (reading_order=true)
  openpdf-markdown      OpenPDF structure add-on (Docling, OpenPDF's settings), as pdf_read_markdown
  openpdf-markdown-ocr  pages without text OCR'd first (pdf_ocr), then pdf_read_markdown:
                        what an agent following the tools' advice does
  openpdf-markdown-auto pdf_read_markdown with its own OCR: scans and the pictures on text pages
                        are OCR'd by the gateway, the text in a picture quoted under it
  openpdf-text-ocr      pages without text OCR'd first, then pdf_read_text (default order: sorting
                        by position mixes the columns of multi-column pages, see RESULTS.md)
  pymupdf4llm           PyMuPDF4LLM to_markdown (a common default in agent stacks; AGPL, only run here)
  pdfcraft-markdown     PDFCraft's PDF to Markdown (pdf.js text, headings by font size; AGPL, only run here;
                        its harness served by benchmarks/pdfcraft/serve.py, PDFCRAFT_URL)
  pdfcraft-rs-markdown  PdfCraft (storytold, Rust) Export to Markdown, through pdfcraft-cli (PDFCRAFT_RS_CLI)
  docling-default       Docling with its default settings (its own OCR on)
  paddleocr-vl          PaddleOCR-VL 1.6 (run with its own venv; PADDLE_DEVICE=cpu without a free GPU)
  indra-ocr             Indra OCR (Datalab, CPU; its own venv; weights not licensed for OpenPDF, only run here)
  indra-ocr-math        the same with --math (formulas as LaTeX)
  structure-at          pages without text OCR'd first, then a structure service at STRUCTURE_URL
                        (a variant started with other settings); use with --name, --only, --base

  --only CAT,CAT  converts only those categories (pdfs/ subfolders); --base SYSTEM copies the
  other categories from that system's outputs, so the overall score stays comparable.

The OpenPDF systems call the gateway (OPENPDF_GATEWAY, default the dev stack).
"""
import argparse
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

GATEWAY = os.environ.get("OPENPDF_GATEWAY", "http://127.0.0.1:28090").rstrip("/")


def _post(path, pdf_bytes, data=None, timeout=900):
    import httpx
    r = httpx.post(f"{GATEWAY}/v1/pdf/{path}", files={"file": ("doc.pdf", pdf_bytes, "application/pdf")},
                   data=data or {}, timeout=timeout)
    r.raise_for_status()
    return r


def _needs_ocr(pdf_bytes):
    pages = _post("page-text", pdf_bytes).json()["pages"]
    return not all((p.get("text") or "").strip() for p in pages)


def _ocr_if_needed(pdf_bytes):
    """OCR the pages without a text layer (the gateway skips pages that have text)."""
    if not _needs_ocr(pdf_bytes):
        return pdf_bytes
    return _post("ocr", pdf_bytes, {"languages": "eng"}, timeout=1800).content


# the "OCR first" systems give the same output as their plain twins wherever no OCR is needed
OCR_TWIN = {"openpdf-markdown-ocr": "openpdf-markdown", "openpdf-text-ocr": "openpdf-text"}


def openpdf_text(pdf_bytes, ordered=False):
    pages = _post("page-text", pdf_bytes, {"sort_by_position": str(ordered).lower()}).json()["pages"]
    return {p["page"]: p.get("text") or "" for p in pages}


def structure_at(pdf_bytes):
    """A structure service variant, called directly (the same JSON as the gateway's /structure)."""
    import httpx
    data = _ocr_if_needed(pdf_bytes)
    url = os.environ["STRUCTURE_URL"].rstrip("/")
    r = httpx.post(f"{url}/convert", files={"file": ("doc.pdf", data, "application/pdf")}, timeout=3600)
    r.raise_for_status()
    return {p["page"]: p.get("markdown") or "" for p in r.json()["pages"]}


def openpdf_markdown(pdf_bytes, model=False):
    pages = _post("structure", pdf_bytes, {"model": str(model).lower()}).json()["pages"]
    return {p["page"]: p.get("markdown") or "" for p in pages}


SYSTEMS = {
    "openpdf-text": lambda b: openpdf_text(b),
    "openpdf-text-ordered": lambda b: openpdf_text(b, ordered=True),
    "openpdf-markdown": openpdf_markdown,
    "openpdf-markdown-ocr": lambda b: openpdf_markdown(_ocr_if_needed(b)),
    # pdf_read_markdown as it is now: the gateway OCRs scans and the pictures on text
    # pages itself, and puts the text read in a picture under it
    "openpdf-markdown-auto": openpdf_markdown,
    # the same, with tables and formulas read again by the document OCR model
    # (the structure service started with OPENPDF_VLM_URL)
    "openpdf-markdown-model": lambda b: openpdf_markdown(b, model=True),
    "openpdf-text-ocr": lambda b: openpdf_text(_ocr_if_needed(b)),
}


def pymupdf4llm_pages(pdf_bytes):
    import pymupdf
    import pymupdf4llm
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    chunks = pymupdf4llm.to_markdown(doc, page_chunks=True)
    return {i + 1: c.get("text", "") for i, c in enumerate(chunks)}


_docling = threading.local()


def docling_default_pages(pdf_bytes):
    from io import BytesIO
    from docling.datamodel.base_models import DocumentStream
    from docling.document_converter import DocumentConverter
    if not hasattr(_docling, "conv"):
        _docling.conv = DocumentConverter()
    res = _docling.conv.convert(DocumentStream(name="doc.pdf", stream=BytesIO(pdf_bytes)))
    doc = res.document
    return {n: doc.export_to_markdown(page_no=n) for n in sorted(doc.pages)} or {1: doc.export_to_markdown()}


_pdfcraft = {"lock": threading.Lock(), "page": None}


def pdfcraft_markdown(pdf_bytes):
    """PDFCraft's PDF to Markdown, its own code in headless Chrome (benchmarks/pdfcraft); one page at a time."""
    with _pdfcraft["lock"]:
        if _pdfcraft["page"] is None:
            sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pdfcraft"))
            from page import PdfCraftPage
            _pdfcraft["page"] = PdfCraftPage()
        out = _pdfcraft["page"].markdown(pdf_bytes, "doc.pdf")
    if not out.get("ok"):
        raise RuntimeError(out.get("error", "failed"))
    return {1: out["md"]}  # the benchmark's PDFs are one page each


PDFCRAFT_RS = os.environ.get("PDFCRAFT_RS_CLI", str(Path.home() / ".cache/openpdf-bench/pdfcraft-rs/bin/pdfcraft-cli-0.18.2-linux-x86_64/pdfcraft-cli"))


def pdfcraft_rs_markdown(pdf_bytes):
    """PdfCraft (Rust): doc_open, then doc_export_office to a .md file, through its CLI."""
    import subprocess
    import tempfile
    with tempfile.TemporaryDirectory() as work:
        (Path(work) / "in.pdf").write_bytes(pdf_bytes)
        steps = [{"tool": "doc_open", "args": {"path": "in.pdf"}},
                 {"tool": "doc_export_office", "args": {"doc": 1, "path": "out.md"}}]
        (Path(work) / "steps.json").write_text(json.dumps(steps))
        p = subprocess.run([PDFCRAFT_RS, "run", "--script", "steps.json", "--root", work, "--report"],
                           capture_output=True, text=True, cwd=work, timeout=600)
        report = json.loads(p.stdout)
        if not report.get("ok"):
            raise RuntimeError(json.dumps(report)[-300:])
        return {1: (Path(work) / "out.md").read_text(encoding="utf-8")}  # one page per benchmark PDF


SYSTEMS["pymupdf4llm"] = pymupdf4llm_pages
SYSTEMS["pdfcraft-markdown"] = pdfcraft_markdown
SYSTEMS["pdfcraft-rs-markdown"] = pdfcraft_rs_markdown
SYSTEMS["structure-at"] = structure_at
SYSTEMS["docling-default"] = docling_default_pages


_paddle = threading.local()


def paddleocr_vl_pages(pdf_bytes):
    """PaddleOCR-VL 1.6 (Apache-2.0): layout model plus a 0.9B vision-language model
    that writes text, tables and LaTeX. PADDLE_DEVICE=cpu where the GPU is busy."""
    import tempfile
    from paddleocr import PaddleOCRVL
    if not hasattr(_paddle, "pipe"):
        _paddle.pipe = PaddleOCRVL(pipeline_version="v1.6", device=os.environ.get("PADDLE_DEVICE", "gpu"))
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(pdf_bytes)
        f.flush()
        results = list(_paddle.pipe.predict(f.name))
    return {i + 1: (r.markdown or {}).get("markdown_texts", "") for i, r in enumerate(results)}


SYSTEMS["paddleocr-vl"] = paddleocr_vl_pages


_indra = threading.local()


def indra_ocr_pages(pdf_bytes, math=False):
    """Indra OCR (Datalab; code Apache-2.0, weights modified OpenRAIL-M: no use by
    competitors or companies over $20M, so only run here). CPU, ONNX Runtime, its
    default auto mode (text layer where it passes its checks, OCR elsewhere).
    INDRA_OCR_MODEL_DIR: a local copy of the models. PDFium is not thread-safe: run
    with --workers 1 (one page at a time, INDRA_THREADS threads, default 4, as
    Datalab times it)."""
    import tempfile
    import indra_ocr
    key = "math" if math else "plain"
    if not hasattr(_indra, key):
        setattr(_indra, key, indra_ocr.load(threads=int(os.environ.get("INDRA_THREADS", "4")), math=math))
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(pdf_bytes)
        f.flush()
        return {i + 1: page.markdown or "" for i, page in getattr(_indra, key).convert(f.name)}


SYSTEMS["indra-ocr"] = indra_ocr_pages
SYSTEMS["indra-ocr-math"] = lambda b: indra_ocr_pages(b, math=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("system", choices=sorted(SYSTEMS))
    ap.add_argument("bench_data", type=Path)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--limit", type=int, default=0, help="only the first N PDFs (a quick try)")
    ap.add_argument("--name", help="output folder (default: the system's name)")
    ap.add_argument("--only", default="", help="only these categories, e.g. tables,multi_column")
    ap.add_argument("--base", help="copy the other categories from this system's outputs")
    ap.add_argument("--sample", type=int, default=0, help="a fixed random sample of N PDFs per category (slow variants)")
    args = ap.parse_args()
    pdf_root = args.bench_data / "pdfs"
    out_root = args.bench_data / (args.name or args.system)
    pdfs = sorted(pdf_root.rglob("*.pdf"))
    if args.only:
        cats = set(args.only.split(","))
        if args.base:
            base = args.bench_data / args.base
            for src in base.rglob("*.md"):
                if src.relative_to(base).parts[0] not in cats:
                    dst = out_root / src.relative_to(base)
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    if not dst.exists():
                        dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
            base_timing = json.loads((base / "_timing.json").read_text())
            out_root.mkdir(parents=True, exist_ok=True)
            t = out_root / "_timing.json"
            if not t.exists():
                t.write_text(json.dumps({k: v for k, v in base_timing.items() if k.split("/")[0] not in cats}))
        pdfs = [p for p in pdfs if p.relative_to(pdf_root).parts[0] in cats]
    if args.sample:
        import random
        picked = []
        for cat in sorted({p.relative_to(pdf_root).parts[0] for p in pdfs}):
            group = [p for p in pdfs if p.relative_to(pdf_root).parts[0] == cat]
            picked += random.Random(1).sample(group, min(args.sample, len(group)))
        pdfs = sorted(picked)
    if args.limit:
        pdfs = pdfs[: args.limit]
    convert = SYSTEMS[args.system]
    timing, failures, lock = {}, [], threading.Lock()

    def one(pdf):
        rel = pdf.relative_to(pdf_root).with_suffix("")
        first = out_root / f"{rel}_pg1_repeat1.md"
        if first.exists():
            return
        t0 = time.time()
        twin = OCR_TWIN.get(args.system)
        if twin and (args.bench_data / twin / f"{rel}_pg1_repeat1.md").exists():
            data = pdf.read_bytes()
            if not _needs_ocr(data):
                first.parent.mkdir(parents=True, exist_ok=True)
                for src in (args.bench_data / twin / rel.parent).glob(f"{rel.name}_pg*_repeat1.md"):
                    (out_root / rel.parent / src.name).write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
                twin_timing = json.loads((args.bench_data / twin / "_timing.json").read_text()).get(str(rel), {})
                with lock:
                    timing[str(rel)] = twin_timing | {"reused": twin}
                return
        try:
            pages = convert(pdf.read_bytes())
        except Exception as exc:  # noqa: BLE001 - a failed page scores as empty, like a crash would
            with lock:
                failures.append(f"{rel}: {type(exc).__name__}: {str(exc)[:200]}")
            pages = {1: ""}
        seconds = time.time() - t0
        first.parent.mkdir(parents=True, exist_ok=True)
        for n, text in (pages or {1: ""}).items():
            (out_root / f"{rel}_pg{n}_repeat1.md").write_text(text or "", encoding="utf-8")
        with lock:
            timing[str(rel)] = {"seconds": round(seconds, 3), "pages": len(pages or {1: ""})}

    t0 = time.time()
    with ThreadPoolExecutor(args.workers) as pool:
        for i, _ in enumerate(pool.map(one, pdfs), 1):
            if i % 100 == 0:
                print(f"{args.system}: {i}/{len(pdfs)} ({time.time() - t0:.0f}s)", flush=True)
    out_root.mkdir(parents=True, exist_ok=True)
    timing_file = out_root / "_timing.json"
    old = json.loads(timing_file.read_text()) if timing_file.exists() else {}
    old.update(timing)
    timing_file.write_text(json.dumps(old, indent=1))
    (out_root / "_failures.txt").write_text("\n".join(failures))
    print(f"{args.system}: {len(pdfs)} PDFs, {len(failures)} failed, {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    sys.exit(main())
