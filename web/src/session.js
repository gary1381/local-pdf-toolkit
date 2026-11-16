// The gateway's two ways of working on a document (routers/pdf.py): an
// uploaded `file` (the result comes back as a file) or a `document_id` (the
// session's PDF is changed, a new revision is stored, JSON comes back).

import { bytes, HttpError, json, readPdfUpload } from "./http.js";
import * as store from "./store.js";

/** Read-only access to an upload or to the current revision of a session. */
export async function loadDocument(form) {
  const id = form.get("document_id");
  if (id) {
    const entry = store.require(id);
    return { data: store.read(id), filename: entry.filename };
  }
  const file = form.file("file");
  if (!file) throw new HttpError(400, "Provide a PDF file or a document_id");
  return { data: await readPdfUpload(file), filename: file.name || "document.pdf" };
}

/**
 * Apply an edit. `op(data, filename)` returns the new bytes, or [bytes, info]
 * where `info` is merged into the JSON answer (or turned into headers by
 * `responseHeaders` for an upload).
 */
export async function mutate(form, op, { newFilename = null, responseHeaders = null } = {}) {
  const id = form.get("document_id");
  if (id) {
    store.require(id);
    return store.locked(id, async () => {
      const entry = store.require(id);
      const [out, info] = normalize(await op(store.read(id), entry.filename));
      const [previous, revision] = store.update(id, out, newFilename);
      return json({ ok: true, document_id: id, revision, previous_revision: previous, ...info });
    });
  }
  const { data, filename } = await loadDocument(form);
  const [out, info] = normalize(await op(data, filename));
  if (form.bool("lightweight")) {
    const docId = store.create(out, newFilename || filename);
    return json({ ok: true, document_id: docId, revision: 1, previous_revision: null, ...info });
  }
  return bytes(out, "application/pdf", responseHeaders ? responseHeaders(info) : {});
}

function normalize(result) {
  return Array.isArray(result) ? [result[0], result[1] || {}] : [result, {}];
}
