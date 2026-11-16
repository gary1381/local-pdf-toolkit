// The page space all the editor's services share (PdfboxServer.PageSpace):
// points, origin at the top-left of the page as displayed (CropBox, /Rotate
// applied), x right, y down. User space is the PDF's own coordinate system.

const TO_USER = {
  0: (cx, cy, cw, ch) => [1, 0, 0, 1, cx, cy],
  90: (cx, cy, cw, ch) => [0, 1, -1, 0, cx + cw, cy],
  180: (cx, cy, cw, ch) => [-1, 0, 0, -1, cx + cw, cy + ch],
  270: (cx, cy, cw, ch) => [0, -1, 1, 0, cx, cy + ch],
};

export function makeSpace(cx, cy, cw, ch, rotateDegrees) {
  const rotation = ((Math.round((rotateDegrees || 0) / 90) * 90) % 360 + 360) % 360;
  const [vw, vh] = rotation % 180 ? [ch, cw] : [cw, ch];
  const matrix = TO_USER[rotation](cx, cy, cw, ch);
  const [a, b, c, d, e, f] = matrix;

  /** Visual top-left point -> user space. */
  const toUser = (x, yTop) => {
    const up = vh - yTop;
    return [a * x + c * up + e, b * x + d * up + f];
  };

  /** User space point -> visual top-left. */
  const toView = (ux, uy) => {
    let vx;
    let up;
    if (rotation === 90) [vx, up] = [uy - cy, cx + cw - ux];
    else if (rotation === 180) [vx, up] = [cx + cw - ux, cy + ch - uy];
    else if (rotation === 270) [vx, up] = [cy + ch - uy, ux - cx];
    else [vx, up] = [ux - cx, uy - cy];
    return [vx, vh - up];
  };

  const bbox = (points) => {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  };

  return {
    vw,
    vh,
    rotation,
    matrix,
    toUser,
    toView,
    /** Visual rect -> user-space rect {x, y, width, height} (y = bottom). */
    userRect: (x, y, w, h) => bbox([toUser(x, y), toUser(x + w, y), toUser(x, y + h), toUser(x + w, y + h)]),
    /** User-space corners -> visual rect. */
    viewRect: (x1, y1, x2, y2) => bbox([toView(x1, y1), toView(x2, y1), toView(x1, y2), toView(x2, y2)]),
  };
}

/** The space of a LibPDF page (CropBox clipped to the MediaBox, as PDFBox and pdf.js do). */
export function pageSpace(page) {
  const media = page.getMediaBox();
  let crop = page.getCropBox();
  const x1 = Math.max(crop.x, media.x);
  const y1 = Math.max(crop.y, media.y);
  const x2 = Math.min(crop.x + crop.width, media.x + media.width);
  const y2 = Math.min(crop.y + crop.height, media.y + media.height);
  crop = x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : media;
  return makeSpace(crop.x, crop.y, crop.width, crop.height, page.rotation);
}
