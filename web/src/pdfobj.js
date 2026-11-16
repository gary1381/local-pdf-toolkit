// Small helpers over LibPDF's object model: build objects from plain values
// and read them back.

import { PdfArray, PdfBool, PdfDict, PdfName, PdfNumber, PdfRef, PdfStream, PdfString } from "@libpdf/core";

/**
 * A PDF object from a plain value: numbers, booleans, "/Name" strings, arrays,
 * plain objects (dictionaries), `text("...")` strings, or LibPDF objects as they are.
 */
export function obj(value) {
  if (value instanceof PdfName || value instanceof PdfNumber || value instanceof PdfArray || value instanceof PdfDict
    || value instanceof PdfString || value instanceof PdfRef || value instanceof PdfBool || value instanceof PdfStream) {
    return value;
  }
  if (typeof value === "number") return PdfNumber.of(Math.round(value * 1e4) / 1e4);
  if (typeof value === "boolean") return value ? PdfBool.TRUE : PdfBool.FALSE;
  if (typeof value === "string") {
    if (value.startsWith("/")) return PdfName.of(value.slice(1));
    return PdfString.fromString(value);
  }
  if (Array.isArray(value)) return new PdfArray(value.map(obj));
  if (value && typeof value === "object") {
    const dict = new PdfDict();
    for (const [k, v] of Object.entries(value)) if (v !== undefined && v !== null) dict.set(k, obj(v));
    return dict;
  }
  throw new TypeError(`Cannot make a PDF object from ${value}`);
}

/** A PDF text string (literal) from JS text. */
export function text(s) {
  return PdfString.fromString(s);
}

export function resolve(pdf, value) {
  return value instanceof PdfRef ? pdf.getObject(value) : value;
}

export function num(pdf, value, fallback = 0) {
  const v = resolve(pdf, value);
  return v instanceof PdfNumber ? v.value : fallback;
}

export function name(pdf, value) {
  const v = resolve(pdf, value);
  return v instanceof PdfName ? v.value : null;
}

export function str(pdf, value) {
  const v = resolve(pdf, value);
  return v instanceof PdfString ? v.asString() : null;
}

export function array(pdf, value) {
  const v = resolve(pdf, value);
  return v instanceof PdfArray ? Array.from({ length: v.length }, (_, i) => v.at(i)) : [];
}

export function numbers(pdf, value) {
  return array(pdf, value).map((item) => num(pdf, item, NaN));
}

/** A content stream (or form XObject) from text, registered in the document. */
export function stream(pdf, dict, content) {
  const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return pdf.register(new PdfStream(obj(dict), data));
}

/** The page's /Annots array (made direct on the page), creating it if needed. */
export function annotsOf(pdf, page) {
  let annots = resolve(pdf, page.dict.get("Annots"));
  if (!(annots instanceof PdfArray)) {
    annots = new PdfArray([]);
  }
  page.dict.set("Annots", annots);
  return annots;
}

/** Numbers formatted for content streams. */
export function n(v) {
  return String(Math.round(v * 1000) / 1000);
}
