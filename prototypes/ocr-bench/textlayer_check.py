"""Does the OCR text layer sit on the text in the image?

For each character in the output PDF's text layer, check that its centre lies
inside one of the text lines RapidOCR finds on the page image (quads grown by
a few pixels). Also draws the character boxes (red) and line quads (green)
over the page to <out>/<name>-overlay.png for a visual check.

Usage (in the OCR image, app code at /app/app):
  python3 textlayer_check.py OUT_DIR searchable1.pdf [searchable2.pdf ...]
"""
import sys
from pathlib import Path

import cv2
import numpy as np
import pypdfium2 as pdfium

sys.path.insert(0, "/app/app")
import rapid_engine  # noqa: E402

out_dir = Path(sys.argv[1]); out_dir.mkdir(parents=True, exist_ok=True)
for path in sys.argv[2:]:
    doc = pdfium.PdfDocument(path)
    inside = total = 0
    for i in range(len(doc)):
        page = doc[i]
        w_pt, h_pt = page.get_size()
        scale = 2.0                                       # 144 dpi is plenty to judge placement
        img = page.render(scale=scale, no_smoothimage=True).to_numpy()[:, :, :3].copy()
        quads = [q for q, _, _ in rapid_engine.recognize(img)]
        tp = page.get_textpage()
        overlay = img.copy()
        for q in quads:
            cv2.polylines(overlay, [q.astype(np.int32)], True, (0, 170, 0), 2)
        for c in range(tp.count_chars()):
            l, b, r, t = tp.get_charbox(c)
            if r - l <= 0 or t - b <= 0:
                continue                                  # spaces / zero-size
            x0, x1 = l * scale, r * scale
            y0, y1 = (h_pt - t) * scale, (h_pt - b) * scale
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            total += 1
            ok = any(cv2.pointPolygonTest(q.astype(np.float32), (cx, cy), True) > -4 for q in quads)
            inside += ok
            cv2.rectangle(overlay, (int(x0), int(y0)), (int(x1), int(y1)), (220, 0, 0) if ok else (255, 0, 255), 1)
        if i == 0:
            cv2.imwrite(str(out_dir / f"{Path(path).stem}-overlay.png"), cv2.cvtColor(overlay, cv2.COLOR_RGB2BGR))
    print(f"{Path(path).name:32} chars on text: {inside}/{total} ({inside / max(1, total):.1%})")
