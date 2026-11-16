// The editor's text boxes ("Add text", "Edit text") and comments
// (read-placements, embed-placements), as PdfboxServer + EditsLayer do it:
//
// - the boxes as the editor sent them are kept in the Info dictionary under
//   PdfGatewayPlacements, so they can be edited again;
// - they are drawn into the pages, one form XObject per page in the optional
//   content group "OpenPDF edits", tagged /OpenPDFEdits (marked content and
//   dictionaries), so the next save takes the old drawing out first and the
//   editor (which draws the boxes itself) can hide it;
// - an "Edit text" box first removes the page text it replaces.

import { PdfArray, PdfDict, PdfRef, PdfStream, PdfString } from "@libpdf/core";
import { erase } from "../content.js";
import { winAnsi } from "../fonts.js";
import { HttpError, json } from "../http.js";
import { openPdf, pdfError, saveEdit, snapshot } from "../libs.js";
import { RawPdf } from "../pdfium-text.js";
import { annotsOf, n, name, numbers, obj, resolve, str } from "../pdfobj.js";
import { loadDocument, mutate } from "../session.js";
import { pageSpace } from "../space.js";
import { color, Face, wrap } from "../textdraw.js";

const KEY = "PdfGatewayPlacements";
const MARK = "OpenPDFEdits";
const LAYER_NAME = "OpenPDF edits";
const ITEM = "OpenPDFItem";
const STYLE = "OpenPDFStyle";

// ---------------------------------------------------------------- the Info dictionary

function infoDict(pdf, create) {
  const trailer = pdf.ctx.info.trailer;
  const ref = trailer.getRef?.("Info");
  const existing = ref ? pdf.getObject(ref) : resolve(pdf, trailer.get("Info"));
  if (existing instanceof PdfDict) return existing;
  if (!create) return null;
  const dict = new PdfDict();
  trailer.set("Info", pdf.register(dict));
  return dict;
}

export async function readPlacements(req) {
  const { data } = await loadDocument(req.form);
  const pdf = await openPdf(data, req.form.get("password"));
  const raw = str(pdf, infoDict(pdf, false)?.get(KEY));
  if (!raw || !raw.trim()) return json({ placements: [] });
  let items;
  try {
    items = JSON.parse(raw);
  } catch (_) {
    items = null;
  }
  if (!Array.isArray(items) || items.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new HttpError(422, "Reading text boxes failed: the PDF could not be processed (it may be damaged or unsupported)");
  }
  return json({ placements: items });
}

// ---------------------------------------------------------------- the earlier drawing

const isMarked = (pdf, dict) => dict instanceof PdfDict && resolve(pdf, dict.get(MARK))?.value === true;

function contentItems(pdf, page) {
  const raw = page.dict.get("Contents");
  const contents = resolve(pdf, raw);
  if (contents instanceof PdfArray) return Array.from({ length: contents.length }, (_, i) => contents.at(i));
  return raw ? [raw] : [];
}

/** The page's own resources dictionary (made direct and unshared if inherited or shared). */
function ownResources(pdf, page) {
  let res = resolve(pdf, page.dict.get("Resources"));
  if (!(res instanceof PdfDict)) {
    let node = resolve(pdf, page.dict.get("Parent"));
    while (node && !(res instanceof PdfDict)) {
      res = resolve(pdf, node.get("Resources"));
      node = resolve(pdf, node.get("Parent"));
    }
  }
  const copy = new PdfDict();
  if (res instanceof PdfDict) for (const key of res.keys()) copy.set(key, res.get(key));
  page.dict.set("Resources", copy);
  return copy;
}

function ownSubDict(pdf, res, key) {
  const existing = resolve(pdf, res.get(key));
  const copy = new PdfDict();
  if (existing instanceof PdfDict) for (const k of existing.keys()) copy.set(k, existing.get(k));
  res.set(key, copy);
  return copy;
}

/** Styles kept with the boxes of an earlier drawing, by box id. */
function keptStyles(pdf) {
  const styles = new Map();
  for (const page of pdf.getPages()) {
    const res = resolve(pdf, page.dict.get("Resources"));
    const xobjects = res instanceof PdfDict ? resolve(pdf, res.get("XObject")) : null;
    const drawing = xobjects instanceof PdfDict ? resolve(pdf, xobjects.get(MARK)) : null;
    const inner = drawing instanceof PdfStream ? resolve(pdf, drawing.get("Resources")) : null;
    const boxes = inner instanceof PdfDict ? resolve(pdf, inner.get("XObject")) : null;
    if (!(boxes instanceof PdfDict)) continue;
    for (const key of boxes.keys()) {
      const box = resolve(pdf, boxes.get(key));
      const id = box instanceof PdfStream ? str(pdf, box.get(ITEM)) : null;
      const st = box instanceof PdfStream ? resolve(pdf, box.get(STYLE)) : null;
      if (id && st instanceof PdfDict) styles.set(id, styleFromDict(pdf, st));
    }
  }
  return styles;
}

function removeDrawing(pdf, page) {
  const raw = resolve(pdf, page.dict.get("Contents"));
  if (raw instanceof PdfArray) {
    const keep = contentItems(pdf, page).filter((item) => !isMarked(pdf, resolve(pdf, item)));
    if (keep.length !== raw.length) page.dict.set("Contents", keep.length === 1 ? keep[0] : new PdfArray(keep));
  }
  const res = resolve(pdf, page.dict.get("Resources"));
  const xobjects = res instanceof PdfDict ? resolve(pdf, res.get("XObject")) : null;
  if (xobjects instanceof PdfDict && xobjects.has(MARK)) ownSubDict(pdf, ownResources(pdf, page), "XObject").delete(MARK);
}

// ---------------------------------------------------------------- the layer

function ocProperties(pdf, create) {
  const catalog = pdf.getCatalog();
  let props = resolve(pdf, catalog.get("OCProperties"));
  if (!(props instanceof PdfDict)) {
    if (!create) return null;
    props = obj({ OCGs: [], D: { ON: [], Order: [] } });
    catalog.set("OCProperties", props);
  }
  return props;
}

function listOf(pdf, dict, key) {
  let list = resolve(pdf, dict.get(key));
  if (!(list instanceof PdfArray)) {
    list = new PdfArray([]);
    dict.set(key, list);
  }
  return list;
}

/** The layer, created (visible) if the file has none yet. */
function layer(pdf) {
  const props = ocProperties(pdf, true);
  const groups = listOf(pdf, props, "OCGs");
  let config = resolve(pdf, props.get("D"));
  if (!(config instanceof PdfDict)) props.set("D", (config = obj({ ON: [], Order: [] })));
  for (let i = 0; i < groups.length; i += 1) {
    const ref = groups.at(i);
    if (isMarked(pdf, resolve(pdf, ref))) {
      enable(pdf, config, ref);
      return ref;
    }
  }
  const ref = pdf.register(obj({ Type: "/OCG", Name: LAYER_NAME, [MARK]: true }));
  groups.push(ref);
  listOf(pdf, config, "Order").push(ref);
  enable(pdf, config, ref);
  return ref;
}

function sameRef(a, b) {
  return a instanceof PdfRef && b instanceof PdfRef && a.objectNumber === b.objectNumber && a.generation === b.generation;
}

function enable(pdf, config, ref) {
  const on = listOf(pdf, config, "ON");
  if (!Array.from({ length: on.length }, (_, i) => on.at(i)).some((r) => sameRef(r, ref))) on.push(ref);
  const off = resolve(pdf, config.get("OFF"));
  if (off instanceof PdfArray) for (let i = off.length - 1; i >= 0; i -= 1) if (sameRef(off.at(i), ref)) off.remove(i);
}

function dropOurs(pdf, list) {
  const array = resolve(pdf, list);
  if (!(array instanceof PdfArray)) return;
  for (let i = array.length - 1; i >= 0; i -= 1) {
    const item = resolve(pdf, array.at(i));
    if (isMarked(pdf, item)) array.remove(i);
    else if (item instanceof PdfArray) dropOurs(pdf, item);
  }
}

function removeLayer(pdf) {
  const props = ocProperties(pdf, false);
  if (!props) return;
  dropOurs(pdf, props.get("OCGs"));
  const config = resolve(pdf, props.get("D"));
  if (config instanceof PdfDict) for (const key of ["ON", "OFF", "Order", "RBGroups", "Locked"]) dropOurs(pdf, config.get(key));
}

// ---------------------------------------------------------------- styles (Edit text in the look of the page)

function styleToDict(style) {
  return obj({
    Size: style.size, Color: style.color, Tc: style.charSpacing || 0, Tz: style.scaling || 100,
    DX: Number.isFinite(style.dx) ? style.dx : undefined, DY: Number.isFinite(style.dy) ? style.dy : undefined,
    BaseFont: style.baseFont ? `/${style.baseFont.replace(/[^A-Za-z0-9+_.-]/g, "")}` : undefined,
    Serif: !!style.serif, Bold: !!style.bold, Italic: !!style.italic, FixedPitch: !!style.fixedPitch,
  });
}

function styleFromDict(pdf, d) {
  const num = (k, fallback) => {
    const v = resolve(pdf, d.get(k));
    return v && typeof v.value === "number" ? v.value : fallback;
  };
  const bool = (k) => resolve(pdf, d.get(k))?.value === true;
  return {
    size: num("Size", 12), color: numbers(pdf, d.get("Color")).slice(0, 3).map((v) => (Number.isFinite(v) ? v : 0)),
    charSpacing: num("Tc", 0), scaling: num("Tz", 100), dx: num("DX", NaN), dy: num("DY", NaN),
    baseFont: name(pdf, d.get("BaseFont")) || "", serif: bool("Serif"), bold: bool("Bold"), italic: bool("Italic"),
    fixedPitch: bool("FixedPitch"),
  };
}

function plainStyle(size) {
  return { size, color: [0, 0, 0], charSpacing: 0, scaling: 100, dx: NaN, dy: NaN, serif: false, bold: false, italic: false, fixedPitch: false };
}

function similarStandardFont(style) {
  const { bold, italic } = style;
  if (style.fixedPitch) return bold && italic ? "Courier-BoldOblique" : bold ? "Courier-Bold" : italic ? "Courier-Oblique" : "Courier";
  if (style.serif) return bold && italic ? "Times-BoldItalic" : bold ? "Times-Bold" : italic ? "Times-Italic" : "Times-Roman";
  return bold && italic ? "Helvetica-BoldOblique" : bold ? "Helvetica-Bold" : italic ? "Helvetica-Oblique" : "Helvetica";
}

const BREAK_ANYWHERE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;

/** Words and CJK characters of a paragraph, each knowing if a space came before it. */
function pieces(paragraph) {
  const out = [];
  let word = "";
  let space = false;
  for (const ch of paragraph) {
    if (/\s/.test(ch)) {
      if (word) out.push({ text: word, spaceBefore: space });
      word = "";
      space = true;
      continue;
    }
    if (BREAK_ANYWHERE.test(ch)) {
      if (word) {
        out.push({ text: word, spaceBefore: space });
        word = "";
        space = false;
      }
      out.push({ text: ch, spaceBefore: space });
      space = false;
      continue;
    }
    word += ch;
  }
  if (word) out.push({ text: word, spaceBefore: space });
  return out;
}

/** TextStyle.layout: lines of pieces with their start and baseline (displayed coordinates, y up). */
function layout(face, size, text, left, firstBaseline, maxWidth, lineHeight, align, firstIndent) {
  const lines = [];
  let baseline = firstBaseline;
  const width = (s) => face.measure(s, size);
  const space = width(" ");
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    const all = pieces(paragraph);
    if (!all.length) {
      baseline -= lineHeight;
      continue;
    }
    let start = 0;
    while (start < all.length) {
      const indent = lines.length ? 0 : firstIndent;
      const room = maxWidth - indent;
      let w = width(all[start].text);
      let end = start + 1;
      while (end < all.length) {
        const add = (all[end].spaceBefore ? space : 0) + width(all[end].text);
        if (w + add > room + 0.01) break; // the editor measures the same widths: rounding is not overflow
        w += add;
        end += 1;
      }
      const words = all.slice(start, end);
      const gaps = words.slice(1).filter((p) => p.spaceBefore).length;
      const bounded = Number.isFinite(maxWidth);
      let extra = 0;
      let x = left + indent;
      if (bounded && align === "justify" && end < all.length && gaps > 0) extra = (room - w) / gaps;
      else if (bounded && align === "center") x = left + indent + (room - w) / 2;
      else if (bounded && align === "right") x = left + indent + room - w;
      lines.push({ x, baseline, words, extra });
      baseline -= lineHeight;
      start = end;
    }
  }
  return lines;
}

/** The text of an Edit text box in the look of the text it replaces, as its own small form. */
async function styledForm(pdf, item, style, text, vh) {
  const itemSize = num(item.fontSize, style.size);
  const size = style.size > 0 && Math.abs(itemSize - style.size) < 0.6 ? style.size : itemSize;
  // a standard font of the same kind when it has the characters, else the CJK font
  let chosen;
  let shown = text;
  if (winAnsi(text)) chosen = Face.standard(pdf, similarStandardFont(style));
  else ({ face: chosen, text: shown } = await Face.for(pdf, text, "宋体"));
  const x = num(item.x, 0);
  const y = num(item.y, 0);
  let left = Number.isFinite(style.dx) ? x + style.dx : x + 3;
  const baselineTop = Number.isFinite(style.dy) ? y + style.dy : y + 1 + size * 0.947;
  let maxWidth = Infinity;
  let lineHeight = size * 1.2;
  let align = "left";
  let indent = 0;
  const para = item.paragraph && typeof item.paragraph === "object" ? item.paragraph : null;
  if (para) {
    indent = Math.max(0, num(para.indent, 0));
    maxWidth = Math.max(size, num(para.width, num(item.width, 0) - 6));
    lineHeight = num(para.lineHeight, lineHeight);
    align = typeof para.align === "string" ? para.align : "left";
    if (!Number.isFinite(style.dx) && para.left != null) left = x + num(para.left, 3);
  }
  if (indent > 0 && Number.isFinite(style.dx)) left -= indent;
  const lines = layout(chosen, size, shown, left, vh - baselineTop, maxWidth, lineHeight, align, indent);
  const gap = (w) => n(-(w * 1000) / size);
  let content = `BT\n/F0 ${n(size)} Tf\n${style.color.map(n).join(" ")} rg\n`;
  if (style.charSpacing) content += `${n(style.charSpacing)} Tc\n`;
  if (Math.abs((style.scaling || 100) - 100) > 0.5) content += `${n(style.scaling)} Tz\n`;
  for (const line of lines) {
    content += `1 0 0 1 ${n(line.x)} ${n(line.baseline)} Tm\n[`;
    line.words.forEach((p, i) => {
      if (i > 0 && p.spaceBefore) content += chosen.show(" ") + (line.extra > 0 ? ` ${gap(line.extra)} ` : "");
      content += chosen.show(p.text);
    });
    content += "] TJ\n";
  }
  content += "ET\n";
  const form = new PdfStream(obj({
    Type: "/XObject", Subtype: "/Form", BBox: [-20000, -20000, 40000, 40000],
    Resources: { Font: { F0: chosen.ref } },
    [ITEM]: String(item.id ?? ""), [STYLE]: styleToDict(style),
  }), new TextEncoder().encode(content));
  return pdf.register(form);
}

// ---------------------------------------------------------------- drawing

function num(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** What an Edit text box removes: the text it replaces when it knows it (origin), else the box. */
function eraseArea(item) {
  const o = item.origin;
  if (o && typeof o === "object" && num(o.width, 0) > 0 && num(o.height, 0) > 0) {
    return { x: num(o.x, 0), y: num(o.y, 0), width: num(o.width, 0), height: num(o.height, 0) };
  }
  return { x: num(item.x, 0), y: num(item.y, 0), width: num(item.width, 0), height: num(item.height, 0) };
}

class Drawing {
  constructor(pdf) {
    this.pdf = pdf;
    this.fonts = new Map();
    this.forms = [];
    this.ops = [];
  }

  font(face) {
    const key = `${face.ref.objectNumber} ${face.ref.generation}`;
    if (!this.fonts.has(key)) this.fonts.set(key, { name: `F${this.fonts.size + 1}`, ref: face.ref });
    return this.fonts.get(key).name;
  }

  form(ref) {
    const name = `T${this.forms.length + 1}`;
    this.forms.push({ name, ref });
    return name;
  }
}

const rgb = (c) => `${c.map(n).join(" ")} rg`;
const RGB = (c) => `${c.map(n).join(" ")} RG`;

async function drawBox(d, item, vh, styles) {
  const x = num(item.x, 0);
  const y = num(item.y, 0);
  const w = num(item.width, 0);
  const h = num(item.height, 0);
  const size = Math.max(1, num(item.fontSize, 12));
  const cover = item.kind === "cover";
  const colors = item.colors && typeof item.colors === "object" ? item.colors : {};
  const background = color(colors.idleBackground, cover ? [1, 1, 1] : null);
  const ink = color(colors.idleColor, [0x11 / 255, 0x18 / 255, 0x27 / 255]);
  const out = d.ops;
  out.push("q");
  if (background) {
    const a = cover ? eraseArea(item) : { x, y, width: w, height: h };
    out.push(`${rgb(background)} ${n(a.x)} ${n(vh - a.y - a.height)} ${n(a.width)} ${n(a.height)} re f`);
  }
  out.push(`${n(x)} ${n(vh - y - h)} ${n(w)} ${n(h)} re W n`);
  const raw = typeof item.text === "string" ? item.text : "";
  let style = item.matchStyle === true && cover ? styles.get(String(item.id ?? "")) : null;
  if (!style && item.paragraph && typeof item.paragraph === "object") style = plainStyle(size);
  if (style && typeof colors.idleColor !== "string") {
    const paragraph = !!(item.paragraph && typeof item.paragraph === "object");
    const ref = await styledForm(d.pdf, item, style, paragraph ? raw : raw.replace(/\r\n|\r|\n/g, " "), vh);
    out.push(`/${d.form(ref)} Do`, "Q");
    return;
  }
  const { face, text } = await Face.for(d.pdf, raw.replace(/\r\n|\r|\n/g, " "), typeof item.fontFamily === "string" ? item.fontFamily : "");
  if (ink) {
    const baseline = vh - (y + 1 + size * (face.cjk ? 1.0 : 0.947));
    out.push(`${rgb(ink)} BT /${d.font(face)} ${n(size)} Tf ${n(x + 3)} ${n(baseline)} Td ${face.show(text)} Tj ET`);
  }
  out.push("Q");
}

function roundedRect(x, y, w, h, r) {
  const k = 0.5523 * r;
  return [
    `${n(x + r)} ${n(y)} m`, `${n(x + w - r)} ${n(y)} l`,
    `${n(x + w - r + k)} ${n(y)} ${n(x + w)} ${n(y + r - k)} ${n(x + w)} ${n(y + r)} c`,
    `${n(x + w)} ${n(y + h - r)} l`,
    `${n(x + w)} ${n(y + h - r + k)} ${n(x + w - r + k)} ${n(y + h)} ${n(x + w - r)} ${n(y + h)} c`,
    `${n(x + r)} ${n(y + h)} l`,
    `${n(x + r - k)} ${n(y + h)} ${n(x)} ${n(y + h - r + k)} ${n(x)} ${n(y + h - r)} c`,
    `${n(x)} ${n(y + r)} l`,
    `${n(x)} ${n(y + r - k)} ${n(x + r - k)} ${n(y)} ${n(x + r)} ${n(y)} c h`,
  ].join(" ");
}

/** A comment: a rounded box with wrapped text and an arrow to where it points. */
async function drawCallout(d, item, vh) {
  const x = num(item.x, 0);
  const y = num(item.y, 0);
  const w = num(item.width, 0);
  const h = num(item.height, 0);
  const ax = num(item.anchorX, x);
  const ay = num(item.anchorY, y);
  const size = Math.max(1, num(item.fontSize, 12));
  const colors = item.colors && typeof item.colors === "object" ? item.colors : {};
  const background = color(colors.idleBackground, [1, 1, 1]);
  const ink = color(colors.idleColor, [0x1e / 255, 0x29 / 255, 0x3b / 255]);
  const line = [0x33 / 255, 0x41 / 255, 0x55 / 255];
  const out = d.ops;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const dx = ax - cx;
  const dy = ay - cy;
  if (!(Math.abs(dx) <= w / 2 && Math.abs(dy) <= h / 2)) {
    const s = Math.min(dx ? w / 2 / Math.abs(dx) : Infinity, dy ? h / 2 / Math.abs(dy) : Infinity);
    const ex = cx + dx * s;
    const ey = cy + dy * s;
    const angle = Math.atan2(ay - ey, ax - ex);
    const endX = ax - Math.cos(angle) * 8;
    const endY = ay - Math.sin(angle) * 8;
    const a1 = angle + Math.PI * 0.82;
    const a2 = angle - Math.PI * 0.82;
    out.push(`q ${RGB(line)} ${rgb(line)} 1.5 w 1 J ${n(ex)} ${n(vh - ey)} m ${n(endX)} ${n(vh - endY)} l S`);
    out.push(`${n(ax)} ${n(vh - ay)} m ${n(ax + Math.cos(a1) * 7)} ${n(vh - (ay + Math.sin(a1) * 7))} l ${n(ax + Math.cos(a2) * 7)} ${n(vh - (ay + Math.sin(a2) * 7))} l h f Q`);
  }
  const bottom = vh - y - h;
  const r = Math.min(12, Math.min(w, h) / 2);
  out.push("q", roundedRect(x, bottom, w, h, r));
  if (background) out.push(rgb(background));
  out.push(`${RGB([0xcb / 255, 0xd5 / 255, 0xe1 / 255])} 0.75 w ${background ? "B" : "S"}`);
  out.push(`${roundedRect(x, bottom, w, h, r)} W n`);
  const raw = typeof item.text === "string" ? item.text : "";
  const { face, text } = await Face.for(d.pdf, raw, typeof item.fontFamily === "string" ? item.fontFamily : "");
  if (ink) {
    const lines = wrap(face, size, text, Math.max(8, w - 24));
    let top = y + 8 + size * 1.02;
    out.push(rgb(ink));
    for (const l of lines) {
      if (top - size > y + h) break;
      if (l) out.push(`BT /${d.font(face)} ${n(size)} Tf ${n(x + 12)} ${n(vh - top)} Td ${face.show(l)} Tj ET`);
      top += size * 1.35;
    }
  }
  out.push("Q");
}

/** Draw a page's items into a new form and show it after the page content. */
async function drawPage(pdf, page, items, layerRef, tag, styles) {
  const space = pageSpace(page);
  const d = new Drawing(pdf);
  for (const item of items) {
    if (item.kind === "callout") await drawCallout(d, item, space.vh);
    else await drawBox(d, item, space.vh, styles);
  }
  const content = `/${MARK} BMC\n${space.matrix.map(n).join(" ")} cm\n${d.ops.join("\n")}\nEMC\n`;
  const fonts = {};
  for (const { name: fname, ref } of d.fonts.values()) fonts[fname] = ref;
  const xobjects = {};
  for (const { name: fname, ref } of d.forms) xobjects[fname] = ref;
  const media = page.getMediaBox();
  const form = obj({
    Type: "/XObject", Subtype: "/Form",
    BBox: [media.x, media.y, media.x + media.width, media.y + media.height],
    Resources: { Font: fonts, XObject: xobjects },
    OC: layerRef ?? undefined,
    [MARK]: tag ? true : undefined,
  });
  const formRef = pdf.register(new PdfStream(form, new TextEncoder().encode(content)));
  const pageXObjects = ownSubDict(pdf, ownResources(pdf, page), "XObject");
  let formName = MARK;
  if (!tag) {
    let k = 1;
    while (pageXObjects.has(`OpenPDFText${k}`)) k += 1;
    formName = `OpenPDFText${k}`;
  }
  pageXObjects.set(formName, formRef);
  const wrapper = (text) => pdf.register(new PdfStream(obj(tag ? { [MARK]: true } : {}), new TextEncoder().encode(text)));
  page.dict.set("Contents", new PdfArray([wrapper("q\n"), ...contentItems(pdf, page), wrapper(`Q\nq /${formName} Do Q\n`)]));
}

/** Annotations whose /Rect centre lies in a cover area go (not widgets, links or popups), with their popups. */
function eraseAnnotations(pdf, page, rects) {
  const annots = annotsOf(pdf, page);
  const space = pageSpace(page);
  let removed = 0;
  for (let i = annots.length - 1; i >= 0; i -= 1) {
    const a = resolve(pdf, annots.at(i));
    if (!(a instanceof PdfDict) || ["Widget", "Link", "Popup"].includes(name(pdf, a.get("Subtype")))) continue;
    const [x1, y1, x2, y2] = numbers(pdf, a.get("Rect"));
    const [mx, my] = space.toView((x1 + x2) / 2, (y1 + y2) / 2);
    if (rects.some((r) => mx >= r.x && mx <= r.x + r.width && my >= r.y && my <= r.y + r.height)) {
      annots.remove(i);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Draw the items into their pages (replacing an earlier drawing), erasing what
 * Edit text boxes cover. With `permanent` (before redaction) they become
 * ordinary page content: no layer, no tags, no metadata copy.
 */
export async function applyEdits(pdf, original, items, raw, { permanent = false } = {}) {
  const pageCount = pdf.getPageCount();
  const styles = keptStyles(pdf);
  pdf.getPages().forEach((page) => removeDrawing(pdf, page));
  const byPage = new Map();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const page = num(item.pageIndex, -1);
    if (!Number.isInteger(page) || page < 0 || page >= pageCount || typeof item.text !== "string" || !item.text.trim()
      || !(num(item.width, 0) > 0) || !(num(item.height, 0) > 0)) continue;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push(item);
  }

  // Edit text on the page's own text: note its look before it is erased
  const toProbe = [...byPage.entries()].flatMap(([page, list]) => list
    .filter((it) => it.kind === "cover" && it.matchStyle === true && !styles.has(String(it.id ?? "")) && it.origin && typeof it.origin === "object")
    .map((it) => [page, it]));
  if (toProbe.length) {
    const rawPdf = await RawPdf.open(await snapshot(pdf));
    try {
      for (const [page, it] of toProbe) {
        const o = it.origin;
        const style = rawPdf.probeStyle(page, { x: num(o.x, 0), y: num(o.y, 0), width: num(o.width, 0), height: num(o.height, 0) });
        if (style) styles.set(String(it.id ?? ""), style);
      }
    } finally {
      rawPdf.close();
    }
  }

  const coverRects = new Map();
  let annotationsErased = 0;
  for (const [index, list] of byPage) {
    const rects = list.filter((it) => it.kind === "cover").map(eraseArea);
    if (rects.length) {
      coverRects.set(index, rects);
      annotationsErased += eraseAnnotations(pdf, pdf.getPage(index), rects);
    }
  }
  const erased = await erase(pdf, coverRects);
  let textLeft = 0;
  for (const v of erased.textLeft.values()) textLeft += v;

  if (!byPage.size || permanent) removeLayer(pdf);
  let drawn = 0;
  if (byPage.size) {
    const layerRef = permanent ? null : layer(pdf);
    for (const [index, list] of byPage) {
      await drawPage(pdf, pdf.getPage(index), list, layerRef, !permanent, styles);
      drawn += list.length;
    }
  }
  const info = infoDict(pdf, !permanent);
  if (permanent) info?.delete(KEY);
  else info.set(KEY, PdfString.fromString(raw));
  return {
    drawn,
    covers: [...coverRects.values()].reduce((a, r) => a + r.length, 0),
    glyphsErased: erased.glyphs,
    imagesErased: 0,
    annotationsErased,
    textLeft,
    notErased: [],
  };
}

export function embedPlacements(req) {
  const raw = req.form.get("placements", null);
  let items;
  try {
    items = JSON.parse(raw ?? "");
  } catch (_) {
    items = null;
  }
  if (raw === null) throw new HttpError(422, "Invalid request parameters: placements");
  if (!Array.isArray(items)) throw new HttpError(400, "Invalid text box data: placements must be a JSON array");
  const permanent = req.form.bool("flatten");
  return mutate(req.form, async (data) => {
    const pdf = await openPdf(data, req.form.get("password"));
    let report;
    try {
      report = await applyEdits(pdf, data, items, raw, { permanent });
    } catch (err) {
      throw pdfError(err);
    }
    return [await saveEdit(pdf, data), { edits: report }];
  });
}

