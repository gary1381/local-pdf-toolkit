// Removing what lies under areas of pages (the work of the Java service's
// RegionEraser): characters, the pixels of pictures, shapes.
//
// PDFium does the removal, on a copy of the document in which every page that
// is cleaned has resources of its own (pages sharing a font dictionary or a
// form would otherwise be damaged: PDFium rewrites what it changes in place).
// The cleaned pages' content and resources are then copied back into the
// LibPDF document being edited, which stays the master copy: its other pages,
// annotations and document-level data are untouched, and a signed file can
// still be saved incrementally.

import { PdfArray, PdfDict, PdfRef, PdfStream } from "@libpdf/core";
import { openPdf, pdfError, pdfium, savePdf, snapshot } from "./libs.js";
import { name, resolve } from "./pdfobj.js";
import { RawPdf } from "./pdfium-text.js";

const RESOURCE_KINDS = ["Font", "XObject", "ExtGState", "ColorSpace", "Pattern", "Shading", "Properties"];

/** The page's resources, also when inherited from the page tree. */
export function inheritedResources(pdf, page) {
  let node = page.dict;
  for (let depth = 0; node && depth < 64; depth += 1) {
    const res = resolve(pdf, node.get("Resources"));
    if (res instanceof PdfDict) return res;
    node = resolve(pdf, node.get("Parent"));
  }
  return new PdfDict();
}

function copyStream(pdf, stream, seen, id) {
  const dict = new PdfDict();
  for (const key of stream.keys()) dict.set(key, stream.get(key));
  // .data: the bytes as stored, matching /Filter (getEncodedData() would
  // compress already-compressed data a second time, and the picture is lost)
  const copy = new PdfStream(dict, stream.data);
  const ref = pdf.register(copy);
  if (id) seen.set(id, ref); // before the resources: forms may refer back to themselves
  if (name(pdf, stream.get("Subtype")) === "Form") {
    const res = resolve(pdf, stream.get("Resources"));
    if (res instanceof PdfDict) copy.set("Resources", ownCopy(pdf, res, seen));
  }
  return ref;
}

/** A copy of a resources dictionary whose sub-dictionaries, forms and images are this copy's own. */
function ownCopy(pdf, res, seen = new Map()) {
  const out = new PdfDict();
  for (const key of res.keys()) {
    const k = key.value ?? String(key);
    const value = resolve(pdf, res.get(key));
    if (!RESOURCE_KINDS.includes(k) || !(value instanceof PdfDict)) {
      out.set(key, res.get(key));
      continue;
    }
    const sub = new PdfDict();
    for (const entryKey of value.keys()) {
      const entry = value.get(entryKey);
      const target = resolve(pdf, entry);
      if (k === "XObject" && target instanceof PdfStream && entry instanceof PdfRef) {
        const id = `${entry.objectNumber} ${entry.generation}`;
        sub.set(entryKey, seen.has(id) ? seen.get(id) : copyStream(pdf, target, seen, id));
      } else {
        sub.set(entryKey, entry);
      }
    }
    out.set(key, sub);
  }
  return out;
}

/** Give each listed page resources (and forms and pictures) that no other page shares. */
export function unsharePages(pdf, indexes) {
  for (const i of indexes) {
    const page = pdf.getPage(i);
    page.dict.set("Resources", ownCopy(pdf, inheritedResources(pdf, page)));
  }
}

/** Replace the content and resources of master's pages with those of the same pages in `cleaned`. */
export async function transplant(master, cleanedBytes, indexes) {
  const cleaned = await openPdf(cleanedBytes);
  const start = master.getPageCount();
  const copies = await master.copyPagesFrom(cleaned, indexes, { includeAnnotations: false, includeThumbnails: false, includeStructure: false });
  copies.forEach((copy, k) => {
    const page = master.getPage(indexes[k]);
    page.dict.set("Contents", copy.dict.get("Contents") ?? new PdfArray([]));
    page.dict.set("Resources", copy.dict.get("Resources") ?? inheritedResources(master, copy));
  });
  for (let i = master.getPageCount() - 1; i >= start; i -= 1) master.removePage(i);
}

function toEngineRect(r) {
  return { origin: { x: r.x, y: r.y }, size: { width: r.width, height: r.height } };
}

/** What a character keeps of its box inside `r`: the share of its area. */
function overlapShare(box, r) {
  const w = Math.min(box.x + box.width, r.x + r.width) - Math.max(box.x, r.x);
  const h = Math.min(box.y + box.height, r.y + r.height) - Math.max(box.y, r.y);
  if (w <= 0.01 || h <= 0.01) return 0; // touching edges (and rounding) is no overlap
  return (w * h) / Math.max(1e-6, box.width * box.height);
}

/** Which characters a rect takes (the Java service's rules). */
export const TAKES = {
  // redaction: a fifth of the character's box is enough
  redact: (box, r) => overlapShare(box, r) >= 0.2,
  // Edit text: the middle of the character
  cover: (box, r) => {
    const mx = box.x + box.width / 2;
    const my = box.y + box.height / 2;
    return mx >= r.x - 0.5 && mx <= r.x + r.width + 0.5 && my >= r.y - 0.5 && my <= r.y + r.height + 0.5;
  },
};

/**
 * PDFium removes every character a rect touches. Pull each rect's edges in
 * past the characters it should keep (those `takes` says no to), so only the
 * others go; the pictures and shapes under the rect go with them.
 */
function fitRects(chars, rects, takes) {
  const out = [];
  for (const rect of rects) {
    let r = { ...rect };
    for (let round = 0; round < 50; round += 1) {
      const keep = chars.find((c) => c.box && !/\s/.test(c.ch) && overlapShare(c.box, r) > 0 && !takes(c.box, rect));
      if (!keep) break;
      const g = 0.05; // just past the character
      const b = { x: keep.box.x - g, y: keep.box.y - g, width: keep.box.width + 2 * g, height: keep.box.height + 2 * g };
      // move the edge that has the least way to go (a line just touching the
      // rect is cut off once, not one character at a time)
      const options = [
        { depth: b.y + b.height - r.y, rect: { ...r, y: b.y + b.height, height: r.y + r.height - (b.y + b.height) } },
        { depth: r.y + r.height - b.y, rect: { ...r, height: b.y - r.y } },
        { depth: b.x + b.width - r.x, rect: { ...r, x: b.x + b.width, width: r.x + r.width - (b.x + b.width) } },
        { depth: r.x + r.width - b.x, rect: { ...r, width: b.x - r.x } },
      ].filter((o) => o.depth > 0 && o.rect.width > 0.5 && o.rect.height > 0.5);
      if (!options.length) {
        r = null;
        break;
      }
      r = options.sort((a, c) => a.depth - c.depth)[0].rect;
    }
    if (r) out.push(r);
  }
  return out;
}

/**
 * Remove what lies under `rectsByPage` (Map page index -> [{x, y, width, height}]
 * visual rects) from `master` (a LibPDF document). `takes` decides which
 * characters a rect takes (TAKES.redact or TAKES.cover).
 * Returns {glyphs, textLeft: Map page -> characters still there}.
 */
export async function erase(master, rectsByPage, { takes = TAKES.cover } = {}) {
  if (!rectsByPage.size) return { glyphs: 0, textLeft: new Map() };
  const indexes = [...rectsByPage.keys()];
  const before = await snapshot(master);
  const work = await openPdf(before);
  unsharePages(work, indexes);
  const prepared = await savePdf(work);

  // which characters go, and the rects that take exactly those
  const raw = await RawPdf.open(prepared);
  const fitted = new Map();
  const counted = new Map();
  try {
    for (const [index, rects] of rectsByPage) {
      const { chars } = raw.pageChars(index);
      counted.set(index, chars.filter((c) => c.box && !/\s/.test(c.ch) && rects.some((r) => takes(c.box, r))).length);
      fitted.set(index, { rects, fit: fitRects(chars, rects, takes) });
    }
  } finally {
    raw.close();
  }

  const { engine } = await pdfium();
  let cleaned;
  let doc;
  try {
    doc = await engine.openDocumentBuffer({ id: crypto.randomUUID(), content: prepared.slice().buffer }).toPromise();
    for (const [index, { fit }] of fitted) {
      if (!fit.length) continue;
      await engine.redactTextInRects(doc, doc.pages[index], fit.map(toEngineRect), { recurseForms: true, drawBlackBoxes: false }).toPromise();
    }
    cleaned = new Uint8Array(await engine.saveAsCopy(doc).toPromise());
  } catch (err) {
    throw pdfError(err?.reason?.message ? new Error(err.reason.message) : err);
  } finally {
    if (doc) await engine.closeDocument(doc).toPromise().catch(() => {});
  }

  // what is still there
  const after = await RawPdf.open(cleaned);
  const textLeft = new Map();
  try {
    for (const [index, { rects }] of fitted) {
      const { chars } = after.pageChars(index);
      textLeft.set(index, chars.filter((c) => c.box && !/\s/.test(c.ch) && rects.some((r) => takes(c.box, r))).length);
    }
  } finally {
    after.close();
  }
  await transplant(master, cleaned, indexes);
  let glyphs = 0;
  for (const i of indexes) glyphs += Math.max(0, (counted.get(i) || 0) - (textLeft.get(i) || 0));
  return { glyphs, textLeft };
}
