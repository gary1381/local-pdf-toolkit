// Pictures: insert an image (sign) and place picture signatures (stamp-signatures).

import { ops, PdfArray } from "@libpdf/core";
import { HttpError } from "../http.js";
import { openPdf, pdfError, saveEdit } from "../libs.js";
import { annotsOf, n, obj, resolve, stream } from "../pdfobj.js";
import { mutate } from "../session.js";
import { pageSpace } from "../space.js";

const MAX_IMAGE = 20 * 1024 * 1024;

export async function readImage(file) {
  if (!file || file.size === 0) throw new HttpError(400, "The image is empty");
  if (file.size > MAX_IMAGE) throw new HttpError(413, "Image too large (limit 20 MB)");
  const data = new Uint8Array(await file.arrayBuffer());
  const png = data[0] === 0x89 && data[1] === 0x50;
  const jpeg = data[0] === 0xff && data[1] === 0xd8;
  if (!png && !jpeg) throw new HttpError(400, "Unsupported image format; use PNG or JPEG");
  return data;
}

export function embedImage(pdf, data) {
  try {
    return data[0] === 0x89 ? pdf.embedPng(data) : pdf.embedJpeg(data);
  } catch (err) {
    throw new HttpError(400, "Unsupported image format; use PNG or JPEG");
  }
}

/**
 * Wrap the page's own content in q ... Q, so what is appended next starts
 * from a clean graphics state (PDFBox's AppendMode.APPEND with resetContext).
 */
export function isolateContents(pdf, page) {
  const contents = resolve(pdf, page.dict.get("Contents"));
  const items = contents instanceof PdfArray ? Array.from({ length: contents.length }, (_, i) => contents.at(i))
    : contents ? [page.dict.get("Contents")] : [];
  const open = stream(pdf, {}, "q\n");
  const close = stream(pdf, {}, "\nQ\n");
  page.dict.set("Contents", new PdfArray([open, ...items, close]));
}

/** Draw `image` stretched into the visual rect (x, y, w, h) of `page`. */
export function drawImageInRect(pdf, page, image, { x, y, width: w, height: h }) {
  const space = pageSpace(page);
  const name = page.registerImage(image);
  page.drawOperators([
    ops.pushGraphicsState(),
    ops.concatMatrix(...space.matrix),
    ops.concatMatrix(w, 0, 0, h, x, space.vh - y - h),
    ops.paintXObject(name),
    ops.popGraphicsState(),
  ]);
}

function pageOf(pdf, index) {
  const page = Number.isInteger(index) && index >= 0 ? pdf.getPage(index) : null;
  if (!page) throw new HttpError(400, "Page number is outside the document");
  return page;
}

export function sign(req) {
  const region = {
    index: req.form.int("page_index", 0),
    x: req.form.float("x", 72),
    y: req.form.float("y", 720),
    width: req.form.float("width", 120),
    height: req.form.float("height", 48),
  };
  return mutate(req.form, async (data) => {
    const imageBytes = await readImage(req.form.file("image"));
    const pdf = await openPdf(data, req.form.get("password"));
    const page = pageOf(pdf, region.index);
    const image = embedImage(pdf, imageBytes);
    try {
      isolateContents(pdf, page);
      drawImageInRect(pdf, page, image, region);
    } catch (err) {
      throw pdfError(err);
    }
    return saveEdit(pdf, data);
  });
}

/** A /Stamp annotation showing the picture, upright on rotated pages. */
function stampAnnotation(pdf, page, image, { x, y, width: w, height: h }) {
  const space = pageSpace(page);
  const rect = space.userRect(x, y, w, h);
  const [a, b, c, d] = space.matrix;
  const appearance = stream(pdf, {
    Type: "/XObject", Subtype: "/Form", BBox: [0, 0, w, h], Matrix: [a, b, c, d, 0, 0],
    Resources: { XObject: { Img: image.ref } },
  }, `q ${n(w)} 0 0 ${n(h)} 0 0 cm /Img Do Q\n`);
  const annot = obj({
    Type: "/Annot", Subtype: "/Stamp",
    Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    Contents: "Signature", F: 4, OpenPDFKind: "signature", P: page.ref,
    AP: { N: appearance },
  });
  annotsOf(pdf, page).push(pdf.register(annot));
}

export function stampSignatures(req) {
  let placements;
  try {
    placements = JSON.parse(req.form.require("placements"));
  } catch (_) {
    throw new HttpError(400, "Invalid signature placement data");
  }
  const files = req.form.files("images");
  const mode = req.form.get("mode", "flatten");
  if (!["flatten", "annotation"].includes(mode)) throw new HttpError(400, "Invalid signature mode");
  if (!Array.isArray(placements) || !placements.length || !files.length) throw new HttpError(400, "Invalid signature placement data");
  if (placements.length > 2000) throw new HttpError(400, "Too many signatures in one request");
  for (const p of placements) {
    const ok = p && typeof p === "object" && ["page", "x", "y", "width", "height"].every((k) => Number.isFinite(Number(p[k])))
      && Number.isInteger(Number(p.image ?? 0)) && Number(p.image ?? 0) >= 0 && Number(p.image ?? 0) < files.length;
    if (!ok) throw new HttpError(400, "Invalid signature placement data");
  }
  return mutate(req.form, async (data) => {
    const imageBytes = await Promise.all(files.map(readImage));
    const pdf = await openPdf(data, req.form.get("password"));
    const images = imageBytes.map((bytes) => embedImage(pdf, bytes));
    const isolated = new Set();
    let stamped = 0;
    try {
      for (const p of placements) {
        const page = pageOf(pdf, Number(p.page));
        const rect = { x: Number(p.x), y: Number(p.y), width: Number(p.width), height: Number(p.height) };
        if (rect.width <= 0 || rect.height <= 0) continue;
        const image = images[Number(p.image ?? 0)];
        if (mode === "annotation") {
          stampAnnotation(pdf, page, image, rect);
        } else {
          if (!isolated.has(page.index)) {
            isolateContents(pdf, page);
            isolated.add(page.index);
          }
          drawImageInRect(pdf, page, image, rect);
        }
        stamped += 1;
      }
    } catch (err) {
      throw pdfError(err);
    }
    return [await saveEdit(pdf, data), { stamped_count: stamped }];
  });
}

