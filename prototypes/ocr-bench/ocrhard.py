"""Harder scan-like pages: 150 dpi, small type, heavy noise/blur, skew, low JPEG quality."""
import io, json, random, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import img2pdf
sys.argv = [sys.argv[0], "/w/ocrhard"]; sys.path.insert(0, "/w")
from ocrfx import ZH, EN, OUT
from ocrbench import EXTRA_ZH, EXTRA_EN, FONTS

rnd = random.Random(2026); truth = {}

def hard_page(lines, font, size, tilt):
    W, H = 1240, 1754                      # A4 at 150 dpi
    img = Image.new("L", (W, H), rnd.randint(225, 245))   # grey paper
    d = ImageDraw.Draw(img); f = ImageFont.truetype(font, size); y = 120
    for ln in lines:
        d.text((90, y), ln, font=f, fill=rnd.randint(20, 70)); y += int(size * 1.9)
    px = img.load()
    for _ in range(40000):
        px[rnd.randrange(W), rnd.randrange(H)] = rnd.randint(60, 200)
    img = img.filter(ImageFilter.GaussianBlur(1.0)).rotate(tilt, fillcolor=235, resample=Image.BICUBIC)
    buf = io.BytesIO(); img.convert("RGB").save(buf, "JPEG", quality=45); return buf.getvalue()

lay = img2pdf.get_layout_fun((img2pdf.mm_to_pt(210), img2pdf.mm_to_pt(297)))
for i in range(12):
    kind = ["zh", "en", "mix"][i % 3]
    pool = (ZH + EXTRA_ZH) if kind == "zh" else (EN + EXTRA_EN) if kind == "en" else (ZH + EXTRA_ZH + EN + EXTRA_EN)
    lines = rnd.sample(pool, 8 if kind != "en" else 7)
    font = FONTS[i % len(FONTS)] if kind != "en" else "/fonts/truetype/dejavu/DejaVuSerif.ttf"
    name = f"h{i:02d}-{kind}.pdf"
    (OUT / name).write_bytes(img2pdf.convert(
        [hard_page(lines, font, rnd.choice([24, 26, 28]), rnd.choice([-3, -2, 2, 3]))], layout_fun=lay))
    truth[name] = [(" " if kind == "en" else "").join(lines)]
for p in OUT.glob("*.pdf"):
    if p.name not in truth: p.unlink()
(OUT / "truth.json").write_text(json.dumps(truth, ensure_ascii=False, indent=1))
print("hard pages:", len(truth))
