# OpenPDF in the browser

The same editor as the desktop app and the server version, with nothing to
install: its services run inside the web page, in a Web Worker, on
WebAssembly. Open the site, open a PDF; the file never leaves the computer.
The site is static (any web server or CDN can host it) and works offline
once loaded.

```bash
cd web
npm install
node build.mjs            # -> dist/ (the site), run again after changing gateway/app/static or web/src
node build.mjs --serve    # also serve it on http://127.0.0.1:28300
node build.mjs --sourcemap   # with source maps, for debugging (don't publish this build)
python3 test/check_web.py http://127.0.0.1:28300 FIXTURES   # FIXTURES: engine/tests/make_fixtures.py
```

Publishing it for other people (HTTPS, hosts, server settings): [DEPLOY.md](DEPLOY.md).

The build downloads the OCR models once (into `.cache/`, about 23 MB) and needs
the WenQuanYi Micro Hei font for text in Chinese, Japanese or Korean (found in
`packaging/build/backend/pdfbox/fonts/` or `/usr/share/fonts/truetype/wqy/`, or
set `OPENPDF_CJK_FONT`).

## How it works

- `dist/ui/` is `gateway/app/static` as it is, plus `web-backend.js`, loaded
  first. It answers the editor's `fetch("/v1/pdf/...")` calls in the page by
  handing them to `web-worker.js`, which returns what the gateway would
  (same JSON, status codes, `X-Error-Code`s, revisions for undo). The editor
  does not know the difference.
- The worker's services (`src/ops/`), by gateway endpoint:

| What | Endpoints | How |
|---|---|---|
| Sessions, undo/redo | register, document, meta, restore | in memory (a reload starts over; the editor re-registers its copy) |
| Pages | rotate, pages, split, merge, flatten, unlock, encrypt, extract | LibPDF |
| Forms | form-fields, fill-form | LibPDF (Chinese values: the CJK font) |
| Highlights, pictures, picture signatures | highlight, remove-highlight, sign, stamp-signatures | LibPDF |
| Text boxes, Edit text, comments | read-placements, embed-placements | LibPDF draws; PDFium removes the text Edit text replaces |
| Redaction | redact | PDFium removes characters, picture pixels and shapes; LibPDF cleans forms, annotations, metadata; every result is checked (text and every object) or refused |
| Digital signatures | generate-cert, cert-info, digital-sign, verify-signatures | LibPDF (PAdES), PKI.js (verification), node-forge (.p12) |
| OCR | ocr, ocr/status | PaddleOCR.js (PP-OCRv6 models) on ONNX Runtime Web; invisible text layer |
| Page pictures | render-page | PDFium |

  Coordinates, messages and results follow the gateway's contract, so the
  editor behaves the same in all three versions.
- Large parts load the first time they are needed: PDFium (4.5 MB), the CJK
  font (4.6 MB), OCR (OpenCV.js 10 MB, ONNX Runtime 14 MB, models 23 MB).
  The service worker (`src/sw-web.js`) keeps them for offline use.
- Nothing contacts another site: libraries' CDN defaults are replaced by
  files served with the editor (`test/check_web.py` checks every request).

## Licences

Everything bundled must allow closed commercial use. `build.mjs` checks the
licence of every package that ends up in the bundle (MIT, Apache-2.0, BSD,
ISC, OFL, Boost...; the build stops on anything else) and writes the notices
with their texts to `dist/ui/THIRD-PARTY-LICENSES.txt`. Main parts: LibPDF
(MIT), PDFium via EmbedPDF (MIT; PDFium BSD-3/Apache-2.0), pdf.js
(Apache-2.0), PKI.js (BSD-3), node-forge (BSD-3 option of BSD-3 / GPL-2),
PaddleOCR.js and models (Apache-2.0), ONNX Runtime Web (MIT), OpenCV.js
(Apache-2.0), WenQuanYi Micro Hei (Apache-2.0 option).

## Differences from the server version

- **Edit text in the look of the page**: the size, colour, position and kind
  of font (serif, bold, italic, fixed pitch) are copied, but the text is
  written with the matching standard font, not the page's own embedded font.
- **Redaction**: a region's edges are pulled in past characters it touches
  without taking (the rule: a fifth of the character); picture pixels in that
  thin band stay under the black box instead of being whitened. OCR of scanned
  pages before searching them is not done (the report says which pages could
  not be searched).
- **Form fields filled with Chinese** embed the whole CJK font (about 2 MB;
  other viewers can then type any character into the field).
- **Timestamped signatures** need a timestamp server that accepts requests
  from web pages (CORS); most public ones do not.
- **Sessions** live in the page: closing or reloading it ends them (the editor
  keeps its own copy of each open file and registers it again).
- **Agents and MCP** need the local services: use the desktop app or the
  PDF Engine.
