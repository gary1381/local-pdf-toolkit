# Third-Party Notices

OpenPDF's own code is licensed under the Apache License 2.0 ([LICENSE](LICENSE),
[NOTICE](NOTICE)). It uses the following open-source components. Each is used
unmodified and keeps its own licence.

## In this source repository

Only these third-party files are stored in the repository, each with its licence
file next to it:

| Component | License | Where | Licence file |
|-----------|---------|-------|--------------|
| pdf.js (pdfjs-dist 4.10.38): library, worker, viewer CSS and images | Apache-2.0 | `gateway/app/static/vendor/pdfjs/` | `LICENSE` |
| Adobe CMaps (shipped with pdf.js) | BSD-3-Clause | `gateway/app/static/vendor/pdfjs/cmaps/` | `cmaps/LICENSE` |
| Foxit standard fonts (shipped with pdf.js, from PDFium) | BSD-3-Clause | `gateway/app/static/vendor/pdfjs/standard_fonts/` | `LICENSE_FOXIT` |
| Liberation Sans (shipped with pdf.js) | SIL OFL 1.1 | `gateway/app/static/vendor/pdfjs/standard_fonts/` | `LICENSE_LIBERATION` |
| Ma Shan Zheng, Zhi Mang Xing, Liu Jian Mao Cao, Dancing Script, Great Vibes (WOFF2, converted from Google Fonts TTFs) | SIL OFL 1.1 | `gateway/app/static/fonts/` | `OFL.txt`, `README.txt` |
| Lucide icons (SVG paths) | ISC | `gateway/app/static/icons.js` | `gateway/app/static/LICENSE-lucide.txt` |

Everything else below is downloaded from its upstream project when the
containers, the web build, the add-ons or the installers are built (Python
packages from PyPI, Java libraries from Maven Central, npm packages, models
from their publishers), and is not stored here.

## Used by the services and containers

The licence texts of the bundled Python packages, with their versions and
source download links, are in `licenses/` and `SOURCES.md` next to each bundled
program in the installers and add-ons.

| Component | License | Role |
|-----------|---------|------|
| OCRmyPDF | MPL-2.0 | OCR pipeline: pages, invisible text layer (optional OCR container) |
| RapidOCR | Apache-2.0 | OCR engine (optional OCR container) |
| PaddleOCR PP-OCRv6 / PP-OCRv5 models (ONNX, via RapidOCR) | Apache-2.0, copyright Baidu / PaddleOCR authors (see RapidOCR's MODEL_LICENSES.md) | Text detection and recognition models (optional OCR container) |
| ONNX Runtime | MIT | Runs the OCR models (optional OCR container; its usage telemetry is turned off) |
| OpenCV (opencv-python-headless) | Apache-2.0; the wheel also bundles FFmpeg (LGPL-2.1, unmodified shared libraries) and other libraries listed in its LICENSE-3RD-PARTY.txt | Image operations inside RapidOCR and the table model (optional OCR and structure containers) |
| NumPy, Shapely, pyclipper, OmegaConf, PyYAML | BSD-3-Clause / BSD-3-Clause / MIT / BSD-3-Clause / MIT | RapidOCR dependencies (optional OCR container) |
| pypdfium2 / PDFium | BSD-3-Clause, Apache-2.0 | Renders pages for OCR (optional OCR container) |
| pikepdf | MPL-2.0 | PDF read/write inside OCRmyPDF (optional OCR container) |
| fpdf2, img2pdf | LGPL-3.0 | Libraries used unmodified by OCRmyPDF (optional OCR container) |
| Docling (docling-slim, docling-core, docling-parse, docling-ibm-models) | MIT | Document structure: layout, reading order, tables (optional structure container) |
| Docling layout model "heron" | Apache-2.0 | Finds headings, paragraphs, lists, tables, figures on a page (optional structure container) |
| TableFormer models (docling-project/docling-models) | CDLA-Permissive-2.0 | Rows and columns of tables (optional structure container) |
| PyTorch, torchvision (CPU builds) | BSD-3-Clause (PyTorch also bundles code under Apache-2.0, BSD-2-Clause, BSL-1.0, MIT) | Run the structure models (optional structure container) |
| Transformers, Hugging Face Hub, Accelerate, safetensors, tokenizers | Apache-2.0 | Load and run the layout model; models are bundled, nothing is downloaded at run time (optional structure container) |
| SciPy, pandas, NumPy, Rtree, Pillow, lxml, SymPy, NetworkX | BSD-3-Clause / BSD-3-Clause / BSD-3-Clause / MIT / MIT-CMU / BSD-3-Clause / BSD-3-Clause / BSD-3-Clause | Docling and PyTorch dependencies (optional structure container) |
| Liberation fonts 2 | SIL OFL 1.1 | Draw the pages of PDFs that do not embed Helvetica/Times/Courier for the layout model (structure container, PDF Engine image) |
| Apache PDFBox | Apache-2.0 | Text extraction, forms, annotations, draw text |
| Apache PDFBox JBIG2 ImageIO plugin (jbig2-imageio) | Apache-2.0 | Reading JBIG2 pictures (common in scanned archives) when pictures are saved or pages drawn |
| qpdf | Apache-2.0 | Merge, split, unlock, flatten, rotate, delete/reorder pages, encrypt |
| Bouncy Castle (bcpkix, bcprov, bcutil) | MIT | Digital signatures: CMS/CAdES, certificates, time stamps (PDFBox sidecar) |
| FastAPI / Uvicorn / httpx | MIT | Gateway and sidecar HTTP services |
| Javalin | Apache-2.0 | PDFBox sidecar HTTP server |
| pdf.js (pdfjs-dist 4.10.38) | Apache-2.0 | In-browser rendering; bundled in `gateway/app/static/vendor/pdfjs` (license file included) |
| WenQuanYi Micro Hei | Apache-2.0 / GPLv3 with font embedding exception | Chinese glyphs embedded (as a subset) in text written into PDFs; installed in the PDFBox container from Ubuntu, bundled in the desktop installers from Debian (`backend/pdfbox/fonts/`, copyright file included); not stored in this repository. The embedding exception means PDFs that contain its glyphs are not covered by the GPL |
| Ma Shan Zheng, Zhi Mang Xing, Liu Jian Mao Cao, Dancing Script, Great Vibes | SIL OFL 1.1 | Handwriting fonts for typed signatures; bundled in `gateway/app/static/fonts` (license and authors included) |
| Lucide icons | ISC | Toolbar icons (`gateway/app/static/icons.js`, licence in `LICENSE-lucide.txt`) |

## Browser build (`web/`)

Installed from npm at build time, not stored in this repository. `web/build.mjs`
checks the licence of every package that ends up in the bundle and writes their
notices to `dist/ui/THIRD-PARTY-LICENSES.txt`. Main parts: LibPDF (MIT), PDFium
via EmbedPDF (MIT; PDFium BSD-3-Clause / Apache-2.0), pdf.js (Apache-2.0),
PKI.js (BSD-3-Clause), node-forge (BSD-3-Clause option), PaddleOCR.js and models
(Apache-2.0), ONNX Runtime Web (MIT), OpenCV.js (Apache-2.0), WenQuanYi Micro
Hei (Apache-2.0 option). See [web/README.md](web/README.md#licences).

## Desktop installers (Linux .deb / AppImage)

The installers also carry the runtimes the services need (see packaging/linux/README.md):

| Component | License | Role |
|-----------|---------|------|
| Tauri | MIT / Apache-2.0 | Desktop window and service launcher |
| Python 3.12 runtime | PSF-2.0 | Runs the gateway, qpdf service and OCR add-on (bundled with PyInstaller) |
| PyInstaller bootloader | GPL-2.0 with the PyInstaller bootloader exception (allows distributing bundled programs under any licence) | Starts the bundled Python programs |
| OpenSSL 1.1 (from the Python build, Debian bullseye) | OpenSSL / SSLeay | TLS library loaded by Python |
| Eclipse Temurin OpenJDK 17 runtime (cut down with jlink) | GPL-2.0 with Classpath Exception | Runs the PDFBox service; notices in `backend/pdfbox/jre/legal/` |
| qpdf 12.4.2 official Linux build | Apache-2.0 | Merge, split, rotate, encrypt ... |
| Libraries in that qpdf build: GnuTLS, libtasn1 | LGPL-2.1-or-later | |
| Nettle / Hogweed, libidn2, libunistring | LGPL-3.0-or-later or GPL-2.0-or-later | |
| p11-kit, libjpeg-turbo, libffi | BSD-3-Clause, IJG / BSD-3-Clause, MIT | |
| GTK 3, WebKitGTK and their dependencies (AppImage only) | LGPL-2.1-or-later and others | Window and web view inside the AppImage |

No AGPL code is shipped. OCR runs without Ghostscript (AGPL-3.0): OCRmyPDF
renders pages with PDFium and writes plain PDF rather than PDF/A. Tesseract is
no longer used.

Licence texts not bundled can be obtained from each upstream project. Do not
remove copyright notices from redistributed third-party binaries or containers.
