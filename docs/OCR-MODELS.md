# Document OCR models: better tables, formulas and figures

Status: design, with the first part working in the structure service
(PaddleOCR-VL: tables, formulas, paragraphs with mathematics, scanned pages).
Measured 2026-10-24.

## Why

OpenPDF reads documents with Docling: its layout model finds the blocks of a
page and the text comes exactly from the PDF (or from OCR of a scan). That is
fast and right for ordinary text, and weak where the block is a picture of
structure rather than text:

- **tables** in scans, or without rules: Docling's TableFormer has to match
  cells to text that OCR read line by line;
- **formulas**: left out (`<!-- formula-not-decoded -->`); OpenPDF scores 0 on
  olmOCR-Bench's two math categories;
- **charts**: only their labels are text; the numbers are drawn.

A new kind of model reads exactly these: small (0.9-3B) vision-language models
trained for documents, which take a picture of a block and write its table as
HTML, its formula as LaTeX, its chart as a data table. Quantised to GGUF they
run in llama.cpp on a CPU or a modest GPU.

## The models

| Model | Size (GGUF) | Licence | llama.cpp | How it reads | Tried here |
|---|---|---|---|---|---|
| **PaddleOCR-VL 1.6** (Baidu) | 0.9B: Q4 decoder 0.3 GB + projector 0.6 GB | Apache-2.0 | yes (mtmd) | one block at a time, with a task prompt (`Table Recognition:`, `Formula Recognition:`, `Chart Recognition:`, `OCR:`); tables as OTSL tokens | GPU: 1-2 s per block. Full pipeline on CPU (Paddle): formulas 81.0 / 73.9 on a 16-page sample (OpenPDF 0, Docling's formula model 7.1 / 13.0), 6 min per page |
| **GLM-OCR** (Zhipu) | 0.9B: Q8 1.0 GB + projector 0.5 GB | MIT (its layout model PP-DocLayoutV3: Apache-2.0) | yes | one block, prompts `Text/Table/Formula Recognition:`; tables as HTML; also JSON extraction to a given schema | GPU: 1.5-7 s per block; read a scanned table Docling garbled |
| **Unlimited-OCR** (Baidu) | 3B MoE: Q4 1.9 GB / Q6 2.4 GB + projector 0.8 GB | MIT | **not yet**: needs llama.cpp PR #24975 (R-SWA attention), single page only so far | whole pages (layout, tables, boxes for every line), several pages at once in its own runtime | GPU decoder + CPU vision: 50-80 s per page; best reading of a scanned page with two tables; on a cropped block it falls back to loose lines |

The repositories `cstr/paddleocr-vl-1.6-GGUF` (for the CrispEmbed runtime, not
llama.cpp) and `LunarOilRig/PaddleOCR-VL-1.6-GGUF-Q4` (llama.cpp; used here)
are conversions of the same Apache-2.0 weights. The official F16 GGUF is
`PaddlePaddle/PaddleOCR-VL-1.6-GGUF` (1.8 GB); a Q8 decoder can be made from it
with `llama-quantize` (cstr reports early stops with Q4 on long lines: to check).

## How OpenPDF uses them

```
PDF ─► OCR of scans + pictures (as now) ─► Docling: blocks, reading order, text
                                               │
                         tables, formulas, charts (boxes)
                                               ▼
                      crop at 200 dpi ─► llama-server (OCR model) ─► HTML / LaTeX / data
                                               │
                          check against the page's text layer
                                               ▼
                   elements + Markdown (same pages and boxes, "readBy": "model")
```

1. **Docling stays in charge of the page.** It finds the blocks and their
   order, and reads paragraphs from the PDF's own text, which no model can
   beat for born-digital documents. The model only re-reads blocks of the
   kinds above, so a 300-page report costs the model only its tables and
   formulas, and every block keeps the page and box Docling gave it (quotes,
   `pdf_extract` sources and highlights keep working).
2. **Tables**: the crop with `Table Recognition:`; OTSL (PaddleOCR-VL), HTML
   (GLM-OCR) or Markdown become rows of cells, merged cells repeated as Docling
   does. **Check:** on pages with a text layer, the model's table is kept only
   when at least half of its words are in the text under the table's box;
   otherwise Docling's table stays. A model can invent a number; the PDF cannot.
3. **Formulas**: `Formula Recognition:` gives LaTeX; it replaces the
   not-decoded mark as `$$ … $$` and is the element's text (`"latex": true`).
   A block of aligned equations becomes one display formula per line.
4. **Paragraphs with mathematics**: formulas inside sentences are not blocks
   for Docling. A paragraph with at least two signs of mathematics (Greek
   letters, operators, `L2`-style subscripts, `a = b`) is read again with
   `OCR:`, which writes the formulas inline (`\( … \)`, turned into `$ … $`).
   **Check:** the words outside the formulas must be 70% in the PDF's text.
5. **Scanned pages**: the gateway tells the structure service which pages were
   scans before OCR (`scanPages`); there every block of text is read again by
   the model, which reads old print better than the OCR layer (check: 40% of its
   words in that layer, which is itself only roughly right).
6. **Charts** (phase 2): pictures that look like charts (axis labels and
   numbers in their text, or Docling's picture classifier) get
   `Chart Recognition:`; the data table goes under the picture, after its quoted
   text.
7. **Whole pages** (phase 2): with Unlimited-OCR (or PaddleOCR-VL's own layout
   model, which also finds formulas inside lines) a scanned page can be read in
   one pass.
8. **Tables across pages** (phase 2): a table ending at the bottom of a page
   and one starting at the top of the next, with the same columns and no caption
   between, are one table: their rows are joined under the first header. With
   Unlimited-OCR, once llama.cpp reads several pages in one request, both pages
   go to the model together.
9. **Extraction without an agent model** (phase 3): GLM-OCR fills a JSON
   template from a page picture. `pdf_extract` called without values could use
   it locally (instead of MCP sampling) and then locate each value as it does now.

## Tiers (chosen by the user)

| Tier | Model | Download | Runs on | Per table / formula | Status |
|---|---|---|---|---|---|
| Off | Docling only | none | CPU | n/a | default until a model is chosen |
| Fastest | small table + formula models (ONNX, about 100 MB) | ~0.1 GB | any CPU, phones | under 1 s | planned: to be measured |
| **Fast** | PaddleOCR-VL 1.6 Q4 | 0.9 GB | GPU or CPU | GPU 2 s / 2 s; CPU 24 s / 4 s | recommended |
| **Best** | Unlimited-OCR 3B Q4 | 2.8 GB | GPU with 5 GB free only (CPU: 8.5 min per page) | whole pages, 2 min per page on CPU here | experimental (llama.cpp PR #24975) |

granite-docling 258M (Apache-2.0) was tried for the fastest tier: as fast as
PaddleOCR-VL on a GPU, slower on a CPU (42 s / 13 s), and it looped on a
scanned table; it saves only download size, so it is not offered.

Best reads whole pages through llama-server's `/completion` (its chat template
adds nothing and the chat endpoint loses the picture's place) with `--special`
(its `<|det|>` block marks and table tags are special tokens), and its blocks
are matched to Docling's by position.

Once a model is downloaded it is used by default (`model=auto`) for tables,
formulas, mathematics and scanned pages; Settings → "Reading tables, formulas
and scans" switches it off or to another tier, and removes downloaded models.

## Switches

- Structure service: `OPENPDF_VLM_URL` (the model server), `OPENPDF_VLM_MODEL`
  (`paddleocr-vl` or `glm-ocr`); `/convert … model=true`; `GET /model` says
  whether a model is set up and answering.
- Gateway: `/structure`, `/export` take `model=true|false`.
- Gateway `/structure`, `/export`: `model=auto|on|off` (auto: whenever a model
  answers); `GET /v1/pdf/structure/model`. MCP: `model` on `pdf_read_markdown`,
  `pdf_structure`, `pdf_export`.
- Containers: `services/model` (llama-server at the pinned commit, CPU or CUDA,
  the tier's files fetched and checked on first start), compose profile
  `model`, `scripts/install-model.sh [fast|best]`.
- Desktop: `desktop/src-tauri/src/addons.rs`, packs from
  `packaging/linux/build-structure.sh` and `build-llama.sh` (CPU variants +
  Vulkan, so any GPU brand works without CUDA).

## Running it

An optional add-on, like OCR today:

- **llama-server** (llama.cpp, MIT) started by the desktop app or the container
  on a free 127.0.0.1 port, stopped with it; one model loaded.
  Builds: CPU (AVX2), Vulkan (any GPU vendor), CUDA (NVIDIA; larger). The app
  picks GPU when there is enough free memory, else CPU.
- **Model files** downloaded on first use from the release repository and checked
  against the SHA-256 built into the app (the OCR add-on's scheme):
  PaddleOCR-VL Q4/Q8 about 0.9-1.4 GB.
- **Memory**: PaddleOCR-VL Q4 needs about 1.4 GB of GPU memory with a 16k
  context; GLM-OCR about 1.5 GB plus a context-sized cache (limit `-c 8192`);
  Unlimited-OCR's vision encoder alone wants 1.5 GB of working memory.
- **Speed budget**: on a GPU, 1-2 s per block (a table page: a few seconds more
  than now). On a CPU, tens of seconds per block: then only what the reader asks
  for (the pages read, or an explicit request), with progress.
- **Concurrency**: llama-server with 2 slots; the structure service sends two
  blocks at a time. PDFium is not thread-safe: every PDFium call in the structure
  service takes Docling's `pypdfium2_lock` (rendering crops while another request
  rendered pages crashed the service once).

## Measurements

| On olmOCR-Bench | Tables | ArXiv math | Old scans: math | Overall | s/page |
|---|---|---|---|---|---|
| OpenPDF now (no model) | 70.9 | 0 | 0 | 53.5 | 7.8 (CPU only) |
| OpenPDF + PaddleOCR-VL Q4 on the GPU (tables, formulas, math paragraphs, scans) | **76.0** | **64.6** | **32.3** | **67.5** | 6.1 (CPU + GPU) |

Old scans 24.3 → 32.3 and long tiny text 76.2 → 78.7 too; headers/footers,
columns and base unchanged within a point. Time per page stays the same on a
GPU (the median moved with the machine's load, both ways). The model only adds work (the default pipeline runs first), so it is not faster: the two runs were
made on different days under different load. On text-only pages, where the model does nothing,
the median moved just as much (headers/footers 5.4 → 2.8 s, multi-column 6.4 → 3.9 s), while old
scans, which the model reads again, went 12.1 → 14.0 s. For comparison,
the benchmark's published results: olmOCR 77.4, Mistral OCR 72.0, GPT-4o 69.9,
MinerU 61.5, Marker 59.4; Docling with its defaults 53.7 (run here).
Steps, on the 16 math pages: formulas only 4.8 / 23.9; with the paragraphs
re-read 71.4 / 34.8 (PaddleOCR-VL's own pipeline: 81.0 / 73.9; the rest of the
gap is its layout model, which finds formulas inside lines).

Sample (16 math pages, same pages for all): PaddleOCR-VL's full pipeline
(Paddle, CPU) 81.0 / 73.9; Docling's formula model 7.1 / 13.0; OpenPDF 0 / 0.

## Plan

1. Tables and formulas with PaddleOCR-VL (done in the structure service;
   benchmark above). Decide the default (`auto`) from the numbers.
2. Inline formulas, charts, tables across pages; GLM-OCR as the alternative
   model, compared on the same pages.
3. The add-on: llama-server builds for Linux (CPU, Vulkan), model download and
   checks, the editor setting, MCP parameters; then Windows/macOS with their
   installers.
4. Unlimited-OCR for scanned and multi-page documents once llama.cpp supports
   it (PR #24975) and its vision encoder fits common GPUs.
