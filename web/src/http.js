// Requests and responses in the worker, in the shape the gateway uses.

export class HttpError extends Error {
  constructor(status, detail, code = "") {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

/** The form of a request: the fields the editor sent (strings and files). */
export class Form {
  constructor(entries = []) {
    this.entries = entries;
  }

  get(name, fallback = "") {
    const found = this.entries.find(([key, value]) => key === name && typeof value === "string");
    return found ? found[1] : fallback;
  }

  bool(name, fallback = false) {
    const value = this.get(name, null);
    if (value === null || value === "") return fallback;
    return ["true", "1", "yes", "on"].includes(value.toLowerCase());
  }

  int(name, fallback) {
    const value = this.get(name, null);
    if (value === null || value === "") return fallback;
    const n = Number(value);
    if (!Number.isInteger(n)) throw new HttpError(422, `Invalid request parameters: ${name}`);
    return n;
  }

  float(name, fallback) {
    const value = this.get(name, null);
    if (value === null || value === "") return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new HttpError(422, `Invalid request parameters: ${name}`);
    return n;
  }

  file(name) {
    const found = this.entries.find(([key, value]) => key === name && value instanceof Blob);
    return found ? found[1] : null;
  }

  files(name) {
    return this.entries.filter(([key, value]) => key === name && value instanceof Blob).map(([, value]) => value);
  }

  require(name) {
    const value = this.get(name, null);
    if (value === null) throw new HttpError(422, `Invalid request parameters: ${name}`);
    return value;
  }
}

export function json(value, status = 200, headers = {}) {
  return { status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) };
}

export function bytes(data, type = "application/pdf", headers = {}, status = 200) {
  return { status, headers: { "content-type": type, ...headers }, body: data };
}

export function errorResponse(err) {
  if (err instanceof HttpError) {
    const headers = err.code ? { "X-Error-Code": err.code } : {};
    return json({ detail: err.message }, err.status, headers);
  }
  console.error("[openpdf services]", err);
  return json({ detail: "Internal error in the in-page PDF services" }, 500);
}

export const SESSION_EXPIRED = "The editing session has expired or does not exist; open the file again";

export function sessionExpired() {
  return new HttpError(404, SESSION_EXPIRED, "session_expired");
}

export const PAGE_LIST_RE = /^\s*\d+\s*(,\s*\d+\s*)*$/;
export const PAGE_RANGE_RE = /^\s*(\d+\s*(-\s*\d*)?)(\s*,\s*\d+\s*(-\s*\d*)?)*\s*$/;

/** 1-based page numbers of a range like "1-3,5,8-" in a document of `count` pages. */
export function pagesInRange(spec, count) {
  const out = [];
  for (const part of spec.replace(/\s+/g, "").split(",").filter(Boolean)) {
    const [a, b] = part.split("-");
    const first = Number(a);
    const last = part.includes("-") ? (b === "" ? count : Number(b)) : first;
    for (let n = first; n <= Math.min(last, count); n += 1) if (n >= 1) out.push(n);
  }
  return out;
}

export async function readPdfUpload(file, name = "file") {
  if (!file || file.size === 0) throw new HttpError(400, "The file is empty");
  const data = new Uint8Array(await file.arrayBuffer());
  const head = new TextDecoder("latin1").decode(data.subarray(0, 1024));
  if (!head.includes("%PDF-")) throw new HttpError(400, `'${file.name || name}' is not a valid PDF file`);
  return data;
}
