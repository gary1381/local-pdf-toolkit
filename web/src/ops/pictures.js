// Pictures (the gateway's /extract-images and /from-images): save the pictures
// of a document as image files with their text, and make a PDF from pictures.

import { zipSync } from "fflate";
import { bytes, HttpError, json, PAGE_RANGE_RE, pagesInRange } from "../http.js";
import { PDF, pdfError, savePdf } from "../libs.js";
import { RawPdf } from "../pdfium-text.js";
import { loadDocument } from "../session.js";
import * as store from "../store.js";
import { linesOf, ocrDocument, ocrStatus, recognise } from "./ocr.js";

const MAX_PICTURES = 500;
const MAX_PICTURE = 50 * 1024 * 1024;
// Without a resolution in the file, the longer side fits A4's (11.69 in).
const A4_LONG_INCHES = 11.69;

const round = (v) => Math.round(v * 100) / 100;

async function png({ data, width, height }) {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").putImageData(new ImageData(data, width, height), 0, 0);
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
}

async function digest(data) {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The pixels of a picture for OCR, its longer side at most `max`. */
async function forOcr(pic, max = 2200) {
  let bitmap;
  if (pic.jpeg) bitmap = await createImageBitmap(new Blob([pic.jpeg], { type: "image/jpeg" }));
  else bitmap = await createImageBitmap(new ImageData(pic.rgba.data, pic.rgba.width, pic.rgba.height));
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return ctx.getImageData(0, 0, w, h);
}

// Strokes of a chart that OCR reads as these Chinese characters (the gateway's LINE_ART)
const LINE_ART = /(?<!\S)[一二十丨口田日]{1,2}(?!\S)/g;

function cleanPictureText(text) {
  if (/[\u3400-\u9fff]/.test(text.replace(LINE_ART, ""))) return text;
  return text.split("\n").map((l) => l.replace(LINE_ART, "").replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

/** Text already in the PDF inside the box: characters whose middle is in it. */
function textIn(chars, box) {
  let text = "";
  let last = -2;
  chars.forEach((c, i) => {
    if (!c.box) return;
    const mx = c.box.x + c.box.width / 2;
    const my = c.box.y + c.box.height / 2;
    if (mx < box.x || mx > box.x + box.width || my < box.y || my > box.y + box.height) return;
    if (last >= 0 && i !== last + 1) text += "\n";
    text += c.ch;
    last = i;
  });
  return text.split(/[\r\n]+/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

export async function extractImages(req) {
  const spec = req.form.get("pages").replace(/\s+/g, "");
  if (spec && !PAGE_RANGE_RE.test(spec)) throw new HttpError(400, "Invalid page range; use a form like 1-3,5,8-");
  const minSize = Math.min(10000, Math.max(1, req.form.int("min_size", 32)));
  const readText = req.form.bool("ocr", true);
  const { data, filename } = await loadDocument(req.form);
  const password = req.form.get("password");
  const raw = await RawPdf.open(data, password);
  const pageCount = raw.pageCount;
  const files = {};
  const images = [];
  const sizes = [];
  const seen = new Map();
  let ocrNote = "";
  let canOcr = readText && (await ocrStatus().then((r) => JSON.parse(r.body).installed).catch(() => false));
  if (readText && !canOcr) ocrNote = "OCR is not installed: only text already in the PDF was read";
  try {
    const pages = spec ? pagesInRange(spec, raw.pageCount) : Array.from({ length: raw.pageCount }, (_, i) => i + 1);
    for (const n of pages) {
      const found = raw.pictures(n - 1, { minSize });
      sizes.push({ page: n, width: round(found.width), height: round(found.height) });
      const chars = readText ? raw.pageChars(n - 1).chars : [];
      let onPage = 0;
      for (const pic of found.pictures) {
        if (images.length >= 5000) break;
        onPage += 1;
        const entry = {
          page: n, index: onPage, x: round(pic.box.x), y: round(pic.box.y), width: round(pic.box.width),
          height: round(pic.box.height), pixelWidth: pic.pixelWidth, pixelHeight: pic.pixelHeight,
        };
        if (pic.box.width > 0) entry.dpi = Math.round(pic.pixelWidth / (pic.box.width / 72));
        if (pic.error) {
          entry.error = "This picture's format could not be decoded";
          images.push(entry);
          continue;
        }
        const content = pic.jpeg || (await png(pic.rgba));
        const key = await digest(pic.jpeg || pic.rgba.data);
        const base = `images/page${String(n).padStart(3, "0")}-${String(onPage).padStart(2, "0")}`;
        if (seen.has(key)) {
          entry.sameAs = seen.get(key);
        } else {
          const file = `${base}.${pic.jpeg ? "jpg" : "png"}`;
          files[file] = content;
          seen.set(key, file);
        }
        entry.file = entry.sameAs || seen.get(key);
        entry.format = pic.jpeg ? "jpg" : "png";
        if (readText) {
          let text = textIn(chars, pic.box);
          if (!text && canOcr && !entry.sameAs) {
            try {
              const image = await forOcr(pic);
              text = linesOf(await recognise(image), image.width / pic.pixelWidth);
            } catch (err) {
              canOcr = false;
              ocrNote = err instanceof HttpError ? err.message : "OCR failed; only text already in the PDF was read";
            }
          }
          text = cleanPictureText(text);
          if (text) {
            entry.text = text;
            if (!entry.sameAs) files[`${base}.txt`] = new TextEncoder().encode(text);
          }
        }
        images.push(entry);
      }
    }
  } finally {
    raw.close();
  }
  const manifest = { pageCount, pages: sizes.length, pageSizes: sizes, images, files: seen.size };
  if (ocrNote) manifest.ocrNote = ocrNote;
  files["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest, null, 1));
  const stem = (filename || "document").replace(/\.pdf$/i, "") || "document";
  return bytes(zipSync(files, { level: 0 }), "application/zip", {
    "Content-Disposition": `attachment; filename="${stem.replace(/[^A-Za-z0-9._ -]/g, "_")}-images.zip"`,
    "X-Image-Count": String(images.length),
  });
}

// ---------------------------------------------------------------- pictures to a PDF

/** JFIF density or EXIF orientation of a JPEG. */
function jpegFacts(data) {
  let dpi = 0;
  let orientation = 1;
  let i = 2;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  while (i + 4 < data.length && data[i] === 0xff) {
    const marker = data[i + 1];
    const len = view.getUint16(i + 2);
    if (marker === 0xda || len < 2) break;
    const start = i + 4;
    if (marker === 0xe0 && String.fromCharCode(...data.subarray(start, start + 4)) === "JFIF" && start + 12 <= data.length) {
      const unit = data[start + 7];
      const x = view.getUint16(start + 8);
      if (unit === 1) dpi = x;
      else if (unit === 2) dpi = x * 2.54;
    }
    if (marker === 0xe1 && String.fromCharCode(...data.subarray(start, start + 4)) === "Exif" && start + 14 < data.length) {
      const tiff = start + 6;
      const little = data[tiff] === 0x49;
      const ifd = tiff + view.getUint32(tiff + 4, little);
      const entries = ifd + 2 <= data.length ? view.getUint16(ifd, little) : 0;
      for (let e = 0; e < entries; e += 1) {
        const at = ifd + 2 + e * 12;
        if (at + 12 > data.length) break;
        if (view.getUint16(at, little) === 0x0112) orientation = view.getUint16(at + 8, little);
      }
    }
    i += 2 + len;
  }
  return { dpi, orientation };
}

/** Pixels per inch from a PNG's pHYs chunk, or 0. */
function pngDpi(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 8; i + 12 <= data.length;) {
    const len = view.getUint32(i);
    const type = String.fromCharCode(...data.subarray(i + 4, i + 8));
    if (type === "pHYs" && data[i + 16] === 1) return view.getUint32(i + 8) * 0.0254;
    if (type === "IDAT") break;
    i += 12 + len;
  }
  return 0;
}

function pageSize(pw, ph, dpi) {
  const res = dpi >= 50 && dpi <= 2400 ? dpi : Math.max(72, Math.max(pw, ph) / A4_LONG_INCHES);
  return [(pw * 72) / res, (ph * 72) / res];
}

export async function fromImages(req) {
  const files = req.form.files("files");
  if (!files.length) throw new HttpError(400, "Choose at least one picture");
  if (files.length > MAX_PICTURES) throw new HttpError(400, `At most ${MAX_PICTURES} pictures at a time`);
  const pdf = PDF.create();
  for (const file of files) {
    const name = file.name || "picture";
    if (!file.size) throw new HttpError(400, `'${name}' is empty`);
    if (file.size > MAX_PICTURE) throw new HttpError(413, `'${name}' is too large (limit 50 MB)`);
    const data = new Uint8Array(await file.arrayBuffer());
    const jpeg = data[0] === 0xff && data[1] === 0xd8;
    const isPng = data[0] === 0x89 && data[1] === 0x50;
    const tiff = (data[0] === 0x49 && data[1] === 0x49) || (data[0] === 0x4d && data[1] === 0x4d);
    if (tiff) throw new HttpError(400, `'${name}' is a TIFF picture, which the browser version cannot read; use JPEG or PNG, or the desktop app`);
    try {
      let image;
      let pw;
      let ph;
      let dpi = 0;
      let rotate = 0;
      if (jpeg) {
        image = await pdf.embedJpeg(data);
        ({ dpi } = jpegFacts(data));
        rotate = { 3: 180, 6: 90, 8: 270 }[jpegFacts(data).orientation] || 0;
      } else if (isPng) {
        image = await pdf.embedPng(data);
        dpi = pngDpi(data);
      } else {
        // GIF, BMP, WebP: what the browser decodes, kept losslessly as PNG
        let bitmap;
        try {
          bitmap = await createImageBitmap(new Blob([data]));
        } catch (_) {
          throw new HttpError(400, `'${name}' is not a picture OpenPDF can read; use JPEG, PNG, GIF or BMP`);
        }
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        image = await pdf.embedPng(new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer()));
      }
      pw = image.width;
      ph = image.height;
      const [w, h] = pageSize(pw, ph, dpi);
      const page = pdf.addPage({ width: w, height: h });
      if (rotate) page.setRotation(rotate);
      page.drawImage(image, { x: 0, y: 0, width: w, height: h });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, `'${name}' could not be read as a picture (it may be damaged)`);
    }
  }
  const outName = req.form.get("filename") || `${(files[0].name || "pictures").replace(/\.[A-Za-z0-9]+$/, "")}.pdf`;
  let did = false;
  let note = "";
  if (req.form.bool("ocr", true)) {
    try {
      await ocrDocument(pdf, { pictures: false });
      did = true;
    } catch (err) {
      if (!(err instanceof HttpError) || err.code !== "ocr_not_installed") throw err;
      note = err.message;
    }
  }
  let out;
  try {
    out = await savePdf(pdf);
  } catch (err) {
    throw pdfError(err);
  }
  const info = { ocr: did, ...(note ? { ocrNote: note } : {}) };
  if (req.form.bool("lightweight")) {
    const id = store.create(out, outName);
    return json({ ok: true, document_id: id, revision: 1, previous_revision: null, filename: outName, ...info });
  }
  return bytes(out, "application/pdf", { "X-OCR": did ? "1" : "0", ...(note ? { "X-OCR-Note": note } : {}) });
}
