// Editing sessions: register, download, revision info, undo/redo, close.

import { bytes, HttpError, json, readPdfUpload } from "../http.js";
import * as store from "../store.js";

export async function register(req) {
  const file = req.form.file("file");
  if (!file) throw new HttpError(422, "Invalid request parameters: file");
  const data = await readPdfUpload(file);
  return json({ document_id: store.create(data, file.name || "document.pdf"), revision: 1 });
}

export async function meta(req, id) {
  const entry = store.require(id);
  const data = store.read(id);
  return json({
    document_id: id,
    revision: entry.revision,
    revisions: [...entry.revisions.keys()],
    size: data.byteLength,
    etag: await store.etag(data),
    filename: entry.filename,
  });
}

export async function download(req, id) {
  const entry = store.require(id);
  const revision = entry.revision;
  const data = store.read(id, revision);
  const headers = {
    ETag: `"${await store.etag(data)}"`,
    "X-Document-Revision": String(revision),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  const range = /^bytes=(\d+)-(\d*)$/.exec((req.headers.range || "").trim());
  if (range) {
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : data.byteLength - 1, data.byteLength - 1);
    if (start <= end && start < data.byteLength) {
      return bytes(data.slice(start, end + 1), "application/pdf", {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${data.byteLength}`,
      }, 206);
    }
  }
  return bytes(data.slice(), "application/pdf", headers);
}

export async function restore(req, id) {
  store.require(id);
  const revision = req.form.int("revision");
  if (revision === undefined) throw new HttpError(422, "Invalid request parameters: revision");
  return store.locked(id, () => {
    const [previous, current] = store.restore(id, revision);
    return json({ ok: true, document_id: id, revision: current, previous_revision: previous });
  });
}

export async function close(req, id) {
  store.remove(id);
  return json({ ok: true });
}
