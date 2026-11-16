// Highlights: add one (highlight: over a box, or a highlighter stroke drawn by
// hand) and remove those in an area (remove-highlight).

import { PdfDict } from "@libpdf/core";
import { HttpError } from "../http.js";
import { openPdf, saveEdit } from "../libs.js";
import { annotsOf, n, name, num, numbers, obj, resolve, stream } from "../pdfobj.js";
import { mutate } from "../session.js";
import { pageSpace } from "../space.js";

function regionOf(form) {
  return {
    index: form.int("page_index", 0),
    x: form.float("x", 72),
    y: form.float("y", 720),
    width: form.float("width", 120),
    height: form.float("height", 18),
  };
}

function pageOf(pdf, index) {
  const page = index >= 0 ? pdf.getPage(index) : null;
  if (!page) throw new HttpError(400, "Page number is outside the document");
  return page;
}

/** Strokes from the `points` field: [[[x, y], ...], ...] in displayed points. */
function strokesOf(form) {
  const raw = form.get("points");
  if (!raw) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch (_) {
    throw new HttpError(400, "points must be a JSON array of strokes, each an array of [x, y]");
  }
  if (!Array.isArray(value)) throw new HttpError(400, "points must be a JSON array of strokes, each an array of [x, y]");
  return value
    .filter((stroke) => Array.isArray(stroke) && stroke.length && stroke.length <= 5000)
    .map((stroke) => stroke.filter((pt) => Array.isArray(pt) && Number.isFinite(+pt[0]) && Number.isFinite(+pt[1])).map((pt) => [+pt[0], +pt[1]]))
    .filter((stroke) => stroke.length);
}

/**
 * A highlighter stroke drawn by hand: an Ink annotation in the highlight's
 * colour and transparency (multiplied, so the text under it stays readable),
 * round ends, its own appearance; marked so that Erase highlight takes it too.
 */
function inkHighlight(pdf, page, space, strokes, width) {
  const paths = strokes.map((stroke) => stroke.map(([x, y]) => space.toUser(x, y)));
  const all = paths.flat();
  const pad = width / 2 + 1;
  const x1 = Math.min(...all.map((p) => p[0])) - pad;
  const y1 = Math.min(...all.map((p) => p[1])) - pad;
  const x2 = Math.max(...all.map((p) => p[0])) + pad;
  const y2 = Math.max(...all.map((p) => p[1])) + pad;
  const ops = paths.map((path) => {
    const [first, ...rest] = path;
    // a single point: round ends make it a dot
    const line = rest.length ? rest : [[first[0] + 0.01, first[1]]];
    return `${n(first[0])} ${n(first[1])} m ${line.map((p) => `${n(p[0])} ${n(p[1])} l`).join(" ")} S`;
  });
  const appearance = stream(pdf, {
    Type: "/XObject", Subtype: "/Form",
    BBox: [x1, y1, x2, y2],
    Resources: { ExtGState: { GS0: { Type: "/ExtGState", CA: 0.35, ca: 0.35, BM: "/Multiply" } } },
  }, `/GS0 gs 1 0.92 0.23 RG ${n(width)} w 1 J 1 j\n${ops.join("\n")}\n`);
  return obj({
    Type: "/Annot", Subtype: "/Ink",
    Rect: [x1, y1, x2, y2],
    InkList: paths.map((path) => path.flat()),
    C: [1, 0.92, 0.23], CA: 0.35, F: 4,
    BS: { W: width },
    OpenPDFHighlighter: true,
    P: page.ref,
    AP: { N: appearance },
  });
}

export function highlight(req) {
  const region = regionOf(req.form);
  const strokes = strokesOf(req.form);
  return mutate(req.form, async (data) => {
    const pdf = await openPdf(data, req.form.get("password"));
    const page = pageOf(pdf, region.index);
    const space = pageSpace(page);
    if (strokes) {
      if (!strokes.length) throw new HttpError(400, "The stroke has no points");
      const width = Math.max(1, Math.min(60, req.form.float("stroke_width", 12)));
      annotsOf(pdf, page).push(pdf.register(inkHighlight(pdf, page, space, strokes, width)));
      return saveEdit(pdf, data);
    }
    // several boxes (the lines of a text selection) make one highlight
    let boxes = [[region.x, region.y, region.width, region.height]];
    const rectsRaw = req.form.get("rects");
    if (rectsRaw) {
      try {
        boxes = JSON.parse(rectsRaw);
      } catch (_) {
        throw new HttpError(400, "rects must be a JSON array of [x, y, width, height]");
      }
      if (!Array.isArray(boxes) || !boxes.length || boxes.length > 500 || boxes.some((b) => !Array.isArray(b) || b.length !== 4)) {
        throw new HttpError(400, "rects must be 1 to 500 boxes of [x, y, width, height]");
      }
    }
    // per box: upper-left, upper-right, lower-left, lower-right as seen on screen
    const quads = boxes.map(([x, y, w, h]) => [space.toUser(x, y), space.toUser(x + w, y), space.toUser(x, y + h), space.toUser(x + w, y + h)]);
    const xs = quads.flat().map((p) => p[0]);
    const ys = quads.flat().map((p) => p[1]);
    const rect = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    const fill = quads.map(([ul, ur, ll, lr]) => `${n(ul[0])} ${n(ul[1])} m ${n(ur[0])} ${n(ur[1])} l ${n(lr[0])} ${n(lr[1])} l ${n(ll[0])} ${n(ll[1])} l h`).join(" ");
    const appearance = stream(pdf, {
      Type: "/XObject", Subtype: "/Form",
      BBox: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
      Resources: { ExtGState: { GS0: { Type: "/ExtGState", CA: 0.35, ca: 0.35, BM: "/Multiply" } } },
    }, `/GS0 gs 1 0.92 0.23 rg ${fill} f\n`);
    const annot = obj({
      Type: "/Annot", Subtype: "/Highlight",
      Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
      QuadPoints: quads.flat().flat(),
      C: [1, 0.92, 0.23], CA: 0.35, F: 4,
      P: page.ref,
      AP: { N: appearance },
    });
    annotsOf(pdf, page).push(pdf.register(annot));
    return saveEdit(pdf, data);
  });
}

/** The box an annotation covers in user space: its /Rect and its QuadPoints together. */
function annotationBounds(pdf, dict) {
  const r = numbers(pdf, dict.get("Rect"));
  const xs = [r[0], r[2]];
  const ys = [r[1], r[3]];
  const q = numbers(pdf, dict.get("QuadPoints"));
  for (let i = 0; i + 1 < q.length; i += 2) {
    xs.push(q[i]);
    ys.push(q[i + 1]);
  }
  const ok = (v) => Number.isFinite(v);
  return [Math.min(...xs.filter(ok)), Math.min(...ys.filter(ok)), Math.max(...xs.filter(ok)), Math.max(...ys.filter(ok))];
}

export function removeHighlight(req) {
  const region = regionOf(req.form);
  return mutate(
    req.form,
    async (data) => {
      const pdf = await openPdf(data, req.form.get("password"));
      const page = pageOf(pdf, region.index);
      const t = pageSpace(page).userRect(region.x, region.y, region.width, region.height);
      const [tx1, ty1, tx2, ty2] = [t.x - 3, t.y - 3, t.x + t.width + 3, t.y + t.height + 3];
      const annots = annotsOf(pdf, page);
      let removed = 0;
      for (let i = annots.length - 1; i >= 0; i -= 1) {
        const dict = resolve(pdf, annots.at(i));
        if (!(dict instanceof PdfDict)) continue;
        if (resolve(pdf, dict.get("OpenPDFHighlighter"))?.value === true) {
          // a highlighter stroke: taken when the area touches the stroke itself
          const half = num(pdf, resolve(pdf, dict.get("BS"))?.get?.("W"), 0) / 2;
          const paths = resolve(pdf, dict.get("InkList"));
          let touches = false;
          for (let k = 0; paths && k < paths.length && !touches; k += 1) {
            const pts = numbers(pdf, paths.at(k));
            for (let j = 0; j + 1 < pts.length; j += 2) {
              if (pts[j] > tx1 - half && pts[j] < tx2 + half && pts[j + 1] > ty1 - half && pts[j + 1] < ty2 + half) {
                touches = true;
                break;
              }
            }
          }
          if (touches) {
            annots.remove(i);
            removed += 1;
          }
          continue;
        }
        if (name(pdf, dict.get("Subtype")) !== "Highlight") continue;
        const [x1, y1, x2, y2] = annotationBounds(pdf, dict);
        if (x1 < tx2 && x2 > tx1 && y1 < ty2 && y2 > ty1) {
          annots.remove(i);
          removed += 1;
        }
      }
      return [await saveEdit(pdf, data), { removed: true, removed_count: removed }];
    },
    { responseHeaders: (info) => ({ "X-Removed-Count": String(info.removed_count ?? 0) }) }
  );
}

