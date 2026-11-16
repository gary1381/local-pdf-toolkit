// Editing sessions, kept in the worker's memory: one per open document, with
// the last revisions for undo and redo (like gateway/app/document_store.py).
// A reload of the page empties it; the editor then registers its copy again.

import { HttpError, sessionExpired } from "./http.js";

const HISTORY = 40;
const sessions = new Map();

function newId() {
  return crypto.randomUUID();
}

export function etag(data) {
  return crypto.subtle.digest("SHA-256", data).then((hash) =>
    Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

export function create(data, filename) {
  const id = newId();
  sessions.set(id, { id, filename, revision: 1, revisions: new Map([[1, data]]), queue: Promise.resolve() });
  return id;
}

export function get(id) {
  return sessions.get(id) || null;
}

export function require(id) {
  const entry = sessions.get(id);
  if (!entry) throw sessionExpired();
  return entry;
}

export function read(id, revision = null) {
  const entry = require(id);
  const data = entry.revisions.get(revision ?? entry.revision);
  if (!data) throw sessionExpired();
  return data;
}

/** Store a new revision. Returns [previous, current]. */
export function update(id, data, filename = null) {
  const entry = require(id);
  const previous = entry.revision;
  entry.revision += 1;
  entry.revisions.set(entry.revision, data);
  if (filename) entry.filename = filename;
  while (entry.revisions.size > HISTORY) entry.revisions.delete(entry.revisions.keys().next().value);
  return [previous, entry.revision];
}

export function restore(id, revision) {
  const entry = require(id);
  const data = entry.revisions.get(revision);
  if (!data) throw new HttpError(410, "That step is beyond the undo history");
  return update(id, data);
}

export function remove(id) {
  sessions.delete(id);
}

/** Run `fn` after every earlier change to the same session (one at a time). */
export function locked(id, fn) {
  const entry = require(id);
  const run = entry.queue.then(fn, fn);
  entry.queue = run.catch(() => {});
  return run;
}
