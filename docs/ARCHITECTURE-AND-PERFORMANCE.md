# OpenPDF Architecture and Performance Design

This document describes the project structure of OpenPDF, the editing session model, and the **Lazy Sync** performance strategy. The goal: keep editing smooth, and refresh the PDF canvas only when necessary.

For the feature list, how OpenPDF differs from other PDF software, and how people and agents use it, see [FEATURES.md](./FEATURES.md).

---

## 1. Project overview

| Layer | Path | Responsibility |
|------|------|------|
| Web UI | `gateway/app/static/` | The editor (`app.js` / `index.html` / `styles.css`) |
| REST Gateway | `gateway/app/` | FastAPI: authentication, routing, document sessions |
| Document sessions | `gateway/app/document_store.py` | Server-side **Working Copy** on disk (with revision history, kept across restarts) |
| PDF engine | `services/pdfbox/` | Edit text / Add text (drawing, erasing), highlight, forms, signatures, etc. |
| Orchestration | OCR / qpdf | Merge, split, OCR, encrypt, etc. |

```
Browser (app.js + pdf.js)
    │  POST /v1/pdf/*  (document_id)
    ▼
Gateway :8090
    │  document_store.update()   ← every edit updates the server-side cache
    ▼
PDFBox sidecar :8092
```

Installers: [openpdf-releases](https://github.com/gary1381/openpdf-releases)

---

## 2. Core concepts

### 2.1 Working Copy

- When a PDF is opened, the client calls `/v1/pdf/register`. The server assigns a `document_id` and stores the PDF bytes in `document_store`.
- Later editing API calls carry the `document_id`. After the server applies a change, it **returns only JSON** (`{ ok, document_id, revision, previous_revision }`), not the whole PDF.
- The file is actually written to disk only when the user clicks **Save** (download, or save over the source file).

### 2.2 Three layers of state

| Layer | Where it is stored | Contents |
|------|----------|------|
| **Server Working Copy** | `document_store` | The authoritative PDF bytes, updated after every API edit |
| **Client DOM preview** | overlay / optimistic UI | Light blue Add text boxes, dark blue Edit text boxes, the highlight layer, form controls |
| **Client pdf.js canvas** | `doc.pdfDoc` + canvas | Bitmaps rendered from the PDF; **may lag behind the server** |

### 2.3 Root cause of the problem (before the rework)

After every successful edit, the frontend called `queueDocumentSync` → `syncDocumentFromServer` 200 ms later:

1. `GET /v1/pdf/document/{id}` downloads the whole PDF  
2. `pdfjsLib.getDocument()` does a **full parse** (blocks the main thread)  
3. `patchPageRender()` redraws the canvas + rebuilds the overlay  

For large files (tens of MB, hundreds of pages), one pass took 1–3 seconds. Dragging lagged, and switching tools stuttered.

**Conclusion**: the server already had a cache. The stutter came from the frontend's **overly eager full reload**, not from a missing cache.

---

## 3. Lazy Sync strategy

### 3.1 Principles

```
Edit  =  API updates the server Working Copy  +  local overlay/optimistic preview
      ≠  immediately download and re-parse the whole PDF

Save  =  get the final PDF from the server  +  embed metadata  +  write to disk
View  =  when leaving edit mode, refresh the canvas of "stale pages" as needed
```

### 3.2 `markPageStale(doc, pageNum)`

After a successful edit, the client **only marks** that the page's canvas differs from the server:

- Set `doc.dirty = true`
- Add the page number to `doc.stalePages` (a `Set`)
- Do **not** start a network download or a pdf.js parse

### 3.3 When the canvas is refreshed

| When | Behavior | Why |
|------|------|------|
| Edit text / Add text / Highlight / move / form filling | `markPageStale` only | The overlay already gives a live preview |
| While an overlay is being dragged | Skip all refreshes | Avoid rebuilding the DOM |
| **Leaving edit mode → Select** | `scheduleStalePageRefresh` (400 ms debounce, in the background) | Once the overlay is hidden, the user must see the real PDF |
| **Save** | `flushDocumentSync` (immediately, all stale pages) | Must match the server before export |
| **Print preview** | `flushDocumentSync` | Uses the latest bytes |
| Rotate / delete page / reorder pages / OCR / split / unlock / flatten | `runDocumentOperation` → run on the session → `reloadWholeDocument` | The document structure changes |

### 3.4 Change queue and session recovery

- `register` runs as soon as a file is opened (one upload only). After that, every change carries the `document_id`.
- `queueDocMutation(doc, task)`: changes to the same document are queued in the browser, and the next one is sent only after the previous one finishes. The server also has a lock per session. Together, the two layers make sure that quick successive changes do not overwrite each other.
- `waitForDocMutations(doc)`: save, print, export and undo first wait for the queue to empty.
- When the server returns 404 with `X-Error-Code: session_expired`, `recoverDocumentSession` registers again with the latest copy in the browser, retries once, and shows a message in the status bar.
- `downloadDocumentBlob` discards versions older than the current one, so an old download that arrives late cannot overwrite newer content.

### 3.5 Undo / Redo

- Server-side changes: each one returns `previous_revision` / `revision`, which is recorded in `doc.undoStack`. Undo calls `POST /document/{id}/restore` to restore an older revision (this creates a new revision number). Redo restores a newer revision.
- Text boxes and comments (browser only): after each change settles (300 ms), the state is compared with the previous snapshot and recorded as a local step.
- Page actions also record before and after snapshots of the text boxes, and undo restores them together.
- Undo / Redo first waits for changes in progress to finish, and never runs concurrently.

### 3.6 Drawing pages on demand

`refreshViewer` only creates placeholder pages of the correct size. `IntersectionObserver` draws a page when it comes near the visible area (±900px) and releases the canvas when it is far away (±4000px). Thumbnails work the same way. Canvases are drawn according to `devicePixelRatio`, so they are sharp on high-DPI screens. When a 60-page document opens, only 2–3 pages are drawn.

---

## 4. Editing tools and how they are previewed

| Tool | `editMode` | What you see in this editor | What is written into the PDF |
|------|------------|------------------|----------------|
| Select | `select` | pdf.js text layer | — |
| Edit text | `cover-text` | Dark blue text box that can be dragged and resized; black on white after the tool is off. A click on the page's text opens that line prefilled (`textRunAt`) | On save: what is under the box is removed (`RegionEraser`), the box drawn into the page (layer “OpenPDF edits”, `EditsLayer`), and kept in the metadata `PdfGatewayPlacements` |
| Add text | `replace-text` | Light blue text box; background becomes transparent after the tool is off | Drawn into the page and kept in the metadata, as above (nothing removed) |
| Comment | `annotate` | The callout box follows the end of the arrow; can be dragged, re-pointed, and its properties changed with right-click | `callouts` in the placements metadata, drawn into the page as above |
| Highlight | `highlight` | Yellow highlight | Highlight annotation |
| Erase | `erase-highlight` | Removes the highlight | Deletes the highlight annotation |
| Insert image | `insert-image` | Preview box | Image on the page (`/sign`) |
| Sign | `sign` | Signature placed by clicking | Image part of the page or a stamp annotation (`/stamp-signatures`); digital signatures with `/digital-sign` |
| Forms | **Forms** button (F) and a field list on the right | Blue form boxes | AcroForm field values |

**Placements**: text boxes are kept in `doc.placedTexts` (text, position, font size, font, colors), comments in `doc.callouts`. On save (also print and export), `/v1/pdf/embed-placements` writes them to `PdfGatewayPlacements` in the PDF document information, removes what Edit text boxes cover, and draws all of them into the pages as one form XObject per page in the optional content group “OpenPDF edits” (tagged `/OpenPDFEdits`, so the next save replaces it). `/read-placements` restores the boxes when the file is reopened; OpenPDF then hides that layer when rendering with pdf.js (`editsLayerHidden`), because it draws the boxes itself.

---

## 5. Key frontend API (app.js)

```text
ensureDocumentSession(doc)     register a document_id (if not registered yet)
markPageStale(doc, pageNum)      mark a page as needing refresh, without downloading
scheduleStalePageRefresh(doc)    debounced background refresh of stale pages
flushDocumentSync(doc)           before save/print: cancel the timer, sync immediately
syncDocumentFromServer(doc, pages[])  download the PDF once, patchPageRender in a batch
refreshStalePages(doc, opts)     refresh all stalePages
reloadWholeDocument(doc)         download and redraw after the document structure changes
```

### 5.1 Drag performance

- `placementInteraction` lock: during drag/resize, `renderPlacedTextOverlays` and sync are blocked.
- `attachOverlayDrag`: shared by Edit text and Add text; follows the mouse with `requestAnimationFrame`.
- Committing a move: **optimistic update** with `rememberPlacedText`; the API writes to the server asynchronously.

---

## 6. Backend session API

| Endpoint | Description |
|------|------|
| `POST /v1/pdf/register` | Upload a PDF, returns `document_id` |
| `GET /v1/pdf/document/{id}` | Download the current Working Copy |
| `POST /v1/pdf/draw-text` etc. | `document_id` → updated inside the session lock, returns `{revision, previous_revision}` |
| `POST /v1/pdf/document/{id}/restore` | Restore one of the kept revisions (Undo / Redo) |
| `DELETE /v1/pdf/document/{id}` | Release the session when the tab is closed |

`document_store` writes sessions to disk (`SESSION_DIR`, container volume `pdf-gateway-sessions`): one directory per session, with `meta.json` + one `rev-N.pdf` per kept revision. Writes are atomic, and sessions load automatically after a restart. The last `SESSION_HISTORY` (40) revisions are kept. When a session has been idle longer than `SESSION_TTL_HOURS` (168), or the total exceeds `SESSION_MAX_TOTAL_MB` (4096), the least recently used sessions that have not been used within the last hour are cleaned up. The gateway is designed as a single process (one uvicorn worker).

---

## 7. Save flow

1. Commit pending image overlays and text being typed  
2. If there are forms → `persistFormFieldValues`  
3. `waitForDocMutations` — wait for all queued changes to finish  
4. `embedPlacementsIntoSession` — write the placements metadata on the session (the whole file is no longer uploaded)  
5. Download the current revision of the session  
6. `saveBlobToDisk` — save over the original file or download in the browser (see §11). Documents created by split / OCR / unlock have no original file handle, so a Save As dialog opens  
7. Clear the unsaved marker; the same session stays in use and the undo history is kept  

Saves of the same document never run concurrently (`doc._saving`).

**Save mode** (**Settings** → save mode, default **Save to the original file**):

| Mode | Behavior |
|------|------|
| **Save to the original file** | Writes back to `fileHandle` with the File System Access API. Without a handle, a Save As dialog opens and the handle is remembered |
| **Save a new copy** | Classic `<a download>` |

Choosing a file with **Open** (not by dragging) gives a `fileHandle`. After that, Ctrl+S can save directly over the original file on disk.

---

## 8. Known trade-offs

1. **In edit mode**: the overlay is accurate; the canvas may be slightly out of date. This is acceptable.  
2. **Switching back to Select mode**: stale pages are refreshed in the background, and “Updating preview…” is shown briefly.  
3. **Edit text / Add text**: the boxes stay after the tool is off (Add text with a transparent background, Edit text black on white). While editing they live in the overlay; they are drawn into the page (and what Edit text covers removed) only when saving, printing or exporting.  
4. **Full pdf.js parse**: still unavoidable on save/refresh, but avoided during editing. Parsing runs in a **Web Worker** (see §11).  

### Future optimizations

- The server returns a **single-page raster** or an incremental patch, to avoid a full `getDocument`  
- Fetch PDF bytes on demand with HTTP Range, to reduce the download size of a sync  

---

## 9. Local development

```bash
cd /path/to/OpenPDF
./scripts/start.sh         # or ./scripts/run-podman.sh (rebuild) / docker compose up -d --build
# Web UI: http://127.0.0.1:8090/
# after changing the frontend, press Ctrl+F5 to force a reload
```

---

## 10. Phase 1 checklist

- [x] Replace `queueDocumentSync` on the edit path with `markPageStale`
- [x] `flushDocumentSync` before save / print
- [x] `scheduleStalePageRefresh` when leaving edit mode
- [x] `placementInteraction` lock during drag
- [x] `replaceActiveBlob` does not reset the edit mode or clear the global overlay when updating a single page
- [x] This document

---

## 11. Phase 2: Worker parsing and saving over the original file

### 11.1 pdf.js Worker

`index.html` sets `GlobalWorkerOptions.workerSrc`. PDF parsing runs in a Worker thread; the main thread only waits for the Promise.

Single entry points:

```text
loadPdfDocument(source)   copy the ArrayBuffer, then getDocument
destroyPdfDocument(doc)   release the old pdfDoc to avoid memory leaks
```

All of `openFile` / `syncDocumentFromServer` / `reloadWholeDocument` / `reloadDocFromBlob` go through these helpers.

### 11.2 Saving over the file with File System Access

| API | Purpose |
|-----|------|
| `showOpenFilePicker` | Gets a `fileHandle` on **Open** |
| `showSaveFilePicker` | Chooses a path on the first save when there is no handle |
| `createWritable()` | Writes the final blob back to disk |

`doc.fileHandle` lives as long as the tab. Files opened by dragging or with `<input type=file>` have no handle, so the first save opens a Save As dialog.

The preference is stored in the `localStorage` key `openpdf_save_mode`.

---

## 12. Phase 3: Revision-aware sync and single-page raster

### 12.1 Document revisions (revision + etag)

On every `update()`, the server-side `document_store` increments `revision` and provides a SHA-256 `etag`.

| Endpoint | Description |
|------|------|
| `GET /v1/pdf/document/{id}/meta` | Lightweight JSON: `revision`, `size`, `etag` |
| `GET /v1/pdf/document/{id}` | Response headers `X-Document-Revision`, `ETag`, `Accept-Ranges` |

### 12.2 Smart sync (`syncDocumentFromServer`)

```text
1. GET /meta
2. revision unchanged + pdfDoc exists → only patchPageRender (no download, no parse)
3. background refresh (preferRaster) → server renders one page as PNG; PDF download is deferred
4. save/print → full download + reloadPdfDocIfChanged (skips getDocument if the fingerprint is the same)
```

Client fields: `doc.serverRevision`, `doc.pdfEtag`, `doc.pdfFingerprint`.

### 12.3 Single-page raster preview

| Endpoint | Description |
|------|------|
| `POST /v1/pdf/render-page` | PDFBox `PDFRenderer` → PNG |

Used for the background refresh of stale pages when leaving edit mode: first the server-rendered image is shown (within milliseconds), then the PDF is downloaded when idle and the pdf.js text layer is filled in.

### 12.4 HTTP Range

`GET /document/{id}` supports `Range: bytes=start-end` (206 Partial Content), reserved for streaming loads in pdf.js later.
