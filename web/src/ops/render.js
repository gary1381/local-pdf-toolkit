// Page pictures (render-page): PDFium draws the page, the worker encodes PNG.

import { bytes, HttpError } from "../http.js";
import { pdfium, pdfError } from "../libs.js";
import { loadDocument } from "../session.js";

/** Open `data` with PDFium for the duration of `fn(engine, doc)`. */
export async function withPdfium(data, password, fn) {
  const { engine } = await pdfium();
  let doc;
  try {
    doc = await engine
      .openDocumentBuffer({ id: crypto.randomUUID(), content: data.slice().buffer }, password ? { password } : undefined)
      .toPromise();
  } catch (err) {
    throw pdfError(err?.reason?.message ? new Error(err.reason.message) : err);
  }
  try {
    return await fn(engine, doc);
  } finally {
    await engine.closeDocument(doc).toPromise().catch(() => {});
  }
}

export async function toPng(image) {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const pixels = new ImageData(new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.byteLength), image.width, image.height);
  canvas.getContext("2d").putImageData(pixels, 0, 0);
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
}

export async function renderPage(req) {
  const index = req.form.int("page_index", 0);
  const scale = Math.min(4, Math.max(0.1, req.form.float("scale", 1.5)));
  const { data } = await loadDocument(req.form);
  return withPdfium(data, req.form.get("password"), async (engine, doc) => {
    const page = doc.pages[index];
    if (!page) throw new HttpError(400, "Page number is outside the document");
    const image = await engine
      .renderPageRaw(doc, page, { scaleFactor: scale, withAnnotations: true, withForms: true })
      .toPromise();
    return bytes(await toPng(image), "image/png");
  });
}
