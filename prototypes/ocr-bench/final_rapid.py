"""RapidOCR (default PP-OCRv6 small + English re-read for Latin lines) on a fixture dir."""
import sys, time, unicodedata
D = sys.argv[1]
sys.argv = ["x"]
exec(open("/w/rapid/spaces.py").read().split("for label, fn in")[0])  # engines, text_b, CJK
FX = Path(D); truth = json.loads((FX / "truth.json").read_text())
N = lambda s: "".join(c for c in unicodedata.normalize("NFKC", s) if not c.isspace())
def cer(ref, hyp):
    ref, hyp = N(ref), N(hyp); prev = list(range(len(hyp) + 1))
    for i, rc in enumerate(ref, 1):
        cur = [i]
        for j, hc in enumerate(hyp, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rc != hc)))
        prev = cur
    return prev[-1] / max(1, len(ref))
cs, words, spent, n = [], [0, 0], 0.0, 0
for name, refs in truth.items():
    doc = pdfium.PdfDocument(str(FX / name))
    for i, ref in enumerate(refs):
        pg = doc[i]
        # same input Tesseract gets: the page at its scan resolution, no smoothing
        px = 1240 if name.startswith("h") else 1700        # scan width in pixels
        img = pg.render(scale=px / pg.get_width(), no_smoothimage=True).to_numpy()[:, :, :3].copy()
        t = time.time(); hyp = text_b(img); spent += time.time() - t; n += 1
        cs.append((name, cer(ref, hyp)))
        if "-en" in name or name == "en.pdf":
            hw = set(hyp.split()); rw = ref.split()
            words[0] += sum(w in hw for w in rw); words[1] += len(rw)
bad = [f"{nm}:{c:.2f}" for nm, c in cs if c > 0.15]
print(f"RapidOCR {D}: mean CER {sum(c for _, c in cs)/len(cs):.3f} over {len(cs)} pages; "
      f">15%: {bad or 'none'}; English words exact {words[0]}/{words[1]}; {spent/n:.2f}s/page")
