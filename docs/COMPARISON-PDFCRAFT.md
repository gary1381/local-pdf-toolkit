# OpenPDF compared with PDFCraft and PdfCraft

As of 2026-11-06. Two unrelated open-source projects use the name:

- **PDFCraft** ([PDFCraftTool/pdfcraft](https://github.com/PDFCraftTool/pdfcraft)): a browser
  toolbox in TypeScript (Next.js, pdf.js, pdf-lib, PyMuPDF compiled to WebAssembly). AGPL-3.0.
- **PdfCraft** ([storytold/pdfcraft](https://github.com/storytold/pdfcraft), from the ArtCraft
  team; `kostyk348/pdfcraft` is a fork of it): a native PDF reader and editor written from
  scratch in Rust. MIT or Apache-2.0.

Both are compared here with OpenPDF from their READMEs and source code, and where we could run
their code, with OpenPDF's own benchmarks: [redaction](../benchmarks/redaction/README.md) and
[parsing](../benchmarks/parsing/README.md) (olmOCR-Bench).

## At a glance

| | OpenPDF | PDFCraft (PDFCraftTool) | PdfCraft (storytold) |
|---|---|---|---|
| What it is | Editor for people, REST API and MCP for agents, document structure for AI | Browser toolbox, 90+ single-purpose tools, workflow editor | Native workbench: reader, organizer, comments, forms, redaction; CLI and MCP |
| Started / activity | 2026 | Jan 2026; releases almost daily | 30 Sep 2026; ~4,400 commits in 5 weeks, 3,000+ open issues |
| GitHub stars | not public yet | ~9,800 | ~19,800 |
| Licence | every bundled component allows commercial use | **AGPL-3.0** (PyMuPDF is AGPL) | MIT or Apache-2.0 |
| Platforms | Linux (.deb, AppImage), browser version, server (containers); Windows and macOS not yet | Windows, macOS, Linux (Tauri), static website, Docker | Windows (x64, x86, ARM64, signed), macOS (notarized), Linux (5 formats), FreeBSD, web |
| Where the work happens | local services (PDFBox, qpdf, OCR, Docling) or WebAssembly in the browser version | in the browser (WebAssembly) | in one native binary |
| For agents | REST API, 29 MCP tools | none | CLI with JSON-Schema tools, MCP (opt-in, `--root` sandbox), remote control of the app |
| PDF to Markdown for AI (olmOCR-Bench) | **53.5**, or **67.5** with the reading model: layout and table models, OCR of scans and pictures | 24.3: pdf.js text lines, headings by font size, aligned rows made tables; no OCR | 27.4: rule-based layout from the text layer; no OCR |
| OCR | OCRmyPDF + RapidOCR (Latin and Chinese); optional PaddleOCR-VL | tesseract.js in the browser | `ocrs` (Latin) and an installed Tesseract; "OCR beyond Latin script" listed as missing |
| Edit existing text | old text removed, new text drawn; works for Chinese | claimed in-place editing (an embedded "EditCore WASM" editor, not checked) | listed as "thin or missing", especially CJK and right-to-left |
| Redaction (13 cases) | **13 clean** in one step; text kept; only copies holding the secret removed | 10 clean; redacted pages become JPEG pictures | 10 clean; **13** with Sanitize, which also deletes all comments, bookmarks, attachments and a scan's OCR text |
| Breadth | ~20 kinds of task | **90+ tools** incl. Office, e-book and image conversion | wide and growing; self-assessed **alpha** (57 % of tracked features) |

## What we measured

### Redaction

The same 13 documents and checks as every other tool in the
[redaction benchmark](../benchmarks/redaction/RESULTS.md).

| Tool | Clean (of 13) | Secrets left | Text still searchable |
|---|---|---|---|
| OpenPDF (desktop / server and browser) | **13** | none | 100 % |
| PdfCraft 0.18.2 (Rust), redact + Sanitize | **13** | none | 94 % (the OCR text of a scan is removed) |
| PdfCraft 0.18.2 (Rust), redact only | 10 | comments; properties, XMP, bookmarks; attached file | 100 % |
| PDFCraft (PDFCraftTool, `e3b231b`), Find & Redact | 10 (+1 refused) | see below | **0 %** (pages become pictures) |
| Stirling-PDF, convert to image | 10 | properties, XMP, bookmarks, attachment, form fields | 0 % |
| PyMuPDF + `scrub()` | 9 | comments, bookmarks, attachment, form fields | 94 % |

PDFCraft draws the boxes, renders every page that has one to a JPEG picture, strips the document
properties, XMP, comments and form fields, and builds a new file (bookmarks and attachments are
not copied). That closes most hiding places, but:

- **Rotated page (`/Rotate 90`):** the box lands in the wrong place. The page becomes a picture
  with the social security number in plain view.
- **Comments:** its search reads only the page text, so the number in a text-box comment is
  never boxed, and rendering the page paints the comment into the picture before the comments
  are deleted.
- **Form fields:** the search does not see field values; it reports "No matches" and makes no
  file.
- Every redacted page loses its text: nothing on it can be searched or copied any more.

PdfCraft (Rust), run through its `pdfcraft-cli` (`redact_mark` with the words or boxes,
`redact_apply`, `doc_save`), is the closest to OpenPDF of any tool tested. Under the marks it
cuts the glyphs out, clears picture pixels, removes comments and form fields, and checks the
page afterwards; the text stays text. Copies of the secret elsewhere in the file (a comment
somewhere else, the document properties, XMP, bookmarks, an attached file) stay until its
**Remove Hidden Information** (Sanitize) is run as well. With it, all 13 cases are clean, but
Sanitize works by category, not by content: it deletes *every* comment, bookmark, attachment
and the document properties, and the invisible OCR text of scanned pages, so a redacted scan is
no longer searchable. OpenPDF removes only the copies that contain the secret, in one step.

### PDF to Markdown (olmOCR-Bench, 1,403 pages)

Full table: [benchmarks/parsing/RESULTS.md](../benchmarks/parsing/RESULTS.md).

| System | Overall | Tables | Multi-column | Long tiny text | Headers / footers | Old scans | s/page (median) |
|---|---|---|---|---|---|---|---|
| OpenPDF, with the reading model | **67.5** | 76.0 | 69.2 | 78.7 | 88.6 | 32.3 | 6.1 (CPU + GPU: model on an RTX 3060) |
| OpenPDF, default | **53.5** | 70.9 | 69.6 | 76.2 | 88.7 | 24.3 | 7.8 (CPU only) |
| PyMuPDF4LLM (for reference) | 37.7 | 61.4 | 66.7 | 33.7 | 38.9 | 13.3 | 2.4 (CPU) |
| PdfCraft 0.18.2 (Rust), Export to Markdown | 27.4 | 27.1 | 42.4 | 10.9 | 37.6 | 13.3 | **0.02** (CPU) |
| PDFCraft (PDFCraftTool), PDF to Markdown | 24.3 | 32.6 | 5.8 | 3.2 | 52.0 | 13.3 | 0.12 (CPU, in Chrome) |

The reading model's time is with the model on a GPU; the default mode uses the CPU only. The model
only adds work (the default pipeline runs first, then the model reads tables, formulas and scans
again), so it is not faster: the two runs were made on different days under different load.

Neither reads scanned pages (no OCR in their Markdown export; 180 of 1,403 pages come out empty).
PDFCraft makes any rows of aligned text into a table, so two-column pages and long small print
become tables whose cells mix the columns (multi-column 5.8). PdfCraft keeps paragraphs and
headings but finds few tables. Both are 100–400 times faster per page than OpenPDF's default
mode: they read the text layer only, where OpenPDF runs a layout model, a table model and OCR.

## Where OpenPDF is ahead

1. **Documents for AI.** On olmOCR-Bench OpenPDF scores 53.5 by default and 67.5 with the
   reading model, against 27.4 (PdfCraft) and 24.3 (PDFCraft). Neither uses a layout or table
   model, and neither reads scanned pages into Markdown. This is the widest gap.
2. **Redaction that removes every copy and keeps the rest.** 13 of 13 clean in one step, with
   all text kept and nothing removed that does not hold the secret. PdfCraft reaches 13 only by
   adding Sanitize, which deletes all comments, bookmarks, attachments and a scan's OCR text;
   PDFCraft turns pages into pictures and still leaks in two cases. The gap to PdfCraft is
   narrow and could close quickly.
3. **Chinese.** OCR, editing existing text and redaction all handle Chinese. PdfCraft lists OCR
   beyond Latin script and CJK text editing as missing; its Chinese interface font is still to come.
4. **An API a server can call.** OpenPDF runs as a service with REST and MCP; PDFCraft has
   neither. (PdfCraft has a CLI and MCP, so this holds only against PDFCraft.)
5. **Licence, against PDFCraft:** AGPL keeps PDFCraft out of closed products unless their source
   is published.

## Where they are ahead

- **Installers and reach:** both ship signed builds for Windows and macOS; ours are still to do.
- **Speed of reading text:** their Markdown export takes 0.02–0.12 s a page (text layer only), OpenPDF's default mode about 8 s.
- **Breadth:** PDFCraft's 90+ tools (Office and e-book conversion, N-up, booklets, workflows).
- **Speed of development:** PdfCraft's ~4,400 commits in five weeks and a native Rust engine
  with fuzzing, incremental and atomic saves, forms authoring, signatures and an accessibility
  checker. It is the stronger competitor: permissive licence, agent tools, careful redaction.
- **Community:** ~10,000 and ~20,000 stars.

## What this means

General PDF tools are now cheap to build, and both projects show it. OpenPDF should not compete
on the number of tools. Its case rests on what is measured above: Markdown for AI that holds up
on a public benchmark, redaction that is clean and keeps the text, and Chinese support. These
have to stay ahead of PdfCraft, which is moving fast and aims at the same agent users.

Next:

- Windows and macOS installers before release (both competitors have signed ones);
- rerun both benchmarks on new PdfCraft releases: it is moving fast, and its roadmap lists
  OCR beyond Latin script and editing existing text next.

## How the numbers were made

- **PDFCraft:** its own processors (`find-and-redact.ts`, `redact.ts`, `pdf-to-markdown.ts`),
  bundled with the pdf-lib and pdf.js versions its lockfile pins, run in headless Chrome
  ([benchmarks/pdfcraft](../benchmarks/pdfcraft/build.sh)); its install scripts are not run.
  Options are the defaults its tools use.
- **PdfCraft:** the release `pdfcraft-cli-0.18.2-linux-x86_64.tar.gz` (checksum checked against
  its `SHA256SUMS.txt`), called through `pdfcraft-cli run --script` with the tools its README
  documents.
- Both are only run as tools under test; nothing of them is part of OpenPDF.
- The machine is shared, so the timings are only a rough guide.

Sources: the projects' READMEs and source at the commits named above;
[PDFCraft on Product Hunt](https://www.producthunt.com/products/pdfcraft);
[PdfCraft releases](https://github.com/storytold/pdfcraft/releases).
