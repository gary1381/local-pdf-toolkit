// Whole-document operations (the gateway does these with qpdf): merge, split,
// rotate, keep/reorder pages, flatten, unlock, encrypt; and text extraction.

import { zipSync } from "fflate";
import { bytes, HttpError, json, PAGE_LIST_RE, PAGE_RANGE_RE, pagesInRange, readPdfUpload } from "../http.js";
import { openPdf, PDF, pdfError, savePdf } from "../libs.js";
import { loadDocument, mutate } from "../session.js";

const MAX_TOTAL = 400 * 1024 * 1024;

export async function merge(req) {
  const files = req.form.files("files");
  if (files.length < 2) throw new HttpError(400, "Merging needs at least two PDF files");
  const sources = [];
  let total = 0;
  for (const file of files) {
    const data = await readPdfUpload(file);
    total += data.byteLength;
    if (total > MAX_TOTAL) throw new HttpError(413, "Total size is over the limit (400 MB)");
    sources.push(data);
  }
  try {
    const merged = await PDF.merge(sources, { lenient: true, includeAnnotations: true });
    return bytes(await savePdf(merged));
  } catch (err) {
    throw pdfError(err);
  }
}

export async function split(req) {
  const pages = req.form.get("pages", "1");
  if (!PAGE_RANGE_RE.test(pages)) throw new HttpError(400, "Invalid page range; use a form like 1-3,5,8-");
  const unify = req.form.bool("unify", true);
  const { data, filename } = await loadDocument(req.form);
  const pdf = await openPdf(data, req.form.get("password"));
  const count = pdf.getPageCount();
  const selected = pagesInRange(pages, count);
  if (!selected.length) throw new HttpError(400, "The page range is outside the document; nothing to split");
  try {
    if (unify) {
      const subset = await pdf.extractPages(selected.map((n) => n - 1), { includeAnnotations: true });
      return bytes(await savePdf(subset));
    }
    const stem = (filename || "document.pdf").replace(/\.pdf$/i, "") || "document";
    const width = String(count).length;
    const used = new Map();
    const files = {};
    for (const n of selected) {
      used.set(n, (used.get(n) || 0) + 1);
      const extra = used.get(n) > 1 ? `-${used.get(n)}` : "";
      const one = await pdf.extractPages([n - 1], { includeAnnotations: true });
      files[`${stem}-page-${String(n).padStart(width, "0")}${extra}.pdf`] = await savePdf(one);
    }
    return bytes(zipSync(files), "application/zip");
  } catch (err) {
    throw pdfError(err);
  }
}

export async function extract(req) {
  const { data } = await loadDocument(req.form);
  const pdf = await openPdf(data, req.form.get("password"));
  try {
    const pages = pdf.extractText();
    const text = pages.map((page) => page.text ?? "").join("\n\f");
    return json({ text, pageCount: pdf.getPageCount() });
  } catch (err) {
    throw pdfError(err);
  }
}

export async function encrypt(req) {
  const userPassword = req.form.get("user_password", null);
  if (userPassword === null) throw new HttpError(422, "Invalid request parameters: user_password");
  if (!userPassword) throw new HttpError(400, "Enter a password");
  const keyLength = req.form.int("key_length", 256);
  if (![128, 256].includes(keyLength)) throw new HttpError(400, "Key length must be 128 or 256");
  const { data } = await loadDocument(req.form);
  const pdf = await openPdf(data);
  try {
    pdf.setProtection({
      userPassword,
      ownerPassword: req.form.get("owner_password") || userPassword,
      algorithm: keyLength === 256 ? "AES-256" : "AES-128",
    });
    return bytes(await savePdf(pdf));
  } catch (err) {
    throw pdfError(err);
  }
}

export function rotate(req) {
  const angle = ((req.form.int("angle", 90) % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(angle)) throw new HttpError(400, "Rotation must be 90, 180 or 270 degrees");
  const pages = req.form.get("pages");
  if (pages && !PAGE_RANGE_RE.test(pages)) throw new HttpError(400, "Invalid page range; use a form like 1,3-5");
  return mutate(req.form, async (data) => {
    const pdf = await openPdf(data, req.form.get("password"));
    const count = pdf.getPageCount();
    const selected = pages ? new Set(pagesInRange(pages, count)) : null;
    pdf.getPages().forEach((page, i) => {
      if (selected && !selected.has(i + 1)) return;
      page.setRotation((page.rotation + angle) % 360);
    });
    return savePdf(pdf);
  });
}

export function selectPages(req) {
  const order = req.form.get("order", null);
  if (order === null) throw new HttpError(422, "Invalid request parameters: order");
  if (!PAGE_LIST_RE.test(order)) throw new HttpError(400, "Invalid page order; use a form like 3,1,2");
  const numbers = order.replace(/\s+/g, "").split(",").map(Number);
  if (numbers.some((n) => n < 1)) throw new HttpError(400, "Page numbers start at 1");
  if (new Set(numbers).size !== numbers.length) throw new HttpError(400, "The page order repeats a page");
  return mutate(req.form, async (data) => {
    const pdf = await openPdf(data, req.form.get("password"));
    const count = pdf.getPageCount();
    if (numbers.some((n) => n > count)) throw new HttpError(400, "Page number is outside the document");
    // Work in the same document, so metadata, outlines and form fields stay.
    const key = (page) => `${page.ref.objectNumber} ${page.ref.generation}`;
    const refs = pdf.getPages().map(key);
    const keep = new Set(numbers.map((n) => refs[n - 1]));
    for (let i = count - 1; i >= 0; i -= 1) if (!keep.has(refs[i])) pdf.removePage(i);
    numbers.forEach((n, target) => {
      const from = pdf.getPages().findIndex((page) => key(page) === refs[n - 1]);
      if (from !== target) pdf.movePage(from, target);
    });
    return savePdf(pdf);
  });
}

export function flatten(req) {
  const mode = req.form.get("mode", "all");
  if (!["all", "print", "screen"].includes(mode)) throw new HttpError(400, "mode must be all, print or screen");
  return mutate(req.form, async (data) => {
    const pdf = await openPdf(data, req.form.get("password"));
    try {
      pdf.flattenAll();
    } catch (err) {
      throw pdfError(err);
    }
    return savePdf(pdf);
  });
}

export function unlock(req) {
  return mutate(req.form, async (data) => {
    const pdf = await openPdf(data, req.form.get("password"));
    try {
      if (pdf.getSecurity().isEncrypted) pdf.removeProtection();
    } catch (err) {
      throw pdfError(err);
    }
    return savePdf(pdf);
  });
}
