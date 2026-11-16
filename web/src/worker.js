// The in-page services: answers the editor's /v1/pdf/* requests (forwarded by
// shim.js) the way the gateway does, with the PDF work done here.

import { errorResponse, Form, HttpError, json } from "./http.js";
import * as annotate from "./ops/annotate.js";
import * as document from "./ops/document.js";
import * as forms from "./ops/forms.js";
import * as images from "./ops/images.js";
import * as ocr from "./ops/ocr.js";
import * as pictures from "./ops/pictures.js";
import * as placements from "./ops/placements.js";
import { redact } from "./ops/redact.js";
import * as signatures from "./ops/signatures.js";
import { renderPage } from "./ops/render.js";
import * as sessions from "./ops/sessions.js";

const NOT_HERE = "This isn't available in the browser version yet";

/** [method, path pattern, handler(req, ...pathParams)] */
const ROUTES = [
  ["GET", /^\/health$/, () => json({ status: "ok", mode: "browser" })],
  ["GET", /^\/v1\/pdf\/engine\/ready$/, () => json({ ready: true, pdfbox: true, qpdf: true, ocr: true, structure: false })],
  ["GET", /^\/v1\/pdf\/ocr\/status$/, ocr.ocrStatus],
  ["GET", /^\/v1\/pdf\/structure\/status$/, () => json({ installed: false })],

  ["POST", /^\/v1\/pdf\/register$/, sessions.register],
  ["GET", /^\/v1\/pdf\/document\/([0-9a-f-]+)\/meta$/, sessions.meta],
  ["GET", /^\/v1\/pdf\/document\/([0-9a-f-]+)$/, sessions.download],
  ["POST", /^\/v1\/pdf\/document\/([0-9a-f-]+)\/restore$/, sessions.restore],
  ["DELETE", /^\/v1\/pdf\/document\/([0-9a-f-]+)$/, sessions.close],

  ["POST", /^\/v1\/pdf\/merge$/, document.merge],
  ["POST", /^\/v1\/pdf\/split$/, document.split],
  ["POST", /^\/v1\/pdf\/extract$/, document.extract],
  ["POST", /^\/v1\/pdf\/encrypt$/, document.encrypt],
  ["POST", /^\/v1\/pdf\/rotate$/, document.rotate],
  ["POST", /^\/v1\/pdf\/pages$/, document.selectPages],
  ["POST", /^\/v1\/pdf\/flatten$/, document.flatten],
  ["POST", /^\/v1\/pdf\/unlock$/, document.unlock],
  ["POST", /^\/v1\/pdf\/render-page$/, renderPage],
  ["POST", /^\/v1\/pdf\/form-fields$/, forms.formFields],
  ["POST", /^\/v1\/pdf\/fill-form$/, forms.fillForm],
  ["POST", /^\/v1\/pdf\/highlight$/, annotate.highlight],
  ["POST", /^\/v1\/pdf\/remove-highlight$/, annotate.removeHighlight],
  ["POST", /^\/v1\/pdf\/sign$/, images.sign],
  ["POST", /^\/v1\/pdf\/stamp-signatures$/, images.stampSignatures],
  ["POST", /^\/v1\/pdf\/read-placements$/, placements.readPlacements],
  ["POST", /^\/v1\/pdf\/embed-placements$/, placements.embedPlacements],
  ["POST", /^\/v1\/pdf\/redact$/, redact],
  ["POST", /^\/v1\/pdf\/generate-cert$/, signatures.generateCert],
  ["POST", /^\/v1\/pdf\/cert-info$/, signatures.certInfo],
  ["POST", /^\/v1\/pdf\/digital-sign$/, signatures.digitalSign],
  ["POST", /^\/v1\/pdf\/verify-signatures$/, signatures.verifySignatures],
  ["POST", /^\/v1\/pdf\/ocr$/, ocr.ocr],
  ["POST", /^\/v1\/pdf\/extract-images$/, pictures.extractImages],
  ["POST", /^\/v1\/pdf\/from-images$/, pictures.fromImages],
];

async function handle(message) {
  const { method, path, headers = {}, body } = message;
  let form = new Form();
  if (body?.form) form = new Form(body.form);
  const req = { method, path, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), form };
  for (const [routeMethod, pattern, handler] of ROUTES) {
    const match = pattern.exec(path);
    if (match && routeMethod === method) return handler(req, ...match.slice(1));
  }
  if (path.startsWith("/v1/pdf/")) throw new HttpError(501, NOT_HERE, "not_in_browser");
  throw new HttpError(404, "Not Found");
}

self.addEventListener("message", async (event) => {
  const { id } = event.data || {};
  let response;
  try {
    response = await handle(event.data);
  } catch (err) {
    response = errorResponse(err);
  }
  const transfer = response.body instanceof Uint8Array && response.body.byteOffset === 0 &&
    response.body.byteLength === response.body.buffer.byteLength ? [response.body.buffer] : [];
  self.postMessage({ id, status: response.status, headers: response.headers, body: response.body }, transfer);
});
