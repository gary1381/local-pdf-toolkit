"""Fixing lost English spaces: (A) gaps between single-character boxes, (B) English rec model for Latin lines."""
import json, re
from pathlib import Path
import numpy as np
import pypdfium2 as pdfium
from rapidocr import RapidOCR, OCRVersion, LangRec, ModelType

FX = Path("/w/ocrbench"); truth = json.loads((FX / "truth.json").read_text())
CJK = re.compile(r"[　-鿿＀-￯]")

a_eng = RapidOCR(params={"Global.return_single_char_box": True, "Global.return_word_box": True})
b_det = RapidOCR()
b_en = RapidOCR(params={"Rec.ocr_version": OCRVersion.PPOCRV5, "Rec.lang_type": LangRec.EN, "Rec.model_type": ModelType.MOBILE})

def a_line(chars):
    """chars: [(char, box)] for one line -> text with spaces at wide gaps."""
    if not chars: return ""
    hs = [b[:, 1].max() - b[:, 1].min() for _, b in chars]; h = float(np.median(hs))
    out = chars[0][0]
    for (c0, b0), (c1, b1) in zip(chars, chars[1:]):
        gap = b1[:, 0].min() - b0[:, 0].max()
        latin = not CJK.search(c0) and not CJK.search(c1)
        out += (" " if latin and gap > 0.22 * h else "") + c1
    return out

def text_a(img):
    r = a_eng(img); lines = []
    for wr in r.word_results:   # one entry per line: [(char, score, box), ...]
        chars = [(w[0], np.array(w[2])) for w in wr]
        lines.append(a_line(chars))
    return " ".join(lines)

def text_b(img):
    r = b_det(img); lines = []
    for box, txt in zip(r.boxes, r.txts):
        if not CJK.search(txt):
            x0, y0 = np.maximum(box.min(0).astype(int) - 2, 0); x1, y1 = box.max(0).astype(int) + 2
            rr = b_en(np.ascontiguousarray(img[y0:y1, x0:x1]), use_det=False, use_cls=False)
            en = rr.txts[0] if rr.txts else ""
            # take the English reading (better spaces) only if the characters agree
            if en.replace(" ", "") == txt.replace(" ", ""):
                txt = en
        lines.append(txt)
    return " ".join(lines)

for label, fn in (("B en model, chars must agree", text_b),):
    good = total = 0; zh_ok = []
    for name, refs in truth.items():
        doc = pdfium.PdfDocument(str(FX / name))
        for i, ref in enumerate(refs):
            pg = doc[i]
            img = pg.render(scale=1700 / pg.get_width(), no_smoothimage=True).to_numpy()[:, :, :3].copy()
            hyp = fn(img); hw = set(hyp.split())
            rw = [w for w in ref.split() if not CJK.search(w)] if "-en" in name or name == "en.pdf" else []
            good += sum(w in hw for w in rw); total += len(rw)
            if CJK.search(ref):  # Chinese must still be intact (spaces ignored)
                zh_ok.append("".join(CJK.findall(ref)) == "".join(CJK.findall(hyp)))
    print(f"{label}: English words exact {good}/{total}; Chinese pages exact {sum(zh_ok)}/{len(zh_ok)}")
