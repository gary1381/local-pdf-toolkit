# Reading PDFs for agents: olmOCR-Bench

How well does OpenPDF turn PDF pages into text an agent can use, compared with
other tools? Measured with [olmOCR-Bench](https://huggingface.co/datasets/allenai/olmOCR-bench)
(Ai2, ODC-BY): 1,403 single-page PDFs and about 7,000 pass/fail checks, scored
by the benchmark's own code (`olmocr.bench.benchmark`).

Results: [RESULTS.md](RESULTS.md), [results.json](results.json). Run of 2026-10-23/24 on
the dev stack (OpenPDF at the commit that adds this folder), one machine (CPU for
Docling; RTX 3060 shared with other work).

## Findings

| System | Tables | Old scans | Headers / footers | Multi-column | Long tiny text | Base | Average without the two math categories | Overall (8 categories) | s/page |
|---|---|---|---|---|---|---|---|---|---|
| Docling 2, default settings (OCR on) | 71.1 | 25.1 | 89.9 | 73.8 | 70.8 | 98.9 | 71.6 | 53.7 | 19.0 |
| **OpenPDF `pdf_read_markdown` now (it OCRs scans and pictures itself)** | 70.9 | 24.3 | 88.7 | 69.6 | 76.2 | 98.1 | **71.3** | **53.5** | 7.8 (CPU only) |
| OpenPDF: OCR first, then Markdown | 68.4 | 24.3 | 91.7 | 70.5 | 70.4 | 98.9 | 70.7 | 53.0 | 8.0 |
| OpenPDF Markdown | 64.2 | 13.3 | 92.2 | 70.2 | 52.3 | 93.7 | 64.3 | 48.2 | 6.6 |
| PyMuPDF4LLM 2.0 | 61.4 | 13.3 | 38.9 | 66.7 | 33.7 | 87.2 | 50.2 | 37.7 | 2.4 |
| OpenPDF: OCR first, then text | 0.2 | 18.8 | 39.5 | 58.1 | 67.2 | 97.9 | 46.9 | 35.2 | 0.3 |
| OpenPDF text | 0.1 | 13.3 | 41.7 | 58.1 | 47.1 | 87.3 | 41.3 | 31.0 | 0.3 |
| OpenPDF text, `reading_order=true` | 0.1 | 13.3 | 33.2 | 13.2 | 17.0 | 87.3 | 27.3 | 20.5 | 0.3 |
| *olmOCR (published)* | 70.2 | 44.5 | 93.4 | 79.4 | 81.7 | 99.0 | *78.0* | *77.4* | |
| *Mistral OCR API (published)* | 60.6 | 29.3 | 93.6 | 71.3 | 77.1 | 99.4 | *71.9* | *72.0* | |
| *GPT-4o, anchored (published)* | 70.0 | 40.7 | 93.8 | 69.3 | 60.6 | 96.8 | *71.9* | *69.9* | |
| *Marker v1.6.2 (published)* | 69.8 | 24.3 | 87.1 | 71.0 | 76.9 | 99.5 | *71.4* | *59.4* | |
| *MinerU v1.3.10 (published)* | 60.9 | 17.3 | 96.6 | 59.0 | 39.1 | 96.6 | *61.6* | *61.5* | |

Published rows: the benchmark's own table (olmOCR paper, February 2025, on the
[dataset card](https://huggingface.co/datasets/allenai/olmOCR-bench)); newer
versions report more (olmOCR 2: 82.4, Chandra 2: 85.8, each by its authors).
None of them was run here.

1. **Without formulas, OpenPDF is level with Marker, Mistral OCR and GPT-4o.** With
   OCR first, the Markdown averages 70.7 on the six categories that need no LaTeX,
   against 71.4-71.9 for those three and 78.0 for olmOCR. Its overall 53.0 is low
   because the two math categories (ArXiv math, old scans: math; 3,385 checks)
   score 0: the structure add-on runs without Docling's formula model, so
   formulas come out as plain characters, not LaTeX.
2. **The Markdown is the right default for agents.** It beats plain text by 17
   points (tables 64 vs 0, running headers and footers left out 92 vs 42, columns
   70 vs 58) and PyMuPDF4LLM by 10, at 6-8 s per page on CPU.
3. **OCR first matters: +4.8.** Pages without a text layer (scans, and many of
   the long-tiny-text pages) are empty to the Markdown otherwise. *(Since then
   `pdf_read_markdown` OCRs them itself: see "After these findings".)*
4. **`reading_order=true` makes `pdf_read_text` worse.** Sorting top to bottom
   across the whole width interleaves the columns: multi-column 58 → 13, overall
   31 → 21. The tool's description says it helps with multi-column layouts; it
   does the opposite (it can still help forms laid out in rows). *(The
   description now says so.)*
5. **OpenPDF's Docling settings are faster, not more accurate.** Docling with its
   defaults (its own OCR on every page) scores 53.7, within the margin of OpenPDF's
   53.0, at 19 s per page against 8: a little better on tables (71.1 vs 68.4) and
   columns (73.8 vs 70.5), a little worse on running headers (89.9 vs 91.7).
   OpenPDF's own fixes (heading levels, the title first) are not what this
   benchmark measures.
6. **Old scans are the weakest category** (24 against 29-45 for the others). Two
   causes: plain OCR quality on old typewritten pages, and a bug: the OCR
   add-on cannot read JBIG2 pictures (common in scanned archives). Its
   PyInstaller build leaves out `pikepdf.jbig2`, so OCR fails with "No module
   named 'pikepdf.jbig2'", which the gateway reports as "the PDF could not be
   processed (it may be damaged or unsupported)"; 10 of the 1,403 pages here.
   *(Fixed in the OCR add-on build after 0.2.0; the gateway now says when a
   component is incomplete instead of blaming the file.)*

## After these findings (2026-10-24)

What was tried to close the gaps above, on the same pages:

| Change | Tables | Overall | s/page (tables) | Kept? |
|---|---|---|---|---|
| OpenPDF, OCR first (the run above) | 68.4 | 53.0 | 7-8 | |
| Without OpenPDF's reading-order fix | 68.4 | 53.0 | same | fix kept: it changes 9% of the pages, the score neither way |
| Docling's own OCR on every page (`OPENPDF_STRUCTURE_OCR=1`) | 70.1 | – | about 2.4× slower (Docling with its defaults: 19 s against 8 per page) | no |
| **`pdf_read_markdown` now: scans and pictures on text pages OCR'd by the gateway** | **70.9** | **53.5** | 7.8 s per page over all pages, as before | yes (default) |

- **The table points came from pictures, not from table settings.** OpenPDF's
  table settings are Docling's own (TableFormer, accurate mode, cell
  matching); the only difference to Docling's defaults is OCR. Docling's OCR
  reads every picture region on every page, which recovers most of the gap but
  more than doubles the time. The same points come back without the cost by
  OCRing only what needs it: pages without text, and on pages with text the
  pictures big enough to hold words (OCRmyPDF's redo mode hides the page's own
  text, so only the picture's words are added). That is now the default of
  `pdf_read_markdown`, `pdf_structure` and `pdf_ocr` (`ocr=false` /
  `pictures=false` to skip it), and the text read in a picture is quoted under
  it in the Markdown.
- **What the pictures cost and give.** Overall 53.0 → 53.5 (71.3 without the
  formula categories, against 71.6 for Docling's defaults at less than half
  the time): tables +2.5, long tiny text +5.8 (much of it is printed as
  pictures). Headers and footers lose 3.0: the benchmark counts the words of a
  map's title block or a footer banner as running headers, while for an agent
  they are part of the page. Two rules keep the loss small: pictures wholly in
  the top or bottom 12% of the page (letterheads, logos) are neither OCR'd nor
  quoted, and lone 一 / 十 / 田 that the Chinese-English OCR model reads in chart
  lines are dropped from a picture's text (base checks: 97.6 before that rule,
  98.1 after, 98.9 without picture OCR).
- **Formulas.** Docling's formula model (CodeFormula) writes correct LaTeX, but
  takes 35-390 s per page on CPU (median about 70 s), ten times the rest of
  the reading, so it is not turned on; it fits only as an opt-in or on a GPU.
  PaddleOCR-VL 1.6 (0.9B, Apache-2.0: formulas, tables and scans in one model)
  is the other candidate; it was not run here yet (its 1.5 GB runtime and 2 GB
  of weights could not be downloaded on the day's connection).

## With a document OCR model (2026-10-24)

`openpdf-markdown-model`: the same reading with PaddleOCR-VL 1.6 (Q4 GGUF,
llama.cpp, on the RTX 3060) re-reading tables, formulas, paragraphs with
mathematics and the text of scanned pages (design and checks:
[docs/OCR-MODELS.md](../../docs/OCR-MODELS.md)). **67.5 overall** (from 53.5):
ArXiv math 0 → 64.6, old scans: math 0 → 32.3, tables 70.9 → 76.0, old scans
24.3 → 32.3, long tiny text 76.2 → 78.7; the other categories within a point;
6.1 s per page (CPU + GPU, against 7.8 s for the default on the CPU only; see
the note under the table below). That is above the published Marker (59.4), MinerU (61.5) and
near GPT-4o (69.9); olmOCR 77.4. Run with:

```bash
packaging/build/llama.cpp/build/bin/llama-server -m PaddleOCR-VL-1.6-Q4_K_M.gguf --mmproj mmproj-Q8_0.gguf \
  --jinja --temp 0 -ngl 99 -c 16384 -np 2 --port 28400
OPENPDF_VLM_URL=http://127.0.0.1:28400 uvicorn app.main:app ...   # services/structure
python convert.py openpdf-markdown-model $B   # with OPENPDF_GATEWAY pointing at a gateway using that service
```

`score.py --sample SYSTEM`: the pass rate over the converted pages only, for
systems run on a sample (PaddleOCR-VL's own pipeline on CPU, Docling's
formula model: 16 math pages, 81.0 / 73.9 and 7.1 / 13.0).

## Indra OCR, for comparison (2026-10-27)

[Indra OCR](https://huggingface.co/datalab-to/indra-ocr) (Datalab, October 2026):
a CPU pipeline of small ONNX models (text detection 90k parameters, line
recognisers 1.2-2.5M, a reading-order model 0.7M, n-gram tables for unsure
lines; no table-structure network), reading the text layer where it passes its
checks. **Research comparison only:** the code is Apache-2.0, but the weights use
a modified OpenRAIL-M licence (no use by companies over $20M revenue or funding,
or by anyone offering a competing product), so it cannot be part of OpenPDF.
Files checked before running: plain ONNX operators, no pickle.

| System | ArXiv math | Old scans: math | Tables | Old scans | Headers / footers | Multi-column | Long tiny text | Base | Overall | s/page |
|---|---|---|---|---|---|---|---|---|---|---|
| OpenPDF + PaddleOCR-VL (`openpdf-markdown-model`) | 64.6 | 32.3 | 76.0 | 32.3 | 88.6 | 69.2 | 78.7 | 97.9 | **67.5** | 6.1 (CPU + GPU) |
| Indra OCR `--math` | 55.9 | 3.5 | 64.3 | 27.6 | 89.6 | 71.9 | 76.0 | 99.6 | **61.1** | 1.9 (CPU) |
| Indra OCR, default | 0.3 | 2.8 | 67.4 | 27.4 | 89.6 | 75.6 | 76.0 | 99.6 | **54.8** | 0.4 (CPU) |
| OpenPDF default: Docling layout + TableFormer, PP-OCR for scans (`openpdf-markdown-auto`) | 0.0 | 0.0 | 70.9 | 24.3 | 88.7 | 69.6 | 76.2 | 98.1 | **53.5** | 7.8 |

- **Level with OpenPDF's default at a twentieth of the time.** Indra's speed is
  real: it OCRs scans (about 2.5-3 s a page here, `source=ocr`), and is fast on
  digital pages because it reads their text layer, as OpenPDF does. OpenPDF's
  time goes to Docling's layout model (every page) and TableFormer (pages with
  tables), not to reading text.
- **Better reading order** (multi-column 75.6 against 69.6): its learned
  reading-order model beats Docling's rules. An Apache-2.0 model that does the
  same is PP-DocLayoutV3 (layout and reading order).
- **Weaker tables** (67.4; 64.3 with `--math`, which reads numbers in cells as
  math) and old scans; `--math` reaches 55.9 on ArXiv math, below PaddleOCR-VL's
  64.6, and nothing on old scanned math.
- Timings on a machine shared with other work (load 18-48 on 16 cores), one page
  at a time with 4 threads (`--workers 1`: PDFium is not thread-safe). Every
  system ran on the CPU only except `openpdf-markdown-model`, whose model ran on
  the GPU (RTX 3060); the rest of its work is on the CPU as in the default.
- **6.1 against 7.8 s is not a speed-up.** The model only adds work (the default pipeline runs first), so it is not faster: the two runs were
  made on different days under different load. On text-only pages, where the model does nothing,
  the median moved just as much (headers/footers 5.4 → 2.8 s, multi-column 6.4 → 3.9 s), while old
  scans, which the model reads again, went 12.1 → 14.0 s.

## Checking the text layer before trusting it (2026-10-27)

Until now a page with any text at all counted as a text page. Two kinds of page
were read wrongly because of that:

| Page | Found in the benchmark | Was | Now |
|---|---|---|---|
| Text that cannot be decoded (a font without a Unicode map): private-use or control characters, glyph codes as numbers, glyph names run together | 5 of 1403 (Danish, English, Arabic, Persian) | the garbage, as text | the structure service lists it in `garbledPages` when both PDFium and Docling fail to decode it (Docling decodes some fonts PDFium cannot); the gateway reads those pages again from their image (OCR `mode=force`) and converts once more; `rereadPages` |
| A scan carrying a few words of real text (a stamped page or Bates number, a heading OCR'd earlier) | 7 (under 200 characters on a page-size picture) | skipped by OCR: it has text, and the picture was taken for a scan already read | its picture is read like other pictures on text pages (OCRmyPDF's redo mode keeps the page's own words) |

On the 12 PDFs concerned (the others unchanged): 11 checks newly pass (one
table read fully, reading order on a page of references, a Chinese exam that
had come out as two empty pictures) and 1 newly fails (an Arabic page: the OCR
models read Latin and Chinese only, so its garbage became nothing).
Overall **53.5 → 53.6** (Tables 70.9 → 71.6, Multi-column 69.6 → 69.9); small
here because the benchmark has few such pages, but these are whole pages lost.

Not caught yet: glyph codes that decode to letter soup (`BXDCD4CTD6`: both
readers see letters) and legacy Arabic fonts mapped to the wrong letters.

## A smaller layout model? (2026-10-28)

Docling's layout model (heron, 172 MB) finds the page's regions before the
table model reads the tables. Its smaller Apache-2.0 siblings (egret) can be
tried with `OPENPDF_STRUCTURE_LAYOUT=egret-medium` (or `egret-large`,
`egret-xlarge`, `heron-101`) on the structure service. The weights are
downloaded on first use; only heron is bundled with the app.

**Accuracy**, full benchmark, default mode (no reading model), with the text-layer check above:

| Layout | Overall | Tables | Headers / footers | Long tiny text | Multi-column | Old scans |
|---|---|---|---|---|---|---|
| heron (default) | **53.6** | 71.6 | 88.7 | 76.2 | 69.9 | 24.3 |
| egret-medium (78 MB) | **52.5** | 67.9 | 85.9 | 74.4 | 69.5 | 24.3 |

135 checks newly fail and 62 newly pass, most of them tables (65 against 27).
The usual loss is a table drawn inside a figure: egret takes it for part of
the picture, so the table model never sees it and its numbers come out as
loose OCR text.

**Speed**, same 56 PDFs (8 per category) run one after another, structure
service on 2 threads, machine load about 40 on 16 cores:

| Layout | Median s/page | Mean s/page | Total |
|---|---|---|---|
| heron | 8.3 | 12.5 | 703 s |
| egret-medium | 6.0 | 8.2 | 463 s (−34 %) |
| egret-large | 6.1 | 10.0 | 561 s (−20 %) |

(The full egret-medium run showed a median of 3.0 s against heron's 7.8 s, but
those runs were days apart under different load; the sample above is the fair
comparison.) On a sample this small accuracy differences are noise (heron
42.8, egret-medium 41.6, egret-large 43.3 % of 353 checks).

**Decision: heron stays the default.** Layout is about a quarter of a page's
time; the table model and OCR take most of the rest, so a smaller layout model
saves a third of the time at most and costs a point of accuracy, mostly
tables. egret-large looks like the better trade but has not been run on the
full benchmark.

## What the checks look at

| Category | Pages | What passes |
|---|---|---|
| ArXiv math | 522 | formulas written as LaTeX that renders like the original |
| Old scans: math | 36 | the same, on old scanned books |
| Tables | (in `tables/`) | a cell's value with the right neighbours (left, right, above, below, headings) |
| Old scans | 98 | sentences present and in the right order, on old scanned pages |
| Headers / footers | 266 | running headers, footers and page numbers left out |
| Multi-column | 231 | sentences in reading order across columns |
| Long tiny text | 62 | dense small print read completely |
| Base | all | no long runs of repeated characters, the page's text not missing |

The overall score is the average of the categories, as the benchmark computes it.

**A scorer quirk, corrected here:** in olmocr 0.4.27 a "present" check passes when
a page's output is only whitespace (a newline, a space), though not when it is
empty. A system that returns a newline for a scanned page with no text would be
credited with every sentence on it. `score.py` therefore empties whitespace-only
outputs for every system before scoring.

## Systems

`convert.py` writes each system's output in the layout the scorer expects:

| System | What it is |
|---|---|
| `openpdf-text` | `pdf_read_text`: the page's text layer (PDFBox) |
| `openpdf-text-ordered` | the same with `reading_order=true` (sorted top to bottom, left to right) |
| `openpdf-markdown` | `pdf_read_markdown`: the structure add-on (Docling, OpenPDF's settings: no OCR, its own reading-order and heading fixes) |
| `openpdf-markdown-ocr` | pages without text OCR'd first (`pdf_ocr`), then `pdf_read_markdown`: what an agent following the tools' advice does |
| `openpdf-markdown-auto` | `pdf_read_markdown` as it is now: the gateway OCRs scans and the pictures on text pages itself |
| `openpdf-text-ocr` | pages without text OCR'd first, then `pdf_read_text` |
| `pymupdf4llm` | PyMuPDF4LLM 2.0 `to_markdown`, a common default in agent stacks (AGPL; only run here) |
| `docling-default` | Docling with its default settings (OCR on) |
| `indra-ocr`, `indra-ocr-math` | Indra OCR 1.1.2, default and `--math` (weights not licensed for OpenPDF; only run here) |
| `pdfcraft-markdown` | PDFCraft (PDFCraftTool, `e3b231b`) PDF to Markdown: pdf.js text lines, headings by font size, rows of aligned text made into tables; no OCR. Its own code in headless Chrome ([../pdfcraft](../pdfcraft/build.sh); AGPL, only run here) |
| `pdfcraft-rs-markdown` | PdfCraft 0.18.2 (storytold, Rust) Export to Markdown (`doc_export_office` to `.md`) through `pdfcraft-cli`; no OCR |

Scores other tools' authors published on the same benchmark are quoted in
RESULTS.md for context; they were not run here.

## Rerunning

```bash
python -m venv ~/.venvs/docbench && ~/.venvs/docbench/bin/pip install "olmocr[bench]" numpy huggingface_hub httpx pymupdf pymupdf4llm
~/.venvs/docbench/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('allenai/olmOCR-bench', repo_type='dataset', local_dir='$HOME/.cache/openpdf-bench/olmOCR-bench')"
B=~/.cache/openpdf-bench/olmOCR-bench/bench_data
engine/tools/devstack.sh start            # OpenPDF services on 28090 (OPENPDF_GATEWAY to change)
~/.venvs/docbench/bin/python convert.py openpdf-markdown $B      # one system; resumable
~/.venvs/docbench/bin/python score.py $B openpdf-text openpdf-markdown ...
```

`docling-default` runs in a venv with Docling installed (`~/.venvs/docling`);
`indra-ocr` in one with `pip install indra-ocr` (run with `--workers 1`).

## Limits

- One benchmark, mostly English, mostly academic and archival pages. Contracts,
  forms, invoices and Chinese documents are not in it.
- Scores published by other tools' authors come from their own runs, often of
  other versions; only the systems above were run here, on one machine.
- The checks are strict about format: math must be LaTeX, tables must keep
  their cell structure. Plain text scores zero there by design.
