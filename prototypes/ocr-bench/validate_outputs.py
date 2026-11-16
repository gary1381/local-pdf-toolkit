"""Check the OCR service's output PDFs (made by validate.sh) — run in the OCR image.

- text layer accuracy: CER of the extracted text (synthetic sets), character
  recall/precision (real images), English words exact
- text layer placement: share of characters lying on a text line in the image
- edge cases: pages that already have text, encrypted / damaged input, deskew,
  a text page followed by a scanned page
- parallel (4 pages at once) vs sequential output: identical text
"""
import json, sys, unicodedata
from collections import Counter
from pathlib import Path

import cv2
import numpy as np
import pypdfium2 as pdfium

sys.path.insert(0, "/app")
from app import rapid_engine  # noqa: E402

K = Path("/w/k/val")

def texts(path):
    doc = pdfium.PdfDocument(str(path))
    return [doc[i].get_textpage().get_text_range() for i in range(len(doc))]

N = lambda s: "".join(c for c in unicodedata.normalize("NFKC", s) if not c.isspace())
def cer(ref, hyp):
    ref, hyp = N(ref), N(hyp); prev = list(range(len(hyp) + 1))
    for i, rc in enumerate(ref, 1):
        cur = [i]
        for j, hc in enumerate(hyp, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rc != hc)))
        prev = cur
    return prev[-1] / max(1, len(ref))

def placement(path):
    """Characters whose centre lies on a text line found in the page image."""
    doc = pdfium.PdfDocument(str(path)); inside = total = 0
    for i in range(len(doc)):
        page = doc[i]; _, h_pt = page.get_size(); s = 2.0
        img = np.ascontiguousarray(page.render(scale=s, no_smoothimage=True).to_numpy()[:, :, :3])
        quads = [q.astype(np.float32) for q, _, _ in rapid_engine.recognize(img)]
        tp = page.get_textpage()
        for c in range(tp.count_chars()):
            l, b, r, t = tp.get_charbox(c)
            if r - l <= 0 or t - b <= 0:
                continue
            total += 1
            pt = ((l + r) / 2 * s, (h_pt - (b + t) / 2) * s)
            inside += any(cv2.pointPolygonTest(q, pt, True) > -4 for q in quads)
    return inside, total

out = []
for prefix, d in (("bench", "/w/ocrbench"), ("hard", "/w/ocrhard")):
    truth = json.loads(Path(d, "truth.json").read_text()); cs = []; words = [0, 0]; codes = Counter(); ins = tot = 0
    for name, refs in truth.items():
        stem = K / f"{prefix}-{Path(name).stem}"
        codes[stem.with_suffix(".code").read_text().strip()] += 1
        got = texts(stem.with_suffix(".pdf"))
        for ref, hyp in zip(refs, got):
            cs.append(cer(ref, hyp))
            if "-en" in name or name == "en.pdf":
                hw = set(hyp.split()); words[0] += sum(w in hw for w in ref.split()); words[1] += len(ref.split())
        if prefix == "hard" or "tilt" in name:
            a, b = placement(stem.with_suffix(".pdf")); ins += a; tot += b
    line = f"{prefix}: HTTP {dict(codes)}, text layer CER {np.mean(cs):.4f}, pages>15% {sum(c > .15 for c in cs)}/{len(cs)}, EN words {words[0]}/{words[1]}"
    if tot:
        line += f", chars on text {ins}/{tot} ({ins / tot:.1%})"
    out.append(line)

PUNCT = set("，。、；：“”‘’（）()!！?？,.;:\"'·-—|/&%@_")
bag = lambda s: Counter(c for c in unicodedata.normalize("NFKC", s) if not c.isspace() and c not in PUNCT)
real = json.loads(Path("/r/real-samples/truth.json").read_text())
for p in sorted(K.glob("real-*.pdf")):
    stem = p.stem[len("real-"):]
    got = "".join(texts(p)); a, b = placement(p)
    line = f"{p.stem}: chars on text {a}/{b}"
    if stem in real:
        want, have = bag(real[stem]), bag(got); hit = sum((want & have).values())
        line += f", recall {hit / sum(want.values()):.1%}, precision {hit / max(1, sum(have.values())):.1%}"
    else:
        line += f", text: {' '.join(got.split())[:60]!r}"
    out.append(line)

src = texts("/w/fx/contract.pdf"); res = texts(K / "edge-has-text.pdf")
out.append(f"edge has-text: HTTP {(K / 'edge-has-text.code').read_text().strip()}, pages {len(res)}/{len(src)}, text unchanged {src == res}")
for n in ("edge-encrypted", "edge-broken"):
    body = (K / f"{n}.pdf").read_bytes()
    out.append(f"{n}: HTTP {(K / f'{n}.code').read_text().strip()} {body[:140].decode('utf-8', 'replace')!r}")
zh = json.loads(Path("/w/ocrfx/truth.json").read_text())["zh-tilt.pdf"][0]
a, b = placement(K / "edge-deskew.pdf")
out.append(f"edge deskew: HTTP {(K / 'edge-deskew.code').read_text().strip()}, CER {cer(zh, texts(K / 'edge-deskew.pdf')[0]):.4f}, chars on text {a}/{b}")
mixed = texts(K / "edge-mixed.pdf"); zh0 = json.loads(Path("/w/ocrfx/truth.json").read_text())["zh.pdf"][0]
out.append(f"edge mixed: HTTP {(K / 'edge-mixed.code').read_text().strip()}, text page kept {mixed[0] == texts('/w/fx/contract.pdf')[0]}, scan page CER {cer(zh0, mixed[1]):.4f}")
par, seq = texts(K / "par-ten.pdf"), texts(K / "seq-ten.pdf")
out.append(f"parallel vs sequential (10 pages): identical text on {sum(a == b for a, b in zip(par, seq))}/{len(seq)} pages")
print("\n".join(out))
