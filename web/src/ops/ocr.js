// Text recognition for scanned pages (ocr), in the page: the scanned pages
// are drawn with PDFium, read with PaddleOCR.js (the PaddleOCR models the OCR
// service uses, on ONNX Runtime Web), and an invisible text layer is written
// over the picture, so the page can be searched, selected and copied. Pages
// that already have text keep it (OCRmyPDF's skip_text); with `pictures` the
// pictures on them are read too (its redo mode: only what is not text yet).
//
// The models and the runtime are served with the editor (vendor/ocr,
// vendor/ort) and fetched the first time OCR is used; nothing else is
// contacted.

import { PdfArray, PdfDict, PdfStream } from "@libpdf/core";
import { HttpError, json } from "../http.js";
import { isSigned, openPdf, pdfium, saveEdit, snapshot } from "../libs.js";
import { RawPdf } from "../pdfium-text.js";
import { n, resolve } from "../pdfobj.js";
import { mutate } from "../session.js";
import { pageSpace } from "../space.js";
import { Face } from "../textdraw.js";

const LANGUAGES = new Set(["eng", "chi_sim"]);
const MODELS = {
  det: "PP-OCRv6_tiny_det",
  rec: "PP-OCRv6_small_rec",
};
// the longest side of the picture the models read (about 200 dpi on a letter page)
const MAX_SIDE = 2200;

let enginePromise = null;

/**
 * PaddleOCR.js and OpenCV.js are written for a page: they make canvases with
 * document.createElement and test for DOM image classes. In this worker an
 * OffscreenCanvas does the same job.
 */
function workerDom() {
  if (typeof document !== "undefined") return;
  globalThis.document = {
    createElement(tag) {
      if (tag !== "canvas") throw new Error(`No <${tag}> in a worker`);
      return new OffscreenCanvas(1, 1);
    },
    getElementById: () => null,
  };
  for (const name of ["HTMLImageElement", "HTMLCanvasElement", "HTMLVideoElement"]) {
    if (typeof globalThis[name] === "undefined") globalThis[name] = class {};
  }
}

function engine() {
  if (!enginePromise) {
    workerDom();
    enginePromise = (async () => {
      const { PaddleOCR } = await import("@paddleocr/paddleocr-js");
      return PaddleOCR.create({
        textDetectionModelName: MODELS.det,
        textDetectionModelAsset: { url: `/ui/vendor/ocr/${MODELS.det}_onnx_infer.tar` },
        textRecognitionModelName: MODELS.rec,
        textRecognitionModelAsset: { url: `/ui/vendor/ocr/${MODELS.rec}_onnx_infer.tar` },
        ortOptions: { backend: "wasm", wasmPaths: "/ui/vendor/ort/", numThreads: 1 },
      });
    })();
    enginePromise.catch(() => (enginePromise = null));
  }
  return enginePromise;
}

/** Whether the OCR files are part of this build (they are fetched on first use). */
export async function ocrStatus() {
  try {
    const resp = await fetch(`/ui/vendor/ocr/${MODELS.det}_onnx_infer.tar`, { method: "HEAD" });
    return json({ installed: resp.ok });
  } catch (_) {
    return json({ installed: false });
  }
}

async function renderForOcr(bytes, index) {
  const { engine: pdf } = await pdfium();
  const doc = await pdf.openDocumentBuffer({ id: crypto.randomUUID(), content: bytes.slice().buffer }).toPromise();
  try {
    const page = doc.pages[index];
    const size = page.rotation % 2 ? [page.size.height, page.size.width] : [page.size.width, page.size.height];
    const scale = Math.min(200 / 72, MAX_SIDE / Math.max(...size));
    const image = await pdf.renderPageRaw(doc, page, { scaleFactor: scale, withAnnotations: false, withForms: false }).toPromise();
    return { image: new ImageData(new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.byteLength), image.width, image.height), scale };
  } finally {
    await pdf.closeDocument(doc).toPromise().catch(() => {});
  }
}

/** One invisible line of text over where it was read (visual points, y down). */
async function lineOps(pdf, item, pxPerPt, vh, fonts) {
  const xs = item.poly.map((p) => p[0] / pxPerPt);
  const ys = item.poly.map((p) => p[1] / pxPerPt);
  const x = Math.min(...xs);
  const top = Math.min(...ys);
  const w = Math.max(...xs) - x;
  const h = Math.max(...ys) - top;
  const text = String(item.text || "").trim();
  if (!text || w <= 0 || h <= 0) return "";
  const { face, text: shown } = await Face.for(pdf, text, "");
  const key = `${face.ref.objectNumber}`;
  if (!fonts.has(key)) fonts.set(key, { name: `OCR${fonts.size}`, ref: face.ref });
  const size = Math.max(1, h * 0.8);
  const natural = face.measure(shown, size);
  const scaling = natural > 0 ? (w / natural) * 100 : 100;
  const baseline = vh - (top + h * 0.85);
  return `BT 3 Tr /${fonts.get(key).name} ${n(size)} Tf ${n(scaling)} Tz 1 0 0 1 ${n(x)} ${n(baseline)} Tm ${face.show(shown)} Tj ET`;
}

/** The text the OCR models read in a picture: [{poly (pixels), text}]. */
export async function recognise(image) {
  let reader;
  try {
    reader = await engine();
  } catch (err) {
    console.error("[openpdf services] OCR could not start", err);
    throw new HttpError(503, "The OCR (text recognition) component is not installed", "ocr_not_installed");
  }
  const [result] = await reader.predict(image);
  return result?.items || [];
}

/** Read lines as text: top to bottom, left to right. */
export function linesOf(items, scale = 1) {
  const boxes = items.map((item) => {
    const xs = item.poly.map((p) => p[0] / scale);
    const ys = item.poly.map((p) => p[1] / scale);
    return { x: Math.min(...xs), y: Math.min(...ys), h: Math.max(...ys) - Math.min(...ys), text: String(item.text || "").trim() };
  }).filter((b) => b.text);
  boxes.sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x);
  const lines = [];
  for (const b of boxes) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(b.y + b.h / 2 - (last[0].y + last[0].h / 2)) < Math.max(2, b.h * 0.5)) last.push(b);
    else lines.push([b]);
  }
  return lines.map((line) => line.sort((a, b) => a.x - b.x).map((b) => b.text).join(" ")).join("\n");
}

// A picture worth reading on a page that has text (routers/pdf.py): at least an
// inch wide and half an inch high, not most of the page (that is a scan) and not
// wholly in the top or bottom band (a letterhead or logo).
export function readablePictures({ pictures, width, height }) {
  return pictures.filter((p) => p.box.width >= 72 && p.box.height >= 36 && p.box.width * p.box.height < 0.8 * width * height
    && p.box.y + p.box.height > 0.12 * height && p.box.y < 0.88 * height);
}

/** Write the lines read on page `index` as an invisible text layer over the page. */
async function writeLayer(pdf, index, items, scale) {
  const page = pdf.getPage(index);
  const space = pageSpace(page);
  const fonts = new Map();
  const lines = [];
  for (const item of items) {
    const op = await lineOps(pdf, item, scale, space.vh, fonts);
    if (op) lines.push(op);
  }
  if (!lines.length) return;
  // the text layer, in displayed coordinates, after the page's own content
  const res = resolve(pdf, page.dict.get("Resources"));
  const own = new PdfDict();
  if (res instanceof PdfDict) for (const k of res.keys()) own.set(k, res.get(k));
  const fontDict = new PdfDict();
  const existing = resolve(pdf, own.get("Font"));
  if (existing instanceof PdfDict) for (const k of existing.keys()) fontDict.set(k, existing.get(k));
  for (const { name, ref } of fonts.values()) fontDict.set(name, ref);
  own.set("Font", fontDict);
  page.dict.set("Resources", own);
  const contents = resolve(pdf, page.dict.get("Contents"));
  const parts = contents instanceof PdfArray ? Array.from({ length: contents.length }, (_, k) => contents.at(k)) : contents ? [page.dict.get("Contents")] : [];
  const layer = `q ${space.matrix.map(n).join(" ")} cm\n${lines.join("\n")}\nQ\n`;
  const open = pdf.register(new PdfStream(new PdfDict(), new TextEncoder().encode("q\n")));
  const close = pdf.register(new PdfStream(new PdfDict(), new TextEncoder().encode(`\nQ\n${layer}`)));
  page.dict.set("Contents", new PdfArray([open, ...parts, close]));
}

const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * OCR in two passes, as the gateway does: the pages without a text layer
 * (scans), then, with `pictures`, the pictures on pages that have text; there
 * only lines inside a picture and clear of the page's own text are added.
 * Returns the pages of each pass.
 */
export async function ocrDocument(pdf, { pictures = true, only = null } = {}) {
  const scans = [];
  const picturePages = [];
  const keep = new Map(); // page index -> {boxes: picture boxes, chars: boxes of its own text}
  const raw = await RawPdf.open(await snapshot(pdf));
  try {
    for (let i = 0; i < raw.pageCount; i += 1) {
      if (only && !only.has(i)) continue;
      const { chars } = raw.pageChars(i);
      const solid = chars.filter((c) => c.box && !/\s/.test(c.ch));
      if (!solid.length) {
        scans.push(i);
      } else if (pictures) {
        const boxes = readablePictures(raw.pictures(i, { pixels: false })).map((p) => p.box);
        if (boxes.length) {
          picturePages.push(i);
          keep.set(i, { boxes, chars: solid.map((c) => c.box) });
        }
      }
    }
  } finally {
    raw.close();
  }
  if (!scans.length && !picturePages.length) return { scans, picturePages };
  await engine().catch(() => {
    throw new HttpError(503, "The OCR (text recognition) component is not installed", "ocr_not_installed");
  });
  const bytes = await snapshot(pdf);
  try {
    for (const index of [...scans, ...picturePages].sort((a, b) => a - b)) {
      const { image, scale } = await renderForOcr(bytes, index);
      let items = await recognise(image);
      const mask = keep.get(index);
      if (mask) {
        items = items.filter((item) => {
          const xs = item.poly.map((p) => p[0] / scale);
          const ys = item.poly.map((p) => p[1] / scale);
          const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
          const cx = box.x + box.width / 2;
          const cy = box.y + box.height / 2;
          return mask.boxes.some((b) => cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height)
            && !mask.chars.some((c) => overlaps(c, box));
        });
      }
      await writeLayer(pdf, index, items, scale);
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error("[openpdf services] OCR failed", err);
    throw new HttpError(500, `OCR failed: ${err?.message || err}`.slice(0, 500));
  }
  return { scans, picturePages };
}

export function ocr(req) {
  const langs = req.form.get("languages", "eng").split(",").map((l) => l.trim()).filter(Boolean);
  if (!langs.length) throw new HttpError(400, "Choose at least one OCR language");
  const unknown = langs.filter((l) => !LANGUAGES.has(l));
  if (unknown.length) throw new HttpError(400, `Unsupported OCR language: ${unknown.join(", ")} (available: eng, chi_sim)`);
  if (req.form.bool("clean")) throw new HttpError(400, "The 'clean' option is not available in this build (unpaper is not installed).");
  const pictures = req.form.bool("pictures", true);
  return mutate(req.form, async (data) => {
    if (isSigned(data)) {
      throw new HttpError(400, "This PDF is digitally signed; OCR would change it and break the signature, so it was left as it is");
    }
    const pdf = await openPdf(data, req.form.get("password"));
    const { scans, picturePages } = await ocrDocument(pdf, { pictures });
    const info = { ocrPages: scans.map((i) => i + 1), pictureOcrPages: picturePages.map((i) => i + 1) };
    return [await saveEdit(pdf, data), info];
  }, {
    responseHeaders: (info) => ({ "X-OCR-Pages": info.ocrPages.join(","), "X-Picture-OCR-Pages": info.pictureOcrPages.join(",") }),
  });
}
