# Redaction comparison

Does the redacted file still give the secret away? This benchmark redacts the
same documents with several tools and then looks for the secrets with tools
that had no part in the redaction.

Results: [RESULTS.md](RESULTS.md) (per case) and [results.json](results.json).
Run of 2026-10-23, OpenPDF as built that day; PDFCraft and PdfCraft added 2026-11-06.

## Summary

| Tool | Clean (of 13) | Where secrets were left |
|---|---|---|
| OpenPDF, desktop / server (PDFBox) | **13** | none |
| OpenPDF, browser (PDFium WASM) | **13** | none |
| PdfCraft 0.18.2 (storytold, Rust), redact + Remove Hidden Information (Sanitize) | **13** | none. But Sanitize removes *every* comment, bookmark, attachment and the document properties, not only those with the secret, and the invisible OCR text of scanned pages (that page is no longer searchable) |
| Stirling-PDF 3.2.1, convert to image | 10 | document properties, XMP, bookmarks; attached file; form field values (but every page becomes a picture: no text left to search or copy) |
| PDFCraft (PDFCraftTool, `e3b231b`), Find & Redact | 10 (1 refused) | a page with `/Rotate` (the box lands in the wrong place, and the page becomes a picture with the number readable); a comment's text painted into the page picture; form field values (it finds no match and makes no file). Every redacted page becomes a JPEG picture: no text left on it |
| PdfCraft 0.18.2 (storytold, Rust), redact only | 10 | comments; properties, XMP, bookmarks (also in old objects left in the file); attached file. Under the marks it removes text, picture pixels, comments and form fields and checks the page |
| PyMuPDF 2.0 + `scrub()` | 9 | comments; bookmarks; attached file; form fields |
| PyMuPDF 2.0, `apply_redactions` | 8 | comments; properties, XMP, bookmarks; `/ActualText`; attached file; form fields |
| Stirling-PDF 3.2.1, auto-redact | 8 | comments; properties, XMP, bookmarks; attached file; form fields; **picture pixels under the box** |
| Stirling-PDF 3.2.1, auto-redact + Sanitize | 8 | comments; bookmarks; attached file (taken off the attachment list, but the catalog's `/AF` still points to it); form fields; picture pixels under the box. Properties and XMP are unlinked but still stored in the file |
| pdf-redactor 0.0.1 | 4 (2 crashes) | shared footer; comments; bookmarks; `/ActualText`; attached file; OCR'd scan pixels |
| Black box drawn on top (control) | 0 | everywhere: shows that the checks find what is left |

Every tool removes ordinary text on the page, including split, rotated and
Chinese text. The differences are in the rest of the file: comments, form
fields, document properties, bookmarks, attached files, text for screen
readers, and the pixels of scanned pages. A user redacting a name expects it
gone from all of these.

## What the comparison found in OpenPDF (fixed before the 2026-10-23 run)

The first runs found two bugs in OpenPDF itself:

- **Server, `/ActualText`:** PDFBox reads text given as marked-content
  `/ActualText` as one character at the span's first glyph. The box covered
  only that glyph, so `078-05-1120` became `78-05-1120` on the page. OpenPDF's
  own final check looks for the whole term, so it passed. Now a match covers
  every glyph of the span, and `scripts/check_redaction_text.py` checks it.
- **Browser, pictures:** before redaction, pictures were copied with LibPDF's
  `getEncodedData()`, which compresses already-compressed data a second time.
  PDFium could not read the copy, and the part of a losslessly compressed
  (Flate) picture outside the box came out black. Nothing leaked, but the page
  was ruined. JPEG pictures were not affected. Now the picture is copied as
  stored, and `web/test/check_web.py` checks it.

## The test documents (`corpus.py`)

13 one- or two-page documents, generated with reportlab, Pillow and pikepdf so
anyone can rebuild and inspect them. Each document comes with:

- the secrets: a name, a US social security number, an e-mail address, and a
  Chinese name and ID number;
- the words that must survive, to see what a tool removes beyond what was
  asked.

| Case | Where the secret is |
|---|---|
| page-text | ordinary page text |
| split-text | a TJ array with kerning, and a name written one letter at a time |
| rotated | text on a page with `/Rotate 90` |
| chinese | text in an embedded CJK font, so the file has no readable bytes of it |
| neighbours | `ID:078-05-1120;Phone 555-0100`: does the neighbouring text survive? |
| shared-form | a footer form XObject used by two pages |
| annotations | a sticky note, a text box comment, a `mailto:` link |
| metadata | document properties, XMP, a bookmark |
| actual-text | marked content `/ActualText` and `/Alt` (what screen readers and copy-paste use) |
| attachment | an attached text file |
| form-field | filled AcroForm fields and their appearances |
| picture | a scanned page: a box drawn over the number (redaction by area) |
| ocr-layer | a scanned page with an invisible OCR text layer over the picture |

Every case asks for the secrets as search terms, except `picture`, which asks
for a box on the page. Each tool is asked the way its documentation shows.

## The checks (`check.py`)

A secret counts as left when any of these finds it:

- **text extraction** with poppler (`pdftotext`), pdfminer.six and pypdf;
- **every object in the file**, streams decompressed, including objects the
  document no longer uses but that are still stored (anyone reading the file
  finds them). Inside page content only the text strings are searched, so
  numbers in drawing operators can't join up into a false match. The report
  names the place: page content, form XObject, annotation, form field,
  bookmark, document properties, XMP, attached file, or unreferenced;
- **OCR** (RapidOCR) of every picture in the file, so pixels left under a box
  are found.

Matching ignores case, spaces and punctuation. A secret counts as partly left
when a piece of 60% of its length (at least 5 characters) can still be read.

Two more measures:

- **Words kept:** the words that should survive and can still be read, as
  text or by OCR.
- **Still text:** of those words that were text before, how many still are
  text. Turning pages into pictures removes everything that could be searched
  or copied.

Before any tool is tested, `run.py` runs the checks on the unredacted
documents. They must find every secret and every word to keep, or the run
stops.

## Rerunning

Requirements:

- a Python venv with `pikepdf pdfminer.six pypdf pymupdf rapidocr-onnxruntime reportlab pillow httpx websocket-client pdf-redactor`;
- poppler-utils;
- OpenPDF's dev stack (`engine/tools/devstack.sh start`; gateway on 28090);
- the browser version served (`cd web && node build.mjs --serve`; 28300) and Google Chrome;
- Stirling-PDF;
- PdfCraft's `pdfcraft-cli` (release tarball; `PDFCRAFT_RS_CLI`);
- the PDFCraft harness (`../pdfcraft/build.sh`, then `python3 ../pdfcraft/serve.py ~/.cache/openpdf-bench/pdfcraft/www 28390`).

```bash
podman run -d --name openpdf-bench-stirling -p 127.0.0.1:28380:8080 \
  -e DOCKER_ENABLE_SECURITY=false docker.io/stirlingtools/stirling-pdf:latest
python run.py /tmp/redaction-bench            # or: python run.py OUT pymupdf stirling ...
python check.py OUT/corpus/metadata.pdf OUT/corpus/cases.json   # the checks on one file
```

`OPENPDF_GATEWAY`, `OPENPDF_WEB`, `STIRLING_URL` and `PDFCRAFT_URL` change the addresses.

## Limits

- **We wrote the test documents and the checks, and OpenPDF is ours.** The
  cases are places where redaction is known to go wrong, chosen without
  looking at the other tools first. The scripts are here so others can check
  them, or add cases where OpenPDF fails.
- **13 small synthetic documents** are not real-world files. Each tool was
  tested in one version, with the settings its documentation shows. Some
  tools have separate clean-up steps, so PyMuPDF `scrub()` and Stirling-PDF
  Sanitize were tested too; a user who knows to add more steps may do better.
- **Not tested yet:** Adobe Acrobat, PDF24, Foxit, pdfedit.com and Omitly.
  They are desktop or web applications without an API that can be run here.
- **Picture redaction in the browser converts CMYK pictures to RGB.** The
  colours change slightly; nothing leaks.
- PDFCraft runs as its own code (Find & Redact: its search, then its redaction with the defaults its
  tools use) in headless Chrome; regions join the same call as boxes, as its Redact tool draws them.
- PyMuPDF and PDFCraft (AGPL) and the other tools are only run here as tools under test.
  None of them is part of OpenPDF.
