// The PDF libraries of the in-page services, loaded on first use.
//
// LibPDF (MIT): reading and writing PDF objects, pages, forms, annotations,
// fonts, encryption, signatures. PDFium (EmbedPDF build, MIT; PDFium itself
// BSD/Apache): rendering and removing content for redaction.

import { PDF } from "@libpdf/core";
import { HttpError } from "./http.js";

export { PDF };

/** Open a PDF with LibPDF; encrypted files need the password (or none, if only an owner password is set). */
export async function openPdf(data, password = "") {
  let pdf;
  try {
    pdf = await PDF.load(data, { lenient: true, ...(password ? { credentials: password } : {}) });
  } catch (err) {
    throw pdfError(err);
  }
  if (pdf.getSecurity?.().isEncrypted && !pdf.isAuthenticated?.() && pdf.authenticate) {
    const result = pdf.authenticate(password || "");
    if (result && result.authenticated === false) throw new HttpError(400, "The PDF is encrypted, or the password is wrong");
  }
  return pdf;
}

export function pdfError(err) {
  if (err instanceof HttpError) return err;
  const text = String(err?.message || err).toLowerCase();
  if (/password|encrypt|decrypt|authenticat/.test(text)) return new HttpError(400, "The PDF is encrypted, or the password is wrong");
  console.warn("[openpdf services] PDF error", err?.stack || err);
  return new HttpError(422, "The PDF could not be processed (it may be damaged or unsupported)");
}

export async function savePdf(pdf, options = {}) {
  return pdf.save({ useXRefStream: false, subsetFonts: true, ...options });
}

/**
 * The document's bytes as they are now, in the middle of an edit (for PDFium
 * to work on). LibPDF writes its embedded fonts once, at the first save, and
 * never again: so that the final save still writes every font (with all the
 * glyphs used by then), the fonts are made pending again afterwards.
 */
export async function snapshot(pdf) {
  const bytes = await savePdf(pdf);
  if (pdf.fonts && typeof pdf.fonts.finalized === "boolean") pdf.fonts.finalized = false;
  return bytes;
}

/** The file carries a digital signature (a signature dictionary with a byte range). */
export function isSigned(data) {
  const text = new TextDecoder("latin1").decode(data);
  return text.includes("/ByteRange");
}

/**
 * Save an edit (PdfboxServer.saveBytes): a signed file gets the change appended
 * after its original bytes, so its signatures stay intact (readers then show
 * "changed after signing"); any other file is written anew.
 */
export async function saveEdit(pdf, original) {
  // canSaveIncrementally() names what prevents it, or is null
  if (isSigned(original) && !pdf.canSaveIncrementally()) {
    try {
      return await pdf.save({ incremental: true });
    } catch (err) {
      console.warn("[openpdf services] incremental save failed, writing the whole file", err);
    }
  }
  return savePdf(pdf);
}

let pdfiumPromise = null;
let wasmOverride = null;

/** Tests outside a browser hand over the WebAssembly binary themselves. */
export function setPdfiumWasm(binary) {
  wasmOverride = binary;
}

/** PDFium (WebAssembly) and its document engine, initialised once. */
export function pdfium() {
  if (!pdfiumPromise) {
    pdfiumPromise = (async () => {
      const [{ init }, { PdfiumNative }] = await Promise.all([import("@embedpdf/pdfium"), import("@embedpdf/engines")]);
      const wasmBinary = wasmOverride || (await (await fetch("/ui/vendor/pdfium/pdfium.wasm")).arrayBuffer());
      const module = await init({ wasmBinary });
      module.PDFiumExt_Init();
      return { module, engine: new PdfiumNative(module) };
    })();
  }
  return pdfiumPromise;
}
