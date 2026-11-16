"""Tesseract via the OCR service (current production settings) on a fixture dir."""
import json, sys, time
D = sys.argv[1]; URL = sys.argv[2]
sys.argv = ["x", "/w/ocrfx"]; sys.path.insert(0, "/w")
import ocrcmp
from pathlib import Path
FX = Path(D); truth = json.loads((FX / "truth.json").read_text())
cs, words, spent, n = [], [0, 0], 0.0, 0
for name, refs in truth.items():
    t = time.time(); code, out = ocrcmp.post(URL, (FX / name).read_bytes(), languages="eng,chi_sim")
    spent += time.time() - t; assert code == 200, (name, code, out[:200])
    for ref, hyp in zip(refs, ocrcmp.text_of(out)):
        n += 1; cs.append((name, ocrcmp.cer(ref, hyp)))
        if "-en" in name or name == "en.pdf":
            hw = set(hyp.split()); rw = ref.split()
            words[0] += sum(w in hw for w in rw); words[1] += len(rw)
bad = [f"{nm}:{c:.2f}" for nm, c in cs if c > 0.15]
print(f"Tesseract {D}: mean CER {sum(c for _, c in cs)/len(cs):.3f} over {len(cs)} pages; "
      f">15%: {bad or 'none'}; English words exact {words[0]}/{words[1]}; {spent/n:.2f}s/page (incl. PDF in/out)")
