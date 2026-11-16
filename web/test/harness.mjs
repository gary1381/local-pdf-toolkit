// Call the in-page services' handlers from Node (no browser), for quick checks
// and for comparing their answers with the gateway's.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Form } from "../src/http.js";
import { setPdfiumWasm } from "../src/libs.js";

const require = createRequire(import.meta.url);
setPdfiumWasm(readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm")));

export function pdfFile(path, name = path.split("/").pop()) {
  return new File([readFileSync(path)], name, { type: "application/pdf" });
}

/** Run `handler` with form `fields` ({name: string | Blob | [values]}); returns {status, headers, json|bytes}. */
export async function call(handler, fields = {}, ...params) {
  const entries = [];
  for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) entries.push([k, one]);
  let res;
  try {
    res = await handler({ method: "POST", path: "", headers: {}, form: new Form(entries) }, ...params);
  } catch (err) {
    return { status: err.status || 500, error: err.message, code: err.code };
  }
  const type = res.headers["content-type"] || "";
  if (type.includes("json")) return { status: res.status, headers: res.headers, json: JSON.parse(res.body) };
  return { status: res.status, headers: res.headers, bytes: res.body };
}

/** The same request to the real gateway, for comparison. */
export async function gateway(base, path, fields = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one);
  const resp = await fetch(`${base}/v1/pdf/${path}`, { method: "POST", body: fd });
  const type = resp.headers.get("content-type") || "";
  if (type.includes("json")) return { status: resp.status, json: await resp.json() };
  return { status: resp.status, bytes: new Uint8Array(await resp.arrayBuffer()) };
}
