# OpenPDF Features

OpenPDF is a **PDF editor for people**, plus an **HTTP API for agents**. People edit files in the browser. Programs and agents in Cursor call the REST API at `http://127.0.0.1:8090`. Both sides work with the same kinds of PDF features, but through different entry points.

Interface: <http://127.0.0.1:8090/>  
Machine-readable API description: <http://127.0.0.1:8090/docs>  
Implementation details such as sessions and lazy refresh: [ARCHITECTURE-AND-PERFORMANCE.md](./ARCHITECTURE-AND-PERFORMANCE.md)

---

## 1. How it differs from other PDF software

Common PDF software falls into a few groups. OpenPDF does not try to replace everything any one of these groups can do.

| Type | Examples | What they are good at | How OpenPDF differs |
|------|------|------------|----------------|
| Desktop editors | Adobe Acrobat, Foxit, WPS | Rewrite the text objects of a PDF in place (reflowing paragraphs) | **Edit text** replaces a line, a paragraph (rewrapped) or an area: on save, the old text is removed from the page and the new text drawn in its place, in the same font, size and colour when the document's font has the characters, so any reader shows it. The boxes also stay editable when you reopen the file in OpenPDF |
| Online toolboxes | Stirling PDF, iLovePDF, Smallpdf | Merge, split, OCR, encrypt, one task at a time | OpenPDF has these too, in the same service as the editor. An agent can call them one after another without switching websites |
| Browser viewers | Chrome, the pdf.js demo page | Page through, search, copy text | On top of viewing, OpenPDF adds Edit text, Add text, comments, highlights, forms and signatures, and it provides an API |
| Libraries for programs only | PDFBox, qpdf, pikepdf | Library functions, no interface for people | People use the web page; agents use REST / MCP. Underneath, it still uses PDFBox, qpdf, OCRmyPDF + RapidOCR |

The most important thing to remember:

**Edit text** changes what the page says. Click a line of the page's text (or select text and choose **Edit**): it opens prefilled, in place; or drag out an area (a scan, a stamp) and type. **Add text** puts new text anywhere and changes nothing that is there.

While you work, both are text boxes in the editor (right-click one to change its colors, size, font size and font). When you save (also print and export):
- the text and pictures under each Edit text box are **removed from the page** (the characters are cut out of the page content; the covered part of a picture is painted white; vector lines stay). The rest of the page stays text: selectable and searchable. If something under a box cannot be removed (an image mask), OpenPDF says so;
- all boxes and comments are **drawn into the pages**, in a layer named “OpenPDF edits”, so every reader shows and prints them and text extraction finds them;
- a copy is kept in the document information (`PdfGatewayPlacements`), so reopening the file in OpenPDF gives the boxes back, editable (OpenPDF then hides the drawn layer instead of showing it twice). The next save replaces the drawing.

For removing confidential information for sure, use **Redact** (R; `/v1/pdf/redact`, `pdf_redact`): it also removes lines and shapes, hidden copies of the words (form values, annotations, metadata, `/ActualText`), and checks the result.

Everything else is also written into the file and visible elsewhere: highlights, signatures/images, form values, merge, split, rotate, OCR, encrypt.

---

## 2. Features that are already implemented

### 2.1 The editor for people

| Feature | How it is written into the PDF | Other readers |
|------|-----------------|------------|
| Open, multiple tabs, thumbnails, single page / two pages / continuous / grid, zoom | — | — |
| Undo / Redo (Ctrl+Z / Ctrl+Y) | Restores an earlier version | — |
| Find (Ctrl+F) | Does not change the file | — |
| Rotate one or more pages, delete pages, reorder pages (right-click or drag a thumbnail) | New page order and orientation | Visible |
| Open an encrypted PDF (enter the password) | Opens a decrypted copy; saved as a new file | — |
| Select and copy existing text on the page | Does not change the file | — |
| Edit text | Old text removed from the page, new text drawn in its place (layer “OpenPDF edits”); editable copy in the metadata | Visible |
| Add text | Drawn into the page (layer “OpenPDF edits”); editable copy in the metadata | Visible |
| Text box properties (right-click) | Saved with the text box | Visible |
| Comment (callout box + arrow) | Drawn into the page (layer “OpenPDF edits”); editable copy in the metadata | Visible |
| Redact | Marked content taken out of the page, black boxes drawn, file checked | Visible |
| Highlight, Erase highlight | PDF highlight annotation | Visible |
| Insert image, signature image | Drawn into the page | Visible |
| Fill in existing AcroForm forms | Form field values | Visible |
| Extract the full text (text mode) | Read only, no change | — |
| OCR | Creates a searchable PDF | Visible |
| Merge, split | New PDF pages | Visible |
| Unlock, encrypt, flatten | qpdf / PDFBox | Visible |
| Print preview | — | — |
| Save: to the original file, or as a download | See below | Depends on each item above |

### 2.2 The API for agents

Everything is available over REST: `/v1/pdf/*`.  
The [PDF Engine](../engine/README.md) wraps them as 29 MCP tools for Claude, Cursor and other MCP clients. The older `mcp/server.py` wraps only 5 basic ones. For anything else, send HTTP requests yourself.

| MCP tool | REST endpoint | What it does |
|----------|-----------|------|
| `pdf_merge` | `POST /v1/pdf/merge` | Merge several PDFs |
| `pdf_split` | `POST /v1/pdf/split` | Extract or split by page numbers |
| `pdf_ocr` | `POST /v1/pdf/ocr` | OCR for scans and for the pictures on text pages |
| `pdf_extract_images` | `POST /v1/pdf/extract-images` | The pictures as files, with page, position and the text in each |
| `pdf_from_images` | `POST /v1/pdf/from-images` | A searchable PDF from photos or scans |
| `pdf_export` | `POST /v1/pdf/export` | Markdown or JSON with the pictures, in a ZIP (optional component) |
| `pdf_outline`, `pdf_read_markdown`, `pdf_structure` (PDF Engine) | `POST /v1/pdf/structure` | Headings, reading order, tables, as Markdown or elements with pages and boxes (optional component) |
| `pdf_extract_text` | `POST /v1/pdf/extract` | Extract text |
| `pdf_info` | `POST /v1/pdf/info` | Page count and metadata |
| `pdf_annotate` | `POST /v1/pdf/annotate` | Sticky-note annotation, not the callout box in the interface |

The callout box in the interface corresponds to `POST /v1/pdf/callout`. MCP does not have a tool with this name yet.

---

## 3. How people use it

### 3.1 Open and save

```bash
cd /path/to/OpenPDF
./scripts/start.sh        # normal start: a few seconds; the first time it builds the images
./scripts/run-podman.sh   # after code changes: rebuild all images
```

Open <http://127.0.0.1:8090/> in the browser. After frontend changes, press **Ctrl+F5** to force a reload. After Java engine changes, rebuild the containers.

By default the service listens only on this computer (127.0.0.1). Other computers on the local network cannot reach it. The containers are set to restart automatically, so the service comes back up after a reboot.

| Action | How |
|------|------|
| Open | **File** menu → **Open**, the + in the tab bar, Ctrl+O, or drag a PDF into the window. When you choose a file with **Open**, the browser can remember the file handle, so later you can save over the original |
| Save | Ctrl+S. In **Settings** you can choose **Save to the original file** or **Save a new copy** (browser download) |
| Copy existing text | **Select**, drag to select text, Ctrl+C |
| Print | **Print**, or Ctrl+P |
| After selecting text | A small toolbar pops up above the page: Copy, Highlight, Edit (change this text), Redact (mark it), Find this text. This is the fastest way to highlight and edit text |
| Right-click a page | Actions for the selected text, plus rotate, move or delete this page |
| Recent | The start page lists the files you recently chose with **Open**. Click one to open it again (Chrome / Edge) |
| Editing tools | The group in the middle of the toolbar: **Select** (V), **Highlight** (H), **Erase** (E), **Edit text** (W), **Add text** (T), **Redact** (R), **Comment** (N), **Forms** (F), **Sign** (G), **Image** (I). When a tool is selected, a hint bar appears above the page. For the tools that write text, you choose the font and font size in the hint bar. Click **Done** or press Esc to go back to **Select** |
| Page through and zoom | Type a page number in the page box at the bottom and press Enter; ← → to turn pages; Ctrl+= / Ctrl+-, or Ctrl+wheel, to zoom; Ctrl+0 resets to 100%. The default is **Fit width**, but never wider than a comfortable reading width |
| List of keyboard shortcuts | Press ? or **File** menu → **Keyboard shortcuts** |
| Undo / Redo | The two arrows at the left of the toolbar, or Ctrl+Z, Ctrl+Y (Ctrl+Shift+Z). Highlights, signatures, forms, page actions, text boxes and comments can all be undone |
| Find | **Find** or Ctrl+F. Enter for next, Shift+Enter for previous, Esc to close |

A file you drag in has no file handle. The first time you save it, a Save As dialog opens.

#### The browser version

The same editor also comes as a website with nothing to install
([web/](../web/README.md)): the PDF work happens inside the page (WebAssembly),
so files stay on the computer, and it keeps working offline. It does the same
as the desktop app; the differences (for example Edit text uses a standard font
in the look of the replaced text) are listed in its README.

#### Install as an app (Chrome / Edge)

In Chrome or Edge, **File** menu → **Install as an app…** (or the install icon in the address bar) turns the editor into an app with its own window. The system then lists OpenPDF under **Open with** for PDF files: double-click or "Open with OpenPDF" in the file manager opens the file in the app (in a new tab when the app is already open), and **Save** writes back to that file; the browser asks once for permission to change it.

The app is the editor of one address: it needs the services there to be running (the containers, or the desktop app). Opened while they are not, it shows "OpenPDF isn't running", keeps the files it was asked to open, and opens them as soon as the services answer. In the desktop app, **File** menu → **Open in your browser** opens the same editor in the default browser, from where it can be installed.

A tab with unsaved changes shows a dot. If you close that tab, reload the page or close the browser tab, you are asked first.

After split, OCR or unlock, the document name gets `-split`, `-searchable` or `-unlocked` added, and saving **creates a new file**. The original file is not overwritten.

For each open file, the server keeps a working copy on disk (container volume `pdf-gateway-sessions`). It survives a restart of the service. Several changes to the same file run in order and do not overwrite each other. Copies not used for more than 7 days are cleaned up. If a copy is missing, the editor restores it automatically from the copy in the browser and shows a message in the status bar.

### 3.1.1 Managing pages

Right-click a thumbnail on the left, or click the **⋯** in its top-right corner: **Rotate clockwise**, **Rotate counterclockwise**, **Move page up**, **Move page down**, **Delete page**. You can also drag thumbnails to change the order. On the toolbar, **Pages** menu → **Rotate pages** lets you choose the current page, all pages or specific page numbers. **Delete this page** is in the same menu. Text boxes and comments move and rotate with their page. All of these actions can be undone. After you delete a page, “Page N deleted · Undo” appears at the bottom; click it to bring the page back. Long operations (OCR, save) show a progress line below the toolbar.

### 3.2 Edit text

1. Click **Edit text** (W).
2. Click a line of the page's text: it opens in place, prefilled, at its own font size. In a paragraph (lines of the same size, evenly spaced, in one column), the whole paragraph opens; it wraps at the paragraph's width with its line spacing and alignment (left, right, centred or justified); Shift+Enter starts a new paragraph. Change it and press Enter. Esc cancels. When saved, the new text uses that line's font (if the font embedded in the document has every character you typed; otherwise a standard font of the same kind: serif or sans, bold, italic, fixed width), its size, colour and spacing, and starts where the old text started. Choosing a font in the box's properties turns this off.
   Or drag out an area (part of a scan, a stamp, a table cell) and type what should be there instead.
   Or select text with **Select** and choose **Edit** in the small toolbar.
3. While the tool is on, the box is dark blue; drag it, drag its edges and corners to resize it, Delete removes it. Off, it shows black text on white, as it will be printed.
4. Right-click to open the properties (see 3.5).
5. Press Ctrl+S. The old text under the box is removed from the page and the new text written there; every reader shows the change. Reopened in OpenPDF, the box comes back and can be changed again.

Removing works on the page's characters (also the invisible text of an OCR'd scan) and on pictures (the covered part is painted white); lines and shapes wholly inside the box go too, those reaching beyond it stay. If something under the box could not be removed (a picture used as a mask), a message says so; for confidential content use **Redact** (3.4), which checks its result.

Moving a box after a save leaves the area it covered before blank: what was there has been removed.

### 3.3 Add text

1. Click **Add text** (T).
2. Click the page, type the text, and press Enter to confirm. Esc cancels.
3. You can drag the light blue box. Click it to edit again. To remove the box, select it and press Delete, or delete all its text and confirm.
4. Right-click to open the properties (see 3.5).
5. When you turn **Add text** off, the box stays. Its background becomes transparent and the text stays dark.
6. Press Ctrl+S: the text is drawn into the page; reopened in OpenPDF, the box can be changed again.

Add text does not change what is already on the page.

### 3.4 Redact

1. Click **Redact** (R). The redaction list opens on the right.
2. Mark what must go: drag over an area of the page; or select text and choose **Redact**; or type words in the list (every place they appear is removed). **Find in this document** adds all email addresses, phone numbers, or ID and account numbers it finds. Marks are red; × removes one.
3. Click **Apply redaction** and confirm. The marked content is taken out of the pages (characters, picture pixels, shapes, annotations over it), black boxes are drawn, and hidden copies go too: form fields and signatures, annotations and bookmarks with the words, optionally the document properties. The file is then searched again; the panel shows what was removed and checked.
4. Pages stay text where this can be checked; a page where it cannot (patterns, picture masks) is replaced by a picture of itself.
5. Save. Until then, Undo brings everything back. Saving with marks not yet applied asks to apply them first. Text boxes and comments become part of the page when a redaction is applied.

### 3.5 Properties (right-click)

Right-click an Edit text or Add text box. You can set each of these separately:

| Property | Meaning |
|------|------|
| Width, height | The size of this box. After changing it, press Enter or click outside the input field |
| Font size | Affects only the text in this box |
| Font | Helvetica, Times New Roman, Courier New, Arial, Song (Chinese serif), Hei (Chinese sans). In the saved file: Helvetica (also for Arial), Times or Courier; Chinese and other scripts use the embedded WenQuanYi Micro Hei |
| Background and text color while the tool is on | When the **Edit text** or **Add text** button is pressed |
| Background and text color after the tool is off | When neither tool is pressed. For the background you can check **Transparent** |
| **Reset to default** | Resets only the colors, not the size or the font |

The properties are saved with the box.

### 3.6 Comment

1. Click **Comment**.
2. Press the left mouse button on the text you want to point at. Dragging sets the direction and length of the arrow, and the callout box follows the end of the arrow. If you only click, the arrow points up and to the right, and the box is placed at a default distance.
3. Release the button, type the text, and press Enter to confirm. Esc cancels.
4. Drag the callout box to move it; the arrow changes length and direction to follow. Drag the edges of the box to resize it. Drag the dot at the end of the arrow to change where it points.
5. Click the text in the box to edit it again. To delete the comment, select it and press Delete, or delete all of its text.
6. Right-click to change the width, height, font size and font, and the background and text colors while the tool is on and after it is off.

Comments are saved like Edit text and Add text boxes: drawn into the page for other readers, and kept in the editor data so that OpenPDF can still move and change them.

This is not the same as `POST /v1/pdf/annotate` in the API. That endpoint adds a PDF sticky note, which is written into the file. `POST /v1/pdf/callout` still draws the callout into the page content; the **Comment** tool in the interface no longer calls it.

### 3.7 Highlight and erase

- **Highlight** (H): three shapes, chosen in the tool's bar or by pressing H again:
  - **Box**: drag a box; that area is highlighted.
  - **Text**: drag across text; only its lines are highlighted, each cut to the box at character boundaries (one undo step).
  - **Pen**: draw freely, like a highlighter pen (6 to 28 pt wide). Saved as an Ink annotation in the highlight's colour, see-through and multiplied, so every reader shows it.
  The shape and the pen width are remembered.
- **Erase** (E): drag over existing highlights to delete the ones you touch; a pen stroke goes when the area touches the stroke itself.
- **Selected text** (Select tool): H or Ctrl+H highlights it, W opens it in Edit text, R marks it for redaction, Ctrl+C copies it. The buttons above the selection show the same keys.

### 3.8 Image and signature

- **Image**: click the page to choose a position, then press Ctrl+V to paste an image from the clipboard. You can drag it and drag its edges and corners to resize it. Press Enter to confirm.
- **Sign** (G): the first time, a signature panel opens. You can **Draw** (mouse, touchpad or pen; choose the color and thickness, undo a stroke), **Type** your name and pick a handwriting font (Chinese: Ma Shan Zheng, Zhi Mang Xing, Liu Jian Mao Cao; English: Dancing Script, Great Vibes), or **Upload image** of a signature on paper (the white background is removed automatically). Finished signatures are stored in **My signatures**, only on this computer. You can set a default signature, and you can also store a set of **Initials**.
- Placing a signature: click the page to place it. Before it is written into the file, you can drag it, drag a corner to resize it (the aspect ratio is kept), or press Delete to remove it. The hint bar also has **Date** and **Name** quick stamps and **Sign every page**. If the PDF has empty signature fields, the signing tool marks them. Click into one to sign, and the signature is scaled to fit the field automatically.
- Writing: when you click **Done**, press Enter, switch tools or save, all placed signatures are written in one step, and a single undo removes them all. **How signatures are added** in **Settings** decides whether a signature becomes **Part of the page** (default; others cannot remove it on its own) or is added **As a stamp** annotation (it can still be moved or deleted in other software).

Images are drawn into the page, so other readers show them.

### 3.8.1 Digital signature (certificate)

**Digital signature…** in the hint bar signs with a .p12 / .pfx certificate (PAdES format). Any reader can then check whether the file was changed after signing.

- Certificate: import a certificate file issued by an organization, or use **Create personal certificate** (self-signed; other people's readers will show “identity not verified”). The certificate file is stored on this computer. You enter the password each time you sign; it is not stored.
- Position: sign into an existing signature field in the PDF, drag out a position on the page (shows the signer and the date, and can include a handwritten signature image), or do not show it on the page. You can optionally add a trusted timestamp (needs an internet connection).
- The signature is written at the end of the file (incremental save), so earlier signatures stay valid and several people can sign one after another. Changes made after signing (text boxes, comments, Edit text, highlights, form values, images) are appended the same way: the signature stays intact and readers show the file as changed after signing. The editor asks first. Saving an unchanged signed file leaves it byte for byte as it was. The signed version stays inside the file, so what Edit text replaced can still be read from it; Redact removes the signatures and rewrites the file. Operations that rebuild the whole file (rotate, delete or reorder pages, flatten, OCR) invalidate signatures.
- When you open a file with digital signatures, the signature status is shown in the bottom-right corner. Click it to see each signature's signer, time and certificate, and whether the file is intact.

### 3.9 Forms, text, OCR, file operations

- **Forms**: lists the existing AcroForm fields in the PDF. Fill them in the blue boxes on the page or in the list on the right, then save. A scan without form fields does not suddenly get fillable fields.
- **Plain text view**: extracts the full text so you can read it in the text view. Click again to return to the PDF view.
- **Recognize text in scans (OCR)**: runs text recognition on scans. Chinese and English are recognized together (including both on the same page), using RapidOCR (PaddleOCR models). The result is a new searchable PDF, and saving creates a new file. The recognized text sits in an invisible text layer under the image. You can search, select and copy it, and its position lines up with the text in the image. OCR is an optional component and is not installed by default. The first time you use it, you are asked to install it:
  - Desktop installer version: click **Download and install**. The download is about 170 MB; after it is verified, installation takes a few seconds, with no restart needed.
  - Container setup: in the desktop app, also click **Download and install**. In the browser, follow the prompt and run `./scripts/install-ocr.sh` (Windows: `scripts\install-ocr.ps1`), about 190 MB. You can also install it during the first deployment with `INSTALL_OCR=1 ./scripts/run-podman.sh`.
- **Pictures**: **Open** also accepts JPEG, PNG, TIFF, GIF and BMP files, and **File → PDF from pictures** takes several at once (or drop several on the window): each picture becomes a page, in name order, without losing quality (a phone photo keeps its orientation), and its text is recognized (OCR, on by default). **Tools → Save the pictures** downloads every picture of the document as a ZIP (JPEGs unchanged), with a list of the page and place of each and, by default, the text read in each picture. **Tools → Export as Markdown or JSON** saves the document in reading order with its pictures (needs the document structure component). OCR also reads the pictures on pages that already have text (charts, photos, pasted scans); the page's own text is left as it is (an option in the OCR dialog, on by default). In the browser version TIFF pictures cannot be opened and Markdown/JSON export is not available.
- **Settings → Reading tables, formulas and scans** (desktop app): choose a reading model to download: **Fast** (PaddleOCR-VL 1.6, 0.9 GB, graphics card or processor) or **Best** (Unlimited-OCR 3B, 2.8 GB, needs a graphics card with 5 GB free; experimental). The first choice also installs the document reading component (Docling, about 780 MB), which Markdown/JSON export needs. Once downloaded, the model reads tables, formulas (as LaTeX) and scanned pages for Markdown/JSON export and for agents, by default; **Off** turns it off, and downloaded models can be removed there. On a server, the administrator installs them (`scripts/install-structure.sh`, `scripts/install-model.sh`).
- **File** menu: Open, Combine PDFs, PDF from pictures, Save, Print, Download a password-protected copy, Remove print and copy restrictions, Settings. **Pages** menu: Rotate, Extract / Split, Delete this page. **Tools** menu: Recognize text in scans (OCR), Plain text view, Flatten comments and forms, Save the pictures, Export as Markdown or JSON. Forms has its own toolbar button. Split accepts page ranges (for example `1-3,5,8-`). Encrypt downloads a copy that needs a password; the current document is not changed.
- You can type Chinese into forms.

---

## 4. How agents use it

Agents do not click buttons on the web page. They send HTTP requests to the Gateway, or call the MCP tools of the PDF Engine.

### 4.1 Check that the service is running

```bash
curl http://127.0.0.1:8090/health
```

`/health` needs no key. When the `API_KEY` environment variable is set, `/v1/pdf/*` needs this request header:

```http
X-API-Key: <same key as the server>
```

By default, no key is checked.

### 4.2 One-shot tasks

Merge, split, OCR, extract text, read info, rotate and encrypt all work as “upload a file, get the result back”.

```bash
# Extract text
curl -F "file=@doc.pdf" http://127.0.0.1:8090/v1/pdf/extract

# Page count and metadata
curl -F "file=@doc.pdf" http://127.0.0.1:8090/v1/pdf/info

# Merge
curl -F "files=@a.pdf" -F "files=@b.pdf" http://127.0.0.1:8090/v1/pdf/merge -o merged.pdf

# OCR
curl -F "file=@scan.pdf" -F "languages=eng,chi_sim" http://127.0.0.1:8090/v1/pdf/ocr -o searchable.pdf

# Highlight an area on page 1 (coordinates are PDF points, origin at the top left of the page, y goes down)
curl -F "file=@doc.pdf" -F "page_index=0" -F "x=72" -F "y=120" \
  -F "width=200" -F "height=18" http://127.0.0.1:8090/v1/pdf/highlight -o highlighted.pdf
```

Coordinates match the interface: `page_index` starts at 0, and `x`/`y` are points from the top-left corner of the page.

### 4.3 Making several changes to the same file

For multi-step changes, register a session first. After that, send only `document_id`; you do not need to upload the whole PDF each time. A change with `document_id` returns JSON: `{"ok":true,"document_id":...,"revision":new revision number,"previous_revision":old revision number}`. Changes to the same file are queued.

```bash
# 1. Register
curl -F "file=@doc.pdf" http://127.0.0.1:8090/v1/pdf/register
# {"document_id":"..."}

# 2. Highlight in the session
curl -F "document_id=DOCUMENT_ID" \
  -F "page_index=0" -F "x=72" -F "y=120" -F "width=200" -F "height=18" \
  http://127.0.0.1:8090/v1/pdf/highlight

# 3. Get the current bytes
curl -o current.pdf http://127.0.0.1:8090/v1/pdf/document/DOCUMENT_ID
```

`GET /v1/pdf/document/{id}/meta` returns `revision`, `revisions` (versions that can still be restored), `etag` and `size`. `GET /v1/pdf/document/{id}` supports `Range`.

```bash
# Undo: restore the session to an older revision (this creates a new revision number)
curl -F "revision=3" http://127.0.0.1:8090/v1/pdf/document/DOCUMENT_ID/restore

# Pages: keep and reorder pages (numbered from 1); pages not listed are deleted
curl -F "document_id=DOCUMENT_ID" -F "order=3,1,2" http://127.0.0.1:8090/v1/pdf/pages

# Rotate some pages (clockwise; empty pages means all pages)
curl -F "document_id=DOCUMENT_ID" -F "angle=90" -F "pages=1,3-5" http://127.0.0.1:8090/v1/pdf/rotate

# Delete the session when you are done
curl -X DELETE http://127.0.0.1:8090/v1/pdf/document/DOCUMENT_ID
```

Sessions are stored on disk and survive a restart. Each session keeps the last 40 revisions for undo. Sessions unused for more than 7 days are cleaned up, and when all sessions together exceed 4 GB, the least recently used ones are cleaned up. An expired session returns 404 with the response header `X-Error-Code: session_expired`, and you need to register again.

Error messages are short English sentences meant for people, for example “The PDF is encrypted, or the password is wrong” and “Page numbers out of range: 9 (the document has 3 pages)”. The upload limit is 200 MB by default (`MAX_UPLOAD_MB`).

### 4.4 The equivalent of Edit text / Add text in the interface

The interface keeps its text boxes and comments as a list (placements). `embed-placements` stores the list in the file (so the editor can open the boxes again) and draws it into the pages, in the layer “OpenPDF edits”; Edit text boxes (`kind: "cover"`) first remove what is under them. Each call replaces the previous drawing. If an agent wants **text boxes that this editor can open again**, it should read and write placements.

placements is a JSON array. Each item looks roughly like this:

```json
{
  "id": "any stable id",
  "kind": "cover",
  "pageIndex": 0,
  "x": 72,
  "y": 120,
  "width": 160,
  "height": 22,
  "text": "replacement text",
  "fontSize": 14,
  "fontFamily": "Helvetica",
  "colors": {
    "editBackground": "#86efac",
    "editColor": "#111827",
    "idleBackground": "#ffffff",
    "idleColor": "#111827"
  }
}
```

`kind` is `cover` for Edit text and `plain` for Add text (comments: `callout`, with `anchorX`/`anchorY`). Positions are points from the top-left of the page as displayed. You can leave out `colors`; then the defaults are used (the idle colors are the ones drawn into the page).

```bash
# Read the existing text boxes
curl -F "file=@doc.pdf" http://127.0.0.1:8090/v1/pdf/read-placements

# Write them back. placements is the whole list, not an incremental patch
# ("黑体" is the stored value for the Hei (Chinese sans) font)
curl -F "file=@doc.pdf" \
  -F 'placements=[{"id":"b1","kind":"cover","pageIndex":0,"x":72,"y":120,"width":180,"height":28,"text":"New text","fontSize":14,"fontFamily":"黑体"}]' \
  http://127.0.0.1:8090/v1/pdf/embed-placements -o with-boxes.pdf
```

With a session (`document_id`), the JSON answer has `edits`: what was drawn and removed (`glyphsErased`, `imagesErased`, `textLeft`, `notErased`).

`draw-text`, `replace-text`, `erase-region` and `move-text` are older low-level endpoints that draw straight into the page content (white rectangles included, without removing anything). The interface no longer calls them.

### 4.5 Callout boxes, forms, signatures

```bash
# Callout box: anchor (anchor_x, anchor_y), text box (x, y, width, height)
curl -F "file=@doc.pdf" -F "page_index=0" -F "text=Note" \
  -F "anchor_x=80" -F "anchor_y=200" \
  -F "x=160" -F "y=80" -F "width=160" -F "height=48" \
  http://127.0.0.1:8090/v1/pdf/callout -o callout.pdf

# List form fields
curl -F "file=@form.pdf" http://127.0.0.1:8090/v1/pdf/form-fields

# Fill in. values is a JSON object whose keys are the full field names
curl -F "file=@form.pdf" -F 'values={"Name":"Ada"}' \
  http://127.0.0.1:8090/v1/pdf/fill-form -o filled.pdf

# Place an image. The field name is image
curl -F "file=@doc.pdf" -F "image=@sign.png" \
  -F "page_index=0" -F "x=72" -F "y=500" -F "width=120" -F "height=48" \
  http://127.0.0.1:8090/v1/pdf/sign -o signed.pdf

# Place several signatures at once (images can hold several pictures; placements refers to them by image index)
curl -F "file=@doc.pdf" -F "images=@sign.png" -F mode=flatten \
  -F 'placements=[{"page":0,"x":72,"y":600,"width":150,"height":50,"image":0}]' \
  http://127.0.0.1:8090/v1/pdf/stamp-signatures -o signed.pdf

# Digital signature: sign into the existing signature field Signer1; or set the position with visible/page_index/x/y/width/height
curl -F "file=@doc.pdf" -F "cert=@me.p12" -F "cert_password=..." -F "field_name=Signer1" \
  http://127.0.0.1:8090/v1/pdf/digital-sign -o signed.pdf

# Verify
curl -F "file=@signed.pdf" http://127.0.0.1:8090/v1/pdf/verify-signatures
```

### 4.6 Using MCP in Cursor

```bash
python3 -m venv .venv-mcp
source .venv-mcp/bin/activate
pip install -r mcp/requirements.txt
export PDF_GATEWAY_URL=http://127.0.0.1:8090
python3 mcp/server.py
```

Merge [mcp/cursor.mcp.json.example](../mcp/cursor.mcp.json.example) into Cursor's MCP configuration. Once it is set up, the agent can handle requests like “merge these two PDFs” or “extract the text from this scan”, which map to `pdf_merge`, `pdf_ocr`, `pdf_extract_text` and so on.

If the task is Edit text, Add text, callout boxes or filling in forms, have the agent call REST directly as in 4.4 and 4.5. Do not assume MCP already has tools with those names.

---

## 5. What it cannot do yet

- Edit text rewraps one paragraph at a time; a paragraph with mixed fonts or styles (bold words, links) is written in one style, and a longer paragraph does not push what follows down (a message says when it may run into it). Documents usually embed only the characters they use: new characters fall back to a standard font of the same kind. While editing, the box shows the document's font only until the file is reloaded.
- Edit text removes characters, picture pixels and shapes wholly under the box, not pictures used as masks (a message says when something stayed). For confidential content use Redact.
- The Song (Chinese serif) and Hei (Chinese sans) choice affects the display in this editor; in the file, Chinese and other scripts use the embedded WenQuanYi Micro Hei font, and English Helvetica, Times or Courier. Emoji become “?”.
- MCP does not cover the whole REST API.
- Several people cannot edit the same file at the same time.
- It cannot create new AcroForm fields; it can only fill in existing ones.
- When you close the desktop app window directly, it does not warn about unsaved changes (the browser version does).
