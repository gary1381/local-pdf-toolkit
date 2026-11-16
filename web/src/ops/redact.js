// Redaction that removes the content (redact), as the gateway and the Java
// service's Redactor do it:
//
//  0. the editor's text boxes become ordinary page content;
//  1. form fields are flattened into the page and the form removed (with
//     signatures and their validation data); encryption goes;
//  2. annotations mentioning a term go (with their popups and replies); the
//     other visible annotations are flattened into the page, where their text
//     can be searched;
//  3. the terms are found (also letter-spaced: "J o h n"); what lies under
//     them and under the given regions is removed from the page (characters,
//     the pixels of pictures, shapes; PDFium), black boxes are drawn; a page
//     where text is left is rebuilt as a picture of itself;
//  4. document-level copies (bookmarks, metadata, attachments, scripts, tags)
//     are cleaned, every page keeps only the resources it draws;
//  5. the saved file is checked: the text of every page is searched again and
//     every string and metadata / XML / attachment stream of every object is
//     scanned. If a term can still be found, nothing is written.

import { PdfArray, PdfDict, PdfRef, PdfStream, PdfString } from "@libpdf/core";
import { erase, TAKES } from "../content.js";
import { HttpError, json } from "../http.js";
import { openPdf, pdfError, pdfium, savePdf, snapshot } from "../libs.js";
import { boxesFor, findTerms, joins, RawPdf } from "../pdfium-text.js";
import { annotsOf, n, name, numbers, obj, resolve, str } from "../pdfobj.js";
import { loadDocument } from "../session.js";
import { pageSpace } from "../space.js";
import * as store from "../store.js";
import { isolateContents } from "./images.js";
import { applyEdits } from "./placements.js";

const MAX_TERMS = 200;
const MAX_REGIONS = 2000;
const RAW_SCAN_LIMIT = 300 * 1024 * 1024;

// ---------------------------------------------------------------- matching text (Redactor.norm, hasNeedle, containsAnyTerm)

const SPACES = /[\s ­]+/g;

function norm(s, cs) {
  const t = s.replace(SPACES, " ");
  return cs ? t : t.toLowerCase();
}

function squeeze(s, cs) {
  const t = s.replace(SPACES, "");
  return cs ? t : t.toLowerCase();
}

/** Short needles (up to 3 characters) must stand as a word; longer ones count anywhere. */
function hasNeedle(text, needles, cs) {
  if (!text) return false;
  const hay = norm(text, cs);
  for (const needle of needles) {
    const word = [...needle].length <= 3;
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      if (!word || ((at === 0 || !joins(hay[at - 1], hay[at])) && (end >= hay.length || !joins(hay[end - 1], hay[end])))) {
        return true;
      }
    }
  }
  return false;
}

function xmlUnescape(s) {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9A-Fa-f]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const cp = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try {
      return String.fromCodePoint(cp);
    } catch (_) {
      return m;
    }
  });
}

/** The text an XML document carries (element text, attribute values, comments, CDATA), not its markup. */
function xmlText(xml) {
  let out = "";
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      out += xmlUnescape(xml.slice(i));
      break;
    }
    out += `${xmlUnescape(xml.slice(i, lt))} `;
    if (xml.startsWith("<!--", lt)) {
      const e = xml.indexOf("-->", lt + 4);
      out += `${xml.slice(lt + 4, e < 0 ? xml.length : e)} `;
      i = e < 0 ? xml.length : e + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const e = xml.indexOf("]]>", lt + 9);
      out += `${xml.slice(lt + 9, e < 0 ? xml.length : e)} `;
      i = e < 0 ? xml.length : e + 3;
    } else {
      let e = lt + 1;
      let quote = "";
      let value = "";
      for (; e < xml.length; e += 1) {
        const c = xml[e];
        if (quote) {
          if (c === quote) {
            out += `${xmlUnescape(value)} `;
            quote = "";
          } else value += c;
        } else if (c === '"' || c === "'") {
          const attr = /([\w:.-]+)\s*=\s*$/.exec(xml.slice(Math.max(lt, e - 200), e));
          if (attr && (attr[1] === "xmlns" || attr[1].startsWith("xmlns:"))) {
            const close = xml.indexOf(c, e + 1);
            e = close < 0 ? xml.length - 1 : close;
            continue;
          }
          quote = c;
          value = "";
        } else if (c === ">") break;
      }
      if (quote) out += xmlUnescape(value);
      i = e + 1;
    }
  }
  return out;
}

/** True if the text mentions a term: long terms ignoring all spaces, short ones as a word. */
function containsAnyTerm(text, terms, cs) {
  if (!text) return false;
  const loose = [];
  const words = [];
  for (const t of terms) {
    const sq = squeeze(t, cs);
    if ([...sq].length <= 3) words.push(norm(t, cs).trim());
    else loose.push(sq);
  }
  const unescaped = xmlUnescape(text);
  const anyLoose = (s) => {
    const hay = squeeze(s, cs);
    return loose.some((needle) => hay.includes(needle));
  };
  return anyLoose(text) || anyLoose(unescaped) || hasNeedle(text, words, cs) || hasNeedle(unescaped, words, cs);
}

function latin1(bytes) {
  return new TextDecoder("latin1").decode(bytes);
}

function streamText(pdf, value) {
  const s = resolve(pdf, value);
  if (!(s instanceof PdfStream)) return null;
  try {
    return latin1(s.getDecodedData().subarray(0, 4 * 1024 * 1024));
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------- forms (Redactor.removeForm)

function pagesOf(pdf) {
  return pdf.getPages();
}

/** Flatten ordinary fields into the page, remove signatures and the form. Returns [flattened, signatures, dropped]. */
function removeForm(pdf) {
  const catalog = pdf.getCatalog();
  catalog.delete("DSS");
  const form = pdf.getForm();
  let flattened = 0;
  let signatures = 0;
  let dropped = 0;
  if (form) {
    const fields = form.getFields();
    const ordinary = fields.filter((f) => f.type !== "signature");
    signatures = fields.length - ordinary.length;
    form.acroForm().getDict().delete("XFA");
    if (ordinary.length) {
      try {
        form.acroForm().getDict().delete("NeedAppearances");
        form.updateAppearances();
      } catch (_) {
        // keep the appearances the file has
      }
      let shown = 0;
      for (const f of ordinary) {
        const value = f.getValue?.();
        const blank = value == null || (Array.isArray(value) ? !value.join("").trim() : !String(value).trim());
        const visible = f.getWidgets().some((w) => !w.isHidden() && w.hasNormalAppearance());
        if (blank || visible) shown += 1;
      }
      try {
        form.flatten();
        flattened = shown;
        dropped = ordinary.length - shown;
      } catch (_) {
        dropped = ordinary.length;
      }
    }
  }
  // any widget left (signatures, fields that could not be flattened) goes too
  for (const page of pagesOf(pdf)) {
    const annots = resolve(pdf, page.dict.get("Annots"));
    if (!(annots instanceof PdfArray)) continue;
    const list = annotsOf(pdf, page);
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const a = resolve(pdf, list.at(i));
      if (a instanceof PdfDict && (name(pdf, a.get("Subtype")) === "Widget" || a.has("FT"))) list.remove(i);
    }
  }
  catalog.delete("AcroForm");
  catalog.delete("Perms");
  return [flattened, signatures, dropped];
}

// ---------------------------------------------------------------- annotations (Redactor.cleanAnnotations)

function annotationMentions(pdf, a, terms, cs) {
  for (const key of ["Contents", "RC", "T", "Subj", "TU"]) {
    const v = resolve(pdf, a.get(key));
    const s = v instanceof PdfString ? v.asString() : v instanceof PdfStream ? streamText(pdf, v) : null;
    if (containsAnyTerm(s, terms, cs)) return true;
  }
  const action = resolve(pdf, a.get("A"));
  if (action instanceof PdfDict && containsAnyTerm(str(pdf, action.get("URI")), terms, cs)) return true;
  const ap = resolve(pdf, a.get("AP"));
  if (ap instanceof PdfDict) {
    for (const key of ap.keys()) {
      const state = resolve(pdf, ap.get(key));
      if (state instanceof PdfStream && containsAnyTerm(streamText(pdf, state), terms, cs)) return true;
      if (state instanceof PdfDict) {
        for (const k of state.keys()) {
          const inner = resolve(pdf, state.get(k));
          if (inner instanceof PdfStream && containsAnyTerm(streamText(pdf, inner), terms, cs)) return true;
        }
      }
    }
  }
  return false;
}

const refKey = (r) => (r instanceof PdfRef ? `${r.objectNumber} ${r.generation}` : null);

/**
 * Remove annotations that mention a term (and, with terms, file attachments),
 * then popups and replies whose parent is gone. Returns {removed, termHits}.
 */
function cleanAnnotations(pdf, rebuilt, terms, cs) {
  const pages = [];
  const present = new Set();
  const drop = new Set();
  let termHits = 0;
  pagesOf(pdf).forEach((page, i) => {
    if (rebuilt.has(i)) return;
    const annots = annotsOf(pdf, page);
    const items = Array.from({ length: annots.length }, (_, k) => annots.at(k));
    pages.push({ page, annots, items });
    for (const item of items) {
      const key = refKey(item);
      const a = resolve(pdf, item);
      if (!(a instanceof PdfDict)) continue;
      if (key) present.add(key);
      if (!terms.length) continue;
      if (annotationMentions(pdf, a, terms, cs)) {
        if (key) drop.add(key);
        termHits += 1;
      } else if (a.get("FS")) {
        if (key) drop.add(key);
      } else if (containsAnyTerm(str(pdf, a.get("NM")), terms, cs)) {
        a.delete("NM");
      }
    }
  });
  const gone = (ref) => {
    const key = refKey(ref);
    return key && (drop.has(key) || !present.has(key));
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const { items } of pages) {
      for (const item of items) {
        const key = refKey(item);
        const a = resolve(pdf, item);
        if (!key || drop.has(key) || !(a instanceof PdfDict)) continue;
        const parent = name(pdf, a.get("Subtype")) === "Popup" ? a.get("Parent") : null;
        if ((parent && gone(parent)) || (a.get("IRT") && gone(a.get("IRT")))) {
          drop.add(key);
          grew = true;
        }
      }
    }
  }
  let removed = 0;
  for (const { annots, items } of pages) {
    for (let k = items.length - 1; k >= 0; k -= 1) {
      if (drop.has(refKey(items[k]))) {
        annots.remove(k);
        removed += 1;
      }
    }
    for (const item of items) {
      const a = resolve(pdf, item);
      if (a instanceof PdfDict && !drop.has(refKey(item)) && a.get("Popup") && gone(a.get("Popup"))) a.delete("Popup");
    }
  }
  return { removed, termHits };
}

function visibleAnnotations(pdf) {
  let count = 0;
  for (const page of pagesOf(pdf)) {
    const annots = resolve(pdf, page.dict.get("Annots"));
    if (!(annots instanceof PdfArray)) continue;
    for (let i = 0; i < annots.length; i += 1) {
      const a = resolve(pdf, annots.at(i));
      if (!(a instanceof PdfDict)) continue;
      const sub = name(pdf, a.get("Subtype"));
      const flags = resolve(pdf, a.get("F"))?.value ?? 0;
      if (sub !== "Widget" && sub !== "Popup" && !(flags & 2) && !(flags & 1) && a.get("AP")) count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------- the document (Redactor.cleanDocument)

function scrubOutline(pdf, first, terms, cs, seen = new Set()) {
  let count = 0;
  for (let ref = first; ref && !seen.has(refKey(ref) ?? ref); ref = resolve(pdf, ref)?.get("Next")) {
    seen.add(refKey(ref) ?? ref);
    const item = resolve(pdf, ref);
    if (!(item instanceof PdfDict)) break;
    if (containsAnyTerm(str(pdf, item.get("Title")), terms, cs)) {
      item.set("Title", PdfString.fromString("[redacted]"));
      count += 1;
    }
    const action = resolve(pdf, item.get("A"));
    if (action instanceof PdfDict && containsAnyTerm(str(pdf, action.get("URI")), terms, cs)) {
      item.delete("A");
      count += 1;
    }
    count += scrubOutline(pdf, item.get("First"), terms, cs, seen);
  }
  return count;
}

function infoDict(pdf) {
  const trailer = pdf.ctx.info.trailer;
  const info = resolve(pdf, trailer.get("Info"));
  return info instanceof PdfDict ? info : null;
}

function cleanDocument(pdf, terms, cs, removeMetadata, pagesRebuilt) {
  const removed = [];
  const cat = pdf.getCatalog();
  if (cat.has("StructTreeRoot") && (pagesRebuilt || terms.length)) {
    cat.delete("StructTreeRoot");
    cat.delete("MarkInfo");
    removed.push("accessibility tags (they repeat the page text)");
  }
  const names = resolve(pdf, cat.get("Names"));
  if (names instanceof PdfDict) {
    if (names.has("EmbeddedFiles")) {
      names.delete("EmbeddedFiles");
      removed.push("embedded files");
    }
    if (names.has("JavaScript")) {
      names.delete("JavaScript");
      removed.push("document JavaScript");
    }
  }
  if (cat.has("AA")) {
    cat.delete("AA");
    removed.push("document actions");
  }
  const open = resolve(pdf, cat.get("OpenAction"));
  if (open instanceof PdfDict && name(pdf, open.get("S")) !== "GoTo") {
    cat.delete("OpenAction");
    removed.push("open action");
  }
  for (const key of ["Collection", "AF", "PieceInfo"]) cat.delete(key);
  const outlines = resolve(pdf, cat.get("Outlines"));
  if (outlines instanceof PdfDict && terms.length) {
    const count = scrubOutline(pdf, outlines.get("First"), terms, cs);
    if (count) removed.push(`${count} bookmark title(s)`);
  }
  const info = infoDict(pdf);
  if (removeMetadata) {
    if (info) for (const key of [...info.keys()]) info.delete(key);
    cat.delete("Metadata");
    removed.push("all document metadata (requested)");
  } else if (terms.length) {
    if (info) {
      for (const key of [...info.keys()]) {
        const v = resolve(pdf, info.get(key));
        const text = v instanceof PdfString ? v.asString() : null;
        if (containsAnyTerm(text, terms, cs)) {
          info.delete(key);
          removed.push(`metadata field ${key.value ?? key}`);
        }
      }
    }
    const xmp = streamText(pdf, cat.get("Metadata"));
    if (xmp && containsAnyTerm(new TextDecoder("utf-8").decode(new TextEncoder().encode(xmp)), terms, cs)) {
      cat.delete("Metadata");
      removed.push("XMP metadata");
    }
  }
  return removed;
}

// ---------------------------------------------------------------- resources (Redactor.pruneResources)

const RESOURCE_KINDS = ["Font", "XObject", "ExtGState", "ColorSpace", "Pattern", "Shading", "Properties"];

function contentBytes(pdf, contents) {
  const c = resolve(pdf, contents);
  const parts = c instanceof PdfArray ? Array.from({ length: c.length }, (_, i) => resolve(pdf, c.at(i))) : [c];
  return parts.filter((p) => p instanceof PdfStream).map((p) => {
    try {
      return latin1(p.getDecodedData());
    } catch (_) {
      return "";
    }
  }).join("\n");
}

/** Every name in a content stream: a superset of the resources it uses. */
function namesIn(content) {
  const used = new Set();
  for (const m of content.matchAll(/\/([^\s/<>[\]()%{}]+)/g)) {
    used.add(m[1].replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
  }
  return used;
}

/** A pruned copy of `res`: only the names `content` uses; forms, patterns and Type 3 fonts pruned in turn. */
function prune(pdf, res, content, done) {
  const out = new PdfDict();
  const used = namesIn(content);
  for (const key of res.keys()) {
    const k = key.value ?? String(key);
    const value = resolve(pdf, res.get(key));
    if (!RESOURCE_KINDS.includes(k) || !(value instanceof PdfDict)) {
      out.set(key, res.get(key));
      continue;
    }
    const sub = new PdfDict();
    for (const entry of value.keys()) {
      if (!used.has(entry.value ?? String(entry))) continue;
      const ref = value.get(entry);
      sub.set(entry, ref);
      const target = resolve(pdf, ref);
      const id = refKey(ref);
      if (target instanceof PdfStream && (!id || !done.has(id))) {
        if (id) done.add(id);
        const inner = resolve(pdf, target.get("Resources"));
        if (inner instanceof PdfDict) {
          let own = "";
          try {
            own = latin1(target.getDecodedData());
          } catch (_) {
            own = "";
          }
          target.set("Resources", prune(pdf, inner, own, done));
        }
      }
    }
    out.set(key, sub);
  }
  return out;
}

/** Every page keeps only what its content uses (nothing removed survives through shared resources). */
function pruneResources(pdf) {
  const done = new Set();
  for (const page of pagesOf(pdf)) {
    let res = resolve(pdf, page.dict.get("Resources"));
    for (let node = resolve(pdf, page.dict.get("Parent")); !(res instanceof PdfDict) && node; node = resolve(pdf, node.get("Parent"))) {
      res = resolve(pdf, node.get("Resources"));
    }
    if (!(res instanceof PdfDict)) continue;
    page.dict.set("Resources", prune(pdf, res, contentBytes(pdf, page.dict.get("Contents")), done));
  }
  // inherited resources on the page tree are no longer needed
  const stack = [resolve(pdf, pdf.getCatalog().get("Pages"))];
  while (stack.length) {
    const node = stack.pop();
    if (!(node instanceof PdfDict) || name(pdf, node.get("Type")) === "Page") continue;
    node.delete("Resources");
    const kids = resolve(pdf, node.get("Kids"));
    if (kids instanceof PdfArray) for (let i = 0; i < kids.length; i += 1) stack.push(resolve(pdf, kids.at(i)));
  }
}

/** Marked-content properties that repeat text (/ActualText, /Alt, /E) taken out of a page's content. */
function stripActualText(pdf, page) {
  const contents = resolve(pdf, page.dict.get("Contents"));
  const parts = contents instanceof PdfArray ? Array.from({ length: contents.length }, (_, i) => contents.at(i)) : [page.dict.get("Contents")];
  let changed = false;
  const out = parts.map((ref) => {
    const s = resolve(pdf, ref);
    if (!(s instanceof PdfStream)) return ref;
    let text;
    try {
      text = latin1(s.getDecodedData());
    } catch (_) {
      return ref;
    }
    const cleaned = text.replace(/\/(ActualText|Alt|E)\s*(\((?:\\[\s\S]|[^\\)])*\)|<[0-9A-Fa-f\s]*>)/g, "");
    if (cleaned === text) return ref;
    changed = true;
    return pdf.register(new PdfStream(new PdfDict(), Uint8Array.from(cleaned, (c) => c.charCodeAt(0))));
  });
  if (changed) page.dict.set("Contents", out.length === 1 ? out[0] : new PdfArray(out));
}

// ---------------------------------------------------------------- pages that must become pictures

function usesTilingPatterns(pdf, res, seen = new Set()) {
  if (!(res instanceof PdfDict)) return false;
  const patterns = resolve(pdf, res.get("Pattern"));
  if (patterns instanceof PdfDict) {
    for (const key of patterns.keys()) {
      const p = resolve(pdf, patterns.get(key));
      if (p instanceof PdfDict && resolve(pdf, p.get("PatternType"))?.value === 1) return true;
    }
  }
  const xobjects = resolve(pdf, res.get("XObject"));
  if (xobjects instanceof PdfDict) {
    for (const key of xobjects.keys()) {
      const ref = xobjects.get(key);
      const id = refKey(ref);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      const x = resolve(pdf, ref);
      if (x instanceof PdfStream && usesTilingPatterns(pdf, resolve(pdf, x.get("Resources")), seen)) return true;
    }
  }
  return false;
}

/** Rewrite the page in place as one picture of itself (rendered without annotations), the boxes burnt in. */
async function rebuildAsPicture(pdf, index, boxes, dpi) {
  if (typeof OffscreenCanvas === "undefined") throw new HttpError(422, "Some text could not be taken out of a page, and this page cannot be rebuilt as a picture here. Nothing was written.");
  const bytes = await snapshot(pdf);
  const { engine } = await pdfium();
  const doc = await engine.openDocumentBuffer({ id: crypto.randomUUID(), content: bytes.slice().buffer }).toPromise();
  let image;
  try {
    image = await engine.renderPageRaw(doc, doc.pages[index], { scaleFactor: dpi / 72, withAnnotations: false, withForms: false }).toPromise();
  } finally {
    await engine.closeDocument(doc).toPromise().catch(() => {});
  }
  const page = pdf.getPage(index);
  const space = pageSpace(page);
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.byteLength), image.width, image.height), 0, 0);
  const sx = image.width / space.vw;
  const sy = image.height / space.vh;
  ctx.fillStyle = "#000";
  for (const b of boxes) ctx.fillRect(Math.floor(b.x * sx), Math.floor(b.y * sy), Math.ceil(b.width * sx) + 1, Math.ceil(b.height * sy) + 1);
  const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 })).arrayBuffer());
  const picture = pdf.embedJpeg(jpeg);
  for (const key of ["Annots", "StructParents", "Thumb", "PieceInfo", "B", "Metadata", "AA", "VP", "ID", "PZ", "SeparationInfo",
    "Group", "BleedBox", "TrimBox", "ArtBox", "BoxColorInfo", "UserUnit", "Tabs", "TemplateInstantiated", "PresSteps", "DPart",
    "AF", "OutputIntents"]) page.dict.delete(key);
  page.dict.set("MediaBox", obj([0, 0, space.vw, space.vh]));
  page.dict.set("CropBox", obj([0, 0, space.vw, space.vh]));
  page.dict.set("Rotate", obj(0));
  page.dict.set("Resources", obj({ XObject: { Im0: picture.ref } }));
  page.dict.set("Contents", pdf.register(new PdfStream(new PdfDict(), new TextEncoder().encode(`q ${n(space.vw)} 0 0 ${n(space.vh)} 0 0 cm /Im0 Do Q\n`))));
}

/** Black boxes over the redacted areas of a page kept as text (what was there is gone already). */
function blackBoxes(pdf, page, boxes) {
  const space = pageSpace(page);
  isolateContents(pdf, page);
  const rects = boxes.map((b) => `${n(b.x)} ${n(space.vh - b.y - b.height)} ${n(b.width)} ${n(b.height)} re`).join(" ");
  const content = `q ${space.matrix.map(n).join(" ")} cm 0 g ${rects} f Q\n`;
  const contents = resolve(pdf, page.dict.get("Contents"));
  contents.push(pdf.register(new PdfStream(new PdfDict(), new TextEncoder().encode(content))));
}

function annotationsOverBoxes(pdf, page, boxes) {
  const annots = resolve(pdf, page.dict.get("Annots"));
  if (!(annots instanceof PdfArray)) return 0;
  const space = pageSpace(page);
  let removed = 0;
  for (let i = annots.length - 1; i >= 0; i -= 1) {
    const a = resolve(pdf, annots.at(i));
    if (!(a instanceof PdfDict)) continue;
    const [x1, y1, x2, y2] = numbers(pdf, a.get("Rect"));
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    const r = space.viewRect(x1, y1, x2, y2);
    if (boxes.some((b) => r.x < b.x + b.width && r.x + r.width > b.x && r.y < b.y + b.height && r.y + r.height > b.y)) {
      annots.remove(i);
      removed += 1;
    }
  }
  return removed;
}

// ---------------------------------------------------------------- the check (Redactor.verify)

function scanObject(pdf, value, needles, cs, budget, seen) {
  if (value == null || value instanceof PdfRef || seen.has(value)) return false;
  seen.add(value);
  if (value instanceof PdfString) return hasNeedle(value.asString(), needles, cs);
  if (value instanceof PdfArray) {
    for (let i = 0; i < value.length; i += 1) if (scanObject(pdf, value.at(i), needles, cs, budget, seen)) return true;
    return false;
  }
  if (value instanceof PdfDict) {
    for (const key of value.keys()) if (scanObject(pdf, value.get(key), needles, cs, budget, seen)) return true;
    if (value instanceof PdfStream) {
      const type = name(pdf, value.get("Type"));
      const subtype = name(pdf, value.get("Subtype"));
      if (type !== "Metadata" && type !== "EmbeddedFile" && subtype !== "XML") return false;
      if (budget.left <= 0) return false;
      let data;
      try {
        data = value.getDecodedData();
      } catch (_) {
        return false;
      }
      if (data.length > budget.left) {
        data = data.subarray(0, budget.left);
        budget.left = 0;
      } else budget.left -= data.length;
      const utf8 = new TextDecoder("utf-8").decode(data);
      const lat = latin1(data);
      const xml = type !== "EmbeddedFile" || utf8.trimStart().startsWith("<");
      if (xml) {
        const utf16 = data.length > 1 && data.length % 2 === 0 && (data[0] === 0 || data[1] === 0 || data[0] >= 0xfe)
          ? new TextDecoder("utf-16be").decode(data) : "";
        return hasNeedle(xmlText(utf8), needles, cs) || hasNeedle(xmlText(lat), needles, cs) || (utf16 && hasNeedle(xmlText(utf16), needles, cs));
      }
      return hasNeedle(utf8, needles, cs) || hasNeedle(xmlUnescape(utf8), needles, cs) || hasNeedle(lat, needles, cs)
        || (data.length % 2 === 0 && hasNeedle(new TextDecoder("utf-16be").decode(data), needles, cs));
    }
  }
  return false;
}

async function verify(bytes, terms, cs) {
  if (!terms.length) return { remainingMatches: 0, rawObjectHits: [], verified: true };
  const raw = await RawPdf.open(bytes);
  let remaining = 0;
  try {
    for (let i = 0; i < raw.pageCount; i += 1) remaining += findTerms(raw.pageChars(i), terms, cs).length;
  } finally {
    raw.close();
  }
  const needles = terms.map((t) => norm(t, cs).trim()).filter((t) => [...t].length >= 2);
  const hits = [];
  const budget = { left: RAW_SCAN_LIMIT };
  const pdf = await openPdf(bytes);
  const registry = pdf.ctx.registry;
  for (let num = 1; num < registry.nextObjectNumber && hits.length < 20; num += 1) {
    let value;
    try {
      value = pdf.getObject(PdfRef.of(num, 0));
    } catch (_) {
      value = null;
    }
    if (value && needles.length && scanObject(pdf, value, needles, cs, budget, new Set())) hits.push(`object ${num}`);
  }
  if (needles.length && scanObject(pdf, pdf.ctx.info.trailer, needles, cs, budget, new Set())) hits.push("trailer");
  const complete = budget.left > 0;
  return { remainingMatches: remaining, rawObjectHits: hits, rawScanComplete: complete, verified: remaining === 0 && !hits.length && complete };
}

// ---------------------------------------------------------------- the endpoint

function compact(pages) {
  const out = [];
  for (let i = 0; i < pages.length; i += 1) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j += 1;
    out.push(j > i ? `${pages[i]}-${pages[j]}` : `${pages[i]}`);
    i = j;
  }
  return out.join(",");
}

function parseList(raw, what) {
  if (!raw) return [];
  let value;
  try {
    value = JSON.parse(raw);
  } catch (_) {
    value = null;
  }
  if (!Array.isArray(value)) throw new HttpError(400, `${what} must be a JSON array`);
  return value;
}

async function runRedaction(data, filename, form) {
  const terms = parseList(form.get("terms"), "terms").map((t) => String(t)).filter((t) => t.trim());
  if (terms.length > MAX_TERMS) throw new HttpError(400, "Too many terms (limit 200)");
  const regionsIn = parseList(form.get("regions"), "regions");
  for (const r of regionsIn) {
    if (!r || typeof r !== "object" || !["page", "x", "y", "width", "height"].every((k) => k in r)) {
      throw new HttpError(400, "Each region needs page, x, y, width and height");
    }
  }
  if (!terms.length && !regionsIn.length) throw new HttpError(400, "Give terms or regions to redact");
  if (regionsIn.length > MAX_REGIONS) throw new HttpError(400, "Too many terms or regions (limits: 200 terms, 2000 regions)");
  const cs = form.bool("case_sensitive");
  const removeMetadata = form.bool("remove_metadata");
  const keepText = form.bool("keep_text", true);
  const dpi = Math.min(400, Math.max(72, form.int("dpi", 200)));
  const editsRaw = form.get("edits");
  const edits = editsRaw ? parseList(editsRaw, "edits") : null;

  const pdf = await openPdf(data, form.get("password"));
  const pageCount = pdf.getPageCount();
  const regions = regionsIn.map((r) => ({ page: Number(r.page), x: Number(r.x), y: Number(r.y), width: Number(r.width), height: Number(r.height) }));
  for (const r of regions) {
    if (!(r.page >= 1 && r.page <= pageCount)) throw new HttpError(400, `Region page ${r.page} is outside the document (1-${pageCount})`);
    if (!(r.width > 0 && r.height > 0)) throw new HttpError(400, "Region width and height must be greater than 0");
  }

  // 0. the editor's boxes become ordinary page content
  if (edits) await applyEdits(pdf, data, edits, editsRaw, { permanent: true });

  // 1. encryption, forms, signatures
  const encryptionRemoved = !!pdf.getSecurity?.().isEncrypted;
  if (encryptionRemoved) pdf.removeProtection();
  const [fieldsFlattened, signaturesRemoved, fieldsDropped] = removeForm(pdf);
  const first = cleanAnnotations(pdf, new Set(), terms, cs);

  // 2. the other visible annotations become page content, where their text is searched
  let annotationsFlattened = 0;
  if (terms.length) {
    annotationsFlattened = visibleAnnotations(pdf);
    if (annotationsFlattened) {
      try {
        pdf.flattenAnnotations();
      } catch (err) {
        throw new HttpError(422, "Could not flatten the document's annotations into the page, which is needed to search their text. Nothing was redacted and no file was written.");
      }
      const left = visibleAnnotations(pdf);
      if (left) {
        throw new HttpError(422, `${left} annotation(s) could not be flattened into the page, so their text cannot be searched. Nothing was redacted and no file was written; flatten the file or remove those annotations first.`);
      }
      cleanAnnotations(pdf, new Set(), terms, cs);
    }
  }

  // 3. where the terms are
  const boxes = new Map(); // page index -> padded boxes (black boxes, annotations)
  const exact = new Map(); // page index -> the words themselves (what PDFium removes)
  const termCounts = Object.fromEntries(terms.map((t) => [t, 0]));
  let scannedPages = 0;
  const pictures = [];
  const add = (map, i, b) => (map.has(i) ? map : map.set(i, [])).get(i).push(b);
  {
    const raw = await RawPdf.open(await snapshot(pdf));
    try {
      for (let i = 0; i < raw.pageCount; i += 1) {
        const pageText = raw.pageChars(i);
        if (!pageText.chars.some((c) => !/\s/.test(c.ch))) scannedPages += 1;
        if (!terms.length) continue;
        for (const match of findTerms(pageText, terms, cs)) {
          termCounts[match.term] += 1;
          for (const b of boxesFor(pageText, match.start, match.end)) {
            add(exact, i, b);
            add(boxes, i, { x: b.x - 1.5, y: b.y - 1.5, width: b.width + 3, height: b.height + 3 });
          }
        }
      }
    } finally {
      raw.close();
    }
  }
  for (const r of regions) {
    add(boxes, r.page - 1, r);
    add(exact, r.page - 1, r);
  }

  const removed = [];
  if (fieldsFlattened) removed.push(`${fieldsFlattened} form field(s), flattened into the page`);
  if (signaturesRemoved) removed.push(`${signaturesRemoved} digital signature(s) (redaction invalidates them)`);
  if (fieldsDropped) removed.push(`${fieldsDropped} form field value(s) not shown on the page (hidden or without an appearance), removed`);
  if (first.removed) removed.push(`${first.removed} annotation(s) mentioning a term or holding an attachment, with their popups and replies`);
  removed.push(...cleanDocument(pdf, terms, cs, removeMetadata, boxes.size > 0));

  // 4. take what is marked out of the pages, keeping them as text where possible
  const pictureBecause = new Map();
  const asText = new Map();
  for (const index of boxes.keys()) {
    if (!keepText) pictureBecause.set(index, "asked for");
    else if (usesTilingPatterns(pdf, resolve(pdf, pdf.getPage(index).dict.get("Resources")))) pictureBecause.set(index, "patterns");
  }
  let annotationsErased = 0;
  for (const [index, list] of boxes) if (!pictureBecause.has(index)) annotationsErased += annotationsOverBoxes(pdf, pdf.getPage(index), list);
  if (annotationsErased) removed.push(`${annotationsErased} annotation(s) over the redacted areas`);
  const toErase = new Map([...exact].filter(([i]) => !pictureBecause.has(i)));
  let charactersRemoved = 0;
  try {
    const result = await erase(pdf, toErase, { takes: TAKES.redact });
    charactersRemoved = result.glyphs;
    for (const [index] of toErase) {
      if ((result.textLeft.get(index) || 0) > 0) pictureBecause.set(index, "text that could not be taken out");
      else asText.set(index, boxes.get(index));
    }
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) throw err;
    for (const [index] of toErase) pictureBecause.set(index, "content that could not be read");
  }
  for (const [index, list] of asText) {
    stripActualText(pdf, pdf.getPage(index));
    blackBoxes(pdf, pdf.getPage(index), list);
  }
  let droppedAnnots = 0;
  for (const index of pictureBecause.keys()) {
    const annots = resolve(pdf, pdf.getPage(index).dict.get("Annots"));
    if (annots instanceof PdfArray) droppedAnnots += annots.length;
  }
  if (droppedAnnots) removed.push(`${droppedAnnots} annotation(s) on pages rebuilt as pictures`);
  for (const [index] of pictureBecause) await rebuildAsPicture(pdf, index, boxes.get(index), dpi);

  if (boxes.size) {
    const orphans = cleanAnnotations(pdf, new Set(pictureBecause.keys()), [], cs);
    if (orphans.removed) removed.push(`${orphans.removed} reply or popup annotation(s) belonging to removed annotations`);
    pruneResources(pdf);
  }
  if (terms.length) {
    pdf.getPages().forEach((page, i) => {
      if (boxes.has(i)) return;
      const res = resolve(pdf, page.dict.get("Resources"));
      const xobjects = res instanceof PdfDict ? resolve(pdf, res.get("XObject")) : null;
      if (xobjects instanceof PdfDict && [...xobjects.keys()].some((k) => name(pdf, resolve(pdf, xobjects.get(k))?.get("Subtype")) === "Image")) pictures.push(i + 1);
    });
  }
  const out = await savePdf(pdf);
  const check = await verify(out, terms, cs);

  const pageReport = [...boxes.keys()].sort((a, b) => a - b).map((index) => (pictureBecause.has(index)
    ? { page: index + 1, boxes: boxes.get(index).length, method: "picture", pictureBecause: pictureBecause.get(index) }
    : { page: index + 1, boxes: boxes.get(index).length, method: "text" }));
  const report = {
    encryptionRemoved,
    redactedPages: pageReport,
    pagesKeptAsText: asText.size,
    charactersRemoved,
    termMatches: termCounts,
    ...(Object.values(termCounts).some((c) => !c) ? { termsNotFound: terms.filter((t) => !termCounts[t]) } : {}),
    regions: regions.length,
    alsoRemoved: removed,
    ...(pictures.length ? { otherPagesWithPictures: compact(pictures) } : {}),
    ...check,
    dpi,
  };
  if (terms.length && annotationsFlattened) {
    report.annotationsFlattened = annotationsFlattened;
    report.changes = [`${annotationsFlattened} visible annotation(s) (comments, stamps, highlights) on all pages were flattened into the page content so their text could be searched; they are no longer editable`];
  }
  if (scannedPages && terms.length) {
    report.scannedPages = scannedPages;
    report.scannedPagesSearched = false;
    report.warning = `${scannedPages} page(s) are images without text and text recognition is not available in the browser version: terms printed on them could not be found. Check those pages and redact them by region.`;
  }
  const found = Object.values(termCounts).reduce((a, b) => a + b, 0) + first.termHits;
  if (terms.length && !found && !regions.length) {
    throw new HttpError(422, "None of the terms were found in the document, so nothing was redacted and no file was written. Check the spelling; text inside pictures is only found on pages without any text layer.");
  }
  report.textRestored = false;
  if (pictureBecause.size) report.note = "Text recognition is not available in the browser version, so the redacted pages are images without searchable text";
  if (terms.length && !report.verified) {
    const where = report.rawObjectHits.length ? `; also in ${report.rawObjectHits.join(", ")}` : "";
    throw new HttpError(422, `Redaction check failed: a term can still be found (${report.remainingMatches} in page text${where}). Nothing was written.`);
  }
  return [out, report];
}

export async function redact(req) {
  const form = req.form;
  const id = form.get("document_id");
  if (id) {
    store.require(id);
    return store.locked(id, async () => {
      const entry = store.require(id);
      let result;
      try {
        result = await runRedaction(store.read(id), entry.filename, form);
      } catch (err) {
        throw pdfError(err);
      }
      const [out, report] = result;
      const [previous, revision] = store.update(id, out);
      return json({ ok: true, document_id: id, revision, previous_revision: previous, report });
    });
  }
  const { data, filename } = await loadDocument(form);
  let result;
  try {
    result = await runRedaction(data, filename, form);
  } catch (err) {
    throw pdfError(err);
  }
  const [out, report] = result;
  const head = new TextEncoder().encode(JSON.stringify(report));
  const prefix = new TextEncoder().encode(`PDFREDACT1 ${head.length}\n`);
  const body = new Uint8Array(prefix.length + head.length + out.length);
  body.set(prefix, 0);
  body.set(head, prefix.length);
  body.set(out, prefix.length + head.length);
  return { status: 200, headers: { "content-type": "application/x-pdf-redaction" }, body };
}

