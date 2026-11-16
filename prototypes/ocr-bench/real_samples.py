"""Real images: to PDF, OCR, and score. Run in steps (different images have different tools).

  topdf  <dir>            (pdf-gateway-ocr image)   images -> <dir>/out/<name>.pdf
  tess   <dir>            (pdf-gateway-ocr image)   text of <dir>/out/<name>-tesseract.pdf -> .txt
  rapid  <dir>            (rapidocr prototype)      RapidOCR on the images -> <dir>/out/<name>-rapidocr.txt
  score  <dir>            (any)                     character recall / precision vs truth.json
"""
import json, sys, unicodedata
from collections import Counter
from pathlib import Path

step, D = sys.argv[1], Path(sys.argv[2]); OUT = D / "out"; OUT.mkdir(exist_ok=True)
IMAGES = sorted(p for p in D.iterdir() if p.suffix.lower() in (".png", ".jpg", ".jpeg"))

if step == "topdf":
    import io, img2pdf
    from PIL import Image
    for p in IMAGES:
        im = Image.open(p); data = p.read_bytes()      # JPEG goes in as is (no re-encoding)
        if im.mode in ("RGBA", "LA", "P"):             # alpha can't go into a PDF image: flatten on white
            rgba = im.convert("RGBA"); bg = Image.new("RGB", im.size, "white"); bg.paste(rgba, mask=rgba.split()[3])
            buf = io.BytesIO(); bg.save(buf, "PNG"); data = buf.getvalue()
        (OUT / f"{p.stem}.pdf").write_bytes(img2pdf.convert(data))
        print("pdf", p.stem, im.size, im.mode)

elif step == "tess":
    import pypdfium2 as pdfium
    for p in IMAGES:
        f = OUT / f"{p.stem}-tesseract.pdf"
        doc = pdfium.PdfDocument(str(f))
        (OUT / f"{p.stem}-tesseract.txt").write_text("\n".join(doc[i].get_textpage().get_text_range() for i in range(len(doc))))

elif step == "rapid":
    sys.argv = ["x"]
    exec(open("/w/rapid/spaces.py").read().split("for label, fn in")[0])   # engines + text_b (en re-read rule)
    import numpy as np
    from PIL import Image
    for p in IMAGES:
        im = Image.open(p)
        if im.mode in ("RGBA", "LA", "P"):             # same white background as the PDF
            rgba = im.convert("RGBA"); bg = Image.new("RGB", im.size, "white"); bg.paste(rgba, mask=rgba.split()[3]); im = bg
        img = np.ascontiguousarray(np.array(im.convert("RGB")))
        try:
            text = text_b(img)
        except TypeError:                              # nothing detected
            text = ""
        (OUT / f"{p.stem}-rapidocr.txt").write_text(text)
        print("rapid", p.stem, len(text))

elif step == "score":
    truth = json.loads((D / "truth.json").read_text())
    PUNCT = set("，。、；：“”‘’（）()!！?？,.;:\"'·-—|/&%@_")
    norm = lambda s: Counter(c for c in unicodedata.normalize("NFKC", s) if not c.isspace() and c not in PUNCT)
    for p in IMAGES:
        for eng in ("tesseract", "rapidocr"):
            t = (OUT / f"{p.stem}-{eng}.txt")
            hyp = t.read_text() if t.exists() else ""
            if p.stem in truth:
                ref, got = norm(truth[p.stem]), norm(hyp); hit = sum((ref & got).values())
                print(f"{p.stem:16} {eng:10} recall {hit/sum(ref.values()):6.1%}  precision {hit/max(1,sum(got.values())):6.1%}  ({sum(ref.values())} chars)")
            else:
                print(f"{p.stem:16} {eng:10} -> {' / '.join(l.strip() for l in hyp.splitlines() if l.strip())[:120]}")
