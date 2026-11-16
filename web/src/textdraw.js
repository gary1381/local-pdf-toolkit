// Writing text into content streams: measure, encode and wrap it with a
// standard font (Helvetica, Times, Courier: not embedded, WinAnsiEncoding) or
// the embedded CJK font (Type0, Identity-H, subset at save).

import { Standard14Font } from "@libpdf/core";
import { fontFor } from "./fonts.js";
import { obj } from "./pdfobj.js";

const WIN_ANSI = new Map(Object.entries({
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a,
  "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97,
  "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
}));

function winAnsiBytes(text) {
  const out = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    out.push(WIN_ANSI.get(ch) ?? (cp <= 255 ? cp : 0x3f));
  }
  return out;
}

function literal(bytes) {
  let s = "(";
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += `\\${String.fromCharCode(b)}`;
    else if (b < 32 || b > 126) s += `\\${b.toString(8).padStart(3, "0")}`;
    else s += String.fromCharCode(b);
  }
  return `${s})`;
}

const standardFonts = new WeakMap();

/** A font usable in content streams: measure(text, size), show(text) -> operand, ref (resource), cjk. */
export class Face {
  static async for(pdf, text, family = "") {
    const chosen = await fontFor(pdf, text, family);
    return { face: chosen.cjk ? Face.embedded(pdf, chosen.font) : Face.standard(pdf, chosen.font), text: chosen.text };
  }

  static standard(pdf, baseFont) {
    let byName = standardFonts.get(pdf);
    if (!byName) standardFonts.set(pdf, (byName = new Map()));
    if (!byName.has(baseFont)) {
      byName.set(baseFont, pdf.register(obj({ Type: "/Font", Subtype: "/Type1", BaseFont: `/${baseFont}`, Encoding: "/WinAnsiEncoding" })));
    }
    const metrics = Standard14Font.of(baseFont);
    const face = new Face();
    face.cjk = false;
    face.ref = byName.get(baseFont);
    face.measure = (text, size) => metrics.widthOfTextAtSize(text, size);
    face.show = (text) => literal(winAnsiBytes(text));
    return face;
  }

  static embedded(pdf, font) {
    const face = new Face();
    face.cjk = true;
    face.ref = pdf.getFontRef(font);
    face.measure = (text, size) => font.widthOfTextAtSize(text, size);
    // Identity-H with CIDToGIDMap /Identity: the content stream holds glyph ids
    face.show = (text) => `<${font.encodeTextToGids(text).map((g) => g.toString(16).padStart(4, "0")).join("")}>`;
    return face;
  }
}

const BREAKS_ANYWHERE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;

/**
 * Lines as the editor shows them (CSS white-space: pre-wrap; word-break:
 * break-word): break at spaces, inside a word only when it is wider than the
 * line; Chinese and Japanese may break between any characters.
 */
export function wrap(face, size, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    let line = "";
    const pieces = paragraph.match(/ +|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]|[^ \p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]+/gu) || [];
    for (const piece of pieces) {
      if (face.measure(line + piece, size) <= maxWidth || (!line && !piece.trim())) {
        line += piece;
        continue;
      }
      if (!piece.trim()) {
        lines.push(line);
        line = "";
        continue;
      }
      if (line) {
        lines.push(line.replace(/\s+$/, ""));
        line = "";
      }
      for (const ch of piece) {
        if (line && face.measure(line + ch, size) > maxWidth) {
          lines.push(line);
          line = "";
        }
        line += ch;
      }
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines;
}

export { BREAKS_ANYWHERE };

/** "#rgb" / "#rrggbb" -> [r, g, b] (0..1); "transparent" -> null; anything else -> fallback. */
export function color(value, fallback) {
  if (typeof value !== "string") return fallback;
  let s = value.trim();
  if (s.toLowerCase() === "transparent") return null;
  if (/^#[0-9a-f]{3}$/i.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  if (/^#[0-9a-f]{6}$/i.test(s)) return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
  return fallback;
}
