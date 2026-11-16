const API_KEY_STORAGE = "pdf_gateway_api_key";
const SAVE_MODE_STORAGE = "openpdf_save_mode";
const SAVE_MODES = { OVERWRITE: "overwrite", DOWNLOAD: "download" };
// + / - and Ctrl+wheel walk these steps. 10% to 3200%: beyond that a page
// would be tens of thousands of pixels wide.
const ZOOM_STEPS = [
  0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32,
];
const ZOOM_MIN = ZOOM_STEPS[0];
const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];
// Largest page picture drawn (pixels). Past it the picture is drawn at a lower
// resolution and stretched: very high zoom gets softer instead of running out
// of memory.
const MAX_CANVAS_PIXELS = 4096 * 4096;

const state = {
  docs: [],
  activeId: null,
  viewMode: "continuous",
  zoom: 1,
  fitWidth: true,
  pagesPanelOpen: true,
  editMode: null,
  pendingSignImage: null,
  selection: null,
  textFontSize: 14,
  textFontFamily: "Helvetica",
  inlineTextEditor: null,
  selectedPlacementId: null,
  selectedCalloutId: null,
  placementInteraction: null,
  imageCursor: null,
  pendingImageOverlay: null,
};

const els = {
  app: document.getElementById("app"),
  tabbar: document.getElementById("tabbar"),
  openTabBtn: document.getElementById("openTabBtn"),
  fileInput: document.getElementById("fileInput"),
  mergeInput: document.getElementById("mergeInput"),
  imagesInput: document.getElementById("imagesInput"),
  welcome: document.getElementById("welcome"),
  welcomeOpenBtn: document.getElementById("welcomeOpenBtn"),
  viewerDrop: document.getElementById("viewerDrop"),
  viewerScroll: document.getElementById("viewerScroll"),
  viewerPages: document.getElementById("viewerPages"),
  textPanel: document.getElementById("textPanel"),
  thumbnails: document.getElementById("thumbnails"),
  pagesPanel: document.getElementById("pagesPanel"),
  togglePagesBtn: document.getElementById("togglePagesBtn"),
  propsPanel: document.getElementById("propsPanel"),
  propsTitle: document.getElementById("propsTitle"),
  propsBody: document.getElementById("propsBody"),
  statusMessage: document.getElementById("statusMessage"),
  pageIndicator: document.getElementById("pageIndicator"),
  prevPageBtn: document.getElementById("prevPageBtn"),
  nextPageBtn: document.getElementById("nextPageBtn"),
  zoomSelect: document.getElementById("zoomSelect"),
  zoomInBtn: document.getElementById("zoomInBtn"),
  zoomOutBtn: document.getElementById("zoomOutBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsDialog: document.getElementById("settingsDialog"),
  apiKey: document.getElementById("apiKey"),
  toolDialog: document.getElementById("toolDialog"),
  toolDialogTitle: document.getElementById("toolDialogTitle"),
  toolDialogBody: document.getElementById("toolDialogBody"),
  toolForm: document.getElementById("toolForm"),
  toolCancelBtn: document.getElementById("toolCancelBtn"),
  printDialog: document.getElementById("printDialog"),
  printFrame: document.getElementById("printFrame"),
  printCloseBtn: document.getElementById("printCloseBtn"),
  printRunBtn: document.getElementById("printRunBtn"),
  textStyleToolbar: document.getElementById("textStyleToolbar"),
  textStyleSep: document.getElementById("textStyleSep"),
  textFontFamilySelect: document.getElementById("textFontFamilySelect"),
  textFontSizeSelect: document.getElementById("textFontSizeSelect"),
  saveModeSelect: document.getElementById("saveModeSelect"),
  findBar: document.getElementById("findBar"),
  findInput: document.getElementById("findInput"),
  findCount: document.getElementById("findCount"),
  findPrevBtn: document.getElementById("findPrevBtn"),
  findNextBtn: document.getElementById("findNextBtn"),
  findCloseBtn: document.getElementById("findCloseBtn"),
  toolHint: document.getElementById("toolHint"),
  toolHintText: document.getElementById("toolHintText"),
  toolHintDone: document.getElementById("toolHintDone"),
  pageInput: document.getElementById("pageInput"),
  pageCountLabel: document.getElementById("pageCountLabel"),
  propsCloseBtn: document.getElementById("propsCloseBtn"),
};

/** Every control that runs an action: toolbar buttons and menu items. */
function actionControls(action = null) {
  const selector = action
    ? `.tool-btn[data-action="${action}"], .menu-item[data-action="${action}"]`
    : ".tool-btn[data-action], .menu-item[data-action]";
  return document.querySelectorAll(selector);
}

function activeDoc() {
  return state.docs.find((d) => d.id === state.activeId) || null;
}

/**
 * Show a message in the status bar. A "sticky" message (used for warnings
 * the user must not miss) is not replaced by routine progress for a few seconds.
 */
function setStatus(message, type = "", { sticky = 0 } = {}) {
  const now = Date.now();
  if (!sticky && type !== "error" && state._stickyUntil > now) return;
  state._stickyUntil = sticky ? now + sticky : 0;
  els.statusMessage.textContent = message;
  els.statusMessage.className = `status-message ${type}`.trim();
}

function headers() {
  const key = els.apiKey.value.trim();
  const h = {};
  if (key) h["X-API-Key"] = key;
  return h;
}

// English source marked with N_; translated where it is shown.
const STATUS_FALLBACK_MESSAGES = {
  401: N_("The API key is wrong or missing (enter it in Settings)"),
  403: N_("The request was refused"),
  404: N_("The requested item was not found"),
  413: N_("The file is too large"),
  502: N_("The background service had an error. Please try again later."),
  503: N_("The background service isn't running or is restarting. Please try again later."),
  504: N_("This took too long. Please try again later."),
};

async function apiError(resp) {
  let message = "";
  try {
    const data = await resp.json();
    const detail = data?.detail;
    if (typeof detail === "string") message = detail;
    else if (Array.isArray(detail)) message = t("The request had invalid values");
    else if (detail && typeof detail === "object") message = detail.message || "";
  } catch (_) {
    /* not JSON */
  }
  if (!message) {
    const fallback = STATUS_FALLBACK_MESSAGES[resp.status];
    message = fallback ? t(fallback) : t("Request failed ({status})", { status: String(resp.status) });
  }
  const err = new Error(message);
  err.status = resp.status;
  err.code = resp.headers.get("X-Error-Code") || "";
  return err;
}

async function apiFetch(path, init = {}) {
  try {
    return await fetch(path, { ...init, headers: { ...headers(), ...(init.headers || {}) } });
  } catch (_) {
    const err = new Error(t("Can't connect to the {app} service. Make sure it is running."));
    err.status = 0;
    throw err;
  }
}

async function apiPost(path, formData) {
  const resp = await apiFetch(path, { method: "POST", body: formData });
  if (!resp.ok) throw await apiError(resp);
  const type = resp.headers.get("content-type") || "";
  if (type.includes("application/json")) return resp.json();
  const blob = await resp.blob();
  return { blob };
}

async function apiGetBlob(path) {
  const resp = await apiFetch(path);
  if (!resp.ok) throw await apiError(resp);
  return resp.blob();
}

async function apiGetJson(path) {
  const resp = await apiFetch(path);
  if (!resp.ok) throw await apiError(resp);
  return resp.json();
}

function isSessionExpired(err) {
  return err?.code === "session_expired";
}

async function fingerprintBlob(blob) {
  const buf = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchDocumentMeta(doc) {
  if (!doc?.documentId) return null;
  return apiGetJson(`/v1/pdf/document/${doc.documentId}/meta`);
}

async function downloadDocumentBlob(doc) {
  const documentId = doc.documentId;
  const resp = await apiFetch(`/v1/pdf/document/${documentId}`);
  if (!resp.ok) throw await apiError(resp);
  const revision = Number(resp.headers.get("X-Document-Revision"));
  const etag = resp.headers.get("ETag")?.replace(/"/g, "");
  const blob = await resp.blob();
  // A slower, older download must not replace a newer copy (or one from a
  // session that has since been replaced).
  if (
    doc.documentId !== documentId ||
    (Number.isFinite(revision) && doc._blobRevision != null && revision < doc._blobRevision)
  ) {
    return doc.blob;
  }
  if (Number.isFinite(revision)) doc._blobRevision = revision;
  doc.blob = blob;
  doc.file = blobToFile(blob, doc.name);
  if (Number.isFinite(revision)) doc.serverRevision = revision;
  if (etag) doc.pdfEtag = etag;
  return blob;
}

async function reloadPdfDocIfChanged(doc, blob) {
  const fp = await fingerprintBlob(blob);
  if (doc.pdfFingerprint === fp && doc.pdfDoc) {
    return false;
  }
  await destroyPdfDocument(doc);
  doc.pdfDoc = await loadPdfDocument(blob);
  doc.pageCount = doc.pdfDoc.numPages;
  doc.pdfFingerprint = fp;
  window.OpenPDFSign?.onDocChanged(doc);
  return true;
}

async function applyServerMeta(doc, meta) {
  if (!meta) return;
  doc.serverRevision = meta.revision;
  doc.pdfEtag = meta.etag;
}

function supportsFileSystemAccess() {
  return typeof window.showOpenFilePicker === "function";
}

// Where the "Open" dialog starts: "last" (folder of the last file) or
// "documents". The desktop app reads the same key for its own dialog.
const OPEN_START_STORAGE = "openpdf.openStart";

function getOpenStart() {
  try {
    return localStorage.getItem(OPEN_START_STORAGE) === "documents" ? "documents" : "last";
  } catch (_) {
    return "last";
  }
}

function setOpenStart(value) {
  try {
    localStorage.setItem(OPEN_START_STORAGE, value === "documents" ? "documents" : "last");
  } catch (_) {
    /* private mode: keep the default */
  }
}

function getSaveMode() {
  const stored = localStorage.getItem(SAVE_MODE_STORAGE);
  if (stored === SAVE_MODES.DOWNLOAD) return SAVE_MODES.DOWNLOAD;
  return SAVE_MODES.OVERWRITE;
}

function setSaveMode(mode) {
  localStorage.setItem(
    SAVE_MODE_STORAGE,
    mode === SAVE_MODES.DOWNLOAD ? SAVE_MODES.DOWNLOAD : SAVE_MODES.OVERWRITE
  );
}

async function destroyPdfDocument(doc) {
  if (!doc?.pdfDoc) return;
  try {
    await doc.pdfDoc.destroy();
  } catch (_) {
    /* ignore */
  }
  doc.pdfDoc = null;
}

const PDFJS_ASSETS = "/ui/vendor/pdfjs";

async function loadPdfDocument(source, options = {}) {
  const data = source instanceof ArrayBuffer ? source : await source.arrayBuffer();
  return pdfjsLib.getDocument({
    data: data.slice(0),
    isEvalSupported: false,
    cMapUrl: `${PDFJS_ASSETS}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_ASSETS}/standard_fonts/`,
    ...(options.password ? { password: options.password } : {}),
  }).promise;
}

async function ensureFileHandleWritePermission(handle) {
  if (!handle) return false;
  let perm = await handle.queryPermission({ mode: "readwrite" });
  if (perm === "granted") return true;
  perm = await handle.requestPermission({ mode: "readwrite" });
  return perm === "granted";
}

async function writeBlobToFileHandle(handle, blob) {
  if (!(await ensureFileHandleWritePermission(handle))) {
    throw new Error(t("No permission to write to the original file"));
  }
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function saveBlobToDisk(doc, blob, filename) {
  const name = filename || doc?.name || "document.pdf";
  const mode = getSaveMode();

  // Desktop app: it receives the PDF as a download. A name ending in
  // ".openpdf-save" asks it to write back to the opened file; a plain name
  // goes to Downloads. It then calls window.__openpdfSaved(path).
  if (window.__openpdfDesktop) {
    const url = downloadBlob(blob, mode === SAVE_MODES.DOWNLOAD ? name : `${name}.openpdf-save`);
    if (doc) desktopSaves.set(url, { docId: doc.id, gen: doc._editGen || 0, name: doc.name });
    return { method: "desktop", name };
  }

  if (mode === SAVE_MODES.DOWNLOAD) {
    downloadBlob(blob, name);
    return { method: "download", name };
  }

  if (doc?.fileHandle) {
    try {
      await writeBlobToFileHandle(doc.fileHandle, blob);
      return { method: "overwrite", name: doc.fileHandle.name || name };
    } catch (err) {
      if (err.name !== "NotAllowedError") throw err;
    }
  }

  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [
          { description: "PDF", accept: { "application/pdf": [".pdf"] } },
          { description: t("Pictures"), accept: { "image/*": [".jpg", ".jpeg", ".png", ".tif", ".tiff", ".gif", ".bmp"] } },
        ],
      });
      if (doc) {
        doc.fileHandle = handle;
        doc.name = handle.name || name;
        renderTabs();
      }
      await writeBlobToFileHandle(handle, blob);
      return { method: "overwrite", name: handle.name || name };
    } catch (err) {
      if (err.name === "AbortError") throw err;
      throw err;
    }
  }

  downloadBlob(blob, name);
  return { method: "download", name };
}

async function pickAndOpenPdf() {
  if (supportsFileSystemAccess()) {
    try {
      // Start in the folder of the last file, or in Documents (a setting).
      // Without a start folder the Linux file dialog opens on "Recent", which
      // checks every recently used file on disk first and can be slow.
      const options = {
        types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
        multiple: false,
      };
      if (getOpenStart() === "documents") {
        options.startIn = "documents";
      } else {
        options.id = "openpdf-open";
        options.startIn = (await lastRecentHandle()) || "documents";
      }
      const [handle] = await window.showOpenFilePicker(options);
      const file = await handle.getFile();
      await openFile(file, { fileHandle: handle });
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
  state._pickStartedAt = performance.now();
  console.info(`[openpdf] open button at ${Date.now()}`);
  els.fileInput.click();
}

function appendDocToForm(fd, doc) {
  if (!doc.documentId) throw new Error(t("The document isn't ready yet. Please try again in a moment."));
  fd.append("document_id", doc.documentId);
}

async function registerDocument(doc) {
  const fd = new FormData();
  fd.append("file", blobToFile(doc.blob, doc.name));
  const data = await apiPost("/v1/pdf/register", fd);
  doc.documentId = data.document_id;
  doc.serverRevision = data.revision ?? 1;
  return data;
}

async function ensureDocumentSession(doc) {
  if (doc.documentId) return;
  if (doc._registerPromise) {
    try {
      await doc._registerPromise;
    } catch (_) {
      /* retried below */
    }
  }
  if (!doc.documentId) {
    doc._registerPromise = registerDocument(doc);
    await doc._registerPromise;
  }
}

/**
 * The server lost this document's session (expired, deleted, or the server
 * data was reset). Start a new session from the newest copy held in the
 * browser so the user can keep working and saving.
 */
async function recoverDocumentSession(doc) {
  if (doc._recovering) return doc._recovering;
  doc._recovering = (async () => {
    const fd = new FormData();
    fd.append("file", blobToFile(doc.blob, doc.name));
    const data = await apiPost("/v1/pdf/register", fd);
    doc.documentId = data.document_id;
    doc.serverRevision = data.revision ?? 1;
    doc._blobRevision = null;
    doc.pdfEtag = null;
    doc.undoStack = (doc.undoStack || []).filter((entry) => entry.type === "local");
    doc.redoStack = (doc.redoStack || []).filter((entry) => entry.type === "local");
    updateUndoButtons();
    setStatus(t("Your editing session expired and was restored from the copy in this browser. If your last change is missing, please make it again."), "error", {
      sticky: 10000,
    });
  })().finally(() => {
    doc._recovering = null;
  });
  return doc._recovering;
}

/**
 * Run server edits for one document strictly one after another, so a quick
 * second edit never races the first. `task` builds its own form at run time
 * (the session id can change if the session had to be recovered).
 */
function queueDocMutation(doc, task, { recover = true, allowSigned = false } = {}) {
  const run = async () => {
    // a digitally signed file: ask before an edit breaks the signature
    if (!allowSigned) await window.OpenPDFSign?.guardEdit(doc);
    await ensureDocumentSession(doc);
    try {
      return await task();
    } catch (err) {
      if (recover && isSessionExpired(err)) {
        await recoverDocumentSession(doc);
        return task();
      }
      throw err;
    }
  };
  doc._pendingMutations = (doc._pendingMutations || 0) + 1;
  scheduleTabsRender();
  const result = (doc._mutationTail || Promise.resolve()).then(run, run);
  doc._mutationTail = result
    .catch(() => {})
    .finally(() => {
      doc._pendingMutations -= 1;
      scheduleTabsRender();
    });
  return result;
}

async function waitForDocMutations(doc) {
  let tail = null;
  while (doc?._mutationTail && tail !== doc._mutationTail) {
    tail = doc._mutationTail;
    await tail;
  }
}

/** Read-only call that needs the session; recovers once if it expired. */
async function withDocSession(doc, task) {
  await ensureDocumentSession(doc);
  try {
    return await task();
  } catch (err) {
    if (!isSessionExpired(err)) throw err;
    await recoverDocumentSession(doc);
    return task();
  }
}

function isDocDirty(doc) {
  return !!(doc && (doc.dirty || doc.placementsDirty || doc._pendingMutations > 0));
}

let tabsRenderQueued = false;
function scheduleTabsRender() {
  if (tabsRenderQueued) return;
  tabsRenderQueued = true;
  requestAnimationFrame(() => {
    tabsRenderQueued = false;
    renderTabs();
  });
}

/** Turn plain dirty flags into setters that keep the tab's unsaved marker current. */
function trackDirtyFlags(doc) {
  for (const key of ["dirty", "placementsDirty"]) {
    let value = !!doc[key];
    Object.defineProperty(doc, key, {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: (next) => {
        const flag = !!next;
        // every change counts, also while already unsaved: a save confirmed later
        // only clears the flag if nothing changed since it started
        if (flag) doc._editGen = (doc._editGen || 0) + 1;
        if (flag === value) return;
        value = flag;
        scheduleTabsRender();
      },
    });
  }
  return doc;
}

// ---------------------------------------------------------------- undo / redo

const UNDO_LIMIT = 100;

/**
 * History entries keep their label untranslated, so the Undo/Redo tooltips
 * follow a language change: either English marked with N_ (translated here)
 * or a function that returns the translated text (labels with values in them).
 */
function stepLabel(label) {
  if (typeof label === "function") return label();
  return label ? t(label) : "";
}

function updateUndoButtons() {
  const doc = activeDoc();
  const undoBtn = document.querySelector('.tool-btn[data-action="undo"]');
  const redoBtn = document.querySelector('.tool-btn[data-action="redo"]');
  if (!doc) {
    if (undoBtn) undoBtn.disabled = true;
    if (redoBtn) redoBtn.disabled = true;
    return;
  }
  if (undoBtn) {
    const last = doc?.undoStack?.[doc.undoStack.length - 1];
    undoBtn.disabled = !last;
    undoBtn.title = last ? t("Undo: {step} (Ctrl+Z)", { step: stepLabel(last.label) }) : t("Undo (Ctrl+Z)");
  }
  if (redoBtn) {
    const next = doc?.redoStack?.[doc.redoStack.length - 1];
    redoBtn.disabled = !next;
    redoBtn.title = next ? t("Redo: {step} (Ctrl+Y)", { step: stepLabel(next.label) }) : t("Redo (Ctrl+Y)");
  }
}

function pushUndo(doc, entry) {
  if (!doc) return;
  if (!doc.undoStack) doc.undoStack = [];
  doc.undoStack.push(entry);
  if (doc.undoStack.length > UNDO_LIMIT) doc.undoStack.shift();
  doc.redoStack = [];
  updateUndoButtons();
}

/** Record a finished server edit (result carries previous/new revision). */
function recordServerStep(doc, result, label, pages = null) {
  if (!doc || !result || result.previous_revision == null || result.revision == null) return;
  checkpointEditorObjects(doc);
  pushUndo(doc, {
    type: "server",
    label,
    before: result.previous_revision,
    after: result.revision,
    pages,
  });
}

/**
 * Text boxes and callouts live in the browser until saved. After each change
 * settles, compare with the last snapshot and record an undo step.
 */
function checkpointEditorObjects(doc) {
  if (!doc) return;
  const snapshot = serializeEditorObjects(doc);
  if (doc._editorSnapshot == null) {
    doc._editorSnapshot = snapshot;
    return;
  }
  if (snapshot === doc._editorSnapshot) return;
  pushUndo(doc, { type: "local", label: N_("Text box / comment"), before: doc._editorSnapshot, after: snapshot });
  doc._editorSnapshot = snapshot;
}

function scheduleEditorCheckpoint() {
  clearTimeout(state._checkpointTimer);
  state._checkpointTimer = setTimeout(() => {
    if (state.placementInteraction?.active || state.inlineTextEditor) {
      scheduleEditorCheckpoint();
      return;
    }
    checkpointEditorObjects(activeDoc());
  }, 300);
}

function restoreEditorObjects(doc, snapshot) {
  if (snapshot == null) return;
  applyStoredEditorObjects(doc, JSON.parse(snapshot));
  doc._editorSnapshot = snapshot;
  doc.placementsDirty = true;
  doc.dirty = true;
  state.selectedPlacementId = null;
  state.selectedCalloutId = null;
  renderPlacedTextOverlays({ force: true });
  renderCalloutOverlays();
}

async function applyHistoryEntry(doc, entry, direction) {
  const undoing = direction === "undo";
  if (entry.type === "local") {
    restoreEditorObjects(doc, undoing ? entry.before : entry.after);
    return;
  }
  await waitForDocMutations(doc);
  const revision = undoing ? entry.before : entry.after;
  const result = await queueDocMutation(
    doc,
    () => {
      const fd = new FormData();
      fd.append("revision", String(revision));
      return apiPost(`/v1/pdf/document/${doc.documentId}/restore`, fd);
    },
    { recover: false, allowSigned: true }
  );
  doc.dirty = true;
  if (entry.editorBefore != null) {
    restoreEditorObjects(doc, undoing ? entry.editorBefore : entry.editorAfter);
  }
  if (entry.rename) {
    doc.name = undoing ? entry.rename.before : entry.rename.after;
    if (undoing && entry.rename.handle) doc.fileHandle = entry.rename.handle;
    if (!undoing && entry.rename.detach) doc.fileHandle = null;
  }
  if (entry.pages?.length) {
    for (const pageNum of entry.pages) markPageStale(doc, pageNum);
    await syncDocumentFromServer(doc, entry.pages, { afterMutation: true, forceFullSync: true });
    forgetStalePages(doc, entry.pages);
  } else {
    await reloadWholeDocument(doc);
  }
  return result;
}

async function undoLastStep() {
  const doc = activeDoc();
  if (!doc || doc._historyBusy) return;
  doc._historyBusy = true;
  try {
    // Finish edits still on their way so the step undone is really the last one.
    await waitForDocMutations(doc);
    await undoLastStepNow(doc);
  } finally {
    doc._historyBusy = false;
  }
}

async function undoLastStepNow(doc) {
  checkpointEditorObjects(doc);
  const entry = doc.undoStack?.pop();
  if (!entry) {
    setStatus(t("Nothing to undo"));
    updateUndoButtons();
    return;
  }
  try {
    setStatus(t("Undoing: {step}…", { step: stepLabel(entry.label) }));
    await applyHistoryEntry(doc, entry, "undo");
    if (!doc.redoStack) doc.redoStack = [];
    doc.redoStack.push(entry);
    setStatus(t("Undone: {step}", { step: stepLabel(entry.label) }), "ok");
  } catch (err) {
    if (err.status !== 410 && !isSessionExpired(err)) doc.undoStack.push(entry);
    setStatus(String(err.message || err), "error");
  }
  updateUndoButtons();
}

async function redoLastStep() {
  const doc = activeDoc();
  if (!doc || doc._historyBusy) return;
  doc._historyBusy = true;
  try {
    await waitForDocMutations(doc);
    await redoLastStepNow(doc);
  } finally {
    doc._historyBusy = false;
  }
}

async function redoLastStepNow(doc) {
  const entry = doc.redoStack?.pop();
  if (!entry) {
    setStatus(t("Nothing to redo"));
    updateUndoButtons();
    return;
  }
  try {
    setStatus(t("Redoing: {step}…", { step: stepLabel(entry.label) }));
    await applyHistoryEntry(doc, entry, "redo");
    doc.undoStack.push(entry);
    setStatus(t("Redone: {step}", { step: stepLabel(entry.label) }), "ok");
  } catch (err) {
    if (err.status !== 410 && !isSessionExpired(err)) doc.redoStack.push(entry);
    setStatus(String(err.message || err), "error");
  }
  updateUndoButtons();
}

function normalizePageList(pages) {
  if (pages == null) {
    const doc = activeDoc();
    return [doc?.pageNum || 1];
  }
  return [...new Set((Array.isArray(pages) ? pages : [pages]).filter(Boolean))];
}

function forgetStalePages(doc, pages) {
  // While a drag is in progress the sync is postponed, so the pages stay stale.
  if (!doc?.stalePages || state.placementInteraction?.active) return;
  for (const pageNum of pages) doc.stalePages.delete(pageNum);
}

function markPageStale(doc, pageNum) {
  if (!doc || !pageNum) return;
  if (!doc.stalePages) doc.stalePages = new Set();
  doc.stalePages.add(pageNum);
  doc.dirty = true;
}

function cancelPendingDocumentRefresh(doc) {
  if (doc?._refreshTimer) {
    clearTimeout(doc._refreshTimer);
    doc._refreshTimer = null;
  }
}

async function flushDocumentSync(doc) {
  if (!doc) return;
  cancelPendingDocumentRefresh(doc);
  if (doc._syncPromise) {
    await doc._syncPromise;
  }
  if (doc._blobSyncPromise) {
    await doc._blobSyncPromise;
  }
  if (!doc.documentId) return;
  const pages = doc.stalePages?.size ? [...doc.stalePages] : [doc.pageNum];
  await syncDocumentFromServer(doc, pages, { preferRaster: false });
  forgetStalePages(doc, pages);
}

function scheduleStalePageRefresh(doc) {
  if (!doc?.stalePages?.size || !doc.documentId) return;
  if (state.placementInteraction?.active) {
    doc._pendingRefresh = true;
    return;
  }
  cancelPendingDocumentRefresh(doc);
  doc._refreshTimer = setTimeout(() => {
    doc._refreshTimer = null;
    refreshStalePages(doc, { background: true, silent: true });
  }, 400);
}

async function refreshStalePages(doc, options = {}) {
  if (!doc?.stalePages?.size || !doc.documentId) return;
  if (state.placementInteraction?.active) {
    doc._pendingRefresh = true;
    return;
  }
  if (doc._syncPromise) {
    await doc._syncPromise;
    if (!doc.stalePages?.size) return;
  }
  const pages = [...doc.stalePages];
  const scrollAnchor = options.background ? captureScrollAnchor() : null;
  const run = async () => {
    if (!options.silent) {
      setStatus(options.background ? t("Updating preview…") : t("Syncing document…"));
    }
    await syncDocumentFromServer(doc, pages, { preferRaster: !!options.background });
    forgetStalePages(doc, pages);
    doc._pendingRefresh = false;
    if (scrollAnchor) restoreScrollAnchor(scrollAnchor);
    if (!options.silent && options.background) {
      setStatus(t("Preview updated"), "ok");
    }
  };
  doc._syncPromise = run()
    .catch((err) => {
      if (options.background) setStatus(String(err.message || err), "error");
      else throw err;
    })
    .finally(() => {
      doc._syncPromise = null;
    });
  if (!options.background) {
    await doc._syncPromise;
  }
}

function beginPlacementInteraction(pageIndex) {
  state.placementInteraction = { pageIndex, active: true };
  const doc = activeDoc();
  cancelPendingDocumentRefresh(doc);
}

function endPlacementInteraction() {
  state.placementInteraction = null;
  const doc = activeDoc();
  if (doc?._pendingRefresh) {
    doc._pendingRefresh = false;
    scheduleStalePageRefresh(doc);
  }
}

async function scheduleBackgroundPdfReload(doc) {
  if (doc._pdfReloadTimer) clearTimeout(doc._pdfReloadTimer);
  doc._pdfReloadTimer = setTimeout(async () => {
    doc._pdfReloadTimer = null;
    if (!doc?.blob) return;
    try {
      const changed = await reloadPdfDocIfChanged(doc, doc.blob);
      if (activeDoc() !== doc) return;
      const selector = changed
        ? '.page-shell[data-rendered="true"]'
        : '.page-shell[data-raster-preview="true"]';
      // Redraw only the pages on or near the screen, nearest first. Pages
      // further away drop their old picture and are drawn again when the
      // user scrolls to them, so a long document doesn't redraw everything.
      const view = els.viewerScroll.getBoundingClientRect();
      const middle = (view.top + view.bottom) / 2;
      const shells = [];
      for (const shell of els.viewerPages.querySelectorAll(selector)) {
        const box = shell.getBoundingClientRect();
        const near = box.bottom > view.top - 900 && box.top < view.bottom + 900;
        if (!near) {
          if (changed && !shell._renderPromise) {
            shell.querySelectorAll(":scope > canvas, :scope > .textLayer").forEach((node) => {
              if (node.tagName === "CANVAS") {
                node.width = 0;
                node.height = 0;
              }
              node.remove();
            });
            shell.dataset.rendered = "false";
            delete shell.dataset.rasterPreview;
          }
          continue;
        }
        shells.push([Math.abs((box.top + box.bottom) / 2 - middle), shell]);
      }
      shells.sort((a, b) => a[0] - b[0]);
      for (const [, shell] of shells) {
        if (activeDoc() !== doc) return;
        const pageNum = Number(shell.dataset.page);
        if (!pageNum) continue;
        // don't pull the page out from under a selection the user is making
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && shell.contains(sel.anchorNode)) {
          markPageStale(doc, pageNum);
          continue;
        }
        await patchPageRender(pageNum);
      }
    } catch (_) {
      /* ignore background reload errors */
    }
  }, 1500);
}

async function patchPageFromServerRaster(doc, pageNum) {
  const shell = els.viewerPages.querySelector(`.page-shell[data-page="${pageNum}"]`);
  if (!shell || !doc.documentId) return false;

  let scale = Number(shell.dataset.scale) || 0;
  if (doc.pdfDoc) {
    try {
      const page = await doc.pdfDoc.getPage(pageNum);
      const baseScale = state.fitWidth ? 1 : state.zoom * 1.2;
      scale = scaleForView(page, baseScale);
    } catch (_) {
      /* keep shell scale */
    }
  }
  if (!scale) scale = state.zoom * 1.2;

  const fd = new FormData();
  appendDocToForm(fd, doc);
  fd.append("page_index", String(pageNum - 1));
  fd.append("scale", String(scale));
  const resp = await fetch("/v1/pdf/render-page", { method: "POST", headers: headers(), body: fd });
  if (!resp.ok) return false;

  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    shell.dataset.scale = String(scale);
    shell.dataset.pageIndex = String(pageNum - 1);
    shell.dataset.rasterPreview = "true";
    shell.dataset.rendered = "true";
    shell.replaceChildren(canvas);
    // keep the text selectable while the preview is a server image
    if (doc.pdfDoc) {
      try {
        const page = await doc.pdfDoc.getPage(pageNum);
        await appendPageTextLayer(shell, page, page.getViewport({ scale }));
      } catch (_) {
        /* text layer comes back with the next full render */
      }
    }
    bindPageShellEvents(shell, pageNum);
    if (state.editMode) {
      shell.classList.add("selectable");
      attachRegionSelect(shell, { scale, pageIndex: pageNum - 1, viewport: null });
    }
    doc.stalePages?.delete(pageNum);
    markPageRendered(doc, pageNum);
    renderPlacedTextOverlays();
    renderCalloutOverlays();
    syncTextLayers();
    renderSearchHits(shell);
    return true;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function syncDocumentFromServer(doc, affectedPages, options = {}) {
  if (!doc.documentId) return;
  const pages = normalizePageList(affectedPages);
  if (state.placementInteraction?.active) {
    pages.forEach((pageNum) => markPageStale(doc, pageNum));
    return;
  }
  const scrollAnchor = captureScrollAnchor();
  const meta = await withDocSession(doc, () => fetchDocumentMeta(doc));

  const staleMutation = options.afterMutation || pages.some((pageNum) => doc.stalePages?.has(pageNum));
  if (meta && doc.serverRevision === meta.revision && doc.pdfDoc && !staleMutation) {
    for (const pageNum of pages) {
      await patchPageRender(pageNum);
      clearOptimisticHighlights(pageNum);
      clearOptimisticErases(pageNum);
    }
    for (const pageNum of pages) markPageRendered(doc, pageNum);
    restoreScrollAnchor(scrollAnchor);
    renderPlacedTextOverlays({ force: true });
    renderCalloutOverlays();
    return;
  }

  if (!options.forceFullSync && options.preferRaster && meta) {
    let rasterOk = true;
    for (const pageNum of pages) {
      const ok = await patchPageFromServerRaster(doc, pageNum);
      if (!ok) rasterOk = false;
      clearOptimisticHighlights(pageNum);
      clearOptimisticErases(pageNum);
    }
    if (rasterOk) {
      await applyServerMeta(doc, meta);
      for (const pageNum of pages) markPageRendered(doc, pageNum);
      restoreScrollAnchor(scrollAnchor);
      renderPlacedTextOverlays({ force: true });
      renderCalloutOverlays();
      doc._blobSyncPromise = downloadDocumentBlob(doc)
        .then(() => scheduleBackgroundPdfReload(doc))
        .finally(() => {
          doc._blobSyncPromise = null;
        });
      return;
    }
  }

  let blob = doc.blob;
  if (
    options.forceFullSync ||
    !meta ||
    doc.serverRevision !== meta.revision ||
    doc.pdfEtag !== meta.etag
  ) {
    blob = await downloadDocumentBlob(doc);
  }
  if (meta) await applyServerMeta(doc, meta);
  await reloadPdfDocIfChanged(doc, blob);
  for (const pageNum of pages) {
    await patchPageRender(pageNum);
    clearOptimisticHighlights(pageNum);
    clearOptimisticErases(pageNum);
    markPageRendered(doc, pageNum);
  }
  restoreScrollAnchor(scrollAnchor);
  renderPlacedTextOverlays({ force: true });
  renderCalloutOverlays();
}

function addOptimisticHighlight(shell, left, top, width, height) {
  const el = document.createElement("div");
  el.className = "highlight-overlay";
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  shell.appendChild(el);
  return el;
}

function clearOptimisticHighlights(pageNum) {
  const shell = els.viewerPages.querySelector(`.page-shell[data-page="${pageNum}"]`);
  shell?.querySelectorAll(".highlight-overlay").forEach((n) => n.remove());
}

function clearOptimisticErases(pageNum) {
  const shell = els.viewerPages.querySelector(`.page-shell[data-page="${pageNum}"]`);
  shell?.querySelectorAll(".erase-overlay").forEach((n) => n.remove());
}

function rectsIntersect(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function removeOptimisticInRegion(shell, pixel, pad = 0) {
  if (!shell || !pixel) return;
  pixel = {
    left: pixel.left - pad,
    top: pixel.top - pad,
    width: pixel.width + pad * 2,
    height: pixel.height + pad * 2,
  };
  shell.querySelectorAll(".highlight-overlay").forEach((el) => {
    const left = parseFloat(el.style.left);
    const top = parseFloat(el.style.top);
    const width = parseFloat(el.style.width);
    const height = parseFloat(el.style.height);
    if (rectsIntersect(left, top, width, height, pixel.left, pixel.top, pixel.width, pixel.height)) {
      el.remove();
    }
  });
}

/**
 * Erase preview: find the highlight annotations the eraser touches (same rule
 * as the server: annotation box meets the drag box grown by 3 pt) and paint
 * those boxes again from a render of the page without annotations. The page
 * text stays where it is; only the yellow goes. Returns how many were hidden.
 */
async function previewHighlightErase(doc, shell, pixel) {
  if (!doc?.pdfDoc || !shell || !pixel) return 0;
  const canvas = shell.querySelector(":scope > canvas");
  if (!canvas) return 0;
  const pageNum = Number(shell.dataset.page);
  const scale = Number(shell.dataset.scale) || 1;
  const page = await doc.pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const annotations = await page.getAnnotations({ intent: "display" });
  const pad = 3 * scale;
  const hits = [];
  for (const ann of annotations) {
    if (ann.subtype !== "Highlight" || !ann.rect) continue;
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(ann.rect);
    const box = {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
    if (
      rectsIntersect(
        box.left, box.top, box.width, box.height,
        pixel.left - pad, pixel.top - pad, pixel.width + pad * 2, pixel.height + pad * 2
      )
    ) {
      hits.push(box);
    }
  }
  if (!hits.length) return 0;
  const { canvas: clean } = await renderPageCanvas(page, scale, {
    cssSize: false,
    annotationMode: pdfjsLib.AnnotationMode.DISABLE,
  });
  try {
    // the page may have been redrawn meanwhile; draw on whatever is there now
    const target = shell.querySelector(":scope > canvas");
    if (!target?.width) return hits.length;
    const ctx = target.getContext("2d");
    const tx = target.width / viewport.width;
    const ty = target.height / viewport.height;
    const cx = clean.width / viewport.width;
    const cy = clean.height / viewport.height;
    for (const box of hits) {
      const left = Math.max(0, box.left - 1);
      const top = Math.max(0, box.top - 1);
      const right = Math.min(viewport.width, box.left + box.width + 1);
      const bottom = Math.min(viewport.height, box.top + box.height + 1);
      if (right <= left || bottom <= top) continue;
      ctx.drawImage(
        clean,
        left * cx, top * cy, (right - left) * cx, (bottom - top) * cy,
        left * tx, top * ty, (right - left) * tx, (bottom - top) * ty
      );
    }
  } finally {
    clean.width = 0;
    clean.height = 0;
  }
  return hits.length;
}

/** Refresh stale pages soon after an edit, once queued edits are done. */
function scheduleQuickPageRefresh(doc) {
  clearTimeout(doc._quickRefreshTimer);
  doc._quickRefreshTimer = setTimeout(async () => {
    doc._quickRefreshTimer = null;
    await waitForDocMutations(doc);
    if (activeDoc() !== doc || !doc.stalePages?.size) return;
    // don't redraw a page under a drag that is still going on
    if (state.pointerDown || doc._pendingMutations > 0) {
      scheduleQuickPageRefresh(doc);
      return;
    }
    refreshStalePages(doc, { background: true, silent: true });
  }, 250);
}

function buildRegionForm(doc, region) {
  const fd = new FormData();
  appendDocToForm(fd, doc);
  fd.append("page_index", String(region.pageIndex));
  fd.append("x", String(region.x));
  fd.append("y", String(region.y));
  fd.append("width", String(region.width));
  fd.append("height", String(region.height));
  return fd;
}

function inflatePdfRegion(region, pad = 8) {
  return {
    pageIndex: region.pageIndex,
    x: Math.max(0, region.x - pad),
    y: Math.max(0, region.y - pad),
    width: region.width + pad * 2,
    height: region.height + pad * 2,
  };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // the desktop app reads the file a moment later
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return url;
}

// Desktop saves on their way to the disk, by download URL: which document,
// and its edit count when the save started.
const desktopSaves = new Map();

// Called by the desktop app once a save has been written (or failed), with
// the URL of the download, so the result goes to the document it belongs to.
window.__openpdfSaved = (path, url) => {
  const pending = url ? desktopSaves.get(url) : null;
  desktopSaves.delete(url);
  const doc = pending && state.docs.find((d) => d.id === pending.docId);
  // nothing changed since the save started: it is saved now
  if (doc && (doc._editGen || 0) === pending.gen) doc.dirty = false;
  renderTabs();
  setStatus(t("Saved to {path}", { path }), "ok");
  showToast(t("Saved to {path}", { path }), { type: "ok" });
  flashSaved();
};
window.__openpdfSaveFailed = (url) => {
  const pending = url ? desktopSaves.get(url) : null;
  desktopSaves.delete(url);
  // an older app gives no URL: the active document is the best guess; a download
  // that was not a save (an export) leaves the documents as they are
  const doc = pending ? state.docs.find((d) => d.id === pending.docId) : url ? null : activeDoc();
  if (doc) {
    doc.dirty = true;
    renderTabs();
  }
  const name = doc?.name || pending?.name || "";
  setStatus(name ? t("Save failed: “{name}” was not written", { name }) : t("Save failed: the file was not written"), "error");
  showToast(t("Save failed: the file was not written. Check that it isn't open in another program or read-only."), { type: "error" });
};

function blobToFile(blob, name) {
  return new File([blob], name, { type: blob.type || "application/pdf" });
}

function pageStride() {
  return state.viewMode === "two-page" ? 2 : 1;
}

function pagesToRender(doc) {
  if (state.viewMode === "single") return [doc.pageNum];
  if (state.viewMode === "two-page") {
    const pages = [doc.pageNum];
    if (doc.pageNum + 1 <= doc.pageCount) pages.push(doc.pageNum + 1);
    return pages;
  }
  return Array.from({ length: doc.pageCount }, (_, i) => i + 1);
}

/** `panel` names what the panel shows ("forms"), so code never has to read the title. */
function showPropsPanel(title, html, panel = "") {
  els.propsTitle.textContent = title;
  els.propsPanel.dataset.panel = panel;
  els.propsBody.innerHTML = html;
  els.propsPanel.classList.remove("hidden");
  els.propsPanel.classList.add("open");
  syncFormsButton();
}

/** The Forms button: pressed while the form panel is open; a dot when the PDF has fields to fill. */
function syncFormsButton() {
  const btn = document.querySelector(".tool-btn.tool-forms");
  if (!btn) return;
  const open = formsPanelOpen();
  btn.classList.toggle("active", open);
  btn.setAttribute("aria-pressed", String(open));
  const doc = activeDoc();
  btn.classList.toggle("has-fields", !!doc?._hasFormFields);
  if (doc && doc._hasFormFields == null && doc.pdfDoc && !doc._checkingFields) {
    doc._checkingFields = true;
    doc.pdfDoc
      .getFieldObjects()
      .then((objects) => {
        doc._hasFormFields = !!objects && Object.keys(objects).length > 0;
      })
      .catch(() => {
        doc._hasFormFields = false;
      })
      .finally(() => {
        doc._checkingFields = false;
        if (activeDoc() === doc) syncFormsButton();
      });
  }
}

async function toggleFormsPanel() {
  if (formsPanelOpen()) {
    await closePropsPanel();
    return;
  }
  // forms are filled in with the plain pointer
  if (state.editMode && state.editMode !== "select") setEditMode("select");
  await loadFormsPanel();
  syncFormsButton();
}

function formsPanelOpen() {
  return els.propsPanel.classList.contains("open") && els.propsPanel.dataset.panel === "forms";
}

/** Draw the pages that hold form fields again from the current PDF, so filled-in values show on the page itself. */
async function redrawFormPages(doc) {
  if (!doc?.formFields?.length || activeDoc() !== doc) return;
  const pages = [...new Set(doc.formFields.map((f) => (f.pageIndex ?? 0) + 1))];
  for (const pageNum of pages) {
    const shell = els.viewerPages.querySelector(`.page-shell[data-page="${pageNum}"]`);
    if (shell?.dataset.rendered === "true") await patchPageRender(pageNum);
    else markPageStale(doc, pageNum);
  }
}

/**
 * Closing the form panel: keep what was typed. Unsaved entries are written
 * into the working copy first and the pages are drawn again with them, so
 * the text doesn't seem to vanish with the input boxes.
 */
async function closePropsPanel() {
  const doc = activeDoc();
  if (!doc || !formsPanelOpen() || !doc.formFields?.length) {
    hidePropsPanel();
    return;
  }
  const typing = document.activeElement;
  if (typing?.closest?.(".form-field-overlay, #propsBody")) typing.blur();
  try {
    const values = collectFormValues();
    const changed = doc.formFields.some(
      (field) => field.name in values && !formValuesMatch(values[field.name], field.value ?? "")
    );
    els.propsPanel.classList.add("hidden");
    els.propsPanel.classList.remove("open");
    if (changed) {
      setStatus(t("Writing form entries…"));
      await persistFormFieldValues(doc); // redraws the pages (panel now closed)
      setStatus(t("Form entries written. Remember to save the file."), "ok");
    } else {
      await refreshWorkingCopyFromServer(doc);
      await redrawFormPages(doc);
    }
  } catch (err) {
    setStatus(String(err.message || err), "error");
  } finally {
    hidePropsPanel();
  }
}

function hidePropsPanel() {
  els.propsPanel.classList.add("hidden");
  els.propsPanel.classList.remove("open");
  els.propsPanel.dataset.panel = "";
  clearFormOverlays();
  syncFormsButton();
}

function syncEditModeUI() {
  document.querySelectorAll(".tool-mode").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === state.editMode);
  });
  els.viewerDrop.classList.toggle("edit-active", !!state.editMode);
  if (state.editMode) els.viewerDrop.dataset.editMode = state.editMode;
  else delete els.viewerDrop.dataset.editMode;
  renderPlacedTextOverlays();
  renderCalloutOverlays();
  syncTextLayers();
  syncTextStyleToolbar();
  syncToolHint();
}

function isTextInputMode(mode = state.editMode) {
  return mode === "replace-text" || mode === "cover-text" || mode === "annotate";
}

function expectedPlacementKind(mode = state.editMode) {
  if (mode === "cover-text") return "cover";
  if (mode === "replace-text") return "plain";
  return null;
}

/** Whether the current tool works on text boxes of this kind. Edit text also
 *  takes the text it inserted on empty space (plain boxes: they erase nothing). */
function placementKindActive(kind, mode = state.editMode) {
  if (mode === "cover-text") return kind === "cover" || kind === "plain";
  if (mode === "replace-text") return kind === "plain";
  return false;
}

const PLACEMENT_COLOR_DEFAULTS = {
  plain: {
    editBackground: "#d6e6fb",
    editColor: "#111827",
    idleBackground: "transparent",
    idleColor: "#111827",
  },
  cover: {
    editBackground: "#1e5aa8",
    editColor: "#ffffff",
    idleBackground: "#ffffff",
    idleColor: "#111827",
  },
};

function placementKindOf(placement) {
  return placement?.kind === "cover" ? "cover" : "plain";
}

function normalizePlacements(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => ({
    ...item,
    kind: item.kind === "cover" ? "cover" : "plain",
  }));
}

function normalizeCallouts(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((item) => item && typeof item === "object");
}

function applyStoredEditorObjects(doc, raw) {
  if (raw && !Array.isArray(raw) && (Array.isArray(raw.placements) || Array.isArray(raw.callouts))) {
    doc.placedTexts = normalizePlacements(raw.placements);
    doc.callouts = normalizeCallouts(raw.callouts);
    return;
  }
  const list = Array.isArray(raw) ? raw : [];
  const placementItems = [];
  const calloutItems = [];
  for (const item of list) {
    if (item?.kind === "callout") calloutItems.push(item);
    else placementItems.push(item);
  }
  doc.placedTexts = normalizePlacements(placementItems);
  doc.callouts = normalizeCallouts(calloutItems);
}

function serializeEditorObjects(doc) {
  const placements = (doc?.placedTexts || []).filter((item) => item && item.kind !== "callout");
  const callouts = (doc?.callouts || [])
    .filter((item) => item && typeof item === "object")
    .map((item) => ({ ...item, kind: "callout" }));
  return JSON.stringify([...placements, ...callouts]);
}

async function loadPlacementsFromPdf(doc) {
  try {
    const data = await withDocSession(doc, () => {
      const fd = new FormData();
      appendDocToForm(fd, doc);
      return apiPost("/v1/pdf/read-placements", fd);
    });
    const addedPlacements = doc.placedTexts || [];
    const addedCallouts = doc.callouts || [];
    applyStoredEditorObjects(doc, data.placements);
    const placementIds = new Set(doc.placedTexts.map((item) => item.id));
    const calloutIds = new Set(doc.callouts.map((item) => item.id));
    doc.placedTexts.push(...addedPlacements.filter((item) => !placementIds.has(item.id)));
    doc.callouts.push(...addedCallouts.filter((item) => !calloutIds.has(item.id)));
  } catch (_) {
    doc.placedTexts = doc.placedTexts || [];
    doc.callouts = doc.callouts || [];
  }
  doc._editorSnapshot = serializeEditorObjects(doc);
}

/** Write the in-browser text boxes and callouts into the session copy. */
async function embedPlacementsIntoSession(doc) {
  return queueDocMutation(doc, () => {
    const fd = new FormData();
    appendDocToForm(fd, doc);
    fd.append("placements", serializeEditorObjects(doc));
    return apiPost("/v1/pdf/embed-placements", fd);
  });
}

async function reloadDocFromBlob(doc) {
  if (!doc?.blob) return;
  await reloadPdfDocIfChanged(doc, doc.blob);
  if (doc.pageNum > doc.pageCount) doc.pageNum = doc.pageCount;
}

function dismissInlineTextEditor() {
  if (!state.inlineTextEditor) return;
  state.inlineTextEditor.editor.remove();
  state.inlineTextEditor = null;
  syncTextStyleToolbar();
}

function isSelectMode(mode = state.editMode) {
  return mode === "select";
}

function isEditToolMode(mode = state.editMode) {
  return !!mode && !isSelectMode(mode);
}

function shouldShowTextLayer() {
  const doc = activeDoc();
  return !!doc && isSelectMode() && doc.contentView !== "text";
}

async function renderPageTextLayer(page, viewport, container) {
  container.replaceChildren();
  container.className = "textLayer";
  if (!shouldShowTextLayer()) {
    container.classList.add("hidden");
    return;
  }
  const textContent = await page.getTextContent();
  for (const item of textContent.items) {
    if (!("str" in item) || !item.str) continue;
    const span = document.createElement("span");
    span.textContent = item.str;
    const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const angle = Math.atan2(transform[1], transform[0]);
    const fontHeight = Math.hypot(transform[2], transform[3]);
    span.style.left = `${transform[4]}px`;
    span.style.top = `${transform[5] - fontHeight}px`;
    span.style.fontSize = `${fontHeight}px`;
    span.style.fontFamily = item.fontName || "sans-serif";
    const pdfFontSize = Math.round((fontHeight / viewport.scale) * 10) / 10;
    span.dataset.pdfFontSize = String(pdfFontSize);
    span.dataset.fontName = item.fontName || "";
    if (Math.abs(angle) > 0.001) {
      span.style.transform = `rotate(${angle}rad)`;
      span.style.transformOrigin = "0% 0%";
    }
    container.appendChild(span);
  }
}

function syncTextLayers() {
  const show = shouldShowTextLayer();
  els.viewerPages.querySelectorAll(".textLayer").forEach((layer) => {
    layer.classList.toggle("hidden", !show);
    // A layer built while a drawing tool was active is empty: fill it now.
    if (show && !layer.childElementCount) fillTextLayer(layer);
  });
}

async function fillTextLayer(layer) {
  const doc = activeDoc();
  const shell = layer.closest(".page-shell");
  if (!doc?.pdfDoc || !shell || layer._filling) return;
  layer._filling = true;
  try {
    const page = await doc.pdfDoc.getPage(Number(shell.dataset.page));
    const viewport = page.getViewport({ scale: Number(shell.dataset.scale) || 1 });
    if (layer.isConnected && !layer.childElementCount) await renderPageTextLayer(page, viewport, layer);
  } catch (_) {
    /* page may have been released meanwhile */
  } finally {
    layer._filling = false;
  }
}

function clearImageInsertUi() {
  els.viewerPages.querySelectorAll(".image-insert-cursor").forEach((node) => node.remove());
  dismissPendingImageOverlay();
  state.imageCursor = null;
}

function dismissPendingImageOverlay() {
  if (!state.pendingImageOverlay) return;
  state.pendingImageOverlay.el?.remove();
  if (state.pendingImageOverlay.objectUrl) {
    URL.revokeObjectURL(state.pendingImageOverlay.objectUrl);
  }
  state.pendingImageOverlay = null;
}

function selectPlacement(placementId) {
  state.selectedPlacementId = placementId;
  els.viewerPages.querySelectorAll(".placed-text-overlay").forEach((el) => {
    el.classList.toggle("selected", el.dataset.placementId === placementId);
  });
  syncTextStyleToolbar();
}

function clearPlacementSelection() {
  state.selectedPlacementId = null;
  els.viewerPages.querySelectorAll(".placed-text-overlay.selected").forEach((el) => {
    el.classList.remove("selected");
  });
  syncTextStyleToolbar();
}

function displayFontName(raw) {
  if (!raw) return "Helvetica";
  const lower = String(raw).toLowerCase();
  if (lower.includes("helvetica") || lower.includes("arial")) return "Helvetica";
  if (lower.includes("times")) return "Times New Roman";
  if (lower.includes("courier")) return "Courier New";
  if (lower.includes("song") || lower.includes("simsun") || lower.includes("宋")) return "宋体";
  if (lower.includes("hei") || lower.includes("simhei") || lower.includes("黑")) return "黑体";
  if (/^g_d\d+_f\d+$/i.test(raw)) return "Helvetica";
  return raw.length > 24 ? `${raw.slice(0, 22)}…` : raw;
}

/** The name shown for a font family value: the two Chinese font values are stored keys, not display text. */
function fontFamilyLabel(value) {
  if (value === "宋体") return t("Song (Chinese serif)");
  if (value === "黑体") return t("Hei (Chinese sans)");
  return value;
}

function getTextStyleFromSelection() {
  const sel = window.getSelection();
  if (!sel?.rangeCount || sel.isCollapsed) return null;
  if (!sel.toString().trim()) return null;
  const node = sel.anchorNode;
  const span =
    node?.nodeType === Node.TEXT_NODE
      ? node.parentElement?.closest(".textLayer span")
      : node?.closest?.(".textLayer span");
  if (!span) return null;
  const shell = span.closest(".page-shell");
  const scale = shell ? Number(shell.dataset.scale) || 1 : 1;
  let fontSize = parseFloat(span.dataset.pdfFontSize);
  if (!Number.isFinite(fontSize)) {
    fontSize = parseFloat(span.style.fontSize) / scale;
  }
  if (!Number.isFinite(fontSize) || fontSize <= 0) return null;
  return {
    fontFamily: displayFontName(span.dataset.fontName || span.style.fontFamily),
    fontSize: Math.round(fontSize * 10) / 10,
  };
}

function setSelectOptionValue(select, value, label = value) {
  if (!select || value == null) return;
  const str = String(value);
  let opt = [...select.options].find((node) => node.value === str);
  if (!opt) {
    select.querySelectorAll("option[data-dynamic]").forEach((node) => node.remove());
    opt = document.createElement("option");
    opt.value = str;
    opt.textContent = String(label);
    opt.dataset.dynamic = "true";
    select.appendChild(opt);
  }
  select.value = str;
}

function resolveContextTextStyle() {
  const doc = activeDoc();
  const fallback = {
    fontFamily: state.textFontFamily || "Helvetica",
    fontSize: state.textFontSize || 14,
    editable: false,
    source: "default",
  };
  if (!doc) return fallback;

  if (state.inlineTextEditor) {
    return {
      fontFamily: state.inlineTextEditor.family || state.textFontFamily || "Helvetica",
      fontSize: state.inlineTextEditor.fontSize || state.textFontSize || 14,
      editable: true,
      source: "editor",
    };
  }
  if (isTextInputMode()) {
    return {
      fontFamily: state.textFontFamily || "Helvetica",
      fontSize: state.textFontSize || 14,
      editable: true,
      source: "insert",
    };
  }
  if (state.selectedPlacementId && doc.placedTexts?.length) {
    const placement = doc.placedTexts.find((item) => item.id === state.selectedPlacementId);
    if (placement) {
      return {
        fontFamily: state.textFontFamily || "Helvetica",
        fontSize: placement.fontSize || state.textFontSize || 14,
        editable: false,
        source: "placement",
      };
    }
  }
  const selected = getTextStyleFromSelection();
  if (selected) {
    return { ...selected, editable: false, source: "selection" };
  }
  return fallback;
}

function syncTextStyleToolbar() {
  if (!els.textFontSizeSelect || !els.textFontFamilySelect) return;
  const doc = activeDoc();
  const visible =
    !!doc && doc.contentView !== "text" && (isTextInputMode() || !!state.inlineTextEditor);
  els.textStyleToolbar?.classList.toggle("hidden", !visible);
  if (!visible) return;

  const ctx = resolveContextTextStyle();
  state._textStyleUiSync = true;
  setSelectOptionValue(els.textFontFamilySelect, ctx.fontFamily, fontFamilyLabel(ctx.fontFamily));
  setSelectOptionValue(els.textFontSizeSelect, ctx.fontSize, ctx.fontSize);
  els.textFontFamilySelect.disabled = !ctx.editable;
  els.textFontSizeSelect.disabled = !ctx.editable;
  els.textFontFamilySelect.title = ctx.editable
    ? t("Font for new text")
    : ctx.source === "selection"
      ? t("Font of the selected PDF text")
      : ctx.source === "placement"
        ? t("Font of the selected text box")
        : t("Default font of this PDF");
  els.textFontSizeSelect.title = ctx.editable
    ? t("Font size for new text")
    : ctx.source === "selection"
      ? t("Font size of the selected PDF text")
      : ctx.source === "placement"
        ? t("Font size of the selected text box")
        : t("Current default font size");
  state._textStyleUiSync = false;
}

async function writeClipboardText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

async function readClipboardText() {
  if (navigator.clipboard?.readText) {
    return navigator.clipboard.readText();
  }
  return "";
}

async function readClipboardImageBlob() {
  if (!navigator.clipboard?.read) return null;
  const items = await navigator.clipboard.read();
  for (const item of items) {
    for (const type of item.types) {
      if (type.startsWith("image/")) {
        return item.getType(type);
      }
    }
  }
  return null;
}

function getSelectedTextFromEditor(editor) {
  const sel = window.getSelection();
  if (sel?.rangeCount && editor.contains(sel.anchorNode)) {
    const selected = sel.toString();
    if (selected) return selected;
  }
  return editor.textContent.replace(/\u200B/g, "");
}

async function copyToClipboard() {
  const doc = activeDoc();
  if (!doc) return;

  if (state.inlineTextEditor?.editor) {
    const text = getSelectedTextFromEditor(state.inlineTextEditor.editor);
    if (text) {
      await writeClipboardText(text);
      setStatus(t("Copied"), "ok");
      return;
    }
  }

  if (state.selectedPlacementId && doc.placedTexts?.length) {
    const placement = doc.placedTexts.find((item) => item.id === state.selectedPlacementId);
    if (placement?.text) {
      await writeClipboardText(placement.text);
      setStatus(t("Copied the text box text"), "ok");
      return;
    }
  }

  const selection = window.getSelection()?.toString()?.trim();
  if (selection && shouldShowTextLayer()) {
    await writeClipboardText(selection);
    setStatus(t("Copied the selected text"), "ok");
    return;
  }

  if (doc.contentView === "text" && els.textPanel) {
    const start = els.textPanel.selectionStart ?? 0;
    const end = els.textPanel.selectionEnd ?? 0;
    const text = els.textPanel.value.substring(start, end) || els.textPanel.value;
    if (text) {
      await writeClipboardText(text);
      setStatus(t("Copied"), "ok");
      return;
    }
  }

  setStatus(t("Nothing selected to copy"), "error");
}

async function pasteIntoInlineEditor(editor, text) {
  editor.focus();
  if (document.queryCommandSupported?.("insertText")) {
    document.execCommand("insertText", false, text);
    return;
  }
  const sel = window.getSelection();
  if (sel?.rangeCount) {
    sel.deleteFromDocument();
    sel.getRangeAt(0).insertNode(document.createTextNode(text));
    sel.collapseToEnd();
    return;
  }
  editor.textContent += text;
}

async function pasteIntoSelectedPlacement() {
  const doc = activeDoc();
  if (!doc?.placedTexts?.length || !state.selectedPlacementId) return false;
  const text = (await readClipboardText()).replace(/\u200B/g, "").trim();
  if (!text) return false;
  const placement = doc.placedTexts.find((item) => item.id === state.selectedPlacementId);
  if (!placement) return false;
  const region = placedTextToRegion(placement);
  const eraseBounds = {
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
  };
  if (placement.kind === "cover") {
    await commitCoverText(
      region,
      text,
      placement.fontSize || state.textFontSize,
      placement.id,
      eraseBounds,
      { preserveBounds: true, kind: "cover" }
    );
  } else {
    await commitPlainTextEdit(
      region,
      text,
      placement.fontSize || state.textFontSize,
      placement.id,
      eraseBounds
    );
  }
  setStatus(t("Pasted into the text box"), "ok");
  return true;
}

function placeImageCursor(shell, pixelX, pixelY, meta) {
  clearImageInsertUi();
  const scale = meta.scale;
  const fontPx = state.textFontSize * scale;
  const height = Math.max(fontPx * 1.25, 14);
  const cursor = document.createElement("div");
  cursor.className = "image-insert-cursor";
  cursor.style.left = `${pixelX}px`;
  cursor.style.top = `${pixelY}px`;
  cursor.style.height = `${height}px`;
  shell.appendChild(cursor);
  const region = canvasToPdfRect(shell, pixelX, pixelY, pixelX + 2, pixelY + height, meta);
  state.imageCursor = {
    shell,
    scale,
    pageIndex: meta.pageIndex,
    pixel: { left: pixelX, top: pixelY, height },
    region,
  };
  setStatus(t("Cursor placed. Press Ctrl+V or click “Paste image” to insert a picture."), "ok");
}

function defaultImagePixelSize(naturalWidth, naturalHeight, scale) {
  const maxPx = 220 * scale;
  let width = naturalWidth;
  let height = naturalHeight;
  if (width > maxPx) {
    height = (height * maxPx) / width;
    width = maxPx;
  }
  return {
    width: Math.max(width, 48),
    height: Math.max(height, 32),
  };
}

function attachImagePreviewOverlay(el, shell, scale, pageIndex) {
  let dragState = null;
  let resizeState = null;

  const finishDrag = () => {
    if (!dragState) return;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", finishDrag);
    dragState = null;
    el.classList.remove("dragging");
  };

  const finishResize = () => {
    if (!resizeState) return;
    document.removeEventListener("mousemove", onResizeMove);
    document.removeEventListener("mouseup", finishResize);
    resizeState = null;
    el.classList.remove("resizing");
  };

  const onDragMove = (ev) => {
    if (!dragState) return;
    const dx = ev.clientX - dragState.startX;
    const dy = ev.clientY - dragState.startY;
    if (!dragState.moved && Math.hypot(dx, dy) < 4) return;
    dragState.moved = true;
    el.classList.add("dragging");
    el.style.left = `${dragState.originLeft + dx}px`;
    el.style.top = `${dragState.originTop + dy}px`;
  };

  const onResizeMove = (ev) => {
    if (!resizeState) return;
    const dx = ev.clientX - resizeState.startX;
    const dy = ev.clientY - resizeState.startY;
    if (!resizeState.changed && Math.hypot(dx, dy) < 3) return;
    resizeState.changed = true;
    el.classList.add("resizing");
    let { left, top, width, height } = resizeState.origin;
    const dir = resizeState.dir;
    if (dir.includes("e")) width = resizeState.origin.width + dx;
    if (dir.includes("w")) {
      width = resizeState.origin.width - dx;
      left = resizeState.origin.left + dx;
    }
    if (dir.includes("s")) height = resizeState.origin.height + dy;
    if (dir.includes("n")) {
      height = resizeState.origin.height - dy;
      top = resizeState.origin.top + dy;
    }
    if (width < PLACED_TEXT_MIN_PX) {
      if (dir.includes("w")) left = resizeState.origin.left + resizeState.origin.width - PLACED_TEXT_MIN_PX;
      width = PLACED_TEXT_MIN_PX;
    }
    if (height < PLACED_TEXT_MIN_PX) {
      if (dir.includes("n")) top = resizeState.origin.top + resizeState.origin.height - PLACED_TEXT_MIN_PX;
      height = PLACED_TEXT_MIN_PX;
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
  };

  el.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0 || ev.target.closest(".placed-text-handle")) return;
    ev.stopPropagation();
    ev.preventDefault();
    dragState = {
      startX: ev.clientX,
      startY: ev.clientY,
      originLeft: parseFloat(el.style.left),
      originTop: parseFloat(el.style.top),
      moved: false,
    };
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", finishDrag);
  });

  for (const dir of PLACED_TEXT_HANDLES) {
    const handle = document.createElement("span");
    handle.className = `placed-text-handle ${dir}`;
    handle.dataset.dir = dir;
    handle.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      ev.preventDefault();
      resizeState = {
        dir,
        startX: ev.clientX,
        startY: ev.clientY,
        origin: overlayPixelRect(el),
        changed: false,
      };
      document.addEventListener("mousemove", onResizeMove);
      document.addEventListener("mouseup", finishResize);
    });
    el.appendChild(handle);
  }

  el.addEventListener("dblclick", (ev) => {
    ev.stopPropagation();
    commitPendingImageOverlay();
  });
}

async function showPendingImageOverlay(imageBlob, mimeType) {
  if (!state.imageCursor) {
    setStatus(t("First click the page where the picture should go"), "error");
    return;
  }
  dismissPendingImageOverlay();
  const { shell, scale, pageIndex, pixel } = state.imageCursor;
  const objectUrl = URL.createObjectURL(imageBlob);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = objectUrl;
  });
  const size = defaultImagePixelSize(img.naturalWidth, img.naturalHeight, scale);
  const el = document.createElement("div");
  el.className = "image-placement-preview";
  el.style.left = `${pixel.left}px`;
  el.style.top = `${pixel.top}px`;
  el.style.width = `${size.width}px`;
  el.style.height = `${size.height}px`;
  const imgEl = document.createElement("img");
  imgEl.src = objectUrl;
  imgEl.alt = t("Image to insert");
  el.appendChild(imgEl);
  attachImagePreviewOverlay(el, shell, scale, pageIndex);
  shell.appendChild(el);
  const ext = mimeType.includes("jpeg") ? "jpg" : "png";
  const imageFile = new File([imageBlob], `pasted-image.${ext}`, { type: mimeType });
  state.pendingImageOverlay = { el, shell, scale, pageIndex, imageFile, objectUrl };
  setStatus(t("Image ready: drag to move, drag a corner to resize, Enter to insert"), "ok");
}

async function commitPendingImageOverlay() {
  const pending = state.pendingImageOverlay;
  if (!pending) return;
  const region = overlayPixelToRegion(
    pending.el,
    pending.shell,
    pending.scale,
    pending.pageIndex
  );
  const imageFile = pending.imageFile;
  dismissPendingImageOverlay();
  clearImageInsertUi();
  await commitInsertImage(region, imageFile);
}

async function commitInsertImage(region, imageFile) {
  const doc = activeDoc();
  if (!doc) return;
  const scrollAnchor = captureScrollAnchor();
  try {
    setStatus(t("Inserting image…"));
    const result = await queueDocMutation(doc, () => {
      const fd = buildRegionForm(doc, region);
      fd.append("image", imageFile);
      return apiPost("/v1/pdf/sign", fd);
    });
    doc.dirty = true;
    recordServerStep(doc, result, N_("Insert image"), [region.pageIndex + 1]);
    markPageStale(doc, region.pageIndex + 1);
    await refreshStalePages(doc, { background: true });
    setStatus(t("Image inserted"), "ok");
  } catch (err) {
    setStatus(String(err.message || err), "error");
  }
}

async function pasteFromClipboard() {
  const doc = activeDoc();
  if (!doc) return;

  if (state.pendingImageOverlay) {
    await commitPendingImageOverlay();
    return;
  }

  if (state.editMode === "insert-image") {
    if (!state.imageCursor) {
      setStatus(t("First click the page where the picture should go"), "error");
      return;
    }
    try {
      const imageBlob = await readClipboardImageBlob();
      if (!imageBlob) {
        setStatus(t("There is no image on the clipboard"), "error");
        return;
      }
      await showPendingImageOverlay(imageBlob, imageBlob.type || "image/png");
    } catch (err) {
      setStatus(t("Couldn't paste the image: {error}", { error: err.message || err }), "error");
    }
    return;
  }

  if (state.inlineTextEditor?.editor) {
    try {
      const text = await readClipboardText();
      if (text) {
        await pasteIntoInlineEditor(state.inlineTextEditor.editor, text);
        setStatus(t("Pasted"), "ok");
        return;
      }
    } catch (_) {
      /* fall through to native */
    }
    state.inlineTextEditor.editor.focus();
    return;
  }

  if (isTextInputMode() && state.selectedPlacementId) {
    try {
      if (await pasteIntoSelectedPlacement()) return;
    } catch (err) {
      setStatus(String(err.message || err), "error");
      return;
    }
  }

  setStatus(t("First select PDF text or a text box, or place the image cursor"), "error");
}

function clearPlacedTextOverlays() {
  els.viewerPages.querySelectorAll(".placed-text-overlay").forEach((node) => node.remove());
}

function markPageRendered(doc, pageNum) {
  if (!doc) return;
  if (!doc.renderedPageRevision) doc.renderedPageRevision = {};
  doc.renderedPageRevision[pageNum] = doc.serverRevision ?? 0;
}

function isPageCanvasFresh(doc, pageNum) {
  if (!doc) return false;
  if (doc.stalePages?.has(pageNum)) return false;
  const shell = els.viewerPages.querySelector(`.page-shell[data-page="${pageNum}"]`);
  if (!shell) return false;
  const renderedRevision = doc.renderedPageRevision?.[pageNum];
  if (renderedRevision == null) return false;
  return renderedRevision === (doc.serverRevision ?? 0);
}

function shouldHidePlacementOverlayContent() {
  return false;
}

function showPlacementOverlayContent(el, placement) {
  if (!el || !placement) return;
  el.classList.remove("canvas-synced");
  const content = el.querySelector(".placed-text-content");
  if (content) content.textContent = placement.text;
}

async function refreshPageAfterPlacementEdit(doc, pageNum, scrollAnchor = null) {
  if (!doc || !pageNum) return;
  cancelPendingDocumentRefresh(doc);
  const anchor = scrollAnchor ?? captureScrollAnchor();
  markPageStale(doc, pageNum);
  if (doc.documentId) {
    await syncDocumentFromServer(doc, [pageNum], { afterMutation: true, forceFullSync: true });
  } else if (doc.pdfDoc) {
    await patchPageRender(pageNum);
  }
  doc.stalePages?.delete(pageNum);
  markPageRendered(doc, pageNum);
  renderPlacedTextOverlays({ force: true });
  renderCalloutOverlays();
  restoreScrollAnchor(anchor);
}

function placedTextToPixel(placement, scale) {
  return {
    left: placement.x * scale,
    top: placement.y * scale,
    width: Math.max(placement.width * scale, 20),
    height: Math.max(placement.height * scale, 14),
  };
}

function placedTextToRegion(placement) {
  return {
    pageIndex: placement.pageIndex,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
  };
}

const FONT_STACKS = {
  Helvetica: "Helvetica, Arial, sans-serif",
  Arial: "Arial, Helvetica, sans-serif",
  "Times New Roman": '"Times New Roman", serif',
  "Courier New": '"Courier New", monospace',
  宋体: '"SimSun", "Songti SC", "Noto Serif CJK SC", serif',
  黑体: '"SimHei", "Heiti SC", "Noto Sans CJK SC", sans-serif',
};

let measureCtx = null;

/** Real text width (Chinese characters are about twice as wide as Latin ones). */
function estimatePlacedTextWidth(text, fontSize, fontFamily = state.textFontFamily) {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  measureCtx.font = `${fontSize}px ${FONT_STACKS[fontFamily] || FONT_STACKS.Helvetica}`;
  const widest = String(text)
    .split(/\r?\n/)
    .reduce((max, line) => Math.max(max, measureCtx.measureText(line).width), 0);
  return Math.max(Math.ceil(widest) + 10, 24);
}

function placedTextBounds(text, fontSize, region) {
  return {
    width: estimatePlacedTextWidth(text, fontSize),
    height: Math.max(region.height, fontSize * 1.25),
  };
}

function formFieldPageIndex(field) {
  return field.pageIndex ?? field.page_index ?? 0;
}

function regionOverlapsFormField(region) {
  const doc = activeDoc();
  if (!doc?.formFields?.length) return false;
  return doc.formFields.some((field) => {
    if (formFieldPageIndex(field) !== region.pageIndex) return false;
    return pdfRectsIntersect(field, region, 2);
  });
}

function findFormFieldAtRegion(region) {
  const doc = activeDoc();
  if (!doc?.formFields?.length) return null;
  let best = null;
  let bestArea = Infinity;
  doc.formFields.forEach((field, index) => {
    if (formFieldPageIndex(field) !== region.pageIndex) return;
    if (!pdfRectsIntersect(field, region, 2)) return;
    const area = field.width * field.height;
    if (area < bestArea) {
      best = { field, index };
      bestArea = area;
    }
  });
  return best;
}

async function ensureFormFieldsLoaded(doc) {
  // Fetched once per document version. An empty list is a real answer too:
  // it used to be treated as "not loaded", so every click with a text tool
  // waited for a server round trip before the text box could open.
  if (!doc || Array.isArray(doc.formFields)) return;
  if (doc._formFieldsPromise) return doc._formFieldsPromise;
  doc._formFieldsPromise = (async () => {
    // Most PDFs have no form at all; pdf.js can tell without the server.
    if (doc.pdfDoc) {
      try {
        const objects = await doc.pdfDoc.getFieldObjects();
        if (!objects || !Object.keys(objects).length) {
          doc.formFields = [];
          return;
        }
      } catch (_) {
        /* fall back to asking the server */
      }
    }
    try {
      const data = await withDocSession(doc, () => {
        const fd = new FormData();
        appendDocToForm(fd, doc);
        return apiPost("/v1/pdf/form-fields", fd);
      });
      doc.formFields = data.fields || [];
    } catch (_) {
      doc.formFields = doc.formFields || [];
    }
  })().finally(() => {
    doc._formFieldsPromise = null;
  });
  return doc._formFieldsPromise;
}

/** A paragraph box: the width of the text it replaces, as tall as the new text needs (never less). */
function paragraphBounds(text, fontSize, region, paragraph) {
  const width = Math.max(paragraph.width, fontSize);
  let lines = 0;
  for (const part of String(text).split("\n")) {
    lines += Math.max(1, Math.ceil(estimatePlacedTextWidth(part, fontSize) / width));
  }
  return {
    width: region.width,
    height: Math.max(region.height, (lines - 1) * paragraph.lineHeight + fontSize * 1.25 + 2),
  };
}

function coverTextBounds(text, fontSize, region) {
  return {
    width: Math.max(region.width, estimatePlacedTextWidth(text, fontSize)),
    height: Math.max(region.height, fontSize * 1.25),
  };
}

function pdfRectsIntersect(a, b, pad = 0) {
  return (
    a.x - pad < b.x + b.width + pad &&
    a.x + a.width + pad > b.x - pad &&
    a.y - pad < b.y + b.height + pad &&
    a.y + a.height + pad > b.y - pad
  );
}

function snapToPlacedText(region) {
  const doc = activeDoc();
  const kind = expectedPlacementKind();
  if (!doc?.placedTexts?.length || !kind) return null;
  let best = null;
  let bestScore = Infinity;
  for (const placement of doc.placedTexts) {
    const placementKind = placement.kind === "cover" ? "cover" : "plain";
    if (!placementKindActive(placementKind)) continue;
    if (placement.pageIndex !== region.pageIndex) continue;
    if (!pdfRectsIntersect(placement, region, 6)) continue;
    const dx = placement.x - region.x;
    const dy = placement.y - region.y;
    const score = dx * dx + dy * dy;
    if (score < bestScore) {
      best = placement;
      bestScore = score;
    }
  }
  return best;
}

const PLACED_TEXT_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const PLACED_TEXT_MIN_PX = 28;

function overlayPixelRect(el) {
  return {
    left: parseFloat(el.style.left),
    top: parseFloat(el.style.top),
    width: parseFloat(el.style.width),
    height: parseFloat(el.style.height),
  };
}

function overlayPixelToRegion(el, shell, scale, pageIndex) {
  const pixel = overlayPixelRect(el);
  return canvasToPdfRect(
    shell,
    pixel.left,
    pixel.top,
    pixel.left + pixel.width,
    pixel.top + pixel.height,
    { scale, pageIndex }
  );
}

function attachOverlayDrag(el, shell, scale, placement, handlers) {
  let dragState = null;
  let dragFrame = null;
  let pendingDragEv = null;

  const finishDrag = async () => {
    if (!dragState) return;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", finishDrag);
    if (dragFrame) {
      cancelAnimationFrame(dragFrame);
      dragFrame = null;
    }
    pendingDragEv = null;
    const moved = dragState.moved;
    const eraseBounds = dragState.eraseBounds;
    dragState = null;
    el.classList.remove("dragging");
    endPlacementInteraction();
    if (!moved) {
      await handlers.onClick?.(eraseBounds);
      return;
    }
    const newRegion = overlayPixelToRegion(el, shell, scale, placement.pageIndex);
    await handlers.onMove?.(newRegion, eraseBounds);
  };

  const onDragMove = (ev) => {
    if (!dragState) return;
    pendingDragEv = ev;
    if (dragFrame) return;
    dragFrame = requestAnimationFrame(() => {
      dragFrame = null;
      const current = pendingDragEv;
      pendingDragEv = null;
      if (!dragState || !current) return;
      const dx = current.clientX - dragState.startX;
      const dy = current.clientY - dragState.startY;
      if (!dragState.moved && Math.hypot(dx, dy) < 4) return;
      dragState.moved = true;
      el.classList.add("dragging");
      el.style.left = `${dragState.originLeft + dx}px`;
      el.style.top = `${dragState.originTop + dy}px`;
      if (pendingDragEv) onDragMove(pendingDragEv);
    });
  };

  el.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0 || ev.target.closest(".placed-text-handle")) return;
    ev.stopPropagation();
    ev.preventDefault();
    selectPlacement(placement.id);
    showPlacementOverlayContent(el, placement);
    beginPlacementInteraction(placement.pageIndex);
    dragState = {
      startX: ev.clientX,
      startY: ev.clientY,
      originLeft: parseFloat(el.style.left),
      originTop: parseFloat(el.style.top),
      moved: false,
      eraseBounds: handlers.eraseBoundsAt(placement),
    };
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", finishDrag);
  });
}

function attachPlacedTextOverlay(el, placement, shell, scale) {
  el.dataset.placementId = placement.id;
  el.title = t("Drag to move; drag an edge or corner to resize; click to edit; right-click for properties; Delete to remove");
  let resizeState = null;

  attachOverlayDrag(el, shell, scale, placement, {
    eraseBoundsAt: () => overlayPixelToRegion(el, shell, scale, placement.pageIndex),
    onClick: async (eraseBounds) => {
      const pixel = overlayPixelRect(el);
      const region = overlayPixelToRegion(el, shell, scale, placement.pageIndex);
      openInlineTextEditor(shell, pixel, region, {
        mode: "cover",
        initialText: placement.text,
        fontSize: placement.fontSize || state.textFontSize,
        fontFamily: placement.fontFamily,
        placementId: placement.id,
        eraseBounds,
      });
    },
    onMove: async (newRegion, eraseBounds) => {
      await commitMovePlacedText(placement, newRegion, eraseBounds);
    },
  });

  const finishResize = async () => {
    if (!resizeState) return;
    document.removeEventListener("mousemove", onResizeMove);
    document.removeEventListener("mouseup", finishResize);
    const changed = resizeState.changed;
    const eraseBounds = resizeState.eraseBounds;
    resizeState = null;
    el.classList.remove("resizing");
    endPlacementInteraction();
    if (!changed) return;
    const newRegion = overlayPixelToRegion(el, shell, scale, placement.pageIndex);
    await commitCoverText(
      newRegion,
      placement.text,
      placement.fontSize || state.textFontSize,
      placement.id,
      eraseBounds,
      { preserveBounds: true }
    );
  };

  const onResizeMove = (ev) => {
    if (!resizeState) return;
    const dx = ev.clientX - resizeState.startX;
    const dy = ev.clientY - resizeState.startY;
    if (!resizeState.changed && Math.hypot(dx, dy) < 3) return;
    resizeState.changed = true;
    el.classList.add("resizing");

    let { left, top, width, height } = resizeState.origin;
    const dir = resizeState.dir;

    if (dir.includes("e")) width = resizeState.origin.width + dx;
    if (dir.includes("w")) {
      width = resizeState.origin.width - dx;
      left = resizeState.origin.left + dx;
    }
    if (dir.includes("s")) height = resizeState.origin.height + dy;
    if (dir.includes("n")) {
      height = resizeState.origin.height - dy;
      top = resizeState.origin.top + dy;
    }

    if (width < PLACED_TEXT_MIN_PX) {
      if (dir.includes("w")) left = resizeState.origin.left + resizeState.origin.width - PLACED_TEXT_MIN_PX;
      width = PLACED_TEXT_MIN_PX;
    }
    if (height < PLACED_TEXT_MIN_PX) {
      if (dir.includes("n")) top = resizeState.origin.top + resizeState.origin.height - PLACED_TEXT_MIN_PX;
      height = PLACED_TEXT_MIN_PX;
    }

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
  };

  for (const dir of PLACED_TEXT_HANDLES) {
    const handle = document.createElement("span");
    handle.className = `placed-text-handle ${dir}`;
    handle.dataset.dir = dir;
    handle.title = t("Drag to resize");
    handle.addEventListener("mousedown", (ev) => {
      selectPlacement(placement.id);
      if (ev.button !== 0) return;
      ev.stopPropagation();
      ev.preventDefault();
      showPlacementOverlayContent(el, placement);
      beginPlacementInteraction(placement.pageIndex);
      resizeState = {
        dir,
        startX: ev.clientX,
        startY: ev.clientY,
        origin: overlayPixelRect(el),
        changed: false,
        eraseBounds: overlayPixelToRegion(el, shell, scale, placement.pageIndex),
      };
      document.addEventListener("mousemove", onResizeMove);
      document.addEventListener("mouseup", finishResize);
    });
    el.appendChild(handle);
  }
}

function attachPlainTextOverlay(el, placement, shell, scale) {
  el.dataset.placementId = placement.id;
  el.title = t("Drag to move; click to edit; right-click for properties; Delete to remove");
  attachOverlayDrag(el, shell, scale, placement, {
    eraseBoundsAt: () => overlayPixelToRegion(el, shell, scale, placement.pageIndex),
    onClick: async (eraseBounds) => {
      const pixel = overlayPixelRect(el);
      const region = overlayPixelToRegion(el, shell, scale, placement.pageIndex);
      openInlineTextEditor(shell, pixel, region, {
        mode: "plain",
        initialText: placement.text,
        fontSize: placement.fontSize || state.textFontSize,
        fontFamily: placement.fontFamily,
        placementId: placement.id,
        eraseBounds,
      });
    },
    onMove: async (newRegion, eraseBounds) => {
      await commitMovePlainText(placement, newRegion, eraseBounds);
    },
  });
}

function placementById(placementId) {
  return activeDoc()?.placedTexts?.find((item) => item.id === placementId) || null;
}

function effectivePlacementColor(placement, key) {
  const defaults = PLACEMENT_COLOR_DEFAULTS[placementKindOf(placement)];
  return placement.colors?.[key] || defaults[key];
}

function applyPlacementColors(el, placement, editable) {
  const colors = placement.colors;
  if (!colors) return;
  if (editable) {
    if (colors.editBackground) el.style.background = colors.editBackground;
    if (colors.editColor) el.style.color = colors.editColor;
  } else {
    if (colors.idleBackground) el.style.background = colors.idleBackground;
    if (colors.idleColor) el.style.color = colors.idleColor;
  }
}

function setPlacementColor(placementId, key, value) {
  const doc = activeDoc();
  const placement = placementById(placementId);
  if (!doc || !placement) return;
  const defaults = PLACEMENT_COLOR_DEFAULTS[placementKindOf(placement)];
  const next = { ...(placement.colors || {}) };
  if (value === defaults[key]) delete next[key];
  else next[key] = value;
  if (Object.keys(next).length) placement.colors = next;
  else delete placement.colors;
  doc.dirty = true;
  doc.placementsDirty = true;
  renderPlacedTextOverlays({ force: true });
}

function updatePlacementFields(placementId, patch) {
  const doc = activeDoc();
  const placement = placementById(placementId);
  if (!doc || !placement) return;
  Object.assign(placement, patch);
  // a font chosen by hand replaces the look of the text the box replaces
  if (patch.fontFamily && placement.matchStyle) {
    delete placement.matchStyle;
    delete placement.origin;
  }
  doc.dirty = true;
  doc.placementsDirty = true;
  renderPlacedTextOverlays({ force: true });
}

function clampPlacementNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(max, Math.max(min, Math.round(number * 10) / 10));
}

let placementColorMenuCloser = null;

function closePlacementColorMenu() {
  document.getElementById("placementColorMenu")?.remove();
  placementColorMenuCloser?.();
  placementColorMenuCloser = null;
}

function openPlacementColorMenu(placementId, x, y) {
  const placement = placementById(placementId);
  if (!placement) return;
  closePlacementColorMenu();
  const menu = document.createElement("div");
  menu.id = "placementColorMenu";
  menu.className = "placement-color-menu";
  menu.addEventListener("contextmenu", (ev) => ev.preventDefault());
  menu.addEventListener("mousedown", (ev) => ev.stopPropagation());

  const title = document.createElement("p");
  title.className = "placement-color-title";
  title.textContent = placementKindOf(placement) === "cover" ? t("Edit text: text box") : t("Added text: text box");
  menu.appendChild(title);

  const appendHeading = (text) => {
    const head = document.createElement("p");
    head.className = "placement-color-heading";
    head.textContent = text;
    menu.appendChild(head);
  };

  const appendNumberRow = (labelText, value, min, max, onCommit) => {
    const row = document.createElement("div");
    row.className = "placement-color-row";
    const label = document.createElement("span");
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.step = "1";
    input.value = String(Math.round(Number(value) * 10) / 10);
    const commit = () => {
      const next = clampPlacementNumber(input.value, min, max);
      if (next == null) return;
      input.value = String(next);
      onCommit(next);
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        commit();
      }
    });
    row.append(label, input);
    menu.appendChild(row);
  };

  appendHeading(t("Text box"));
  appendNumberRow(t("Width"), placement.width, 8, 2000, (width) => {
    updatePlacementFields(placementId, { width });
  });
  appendNumberRow(t("Height"), placement.height, 8, 2000, (height) => {
    updatePlacementFields(placementId, { height });
  });

  appendHeading(t("Text"));
  appendNumberRow(t("Font size"), placement.fontSize || state.textFontSize, 6, 96, (fontSize) => {
    updatePlacementFields(placementId, { fontSize });
  });

  const familyRow = document.createElement("div");
  familyRow.className = "placement-color-row";
  const familyLabel = document.createElement("span");
  familyLabel.textContent = t("Font");
  const family = document.createElement("select");
  const currentFamily = placement.fontFamily || state.textFontFamily || "Helvetica";
  const familyOptions = els.textFontFamilySelect
    ? [...els.textFontFamilySelect.options]
    : [];
  if (!familyOptions.some((opt) => opt.value === currentFamily)) {
    const extra = document.createElement("option");
    extra.value = currentFamily;
    extra.textContent = fontFamilyLabel(currentFamily);
    family.appendChild(extra);
  }
  for (const opt of familyOptions) {
    const node = document.createElement("option");
    node.value = opt.value;
    node.textContent = opt.textContent;
    family.appendChild(node);
  }
  family.value = currentFamily;
  family.addEventListener("change", () => {
    updatePlacementFields(placementId, { fontFamily: family.value });
  });
  familyRow.append(familyLabel, family);
  menu.appendChild(familyRow);

  const appendSection = (heading, backgroundKey, colorKey) => {
    const head = document.createElement("p");
    head.className = "placement-color-heading";
    head.textContent = heading;
    menu.appendChild(head);

    const bgRow = document.createElement("div");
    bgRow.className = "placement-color-row";
    const bgLabel = document.createElement("span");
    bgLabel.textContent = t("Background");
    const bgInput = document.createElement("input");
    bgInput.type = "color";
    const bgValue = effectivePlacementColor(placement, backgroundKey);
    const bgClear = bgValue === "transparent";
    bgInput.value = bgClear ? "#ffffff" : bgValue;
    bgInput.disabled = bgClear;
    bgInput.addEventListener("input", () => setPlacementColor(placementId, backgroundKey, bgInput.value));
    const clearLabel = document.createElement("label");
    clearLabel.className = "placement-color-clear";
    const clearBox = document.createElement("input");
    clearBox.type = "checkbox";
    clearBox.checked = bgClear;
    clearBox.addEventListener("change", () => {
      bgInput.disabled = clearBox.checked;
      setPlacementColor(placementId, backgroundKey, clearBox.checked ? "transparent" : bgInput.value);
    });
    clearLabel.append(clearBox, document.createTextNode(t("Transparent")));
    bgRow.append(bgLabel, bgInput, clearLabel);
    menu.appendChild(bgRow);

    const fgRow = document.createElement("div");
    fgRow.className = "placement-color-row";
    const fgLabel = document.createElement("span");
    fgLabel.textContent = t("Text color");
    const fgInput = document.createElement("input");
    fgInput.type = "color";
    fgInput.value = effectivePlacementColor(placement, colorKey);
    fgInput.addEventListener("input", () => setPlacementColor(placementId, colorKey, fgInput.value));
    fgRow.append(fgLabel, fgInput);
    menu.appendChild(fgRow);
  };

  appendSection(t("While the tool is on"), "editBackground", "editColor");
  appendSection(t("After the tool is off"), "idleBackground", "idleColor");

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "ghost-btn placement-color-reset";
  reset.textContent = t("Reset to default");
  reset.addEventListener("click", () => {
    const current = placementById(placementId);
    if (current) delete current.colors;
    const doc = activeDoc();
    if (doc) {
      doc.dirty = true;
      doc.placementsDirty = true;
    }
    renderPlacedTextOverlays({ force: true });
    openPlacementColorMenu(placementId, x, y);
  });
  menu.appendChild(reset);

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;

  const onKey = (ev) => {
    if (ev.key !== "Escape") return;
    closePlacementColorMenu();
  };
  const onPointer = (ev) => {
    if (menu.isConnected && (menu.contains(ev.target) || menu.contains(document.activeElement))) return;
    closePlacementColorMenu();
  };
  placementColorMenuCloser = () => {
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("pointerdown", onPointer, true);
  };
  document.addEventListener("keydown", onKey);
  setTimeout(() => document.addEventListener("pointerdown", onPointer, true), 0);
}

function renderPlacedTextOverlays(options = {}) {
  scheduleEditorCheckpoint();
  if (state.placementInteraction?.active && !options.force) return;
  clearPlacedTextOverlays();
  const doc = activeDoc();
  if (!doc?.placedTexts?.length) return;
  for (const placement of doc.placedTexts) {
    if (placement?.kind === "callout") continue;
    const kind = placement.kind === "cover" ? "cover" : "plain";
    const active = placementKindActive(kind);
    const shell = els.viewerPages.querySelector(
      `.page-shell[data-page="${placement.pageIndex + 1}"]`
    );
    if (!shell) continue;
    const scale = Number(shell.dataset.scale) || 1;
    const el = document.createElement("div");
    el.className = `placed-text-overlay ${kind}`;
    el.style.left = `${placement.x * scale}px`;
    el.style.top = `${placement.y * scale}px`;
    el.style.width = `${Math.max(placement.width * scale, 20)}px`;
    el.style.height = `${Math.max(placement.height * scale, 14)}px`;
    el.style.fontSize = `${(placement.fontSize || state.textFontSize) * scale}px`;
    const pdfFont = placement.matchStyle && doc._runFonts?.[placement.id];
    const family = placement.fontFamily || state.textFontFamily || "Helvetica";
    // while the page's own font is loaded (until the file is reloaded), show the new text in it
    el.style.fontFamily = pdfFont ? `"${pdfFont}", ${family}` : family;
    const content = document.createElement("span");
    content.className = "placed-text-content";
    content.textContent = placement.text;
    if (placement.paragraph) {
      el.classList.add("paragraph");
      content.style.lineHeight = `${placement.paragraph.lineHeight * scale}px`;
      content.style.textAlign = placement.paragraph.align === "justify" ? "justify" : placement.paragraph.align || "left";
      if (placement.paragraph.indent) content.style.textIndent = `${placement.paragraph.indent * scale}px`;
    }
    el.appendChild(content);
    const origin = placement.origin;
    if (kind === "cover" && origin && !active && !placement.colors?.idleBackground) {
      const ox = (origin.x - placement.x) * scale;
      const oy = (origin.y - placement.y) * scale;
      el.style.background = `linear-gradient(#fff, #fff) ${ox}px ${oy}px / ${origin.width * scale}px ${origin.height * scale}px no-repeat`;
    }
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "placement-delete-btn";
    deleteBtn.title = t("Delete text box (Delete)");
    deleteBtn.setAttribute("aria-label", t("Delete text box"));
    deleteBtn.textContent = "×";
    deleteBtn.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
    });
    deleteBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      commitDeletePlacement(placement);
    });
    el.appendChild(deleteBtn);
    if (state.selectedPlacementId === placement.id) el.classList.add("selected");
    applyPlacementColors(el, placement, active);
    el.addEventListener("mousedown", (ev) => {
      if (ev.button === 2 || !active) ev.stopPropagation();
    });
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      selectPlacement(placement.id);
      openPlacementColorMenu(placement.id, ev.clientX, ev.clientY);
    });
    if (active) {
      if (kind === "cover") {
        attachPlacedTextOverlay(el, placement, shell, scale);
      } else {
        attachPlainTextOverlay(el, placement, shell, scale);
      }
    } else {
      el.classList.add("placement-readonly");
    }
    shell.appendChild(el);
  }
}

function forgetPlacedText(placementId) {
  const doc = activeDoc();
  if (!doc?.placedTexts) return;
  doc.placedTexts = doc.placedTexts.filter((item) => item.id !== placementId);
  doc.placementsDirty = true;
  if (state.selectedPlacementId === placementId) clearPlacementSelection();
}

async function commitDeletePlacement(placement) {
  const doc = activeDoc();
  if (!doc || !placement) return;
  forgetPlacedText(placement.id);
  doc.dirty = true;
  renderPlacedTextOverlays({ force: true });
  setStatus(t("Text box deleted"), "ok");
}

async function deleteSelectedPlacement() {
  const doc = activeDoc();
  if (!doc || !state.selectedPlacementId || !isTextInputMode()) return false;
  const placement = doc.placedTexts?.find((item) => item.id === state.selectedPlacementId);
  if (!placement) return false;
  const placementKind = placement.kind === "cover" ? "cover" : "plain";
  if (!placementKindActive(placementKind)) return false;
  await commitDeletePlacement(placement);
  return true;
}

function rememberPlacedText(region, text, fontSize, placementId = null, options = {}) {
  const doc = activeDoc();
  if (!doc) return;
  if (!doc.placedTexts) doc.placedTexts = [];
  const kind = options.kind === "cover" ? "cover" : "plain";
  let bounds = region;
  if (!options.preserveBounds) {
    bounds =
      kind === "cover"
        ? coverTextBounds(text, fontSize, region)
        : placedTextBounds(text, fontSize, region);
  }
  const existing = placementId
    ? doc.placedTexts.find((item) => item.id === placementId)
    : null;
  const entry = {
    id: placementId || crypto.randomUUID(),
    kind,
    pageIndex: region.pageIndex,
    x: region.x,
    y: region.y,
    width: bounds.width,
    height: bounds.height,
    text,
    fontSize,
    fontFamily: options.fontFamily || existing?.fontFamily || state.textFontFamily || "Helvetica",
  };
  if (existing?.colors) entry.colors = existing.colors;
  // Edit text on the page's own text keeps that text's look (the server finds it at "origin")
  const style = options.style || (existing?.matchStyle ? { origin: existing.origin } : null);
  const paragraph = options.paragraph || existing?.paragraph;
  if (kind === "cover" && paragraph) entry.paragraph = paragraph;
  // the text it replaces, even when the box later grows past it: only that is erased
  if (kind === "cover" && !style?.origin && existing?.origin) entry.origin = existing.origin;
  if (kind === "cover" && style?.origin && options.fontFamily) {
    // a font chosen for it: written in that font, still erasing only the text it replaced
    entry.origin = style.origin;
  } else if (kind === "cover" && style?.origin) {
    entry.matchStyle = true;
    entry.origin = style.origin;
    if (style.pdfFont) {
      doc._runFonts = doc._runFonts || {};
      doc._runFonts[entry.id] = style.pdfFont;
    }
  }
  if (placementId) {
    const idx = doc.placedTexts.findIndex((item) => item.id === placementId);
    if (idx >= 0) doc.placedTexts[idx] = entry;
    else doc.placedTexts.push(entry);
  } else {
    doc.placedTexts.push(entry);
  }
  doc.placementsDirty = true;
}

function openInlineTextEditor(shell, pixel, region, options = {}) {
  dismissInlineTextEditor();
  const scale = Number(shell.dataset.scale) || 1;
  const mode = options.mode || "plain";
  const fontSize = options.fontSize ?? state.textFontSize;
  const editor = document.createElement("div");
  editor.className = "inline-text-editor";
  if (mode === "callout") editor.classList.add("callout-text-editor");
  editor.contentEditable = "true";
  editor.spellcheck = false;
  editor.style.left = `${pixel.left}px`;
  editor.style.top = `${pixel.top}px`;
  editor.style.minWidth = `${Math.max(pixel.width, 24)}px`;
  editor.style.minHeight = `${Math.max(pixel.height, fontSize * scale * 1.2)}px`;
  editor.style.fontSize = `${fontSize * scale}px`;
  editor.style.lineHeight = `${fontSize * scale * 1.2}px`;
  editor.style.fontFamily = options.fontFamily || state.textFontFamily || "Helvetica";
  if (options.paragraph) {
    editor.classList.add("paragraph-editor");
    editor.style.width = `${Math.max(pixel.width, 24)}px`;
    editor.style.lineHeight = `${options.paragraph.lineHeight * scale}px`;
    editor.style.textAlign = options.paragraph.align === "justify" ? "justify" : options.paragraph.align || "left";
    if (options.paragraph.indent) editor.style.textIndent = `${options.paragraph.indent * scale}px`;
  }
  shell.appendChild(editor);
  if (options.initialText) {
    editor.textContent = options.initialText;
  }
  state.inlineTextEditor = {
    editor,
    shell,
    region,
    scale,
    mode,
    fontSize,
    eraseBounds: options.eraseBounds || null,
    placementId: options.placementId || null,
    preserveBounds: !!options.preserveBounds,
    calloutAnchor: options.calloutAnchor || null,
    calloutId: options.calloutId || null,
    calloutDraft: !!options.calloutDraft,
    style: options.style || null,
    paragraph: options.paragraph || null,
    // the font family the box is written in; chosen in the toolbar while typing, it replaces the page's look
    family: options.family || state.textFontFamily || "Helvetica",
    familyChosen: false,
    // text put on a line of the page: a new size keeps it on that line
    keepBaseline: !!options.keepBaseline,
  };
  if (mode === "callout") {
    editor.style.width = `${Math.max(pixel.width, 24)}px`;
    editor.style.height = `${Math.max(pixel.height, fontSize * scale * 1.2)}px`;
  }
  syncTextStyleToolbar();
  editor.focus();
  if (options.initialText) {
    let range = null;
    const at = options.caretAt;
    if (at && document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(at.x, at.y);
      if (r && editor.contains(r.startContainer)) range = r;
    } else if (at && document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(at.x, at.y);
      if (pos && editor.contains(pos.offsetNode)) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
      }
    }
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  let committing = false;
  const commit = async () => {
    if (committing) return;
    if (!state.inlineTextEditor || state.inlineTextEditor.editor !== editor) return;
    committing = true;
    const ctx = state.inlineTextEditor;
    const text = (ctx.paragraph ? editor.innerText : editor.textContent).replace(/\u200B/g, "").trim();
    dismissInlineTextEditor();
    try {
      if (!text) {
        if (ctx.mode === "callout" && ctx.calloutId) {
          deleteCallout(ctx.calloutId);
          return;
        }
        if (ctx.placementId) {
          const doc = activeDoc();
          const placement = doc?.placedTexts?.find((item) => item.id === ctx.placementId);
          if (placement) await commitDeletePlacement(placement);
        }
        return;
      }
      if (ctx.mode === "callout") {
        await commitCalloutText(ctx.region, text, ctx.fontSize, ctx.calloutAnchor, ctx.calloutId);
      } else if (ctx.mode === "cover") {
        const fontFamily = ctx.familyChosen ? ctx.family : undefined;
        await commitCoverText(
          ctx.region,
          text,
          ctx.fontSize,
          ctx.placementId,
          ctx.eraseBounds,
          ctx.preserveBounds
            ? { preserveBounds: true, kind: "cover", style: ctx.style, paragraph: ctx.paragraph, fontFamily }
            : { kind: "cover", style: ctx.style, paragraph: ctx.paragraph, fontFamily }
        );
      } else if (ctx.placementId && ctx.eraseBounds) {
        await commitPlainTextEdit(
          ctx.region,
          text,
          ctx.fontSize,
          ctx.placementId,
          ctx.eraseBounds,
          ctx.familyChosen ? ctx.family : undefined
        );
      } else {
        await commitDrawText(ctx.region, text, ctx.fontSize);
      }
    } finally {
      committing = false;
    }
  };
  state.inlineTextEditor.commit = commit;

  editor.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      // Esc cancels the typing only; the tool stays on (a second Esc leaves it)
      e.stopPropagation();
      const ctx = state.inlineTextEditor;
      dismissInlineTextEditor();
      if (ctx?.mode === "callout" && ctx.calloutDraft && ctx.calloutId) {
        deleteCallout(ctx.calloutId, t("Comment canceled"));
        return;
      }
      setStatus(t("Typing canceled"), "ok");
    }
  });

  editor.addEventListener("blur", (ev) => {
    const sel = window.getSelection();
    if (sel?.rangeCount && editor.contains(sel.anchorNode)) {
      state.inlineTextEditor && (state.inlineTextEditor.savedRange = sel.getRangeAt(0).cloneRange());
    }
    // the size and font menus act on this box: it stays open while they are used
    if (ev.relatedTarget && els.textStyleToolbar?.contains(ev.relatedTarget)) return;
    setTimeout(() => {
      if (state.inlineTextEditor?.editor !== editor) return;
      if (els.textStyleToolbar?.contains(document.activeElement)) return;
      const text = editor.textContent.replace(/\u200B/g, "").trim();
      if (text) {
        commit();
        return;
      }
      const ctx = state.inlineTextEditor;
      dismissInlineTextEditor();
      if (ctx?.mode === "callout" && ctx.calloutId) {
        deleteCallout(ctx.calloutId, ctx.calloutDraft ? t("Comment canceled") : t("Comment deleted"));
        return;
      }
      if (ctx?.placementId) {
        const doc = activeDoc();
        const placement = doc?.placedTexts?.find((item) => item.id === ctx.placementId);
        if (placement) commitDeletePlacement(placement);
      }
    }, 120);
  });
}

async function commitFormFieldText(formHit, text, scrollAnchor) {
  const doc = activeDoc();
  if (!doc) return false;
  const { field, index } = formHit;
  const result = await queueDocMutation(doc, () => {
    const fd = new FormData();
    appendDocToForm(fd, doc);
    fd.append("values", JSON.stringify({ [field.name]: text }));
    return apiPost("/v1/pdf/fill-form", fd);
  });
  doc.dirty = true;
  const pageNum = (formFieldPageIndex(field) ?? doc.pageNum - 1) + 1;
  recordServerStep(doc, result, N_("Fill in forms"), [pageNum]);
  await refreshWorkingCopyFromServer(doc);
  markPageStale(doc, pageNum);
  if (doc.formFields?.length) renderFormOverlays(doc.formFields);
  field.value = text;
  document.querySelectorAll(`[data-form-index="${index}"]`).forEach((input) => {
    if (input.type === "checkbox") return;
    input.value = text;
  });
  return true;
}

async function commitCalloutText(region, text, fontSize, anchor, calloutId = null) {
  const doc = activeDoc();
  if (!doc || !anchor) return;
  const entry = rememberCallout(region, text, fontSize, anchor, calloutId);
  if (entry) state.selectedCalloutId = entry.id;
  renderCalloutOverlays();
  setStatus(calloutId ? t("Comment changed") : t("Comment added"), "ok");
}

async function commitDrawText(region, text, fontSize) {
  const doc = activeDoc();
  if (!doc) return;
  const scrollAnchor = captureScrollAnchor();
  try {
    setStatus(t("Inserting text…"));
    await ensureDocumentSession(doc).catch(() => {});
    await ensureFormFieldsLoaded(doc);
    const formHit = findFormFieldAtRegion(region);
    if (
      formHit &&
      !["checkbox", "signature", "button"].includes(formHit.field.kind) &&
      !formHit.field.readOnly
    ) {
      await commitFormFieldText(formHit, text, scrollAnchor);
      setStatus(t("Filled in the form field"), "ok");
      return;
    }
    const bounds = placedTextBounds(text, fontSize, region);
    rememberPlacedText({ ...region, ...bounds }, text, fontSize, null, { kind: "plain" });
    doc.dirty = true;
    renderPlacedTextOverlays({ force: true });
    setStatus(t("Text inserted"), "ok");
  } catch (err) {
    setStatus(String(err.message || err), "error");
  }
}

async function commitPlainTextEdit(region, text, fontSize, placementId, _eraseBounds, fontFamily) {
  const doc = activeDoc();
  if (!doc) return;
  const bounds = placedTextBounds(text, fontSize, region);
  rememberPlacedText({ ...region, ...bounds }, text, fontSize, placementId, { kind: "plain", fontFamily });
  doc.dirty = true;
  renderPlacedTextOverlays({ force: true });
  setStatus(t("Text changed"), "ok");
}

async function commitCoverText(
  region,
  text,
  fontSize,
  placementId = null,
  eraseBounds = null,
  options = {}
) {
  const doc = activeDoc();
  if (!doc) return;
  const bounds = options.paragraph
    ? paragraphBounds(text, fontSize, region, options.paragraph)
    : options.preserveBounds
      ? region
      : coverTextBounds(text, fontSize, region);
  const coverRegion = options.preserveBounds ? { ...region } : { ...region, ...bounds };
  rememberPlacedText(coverRegion, text, fontSize, placementId, {
    kind: "cover",
    ...options,
    preserveBounds: options.preserveBounds || !!options.paragraph,
  });
  if (options.paragraph && bounds.height > region.height + 1) {
    doc.dirty = true;
    renderPlacedTextOverlays({ force: true });
    setStatus(t("The new text is longer than the paragraph it replaces and may run into what follows"), "error");
    return;
  }
  doc.dirty = true;
  renderPlacedTextOverlays({ force: true });
  setStatus(t("Text changed"), "ok");
}

async function commitMovePlainText(placement, newRegion) {
  const doc = activeDoc();
  if (!doc) return;
  const fontSize = placement.fontSize || state.textFontSize;
  rememberPlacedText(
    {
      pageIndex: placement.pageIndex,
      x: newRegion.x,
      y: newRegion.y,
      width: placement.width,
      height: placement.height,
    },
    placement.text,
    fontSize,
    placement.id,
    { preserveBounds: true, kind: "plain" }
  );
  doc.dirty = true;
  renderPlacedTextOverlays({ force: true });
  setStatus(t("Text box moved"), "ok");
}

async function commitMovePlacedText(placement, newRegion) {
  const doc = activeDoc();
  if (!doc) return;
  const fontSize = placement.fontSize || state.textFontSize;
  rememberPlacedText(
    {
      ...newRegion,
      pageIndex: placement.pageIndex,
    },
    placement.text,
    fontSize,
    placement.id,
    { preserveBounds: true, kind: "cover" }
  );
  doc.dirty = true;
  renderPlacedTextOverlays({ force: true });
  setStatus(t("Text box moved"), "ok");
}

function syncEditModeLayers() {
  if (!els.viewerPages) return;
  els.viewerPages.querySelectorAll(".page-shell").forEach((shell) => {
    detachRegionSelect(shell);
    shell.classList.toggle("selectable", isEditToolMode());
    if (!isEditToolMode()) return;
    const scale = Number(shell.dataset.scale) || 1;
    const pageIndex = Number(shell.dataset.pageIndex);
    attachRegionSelect(shell, { scale, pageIndex, viewport: null });
  });
}

function setEditMode(mode) {
  const previousMode = state.editMode;
  if (mode !== "select" && mode !== previousMode && formsPanelOpen()) closePropsPanel();
  if (mode === "select") {
    state.editMode = "select";
  } else {
    state.editMode = state.editMode === mode ? "select" : mode;
  }
  state.pendingSignImage = null;
  if (previousMode === "sign" && state.editMode !== "sign") window.OpenPDFSign?.leaveSignMode();
  if (!isTextInputMode(state.editMode)) {
    dismissInlineTextEditor();
  }
  if (state.editMode !== "insert-image") {
    clearImageInsertUi();
  }
  if (!isTextInputMode(state.editMode)) {
    clearPlacementSelection();
  }
  if (state.editMode !== "annotate") state.selectedCalloutId = null;
  syncEditModeUI();
  if (state.editMode === "sign" && previousMode !== "sign") {
    window.OpenPDFSign?.enterSignMode();
  }
  if (state.editMode === "redact" && previousMode !== "redact") {
    openRedactionPanel();
  } else if (previousMode === "redact" && els.propsPanel.dataset.panel === "redact" && !hasPendingRedaction(activeDoc())) {
    hidePropsPanel();
  }
  if (previousMode !== state.editMode && state.editMode && state.editMode !== "select") {
    setStatus(t("{tool}: {hint}", { tool: toolName(state.editMode) || t("Edit"), hint: toolHint(state.editMode) }));
  } else if (state.editMode === "select" && previousMode && previousMode !== "select") {
    setStatus(t("Ready"));
  }
  syncEditModeLayers();
  const doc = activeDoc();
  // look up form fields now, so the first click with a text tool doesn't wait
  if (doc && isTextInputMode()) ensureFormFieldsLoaded(doc);
  if (doc && previousMode && previousMode !== "select" && state.editMode === "select") {
    scheduleStalePageRefresh(doc);
  }
}

// English source marked with N_; toolName() / toolHint() translate them when shown.
const TOOL_NAMES = {
  select: N_("Select"),
  highlight: N_("Highlight"),
  "erase-highlight": N_("Erase highlight"),
  "replace-text": N_("Add text"),
  "cover-text": N_("Edit text"),
  annotate: N_("Comment"),
  sign: N_("Sign"),
  "insert-image": N_("Image"),
  redact: N_("Redact"),
};

const TOOL_HINTS = {
  highlight: N_("Drag across text"),
  "erase-highlight": N_("Drag across the highlight to remove"),
  "replace-text": N_("Click the page and type, Enter to confirm; drag a text box to move it, select it and press Delete to remove it"),
  "cover-text": N_("Click text on the page to change it, or drag out an area and type; when you save, what was there is removed and your text is written in its place"),
  annotate: N_("Hold the left button and drag out an arrow, then type your note; select it and press Delete to remove it"),
  sign: N_("Click the page to place the signature"),
  "insert-image": N_("Click the page to place the cursor, then press Ctrl+V to paste a picture; drag the corners to resize, Enter to confirm"),
  redact: N_("Drag over what to remove, or add words in the list; then apply the redaction"),
};

function toolName(mode) {
  return TOOL_NAMES[mode] ? t(TOOL_NAMES[mode]) : "";
}

function toolHint(mode) {
  if (mode === "highlight") return t(highlightShapeInfo().hint);
  return TOOL_HINTS[mode] ? t(TOOL_HINTS[mode]) : "";
}

// ---------------------------------------------------------------- highlight shapes

const HIGHLIGHT_SHAPES = [
  { id: "box", label: N_("Box"), hint: N_("Drag a box over what to highlight") },
  { id: "text", label: N_("Text"), hint: N_("Drag across text: only its lines are highlighted") },
  { id: "pen", label: N_("Pen"), hint: N_("Draw freely, like a highlighter pen") },
];
const HIGHLIGHT_PEN_WIDTHS = [6, 10, 14, 20, 28];

function storedSetting(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch (_) {
    return fallback;
  }
}

function storeSetting(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch (_) {
    /* private window: the choice lasts until the page is closed */
  }
}

function highlightShapeInfo() {
  if (!state.highlightShape) state.highlightShape = storedSetting("openpdf_highlight_shape", "box");
  return HIGHLIGHT_SHAPES.find((shape) => shape.id === state.highlightShape) || HIGHLIGHT_SHAPES[0];
}

function highlightPenWidth() {
  if (!state.highlightPenWidth) state.highlightPenWidth = Number(storedSetting("openpdf_highlight_pen", "14")) || 14;
  return state.highlightPenWidth;
}

function setHighlightShape(id) {
  const shape = HIGHLIGHT_SHAPES.find((item) => item.id === id) || HIGHLIGHT_SHAPES[0];
  state.highlightShape = shape.id;
  storeSetting("openpdf_highlight_shape", shape.id);
  syncToolHint();
  setStatus(t("Highlight shape: {shape}", { shape: t(shape.label) }), "ok");
}

/** H again while highlighting: the next shape. */
function cycleHighlightShape() {
  const at = HIGHLIGHT_SHAPES.indexOf(highlightShapeInfo());
  setHighlightShape(HIGHLIGHT_SHAPES[(at + 1) % HIGHLIGHT_SHAPES.length].id);
}

/** The bar at the top of the page area: what the current tool does, plus text style. */
function syncToolHint() {
  if (!els.toolHint) return;
  const doc = activeDoc();
  const mode = state.editMode;
  const show = !!doc && doc.contentView !== "text" && !!mode && mode !== "select";
  els.toolHint.classList.toggle("hidden", !show);
  els.toolHint.parentElement?.classList.toggle("has-hint", show);
  if (!show) return;
  els.toolHint.dataset.mode = mode;
  els.toolHintText.replaceChildren();
  const name = document.createElement("strong");
  name.textContent = toolName(mode);
  const hint = document.createElement("span");
  hint.textContent = toolHint(mode);
  els.toolHintText.append(name, hint);
  if (mode === "insert-image") {
    const paste = document.createElement("button");
    paste.type = "button";
    paste.className = "tool-hint-action";
    paste.textContent = t("Paste image");
    paste.addEventListener("click", () => actions.paste());
    els.toolHintText.append(paste);
  }
  if (mode === "sign") window.OpenPDFSign?.buildHint(els.toolHintText);
  if (mode === "highlight") {
    // a div: narrow windows hide the hint's spans, not these choices
    const group = document.createElement("div");
    group.className = "highlight-shapes";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", t("Highlight shape"));
    const current = highlightShapeInfo();
    for (const shape of HIGHLIGHT_SHAPES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tool-hint-action";
      btn.dataset.shape = shape.id;
      btn.textContent = t(shape.label);
      btn.title = `${t(shape.hint)} (H)`;
      btn.setAttribute("aria-pressed", String(shape === current));
      btn.addEventListener("click", () => setHighlightShape(shape.id));
      group.append(btn);
    }
    els.toolHintText.append(group);
    if (current.id === "pen") {
      const width = document.createElement("select");
      width.className = "highlight-pen-width";
      width.title = t("Pen width");
      width.setAttribute("aria-label", t("Pen width"));
      for (const w of HIGHLIGHT_PEN_WIDTHS) {
        const opt = document.createElement("option");
        opt.value = String(w);
        opt.textContent = `${w} pt`;
        width.append(opt);
      }
      width.value = String(highlightPenWidth());
      width.addEventListener("change", () => {
        state.highlightPenWidth = Number(width.value) || 14;
        storeSetting("openpdf_highlight_pen", state.highlightPenWidth);
      });
      els.toolHintText.append(width);
    }
  }
  if (mode === "redact") {
    const list = document.createElement("button");
    list.type = "button";
    list.className = "tool-hint-action";
    list.textContent = t("Words and apply…");
    list.addEventListener("click", () => openRedactionPanel());
    els.toolHintText.append(list);
  }
}

function isScrollViewMode() {
  return state.viewMode === "continuous" || state.viewMode === "grid";
}

function updateToolbarState() {
  const hasDoc = !!activeDoc();
  actionControls().forEach((btn) => {
    const action = btn.dataset.action;
    if (action === "undo" || action === "redo") return;
    const needsDoc = !["open", "merge", "fromImages", "settings"].includes(action);
    btn.disabled = needsDoc && !hasDoc;
  });
  document.querySelectorAll(".tool-btn.menu-btn").forEach((btn) => {
    btn.disabled = !hasDoc;
  });
  if (els.pageInput) els.pageInput.disabled = !hasDoc;
  updateUndoButtons();
  document.querySelectorAll(".tool-btn.tool-mode").forEach((btn) => {
    btn.disabled = !hasDoc;
  });
  els.prevPageBtn.disabled = !hasDoc;
  els.nextPageBtn.disabled = !hasDoc;
  els.zoomSelect.disabled = !hasDoc;
  els.zoomInBtn.disabled = !hasDoc;
  els.zoomOutBtn.disabled = !hasDoc;
  syncContentViewUI();
  syncTextStyleToolbar();
}

function renderTabs() {
  els.tabbar.querySelectorAll(".doc-tab").forEach((n) => n.remove());
  state.docs.forEach((doc) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = `doc-tab${doc.id === state.activeId ? " active" : ""}`;
    tab.dataset.id = doc.id;
    const dirty = isDocDirty(doc);
    tab.title = dirty ? t("{name} (unsaved changes)", { name: doc.name }) : doc.name;
    if (dirty) {
      const dot = document.createElement("span");
      dot.className = "tab-dirty";
      dot.textContent = "●";
      dot.setAttribute("aria-label", t("Unsaved"));
      tab.appendChild(dot);
    }
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = doc.name;
    tab.appendChild(title);
    const close = document.createElement("span");
    close.className = "tab-close";
    close.title = t("Close");
    close.setAttribute("role", "button");
    close.setAttribute("aria-label", t("Close “{name}”", { name: doc.name }));
    close.dataset.icon = "x";
    close.dataset.iconSize = "12";
    tab.appendChild(close);
    window.PdfIcons?.hydrate(tab);
    tab.addEventListener("click", (e) => {
      if (e.target.closest(".tab-close")) closeDoc(doc.id);
      else switchDoc(doc.id);
    });
    tab.addEventListener("auxclick", (e) => {
      if (e.button === 1) closeDoc(doc.id);
    });
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(doc.id === state.activeId));
    els.tabbar.insertBefore(tab, els.openTabBtn);
  });
  const active = activeDoc();
  // Window / browser title names the file being worked on.
  document.title = active ? `${active.name} - OpenPDF` : "OpenPDF";
  // With many files open the tab bar scrolls: keep the current tab in view.
  els.tabbar.querySelector(".doc-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  renderTabsMenu();
  syncFormsButton();
  window.OpenPDFSign?.renderBanner();
}

/** "All open files" list, shown when the tabs don't all fit. */
function renderTabsMenu() {
  const anchor = document.getElementById("tabsAll");
  const menu = document.getElementById("tabsMenu");
  if (!anchor || !menu) return;
  const overflowing = els.tabbar.scrollWidth > els.tabbar.clientWidth + 1;
  anchor.hidden = !overflowing;
  if (!overflowing) {
    menu.hidden = true;
    return;
  }
  const index = state.docs.findIndex((d) => d.id === state.activeId);
  document.getElementById("tabsCount").textContent = `${index + 1}/${state.docs.length}`;
  menu.replaceChildren();
  state.docs.forEach((doc) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `menu-item${doc.id === state.activeId ? " current" : ""}`;
    item.setAttribute("role", "menuitem");
    const mark = document.createElement("span");
    mark.className = "tab-mark";
    if (doc.id === state.activeId) {
      mark.dataset.icon = "check";
      mark.dataset.iconSize = "14";
    }
    const text = document.createElement("span");
    text.className = "menu-text";
    text.textContent = (isDocDirty(doc) ? "● " : "") + doc.name;
    item.title = doc.name;
    item.append(mark, text);
    item.addEventListener("click", () => {
      closeMenus();
      switchDoc(doc.id);
    });
    menu.appendChild(item);
  });
  window.PdfIcons?.hydrate(menu);
}

const PICTURE_NAME = /\.(jpe?g|png|tiff?|gif|bmp)$/i;

function isPicture(file) {
  return !!file && (/^image\/(jpeg|png|tiff|gif|bmp)$/.test(file.type || "") || PICTURE_NAME.test(file.name || ""));
}

/** Pictures (photos, scans) to a PDF, one page each, opened as a new document. */
async function openPictures(files) {
  const pictures = files.filter(isPicture).sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { numeric: true }));
  if (!pictures.length) {
    setStatus(t("Choose JPEG, PNG, TIFF, GIF or BMP pictures"), "error");
    return;
  }
  const ocrReady = await ocrInstalled();
  const data = await showToolDialog(
    tn(pictures.length, "PDF from {n} picture", "PDF from {n} pictures"),
    `<p class="field-hint">${t("One page per picture, in name order. The pictures keep their quality.")}</p>
     <label class="check-option"><input type="checkbox" data-field="ocr" ${ocrReady ? "checked" : "disabled"} /><span>${t("Recognize the text in the pictures (OCR), so it can be searched and copied")}</span></label>
     ${ocrReady ? "" : `<p class="field-hint">${t("Text recognition (OCR) is not installed; you can add it later with More tools → Recognize text in scans.")}</p>`}`
  );
  if (!data) return;
  const fd = new FormData();
  pictures.forEach((f) => fd.append("files", f));
  fd.append("ocr", data.ocr ? "true" : "false");
  fd.append("languages", "eng,chi_sim");
  const name = `${(pictures[0].name || "pictures").replace(/\.[^.]+$/, "")}.pdf`;
  try {
    setStatus(data.ocr ? t("Making the PDF and recognizing the text…") : t("Making the PDF…"));
    const { blob } = await apiPost("/v1/pdf/from-images", fd);
    await openFile(blobToFile(blob, name));
    setStatus(data.ocr ? t("PDF made from the pictures, with their text recognized") : t("PDF made from the pictures"), "ok");
  } catch (err) {
    setStatus(String(err.message || err), "error");
  }
}

function looksLikePdf(file) {
  if (!file) return false;
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name || "") || !file.type;
}

async function hasPdfHeader(file) {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  let text = "";
  for (const byte of head) text += String.fromCharCode(byte);
  return text.includes("%PDF-");
}

async function askForPassword(name, retry) {
  const data = await showToolDialog(
    t("Enter password"),
    `<p class="field-hint">${retry ? `${t("Wrong password. Please try again.")} ` : ""}${t("“{name}” is encrypted and needs a password to open.", { name: escapeHtml(name) })}</p>
     <label>${t("Password")}</label><input data-field="password" type="password" required autocomplete="off" />`
  );
  return data?.password || null;
}

/** Ask for the password, then open a decrypted copy (the encrypted original is never overwritten). */
async function openEncryptedPdf(file) {
  let retry = false;
  for (;;) {
    const password = await askForPassword(file.name || "PDF", retry);
    if (!password) return null;
    try {
      const probe = await loadPdfDocument(file, { password });
      await probe.destroy();
    } catch (err) {
      if (err?.name === "PasswordException") {
        retry = true;
        continue;
      }
      throw err;
    }
    const fd = new FormData();
    fd.append("file", file);
    fd.append("password", password);
    const { blob } = await apiPost("/v1/pdf/unlock", fd);
    return { blob, pdfDoc: await loadPdfDocument(blob) };
  }
}

async function openFile(file, options = {}) {
  if (isPicture(file)) {
    await openPictures([file]);
    return;
  }
  if (!looksLikePdf(file)) {
    setStatus(t("Please choose a PDF file"), "error");
    return;
  }
  let name = file.name || "document.pdf";
  let blob = file;
  let fileHandle = options.fileHandle || null;
  let pdfDoc = null;
  let unlocked = false;
  setStatus(t("Opening “{name}”…", { name }));
  const openT0 = performance.now();
  const pickMs = state._pickStartedAt ? Math.round(openT0 - state._pickStartedAt) : null;
  state._pickStartedAt = null;
  let parsedAt = openT0;
  try {
    if (!(await hasPdfHeader(file))) throw new Error("not a pdf");
    pdfDoc = await loadPdfDocument(file);
    parsedAt = performance.now();
  } catch (err) {
    if (err?.name !== "PasswordException") {
      setStatus(t("Can't open “{name}”: the file is damaged or isn't a valid PDF", { name }), "error");
      return;
    }
    try {
      const decrypted = await openEncryptedPdf(file);
      if (!decrypted) {
        setStatus(t("Opening the encrypted file was canceled"));
        return;
      }
      ({ blob, pdfDoc } = decrypted);
      name = `${name.replace(/\.pdf$/i, "")}-unlocked.pdf`;
      fileHandle = null;
      unlocked = true;
    } catch (unlockErr) {
      setStatus(t("Can't open “{name}”: {error}", { name, error: unlockErr.message || unlockErr }), "error");
      return;
    }
  }

  const doc = trackDirtyFlags({
    id: crypto.randomUUID(),
    name,
    file: blobToFile(blob, name),
    blob,
    fileHandle,
    pdfDoc,
    pdfFingerprint: null,
    pageNum: 1,
    pageCount: pdfDoc.numPages,
    dirty: false,
    documentId: null,
    contentView: "pdf",
    extractedText: null,
    formFields: null,
    placedTexts: [],
    placementsDirty: false,
    callouts: [],
    calloutsDirty: false,
    stalePages: null,
    renderedPageRevision: {},
    serverRevision: null,
    pdfEtag: null,
    undoStack: [],
    redoStack: [],
    searchIndex: null,
    _editorSnapshot: null,
    _mutationTail: null,
    _pendingMutations: 0,
    _syncTimer: null,
    _syncPromise: null,
    _blobSyncPromise: null,
    _pdfReloadTimer: null,
  });
  // Upload once, right away, so the first edit does not wait for it.
  doc._registerPromise = registerDocument(doc);
  doc._registerPromise.catch((err) => setStatus(String(err.message || err), "error"));

  state.docs.push(doc);
  state.activeId = doc.id;
  state.editMode = "select";
  renderTabs();
  updateToolbarState();
  hidePropsPanel();
  await refreshViewer({ scrollAnchor: { pageNum: 1, offsetY: 0, scrollTop: 0, thumbTop: 0 } });
  // one line per open, so slow opens can be traced (desktop: printed to the terminal)
  console.info(
    `[openpdf] open ${name} at ${Date.now()}: ${pickMs != null ? `dialog ${pickMs}ms, ` : ""}parse ${Math.round(parsedAt - openT0)}ms, first page ${Math.round(performance.now() - openT0)}ms`
  );
  setEditMode("select");
  updateUndoButtons();
  setStatus(
    unlocked
      ? t("Opened “{name}” (decrypted; saving creates a new file without a password)", { name })
      : t("Opened “{name}”", { name }),
    "ok"
  );
  rememberRecent(doc);
  try {
    await doc._registerPromise;
    doc.pdfFingerprint = await fingerprintBlob(doc.blob);
    await loadPlacementsFromPdf(doc);
    if (activeDoc() === doc) {
      renderPlacedTextOverlays({ force: true });
      renderCalloutOverlays();
    }
    window.OpenPDFSign?.onDocOpened(doc);
  } catch (_) {
    /* status already shows the connection problem */
  }
}

async function closeDoc(id) {
  const idx = state.docs.findIndex((d) => d.id === id);
  if (idx === -1) return;
  const doc = state.docs[idx];
  if (
    isDocDirty(doc) &&
    !window.confirm(t("“{name}” has unsaved changes. If you close it, they will be lost. Close anyway?", { name: doc.name }))
  ) {
    return;
  }
  state.docs.splice(idx, 1);
  if (state.activeId === id) {
    state.activeId = state.docs[idx]?.id || state.docs[idx - 1]?.id || null;
  }
  destroyPdfDocument(doc);
  Promise.resolve(doc._registerPromise)
    .catch(() => {})
    .then(() => waitForDocMutations(doc))
    .then(() => {
      if (doc.documentId) return apiFetch(`/v1/pdf/document/${doc.documentId}`, { method: "DELETE" });
      return null;
    })
    .catch(() => {});
  renderTabs();
  updateToolbarState();
  updateUndoButtons();
  if (state.activeId) {
    refreshViewer();
    setEditMode("select");
  } else {
    state.editMode = null;
    syncEditModeUI();
    showWelcome();
  }
}

function switchDoc(id) {
  if (id === state.activeId) return;
  const leaving = activeDoc();
  if (leaving) leaving._scrollAnchor = captureScrollAnchor();
  state.activeId = id;
  renderTabs();
  updateUndoButtons();
  closeFindBar();
  hideSelectionToolbar();
  hidePropsPanel();
  const doc = activeDoc();
  applyDocContentView(doc);
  if (!doc || doc.contentView !== "text") {
    // each tab comes back where it was left
    refreshViewer({ scrollAnchor: doc?._scrollAnchor || { pageNum: 1, offsetY: 0, scrollTop: 0, thumbTop: 0 } });
    setEditMode("select");
  }
}

function showWelcome() {
  state.editMode = null;
  syncEditModeUI();
  els.welcome.classList.remove("hidden");
  els.viewerScroll.classList.add("hidden");
  els.textPanel.classList.add("hidden");
  els.thumbnails.innerHTML = "";
  els.pageIndicator.textContent = "/ —";
  if (els.pageInput) els.pageInput.value = "";
  if (els.pageCountLabel) els.pageCountLabel.textContent = "";
  setStatus(t("Ready"));
}

function syncContentViewUI() {
  document.querySelectorAll(".tool-toggle").forEach((btn) => {
    const doc = activeDoc();
    const active = !!doc && doc.contentView === "text";
    btn.classList.toggle("active", active);
  });
}

function showTextView(doc, text) {
  if (doc) {
    doc.contentView = "text";
    if (text != null) doc.extractedText = text;
  }
  if (state.editMode) {
    state.editMode = null;
    state.pendingSignImage = null;
    syncEditModeUI();
    syncEditModeLayers();
  }
  els.welcome.classList.add("hidden");
  els.viewerScroll.classList.add("hidden");
  els.textPanel.classList.remove("hidden");
  if (text != null) els.textPanel.value = text;
  syncContentViewUI();
  syncTextLayers();
}

function showPdfView(doc) {
  if (doc) doc.contentView = "pdf";
  els.textPanel.classList.add("hidden");
  els.viewerScroll.classList.remove("hidden");
  if (doc) els.welcome.classList.add("hidden");
  syncContentViewUI();
  if (doc) setEditMode("select");
  else syncTextStyleToolbar();
}

function hideTextPanel() {
  showPdfView(activeDoc());
}

function applyDocContentView(doc) {
  if (!doc) return;
  if (doc.contentView === "text" && doc.extractedText != null) {
    showTextView(doc, doc.extractedText);
  } else {
    showPdfView(doc);
  }
}

function captureScrollAnchor() {
  const scrollTop = els.viewerScroll.scrollTop;
  const shells = [...els.viewerPages.querySelectorAll(".page-shell")];
  const doc = activeDoc();
  if (!shells.length) {
    return {
      pageNum: doc?.pageNum ?? 1,
      offsetY: 0,
      scrollTop,
      thumbTop: els.thumbnails.scrollTop,
    };
  }
  let pageNum = Number(shells[0].dataset.page);
  let offsetY = scrollTop;
  for (const shell of shells) {
    const top = shell.offsetTop;
    if (top <= scrollTop + 8) {
      pageNum = Number(shell.dataset.page);
      offsetY = scrollTop - top;
    } else {
      break;
    }
  }
  return { pageNum, offsetY, scrollTop, thumbTop: els.thumbnails.scrollTop };
}

function restoreScrollAnchor(anchor) {
  if (!anchor) return;
  let attempts = 0;
  const apply = () => {
    attempts += 1;
    const shell = els.viewerPages.querySelector(`.page-shell[data-page="${anchor.pageNum}"]`);
    let target = shell ? shell.offsetTop + anchor.offsetY : anchor.scrollTop;
    if (anchor.pageNum === 1 && anchor.offsetY <= 0) target = 0;
    els.viewerScroll.scrollTop = target;
    els.viewerScroll.scrollLeft = 0;
    els.thumbnails.scrollTop = anchor.thumbTop;
    const thumb = els.thumbnails.children[anchor.pageNum - 1];
    thumb?.scrollIntoView({ block: "nearest" });
    if (attempts < 10 && Math.abs(els.viewerScroll.scrollTop - target) > 2) {
      requestAnimationFrame(apply);
    }
  };
  requestAnimationFrame(apply);
}

function updatePageIndicator() {
  const doc = activeDoc();
  if (!doc) return;
  els.pageIndicator.textContent = `/ ${doc.pageCount}`;
  if (els.pageInput && document.activeElement !== els.pageInput) els.pageInput.value = String(doc.pageNum);
  if (els.pageCountLabel) els.pageCountLabel.textContent = String(doc.pageCount);
  els.thumbnails.querySelectorAll(".thumb").forEach((thumb, idx) => {
    thumb.classList.toggle("active", idx + 1 === doc.pageNum);
  });
}

function scrollToPage(pageNum, { smooth = false } = {}) {
  const shell = els.viewerPages.querySelector(`.page-shell[data-page="${pageNum}"]`);
  if (!shell) return;
  const top = Math.max(0, shell.offsetTop - 12);
  if (smooth) {
    els.viewerScroll.scrollTo({ top, behavior: "smooth" });
  } else {
    els.viewerScroll.scrollTop = top;
  }
}

function goToPage(pageNum, options = {}) {
  const doc = activeDoc();
  if (!doc) return;
  doc.pageNum = Math.max(1, Math.min(doc.pageCount, pageNum));
  if (isScrollViewMode() && !options.forceRefresh) {
    updatePageIndicator();
    if (!options.skipScroll) scrollToPage(doc.pageNum, { smooth: options.smooth });
    return;
  }
  refreshViewer({ scrollAnchor: options.scrollAnchor ?? captureScrollAnchor() });
}

function syncPageFromScroll() {
  const doc = activeDoc();
  if (!doc || !isScrollViewMode()) return;
  const probe = els.viewerScroll.scrollTop + els.viewerScroll.clientHeight * 0.15;
  const shells = [...els.viewerPages.querySelectorAll(".page-shell")];
  for (const shell of shells) {
    const top = shell.offsetTop;
    const bottom = top + shell.offsetHeight;
    if (bottom > probe) {
      const pageNum = Number(shell.dataset.page);
      if (pageNum !== doc.pageNum) {
        doc.pageNum = pageNum;
        updatePageIndicator();
      }
      break;
    }
  }
}

/** The session copy changed as a whole (page tools, OCR, undo...): download and redraw. */
async function reloadWholeDocument(doc, options = {}) {
  const anchor = options.scrollAnchor ?? (activeDoc() === doc ? captureScrollAnchor() : null);
  const blob = await withDocSession(doc, () => downloadDocumentBlob(doc));
  doc.file = blobToFile(blob, doc.name);
  await reloadPdfDocIfChanged(doc, blob);
  if (doc.pageNum > doc.pageCount) doc.pageNum = Math.max(1, doc.pageCount);
  doc.formFields = null;
  doc.extractedText = null;
  doc.searchIndex = null;
  doc.stalePages?.clear();
  doc.renderedPageRevision = {};
  renderTabs();
  if (activeDoc() !== doc) return;
  clearFormOverlays();
  clearImageInsertUi();
  if (doc.contentView !== "pdf") showPdfView(doc);
  await refreshViewer({ scrollAnchor: anchor });
  if (state.find.open) runFind({ keepIndex: true });
}

/**
 * Run a whole-document tool on the session copy (rotate, delete/reorder
 * pages, OCR, unlock, flatten), record it for undo and redraw.
 *
 * `rename` gives the edited document a new name; `detachFile` stops Ctrl+S
 * from overwriting the original file with what is now a different document.
 */
async function runDocumentOperation(doc, { label, endpoint, fields = {}, rename = null, detachFile = false, editorTransform = null }) {
  setStatus(t("{step}…", { step: stepLabel(label) }));
  setBusy(true, stepLabel(label));
  const editorBefore = serializeEditorObjects(doc);
  let result;
  try {
    result = await queueDocMutation(doc, () => {
      const fd = new FormData();
      appendDocToForm(fd, doc);
      for (const [key, value] of Object.entries(fields)) fd.append(key, String(value));
      return apiPost(endpoint, fd);
    });
  } finally {
    setBusy(false);
  }
  checkpointEditorObjects(doc);
  if (editorTransform) {
    editorTransform(doc);
    doc.placementsDirty = true;
  }
  const editorAfter = serializeEditorObjects(doc);
  doc._editorSnapshot = editorAfter;
  const renameInfo = rename ? { before: doc.name, after: rename, handle: doc.fileHandle, detach: detachFile } : null;
  if (rename) doc.name = rename;
  if (detachFile) doc.fileHandle = null;
  doc.dirty = true;
  pushUndo(doc, {
    type: "server",
    label,
    before: result.previous_revision,
    after: result.revision,
    pages: null,
    editorBefore,
    editorAfter,
    rename: renameInfo,
  });
  await reloadWholeDocument(doc);
  return result;
}

function parsePageRange(text, count) {
  const pages = [];
  const seen = new Set();
  for (const part of String(text || "").replace(/\s+/g, "").split(",")) {
    if (!part) continue;
    const match = part.match(/^(\d+)(?:-(\d*))?$/);
    if (!match) throw new Error(t("Invalid page numbers: {part} (for example 1-3,5,8-)", { part }));
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : match[2] === "" ? count : Number(match[2]);
    if (start < 1 || end < start || end > count) {
      throw new Error(tn(count, "Page numbers out of range: {part} (the document has {n} page)", "Page numbers out of range: {part} (the document has {n} pages)", { part }));
    }
    for (let p = start; p <= end; p += 1) {
      if (!seen.has(p)) {
        seen.add(p);
        pages.push(p);
      }
    }
  }
  if (!pages.length) throw new Error(t("Please enter page numbers"));
  return pages;
}

async function visualPageSizes(doc, pageNums) {
  const sizes = new Map();
  for (const pageNum of pageNums) {
    const page = await doc.pdfDoc.getPage(pageNum);
    const vp = page.getViewport({ scale: 1 });
    sizes.set(pageNum - 1, { width: vp.width, height: vp.height });
  }
  return sizes;
}

function rotatePointClockwise(x, y, width, height, angle) {
  if (angle === 90) return [height - y, x];
  if (angle === 180) return [width - x, height - y];
  if (angle === 270) return [y, width - x];
  return [x, y];
}

/** Keep text boxes and callouts on the same spot of the page after it turns. */
function rotateEditorObjects(doc, sizes, angle) {
  const moveBox = (item, size) => {
    const [cx, cy] = rotatePointClockwise(
      item.x + item.width / 2,
      item.y + item.height / 2,
      size.width,
      size.height,
      angle
    );
    return { ...item, x: cx - item.width / 2, y: cy - item.height / 2 };
  };
  doc.placedTexts = (doc.placedTexts || []).map((item) =>
    sizes.has(item.pageIndex) ? moveBox(item, sizes.get(item.pageIndex)) : item
  );
  doc.callouts = (doc.callouts || []).map((item) => {
    const size = sizes.get(item.pageIndex);
    if (!size) return item;
    const moved = moveBox(item, size);
    const [anchorX, anchorY] = rotatePointClockwise(item.anchorX, item.anchorY, size.width, size.height, angle);
    return { ...moved, anchorX, anchorY };
  });
}

/** Text boxes follow their page when pages are deleted or moved. */
function remapEditorObjectPages(doc, order) {
  const newIndex = new Map(order.map((oldPage, i) => [oldPage - 1, i]));
  const remap = (list) =>
    (list || [])
      .filter((item) => newIndex.has(item.pageIndex))
      .map((item) => ({ ...item, pageIndex: newIndex.get(item.pageIndex) }));
  doc.placedTexts = remap(doc.placedTexts);
  doc.callouts = remap(doc.callouts);
}

async function rotatePages(doc, pageNums, angle) {
  const sizes = await visualPageSizes(doc, pageNums);
  const all = pageNums.length === doc.pageCount;
  const label = all
    ? () => t("Rotate all pages {angle}°", { angle })
    : () => tn(pageNums.length, "Rotate page {pages}", "Rotate pages {pages}", { pages: pageNums.join(",") });
  await runDocumentOperation(doc, {
    label,
    endpoint: "/v1/pdf/rotate",
    fields: { angle, pages: all ? "" : pageNums.join(",") },
    editorTransform: (d) => rotateEditorObjects(d, sizes, angle),
  });
  setStatus(t("{step}: done", { step: stepLabel(label) }), "ok");
}

async function applyPageOrder(doc, order, label) {
  if (!order.length) throw new Error(t("You can't delete every page"));
  await runDocumentOperation(doc, {
    label,
    endpoint: "/v1/pdf/pages",
    fields: { order: order.join(",") },
    editorTransform: (d) => remapEditorObjectPages(d, order),
  });
  setStatus(t("{step}: done", { step: stepLabel(label) }), "ok");
}

async function deletePages(doc, pageNums) {
  const drop = new Set(pageNums);
  const order = [];
  for (let p = 1; p <= doc.pageCount; p += 1) if (!drop.has(p)) order.push(p);
  await applyPageOrder(
    doc,
    order,
    pageNums.length === 1
      ? () => t("Delete page {page}", { page: pageNums[0] })
      : () => tn(pageNums.length, "Delete {n} page", "Delete {n} pages")
  );
}

async function movePage(doc, fromPage, toPage) {
  if (fromPage === toPage) return;
  const order = [];
  for (let p = 1; p <= doc.pageCount; p += 1) order.push(p);
  order.splice(fromPage - 1, 1);
  order.splice(toPage - 1, 0, fromPage);
  await applyPageOrder(doc, order, () => t("Move page {from} to page {to}", { from: fromPage, to: toPage }));
  doc.pageNum = toPage;
}

function bindPageShellEvents(shell, pageNum) {
  shell.onclick = (ev) => {
    if (isEditToolMode()) return;
    if (ev.target.closest(".textLayer span")) return;
    if (isSelectMode() && window.getSelection()?.toString()?.trim()) return;
    goToPage(pageNum, { skipScroll: isScrollViewMode() });
  };
  shell.oncontextmenu = (ev) => {
    if (state.inlineTextEditor || ev.target.closest(".placed-text-overlay, .callout-overlay")) return;
    ev.preventDefault();
    openPageContextMenu(ev, pageNum);
  };
}

async function patchPageRender(pageNum) {
  const doc = activeDoc();
  // the PDF may be in the middle of being reloaded (or the tab just closed)
  if (!doc?.pdfDoc) return false;
  const shell = els.viewerPages.querySelector(`.page-shell[data-page="${pageNum}"]`);
  if (!shell) return false;

  const page = await doc.pdfDoc.getPage(pageNum);
  const baseScale = state.fitWidth ? 1 : state.zoom * 1.2;
  const scale = scaleForView(page, baseScale);
  const { canvas, viewport } = await renderPageCanvas(page, scale);
  shell.dataset.scale = String(scale);
  shell.dataset.pageIndex = String(pageNum - 1);
  shell.dataset.rendered = "true";
  sizeShell(shell, viewport);
  delete shell.dataset.rasterPreview;
  shell.replaceChildren(canvas);
  await appendPageTextLayer(shell, page, viewport);
  bindPageShellEvents(shell, pageNum);
  if (state.editMode) {
    shell.classList.add("selectable");
    attachRegionSelect(shell, { scale, pageIndex: pageNum - 1, viewport });
  }
  if (doc.formFields?.length && els.propsPanel.classList.contains("open")) {
    renderFormOverlays(doc.formFields);
  }
  doc.stalePages?.delete(pageNum);
  markPageRendered(doc, pageNum);
  renderPlacedTextOverlays();
  renderCalloutOverlays();
  syncTextLayers();
  renderSearchHits(shell);
  return true;
}

function sizeShell(shell, viewport) {
  if (state.viewMode === "grid") {
    shell.style.width = "";
    shell.style.height = "";
    shell.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
  } else {
    shell.style.aspectRatio = "";
    shell.style.width = `${viewport.width}px`;
    shell.style.height = `${viewport.height}px`;
  }
}

function scaleForView(page, baseScale) {
  let scale = baseScale;
  if (state.fitWidth) {
    // Fill the window, but never wider than a comfortable reading width.
    const shellWidth = Math.min(els.viewerScroll.clientWidth - 48, 1000);
    const viewport = page.getViewport({ scale: 1 });
    scale = (shellWidth / viewport.width) * baseScale;
  }
  if (state.viewMode === "grid") scale *= 0.42;
  if (state.viewMode === "two-page") scale *= 0.82;
  return scale;
}

// Saving also draws the text boxes and comments into the pages, in the layer
// "OpenPDF edits", so other readers show and print them (EditsLayer.java).
// OpenPDF draws them itself, editable, from the copy kept in the metadata; it
// hides that layer then, or they would show twice. A file whose metadata copy
// was lost (another program rewrote it) keeps the layer visible.
const EDITS_LAYER_NAME = "OpenPDF edits";

function hasStoredEditorObjects(raw) {
  if (!raw) return false;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.length > 0 : !!(value?.placements?.length || value?.callouts?.length);
  } catch (_) {
    return false;
  }
}

function editsLayerHidden(pdfDoc) {
  if (!pdfDoc) return Promise.resolve(null);
  if (!pdfDoc._openpdfEditsLayer) {
    pdfDoc._openpdfEditsLayer = (async () => {
      const meta = await pdfDoc.getMetadata();
      if (!hasStoredEditorObjects(meta?.info?.Custom?.PdfGatewayPlacements)) return null;
      const config = await pdfDoc.getOptionalContentConfig();
      let found = false;
      for (const [id, group] of Object.entries(config.getGroups() || {})) {
        if (group?.name === EDITS_LAYER_NAME) {
          config.setVisibility(id, false);
          found = true;
        }
      }
      return found ? config : null;
    })().catch(() => null);
  }
  return pdfDoc._openpdfEditsLayer;
}

/** Render at the screen's pixel density so text stays sharp on HiDPI displays. */
async function renderPageCanvas(page, scale, { cssSize = true, annotationMode, pdfDoc } = {}) {
  const optionalContent = await editsLayerHidden(pdfDoc || activeDoc()?.pdfDoc);
  const viewport = page.getViewport({ scale });
  let ratio = Math.min(window.devicePixelRatio || 1, 2);
  const area = viewport.width * viewport.height * ratio * ratio;
  if (area > MAX_CANVAS_PIXELS) ratio *= Math.sqrt(MAX_CANVAS_PIXELS / area);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
  canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
  if (cssSize && state.viewMode !== "grid") {
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
  }
  await page.render({
    canvasContext: canvas.getContext("2d"),
    viewport,
    transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
    ...(annotationMode != null ? { annotationMode } : {}),
    ...(optionalContent ? { optionalContentConfigPromise: Promise.resolve(optionalContent) } : {}),
  }).promise;
  return { canvas, viewport, scale };
}

async function appendPageTextLayer(shell, page, viewport) {
  const textLayerDiv = document.createElement("div");
  textLayerDiv.className = shouldShowTextLayer() ? "textLayer" : "textLayer hidden";
  shell.appendChild(textLayerDiv);
  await renderPageTextLayer(page, viewport, textLayerDiv);
}

function canvasToPdfRect(shell, x0, y0, x1, y1, meta) {
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);
  const pdfX = left / meta.scale;
  const pdfY = top / meta.scale;
  const pdfW = width / meta.scale;
  const pdfH = height / meta.scale;
  return { x: pdfX, y: pdfY, width: pdfW, height: pdfH, pageIndex: meta.pageIndex };
}

function canvasToPdfPoint(x, y, meta) {
  return { x: x / meta.scale, y: y / meta.scale, pageIndex: meta.pageIndex };
}

const CALLOUT_COLOR_DEFAULTS = {
  editBackground: "#ffffff",
  editColor: "#1e293b",
  idleBackground: "#ffffff",
  idleColor: "#1e293b",
};

function calloutEdgePoint(anchorX, anchorY, boxLeft, boxTop, boxWidth, boxHeight) {
  const cx = boxLeft + boxWidth / 2;
  const cy = boxTop + boxHeight / 2;
  const dx = anchorX - cx;
  const dy = anchorY - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: boxTop };
  const scaleX = dx !== 0 ? boxWidth / 2 / Math.abs(dx) : Infinity;
  const scaleY = dy !== 0 ? boxHeight / 2 / Math.abs(dy) : Infinity;
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function defaultCalloutPixelSize(scale) {
  const font = state.textFontSize * (scale || 1);
  return {
    width: Math.max(148, font * 8),
    height: Math.max(font * 2.6, 40),
  };
}

const CALLOUT_MIN_DRAG = 12;

function layoutCalloutFromDrag(anchorX, anchorY, pointerX, pointerY, boxW, boxH) {
  let dx = pointerX - anchorX;
  let dy = pointerY - anchorY;
  if (Math.hypot(dx, dy) < CALLOUT_MIN_DRAG) {
    dx = 84;
    dy = -56;
  }
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const reach = Math.abs(ux) * (boxW / 2) + Math.abs(uy) * (boxH / 2);
  const minCenter = reach + 36;
  const centerDist = Math.max(len, minCenter);
  const cx = anchorX + ux * centerDist;
  const cy = anchorY + uy * centerDist;
  return {
    left: cx - boxW / 2,
    top: cy - boxH / 2,
    width: boxW,
    height: boxH,
  };
}

function clearCalloutOverlays() {
  if (!els.viewerPages) return;
  els.viewerPages
    .querySelectorAll(
      ".callout-line-svg, .callout-overlay, .callout-anchor-handle, .callout-preview-svg, .callout-box-preview, [data-callout-id]"
    )
    .forEach((node) => node.remove());
}

function rememberCallout(region, text, fontSize, anchor, calloutId = null) {
  const doc = activeDoc();
  if (!doc) return null;
  if (!doc.callouts) doc.callouts = [];
  const existing = calloutId ? doc.callouts.find((item) => item.id === calloutId) : null;
  const entry = {
    id: calloutId || crypto.randomUUID(),
    pageIndex: region.pageIndex,
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
    text,
    fontSize,
    fontFamily: existing?.fontFamily || state.textFontFamily || "Helvetica",
    anchorX: anchor.x,
    anchorY: anchor.y,
  };
  if (existing?.colors) entry.colors = existing.colors;
  if (existing) {
    const idx = doc.callouts.findIndex((item) => item.id === calloutId);
    doc.callouts[idx] = entry;
  } else {
    doc.callouts.push(entry);
  }
  doc.calloutsDirty = true;
  doc.placementsDirty = true;
  doc.dirty = true;
  return entry;
}

function calloutById(calloutId) {
  return activeDoc()?.callouts?.find((item) => item.id === calloutId) || null;
}

function deleteCallout(calloutId, statusMessage = t("Comment deleted")) {
  const doc = activeDoc();
  if (!doc?.callouts) return;
  doc.callouts = doc.callouts.filter((item) => item.id !== calloutId);
  if (state.selectedCalloutId === calloutId) state.selectedCalloutId = null;
  doc.dirty = true;
  doc.placementsDirty = true;
  renderCalloutOverlays();
  if (statusMessage) setStatus(statusMessage, "ok");
}

function updateCalloutFields(calloutId, patch) {
  const doc = activeDoc();
  const callout = calloutById(calloutId);
  if (!doc || !callout) return;
  Object.assign(callout, patch);
  doc.dirty = true;
  doc.placementsDirty = true;
  renderCalloutOverlays();
}

function effectiveCalloutColor(callout, key) {
  return callout.colors?.[key] || CALLOUT_COLOR_DEFAULTS[key];
}

function applyCalloutColors(el, callout, editable) {
  const colors = callout.colors || {};
  const background = editable
    ? colors.editBackground || CALLOUT_COLOR_DEFAULTS.editBackground
    : colors.idleBackground || CALLOUT_COLOR_DEFAULTS.idleBackground;
  const color = editable
    ? colors.editColor || CALLOUT_COLOR_DEFAULTS.editColor
    : colors.idleColor || CALLOUT_COLOR_DEFAULTS.idleColor;
  el.style.background = background;
  el.style.color = color;
}

function selectCallout(calloutId) {
  state.selectedCalloutId = calloutId;
  state.selectedPlacementId = null;
  els.viewerPages.querySelectorAll(".callout-overlay").forEach((el) => {
    el.classList.toggle("selected", el.dataset.calloutId === calloutId);
  });
  els.viewerPages.querySelectorAll(".placed-text-overlay.selected").forEach((el) => {
    el.classList.remove("selected");
  });
}

function setCalloutColor(calloutId, key, value) {
  const doc = activeDoc();
  const callout = calloutById(calloutId);
  if (!doc || !callout) return;
  const next = { ...(callout.colors || {}) };
  if (value === CALLOUT_COLOR_DEFAULTS[key]) delete next[key];
  else next[key] = value;
  if (Object.keys(next).length) callout.colors = next;
  else delete callout.colors;
  doc.dirty = true;
  doc.placementsDirty = true;
  renderCalloutOverlays();
}

function openCalloutPropertyMenu(calloutId, x, y) {
  const callout = calloutById(calloutId);
  if (!callout) return;
  closePlacementColorMenu();
  const menu = document.createElement("div");
  menu.id = "placementColorMenu";
  menu.className = "placement-color-menu";
  menu.addEventListener("contextmenu", (ev) => ev.preventDefault());
  menu.addEventListener("mousedown", (ev) => ev.stopPropagation());

  const title = document.createElement("p");
  title.className = "placement-color-title";
  title.textContent = t("Comment");
  menu.appendChild(title);

  const appendHeading = (text) => {
    const head = document.createElement("p");
    head.className = "placement-color-heading";
    head.textContent = text;
    menu.appendChild(head);
  };
  const appendNumberRow = (labelText, value, min, max, onCommit) => {
    const row = document.createElement("div");
    row.className = "placement-color-row";
    const label = document.createElement("span");
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.step = "1";
    input.value = String(Math.round(Number(value) * 10) / 10);
    const commit = () => {
      const next = clampPlacementNumber(input.value, min, max);
      if (next == null) return;
      input.value = String(next);
      onCommit(next);
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        commit();
      }
    });
    row.append(label, input);
    menu.appendChild(row);
  };

  appendHeading(t("Callout box"));
  appendNumberRow(t("Width"), callout.width, 24, 2000, (width) => updateCalloutFields(calloutId, { width }));
  appendNumberRow(t("Height"), callout.height, 16, 2000, (height) => updateCalloutFields(calloutId, { height }));
  appendHeading(t("Text"));
  appendNumberRow(t("Font size"), callout.fontSize || state.textFontSize, 6, 96, (fontSize) => {
    updateCalloutFields(calloutId, { fontSize });
  });

  const familyRow = document.createElement("div");
  familyRow.className = "placement-color-row";
  const familyLabel = document.createElement("span");
  familyLabel.textContent = t("Font");
  const family = document.createElement("select");
  const currentFamily = callout.fontFamily || state.textFontFamily || "Helvetica";
  for (const opt of els.textFontFamilySelect ? [...els.textFontFamilySelect.options] : []) {
    const node = document.createElement("option");
    node.value = opt.value;
    node.textContent = opt.textContent;
    family.appendChild(node);
  }
  if (![...family.options].some((opt) => opt.value === currentFamily)) {
    const extra = document.createElement("option");
    extra.value = currentFamily;
    extra.textContent = fontFamilyLabel(currentFamily);
    family.appendChild(extra);
  }
  family.value = currentFamily;
  family.addEventListener("change", () => updateCalloutFields(calloutId, { fontFamily: family.value }));
  familyRow.append(familyLabel, family);
  menu.appendChild(familyRow);

  const appendColor = (heading, backgroundKey, colorKey) => {
    appendHeading(heading);
    const bgRow = document.createElement("div");
    bgRow.className = "placement-color-row";
    const bgLabel = document.createElement("span");
    bgLabel.textContent = t("Background");
    const bgInput = document.createElement("input");
    bgInput.type = "color";
    const bgValue = effectiveCalloutColor(callout, backgroundKey);
    const bgClear = bgValue === "transparent";
    bgInput.value = bgClear ? "#ffffff" : bgValue;
    bgInput.disabled = bgClear;
    bgInput.addEventListener("input", () => setCalloutColor(calloutId, backgroundKey, bgInput.value));
    const clearLabel = document.createElement("label");
    clearLabel.className = "placement-color-clear";
    const clearBox = document.createElement("input");
    clearBox.type = "checkbox";
    clearBox.checked = bgClear;
    clearBox.addEventListener("change", () => {
      bgInput.disabled = clearBox.checked;
      setCalloutColor(calloutId, backgroundKey, clearBox.checked ? "transparent" : bgInput.value);
    });
    clearLabel.append(clearBox, document.createTextNode(t("Transparent")));
    bgRow.append(bgLabel, bgInput, clearLabel);
    menu.appendChild(bgRow);

    const fgRow = document.createElement("div");
    fgRow.className = "placement-color-row";
    const fgLabel = document.createElement("span");
    fgLabel.textContent = t("Text color");
    const fgInput = document.createElement("input");
    fgInput.type = "color";
    fgInput.value = effectiveCalloutColor(callout, colorKey);
    fgInput.addEventListener("input", () => setCalloutColor(calloutId, colorKey, fgInput.value));
    fgRow.append(fgLabel, fgInput);
    menu.appendChild(fgRow);
  };
  appendColor(t("While the tool is on"), "editBackground", "editColor");
  appendColor(t("After the tool is off"), "idleBackground", "idleColor");

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "ghost-btn placement-color-reset";
  reset.textContent = t("Reset to default colors");
  reset.addEventListener("click", () => {
    const current = calloutById(calloutId);
    if (current) delete current.colors;
    const doc = activeDoc();
    if (doc) {
      doc.dirty = true;
      doc.placementsDirty = true;
    }
    renderCalloutOverlays();
    openCalloutPropertyMenu(calloutId, x, y);
  });
  menu.appendChild(reset);
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;

  const onKey = (ev) => {
    if (ev.key !== "Escape") return;
    closePlacementColorMenu();
  };
  const onPointer = (ev) => {
    if (menu.isConnected && (menu.contains(ev.target) || menu.contains(document.activeElement))) return;
    closePlacementColorMenu();
  };
  placementColorMenuCloser = () => {
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("pointerdown", onPointer, true);
  };
  document.addEventListener("keydown", onKey);
  setTimeout(() => document.addEventListener("pointerdown", onPointer, true), 0);
}

function renderCalloutOverlays() {
  window.OpenPDFSign?.renderOverlays();
  renderRedactionMarks();
  renderRedactionTermMarks();
  scheduleEditorCheckpoint();
  clearCalloutOverlays();
  const doc = activeDoc();
  if (!doc?.callouts?.length || doc.contentView === "text") return;
  const editable = state.editMode === "annotate";

  for (const callout of doc.callouts) {
    const pageNum = callout.pageIndex + 1;
    const shell = els.viewerPages.querySelector(`.page-shell[data-page="${pageNum}"]`);
    if (!shell) continue;
    const scale = Number(shell.dataset.scale) || 1;
    const boxLeft = callout.x * scale;
    const boxTop = callout.y * scale;
    const boxWidth = Math.max(callout.width * scale, 36);
    const boxHeight = Math.max(callout.height * scale, 24);
    const anchorX = callout.anchorX * scale;
    const anchorY = callout.anchorY * scale;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "callout-line-svg");
    svg.setAttribute("data-callout-id", callout.id);
    paintCalloutArrow(svg, anchorX, anchorY, boxLeft, boxTop, boxWidth, boxHeight);
    shell.appendChild(svg);

    if (editable) {
      const handle = document.createElement("div");
      handle.className = "callout-anchor-handle";
      handle.style.left = `${anchorX}px`;
      handle.style.top = `${anchorY}px`;
      handle.title = t("Drag to move where the arrow points");
      attachCalloutAnchorDrag(handle, callout, shell, scale);
      shell.appendChild(handle);
    }

    const editingThis = state.inlineTextEditor?.calloutId === callout.id;
    if (editingThis) continue;

    const el = document.createElement("div");
    el.className = "callout-overlay";
    if (!editable) el.classList.add("callout-readonly");
    el.dataset.calloutId = callout.id;
    el.style.left = `${boxLeft}px`;
    el.style.top = `${boxTop}px`;
    el.style.width = `${boxWidth}px`;
    el.style.height = `${boxHeight}px`;
    el.style.fontSize = `${(callout.fontSize || state.textFontSize) * scale}px`;
    el.style.fontFamily = callout.fontFamily || state.textFontFamily || "Helvetica";
    applyCalloutColors(el, callout, editable);
    const content = document.createElement("span");
    content.className = "callout-overlay-text";
    content.textContent = callout.text;
    el.appendChild(content);
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "placement-delete-btn";
    deleteBtn.title = t("Delete comment (Delete)");
    deleteBtn.setAttribute("aria-label", t("Delete comment"));
    deleteBtn.textContent = "×";
    deleteBtn.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
    });
    deleteBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      deleteCallout(callout.id);
    });
    el.appendChild(deleteBtn);
    if (editable && state.selectedCalloutId === callout.id) {
      el.classList.add("selected");
    }
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      selectCallout(callout.id);
      openCalloutPropertyMenu(callout.id, ev.clientX, ev.clientY);
    });
    el.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      if (ev.button !== 0) return;
      if (!editable) return;
      selectCallout(callout.id);
      beginCalloutBoxGesture(ev, el, callout, shell, scale);
    });
    el.title = editable
      ? t("Drag to move; drag an edge to resize; click to edit the text; right-click for properties; hover and click × or press Delete to remove")
      : t("Hover and click × to delete; right-click for properties");
    shell.appendChild(el);
  }
}

function beginCalloutBoxGesture(ev, el, callout, shell, scale) {
  const edge = calloutEdgeHit(ev, el);
  const origin = overlayPixelRect(el);
  const startX = ev.clientX;
  const startY = ev.clientY;
  let moved = false;
  const onMove = (moveEv) => {
    const dx = moveEv.clientX - startX;
    const dy = moveEv.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    moved = true;
    el.classList.add("dragging");
    if (!edge) {
      el.style.left = `${origin.left + dx}px`;
      el.style.top = `${origin.top + dy}px`;
    } else {
      let { left, top, width, height } = origin;
      if (edge.includes("e")) width = origin.width + dx;
      if (edge.includes("s")) height = origin.height + dy;
      if (edge.includes("w")) {
        width = origin.width - dx;
        left = origin.left + dx;
      }
      if (edge.includes("n")) {
        height = origin.height - dy;
        top = origin.top + dy;
      }
      if (width < 48) {
        if (edge.includes("w")) left = origin.left + origin.width - 48;
        width = 48;
      }
      if (height < 28) {
        if (edge.includes("n")) top = origin.top + origin.height - 28;
        height = 28;
      }
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.width = `${width}px`;
      el.style.height = `${height}px`;
    }
    const box = overlayPixelRect(el);
    const svg = el.parentElement?.querySelector(
      `.callout-line-svg[data-callout-id="${callout.id}"]`
    );
    if (svg) {
      paintCalloutArrow(
        svg,
        callout.anchorX * scale,
        callout.anchorY * scale,
        box.left,
        box.top,
        box.width,
        box.height
      );
    }
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    el.classList.remove("dragging");
    if (!moved) {
      const pixel = overlayPixelRect(el);
      const region = overlayPixelToRegion(el, shell, scale, callout.pageIndex);
      openInlineTextEditor(shell, pixel, region, {
        mode: "callout",
        initialText: callout.text,
        fontSize: callout.fontSize || state.textFontSize,
        fontFamily: callout.fontFamily,
        calloutAnchor: { x: callout.anchorX, y: callout.anchorY },
        calloutId: callout.id,
        preserveBounds: true,
      });
      return;
    }
    const region = overlayPixelToRegion(el, shell, scale, callout.pageIndex);
    updateCalloutFields(callout.id, {
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
    });
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function calloutEdgeHit(ev, el) {
  const rect = el.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  const margin = 8;
  let dir = "";
  if (y <= margin) dir += "n";
  else if (y >= rect.height - margin) dir += "s";
  if (x <= margin) dir += "w";
  else if (x >= rect.width - margin) dir += "e";
  return dir;
}

function attachCalloutAnchorDrag(handle, callout, shell, scale) {
  handle.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    selectCallout(callout.id);
    const onMove = (moveEv) => {
      const bounds = shell.getBoundingClientRect();
      const x = moveEv.clientX - bounds.left;
      const y = moveEv.clientY - bounds.top;
      handle.style.left = `${x}px`;
      handle.style.top = `${y}px`;
      const svg = shell.querySelector(`.callout-line-svg[data-callout-id="${callout.id}"]`);
      const box = shell.querySelector(`.callout-overlay[data-callout-id="${callout.id}"]`);
      if (svg && box) {
        const pixel = overlayPixelRect(box);
        paintCalloutArrow(svg, x, y, pixel.left, pixel.top, pixel.width, pixel.height);
      }
    };
    const onUp = (upEv) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const bounds = shell.getBoundingClientRect();
      const point = canvasToPdfPoint(
        upEv.clientX - bounds.left,
        upEv.clientY - bounds.top,
        { scale, pageIndex: callout.pageIndex }
      );
      updateCalloutFields(callout.id, { anchorX: point.x, anchorY: point.y });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function paintCalloutArrow(svg, anchorX, anchorY, boxLeft, boxTop, boxWidth, boxHeight) {
  const edge = calloutEdgePoint(anchorX, anchorY, boxLeft, boxTop, boxWidth, boxHeight);
  const angle = Math.atan2(anchorY - edge.y, anchorX - edge.x);
  const tipInset = 8;
  const endX = anchorX - Math.cos(angle) * tipInset;
  const endY = anchorY - Math.sin(angle) * tipInset;
  let line = svg.querySelector("line");
  let head = svg.querySelector("polygon");
  if (!line) {
    line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("class", "callout-overlay-line");
    svg.appendChild(line);
  }
  if (!head) {
    head = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    head.setAttribute("class", "callout-overlay-head");
    svg.appendChild(head);
  }
  line.setAttribute("x1", String(edge.x));
  line.setAttribute("y1", String(edge.y));
  line.setAttribute("x2", String(endX));
  line.setAttribute("y2", String(endY));
  const size = 7;
  const a1 = angle + Math.PI * 0.82;
  const a2 = angle - Math.PI * 0.82;
  const p1 = `${anchorX},${anchorY}`;
  const p2 = `${anchorX + Math.cos(a1) * size},${anchorY + Math.sin(a1) * size}`;
  const p3 = `${anchorX + Math.cos(a2) * size},${anchorY + Math.sin(a2) * size}`;
  head.setAttribute("points", `${p1} ${p2} ${p3}`);
}

function ensureCalloutPreviewSvg(shell) {
  let svg = shell.querySelector(".callout-preview-svg");
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "callout-preview-svg callout-line-svg");
    shell.appendChild(svg);
  }
  return svg;
}

function updateCalloutPreview(shell, anchorX, anchorY, boxLeft, boxTop, boxWidth, boxHeight) {
  const svg = ensureCalloutPreviewSvg(shell);
  paintCalloutArrow(svg, anchorX, anchorY, boxLeft, boxTop, boxWidth, boxHeight);
}

function clearCalloutPreview(shell) {
  shell?.querySelector(".callout-preview-svg")?.remove();
}

function detachRegionSelect(shell) {
  shell?._detachRegionSelect?.();
}

function attachRegionSelect(shell, meta) {
  if (!state.editMode) return;
  detachRegionSelect(shell);
  shell.classList.add("selectable");
  const layer = document.createElement("div");
  layer.className = "selection-layer";
  shell.appendChild(layer);

  let start = null;
  let rectEl = null;

  const finish = async (ev) => {
    if (!start || !rectEl) return;
    const bounds = shell.getBoundingClientRect();
    const x1 = ev.clientX - bounds.left;
    const y1 = ev.clientY - bounds.top;
    const sx = start.x;
    const sy = start.y;
    let region = canvasToPdfRect(shell, sx, sy, x1, y1, meta);
    let pixel = {
      left: Math.min(sx, x1),
      top: Math.min(sy, y1),
      width: Math.abs(x1 - sx),
      height: Math.abs(y1 - sy),
    };
    clearCalloutPreview(shell);
    rectEl.remove();
    rectEl = null;
    start = null;
    shell.removeEventListener("mousemove", move);
    shell.removeEventListener("mouseup", finish);
    const wasTinyDrag = region.width < 4 || region.height < 4;
    if (state.editMode === "annotate") {
      if (Math.hypot(x1 - sx, y1 - sy) < CALLOUT_MIN_DRAG) return;
      const scale = Number(shell.dataset.scale) || meta.scale || 1;
      const size = defaultCalloutPixelSize(scale);
      const box = layoutCalloutFromDrag(sx, sy, x1, y1, size.width, size.height);
      pixel = box;
      region = canvasToPdfRect(shell, box.left, box.top, box.left + box.width, box.top + box.height, meta);
      const calloutAnchor = canvasToPdfPoint(sx, sy, meta);
      const entry = rememberCallout(region, "", state.textFontSize, calloutAnchor);
      openInlineTextEditor(shell, pixel, region, {
        mode: "callout",
        fontSize: state.textFontSize,
        fontFamily: state.textFontFamily,
        calloutAnchor,
        calloutId: entry?.id,
        calloutDraft: true,
      });
      renderCalloutOverlays();
      return;
    }
    if (wasTinyDrag && isTextInputMode()) {
      const scale = Number(shell.dataset.scale) || 1;
      const h = Math.max(state.textFontSize * scale * 1.25, 14);
      pixel = { left: sx, top: sy, width: 160, height: h };
      region = canvasToPdfRect(shell, sx, sy, sx + 160, sy + h, meta);
    } else if (wasTinyDrag) {
      return;
    }
    if (isTextInputMode()) {
      await ensureFormFieldsLoaded(activeDoc());
    }
    if (state.editMode === "insert-image") {
      placeImageCursor(shell, sx, sy, meta);
      return;
    }
    if (state.editMode === "replace-text") {
      openInlineTextEditor(shell, pixel, region, {
        mode: "plain",
        fontSize: state.textFontSize,
      });
      return;
    }
    if (state.editMode === "cover-text") {
      const scale = Number(shell.dataset.scale) || 1;
      // a click picks up the box under the pointer, not one beside it
      const snapped = snapToPlacedText(
        wasTinyDrag ? { ...canvasToPdfRect(shell, sx, sy, sx + 1, sy + 1, meta), pageIndex: region.pageIndex } : region
      );
      if (snapped && snapped.kind !== "cover") {
        // text inserted earlier on empty space: type on, it still erases nothing
        openInlineTextEditor(shell, placedTextToPixel(snapped, scale), placedTextToRegion(snapped), {
          mode: "plain",
          initialText: snapped.text,
          fontSize: snapped.fontSize || state.textFontSize,
          fontFamily: snapped.fontFamily,
          family: snapped.fontFamily,
          placementId: snapped.id,
          eraseBounds: { x: snapped.x, y: snapped.y, width: snapped.width, height: snapped.height },
          caretAt: { x: ev.clientX, y: ev.clientY },
        });
        return;
      }
      // A click on the page's own text: edit that run of text in place.
      const run = !snapped && wasTinyDrag ? await textRunAt(shell, sx, sy) : null;
      if (!snapped && !run && wasTinyDrag) {
        // A click on empty space (the blank after a form's label): new text right
        // there, which removes nothing. On a line of the page's text it sits on
        // that line, in that size.
        const row = await textRowAt(shell, sx, sy);
        const size = row ? Math.max(4, Math.round((row.h / scale) * 2) / 2) : state.textFontSize;
        if (row) {
          state.textFontSize = size;
          syncTextStyleToolbar();
        }
        // where the saved text's baseline is drawn: 1 pt + 0.947 em below the box top, 3 pt in
        const left = sx - 3 * scale;
        const top = row ? row.base - (1 + size * 0.947) * scale : sy - size * scale * 0.6;
        const height = size * scale * 1.25;
        openInlineTextEditor(shell, { left, top, width: 24, height }, canvasToPdfRect(shell, left, top, left + 24, top + height, meta), {
          mode: "plain",
          fontSize: size,
          keepBaseline: !!row,
        });
        setStatus(t("Type the new text; nothing on the page is removed"), "ok");
        return;
      }
      if (snapped) {
        pixel = placedTextToPixel(snapped, scale);
        region = placedTextToRegion(snapped);
      } else if (run) {
        pixel = run.pixel;
        region = run.region;
        state.textFontSize = run.fontSize;
        syncTextStyleToolbar();
      }
      openInlineTextEditor(shell, pixel, region, {
        mode: "cover",
        preserveBounds: !wasTinyDrag && !snapped,
        initialText: snapped?.text || run?.text || "",
        fontSize: state.textFontSize,
        placementId: snapped?.id || null,
        // text of the page itself: saving writes the new text in its font, size and colour
        style: run ? { origin: { ...run.region }, pdfFont: run.fontName } : null,
        paragraph: snapped?.paragraph || run?.paragraph || null,
        fontFamily: run?.fontName ? `"${run.fontName}", ${state.textFontFamily || "Helvetica"}` : snapped?.fontFamily,
        family: snapped?.fontFamily,
        caretAt: { x: ev.clientX, y: ev.clientY },
        eraseBounds: snapped
          ? {
              x: snapped.x,
              y: snapped.y,
              width: snapped.width,
              height: snapped.height,
            }
          : null,
      });
      return;
    }
    try {
      await applyRegionAction(region, { shell, pixel, meta });
    } catch (err) {
      setStatus(String(err.message || err), "error");
    }
  };

  const move = (ev) => {
    if (!start) return;
    const bounds = shell.getBoundingClientRect();
    const x = ev.clientX - bounds.left;
    const y = ev.clientY - bounds.top;
    const left = Math.min(start.x, x);
    const top = Math.min(start.y, y);
    rectEl.style.left = `${left}px`;
    rectEl.style.top = `${top}px`;
    const width = Math.abs(x - start.x);
    const height = Math.abs(y - start.y);
    rectEl.style.width = `${width}px`;
    rectEl.style.height = `${height}px`;
    if (state.editMode === "annotate") {
      if (Math.hypot(x - start.x, y - start.y) < CALLOUT_MIN_DRAG) {
        rectEl.style.width = "0px";
        rectEl.style.height = "0px";
        clearCalloutPreview(shell);
        return;
      }
      const scale = Number(shell.dataset.scale) || meta.scale || 1;
      const size = defaultCalloutPixelSize(scale);
      const box = layoutCalloutFromDrag(start.x, start.y, x, y, size.width, size.height);
      rectEl.style.left = `${box.left}px`;
      rectEl.style.top = `${box.top}px`;
      rectEl.style.width = `${box.width}px`;
      rectEl.style.height = `${box.height}px`;
      updateCalloutPreview(shell, start.x, start.y, box.left, box.top, box.width, box.height);
    }
  };

  const onMouseDown = (ev) => {
    if (ev.button !== 0) return;
    // in the box being typed: the mouse places the caret and selects text
    if (ev.target.closest?.(".inline-text-editor")) return;
    if (state.editMode === "insert-image") {
      if (ev.target.closest(".image-placement-preview")) return;
      const bounds = shell.getBoundingClientRect();
      placeImageCursor(shell, ev.clientX - bounds.left, ev.clientY - bounds.top, meta);
      return;
    }
    if (state.editMode === "sign") {
      window.OpenPDFSign?.pageMouseDown(ev, shell, meta);
      return;
    }
    if (
      state.editMode === "annotate" &&
      ev.target.closest(".callout-overlay, .callout-anchor-handle, .placement-color-menu")
    ) {
      return;
    }
    if (state.editMode === "highlight" && highlightShapeInfo().id === "pen") {
      ev.preventDefault();
      startHighlighterStroke(ev, shell, meta);
      return;
    }
    const bounds = shell.getBoundingClientRect();
    start = { x: ev.clientX - bounds.left, y: ev.clientY - bounds.top };
    rectEl = document.createElement("div");
    rectEl.className =
      state.editMode === "annotate" ? "selection-rect callout-box-preview" : "selection-rect";
    layer.appendChild(rectEl);
    shell.addEventListener("mousemove", move);
    shell.addEventListener("mouseup", finish);
  };
  shell.addEventListener("mousedown", onMouseDown);
  shell._detachRegionSelect = () => {
    shell.removeEventListener("mousedown", onMouseDown);
    shell.removeEventListener("mousemove", move);
    shell.removeEventListener("mouseup", finish);
    layer.remove();
    clearCalloutPreview(shell);
    rectEl?.remove();
    rectEl = null;
    start = null;
    delete shell._detachRegionSelect;
  };
}

async function applyRegionAction(region, visual = {}) {
  const doc = activeDoc();
  if (!doc) return;
  const scrollAnchor = captureScrollAnchor();

  try {
    if (state.editMode === "highlight" && highlightShapeInfo().id === "text" && visual.shell && visual.pixel) {
      await highlightTextIn(visual.shell, visual.pixel, visual.meta);
      return;
    }
    if (state.editMode === "highlight") {
      let optimistic = null;
      if (visual.shell && visual.pixel) {
        optimistic = addOptimisticHighlight(
          visual.shell,
          visual.pixel.left,
          visual.pixel.top,
          visual.pixel.width,
          visual.pixel.height
        );
      }
      setStatus(t("Saving highlight…"));
      const result = await queueDocMutation(doc, () =>
        apiPost("/v1/pdf/highlight", buildRegionForm(doc, region))
      );
      doc.dirty = true;
      recordServerStep(doc, result, N_("Highlight"), [region.pageIndex + 1]);
      setStatus(t("Highlight added"), "ok");
      markPageStale(doc, region.pageIndex + 1);
    } else if (state.editMode === "redact") {
      addRedactionArea(region);
    } else if (state.editMode === "erase-highlight") {
      const pageNum = region.pageIndex + 1;
      // Instant feedback: take the highlights out of the page picture right
      // away (the page text stays visible), while the server does the edit.
      let preview = Promise.resolve(0);
      if (visual.shell && visual.pixel) {
        removeOptimisticInRegion(visual.shell, visual.pixel, 3 * (Number(visual.shell.dataset.scale) || 1));
        preview = previewHighlightErase(doc, visual.shell, visual.pixel).catch(() => 0);
      }
      setStatus(t("Erasing highlights…"));
      let result;
      try {
        result = await queueDocMutation(doc, () =>
          apiPost("/v1/pdf/remove-highlight", buildRegionForm(doc, region))
        );
      } catch (err) {
        // put back whatever the preview took away
        if ((await preview) > 0) patchPageRender(pageNum).catch(() => {});
        throw err;
      }
      const removed = result.removed_count;
      if (removed === 0) {
        if ((await preview) > 0) patchPageRender(pageNum).catch(() => {});
        setStatus(t("No highlight found in the selected area. Try selecting a larger area."), "error");
      } else {
        doc.dirty = true;
        recordServerStep(doc, result, N_("Erase highlight"), [pageNum]);
        markPageStale(doc, pageNum);
        // bring the page in line with the saved file straight away
        scheduleQuickPageRefresh(doc);
        setStatus(removed != null ? tn(removed, "Erased {n} highlight", "Erased {n} highlights") : t("Highlight erased"), "ok");
      }
    }
  } catch (err) {
    if (state.editMode === "highlight" && visual.shell) {
      clearOptimisticHighlights(region.pageIndex + 1);
    }
    setStatus(String(err.message || err), "error");
  }
}

/**
 * Pages start as correctly sized placeholders and are drawn only when they
 * come near the visible area; pages far away give their canvas back. This
 * keeps opening, zooming and switching tabs fast on long documents.
 */
function pageObservers() {
  if (!state._pageObserver) {
    state._pageObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) ensureShellRendered(entry.target);
        }
      },
      { root: els.viewerScroll, rootMargin: "900px 0px" }
    );
    state._pageReleaseObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) releaseShell(entry.target);
        }
      },
      { root: els.viewerScroll, rootMargin: "4000px 0px" }
    );
    state._thumbObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) ensureThumbRendered(entry.target);
        }
      },
      { root: els.thumbnails, rootMargin: "600px 0px" }
    );
  }
  return state;
}

function ensureShellRendered(shell) {
  if (!shell || shell.dataset.rendered === "true") return Promise.resolve(true);
  if (shell._renderPromise) return shell._renderPromise;
  const pageNum = Number(shell.dataset.page);
  shell._renderPromise = patchPageRender(pageNum)
    .catch(() => false)
    .finally(() => {
      shell._renderPromise = null;
    });
  return shell._renderPromise;
}

function releaseShell(shell) {
  if (shell.dataset.rendered !== "true" || shell._renderPromise) return;
  if (Number(shell.dataset.page) === activeDoc()?.pageNum) return;
  shell.querySelectorAll(":scope > canvas, :scope > .textLayer").forEach((node) => {
    if (node.tagName === "CANVAS") {
      node.width = 0;
      node.height = 0;
    }
    node.remove();
  });
  shell.dataset.rendered = "false";
}

async function buildPageShell(pageNum, baseScale) {
  const doc = activeDoc();
  const page = await doc.pdfDoc.getPage(pageNum);
  const scale = scaleForView(page, baseScale);
  const viewport = page.getViewport({ scale });
  const shell = document.createElement("div");
  shell.className = "page-shell";
  shell.dataset.page = String(pageNum);
  shell.dataset.scale = String(scale);
  shell.dataset.pageIndex = String(pageNum - 1);
  shell.dataset.rendered = "false";
  shell.setAttribute("aria-label", t("Page {page}", { page: pageNum }));
  sizeShell(shell, viewport);
  bindPageShellEvents(shell, pageNum);
  if (state.editMode) {
    shell.classList.add("selectable");
    attachRegionSelect(shell, { scale, pageIndex: pageNum - 1, viewport });
  }
  return shell;
}

const THUMB_SCALE = 0.28;

async function buildThumb(pageNum) {
  const doc = activeDoc();
  const page = await doc.pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: THUMB_SCALE });
  const wrap = document.createElement("div");
  wrap.className = `thumb${pageNum === doc.pageNum ? " active" : ""}`;
  wrap.dataset.page = String(pageNum);
  wrap.dataset.rendered = "false";
  wrap.draggable = true;
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "button");
  wrap.setAttribute("aria-label", t("Page {page} (right-click or drag to manage pages)", { page: pageNum }));
  const holder = document.createElement("div");
  holder.className = "thumb-canvas";
  holder.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
  wrap.appendChild(holder);
  const num = document.createElement("div");
  num.className = "thumb-num";
  num.textContent = String(pageNum);
  wrap.appendChild(num);
  const more = document.createElement("span");
  more.className = "thumb-more";
  more.setAttribute("role", "button");
  more.title = t("Page actions");
  more.setAttribute("aria-label", t("Actions for page {page}", { page: pageNum }));
  more.dataset.icon = "more-horizontal";
  more.dataset.iconSize = "14";
  more.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const r = more.getBoundingClientRect();
    openThumbMenu(pageNum, r.left, r.bottom + 4);
  });
  wrap.appendChild(more);
  window.PdfIcons?.hydrate(wrap);
  wrap.addEventListener("click", (ev) => {
    if (ev.target.closest(".thumb-more")) return;
    goToPage(pageNum, { smooth: isScrollViewMode() });
  });
  wrap.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") goToPage(pageNum, { smooth: isScrollViewMode() });
    if (ev.key === "Delete") {
      ev.preventDefault();
      ev.stopPropagation();
      runPageAction("delete", pageNum);
    }
  });
  wrap.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    openThumbMenu(pageNum, ev.clientX, ev.clientY);
  });
  bindThumbDrag(wrap, pageNum);
  return wrap;
}

// Thumbnails are drawn one at a time, after the page in view has been drawn,
// so they never compete with it. A page already drawn in the viewer is
// simply scaled down instead of being rendered a second time.
const thumbQueue = { items: [], running: false };

function ensureThumbRendered(wrap) {
  if (!wrap || wrap.dataset.rendered !== "false") return;
  wrap.dataset.rendered = "pending";
  thumbQueue.items.push(wrap);
  pumpThumbQueue();
}

async function pumpThumbQueue() {
  if (thumbQueue.running) return;
  thumbQueue.running = true;
  try {
    while (thumbQueue.items.length) {
      await Promise.race([state._firstPagePainted, new Promise((r) => setTimeout(r, 3000))]);
      const wrap = thumbQueue.items.shift();
      if (!wrap.isConnected) {
        wrap.dataset.rendered = "false";
        continue;
      }
      await renderThumb(wrap);
      // give the screen a frame between thumbnails
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    thumbQueue.running = false;
  }
}

async function renderThumb(wrap) {
  const doc = activeDoc();
  const pageNum = Number(wrap.dataset.page);
  try {
    const page = await doc.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: THUMB_SCALE });
    const shell = els.viewerPages.querySelector(`.page-shell[data-page="${pageNum}"]`);
    const source = shell?.dataset.rendered === "true" ? shell.querySelector(":scope > canvas") : null;
    let canvas;
    if (source?.width) {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    } else {
      ({ canvas } = await renderPageCanvas(page, THUMB_SCALE, { cssSize: false }));
    }
    if (!wrap.isConnected) {
      wrap.dataset.rendered = "false";
      return;
    }
    wrap.querySelector(".thumb-canvas")?.replaceChildren(canvas);
    wrap.dataset.rendered = "true";
  } catch (_) {
    wrap.dataset.rendered = "false";
  }
}

let refreshViewerJob = 0;

async function refreshViewer(options = {}) {
  const doc = activeDoc();
  if (!doc) {
    showWelcome();
    return;
  }
  const job = ++refreshViewerJob;
  let firstPainted;
  state._firstPagePainted = new Promise((resolve) => (firstPainted = resolve));
  state._resolveFirstPaint = firstPainted;
  try {
    await refreshViewerInner(doc, job, options);
  } finally {
    firstPainted();
  }
}

async function refreshViewerInner(doc, job, options) {
  if (!doc.pdfDoc) return;
  const scrollAnchor = options.scrollAnchor ?? null;
  const skipThumbnails = options.skipThumbnails ?? false;

  els.welcome.classList.add("hidden");
  els.viewerScroll.classList.remove("hidden");

  const pagesRoot = document.createElement("div");
  pagesRoot.className = "viewer-pages";
  if (state.viewMode === "continuous") pagesRoot.classList.add("continuous");
  if (state.viewMode === "two-page") pagesRoot.classList.add("two-page");
  if (state.viewMode === "grid") pagesRoot.classList.add("grid");

  const baseScale = state.fitWidth ? 1 : state.zoom * 1.2;
  const pageNumbers = pagesToRender(doc);
  const shells = await Promise.all(pageNumbers.map((n) => buildPageShell(n, baseScale)));
  let thumbs = null;
  if (!skipThumbnails) {
    thumbs = await Promise.all(Array.from({ length: doc.pageCount }, (_, i) => buildThumb(i + 1)));
  }
  if (job !== refreshViewerJob || activeDoc() !== doc) return;

  const observers = pageObservers();
  observers._pageObserver.disconnect();
  observers._pageReleaseObserver.disconnect();
  shells.forEach((shell) => pagesRoot.appendChild(shell));
  pagesRoot.id = "viewerPages";
  els.viewerPages.replaceWith(pagesRoot);
  els.viewerPages = pagesRoot;

  if (thumbs) {
    observers._thumbObserver.disconnect();
    const thumbsFragment = document.createDocumentFragment();
    thumbs.forEach((t) => thumbsFragment.appendChild(t));
    els.thumbnails.innerHTML = "";
    els.thumbnails.appendChild(thumbsFragment);
    thumbs.forEach((t) => observers._thumbObserver.observe(t));
  }

  updatePageIndicator();
  updateToolbarState();
  updateUndoButtons();
  restoreScrollAnchor(scrollAnchor);
  syncEditModeUI();
  syncEditModeLayers();

  // Draw the page being looked at first, on its own, then its neighbours;
  // the rest follow as they scroll into view.
  const focusPage = scrollAnchor?.pageNum ?? doc.pageNum;
  const focusShell = shells.find((shell) => Number(shell.dataset.page) === focusPage);
  if (focusShell) await ensureShellRendered(focusShell);
  state._resolveFirstPaint?.();
  if (job !== refreshViewerJob) return;
  const neighbours = shells.filter((shell) => {
    const n = Number(shell.dataset.page);
    return shell !== focusShell && n >= focusPage - 1 && n <= focusPage + 1;
  });
  await Promise.all(neighbours.map((shell) => ensureShellRendered(shell)));
  if (job !== refreshViewerJob) return;
  shells.forEach((shell) => {
    observers._pageObserver.observe(shell);
    observers._pageReleaseObserver.observe(shell);
  });

  if (doc.formFields?.length && els.propsPanel.classList.contains("open")) {
    renderFormOverlays(doc.formFields);
  }
  for (const shell of shells) {
    markPageRendered(doc, Number(shell.dataset.page));
  }
  renderPlacedTextOverlays();
  renderCalloutOverlays();
  renderSearchHits();
}

async function setZoom(value) {
  if (value === "fit") {
    state.fitWidth = true;
    els.zoomSelect.value = "fit";
  } else {
    state.fitWidth = false;
    const zoom = Number(value);
    state.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number.isFinite(zoom) && zoom > 0 ? zoom : 1));
    syncZoomSelect();
  }
  const doc = activeDoc();
  if (!doc) return;
  await refreshViewer({ scrollAnchor: captureScrollAnchor(), skipThumbnails: true });
}

/** The zoom shown on screen, also while "fit width" decides it. */
function currentZoom() {
  if (!state.fitWidth) return state.zoom;
  const doc = activeDoc();
  const shell = doc && els.viewerPages.querySelector(`.page-shell[data-page="${doc.pageNum}"]`);
  const scale = Number(shell?.dataset.scale);
  if (!scale) return state.zoom;
  const modeFactor = state.viewMode === "grid" ? 0.42 : state.viewMode === "two-page" ? 0.82 : 1;
  return scale / modeFactor / 1.2;
}

/** Show the zoom in the list, adding it when it is not one of the preset entries. */
function syncZoomSelect() {
  const value = String(state.zoom);
  let custom = els.zoomSelect.querySelector("option[data-custom]");
  const preset = [...els.zoomSelect.options].some((o) => !o.dataset.custom && o.value === value);
  if (preset) {
    custom?.remove();
  } else {
    if (!custom) {
      custom = document.createElement("option");
      custom.dataset.custom = "true";
      els.zoomSelect.insertBefore(custom, els.zoomSelect.querySelector('option[value="fit"]'));
    }
    custom.value = value;
    custom.textContent = `${Math.round(state.zoom * 100)}%`;
  }
  els.zoomSelect.value = value;
}

// ---------------------------------------------------------------- page management

function closeThumbMenu() {
  state._thumbMenu?.remove();
  state._thumbMenu = null;
}

/**
 * A small pop-up menu at (x, y). Items: {label, action, danger, disabled, icon}
 * or "-" for a separator. Esc or clicking elsewhere closes it.
 */
function openContextMenu(items, x, y, title = "") {
  closeThumbMenu();
  const menu = document.createElement("div");
  menu.className = "thumb-menu";
  menu.setAttribute("role", "menu");
  if (title) {
    const heading = document.createElement("div");
    heading.className = "thumb-menu-title";
    heading.textContent = title;
    menu.appendChild(heading);
  }
  for (const item of items) {
    if (item === "-") {
      const sep = document.createElement("div");
      sep.className = "menu-sep";
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "menuitem");
    if (item.icon) {
      const icon = document.createElement("span");
      icon.dataset.icon = item.icon;
      icon.dataset.iconSize = "15";
      btn.appendChild(icon);
    }
    const label = document.createElement("span");
    label.className = "menu-text";
    label.textContent = item.label;
    btn.appendChild(label);
    if (item.hint) {
      const hint = document.createElement("kbd");
      hint.textContent = item.hint;
      btn.appendChild(hint);
    }
    btn.disabled = !!item.disabled;
    if (item.danger) btn.classList.add("danger");
    btn.addEventListener("click", () => {
      closeThumbMenu();
      item.action?.();
    });
    menu.appendChild(btn);
  }
  window.PdfIcons?.hydrate(menu);
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  state._thumbMenu = menu;
  menu.querySelector("button:not(:disabled)")?.focus();
  const onAway = (ev) => {
    if (ev.type === "keydown" && ev.key !== "Escape") return;
    if (ev.type === "mousedown" && menu.contains(ev.target)) return;
    closeThumbMenu();
    document.removeEventListener("mousedown", onAway, true);
    document.removeEventListener("keydown", onAway, true);
    document.removeEventListener("scroll", onAway, true);
  };
  document.addEventListener("mousedown", onAway, true);
  document.addEventListener("keydown", onAway, true);
  document.addEventListener("scroll", onAway, true);
}

function pageMenuItems(pageNum) {
  const doc = activeDoc();
  if (!doc) return [];
  return [
    { label: t("Rotate clockwise"), icon: "rotate-cw", action: () => runPageAction("rotate-cw", pageNum) },
    { label: t("Rotate counterclockwise"), icon: "rotate-ccw", action: () => runPageAction("rotate-ccw", pageNum) },
    "-",
    { label: t("Move page up"), icon: "chevron-up", disabled: pageNum <= 1, action: () => runPageAction("move-up", pageNum) },
    { label: t("Move page down"), icon: "chevron-down", disabled: pageNum >= doc.pageCount, action: () => runPageAction("move-down", pageNum) },
    "-",
    { label: t("Delete page"), icon: "trash-2", danger: true, disabled: doc.pageCount <= 1, action: () => runPageAction("delete", pageNum) },
  ];
}

function openThumbMenu(pageNum, x, y) {
  openContextMenu(pageMenuItems(pageNum), x, y, t("Page {page}", { page: pageNum }));
}

/** Right-click on a page: act on the selected text, or on the page itself. */
function openPageContextMenu(ev, pageNum) {
  const doc = activeDoc();
  if (!doc) return;
  const selected = isSelectMode() && !!window.getSelection()?.toString()?.trim();
  const items = [];
  if (selected) {
    items.push(
      { label: t("Copy"), icon: "copy", hint: "Ctrl C", action: () => actions.copy() },
      { label: t("Highlight"), icon: "highlighter", action: () => highlightSelection() },
      { label: t("Edit this text"), icon: "text-box", action: () => coverSelection() },
      "-"
    );
  }
  items.push({ label: t("Find"), icon: "search", hint: "Ctrl F", action: () => openFindBar() }, "-", ...pageMenuItems(pageNum));
  openContextMenu(items, ev.clientX, ev.clientY, selected ? "" : t("Page {page}", { page: pageNum }));
}

async function runPageAction(action, pageNum) {
  const doc = activeDoc();
  if (!doc) return;
  try {
    if (action === "rotate-cw") await rotatePages(doc, [pageNum], 90);
    else if (action === "rotate-ccw") await rotatePages(doc, [pageNum], 270);
    else if (action === "move-up") await movePage(doc, pageNum, pageNum - 1);
    else if (action === "move-down") await movePage(doc, pageNum, pageNum + 1);
    else if (action === "delete") {
      if (doc.pageCount <= 1) throw new Error(t("You can't delete the only page"));
      await deletePages(doc, [pageNum]);
      showToast(t("Page {page} deleted", { page: pageNum }), { action: t("Undo"), onAction: () => undoLastStep() });
    }
    updatePageIndicator();
  } catch (err) {
    setStatus(String(err.message || err), "error");
    showToast(String(err.message || err), { type: "error" });
  }
}

function bindThumbDrag(wrap, pageNum) {
  wrap.addEventListener("dragstart", (ev) => {
    ev.dataTransfer.setData("application/x-openpdf-page", String(pageNum));
    ev.dataTransfer.effectAllowed = "move";
    wrap.classList.add("dragging");
  });
  wrap.addEventListener("dragend", () => {
    wrap.classList.remove("dragging");
    els.thumbnails.querySelectorAll(".drop-before, .drop-after").forEach((node) => {
      node.classList.remove("drop-before", "drop-after");
    });
  });
  wrap.addEventListener("dragover", (ev) => {
    if (!ev.dataTransfer.types.includes("application/x-openpdf-page")) return;
    ev.preventDefault();
    ev.stopPropagation();
    const rect = wrap.getBoundingClientRect();
    const before = ev.clientY < rect.top + rect.height / 2;
    wrap.classList.toggle("drop-before", before);
    wrap.classList.toggle("drop-after", !before);
  });
  wrap.addEventListener("dragleave", () => {
    wrap.classList.remove("drop-before", "drop-after");
  });
  wrap.addEventListener("drop", (ev) => {
    const raw = ev.dataTransfer.getData("application/x-openpdf-page");
    if (!raw) return;
    ev.preventDefault();
    ev.stopPropagation();
    const before = wrap.classList.contains("drop-before");
    wrap.classList.remove("drop-before", "drop-after");
    const from = Number(raw);
    const insertAt = before ? pageNum : pageNum + 1;
    const to = insertAt > from ? insertAt - 1 : insertAt;
    const doc = activeDoc();
    if (!doc || !from || from === to) return;
    movePage(doc, from, to).catch((err) => setStatus(String(err.message || err), "error"));
  });
}

// ---------------------------------------------------------------- find in document

state.find = { open: false, query: "", hits: [], index: -1, token: 0 };

function openFindBar() {
  if (!activeDoc()) return;
  state.find.open = true;
  els.findBar.classList.remove("hidden");
  els.findInput.focus();
  els.findInput.select();
  if (els.findInput.value.trim()) runFind({ keepIndex: true });
}

function closeFindBar() {
  if (!els.findBar) return;
  state.find.open = false;
  state.find.token += 1;
  state.find.hits = [];
  state.find.index = -1;
  els.findBar.classList.add("hidden");
  els.findCount.textContent = "";
  renderSearchHits();
}

async function buildSearchIndex(doc, token) {
  if (doc.searchIndex) return doc.searchIndex;
  const pages = [];
  for (let n = 1; n <= doc.pageCount; n += 1) {
    if (token !== state.find.token) return null;
    if (n % 20 === 0) els.findCount.textContent = t("Indexing {done}/{total}…", { done: n, total: doc.pageCount });
    const page = await doc.pdfDoc.getPage(n);
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    const items = [];
    let text = "";
    for (const item of content.items) {
      if (!("str" in item) || !item.str) continue;
      const start = text.length;
      text += item.str;
      items.push({ start, end: text.length, item });
      if (item.hasEOL) text += "\n";
    }
    pages.push({ lower: text.toLocaleLowerCase(), items, viewport });
  }
  doc.searchIndex = pages;
  return pages;
}

/** Rectangles (page units at scale 1, from the displayed top-left) covering text [from, to). */
function searchHitRects(pageEntry, from, to) {
  const rects = [];
  for (const { start, end, item } of pageEntry.items) {
    if (end <= from || start >= to) continue;
    const tx = pdfjsLib.Util.transform(pageEntry.viewport.transform, item.transform);
    const height = Math.hypot(tx[2], tx[3]) || 10;
    const length = Math.max(1, end - start);
    const width = item.width * pageEntry.viewport.scale;
    const a = Math.max(from, start) - start;
    const b = Math.min(to, end) - start;
    rects.push({
      x: tx[4] + (width * a) / length,
      y: tx[5] - height,
      w: Math.max(2, (width * (b - a)) / length),
      h: height * 1.15,
    });
  }
  return rects;
}

async function runFind({ keepIndex = false, step = 0 } = {}) {
  const doc = activeDoc();
  if (!doc) return;
  const query = els.findInput.value.trim().toLocaleLowerCase();
  const token = ++state.find.token;
  if (!query) {
    state.find.hits = [];
    state.find.index = -1;
    els.findCount.textContent = "";
    renderSearchHits();
    return;
  }
  const index = await buildSearchIndex(doc, token);
  if (!index || token !== state.find.token) return;
  const hits = [];
  index.forEach((pageEntry, i) => {
    let at = pageEntry.lower.indexOf(query);
    while (at !== -1) {
      hits.push({ pageNum: i + 1, rects: searchHitRects(pageEntry, at, at + query.length) });
      at = pageEntry.lower.indexOf(query, at + query.length);
    }
  });
  const previous = state.find.index;
  state.find.hits = hits;
  if (!hits.length) {
    state.find.index = -1;
    els.findCount.textContent = t("No results");
    renderSearchHits();
    return;
  }
  if (keepIndex && previous >= 0) {
    state.find.index = Math.min(previous, hits.length - 1);
  } else {
    // start at the first hit on or after the current page
    const fromPage = doc.pageNum;
    const firstAfter = hits.findIndex((hit) => hit.pageNum >= fromPage);
    state.find.index = firstAfter === -1 ? 0 : firstAfter;
  }
  if (step) state.find.index = (state.find.index + step + hits.length) % hits.length;
  await showCurrentFindHit();
}

async function stepFind(step) {
  if (!state.find.hits.length) {
    await runFind();
    return;
  }
  state.find.index = (state.find.index + step + state.find.hits.length) % state.find.hits.length;
  await showCurrentFindHit();
}

async function showCurrentFindHit() {
  const hit = state.find.hits[state.find.index];
  if (!hit) return;
  els.findCount.textContent = `${state.find.index + 1} / ${state.find.hits.length}`;
  const doc = activeDoc();
  if (!isScrollViewMode() && !pagesToRender(doc).includes(hit.pageNum)) {
    doc.pageNum = hit.pageNum;
    await refreshViewer({ skipThumbnails: true });
  }
  const shell = els.viewerPages.querySelector(`.page-shell[data-page="${hit.pageNum}"]`);
  if (!shell) return;
  await ensureShellRendered(shell);
  const scale = Number(shell.dataset.scale) || 1;
  const top = hit.rects[0] ? hit.rects[0].y * scale : 0;
  els.viewerScroll.scrollTop = Math.max(0, shell.offsetTop + top - els.viewerScroll.clientHeight / 3);
  doc.pageNum = hit.pageNum;
  updatePageIndicator();
  renderSearchHits();
}

function renderSearchHits(onlyShell = null) {
  const shells = onlyShell ? [onlyShell] : [...els.viewerPages.querySelectorAll(".page-shell")];
  const current = state.find.hits[state.find.index];
  for (const shell of shells) {
    shell.querySelectorAll(".search-hit").forEach((node) => node.remove());
    if (!state.find.open || !state.find.hits.length) continue;
    const pageNum = Number(shell.dataset.page);
    const scale = Number(shell.dataset.scale) || 1;
    for (const hit of state.find.hits) {
      if (hit.pageNum !== pageNum) continue;
      for (const rect of hit.rects) {
        const el = document.createElement("div");
        el.className = `search-hit${hit === current ? " current" : ""}`;
        el.style.left = `${rect.x * scale}px`;
        el.style.top = `${rect.y * scale}px`;
        el.style.width = `${rect.w * scale}px`;
        el.style.height = `${rect.h * scale}px`;
        shell.appendChild(el);
      }
    }
  }
}

function bindFind() {
  let timer = null;
  els.findInput.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => runFind(), 220);
  });
  els.findInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      stepFind(ev.shiftKey ? -1 : 1);
    }
  });
  els.findNextBtn.addEventListener("click", () => stepFind(1));
  els.findPrevBtn.addEventListener("click", () => stepFind(-1));
  els.findCloseBtn.addEventListener("click", () => closeFindBar());
}

/** "All pages / current page / these pages" for a tool dialog; read back with scopePages. */
function pageScopeFields(doc) {
  return `<fieldset class="choice-group">
     <legend>${t("Pages")}</legend>
     <label class="choice"><input type="radio" data-field="scope" name="scope" value="all" checked /><span><strong>${tn(doc.pageCount, "All {n} page", "All {n} pages")}</strong></span></label>
     <label class="choice"><input type="radio" data-field="scope" name="scope" value="current" /><span><strong>${t("Current page")}</strong><small>${t("Page {page}", { page: doc.pageNum })}</small></span></label>
     <label class="choice"><input type="radio" data-field="scope" name="scope" value="range" /><span><strong>${t("Specific pages")}</strong><input data-field="pages" type="text" placeholder="${t("For example 1,3-5")}" class="inline-input" /></span></label>
   </fieldset>`;
}

function scopePages(data, doc) {
  if (data.scope !== "range" && data.pages?.trim()) data.scope = "range";
  if (data.scope === "current") return [doc.pageNum];
  if (data.scope === "range") return parsePageRange(data.pages, doc.pageCount);
  return Array.from({ length: doc.pageCount }, (_, i) => i + 1);
}

function showToolDialog(title, bodyHtml) {
  return new Promise((resolve) => {
    els.toolDialogTitle.textContent = title;
    els.toolDialogBody.innerHTML = bodyHtml;
    els.toolDialog.showModal();
    const first = els.toolDialogBody.querySelector("input:not([type=radio]):not([type=checkbox]), select, input:checked");
    first?.focus();
    const onSubmit = (e) => {
      e.preventDefault();
      const data = {};
      els.toolDialogBody.querySelectorAll("[data-field]").forEach((input) => {
        if (input.type === "radio") {
          if (input.checked) data[input.dataset.field] = input.value;
          return;
        }
        data[input.dataset.field] = input.type === "checkbox" ? input.checked : input.value;
      });
      els.toolDialog.close();
      cleanup();
      resolve(data);
    };
    const onCancel = () => {
      els.toolDialog.close();
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      els.toolForm.removeEventListener("submit", onSubmit);
      els.toolCancelBtn.removeEventListener("click", onCancel);
    };
    els.toolForm.addEventListener("submit", onSubmit);
    els.toolCancelBtn.addEventListener("click", onCancel);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isTruthyFormValue(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["true", "yes", "1", "on"].includes(normalized);
}

function formFieldLabel(field) {
  const name = field.name || t("Field");
  return `${escapeHtml(name)}${field.type ? ` (${escapeHtml(field.type)})` : ""}`;
}

function formOptionValue(option) {
  return typeof option === "string" ? option : option.exportValue || option.displayValue || "";
}

// The entries of a drop-down for a choice (or radio) field. When nothing is
// selected yet, an empty first entry stays selected: otherwise the browser
// shows the first option, and saving would fill it in (and, on a signed form,
// warn that the signature breaks although nothing was changed).
function formSelectOptions(field) {
  const labels = Array.isArray(field.optionLabels) ? field.optionLabels : [];
  const entries = (field.options || []).map((option, i) => {
    const value = formOptionValue(option);
    const label = labels[i] || (typeof option === "object" && option?.displayValue) || value;
    return { value, label, selected: false };
  });
  const hit = entries.find((e) => formValuesMatch(e.value, field.value));
  if (hit) hit.selected = true;
  else entries.unshift({ value: "", label: "", selected: true });
  return entries;
}

function formValuesMatch(a, b) {
  if (a == null || b == null) return false;
  if (a === b) return true;
  const norm = (v) => (String(v).startsWith("/") ? String(v).slice(1) : String(v));
  return norm(a) === norm(b);
}

function renderFormFieldInput(field, index) {
  const label = formFieldLabel(field);
  if (field.kind === "checkbox") {
    const checked = field.checked || isTruthyFormValue(field.value);
    return `<label class="form-check-row">
      <input data-form-index="${index}" type="checkbox" ${checked ? "checked" : ""} ${field.readOnly ? "disabled" : ""} />
      <span>${label}</span>
    </label>`;
  }
  if (field.kind === "radio" && Array.isArray(field.options) && field.options.length) {
    const current = field.value || "";
    const radios = field.options
      .map((option) => {
        const opt = formOptionValue(option);
        const checked = formValuesMatch(opt, current) ? "checked" : "";
        return `<label class="form-check-row">
          <input data-form-index="${index}" type="radio" name="form-radio-${index}" value="${escapeHtml(opt)}" ${checked} ${field.readOnly ? "disabled" : ""} />
          <span>${escapeHtml(opt)}</span>
        </label>`;
      })
      .join("");
    return `<div class="form-field-row form-radio-group"><div class="form-radio-label">${label}</div>${radios}</div>`;
  }
  if (field.kind === "choice" && Array.isArray(field.options) && field.options.length) {
    const options = formSelectOptions(field)
      .map(
        (o) =>
          `<option value="${escapeHtml(o.value)}" ${o.selected ? "selected" : ""}>${escapeHtml(o.label)}</option>`,
      )
      .join("");
    return `<div class="form-field-row">
      <label>${label}</label>
      <select data-form-index="${index}" ${field.readOnly ? "disabled" : ""}>${options}</select>
    </div>`;
  }
  if (field.kind === "textarea") {
    return `<div class="form-field-row">
      <label>${label}</label>
      <textarea data-form-index="${index}" ${field.readOnly ? "disabled" : ""}>${escapeHtml(field.value || "")}</textarea>
    </div>`;
  }
  return `<div class="form-field-row">
    <label>${label}</label>
    <input data-form-index="${index}" type="text" value="${escapeHtml(field.value || "")}" ${field.readOnly ? "disabled" : ""} />
  </div>`;
}

function readFormInputValue(input, field) {
  if (input.type === "checkbox") {
    if (!input.checked) return "Off";
    return field?.onValue || "Yes";
  }
  if (input.type === "radio") {
    return input.checked ? input.value : null;
  }
  return input.value;
}

function readFormFieldValue(field, index) {
  if (field.readOnly || field.kind === "signature" || field.kind === "button") return null;
  const overlay = document.querySelector(`.form-field-overlay [data-form-index="${index}"]`);
  const panel = els.propsBody.querySelector(`[data-form-index="${index}"]`);

  if (field.kind === "checkbox") {
    const overlayBox = document.querySelector(`.form-field-overlay [data-form-index="${index}"][type="checkbox"]`);
    const panelBox = els.propsBody.querySelector(`[data-form-index="${index}"][type="checkbox"]`);
    if (overlayBox?.disabled && panelBox?.disabled) return null;
    const checked = (overlayBox && overlayBox.checked) || (panelBox && panelBox.checked);
    return checked ? field.onValue || "Yes" : "Off";
  }

  if (field.kind === "radio") {
    const checked =
      document.querySelector(`.form-field-overlay input[type="radio"][data-form-index="${index}"]:checked`) ||
      els.propsBody.querySelector(`input[type="radio"][data-form-index="${index}"]:checked`);
    const overlaySelect = overlay?.tagName === "SELECT" ? overlay : null;
    const panelSelect = els.propsBody.querySelector(`select[data-form-index="${index}"]`);
    if (checked) return checked.value;
    if (overlaySelect?.value) return overlaySelect.value;
    if (panelSelect?.value) return panelSelect.value;
    return field.value || "";
  }

  const input = overlay || panel;
  if (!input || input.disabled) return null;
  return readFormInputValue(input, field);
}

function syncLinkedFormInputs(sourceInput) {
  const index = sourceInput.dataset.formIndex;
  if (index == null) return;
  if (sourceInput.type === "checkbox") {
    document.querySelectorAll(`[data-form-index="${index}"][type="checkbox"]`).forEach((other) => {
      if (other !== sourceInput) other.checked = sourceInput.checked;
    });
    return;
  }
  if (sourceInput.type === "radio") {
    document.querySelectorAll(`input[type="radio"][data-form-index="${index}"]`).forEach((other) => {
      other.checked = other.value === sourceInput.value;
    });
    document.querySelectorAll(`select[data-form-index="${index}"]`).forEach((select) => {
      select.value = sourceInput.value;
    });
    return;
  }
  document.querySelectorAll(`[data-form-index="${index}"]`).forEach((other) => {
    if (other === sourceInput) return;
    if (other.type === "checkbox" || other.type === "radio") return;
    other.value = sourceInput.value;
  });
}

function bindFormSyncDelegation() {
  if (state._formSyncBound) return;
  state._formSyncBound = true;
  const onFormInput = (ev) => {
    const input = ev.target.closest("[data-form-index]");
    if (!input) return;
    syncLinkedFormInputs(input);
    const doc = activeDoc();
    if (doc && !doc.dirty) {
      doc.dirty = true; // unsaved form entries: tab dot + leave warning
      renderTabs();
    }
  };
  els.propsBody.addEventListener("input", onFormInput);
  els.propsBody.addEventListener("change", onFormInput);
  els.viewerPages.addEventListener("input", onFormInput);
  els.viewerPages.addEventListener("change", onFormInput);
}

function focusFormFieldRow(index) {
  els.propsBody.querySelectorAll(".form-field-overlay-ref").forEach((row) => {
    row.classList.toggle("focused", Number(row.dataset.formRow) === index);
  });
  const row = els.propsBody.querySelector(`[data-form-row="${index}"]`);
  row?.scrollIntoView({ block: "nearest" });
  const input = row?.querySelector("[data-form-index]");
  input?.focus();
}

function clearFormOverlays() {
  els.viewerPages.querySelectorAll(".form-field-overlay").forEach((node) => node.remove());
}

function createFormOverlayWidget(field, index, scale) {
  const overlay = document.createElement("div");
  overlay.className = "form-field-overlay";
  overlay.style.left = `${field.x * scale}px`;
  overlay.style.top = `${field.y * scale}px`;
  overlay.style.width = `${Math.max(field.width * scale, field.kind === "checkbox" ? 22 : 48)}px`;
  overlay.style.height = `${Math.max(field.height * scale, field.kind === "checkbox" ? 22 : 16)}px`;
  overlay.title = field.name || t("Form field");

  if (field.kind === "checkbox") {
    const label = document.createElement("label");
    label.className = "form-overlay-check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.formIndex = String(index);
    input.checked = field.checked || isTruthyFormValue(field.value);
    input.disabled = !!field.readOnly;
    label.appendChild(input);
    overlay.appendChild(label);
    input.addEventListener("click", (ev) => ev.stopPropagation());
    input.addEventListener("change", () => focusFormFieldRow(index));
  } else if (
    (field.kind === "choice" || field.kind === "radio") &&
    Array.isArray(field.options) &&
    field.options.length
  ) {
    const select = document.createElement("select");
    select.className = "form-overlay-select";
    select.dataset.formIndex = String(index);
    select.disabled = !!field.readOnly;
    for (const o of formSelectOptions(field)) {
      const el = document.createElement("option");
      el.value = o.value;
      el.textContent = o.label;
      el.selected = o.selected;
      select.appendChild(el);
    }
    select.addEventListener("mousedown", (ev) => ev.stopPropagation());
    select.addEventListener("focus", () => focusFormFieldRow(index));
    overlay.appendChild(select);
  } else if (field.kind === "textarea") {
    const textarea = document.createElement("textarea");
    textarea.className = "form-overlay-textarea";
    textarea.dataset.formIndex = String(index);
    textarea.value = field.value || "";
    textarea.disabled = !!field.readOnly;
    textarea.addEventListener("mousedown", (ev) => ev.stopPropagation());
    textarea.addEventListener("focus", () => focusFormFieldRow(index));
    overlay.appendChild(textarea);
  } else {
    const input = document.createElement("input");
    input.className = "form-overlay-input";
    input.type = "text";
    input.dataset.formIndex = String(index);
    input.value = field.value || "";
    input.disabled = !!field.readOnly;
    input.addEventListener("mousedown", (ev) => ev.stopPropagation());
    input.addEventListener("focus", () => focusFormFieldRow(index));
    overlay.appendChild(input);
  }

  overlay.addEventListener("mousedown", (ev) => ev.stopPropagation());
  overlay.addEventListener("click", (ev) => {
    ev.stopPropagation();
    focusFormFieldRow(index);
  });
  return overlay;
}

/** Put the saved values into the existing boxes; false if they don't match the fields any more. */
function updateFormInputsInPlace(fields) {
  if (!fields?.length) return false;
  const overlays = els.viewerPages.querySelectorAll(".form-field-overlay [data-form-index]");
  const expected = fields.filter((f) => f.pageIndex != null && f.pageIndex >= 0).length;
  const shown = new Set([...overlays].map((el) => el.dataset.formIndex));
  if (!overlays.length || shown.size !== expected) return false;
  fields.forEach((field, index) => {
    document.querySelectorAll(`[data-form-index="${index}"]`).forEach((el) => {
      if (el === document.activeElement) return; // leave what the user is typing alone
      if (el.type === "checkbox") el.checked = formValuesMatch(field.onValue || "Yes", field.value);
      else if (el.type === "radio") el.checked = formValuesMatch(el.value, field.value);
      else if (field.value != null && el.value !== String(field.value)) el.value = String(field.value);
    });
  });
  return true;
}

function renderFormOverlays(fields) {
  clearFormOverlays();
  const doc = activeDoc();
  if (!doc || !fields?.length) return;
  fields.forEach((field, index) => {
    if (field.pageIndex == null || field.pageIndex < 0) return;
    const shell = els.viewerPages.querySelector(`.page-shell[data-page="${field.pageIndex + 1}"]`);
    if (!shell) return;
    const scale = Number(shell.dataset.scale) || 1;
    shell.appendChild(createFormOverlayWidget(field, index, scale));
  });
}

function collectFormValues() {
  const values = {};
  const doc = activeDoc();
  if (!doc?.formFields) return values;
  doc.formFields.forEach((field, index) => {
    const value = readFormFieldValue(field, index);
    if (value == null) return;
    values[field.name] = value;
  });
  return values;
}

async function refreshWorkingCopyFromServer(doc) {
  if (!doc?.documentId) return;
  const meta = await withDocSession(doc, () => fetchDocumentMeta(doc));
  const blob = await downloadDocumentBlob(doc);
  if (meta) await applyServerMeta(doc, meta);
  await reloadPdfDocIfChanged(doc, blob);
}

function markFormFieldPagesStale(doc) {
  if (!doc?.formFields?.length) return;
  for (const field of doc.formFields) {
    const pageIndex = field.pageIndex ?? field.page_index ?? 0;
    markPageStale(doc, pageIndex + 1);
  }
}

async function reloadFormFieldsFromPdf(doc) {
  if (!doc) return false;
  try {
    const data = await withDocSession(doc, () => {
      const fd = new FormData();
      appendDocToForm(fd, doc);
      return apiPost("/v1/pdf/form-fields", fd);
    });
    doc.formFields = data.fields || [];
    return doc.formFields.length > 0;
  } catch (_) {
    return false;
  }
}

function renderFormPanelBody(doc) {
  if (!doc?.formFields?.length) return;
  const rows = doc.formFields
    .map(
      (field, index) =>
        `<div class="form-field-overlay-ref" data-form-row="${index}">${renderFormFieldInput(field, index)}</div>`
    )
    .join("");
  els.propsBody.innerHTML = `<p class="form-hint">${t("Type or tick directly in the blue boxes on the PDF; the list here stays in sync. Save when you're done.")}</p>
       <div class="form-fields-scroll">${rows}</div>
       <button type="button" class="primary-btn" id="fillFormBtn">${t("Save form")}</button>`;
  bindFillFormButton(doc);
}

function bindFillFormButton(doc) {
  const btn = document.getElementById("fillFormBtn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    try {
      setStatus(t("Saving form…"));
      const result = await persistFormFieldValues(doc);
      if (!result.attempted) {
        setStatus(t("No form fields to save"), "error");
        return;
      }
      if (result.filled === 0) {
        setStatus(t("No fields were updated. Check that the fields can be edited."), "error");
      } else {
        setStatus(
          result.filled != null
            ? tn(result.filled, "Form saved ({n} field updated)", "Form saved ({n} fields updated)")
            : t("Form saved"),
          "ok"
        );
      }
    } catch (err) {
      setStatus(String(err.message || err), "error");
    }
  });
}

async function persistFormFieldValues(doc, { onlyChanged = false } = {}) {
  if (!doc?.formFields?.length) {
    return { attempted: false, filled: 0 };
  }
  const values = collectFormValues();
  if (onlyChanged) {
    for (const field of doc.formFields) {
      if (!(field.name in values)) continue;
      const before = field.kind === "checkbox" ? (field.checked ? field.onValue || "Yes" : "Off") : field.value ?? "";
      if (String(values[field.name]) === String(before)) delete values[field.name];
    }
  }
  if (!Object.keys(values).length) {
    return { attempted: false, filled: 0 };
  }
  const result = await queueDocMutation(doc, () => {
    const fillFd = new FormData();
    appendDocToForm(fillFd, doc);
    fillFd.append("values", JSON.stringify(values));
    return apiPost("/v1/pdf/fill-form", fillFd);
  });
  doc.dirty = true;
  recordServerStep(doc, result, N_("Fill in forms"));
  await refreshWorkingCopyFromServer(doc);
  markFormFieldPagesStale(doc);
  await reloadFormFieldsFromPdf(doc);
  // Update the boxes in place: rebuilding them would pull the box being
  // typed in out from under the cursor (and an input method), which in the
  // desktop app left the filled-in text invisible until the next repaint.
  if (formsPanelOpen()) {
    if (!updateFormInputsInPlace(doc.formFields)) {
      renderFormPanelBody(doc);
      renderFormOverlays(doc.formFields);
    }
  } else {
    // No form boxes on screen: show the values by drawing the pages again.
    await redrawFormPages(doc);
  }
  return { attempted: true, filled: result.filled_count ?? 0 };
}

async function loadFormsPanel() {
  const doc = activeDoc();
  if (!doc) return;
  try {
    setStatus(t("Loading form fields…"));
    const data = await withDocSession(doc, () => {
      const fd = new FormData();
      appendDocToForm(fd, doc);
      return apiPost("/v1/pdf/form-fields", fd);
    });
    const fields = data.fields || [];
    doc.formFields = fields;
    if (!fields.length) {
      clearFormOverlays();
      showPropsPanel(t("Forms"), `<p class="form-empty">${t("This PDF has no AcroForm fields to fill in (scans, XFA forms and flattened forms aren't supported).")}</p>`, "forms");
      setStatus(t("No form fields found"), "ok");
      return;
    }
    bindFormSyncDelegation();
    showPropsPanel(t("Forms"), "", "forms");
    renderFormPanelBody(doc);
    renderFormOverlays(fields);
    setStatus(tn(fields.length, "Loaded {n} form field", "Loaded {n} form fields"), "ok");
  } catch (err) {
    setStatus(String(err.message || err), "error");
  }
}

/**
 * Flush browser-only edits before reading a PDF for save, print, or export.
 * editorObjects: false leaves the text boxes and comments to the caller.
 */
async function prepareDocumentForExport(doc, { editorObjects = true } = {}) {
  const typing = document.activeElement;
  if (typing?.closest?.(".form-field-overlay, #propsBody")) typing.blur();
  if (typeof state.inlineTextEditor?.commit === "function") {
    await state.inlineTextEditor.commit();
  }
  if (state.pendingImageOverlay) await commitPendingImageOverlay();
  await window.OpenPDFSign?.commitPending(doc);
  const signed = !!doc.signatures?.length;
  if (doc.formFields?.length) {
    setStatus(t("Saving form fields…"));
    // Do not rewrite an unchanged signed PDF: it would invalidate its signature.
    await persistFormFieldValues(doc, { onlyChanged: true });
  }
  await waitForDocMutations(doc);
  if (!editorObjects) return;
  if (doc.placementsDirty || (!signed && (doc.placedTexts?.length || doc.callouts?.length))) {
    const result = await embedPlacementsIntoSession(doc);
    // "Edit text" removes what its boxes cover; say so when something stayed
    // (a picture used as a mask, text the eraser could not take apart).
    const edits = result?.edits;
    if (edits && (edits.textLeft > 0 || edits.notErased?.length)) {
      showToast(t("Some content under an edited area could not be removed and may still be readable"), {
        type: "error",
        duration: 9000,
      });
    }
  }
}

async function openPrintPreview() {
  const doc = activeDoc();
  if (!doc) return;
  try {
    setStatus(t("Preparing print preview…"));
    await prepareDocumentForExport(doc);
    const blob = await withDocSession(doc, () => downloadDocumentBlob(doc));
    const url = URL.createObjectURL(blob);
    els.printFrame.src = url;
    els.printDialog.showModal();
    els.printFrame.onload = () => URL.revokeObjectURL(url);
    setStatus(t("Print preview ready"), "ok");
  } catch (err) {
    setStatus(String(err.message || err), "error");
  }
}

const actions = {
  open: () => pickAndOpenPdf(),
  copy: () => copyToClipboard(),
  paste: () => pasteFromClipboard(),
  settings: () => openSettings(),
  deleteCurrentPage: () => {
    const doc = activeDoc();
    if (doc) runPageAction("delete", doc.pageNum);
  },
  undo: () => undoLastStep(),
  redo: () => redoLastStep(),
  find: () => openFindBar(),
  save: async () => {
    const doc = activeDoc();
    if (!doc) return;
    if (doc._saving) {
      setStatus(t("Saving, please wait…"));
      return;
    }
    if (hasPendingRedaction(doc)) {
      // Marks are not redaction until applied; saving them as they are would keep the content.
      if (window.confirm(t("Some content is marked for redaction but not removed yet. Apply the redaction before saving?"))) {
        if (!(await applyRedaction(doc))) return;
      }
    }
    doc._saving = true;
    setBusy(true, t("Save"));
    try {
      setStatus(t("Preparing to save…"));
      await prepareDocumentForExport(doc);
      setStatus(t("Saving…"));
      const blob = await withDocSession(doc, () => downloadDocumentBlob(doc));
      const saved = await saveBlobToDisk(doc, blob, doc.name);
      await reloadPdfDocIfChanged(doc, blob);
      // the desktop app writes the file afterwards and says when it is done (__openpdfSaved)
      if (saved.method !== "desktop") doc.dirty = false;
      doc.placementsDirty = false;
      doc.stalePages?.clear();
      renderTabs();
      if (saved.method === "desktop") {
        setStatus(t("Writing the file…"));
      } else if (saved.method === "overwrite") {
        setStatus(t("Saved to “{name}”", { name: saved.name }), "ok");
        showToast(t("Saved to “{name}”", { name: saved.name }), { type: "ok" });
      } else {
        setStatus(t("Downloaded “{name}”", { name: saved.name }), "ok");
        showToast(t("Downloaded “{name}”", { name: saved.name }), { type: "ok" });
      }
      if (saved.method !== "desktop") flashSaved();
    } catch (err) {
      if (err.name === "AbortError") {
        setStatus(t("Save canceled"), "ok");
        return;
      }
      setStatus(String(err.message || err), "error");
      showToast(String(err.message || err), { type: "error" });
    } finally {
      doc._saving = false;
      setBusy(false);
    }
  },
  merge: () => els.mergeInput.click(),
  fromImages: () => els.imagesInput.click(),
  forms: () => toggleFormsPanel(),
  print: () => openPrintPreview(),

  split: async () => {
    const doc = activeDoc();
    if (!doc) return;
    const data = await showToolDialog(
      t("Extract or split pages"),
      `<label for="splitPages">${t("Page numbers")}</label>
       <input id="splitPages" data-field="pages" type="text" value="1-${doc.pageCount}" />
       <p class="field-hint">${tn(doc.pageCount, "For example 1-3,5,8- ({n} page in all)", "For example 1-3,5,8- ({n} pages in all)")}</p>
       <fieldset class="choice-group">
         <legend>${t("Create")}</legend>
         <label class="choice"><input type="radio" data-field="unify" name="unify" value="one" checked /><span><strong>${t("One PDF with only these pages")}</strong><small>${t("Opens in this tab; saving creates a new file")}</small></span></label>
         <label class="choice"><input type="radio" data-field="unify" name="unify" value="each" /><span><strong>${t("One PDF per page")}</strong><small>${t("Downloaded together as a ZIP")}</small></span></label>
       </fieldset>`
    );
    if (!data) return;
    try {
      const pages = parsePageRange(data.pages, doc.pageCount);
      const base = doc.name.replace(/\.pdf$/i, "") || "document";
      if (data.unify !== "each") {
        await runDocumentOperation(doc, {
          label: N_("Split"),
          endpoint: "/v1/pdf/pages",
          fields: { order: pages.join(",") },
          rename: `${base}-split.pdf`,
          detachFile: true,
          editorTransform: (d) => remapEditorObjectPages(d, pages),
        });
        setStatus(t("Split done: saving creates a new file"), "ok");
      } else {
        setStatus(t("Splitting…"));
        await waitForDocMutations(doc);
        const { blob } = await withDocSession(doc, () => {
          const fd = new FormData();
          appendDocToForm(fd, doc);
          fd.append("pages", pages.join(","));
          fd.append("unify", "false");
          return apiPost("/v1/pdf/split", fd);
        });
        downloadBlob(blob, `${base}-pages.zip`);
        setStatus(t("ZIP downloaded"), "ok");
      }
    } catch (err) {
      setStatus(String(err.message || err), "error");
    }
  },

  rotate: async () => {
    const doc = activeDoc();
    if (!doc) return;
    const data = await showToolDialog(
      t("Rotate pages"),
      `<fieldset class="choice-row">
         <legend>${t("Direction")}</legend>
         <label class="chip"><input type="radio" data-field="angle" name="angle" value="90" checked /><span>${t("Clockwise 90°")}</span></label>
         <label class="chip"><input type="radio" data-field="angle" name="angle" value="270" /><span>${t("Counterclockwise 90°")}</span></label>
         <label class="chip"><input type="radio" data-field="angle" name="angle" value="180" /><span>180°</span></label>
       </fieldset>
       <fieldset class="choice-group">
         <legend>${t("Pages")}</legend>
         <label class="choice"><input type="radio" data-field="scope" name="scope" value="current" checked /><span><strong>${t("Current page")}</strong><small>${t("Page {page}", { page: doc.pageNum })}</small></span></label>
         <label class="choice"><input type="radio" data-field="scope" name="scope" value="all" /><span><strong>${tn(doc.pageCount, "All {n} page", "All {n} pages")}</strong></span></label>
         <label class="choice"><input type="radio" data-field="scope" name="scope" value="range" /><span><strong>${t("Specific pages")}</strong><input data-field="pages" type="text" placeholder="${t("For example 1,3-5")}" class="inline-input" /></span></label>
       </fieldset>`
    );
    if (!data) return;
    try {
      let pages;
      if (data.scope !== "range" && data.pages?.trim()) data.scope = "range";
      if (data.scope === "all") pages = Array.from({ length: doc.pageCount }, (_, i) => i + 1);
      else if (data.scope === "range") pages = parsePageRange(data.pages, doc.pageCount);
      else pages = [doc.pageNum];
      await rotatePages(doc, pages, Number(data.angle) || 90);
    } catch (err) {
      setStatus(String(err.message || err), "error");
    }
  },

  ocr: async () => {
    const doc = activeDoc();
    if (!doc) return;
    // OCR is an optional component, installed the first time it is needed.
    if (!(await ocrInstalled())) {
      if (await offerOcrInstall()) actions.ocr();
      return;
    }
    const data = await showToolDialog(
      t("Recognize text in scans"),
      `<p>${t("Chinese and English text are recognized together, even when mixed on one page.")}</p>
       <p class="field-hint">${t("Afterwards you can search and copy the text. The text a page already has is kept as it is. Many pages can take a few minutes; the result is saved as a new file.")}</p>
       <label class="check-option"><input type="checkbox" data-field="pictures" checked /><span>${t("Also read the text in pictures on pages that have text (charts, photos, pasted scans)")}</span></label>`
    );
    if (!data) return;
    try {
      setStatus(t("Running OCR. Many pages can take a few minutes…"));
      await runDocumentOperation(doc, {
        label: N_("OCR"),
        endpoint: "/v1/pdf/ocr",
        fields: { languages: data.languages || "eng,chi_sim", deskew: "false", clean: "false", pictures: data.pictures ? "true" : "false" },
        rename: `${doc.name.replace(/\.pdf$/i, "")}-searchable.pdf`,
        detachFile: true,
      });
      setStatus(t("OCR done"), "ok");
    } catch (err) {
      if (err.code === "ocr_not_installed") {
        if (await offerOcrInstall()) actions.ocr();
        return;
      }
      setStatus(String(err.message || err), "error");
    }
  },

  exportImages: async () => {
    const doc = activeDoc();
    if (!doc) return;
    const data = await showToolDialog(
      t("Save the pictures"),
      `<p class="field-hint">${t("Every picture in the document as an image file (JPEG pictures keep their original quality), in a ZIP with a list of the page and place of each.")}</p>
       ${pageScopeFields(doc)}
       <label class="check-option"><input type="checkbox" data-field="ocr" checked /><span>${t("Also save the text in each picture (OCR)")}</span></label>`
    );
    if (!data) return;
    try {
      const pages = scopePages(data, doc);
      setStatus(data.ocr ? t("Saving the pictures and reading their text…") : t("Saving the pictures…"));
      await waitForDocMutations(doc);
      const resp = await withDocSession(doc, async () => {
        const fd = new FormData();
        appendDocToForm(fd, doc);
        fd.append("pages", pages.join(","));
        fd.append("ocr", data.ocr ? "true" : "false");
        const r = await apiFetch("/v1/pdf/extract-images", { method: "POST", body: fd });
        if (!r.ok) throw await apiError(r);
        return r;
      });
      const count = Number(resp.headers.get("X-Image-Count") || 0);
      if (!count) {
        setStatus(t("No pictures on these pages (drawings made of lines and text are not pictures)"), "error");
        return;
      }
      downloadBlob(await resp.blob(), `${doc.name.replace(/\.pdf$/i, "") || "document"}-images.zip`);
      setStatus(tn(count, "{n} picture saved (ZIP downloaded)", "{n} pictures saved (ZIP downloaded)"), "ok");
    } catch (err) {
      setStatus(String(err.message || err), "error");
    }
  },

  exportStructure: async () => {
    const doc = activeDoc();
    if (!doc) return;
    let installed = false;
    try {
      installed = (await apiGetJson("/v1/pdf/structure/status")).installed;
    } catch (_) {
      installed = false;
    }
    if (!installed) {
      setStatus(t("Exporting as Markdown or JSON needs the document structure add-on, which is not installed here"), "error");
      return;
    }
    const data = await showToolDialog(
      t("Export as Markdown or JSON"),
      `<fieldset class="choice-group">
         <legend>${t("Format")}</legend>
         <label class="choice"><input type="radio" data-field="format" name="format" value="markdown" checked /><span><strong>Markdown</strong><small>${t("Headings, paragraphs, lists and tables, in reading order; each picture linked")}</small></span></label>
         <label class="choice"><input type="radio" data-field="format" name="format" value="json" /><span><strong>JSON</strong><small>${t("The same blocks with their page and position, tables as rows of cells")}</small></span></label>
       </fieldset>
       ${pageScopeFields(doc)}
       <label class="check-option"><input type="checkbox" data-field="ocr" checked /><span>${t("Recognize the text in scanned pages and in pictures first (OCR)")}</span></label>
       <p class="field-hint">${t("Downloaded as a ZIP, with the pictures in an images folder. Takes a few seconds per page.")}</p>`
    );
    if (!data) return;
    try {
      const pages = scopePages(data, doc);
      const format = data.format === "json" ? "json" : "markdown";
      setStatus(t("Exporting… this takes a few seconds per page"));
      await waitForDocMutations(doc);
      const { blob } = await withDocSession(doc, () => {
        const fd = new FormData();
        appendDocToForm(fd, doc);
        fd.append("format", format);
        if (pages.length !== doc.pageCount) fd.append("pages", pages.join(","));
        fd.append("ocr", data.ocr ? "true" : "false");
        return apiPost("/v1/pdf/export", fd);
      });
      downloadBlob(blob, `${doc.name.replace(/\.pdf$/i, "") || "document"}-${format}.zip`);
      setStatus(t("Exported (ZIP downloaded)"), "ok");
    } catch (err) {
      setStatus(String(err.message || err), "error");
    }
  },

  extract: async () => {
    const doc = activeDoc();
    if (!doc) return;
    if (doc.contentView === "text") {
      showPdfView(doc);
      setStatus(t("Back to the PDF view"), "ok");
      return;
    }
    if (doc.extractedText != null) {
      showTextView(doc, doc.extractedText);
      setStatus(tn(doc.pageCount, "Text view · {n} page", "Text view · {n} pages"), "ok");
      return;
    }
    try {
      setStatus(t("Extracting text…"));
      await waitForDocMutations(doc);
      const data = await withDocSession(doc, () => {
        const fd = new FormData();
        appendDocToForm(fd, doc);
        return apiPost("/v1/pdf/extract", fd);
      });
      const text = data.text || t("(No text)");
      showTextView(doc, text);
      const pageCount = data.pageCount || doc.pageCount;
      setStatus(tn(pageCount, "Text view · {n} page", "Text view · {n} pages"), "ok");
    } catch (err) {
      setStatus(String(err.message || err), "error");
    }
  },

  unlock: async () => {
    const doc = activeDoc();
    if (!doc) return;
    const data = await showToolDialog(
      t("Remove restrictions"),
      `<p class="field-hint">${t("Removes restrictions such as on printing and copying. Saving creates a new file.")}</p>
       <label>${t("Password (leave empty if there is none)")}</label><input data-field="password" type="password" autocomplete="off" />`
    );
    if (!data) return;
    try {
      await runDocumentOperation(doc, {
        label: N_("Unlock"),
        endpoint: "/v1/pdf/unlock",
        fields: { password: data.password || "" },
        rename: `${doc.name.replace(/\.pdf$/i, "")}-unlocked.pdf`,
        detachFile: true,
      });
      setStatus(t("Unlocked"), "ok");
    } catch (err) {
      setStatus(String(err.message || err), "error");
    }
  },

  encrypt: async () => {
    const doc = activeDoc();
    if (!doc) return;
    const data = await showToolDialog(
      t("Password-protect"),
      `<p class="field-hint">${t("Downloads a copy that needs a password to open. This document stays as it is.")}</p>
       <label>${t("Password")}</label><input data-field="password" type="password" required autocomplete="new-password" />
       <label>${t("Enter it again")}</label><input data-field="confirm" type="password" required autocomplete="new-password" />`
    );
    if (!data) return;
    if (data.password !== data.confirm) {
      setStatus(t("The passwords don't match"), "error");
      return;
    }
    try {
      setStatus(t("Encrypting…"));
      await prepareDocumentForExport(doc);
      const { blob } = await withDocSession(doc, () => {
        const fd = new FormData();
        appendDocToForm(fd, doc);
        fd.append("user_password", data.password);
        return apiPost("/v1/pdf/encrypt", fd);
      });
      downloadBlob(blob, doc.name.replace(/\.pdf$/i, "") + "-encrypted.pdf");
      setStatus(t("Encrypted and downloaded"), "ok");
    } catch (err) {
      setStatus(String(err.message || err), "error");
    }
  },

  flatten: async () => {
    const doc = activeDoc();
    if (!doc) return;
    try {
      await runDocumentOperation(doc, {
        label: N_("Flatten"),
        endpoint: "/v1/pdf/flatten",
        fields: { engine: "qpdf" },
      });
      setStatus(t("Flattened"), "ok");
    } catch (err) {
      setStatus(String(err.message || err), "error");
    }
  },
};

function bindToolbar() {
  actionControls().forEach((btn) => {
    btn.addEventListener("click", () => {
      closeMenus();
      actions[btn.dataset.action]?.();
    });
  });
  bindMenus();
  document.querySelectorAll(".tool-btn.tool-mode").forEach((btn) => {
    btn.addEventListener("click", () => setEditMode(btn.dataset.mode));
  });
}

function bindNavigation() {
  let scrollSyncTimer = null;
  els.viewerScroll.addEventListener(
    "scroll",
    () => {
      if (scrollSyncTimer) cancelAnimationFrame(scrollSyncTimer);
      scrollSyncTimer = requestAnimationFrame(syncPageFromScroll);
    },
    { passive: true }
  );

  els.prevPageBtn.addEventListener("click", () => {
    const doc = activeDoc();
    const stride = pageStride();
    if (doc && doc.pageNum > 1) goToPage(doc.pageNum - stride, { smooth: isScrollViewMode() });
  });
  els.nextPageBtn.addEventListener("click", () => {
    const doc = activeDoc();
    const stride = pageStride();
    if (doc && doc.pageNum < doc.pageCount) goToPage(doc.pageNum + stride, { smooth: isScrollViewMode() });
  });
  els.zoomSelect.addEventListener("change", () => setZoom(els.zoomSelect.value));
  els.zoomInBtn.addEventListener("click", () => {
    const current = currentZoom();
    const next = ZOOM_STEPS.find((z) => z > current * 1.001) ?? ZOOM_MAX;
    setZoom(String(next));
  });
  els.zoomOutBtn.addEventListener("click", () => {
    const current = currentZoom();
    const prev = [...ZOOM_STEPS].reverse().find((z) => z < current * 0.999) ?? ZOOM_MIN;
    setZoom(String(prev));
  });
  document.querySelectorAll(".view-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".view-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.viewMode = btn.dataset.view;
      refreshViewer({ scrollAnchor: captureScrollAnchor() });
    });
  });
}

function bindFiles() {
  els.fileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (file) await openFile(file);
    e.target.value = "";
  });
  els.imagesInput.addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length) await openPictures(files);
  });
  els.mergeInput.addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length < 2) return setStatus(t("Choose at least two PDFs to combine"), "error");
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    try {
      const { blob } = await apiPost("/v1/pdf/merge", fd);
      await openFile(blobToFile(blob, "merged.pdf"));
      setStatus(t("PDFs combined"), "ok");
    } catch (err) {
      setStatus(String(err.message || err), "error");
    }
  });
  els.openTabBtn.addEventListener("click", () => pickAndOpenPdf());
  els.welcomeOpenBtn.addEventListener("click", () => pickAndOpenPdf());
  ["dragenter", "dragover"].forEach((ev) => {
    els.viewerDrop.addEventListener(ev, (e) => {
      e.preventDefault();
      els.viewerDrop.classList.add("drag-over");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    els.viewerDrop.addEventListener(ev, (e) => {
      e.preventDefault();
      els.viewerDrop.classList.remove("drag-over");
    });
  });
  els.viewerDrop.addEventListener("drop", async (e) => {
    const files = [...e.dataTransfer.files];
    // several pictures dropped together make one PDF
    if (files.length > 1 && files.every(isPicture)) await openPictures(files);
    else if (files[0]) await openFile(files[0]);
  });
}

/**
 * Settings → Reading tables, formulas and scans: the document reading model
 * (docs/OCR-MODELS.md). In the desktop app the model is chosen, downloaded and
 * removed here (desktop/src-tauri/src/addons.rs answers through
 * window.__openpdfAddons); elsewhere this shows what the server has.
 */
const reading = { status: null, busy: false };

function readingAction(action, what = "") {
  window.location.href = `openpdf-action://addons?do=${action}&what=${encodeURIComponent(what)}`;
}

function renderReading() {
  const box = document.getElementById("readingChoices");
  const section = document.getElementById("readingSection");
  const s = reading.status;
  if (!box || !section || !s) return;
  section.hidden = false;
  const gb = (mb) => (mb / 1024).toFixed(1);
  if (!s.desktop) {
    // a server: installed by whoever runs it
    box.innerHTML = s.ready
      ? `<p class="field-hint">${t("In use: {name}. Tables, formulas and scanned pages are read by it.", { name: escapeHtml(s.name) })}</p>`
      : `<p class="field-hint">${s.structure
          ? t("No reading model is installed on this server. To add one: scripts/install-model.sh")
          : t("Not installed on this server. To add it: scripts/install-structure.sh, then scripts/install-model.sh")}</p>`;
    return;
  }
  const tiers = s.tiers || {};
  const row = (value, title, detail, { disabled = false, extra = "" } = {}) =>
    `<label class="choice${disabled ? " is-disabled" : ""}"><input type="radio" name="readingModel" value="${value}" ${s.selected === value ? "checked" : ""} ${disabled || reading.busy ? "disabled" : ""} /><span><strong>${title}</strong><small>${detail}</small>${extra}</span></label>`;
  const parts = [row("off", t("Off"), s.structure
    ? t("Tables as Docling reads them; formulas left out")
    : t("Markdown and JSON export need the document reading component"),
  { extra: s.structure ? "" : `<button type="button" class="ghost-btn reading-btn" data-reading-install="structure" ${reading.busy ? "disabled" : ""}>${t("Install it")}</button>` })];
  for (const [name, tier] of Object.entries(tiers)) {
    const needGpu = !tier.cpuOk && (s.gpuFreeMb == null || s.gpuFreeMb < tier.minGpuMb);
    const label = name === "fast" ? t("Fast") : name === "best" ? t("Best") : escapeHtml(name);
    let detail = `${escapeHtml(tier.name)} · ${tier.downloaded ? t("downloaded") : t("{size} GB download", { size: gb(tier.sizeMb) })}`;
    if (tier.experimental) detail += ` · ${t("experimental")}`;
    if (needGpu) detail += ` · ${t("needs a graphics card with {size} GB free", { size: gb(tier.minGpuMb) })}`;
    else if (!tier.cpuOk) detail += ` · ${t("uses the graphics card")}`;
    else detail += ` · ${s.gpuFreeMb >= tier.minGpuMb ? t("uses the graphics card") : t("runs on the processor (slower)")}`;
    const remove = tier.downloaded && !reading.busy
      ? `<button type="button" class="ghost-btn reading-btn" data-reading-remove="${name}">${t("Remove ({size} GB)", { size: gb(tier.sizeMb) })}</button>`
      : "";
    parts.push(row(name, `${label}`, detail, { disabled: needGpu && !tier.downloaded, extra: remove }));
  }
  box.innerHTML = parts.join("");
  box.querySelectorAll('input[name="readingModel"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (reading.busy) return;
      reading.busy = true;
      showReadingProgress(t("Preparing…"));
      readingAction("select", input.value);
    });
  });
  box.querySelectorAll("[data-reading-install]").forEach((btn) => btn.addEventListener("click", () => {
    reading.busy = true;
    showReadingProgress(t("Preparing…"));
    readingAction("install", btn.dataset.readingInstall);
  }));
  box.querySelectorAll("[data-reading-remove]").forEach((btn) => btn.addEventListener("click", () => {
    reading.busy = true;
    showReadingProgress(t("Removing…"));
    readingAction("remove", btn.dataset.readingRemove);
  }));
}

function showReadingProgress(text, pct = null) {
  const progress = document.getElementById("readingProgress");
  if (!progress) return;
  progress.hidden = false;
  document.getElementById("readingError").hidden = true;
  if (text) document.getElementById("readingStep").textContent = text;
  if (pct != null) progress.querySelector(".ocr-progress-bar span").style.width = `${pct}%`;
  renderReading();
}

window.__openpdfAddons = ({ kind, text, status }) => {
  if (status) reading.status = status;
  if (kind === "line") {
    const pct = /^PCT (\d+)/.exec(text || "");
    if (pct) return showReadingProgress(null, Number(pct[1]));
    const step = /^STEP \d+\/\d+ (.*)/.exec(text || "");
    showReadingProgress(step ? step[1] : text);
    return;
  }
  if (kind === "done" || kind === "error") {
    reading.busy = false;
    document.getElementById("readingProgress").hidden = true;
    const error = document.getElementById("readingError");
    error.hidden = kind !== "error";
    if (kind === "error") error.textContent = text;
    else setStatus(t("Reading settings saved"), "ok");
  }
  renderReading();
};

async function refreshReading() {
  if (window.__openpdfDesktop) {
    if (!reading.busy) readingAction("status");
    return;
  }
  try {
    const st = await apiGetJson("/v1/pdf/structure/status");
    if (!st.installed && !window.__OPENPDF_GATEWAY) {
      // the browser version, or a server without the component: nothing to choose here
      const browser = (await apiGetJson("/health").catch(() => ({}))).mode === "browser";
      if (browser) return;
    }
    const model = st.installed ? await apiGetJson("/v1/pdf/structure/model").catch(() => ({})) : {};
    reading.status = { desktop: false, structure: !!st.installed, ready: !!model.ready, name: model.model || "" };
    renderReading();
  } catch (_) {
    /* not available here */
  }
}

function openSettings() {
  els.settingsDialog.showModal();
  refreshReading();
}

function bindSettings() {
  els.settingsBtn.addEventListener("click", () => openSettings());
  els.apiKey.addEventListener("change", () => {
    localStorage.setItem(API_KEY_STORAGE, els.apiKey.value.trim());
  });
  const savedKey = localStorage.getItem(API_KEY_STORAGE);
  if (savedKey) els.apiKey.value = savedKey;
  if (els.saveModeSelect) {
    els.saveModeSelect.value = getSaveMode();
    els.saveModeSelect.addEventListener("change", () => {
      setSaveMode(els.saveModeSelect.value);
    });
  }
  els.settingsDialog.querySelectorAll('input[name="openStart"]').forEach((radio) => {
    radio.checked = radio.value === getOpenStart();
    radio.addEventListener("change", () => {
      if (radio.checked) setOpenStart(radio.value);
    });
  });
  const radios = els.settingsDialog.querySelectorAll('input[name="saveMode"]');
  radios.forEach((radio) => {
    radio.checked = radio.value === getSaveMode();
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      setSaveMode(radio.value);
      if (els.saveModeSelect) els.saveModeSelect.value = radio.value;
    });
  });
}

// ---------------------------------------------------------------- menus

function closeMenus(except = null) {
  document.querySelectorAll(".menu:not([hidden])").forEach((menu) => {
    if (menu === except) return;
    menu.hidden = true;
    document.querySelector(`[data-menu="${menu.id}"]`)?.setAttribute("aria-expanded", "false");
  });
}

function openMenu(button) {
  const menu = document.getElementById(button.dataset.menu);
  if (!menu) return;
  const opening = menu.hidden;
  closeMenus(menu);
  menu.hidden = !opening;
  button.setAttribute("aria-expanded", String(opening));
  if (opening) {
    (menu.querySelector(".menu-item.current") || menu.querySelector(".menu-item:not(:disabled)"))?.focus();
  }
}

function bindMenus() {
  document.querySelectorAll("[data-menu]").forEach((button) => {
    button.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openMenu(button);
    });
    button.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        const menu = document.getElementById(button.dataset.menu);
        if (menu?.hidden) openMenu(button);
      }
    });
  });
  document.querySelectorAll(".menu").forEach((menu) => {
    menu.addEventListener("keydown", (ev) => {
      const items = [...menu.querySelectorAll(".menu-item:not(:disabled)")];
      const at = items.indexOf(document.activeElement);
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        const next = ev.key === "ArrowDown" ? at + 1 : at - 1;
        items[(next + items.length) % items.length]?.focus();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        closeMenus();
        document.querySelector(`[data-menu="${menu.id}"]`)?.focus();
      } else if (ev.key === "Tab") {
        closeMenus();
      }
    });
  });
  document.addEventListener("mousedown", (ev) => {
    if (!ev.target.closest(".menu, [data-menu]")) closeMenus();
  });
  window.addEventListener("blur", () => closeMenus());
}

function bindPageInput() {
  if (!els.pageInput) return;
  const jump = () => {
    const doc = activeDoc();
    if (!doc) return;
    const n = parseInt(els.pageInput.value, 10);
    if (Number.isFinite(n)) goToPage(Math.max(1, Math.min(doc.pageCount, n)), { smooth: false });
    els.pageInput.value = String(doc.pageNum);
  };
  els.pageInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      jump();
      els.pageInput.blur();
    } else if (ev.key === "Escape") {
      els.pageInput.value = String(activeDoc()?.pageNum || "");
      els.pageInput.blur();
    }
  });
  els.pageInput.addEventListener("focus", () => els.pageInput.select());
  els.pageInput.addEventListener("blur", jump);
  els.toolHintDone?.addEventListener("click", () => setEditMode("select"));
  els.propsCloseBtn?.addEventListener("click", () => closePropsPanel());
}

function bindPrint() {
  els.printCloseBtn.addEventListener("click", () => {
    els.printFrame.src = "about:blank";
    els.printDialog.close();
  });
  els.printRunBtn.addEventListener("click", () => {
    try {
      els.printFrame.contentWindow.focus();
      els.printFrame.contentWindow.print();
    } catch (err) {
      setStatus(t("Printing failed: {error}", { error: err.message }), "error");
    }
  });
}

function updatePagesPanelToggleIcon() {
  window.PdfIcons?.mount(els.togglePagesBtn, "panel-left", 16);
  const label = state.pagesPanelOpen ? t("Hide thumbnails") : t("Show thumbnails");
  els.togglePagesBtn.title = label;
  els.togglePagesBtn.setAttribute("aria-label", label);
  els.togglePagesBtn.setAttribute("aria-pressed", String(state.pagesPanelOpen));
}

function bindPagesPanel() {
  updatePagesPanelToggleIcon();
  els.togglePagesBtn.addEventListener("click", () => {
    state.pagesPanelOpen = !state.pagesPanelOpen;
    els.app.querySelector(".workspace").classList.toggle("no-pages", !state.pagesPanelOpen);
    updatePagesPanelToggleIcon();
  });
}

function bindTextStyleToolbar() {
  if (!els.textFontSizeSelect || !els.textFontFamilySelect) return;
  els.textFontSizeSelect.value = String(state.textFontSize);
  els.textFontFamilySelect.value = state.textFontFamily;

  // back to typing in the box, with the caret or selection it had
  const resumeTyping = () => {
    const ctx = state.inlineTextEditor;
    if (!ctx) return;
    ctx.editor.focus();
    if (ctx.savedRange) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(ctx.savedRange);
    }
  };
  els.textFontSizeSelect.addEventListener("change", () => {
    if (state._textStyleUiSync) return;
    if (!isTextInputMode() && !state.inlineTextEditor) return;
    state.textFontSize = Number(els.textFontSizeSelect.value) || 14;
    if (state.inlineTextEditor) {
      const scale = state.inlineTextEditor.scale;
      const ctx = state.inlineTextEditor;
      if (ctx.keepBaseline && ctx.region) {
        // the baseline is drawn 0.947 em below the box top: move the top by the change
        const shift = (state.textFontSize - (ctx.fontSize || state.textFontSize)) * 0.947;
        ctx.region = { ...ctx.region, y: ctx.region.y - shift };
        ctx.editor.style.top = `${parseFloat(ctx.editor.style.top) - shift * scale}px`;
      }
      state.inlineTextEditor.fontSize = state.textFontSize;
      state.inlineTextEditor.editor.style.fontSize = `${state.textFontSize * scale}px`;
      state.inlineTextEditor.editor.style.lineHeight = `${state.textFontSize * scale * 1.2}px`;
      resumeTyping();
    }
  });

  els.textFontFamilySelect.addEventListener("change", () => {
    if (state._textStyleUiSync) return;
    if (!isTextInputMode() && !state.inlineTextEditor) return;
    state.textFontFamily = els.textFontFamilySelect.value || "Helvetica";
    const ctx = state.inlineTextEditor;
    if (ctx) {
      ctx.family = state.textFontFamily;
      ctx.familyChosen = true;
      ctx.editor.style.fontFamily = state.textFontFamily;
      resumeTyping();
    }
  });

  // leaving the menus for anything but the box: the box is done
  for (const select of [els.textFontSizeSelect, els.textFontFamilySelect]) {
    select.addEventListener("blur", () => {
      setTimeout(() => {
        const ctx = state.inlineTextEditor;
        if (!ctx) return;
        const active = document.activeElement;
        if (active === ctx.editor || els.textStyleToolbar?.contains(active)) return;
        ctx.commit?.();
      }, 150);
    });
  }

  document.addEventListener("selectionchange", () => {
    if (!isSelectMode() || state.inlineTextEditor) return;
    clearTimeout(state._textStyleSyncTimer);
    state._textStyleSyncTimer = setTimeout(syncTextStyleToolbar, 60);
  });
}

function bindKeyboard() {
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const active = document.activeElement;
    const inNativeField =
      active &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        (active.isContentEditable && active !== state.inlineTextEditor?.editor));

    const key = (e.key || "").toLowerCase();
    const typing = inNativeField || !!state.inlineTextEditor || active?.tagName === "SELECT";

    if (mod && key === "o") {
      e.preventDefault();
      actions.open();
    }
    if (mod && key === "s") {
      e.preventDefault();
      actions.save();
    }
    if (mod && key === "p") {
      e.preventDefault();
      actions.print();
    }
    if (mod && activeDoc() && (key === "=" || key === "+" || key === "-" || key === "0")) {
      e.preventDefault();
      if (key === "-") els.zoomOutBtn.click();
      else if (key === "0") setZoom("1");
      else els.zoomInBtn.click();
      return;
    }
    // text selected on the page: the tool's letter acts on it (H or Ctrl+H highlight, W edit, R redact)
    const selectionBar = document.getElementById("selectionToolbar");
    if (!e.altKey && !typing && activeDoc() && selectionBar && !selectionBar.classList.contains("hidden")
        && (key === "h" || (!mod && (key === "w" || key === "r")))) {
      e.preventDefault();
      if (key === "h") highlightSelection();
      else if (key === "w") coverSelection();
      else redactSelection();
      return;
    }
    if (!mod && !e.altKey && !typing && key === "h" && state.editMode === "highlight") {
      e.preventDefault();
      cycleHighlightShape();
      return;
    }
    if (!mod && !e.altKey && !typing && activeDoc() && /^[a-z]$/.test(key)) {
      const toolBtn = document.querySelector(`.tool-tray [data-key="${key.toUpperCase()}"]`);
      if (toolBtn && !toolBtn.disabled) {
        e.preventDefault();
        if (toolBtn.dataset.mode) setEditMode(toolBtn.dataset.mode);
        else actions[toolBtn.dataset.action]?.();
        return;
      }
    }
    if (mod && key === "f" && activeDoc()) {
      e.preventDefault();
      openFindBar();
      return;
    }
    if (mod && !typing && activeDoc() && ((key === "z" && e.shiftKey) || key === "y")) {
      e.preventDefault();
      redoLastStep();
      return;
    }
    if (mod && !typing && activeDoc() && key === "z") {
      e.preventDefault();
      undoLastStep();
      return;
    }
    if (mod && key === "c" && !inNativeField) {
      if (activeDoc()) {
        e.preventDefault();
        actions.copy();
      }
    }
    if (mod && key === "v" && !inNativeField) {
      if (
        activeDoc() &&
        (state.editMode === "insert-image" ||
          state.pendingImageOverlay ||
          state.inlineTextEditor ||
          (isTextInputMode() && state.selectedPlacementId))
      ) {
        e.preventDefault();
        actions.paste();
      }
    }
    if (e.key === "Enter" && state.pendingImageOverlay) {
      e.preventDefault();
      commitPendingImageOverlay();
    }
    if (
      (e.key === "Delete" || e.key === "Backspace") &&
      !mod &&
      !inNativeField &&
      !state.inlineTextEditor
    ) {
      if (state.editMode === "annotate" && state.selectedCalloutId) {
        e.preventDefault();
        deleteCallout(state.selectedCalloutId);
      } else if (isTextInputMode() && state.selectedPlacementId) {
        e.preventDefault();
        deleteSelectedPlacement();
      }
    }
    if (e.key === "?" && !typing && !mod) {
      e.preventDefault();
      const help = document.getElementById("helpDialog");
      help?.showModal();
      help?.querySelector(".help-card")?.focus();
      return;
    }
    if (e.key === "Escape") {
      const doc = activeDoc();
      hideSelectionToolbar();
      if (state.find.open && (active === els.findInput || !typing)) {
        closeFindBar();
        return;
      }
      if (state.pendingImageOverlay) {
        dismissPendingImageOverlay();
        setStatus(t("Image insertion canceled"), "ok");
        return;
      }
      if (doc?.contentView === "text") {
        showPdfView(doc);
        setStatus(t("Back to the PDF view"), "ok");
      } else if (doc) {
        setEditMode("select");
      } else {
        state.editMode = null;
        syncEditModeUI();
      }
    }
    if (!typing && !mod && !e.altKey) {
      if (e.key === "ArrowLeft") els.prevPageBtn.click();
      if (e.key === "ArrowRight") els.nextPageBtn.click();
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (!state.docs.some(isDocDirty)) return;
    e.preventDefault();
    e.returnValue = "";
  });
}

// ---------------------------------------------------------------- toasts and progress

function flashSaved() {
  const btn = document.querySelector('.tool-btn[data-action="save"]');
  if (!btn) return;
  btn.classList.add("saved");
  setTimeout(() => btn.classList.remove("saved"), 1600);
}

function showToast(message, { type = "", action = null, onAction = null, duration = 4500 } = {}) {
  const host = document.getElementById("toasts");
  if (!host) return;
  host.querySelectorAll(".toast").forEach((old) => old.remove());
  const toast = document.createElement("div");
  toast.className = `toast ${type}`.trim();
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  const text = document.createElement("span");
  text.className = "toast-text";
  text.textContent = message;
  toast.appendChild(text);
  if (action && onAction) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action;
    btn.addEventListener("click", () => {
      toast.remove();
      onAction();
    });
    toast.appendChild(btn);
  }
  host.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  const timer = setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 200);
  }, type === "error" ? Math.max(duration, 7000) : duration);
  toast.addEventListener("mouseenter", () => clearTimeout(timer));
}

/** Thin progress line under the toolbar while a long job runs. */
function setBusy(on, label = "") {
  const bar = document.getElementById("busyBar");
  if (!bar) return;
  state._busyCount = Math.max(0, (state._busyCount || 0) + (on ? 1 : -1));
  bar.classList.toggle("hidden", state._busyCount === 0);
  if (label) bar.setAttribute("aria-label", label);
}

// ---------------------------------------------------------------- acting on selected text

/** The selected text as rectangles on the page, in PDF points from the top-left. */
function selectionRegions() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return [];
  const range = sel.getRangeAt(0);
  const regions = [];
  for (const rect of range.getClientRects()) {
    if (rect.width < 2 || rect.height < 2) continue;
    const shell = document.elementFromPoint(rect.left + 1, rect.top + rect.height / 2)?.closest(".page-shell")
      || [...els.viewerPages.querySelectorAll(".page-shell")].find((el) => {
        const b = el.getBoundingClientRect();
        return rect.top >= b.top - 1 && rect.bottom <= b.bottom + 1 && rect.left >= b.left - 1;
      });
    if (!shell) continue;
    const bounds = shell.getBoundingClientRect();
    const scale = Number(shell.dataset.scale) || 1;
    const pageIndex = Number(shell.dataset.pageIndex);
    const last = regions[regions.length - 1];
    const region = {
      pageIndex,
      x: (rect.left - bounds.left) / scale,
      y: (rect.top - bounds.top) / scale,
      width: rect.width / scale,
      height: rect.height / scale,
      shell,
      pixel: { left: rect.left - bounds.left, top: rect.top - bounds.top, width: rect.width, height: rect.height },
    };
    // merge pieces of the same line
    if (last && last.pageIndex === pageIndex && Math.abs(last.y - region.y) < region.height * 0.5) {
      const left = Math.min(last.x, region.x);
      const right = Math.max(last.x + last.width, region.x + region.width);
      last.x = left;
      last.width = right - left;
      last.pixel.left = Math.min(last.pixel.left, region.pixel.left);
      last.pixel.width = Math.max(last.pixel.left + last.pixel.width, region.pixel.left + region.pixel.width) - last.pixel.left;
      continue;
    }
    regions.push(region);
  }
  return regions;
}

async function highlightSelection() {
  const doc = activeDoc();
  const regions = selectionRegions();
  if (!doc || !regions.length) return;
  window.getSelection()?.removeAllRanges();
  hideSelectionToolbar();
  await highlightRegions(doc, regions);
}

/** Highlights over several boxes (each with its shell and pixel box), one undo step. */
async function highlightRegions(doc, regions) {
  const overlays = regions.map((r) => addOptimisticHighlight(r.shell, r.pixel.left, r.pixel.top, r.pixel.width, r.pixel.height));
  setStatus(t("Saving highlight…"));
  try {
    let first = null;
    let last = null;
    // one request (one highlight, one undo step) per page with all its lines:
    // each request loads and saves the whole file, so line by line was slow
    const byPage = new Map();
    for (const r of regions) byPage.set(r.pageIndex, [...(byPage.get(r.pageIndex) || []), r]);
    for (const group of byPage.values()) {
      const result = await queueDocMutation(doc, () => {
        const fd = buildRegionForm(doc, group[0]);
        if (group.length > 1) fd.append("rects", JSON.stringify(group.map((r) => [r.x, r.y, r.width, r.height])));
        return apiPost("/v1/pdf/highlight", fd);
      });
      first = first || result;
      last = result;
    }
    doc.dirty = true;
    const pages = [...new Set(regions.map((r) => r.pageIndex + 1))];
    if (first && last) {
      checkpointEditorObjects(doc);
      pushUndo(doc, { type: "server", label: N_("Highlight"), before: first.previous_revision, after: last.revision, pages });
    }
    for (const pageNum of pages) markPageStale(doc, pageNum);
    await refreshStalePages(doc, { background: true, silent: true });
    setStatus(t("Highlight added"), "ok");
  } catch (err) {
    overlays.forEach((el) => el.remove());
    setStatus(String(err.message || err), "error");
    showToast(String(err.message || err), { type: "error" });
  }
}

/**
 * The "Text" highlight: the lines of the page's text inside a dragged box, each
 * cut to the box at character boundaries, highlighted as one step.
 */
async function highlightTextIn(shell, box, meta) {
  const doc = activeDoc();
  if (!doc) return;
  const items = (await pageTextItems(shell)) || [];
  const lines = [];
  for (const it of items) {
    const top = it.base - it.h * 0.95;
    const bottom = it.base + it.h * 0.25;
    const middle = (top + bottom) / 2;
    if (middle < box.top || middle > box.top + box.height) continue;
    const count = Math.max(1, [...it.str].length);
    const cw = (it.right - it.left) / count;
    const from = Math.max(0, Math.floor((Math.max(it.left, box.left) - it.left) / cw + 0.35));
    const to = Math.min(count, Math.ceil((Math.min(it.right, box.left + box.width) - it.left) / cw - 0.35));
    if (to <= from) continue;
    const x0 = it.left + from * cw;
    const x1 = it.left + to * cw;
    const line = lines.find((l) => Math.abs(l.base - it.base) < it.h * 0.3);
    if (line) {
      line.left = Math.min(line.left, x0);
      line.right = Math.max(line.right, x1);
      line.top = Math.min(line.top, top);
      line.bottom = Math.max(line.bottom, bottom);
    } else {
      lines.push({ base: it.base, h: it.h, left: x0, right: x1, top, bottom });
    }
  }
  if (!lines.length) {
    setStatus(t("No text in that area; choose Box to highlight any area"), "error");
    return;
  }
  const regions = lines.map((l) => {
    const pixel = { left: l.left, top: l.top, width: l.right - l.left, height: l.bottom - l.top };
    return { ...canvasToPdfRect(shell, l.left, l.top, l.right, l.bottom, meta), shell, pixel };
  });
  await highlightRegions(doc, regions);
}

/** The "Pen" highlight: a stroke drawn while the mouse button is down. */
function startHighlighterStroke(ev, shell, meta) {
  const bounds = shell.getBoundingClientRect();
  const scale = Number(shell.dataset.scale) || meta.scale || 1;
  const width = highlightPenWidth();
  const pts = [[ev.clientX - bounds.left, ev.clientY - bounds.top]];
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("class", "highlight-overlay pen-stroke");
  Object.assign(svg.style, { left: "0px", top: "0px", width: `${bounds.width}px`, height: `${bounds.height}px` });
  svg.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
  const line = document.createElementNS(svgNs, "polyline");
  line.setAttribute("stroke-width", String(width * scale));
  svg.append(line);
  shell.append(svg);
  const draw = () => line.setAttribute("points", (pts.length > 1 ? pts : [pts[0], [pts[0][0] + 0.1, pts[0][1]]]).map((p) => p.join(",")).join(" "));
  draw();
  const move = (e) => {
    const p = [e.clientX - bounds.left, e.clientY - bounds.top];
    const last = pts[pts.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 2) {
      pts.push(p);
      draw();
    }
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    // the preview keeps only its own box, so erasing and clearing find it like the others
    const pad = (width * scale) / 2 + 1;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const left = Math.min(...xs) - pad;
    const top = Math.min(...ys) - pad;
    const w = Math.max(...xs) + pad - left;
    const h = Math.max(...ys) + pad - top;
    Object.assign(svg.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
    svg.setAttribute("viewBox", `${left} ${top} ${w} ${h}`);
    commitHighlighterStroke(shell, meta, pts, width, svg);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

async function commitHighlighterStroke(shell, meta, pts, width, preview) {
  const doc = activeDoc();
  if (!doc) return;
  const points = pts.map(([x, y]) => {
    const p = canvasToPdfPoint(x, y, meta);
    return [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100];
  });
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const region = {
    pageIndex: meta.pageIndex,
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
  setStatus(t("Saving highlight…"));
  try {
    const fd = buildRegionForm(doc, region);
    fd.append("points", JSON.stringify([points]));
    fd.append("stroke_width", String(width));
    const result = await queueDocMutation(doc, () => apiPost("/v1/pdf/highlight", fd));
    doc.dirty = true;
    recordServerStep(doc, result, N_("Highlight"), [region.pageIndex + 1]);
    markPageStale(doc, region.pageIndex + 1);
    setStatus(t("Highlight added"), "ok");
  } catch (err) {
    preview.remove();
    setStatus(String(err.message || err), "error");
  }
}

/**
 * The page's own text at a click (pixels in the page shell). First the run:
 * the pdf.js text item under the point, joined with its neighbours on the
 * same line while the gaps are word gaps. Then, when the lines above and below
 * continue it (same size, even line spacing, same column), the paragraph.
 * Horizontal text only. Returns the box as pixels and as a page region, the
 * text, its font size and pdf.js font name, and for a paragraph its layout
 * (line spacing, width, alignment); or null.
 */
/** The page's own text pieces (not what OpenPDF drew from its boxes), upright
 *  ones only, with their place on the page picture in pixels. */
async function pageTextItems(shell) {
  const doc = activeDoc();
  if (!doc?.pdfDoc) return null;
  const page = await doc.pdfDoc.getPage(Number(shell.dataset.page));
  const scale = Number(shell.dataset.scale) || 1;
  const viewport = page.getViewport({ scale });
  const content = await page.getTextContent({ includeMarkedContent: true });
  const items = [];
  const marks = [];
  for (const item of content.items) {
    if (item.type === "beginMarkedContent" || item.type === "beginMarkedContentProps") {
      marks.push(item.tag);
      continue;
    }
    if (item.type === "endMarkedContent") {
      marks.pop();
      continue;
    }
    if (marks.includes("OpenPDFEdits")) continue;
    if (!item.str || !item.str.trim()) continue;
    const tr = pdfjsLib.Util.transform(viewport.transform, item.transform);
    if (Math.abs(tr[1]) > 0.01 * Math.abs(tr[0]) || tr[0] <= 0) continue; // rotated text
    const h = Math.hypot(tr[2], tr[3]);
    items.push({ str: item.str, left: tr[4], right: tr[4] + item.width * scale, base: tr[5], h, fontName: item.fontName });
  }
  return items;
}

/** The line of the page's text level with a point (a form's label row): the
 *  nearest piece on it, preferring the label to the left of the point. */
async function textRowAt(shell, sx, sy) {
  try {
    const items = await pageTextItems(shell);
    let best = null;
    for (const it of items || []) {
      if (sy < it.base - it.h * 1.1 || sy > it.base + it.h * 0.5) continue;
      const dx = sx >= it.right ? sx - it.right : sx <= it.left ? (it.left - sx) * 2 : 0;
      if (dx > 450) continue;
      const score = Math.abs(sy - (it.base - it.h * 0.35)) * 4 + dx;
      if (!best || score < best.score) best = { ...it, score };
    }
    return best;
  } catch (_) {
    return null;
  }
}

async function textRunAt(shell, sx, sy) {
  const doc = activeDoc();
  if (!doc?.pdfDoc) return null;
  try {
    const scale = Number(shell.dataset.scale) || 1;
    const items = await pageTextItems(shell);
    if (!items) return null;
    const hit = items.find(
      (it) => sx >= it.left - 1 && sx <= it.right + 1 && sy >= it.base - it.h && sy <= it.base + it.h * 0.25
    );
    if (!hit) return null;

    // runs: items on one baseline, split where the gap is wider than a word gap
    const runsOn = (base, h) => {
      const row = items
        .filter((it) => Math.abs(it.base - base) < h * 0.2 && Math.abs(it.h - h) < h * 0.2)
        .sort((a, b) => a.left - b.left);
      const runs = [];
      for (const it of row) {
        const last = runs[runs.length - 1];
        if (last && it.left - last.right < h * 1.2) {
          const space = it.left - last.right > h * 0.15 && !/\s$/.test(last.text) && !/^\s/.test(it.str);
          last.text += (space ? " " : "") + it.str;
          last.right = Math.max(last.right, it.right);
          last.parts.push(it);
        } else {
          runs.push({ left: it.left, right: it.right, base: it.base, h: it.h, text: it.str, parts: [it] });
        }
      }
      return runs;
    };
    const run = runsOn(hit.base, hit.h).find((r) => r.parts.includes(hit));
    if (!run) return null;

    // the paragraph: follow lines up and down while they look like the same block
    let lines = [run];
    const baselines = [...new Set(items.map((it) => Math.round(it.base * 2) / 2))].sort((a, b) => a - b);
    const lineNear = (from, dir) => {
      const candidates = baselines.filter((b) => (dir > 0 ? b > from.base + from.h * 0.5 : b < from.base - from.h * 0.5));
      if (!candidates.length) return null;
      const next = dir > 0 ? candidates[0] : candidates[candidates.length - 1];
      const gap = Math.abs(next - from.base);
      if (gap > from.h * 2.2) return null;
      const overlap = (r) => Math.min(r.right, run.right) - Math.max(r.left, run.left);
      const best = runsOn(next, from.h)
        .filter((r) => Math.abs(r.h - from.h) < from.h * 0.12)
        .sort((a, b) => overlap(b) - overlap(a))[0];
      if (!best || overlap(best) < Math.min(run.right - run.left, best.right - best.left) * 0.5) return null;
      return { line: best, gap };
    };
    let spacing = null;
    for (const dir of [-1, 1]) {
      let from = run;
      for (let guard = 0; guard < 60; guard += 1) {
        const next = lineNear(from, dir);
        if (!next) break;
        if (spacing != null && Math.abs(next.gap - spacing) > spacing * 0.15) break;
        spacing = spacing ?? next.gap;
        if (dir < 0) lines.unshift(next.line);
        else lines.push(next.line);
        from = next.line;
      }
    }

    // A line that ends early (the next line's first word would have fitted) was ended
    // by hand: lines of a list or an address, not a wrapped paragraph. Keep only the
    // lines between such breaks around the one clicked.
    if (lines.length > 1) {
      const blockRight = Math.max(...lines.map((l) => l.right));
      const firstWordWidth = (l) => {
        const t = l.text.trim();
        const perChar = (l.right - l.left) / Math.max(1, t.length);
        const cjk = /^[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(t);
        return (cjk ? 1 : (t.split(/\s+/)[0] || "").length) * perChar;
      };
      const at = lines.indexOf(run);
      let start = 0;
      let end = lines.length - 1;
      for (let i = 0; i < lines.length - 1; i += 1) {
        const room = blockRight - lines[i].right;
        if (room > firstWordWidth(lines[i + 1]) + hit.h * 0.25) {
          if (i < at) start = i + 1;
          else {
            end = i;
            break;
          }
        }
      }
      lines = lines.slice(start, end + 1);
    }

    const h = hit.h;
    // a first line indented further than the others (by at least half a line height)
    const restLeft = lines.length > 1 ? Math.min(...lines.slice(1).map((l) => l.left)) : lines[0].left;
    const indent = lines.length > 1 && lines[0].left - restLeft > h * 0.5 ? lines[0].left - restLeft : 0;
    const left = Math.min(...lines.map((l) => l.left));
    const right = Math.max(...lines.map((l) => l.right));
    const top = lines[0].base - h;
    const bottom = lines[lines.length - 1].base + h * 0.25;
    let text = lines[0].text;
    for (const line of lines.slice(1)) {
      // a word broken at the end of a line ("infor-" + "mation") is joined again
      if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(line.text)) text = text.slice(0, -1) + line.text;
      else if (/[　-鿿＀-￯]$/.test(text)) text += line.text;
      else text += " " + line.text;
    }
    const tolerance = h * 0.6;
    const body = lines.slice(0, -1);
    const leftAligned = lines.every((l, i) => Math.abs(l.left - (i === 0 ? left + indent : left)) < tolerance);
    const rightAligned = body.length > 0 && body.every((l) => Math.abs(l.right - right) < tolerance);
    const centered = !leftAligned && lines.every((l) => Math.abs((l.left + l.right) / 2 - (left + right) / 2) < tolerance);
    const align = leftAligned && rightAligned ? "justify" : leftAligned ? "left" : centered ? "center" : rightAligned ? "right" : "left";

    const boxLeft = left - 3; // the box pads its text by 3px: keep the text where it was
    const region = {
      pageIndex: Number(shell.dataset.page) - 1,
      x: boxLeft / scale,
      y: top / scale,
      width: (right + 1 - boxLeft) / scale,
      height: (bottom - top) / scale,
    };
    return {
      text: text.trim(),
      fontName: hit.fontName || "",
      fontSize: Math.max(4, Math.round((hit.h / scale) * 2) / 2),
      pixel: { left: boxLeft, top, width: right + 1 - boxLeft, height: bottom - top },
      region,
      paragraph:
        lines.length > 1
          ? {
              lineHeight: spacing / scale,
              width: (right - left) / scale,
              left: (left - boxLeft) / scale,
              indent: indent / scale,
              align,
              lines: lines.length,
            }
          : null,
    };
  } catch (_) {
    return null;
  }
}

/** Edit the selected text: a text box over it, prefilled with it. */
function coverSelection() {
  const regions = selectionRegions();
  if (!regions.length) return;
  const text = window.getSelection()?.toString() || "";
  const first = regions[0];
  const lastOnPage = regions.filter((r) => r.pageIndex === first.pageIndex);
  const left = Math.min(...lastOnPage.map((r) => r.pixel.left));
  const top = Math.min(...lastOnPage.map((r) => r.pixel.top));
  const right = Math.max(...lastOnPage.map((r) => r.pixel.left + r.pixel.width));
  const bottom = Math.max(...lastOnPage.map((r) => r.pixel.top + r.pixel.height));
  const scale = Number(first.shell.dataset.scale) || 1;
  const lineHeight = first.height;
  window.getSelection()?.removeAllRanges();
  hideSelectionToolbar();
  state.textFontSize = Math.max(8, Math.round(lineHeight * 0.8));
  setEditMode("cover-text");
  const pixel = { left, top, width: right - left, height: bottom - top };
  const region = { pageIndex: first.pageIndex, x: left / scale, y: top / scale, width: (right - left) / scale, height: (bottom - top) / scale };
  openInlineTextEditor(first.shell, pixel, region, {
    mode: "cover",
    style: { origin: { ...region } },
    // grows when the new text is longer; never smaller than what it replaces
    preserveBounds: false,
    initialText: text.replace(/\s*\n\s*/g, " ").trim(),
    fontSize: state.textFontSize,
  });
}

// ---------------------------------------------------------------- redaction
// Redact marks areas and words; nothing changes until "Apply redaction". Then
// the server removes what is marked for good (/v1/pdf/redact), together with
// hidden copies (form values, annotations, metadata), and checks the result.
// The marks live only in the browser: Save asks first when some are pending.

const REDACTION_PRESETS = [
  {
    id: "email",
    label: N_("Email addresses"),
    re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    keep: () => true,
  },
  {
    id: "phone",
    label: N_("Phone numbers"),
    re: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]\d{2,4}){1,3}/g,
    keep: (s) => {
      const digits = s.replace(/\D/g, "").length;
      return digits >= 7 && digits <= 15;
    },
  },
  {
    id: "number",
    label: N_("ID and account numbers"),
    re: /\d[\d -]{4,}\d/g,
    keep: (s) => s.replace(/\D/g, "").length >= 6,
  },
];

function redactionOf(doc) {
  if (!doc.redaction) doc.redaction = { areas: [], terms: [], caseSensitive: false, removeMetadata: false };
  return doc.redaction;
}

function hasPendingRedaction(doc) {
  const r = doc?.redaction;
  return !!(r && (r.areas.length || r.terms.length));
}

function addRedactionArea(region, { silent = false } = {}) {
  const doc = activeDoc();
  if (!doc || !(region.width > 1) || !(region.height > 1)) return;
  redactionOf(doc).areas.push({
    id: crypto.randomUUID(),
    pageIndex: region.pageIndex,
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
  });
  renderRedactionMarks();
  refreshRedactionPanel();
  if (!silent) setStatus(t("Marked for redaction; apply the redaction to remove it"), "ok");
}

function removeRedactionArea(id) {
  const doc = activeDoc();
  if (!doc?.redaction) return;
  doc.redaction.areas = doc.redaction.areas.filter((a) => a.id !== id);
  renderRedactionMarks();
  refreshRedactionPanel();
}

function addRedactionTerms(terms) {
  const doc = activeDoc();
  if (!doc) return 0;
  const r = redactionOf(doc);
  let added = 0;
  for (const raw of terms) {
    const term = String(raw || "").replace(/\s+/g, " ").trim();
    if (!term || r.terms.includes(term)) continue;
    r.terms.push(term);
    added += 1;
  }
  refreshRedactionPanel();
  return added;
}

/** Red boxes over the marked areas (the marks are not part of the PDF). */
function renderRedactionMarks() {
  els.viewerPages.querySelectorAll(".redaction-mark").forEach((node) => node.remove());
  const doc = activeDoc();
  if (!doc?.redaction?.areas.length || doc.contentView === "text") return;
  const editable = state.editMode === "redact";
  for (const area of doc.redaction.areas) {
    const shell = els.viewerPages.querySelector(`.page-shell[data-page="${area.pageIndex + 1}"]`);
    if (!shell) continue;
    const scale = Number(shell.dataset.scale) || 1;
    const el = document.createElement("div");
    el.className = "redaction-mark";
    el.style.left = `${area.x * scale}px`;
    el.style.top = `${area.y * scale}px`;
    el.style.width = `${area.width * scale}px`;
    el.style.height = `${area.height * scale}px`;
    el.title = t("Marked for redaction");
    if (editable) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "placement-delete-btn redaction-mark-delete";
      del.textContent = "×";
      del.title = t("Remove this mark");
      del.setAttribute("aria-label", t("Remove this mark"));
      del.addEventListener("mousedown", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      });
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        removeRedactionArea(area.id);
      });
      el.appendChild(del);
    }
    shell.appendChild(el);
  }
}

/** Mark the selected text (Redact in the selection toolbar). */
function redactSelection() {
  const regions = selectionRegions();
  if (!regions.length) return;
  window.getSelection()?.removeAllRanges();
  hideSelectionToolbar();
  for (const r of regions) {
    // the selection follows the browser's font, not the PDF's: leave a margin
    const pad = Math.max(1.5, r.height * 0.12);
    addRedactionArea(
      { pageIndex: r.pageIndex, x: r.x - pad, y: r.y - pad * 0.5, width: r.width + pad * 2, height: r.height + pad },
      { silent: true }
    );
  }
  if (state.editMode !== "redact") setEditMode("redact");
  openRedactionPanel();
  setStatus(t("Marked for redaction; apply the redaction to remove it"), "ok");
}

/** The page text as the search builds it, with the original letter case. */
async function redactionTextIndex(doc) {
  const index = await buildSearchIndex(doc, state.find.token);
  return (index || []).map((entry) => {
    let text = "";
    for (const { item } of entry.items) {
      text += item.str;
      if (item.hasEOL) text += "\n";
    }
    return { ...entry, text };
  });
}

/** Where the marked words are on each page (as the editor finds them; the server searches again). */
async function redactionTermHits(doc) {
  const terms = doc?.redaction?.terms || [];
  if (!terms.length) return [];
  const index = await redactionTextIndex(doc);
  const hits = [];
  index.forEach((entry, pageIndex) => {
    for (const term of terms) {
      const caseSensitive = doc.redaction.caseSensitive;
      const hay = caseSensitive ? entry.text : entry.lower;
      const needle = caseSensitive ? term : term.toLocaleLowerCase();
      let at = hay.indexOf(needle);
      while (at >= 0 && needle) {
        hits.push({ term, pageIndex, rects: searchHitRects(entry, at, at + needle.length) });
        at = hay.indexOf(needle, at + needle.length);
      }
    }
  });
  return hits;
}

async function renderRedactionTermMarks() {
  const doc = activeDoc();
  els.viewerPages.querySelectorAll(".redaction-term-mark").forEach((node) => node.remove());
  if (!doc?.redaction?.terms.length || doc.contentView === "text") return;
  let hits;
  try {
    hits = await redactionTermHits(doc);
  } catch (_) {
    return;
  }
  if (activeDoc() !== doc) return;
  els.viewerPages.querySelectorAll(".redaction-term-mark").forEach((node) => node.remove());
  for (const hit of hits) {
    const shell = els.viewerPages.querySelector(`.page-shell[data-page="${hit.pageIndex + 1}"]`);
    if (!shell) continue;
    const scale = Number(shell.dataset.scale) || 1;
    for (const r of hit.rects) {
      const el = document.createElement("div");
      el.className = "redaction-mark redaction-term-mark";
      el.style.left = `${(r.x - 1) * scale}px`;
      el.style.top = `${(r.y - 1) * scale}px`;
      el.style.width = `${(r.w + 2) * scale}px`;
      el.style.height = `${(r.h + 2) * scale}px`;
      el.title = t("Marked for redaction: “{term}”", { term: hit.term });
      shell.appendChild(el);
    }
  }
}

/** Words of the document that look like the preset (emails, phone numbers, ...). */
async function findRedactionPreset(doc, preset) {
  const found = new Set();
  for (const entry of await redactionTextIndex(doc)) {
    for (const m of entry.text.matchAll(preset.re)) {
      const s = m[0].trim();
      if (preset.keep(s)) found.add(s);
    }
  }
  return [...found];
}

function refreshRedactionPanel() {
  if (els.propsPanel.classList.contains("open") && els.propsPanel.dataset.panel === "redact") {
    openRedactionPanel();
  }
  renderRedactionTermMarks();
}

function openRedactionPanel() {
  const doc = activeDoc();
  if (!doc) return;
  const r = redactionOf(doc);
  const areaRows = r.areas
    .map(
      (a, i) => `<li><span>${t("Area {n}, page {page}", { n: i + 1, page: a.pageIndex + 1 })}</span>
        <button type="button" class="icon-btn" data-remove-area="${a.id}" title="${escapeHtml(t("Remove this mark"))}" aria-label="${escapeHtml(t("Remove this mark"))}">×</button></li>`
    )
    .join("");
  const termRows = r.terms
    .map(
      (term, i) => `<li><span class="redaction-term">${escapeHtml(term)}</span>
        <button type="button" class="icon-btn" data-remove-term="${i}" title="${escapeHtml(t("Remove this mark"))}" aria-label="${escapeHtml(t("Remove this mark"))}">×</button></li>`
    )
    .join("");
  const presets = REDACTION_PRESETS.map(
    (p) => `<button type="button" class="ghost-btn redaction-preset" data-preset="${p.id}">${escapeHtml(t(p.label))}</button>`
  ).join("");
  const empty = !r.areas.length && !r.terms.length;
  showPropsPanel(
    t("Redact"),
    `<p class="form-hint">${t("Drag over the page to mark an area, or add words: every place they appear is removed. Nothing changes until you apply.")}</p>
     <label for="redactTermInput">${t("Words to remove")}</label>
     <div class="redaction-add">
       <input type="text" id="redactTermInput" placeholder="${escapeHtml(t("A name, a number…"))}" />
       <button type="button" class="ghost-btn" id="redactTermAdd">${t("Add")}</button>
     </div>
     <div class="redaction-presets"><span class="form-hint">${t("Find in this document:")}</span>${presets}</div>
     ${termRows ? `<ul class="redaction-list">${termRows}</ul>` : ""}
     ${areaRows ? `<label>${t("Marked areas")}</label><ul class="redaction-list">${areaRows}</ul>` : ""}
     <label class="redaction-option"><input type="checkbox" id="redactCase" ${r.caseSensitive ? "checked" : ""} /> ${t("Match case")}</label>
     <label class="redaction-option"><input type="checkbox" id="redactMeta" ${r.removeMetadata ? "checked" : ""} /> ${t("Also remove the document properties (title, author, keywords)")}</label>
     <button type="button" class="primary-btn redaction-apply" id="redactApply" ${empty ? "disabled" : ""}>${t("Apply redaction")}</button>
     <p class="form-hint">${t("Once the file is saved this cannot be undone. The marked content is taken out of the page; a page where that cannot be checked is replaced by a picture of itself.")}</p>
     <div id="redactReport"></div>`,
    "redact"
  );
  const body = els.propsBody;
  const input = body.querySelector("#redactTermInput");
  const add = () => {
    if (addRedactionTerms([input.value])) input.value = "";
    body.querySelector("#redactTermInput")?.focus();
  };
  body.querySelector("#redactTermAdd").addEventListener("click", add);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      add();
    }
  });
  body.querySelectorAll("[data-remove-area]").forEach((btn) =>
    btn.addEventListener("click", () => removeRedactionArea(btn.dataset.removeArea))
  );
  body.querySelectorAll("[data-remove-term]").forEach((btn) =>
    btn.addEventListener("click", () => {
      r.terms.splice(Number(btn.dataset.removeTerm), 1);
      refreshRedactionPanel();
    })
  );
  body.querySelectorAll("[data-preset]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const preset = REDACTION_PRESETS.find((p) => p.id === btn.dataset.preset);
      const found = await findRedactionPreset(doc, preset);
      const added = addRedactionTerms(found);
      setStatus(
        found.length
          ? tn(added, "Added {n} match", "Added {n} matches")
          : t("Nothing like that found in this document"),
        found.length ? "ok" : "error"
      );
    })
  );
  body.querySelector("#redactCase").addEventListener("change", (ev) => {
    r.caseSensitive = ev.target.checked;
    renderRedactionTermMarks();
  });
  body.querySelector("#redactMeta").addEventListener("change", (ev) => {
    r.removeMetadata = ev.target.checked;
  });
  body.querySelector("#redactApply").addEventListener("click", () => applyRedaction(doc));
}

/** Remove what is marked, for good, and show what the server removed and checked. */
async function applyRedaction(doc) {
  const r = doc?.redaction;
  if (!hasPendingRedaction(doc)) {
    setStatus(t("Mark something to redact first"), "error");
    return false;
  }
  const hasEdits = !!(doc.placedTexts?.length || doc.callouts?.length);
  const message = [
    t("Remove the marked content for good?"),
    t("Form fields, digital signatures, and annotations that contain the words are removed too."),
    hasEdits ? t("Your text boxes and comments become part of the page and can no longer be edited.") : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (!window.confirm(message)) return false;
  // The redaction rewrites the document: what was typed or placed goes in first.
  await prepareDocumentForExport(doc, { editorObjects: false });
  const fields = {
    regions: JSON.stringify(
      r.areas.map((a) => ({ page: a.pageIndex + 1, x: a.x, y: a.y, width: a.width, height: a.height }))
    ),
    terms: JSON.stringify(r.terms),
    case_sensitive: r.caseSensitive ? "true" : "false",
    remove_metadata: r.removeMetadata ? "true" : "false",
  };
  // always sent: also takes out an earlier drawing of boxes deleted since
  fields.edits = serializeEditorObjects(doc);
  let result;
  try {
    result = await runDocumentOperation(doc, {
      label: N_("Redact"),
      endpoint: "/v1/pdf/redact",
      fields,
      editorTransform: (d) => {
        d.placedTexts = [];
        d.callouts = [];
      },
    });
  } catch (err) {
    setStatus(String(err.message || err), "error");
    showToast(String(err.message || err), { type: "error", duration: 9000 });
    return false;
  }
  doc.redaction = null;
  doc.searchIndex = null;
  renderRedactionMarks();
  renderRedactionTermMarks();
  renderPlacedTextOverlays({ force: true });
  renderCalloutOverlays();
  const report = result?.report || {};
  openRedactionPanel();
  showRedactionReport(report);
  setStatus(t("Redaction applied; save the file to keep it"), "ok");
  return true;
}

function showRedactionReport(report) {
  const box = document.getElementById("redactReport");
  if (!box) return;
  const pages = (report.redactedPages || []).map((p) => p.page).join(", ");
  const found = Object.entries(report.termMatches || {})
    .map(([term, n]) => `<li>${escapeHtml(term)} — ${escapeHtml(tn(n, "{n} place", "{n} places"))}</li>`)
    .join("");
  const details = [...(report.alsoRemoved || []), ...(report.changes || [])]
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join("");
  const notes = [report.warning, report.note].filter(Boolean).map((s) => `<p class="form-hint">${escapeHtml(s)}</p>`).join("");
  const verified = report.verified !== false;
  box.innerHTML = `<div class="redaction-report ${verified ? "ok" : ""}">
      <strong>${verified ? t("Redaction applied and checked") : t("Redaction applied")}</strong>
      ${pages ? `<p>${t("Pages changed: {pages}", { pages: escapeHtml(pages) })}</p>` : ""}
      ${found ? `<ul class="redaction-list">${found}</ul>` : ""}
      ${Object.keys(report.termMatches || {}).length ? `<p>${t("The removed words can no longer be found anywhere in the file.")}</p>` : ""}
      ${details ? `<details><summary>${t("Also removed")}</summary><ul>${details}</ul></details>` : ""}
      ${notes}
    </div>`;
}

function hideSelectionToolbar() {
  document.getElementById("selectionToolbar")?.classList.add("hidden");
}

function updateSelectionToolbar() {
  const bar = document.getElementById("selectionToolbar");
  if (!bar) return;
  if (!isSelectMode() || state.inlineTextEditor || !activeDoc()) {
    bar.classList.add("hidden");
    return;
  }
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    bar.classList.add("hidden");
    return;
  }
  const anchor = sel.anchorNode?.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : sel.anchorNode;
  if (!anchor?.closest?.(".textLayer")) {
    bar.classList.add("hidden");
    return;
  }
  const rects = [...sel.getRangeAt(0).getClientRects()].filter((r) => r.width > 1);
  if (!rects.length) {
    bar.classList.add("hidden");
    return;
  }
  const host = els.viewerPages.closest(".viewer-wrap").getBoundingClientRect();
  const first = rects[0];
  bar.classList.remove("hidden");
  const width = bar.offsetWidth || 220;
  let x = first.left + first.width / 2 - host.left - width / 2;
  x = Math.max(8, Math.min(x, host.width - width - 8));
  let y = first.top - host.top - bar.offsetHeight - 8;
  if (y < 52) y = rects[rects.length - 1].bottom - host.top + 8;
  bar.style.left = `${x}px`;
  bar.style.top = `${y}px`;
}

function bindSelectionToolbar() {
  const bar = document.getElementById("selectionToolbar");
  if (!bar) return;
  bar.addEventListener("mousedown", (ev) => ev.preventDefault());
  bar.querySelector('[data-sel="copy"]').addEventListener("click", () => {
    actions.copy();
    hideSelectionToolbar();
  });
  bar.querySelector('[data-sel="highlight"]').addEventListener("click", () => highlightSelection());
  bar.querySelector('[data-sel="cover"]').addEventListener("click", () => coverSelection());
  bar.querySelector('[data-sel="redact"]').addEventListener("click", () => redactSelection());
  bar.querySelector('[data-sel="find"]').addEventListener("click", () => {
    const text = window.getSelection()?.toString().trim();
    openFindBar();
    if (text) {
      els.findInput.value = text;
      runFind();
    }
    hideSelectionToolbar();
  });
  let timer = null;
  document.addEventListener("selectionchange", () => {
    clearTimeout(timer);
    timer = setTimeout(updateSelectionToolbar, 120);
  });
  let raf = null;
  els.viewerScroll.addEventListener(
    "scroll",
    () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        updateSelectionToolbar();
      });
    },
    { passive: true }
  );
}

// ---------------------------------------------------------------- recent files

const RECENT_DB = "openpdf";
const RECENT_LIMIT = 8;

function openRecentDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(RECENT_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("recent", { keyPath: "key" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function recentStore(mode, fn) {
  try {
    const db = await openRecentDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("recent", mode);
      const result = fn(tx.objectStore("recent"));
      tx.oncomplete = () => resolve(result?.result ?? result);
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) {
    return null;
  }
}

async function thumbnailDataUrl(pdfDoc) {
  try {
    const page = await pdfDoc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const scale = 120 / viewport.width;
    const { canvas } = await renderPageCanvas(page, scale, { cssSize: false, pdfDoc });
    return canvas.toDataURL("image/jpeg", 0.7);
  } catch (_) {
    return null;
  }
}

async function rememberRecent(doc) {
  if (!doc?.fileHandle || typeof doc.fileHandle.getFile !== "function") return;
  const thumb = await thumbnailDataUrl(doc.pdfDoc);
  await recentStore("readwrite", (store) =>
    store.put({
      key: doc.name,
      name: doc.name,
      handle: doc.fileHandle,
      pages: doc.pageCount,
      thumb,
      openedAt: Date.now(),
    })
  );
  await recentStore("readwrite", async (store) => {
    const all = store.getAll();
    all.onsuccess = () => {
      const items = all.result.sort((a, b) => b.openedAt - a.openedAt);
      items.slice(RECENT_LIMIT).forEach((item) => store.delete(item.key));
    };
  });
  renderRecentFiles();
}

async function lastRecentHandle() {
  try {
    const items = (await recentStore("readonly", (store) => store.getAll())) || [];
    items.sort((a, b) => b.openedAt - a.openedAt);
    return items[0]?.handle || null;
  } catch (_) {
    return null;
  }
}

async function forgetRecent(key) {
  await recentStore("readwrite", (store) => store.delete(key));
  renderRecentFiles();
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const minutes = Math.round(diff / 60000);
  if (minutes < 2) return t("Just now");
  if (minutes < 60) return tn(minutes, "{n} minute ago", "{n} minutes ago");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return tn(hours, "{n} hour ago", "{n} hours ago");
  const days = Math.round(hours / 24);
  if (days < 30) return tn(days, "{n} day ago", "{n} days ago");
  return new Date(ts).toLocaleDateString(I18N.lang);
}

async function openRecent(item) {
  try {
    let perm = await item.handle.queryPermission({ mode: "read" });
    if (perm !== "granted") perm = await item.handle.requestPermission({ mode: "read" });
    if (perm !== "granted") {
      setStatus(t("No permission to read this file"), "error");
      return;
    }
    const file = await item.handle.getFile();
    await openFile(file, { fileHandle: item.handle });
  } catch (err) {
    if (err?.name === "NotFoundError") {
      showToast(t("Can't find “{name}”. It may have been moved or deleted.", { name: item.name }), { type: "error" });
      forgetRecent(item.key);
      return;
    }
    setStatus(String(err.message || err), "error");
  }
}

async function renderRecentFiles() {
  const host = document.getElementById("recentFiles");
  if (!host) return;
  const items = (await recentStore("readonly", (store) => store.getAll())) || [];
  items.sort((a, b) => b.openedAt - a.openedAt);
  host.replaceChildren();
  host.closest(".welcome-recent")?.classList.toggle("hidden", !items.length);
  for (const item of items.slice(0, RECENT_LIMIT)) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "recent-card";
    card.title = t("Open “{name}”", { name: item.name });
    const pic = document.createElement("div");
    pic.className = "recent-thumb";
    if (item.thumb) {
      const img = document.createElement("img");
      img.src = item.thumb;
      img.alt = "";
      pic.appendChild(img);
    }
    card.appendChild(pic);
    const name = document.createElement("span");
    name.className = "recent-name";
    name.textContent = item.name;
    card.appendChild(name);
    const meta = document.createElement("span");
    meta.className = "recent-meta";
    meta.textContent = tn(item.pages, "{n} page · {time}", "{n} pages · {time}", { time: relativeTime(item.openedAt) });
    card.appendChild(meta);
    const remove = document.createElement("span");
    remove.className = "recent-remove";
    remove.title = t("Remove from list");
    remove.setAttribute("role", "button");
    remove.dataset.icon = "x";
    remove.dataset.iconSize = "13";
    remove.addEventListener("click", (ev) => {
      ev.stopPropagation();
      forgetRecent(item.key);
    });
    card.appendChild(remove);
    card.addEventListener("click", () => openRecent(item));
    host.appendChild(card);
  }
  window.PdfIcons?.hydrate(host);
}

// ---------------------------------------------------------------- installed app (PWA)
//
// In Chrome / Edge the editor can be installed as an app (manifest.webmanifest).
// The system then offers it for opening PDF files: the files arrive through
// window.launchQueue as file handles, so Save writes back to the file that was
// opened. When the app is opened while the services are not running, sw.js
// shows offline.html, which keeps the files in IndexedDB (LAUNCH_DB) until the
// editor is back and opens them here.

const LAUNCH_DB = "openpdf-launch";

function launchStore(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LAUNCH_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("pending", { autoIncrement: true });
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction("pending", mode);
      const result = fn(tx.objectStore("pending"));
      tx.oncomplete = () => resolve(result?.result ?? result);
      tx.onerror = () => reject(tx.error);
    };
  });
}

/** Files offline.html kept for us (opened while the services were down). */
async function takePendingLaunches() {
  try {
    const items = (await launchStore("readonly", (store) => store.getAll())) || [];
    if (items.length) await launchStore("readwrite", (store) => store.clear());
    return items.map((item) => item.handle);
  } catch (_) {
    return [];
  }
}

async function openLaunchedFiles(handles) {
  for (const handle of handles) {
    if (handle?.kind !== "file") continue;
    let file;
    try {
      file = await handle.getFile();
    } catch (_) {
      setStatus(t("Can't open “{name}”: the file was moved or can't be read", { name: handle.name }), "error");
      continue;
    }
    await openFile(file, { fileHandle: handle });
  }
}

function bindInstalledApp() {
  const installItems = document.querySelectorAll('[data-action="installApp"]');
  const browserItems = document.querySelectorAll('[data-action="openInBrowser"]');
  // The desktop app's window: offer the same editor in the browser, where it
  // can be installed. (The desktop app says so only once the page has loaded.)
  document.querySelector(".file-menu-btn")?.addEventListener(
    "click",
    () => browserItems.forEach((item) => (item.hidden = !window.__openpdfDesktop)),
    true
  );
  actions.openInBrowser = () => {
    closeMenus();
    const url = `${window.location.origin}/ui/index.html`;
    window.location.href = `openpdf-action://open-in-browser?url=${encodeURIComponent(url)}`;
  };

  // Installing and opening files from the system: Chromium browsers only.
  if (!("launchQueue" in window || "onbeforeinstallprompt" in window)) return;
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("/ui/sw.js", { scope: "/ui/" })
      .catch((err) => console.warn("[openpdf] service worker not registered", err));
  }
  if ("launchQueue" in window) {
    window.launchQueue.setConsumer((params) => openLaunchedFiles(params.files || []));
  }
  takePendingLaunches().then(openLaunchedFiles);

  let installPrompt = null;
  const showInstall = (show) => installItems.forEach((item) => (item.hidden = !show));
  window.addEventListener("beforeinstallprompt", (ev) => {
    ev.preventDefault(); // offered in the File menu instead of a banner
    installPrompt = ev;
    showInstall(true);
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    showInstall(false);
    showToast(t("{app} is installed. PDF files can now be opened with it from your file manager."), {
      type: "ok",
    });
  });
  actions.installApp = async () => {
    closeMenus();
    if (!installPrompt) return;
    const prompt = installPrompt;
    installPrompt = null;
    showInstall(false);
    await prompt.prompt();
  };
}

// ---------------------------------------------------------------- help

function bindHelp() {
  const dialog = document.getElementById("helpDialog");
  if (!dialog) return;
  document.querySelectorAll('[data-action="help"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      closeMenus();
      dialog.showModal();
      dialog.querySelector(".help-card")?.focus();
    });
  });
  dialog.querySelector("[data-close]")?.addEventListener("click", () => dialog.close());
}

function bindWheelZoom() {
  els.viewerScroll.addEventListener(
    "wheel",
    (ev) => {
      if (!(ev.ctrlKey || ev.metaKey) || !activeDoc()) return;
      ev.preventDefault();
      if (state._wheelZoomLock) return;
      state._wheelZoomLock = true;
      setTimeout(() => (state._wheelZoomLock = false), 180);
      if (ev.deltaY < 0) els.zoomInBtn.click();
      else els.zoomOutBtn.click();
    },
    { passive: false }
  );
}

window.PdfIcons?.hydrate(document);

bindToolbar();
bindNavigation();
bindFiles();
bindSettings();
bindPrint();
bindPagesPanel();
bindPageInput();
bindSelectionToolbar();
bindHelp();
bindWheelZoom();
bindInstalledApp();
// Mouse wheel scrolls a crowded tab bar sideways.
els.tabbar.addEventListener(
  "wheel",
  (ev) => {
    if (els.tabbar.scrollWidth <= els.tabbar.clientWidth || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) return;
    ev.preventDefault();
    els.tabbar.scrollLeft += ev.deltaY;
  },
  { passive: false }
);
window.addEventListener("resize", () => renderTabsMenu());
// whether a mouse button is held: background redraws wait until it's released
window.addEventListener("pointerdown", () => (state.pointerDown = true), true);
window.addEventListener("pointerup", () => (state.pointerDown = false), true);
window.addEventListener("pointercancel", () => (state.pointerDown = false), true);
window.addEventListener("blur", () => (state.pointerDown = false));
renderRecentFiles();
bindKeyboard();
bindFind();
bindTextStyleToolbar();
bindFormSyncDelegation();
updateToolbarState();
showWelcome();
notePortChange();

/**
 * Desktop app: the editor's usual address was taken by another program, so it
 * runs on another one this time, and what the browser keeps per address
 * (language, save setting, saved signatures and certificates) is not there.
 */
function notePortChange() {
  const params = new URLSearchParams(location.search);
  if (!params.has("portChanged")) return;
  params.delete("portChanged");
  history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`);
  showToast(
    t("Another program is using OpenPDF's usual port, so the editor runs on a different one this time: your language, save setting and saved signatures may be missing. Close that program and restart OpenPDF to get them back."),
    { type: "error", duration: 15000 }
  );
}

// ---------------------------------------------------------------- language change

/** The forms panel: update its text in place, so values typed but not yet saved stay put. */
function refreshFormsPanelText() {
  els.propsTitle.textContent = t("Forms");
  const hint = els.propsBody.querySelector(".form-hint");
  if (hint) hint.textContent = t("Type or tick directly in the blue boxes on the PDF; the list here stays in sync. Save when you're done.");
  const empty = els.propsBody.querySelector(".form-empty");
  if (empty) empty.textContent = t("This PDF has no AcroForm fields to fill in (scans, XFA forms and flattened forms aren't supported).");
  const saveBtn = document.getElementById("fillFormBtn");
  if (saveBtn) saveBtn.textContent = t("Save form");
}

// index.html is translated by i18n.js; rebuild here what the script put on screen.
/**
 * Show tool labels only when they all fit; otherwise icons with tooltips.
 * (How long the labels are depends on the language.)
 */
function fitToolbar() {
  const bar = document.querySelector(".toolbar");
  const tray = bar?.querySelector(".tool-tray");
  if (!bar || !tray) return;
  bar.classList.remove("compact", "compact-menus");
  const overflowing = () => tray.scrollWidth > tray.clientWidth + 1 || bar.scrollWidth > bar.clientWidth + 1;
  if (overflowing()) bar.classList.add("compact-menus");
  if (overflowing()) bar.classList.add("compact");
}
if (window.ResizeObserver) new ResizeObserver(() => fitToolbar()).observe(document.querySelector(".toolbar"));
fitToolbar();

window.addEventListener("i18n:change", () => {
  fitToolbar();
  // menus built for the old language are simply closed
  closeThumbMenu();
  closePlacementColorMenu();
  updateUndoButtons();
  renderTabs(); // also the "All open files" menu and the window title
  updatePagesPanelToggleIcon();
  syncToolHint();
  syncTextStyleToolbar();
  const working = state._busyCount > 0 || state.docs.some((d) => d._saving || d._pendingMutations > 0);
  if (!working) setStatus(t("Ready"));
  const doc = activeDoc();
  if (doc) {
    updatePageIndicator();
    els.viewerPages.querySelectorAll(".page-shell").forEach((shell) => {
      shell.setAttribute("aria-label", t("Page {page}", { page: Number(shell.dataset.page) }));
    });
    els.thumbnails.querySelectorAll(".thumb").forEach((thumb) => {
      const page = Number(thumb.dataset.page);
      thumb.setAttribute("aria-label", t("Page {page} (right-click or drag to manage pages)", { page }));
      const more = thumb.querySelector(".thumb-more");
      if (more) {
        more.title = t("Page actions");
        more.setAttribute("aria-label", t("Actions for page {page}", { page }));
      }
    });
    // tooltips on text boxes and comments (not while one is being typed in or dragged)
    if (!state.inlineTextEditor && !state.placementInteraction?.active) {
      renderPlacedTextOverlays({ force: true });
      renderCalloutOverlays();
    }
    if (formsPanelOpen()) refreshFormsPanelText();
    if (state.find.open) runFind({ keepIndex: true });
  }
  renderRecentFiles();
});

// ---------------------------------------------------------------- optional OCR component

async function ocrInstalled() {
  try {
    const data = await apiGetJson("/v1/pdf/ocr/status");
    return !!data?.installed;
  } catch (_) {
    return true; // can't tell: let the OCR request itself report the problem
  }
}

/**
 * Explain the OCR component and install it: the desktop app runs the installer
 * itself and reports progress; in a browser the command is shown instead.
 * Resolves true once it is installed.
 */
// Step names the desktop app reports while installing the OCR component (in English).
const OCR_INSTALL_STEPS = [
  N_("Downloading and building the OCR component (about 190 MB, takes a few minutes)…"),
  N_("Downloading the OCR component…"),
  N_("Unpacking…"),
  N_("Starting the OCR component…"),
];

function offerOcrInstall() {
  return new Promise((resolve) => {
    let dialog = document.getElementById("ocrInstallDialog");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.className = "modal";
      dialog.id = "ocrInstallDialog";
      document.body.appendChild(dialog);
    }
    const desktop = !!window.__openpdfDesktop;
    const windows = /Windows/i.test(navigator.userAgent);
    const command = windows ? "scripts\\install-ocr.ps1" : "./scripts/install-ocr.sh";
    dialog.innerHTML = `
      <div class="modal-card ocr-install-card">
        <h2>${t("Install the text recognition (OCR) component")}</h2>
        <p>${t("Recognizing text in scans needs an extra component: the RapidOCR text recognition engine, which reads both Chinese and English. It is large, so it isn't installed with the app.")}</p>
        <p class="field-hint">${
          window.__OPENPDF_GATEWAY
            ? t("About a 170 MB download, about 390 MB once installed. You only need to install it once.")
            : t("About a 190 MB download, about 620 MB once installed. Installing takes a few minutes and is only needed once.")
        }</p>
        ${
          desktop
            ? `<div class="ocr-progress" hidden>
                 <div class="ocr-progress-step" id="ocrStep">${t("Preparing…")}</div>
                 <div class="ocr-progress-bar"><span></span></div>
                 <pre class="ocr-progress-log" id="ocrLog"></pre>
               </div>`
            : `<p>${t("Run this command in the {app} folder, then click “Check”:")}</p>
               <div class="ocr-command"><code>${command}</code><button type="button" class="ghost-btn" data-ocr="copy">${t("Copy")}</button></div>`
        }
        <p class="sign-error" id="ocrError" hidden></p>
        <menu class="modal-actions">
          <button type="button" class="ghost-btn" data-ocr="cancel">${t("Not now")}</button>
          ${
            desktop
              ? `<button type="button" class="primary-btn" data-ocr="install">${t("Download and install")}</button>`
              : `<button type="button" class="primary-btn" data-ocr="check">${t("Check")}</button>`
          }
        </menu>
      </div>`;
    const error = dialog.querySelector("#ocrError");
    const showError = (text) => {
      error.textContent = text || "";
      error.hidden = !text;
    };
    let installing = false;
    const finish = (ok) => {
      window.__openpdfOcrInstall = null;
      dialog.close();
      resolve(ok);
    };
    dialog.oncancel = (e) => {
      if (installing) e.preventDefault();
      else resolve(false);
    };
    dialog.querySelector('[data-ocr="cancel"]').onclick = () => {
      if (!installing) finish(false);
    };
    dialog.querySelector('[data-ocr="copy"]')?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(command);
        setStatus(t("Install command copied"), "ok");
      } catch (_) {
        setStatus(t("Please copy the command yourself"), "error");
      }
    });
    dialog.querySelector('[data-ocr="check"]')?.addEventListener("click", async () => {
      showError("");
      if (await ocrInstalled()) {
        setStatus(t("OCR component installed"), "ok");
        finish(true);
      } else {
        showError(t("The OCR component wasn't found yet. Once it is installed, click “Check” again."));
      }
    });
    const installBtn = dialog.querySelector('[data-ocr="install"]');
    installBtn?.addEventListener("click", () => {
      showError("");
      installing = true;
      installBtn.disabled = true;
      dialog.querySelector('[data-ocr="cancel"]').disabled = true;
      const progress = dialog.querySelector(".ocr-progress");
      const step = dialog.querySelector("#ocrStep");
      const log = dialog.querySelector("#ocrLog");
      const bar = dialog.querySelector(".ocr-progress-bar span");
      progress.hidden = false;
      const lines = [];
      let stepNo = 1;
      let stepCount = 2;
      // the desktop app calls this with each line of the installer's output
      window.__openpdfOcrInstall = async (event) => {
        if (event.kind === "line") {
          const text = String(event.text || "");
          const m = text.match(/^STEP (\d+)\/(\d+) (.*)$/);
          if (m) {
            stepNo = Number(m[1]);
            stepCount = Number(m[2]);
            step.textContent = t(m[3]); // the desktop app's steps: OCR_INSTALL_STEPS
            bar.style.width = `${Math.round(((stepNo - 0.5) / stepCount) * 100)}%`;
            return;
          }
          // "PCT n": n% of the current step done (downloads)
          const pct = text.match(/^PCT (\d+)$/);
          if (pct) {
            bar.style.width = `${Math.round(((stepNo - 1 + Number(pct[1]) / 100) / stepCount) * 100)}%`;
            return;
          }
          if (/^DONE /.test(text)) return;
          // podman's own build steps move the bar through the first half
          const b = text.match(/^STEP (\d+)\/(\d+): /);
          if (b) bar.style.width = `${Math.round((Number(b[1]) / Number(b[2])) * 50)}%`;
          lines.push(text);
          if (lines.length > 6) lines.shift();
          log.textContent = lines.join("\n");
        } else if (event.kind === "done") {
          bar.style.width = "100%";
          step.textContent = t("Connecting…");
          for (let i = 0; i < 20 && !(await ocrInstalled()); i += 1) {
            await new Promise((r) => setTimeout(r, 1000));
          }
          installing = false;
          setStatus(t("OCR component installed"), "ok");
          showToast(t("OCR component installed"), { type: "ok" });
          finish(true);
        } else if (event.kind === "error") {
          installing = false;
          installBtn.disabled = false;
          dialog.querySelector('[data-ocr="cancel"]').disabled = false;
          step.textContent = t("The installation didn't finish");
          showError(event.text || t("Installation failed. Check your network connection and try again."));
        }
      };
      // the desktop shell catches this address and runs scripts/install-ocr
      window.location.href = "openpdf-action://install-ocr";
    });
    dialog.showModal();
  });
}
