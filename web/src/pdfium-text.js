// The text of PDF pages through PDFium's raw API: every character with its box
// on the page as displayed (points, top-left origin, rotation applied), the
// convention all the editor's services use. Used to find terms for redaction
// and to check afterwards that none is left.

import { HttpError } from "./http.js";
import { pdfium } from "./libs.js";
import { makeSpace } from "./space.js";

const SPACE = /[\s ­]/;

export class RawPdf {
  static async open(data, password = "") {
    const { module } = await pdfium();
    const raw = new RawPdf(module);
    raw.filePtr = raw.malloc(data.byteLength);
    module.pdfium.HEAPU8.set(data, raw.filePtr);
    raw.doc = module.FPDF_LoadMemDocument(raw.filePtr, data.byteLength, password || "");
    if (!raw.doc) {
      const code = module.FPDF_GetLastError();
      raw.free(raw.filePtr);
      throw new HttpError(code === 4 ? 400 : 422, code === 4 ? "The PDF is encrypted, or the password is wrong"
        : "The PDF could not be processed (it may be damaged or unsupported)");
    }
    return raw;
  }

  constructor(module) {
    this.m = module;
  }

  malloc(size) {
    return this.m.pdfium.wasmExports.malloc(size);
  }

  free(ptr) {
    this.m.pdfium.wasmExports.free(ptr);
  }

  get pageCount() {
    return this.m.FPDF_GetPageCount(this.doc);
  }

  /** The Java service's page space (contract 0.8): CropBox (else MediaBox) and /Rotate. */
  _space(page) {
    const m = this.m;
    const box = this.malloc(16);
    let cx, cy, cw, ch;
    try {
      const got = m.FPDFPage_GetCropBox(page, box, box + 4, box + 8, box + 12)
        || m.FPDFPage_GetMediaBox(page, box, box + 4, box + 8, box + 12);
      const [l, b, r, t] = [0, 4, 8, 12].map((o) => m.pdfium.getValue(box + o, "float"));
      [cx, cy, cw, ch] = got ? [Math.min(l, r), Math.min(b, t), Math.abs(r - l), Math.abs(t - b)]
        : [0, 0, m.FPDF_GetPageWidthF(page), m.FPDF_GetPageHeightF(page)];
    } finally {
      this.free(box);
    }
    return makeSpace(cx, cy, cw, ch, m.FPDFPage_GetRotation(page) * 90);
  }

  /**
   * The pictures drawn on page `index` (0-based), as ImageTools.extractImages
   * finds them: {box (displayed points, top-left), pixelWidth, pixelHeight,
   * jpeg (the original bytes of a plain JPEG) or rgba ({data, width, height},
   * the decoded pixels; a mask is not applied)}, and the displayed page size.
   * With `pixels` false only the boxes and sizes are read.
   */
  pictures(index, { minSize = 32, pixels = true } = {}) {
    const m = this.m;
    const page = m.FPDF_LoadPage(this.doc, index);
    if (!page) throw new HttpError(422, "The PDF could not be processed (it may be damaged or unsupported)");
    const space = this._space(page);
    const out = [];
    const f4 = this.malloc(32);
    const meta = this.malloc(28);
    const name = this.malloc(64);
    const mul = (a, b) => [
      a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
      a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
      a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
    ];
    const visit = (obj, outer) => {
      const type = m.FPDFPageObj_GetType(obj);
      if (type === 5) { // a form XObject: its objects, in its own space
        let inner = outer;
        if (m.FPDFPageObj_GetMatrix(obj, f4)) inner = mul([0, 4, 8, 12, 16, 20].map((o) => m.pdfium.getValue(f4 + o, "float")), outer);
        const n = m.FPDFFormObj_CountObjects(obj);
        for (let i = 0; i < n; i += 1) visit(m.FPDFFormObj_GetObject(obj, i), inner);
        return;
      }
      if (type !== 3) return; // 3: image
      if (!m.FPDFImageObj_GetImagePixelSize(obj, f4, f4 + 4)) return;
      const pw = m.pdfium.getValue(f4, "i32");
      const ph = m.pdfium.getValue(f4 + 4, "i32");
      if (pw < minSize || ph < minSize) return;
      if (!m.FPDFPageObj_GetBounds(obj, f4, f4 + 4, f4 + 8, f4 + 12)) return;
      const [l, b, r, t] = [0, 4, 8, 12].map((o) => m.pdfium.getValue(f4 + o, "float"));
      const corners = [[l, b], [r, b], [l, t], [r, t]].map(([x, y]) =>
        space.toView(outer[0] * x + outer[2] * y + outer[4], outer[1] * x + outer[3] * y + outer[5]));
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
      const pic = { box, pixelWidth: pw, pixelHeight: ph };
      if (pixels) {
        const filters = m.FPDFImageObj_GetImageFilterCount(obj);
        const last = filters ? (m.FPDFImageObj_GetImageFilter(obj, filters - 1, name, 64), m.pdfium.UTF8ToString(name)) : "";
        const space2 = m.FPDFImageObj_GetImageMetadata(obj, page, meta) ? m.pdfium.getValue(meta + 20, "i32") : 0;
        if (filters === 1 && last === "DCTDecode" && (space2 === 1 || space2 === 2)) { // gray or RGB
          const size = m.FPDFImageObj_GetImageDataRaw(obj, 0, 0);
          const buf = this.malloc(size);
          try {
            m.FPDFImageObj_GetImageDataRaw(obj, buf, size);
            pic.jpeg = m.pdfium.HEAPU8.slice(buf, buf + size);
          } finally {
            this.free(buf);
          }
        } else {
          pic.rgba = this._bitmap(m.FPDFImageObj_GetBitmap(obj));
          if (!pic.rgba) pic.error = true;
        }
      }
      out.push(pic);
    };
    try {
      const n = m.FPDFPage_CountObjects(page);
      for (let i = 0; i < n && out.length < 5000; i += 1) visit(m.FPDFPage_GetObject(page, i), [1, 0, 0, 1, 0, 0]);
      return { pictures: out, width: space.vw, height: space.vh };
    } finally {
      this.free(f4);
      this.free(meta);
      this.free(name);
      m.FPDF_ClosePage(page);
    }
  }

  /** A PDFium bitmap as RGBA pixels (and destroyed), or null. */
  _bitmap(bitmap) {
    const m = this.m;
    if (!bitmap) return null;
    try {
      const w = m.FPDFBitmap_GetWidth(bitmap);
      const h = m.FPDFBitmap_GetHeight(bitmap);
      const stride = m.FPDFBitmap_GetStride(bitmap);
      const format = m.FPDFBitmap_GetFormat(bitmap); // 1 gray, 2 BGR, 3 BGRx, 4 BGRA
      const src = m.pdfium.HEAPU8.subarray(m.FPDFBitmap_GetBuffer(bitmap), m.FPDFBitmap_GetBuffer(bitmap) + stride * h);
      const data = new Uint8ClampedArray(w * h * 4);
      const step = { 1: 1, 2: 3, 3: 4, 4: 4 }[format];
      if (!step || !w || !h) return null;
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const s = y * stride + x * step;
          const d = (y * w + x) * 4;
          if (format === 1) {
            data[d] = data[d + 1] = data[d + 2] = src[s];
          } else {
            data[d] = src[s + 2];
            data[d + 1] = src[s + 1];
            data[d + 2] = src[s];
          }
          data[d + 3] = format === 4 ? src[s + 3] : 255;
        }
      }
      return { data, width: w, height: h };
    } finally {
      m.FPDFBitmap_Destroy(bitmap);
    }
  }

  /** Characters of page `index` (0-based): [{ch, box: {x, y, width, height} | null}], and the displayed size. */
  pageChars(index) {
    const m = this.m;
    const page = m.FPDF_LoadPage(this.doc, index);
    if (!page) throw new HttpError(422, "The PDF could not be processed (it may be damaged or unsupported)");
    const text = m.FPDFText_LoadPage(page);
    const rect = this.malloc(16);
    try {
      const space = this._space(page);
      const { vw, vh, rotation, toView } = space;
      const count = m.FPDFText_CountChars(text);
      const chars = [];
      for (let i = 0; i < count; i += 1) {
        const ch = String.fromCodePoint(m.FPDFText_GetUnicode(text, i) || 0xfffd);
        let box = null;
        if (m.FPDFText_GetLooseCharBox(text, i, rect)) {
          const l = m.pdfium.getValue(rect, "float");
          const t = m.pdfium.getValue(rect + 4, "float");
          const r = m.pdfium.getValue(rect + 8, "float");
          const b = m.pdfium.getValue(rect + 12, "float");
          if (l !== r && t !== b) {
            const [x1, y1] = toView(l, t);
            const [x2, y2] = toView(r, b);
            box = { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
          }
        }
        chars.push({ ch, box, generated: !!m.FPDFText_IsGenerated(text, i) });
      }
      return { chars, width: vw, height: vh, rotation, toView };
    } finally {
      this.free(rect);
      m.FPDFText_ClosePage(text);
      m.FPDF_ClosePage(page);
    }
  }

  /**
   * The look of the page's text inside `origin` (visual rect), as the Java
   * service's TextStyle.probe finds it: the font with the most characters
   * there; from its top-most, then left-most character: size, colour, where it
   * starts (dx) and its baseline (dy) relative to the rect, and the kind of
   * font (serif, bold, italic, fixed pitch). Null when there is no text.
   */
  probeStyle(index, origin) {
    const m = this.m;
    const page = m.FPDF_LoadPage(this.doc, index);
    if (!page) return null;
    const { chars, toView } = this.pageChars(index);
    const text = m.FPDFText_LoadPage(page);
    const buf = this.malloc(512);
    const flags = this.malloc(4);
    const rgba = this.malloc(16);
    const xy = this.malloc(16);
    try {
      const groups = new Map();
      chars.forEach((c, i) => {
        if (!c.box || /\s/.test(c.ch) || c.generated) return;
        const mx = c.box.x + c.box.width / 2;
        const my = c.box.y + c.box.height / 2;
        if (mx < origin.x - 0.5 || mx > origin.x + origin.width + 0.5 || my < origin.y - 0.5 || my > origin.y + origin.height + 0.5) return;
        const len = m.FPDFText_GetFontInfo(text, i, buf, 512, flags);
        const font = len > 1 ? m.pdfium.UTF8ToString(buf) : "";
        if (!groups.has(font)) groups.set(font, { font, flags: m.pdfium.getValue(flags, "i32"), items: [] });
        groups.get(font).items.push(i);
      });
      if (!groups.size) return null;
      const best = [...groups.values()].sort((a, b) => b.items.length - a.items.length)[0];
      const first = best.items.slice().sort((a, b) => chars[a].box.y - chars[b].box.y || chars[a].box.x - chars[b].box.x)[0];
      const size = m.FPDFText_GetFontSize(text, first);
      let color = [0, 0, 0];
      if (m.FPDFText_GetFillColor(text, first, rgba, rgba + 4, rgba + 8, rgba + 12)) {
        color = [0, 4, 8].map((o) => m.pdfium.getValue(rgba + o, "i32") / 255);
      }
      let dx = chars[first].box.x - origin.x;
      let dy = NaN;
      if (m.FPDFText_GetCharOrigin(text, first, xy, xy + 8)) {
        const [vx, vy] = toView(m.pdfium.getValue(xy, "double"), m.pdfium.getValue(xy + 8, "double"));
        dx = vx - origin.x;
        dy = vy - origin.y;
      }
      const baseFont = best.font.replace(/^[A-Z]{6}\+/, "");
      const weight = m.FPDFText_GetFontWeight(text, first);
      const lower = baseFont.toLowerCase();
      return {
        size: Math.round(size * 100) / 100,
        color,
        dx,
        dy,
        baseFont,
        fixedPitch: !!(best.flags & 1) || /courier|mono|consol/.test(lower),
        serif: (!!(best.flags & 2) || /times|serif|georgia|garamond|minion|roman|song|mincho|ming/.test(lower)) && !/sans/.test(lower),
        bold: weight >= 600 || /bold|black|heavy|semibold|demi/.test(lower),
        italic: !!(best.flags & 64) || /italic|oblique/.test(lower),
        charSpacing: 0,
        scaling: 100,
      };
    } finally {
      this.free(buf);
      this.free(flags);
      this.free(rgba);
      this.free(xy);
      m.FPDFText_ClosePage(text);
      m.FPDF_ClosePage(page);
    }
  }

  close() {
    if (this.doc) this.m.FPDF_CloseDocument(this.doc);
    if (this.filePtr) this.free(this.filePtr);
    this.doc = 0;
    this.filePtr = 0;
  }
}

// ---------------------------------------------------------------- finding terms
// As the Java service does it (AgentTools.find with loose=true): whitespace runs
// count as one space; a second pass ignores all whitespace, for letter-spaced
// or wrapped words ("J o h n"), but only where the match starts and ends at a
// word boundary.

const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Two neighbouring characters belong to one word (scripts written without spaces never join). */
export function joins(a, b) {
  return LETTER_OR_DIGIT.test(a) && LETTER_OR_DIGIT.test(b) && !UNSPACED.test(a) && !UNSPACED.test(b);
}

function fold(chars, caseSensitive) {
  let out = "";
  const map = [];
  let lastSpace = false;
  chars.forEach((c, i) => {
    if (SPACE.test(c)) {
      if (!lastSpace && out) {
        out += " ";
        map.push(i);
      }
      lastSpace = true;
      return;
    }
    lastSpace = false;
    out += caseSensitive ? c : c.toLowerCase();
    map.push(i);
  });
  return { hay: out, map };
}

function squeeze(chars, caseSensitive) {
  let out = "";
  const map = [];
  chars.forEach((c, i) => {
    if (SPACE.test(c)) return;
    out += caseSensitive ? c : c.toLowerCase();
    map.push(i);
  });
  return { hay: out, map };
}

/** Where the terms occur on one page: [{term, text, start, end}] (character indexes, inclusive). */
export function findTerms(pageText, terms, caseSensitive) {
  const source = pageText.chars.map((c) => c.ch);
  const found = [];
  const starts = new Set();
  for (let pass = 0; pass < 2; pass += 1) {
    const { hay, map } = pass === 0 ? fold(source, caseSensitive) : squeeze(source, caseSensitive);
    terms.forEach((term, ti) => {
      const needle = pass === 0
        ? fold([...term], caseSensitive).hay.trim()
        : squeeze([...term], caseSensitive).hay;
      if (!needle) return;
      let from = 0;
      for (;;) {
        const at = hay.indexOf(needle, from);
        if (at < 0) break;
        const start = map[at];
        const end = map[at + needle.length - 1];
        if (pass === 1) {
          const boundary = (start === 0 || !joins(source[start - 1], source[start]))
            && (end + 1 >= source.length || !joins(source[end], source[end + 1]));
          if (!boundary) {
            from = at + 1;
            continue;
          }
        }
        const key = `${ti}:${start}`;
        if (!starts.has(key)) {
          starts.add(key);
          found.push({ term, text: source.slice(start, end + 1).join(""), start, end });
        }
        from = at + needle.length;
      }
    });
  }
  return found;
}

/**
 * One box per run of touching characters (a line, in whatever direction the
 * text runs on the displayed page), like the Java service's boxesFor.
 */
export function boxesFor(pageText, start, end) {
  const runs = [];
  let cur = null;
  for (let i = start; i <= end; i += 1) {
    const b = pageText.chars[i].box;
    if (!b || SPACE.test(pageText.chars[i].ch)) continue;
    const reach = Math.max(b.width, b.height) * 0.9;
    const gap = cur
      ? Math.max(0, b.x - cur.x2, cur.x - (b.x + b.width), b.y - cur.y2, cur.y - (b.y + b.height))
      : Infinity;
    if (gap > reach) {
      cur = { x: b.x, y: b.y, x2: b.x + b.width, y2: b.y + b.height };
      runs.push(cur);
    } else {
      cur.x = Math.min(cur.x, b.x);
      cur.y = Math.min(cur.y, b.y);
      cur.x2 = Math.max(cur.x2, b.x + b.width);
      cur.y2 = Math.max(cur.y2, b.y + b.height);
    }
  }
  return runs.map((r) => ({ x: r.x, y: r.y, width: r.x2 - r.x, height: r.y2 - r.y }));
}
