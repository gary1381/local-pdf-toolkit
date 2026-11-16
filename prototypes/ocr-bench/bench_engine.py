"""The service's recognition (app/rapid_engine.recognize) on all test sets.

Synthetic sets: CER (order matters; whitespace ignored). Real images: character
recall / precision (order-free, punctuation ignored), because table layouts
are read in different orders. English pages: whole words exactly right.

Usage (OCR image, app at /app/app, this dir at /r, fixtures at /w):
  python3 bench_engine.py [label] [Det.param=value ...]
"""
import json, sys, time, unicodedata
from collections import Counter
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium
from PIL import Image

sys.path.insert(0, "/app/app")
import rapid_engine  # noqa: E402

label = sys.argv[1] if len(sys.argv) > 1 else "default"
def _value(v):
    from rapidocr import ModelType, OCRVersion
    for enum in (OCRVersion, ModelType):
        if v in enum.__members__:
            return enum[v]
    if v in ("True", "False"):
        return v == "True"
    try:
        return int(v)
    except ValueError:
        try:
            return float(v)
        except ValueError:
            return v
overrides = {k: _value(v) for k, v in (a.split("=") for a in sys.argv[2:])}
if overrides:
    from rapidocr import RapidOCR
    base = rapid_engine.ocr_models.params("main", rapid_engine._threads())
    rapid_engine._engines["main"] = RapidOCR(params={**base, **overrides})

N = lambda s: "".join(c for c in unicodedata.normalize("NFKC", s) if not c.isspace())
def cer(ref, hyp):
    ref, hyp = N(ref), N(hyp); prev = list(range(len(hyp) + 1))
    for i, rc in enumerate(ref, 1):
        cur = [i]
        for j, hc in enumerate(hyp, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rc != hc)))
        prev = cur
    return prev[-1] / max(1, len(ref))

def read(img):
    return " ".join(t for _, t, _ in rapid_engine.recognize(np.ascontiguousarray(img)))

results, t0 = [], time.time()
for d, px in (("/w/ocrbench", 1700), ("/w/ocrhard", 1240)):
    truth = json.loads(Path(d, "truth.json").read_text()); cs = []; words = [0, 0]
    for name, refs in truth.items():
        doc = pdfium.PdfDocument(f"{d}/{name}")
        for i, ref in enumerate(refs):
            pg = doc[i]
            hyp = read(pg.render(scale=px / pg.get_width(), no_smoothimage=True).to_numpy()[:, :, :3])
            cs.append(cer(ref, hyp))
            if "-en" in name or name == "en.pdf":
                hw = set(hyp.split()); words[0] += sum(w in hw for w in ref.split()); words[1] += len(ref.split())
    results.append(f"{Path(d).name}: CER {np.mean(cs):.4f}, pages>15% {sum(c > .15 for c in cs)}/{len(cs)}, EN words {words[0]}/{words[1]}")

PUNCT = set("，。、；：“”‘’（）()!！?？,.;:\"'·-—|/&%@_")
bag = lambda s: Counter(c for c in unicodedata.normalize("NFKC", s) if not c.isspace() and c not in PUNCT)
real = json.loads(Path("/r/real-samples/truth.json").read_text())
for stem, ref in real.items():
    p = next(Path("/r/real-samples").glob(stem + ".*"))
    im = Image.open(p)
    if im.mode in ("RGBA", "LA", "P"):
        rgba = im.convert("RGBA"); bg = Image.new("RGB", im.size, "white"); bg.paste(rgba, mask=rgba.split()[3]); im = bg
    got = bag(read(np.array(im.convert("RGB")))); want = bag(ref); hit = sum((want & got).values())
    results.append(f"{stem}: recall {hit / sum(want.values()):.1%} precision {hit / max(1, sum(got.values())):.1%}")
print(f"[{label}] " + " | ".join(results) + f" | {time.time() - t0:.0f}s")
