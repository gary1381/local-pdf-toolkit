// Fonts for text the services write (as PdfboxServer.FontResources does):
// Helvetica / Times / Courier (standard 14, not embedded) when they can show the
// text, else the CJK font (WenQuanYi Micro Hei, Apache-2.0), embedded as a
// subset. The CJK font is fetched the first time it is needed.

import { HttpError } from "./http.js";

let cjkBytes = null;
let cjkOverride = null;

/** Tests outside a browser hand over the font file themselves. */
export function setCjkFont(bytes) {
  cjkOverride = bytes;
}

async function cjkFontBytes() {
  if (cjkOverride) return cjkOverride;
  if (!cjkBytes) {
    cjkBytes = fetch("/ui/fonts/cjk.ttf").then(async (resp) => {
      if (!resp.ok) throw new HttpError(422, "No CJK font available in this build, so the text cannot be written");
      return new Uint8Array(await resp.arrayBuffer());
    });
    cjkBytes.catch(() => (cjkBytes = null));
  }
  return cjkBytes;
}

const fontCache = new WeakMap();

/** The CJK font embedded in `pdf` (once per document). */
export async function cjkFont(pdf) {
  let font = fontCache.get(pdf);
  if (!font) {
    font = pdf.embedFont(await cjkFontBytes());
    fontCache.set(pdf, font);
  }
  return font;
}

// Windows-1252 (WinAnsiEncoding) beyond Latin-1: the characters Helvetica can show.
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

export function winAnsi(text) {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 10 || cp === 13 || cp === 9) continue;
    if ((cp >= 32 && cp <= 126) || (cp >= 160 && cp <= 255) || WIN_ANSI_EXTRA.has(ch)) continue;
    return false;
  }
  return true;
}

/** The standard font a CSS family names (the editor's choices), as PDFBox picks it. */
export function latinFontFor(family = "") {
  const f = String(family).toLowerCase();
  if (f.includes("times")) return "Times-Roman";
  if (f.includes("courier")) return "Courier";
  return "Helvetica";
}

export function wantsCjk(family = "") {
  const f = String(family).toLowerCase();
  return /[宋黑]|song|hei/.test(f);
}

/**
 * The font to write `text` with: {font, cjk} where `font` is a standard font
 * name or an embedded font. Characters even the CJK font lacks become "?".
 */
export async function fontFor(pdf, text, family = "") {
  if (!wantsCjk(family) && winAnsi(text)) return { font: latinFontFor(family), cjk: false, text };
  const font = await cjkFont(pdf);
  const missing = new Set(font.getUnencodableCharacters(text.replace(/[\r\n\t]/g, "")));
  const clean = missing.size ? [...text].map((ch) => (missing.has(ch) ? "?" : ch)).join("") : text;
  return { font, cjk: true, text: clean };
}
