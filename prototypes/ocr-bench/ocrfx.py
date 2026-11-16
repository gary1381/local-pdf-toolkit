"""Scan-like OCR fixtures: image-only pages rendered from known text."""
import io, json, random, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import img2pdf, pikepdf

OUT = Path(sys.argv[1]); OUT.mkdir(parents=True, exist_ok=True)
CJK = "/fonts/opentype/noto/NotoSerifCJK-Regular.ttc"
LAT = "/fonts/truetype/dejavu/DejaVuSerif.ttf"
random.seed(7)

ZH = ["开源软件许可证决定了代码能否被商业使用。",
      "本合同自双方签字盖章之日起生效，有效期三年。",
      "光学字符识别技术可以把扫描件转换成可搜索的文字。",
      "请于二零二六年十月三十一日前提交季度财务报告。",
      "北京市海淀区中关村大街二十七号，邮编一零零零八零。",
      "甲方应按月支付服务费用人民币壹万贰仟元整。"]
EN = ["The quick brown fox jumps over the lazy dog.",
      "Invoice number 2026-1042 is due on October 31.",
      "Optical character recognition turns scans into text.",
      "Please sign and return the attached agreement.",
      "Total amount payable: 12,480.50 USD including tax.",
      "OpenPDF is free for personal and commercial use."]

def page(lines, font, size, tilt=0.0, noise=True):
    W, H = 1700, 2200  # A-ish page at 200 dpi
    img = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(font, size)
    y = 180
    for ln in lines:
        d.text((150, y), ln, font=f, fill=random.randint(0, 40)); y += int(size * 2.1)
    if noise:
        px = img.load()
        for _ in range(9000):
            px[random.randrange(W), random.randrange(H)] = random.randint(120, 220)
        img = img.filter(ImageFilter.GaussianBlur(0.6))
    if tilt:
        img = img.rotate(tilt, fillcolor=255, resample=Image.BICUBIC)
    buf = io.BytesIO(); img.convert("RGB").save(buf, "JPEG", quality=80)
    return buf.getvalue()

def pdf(name, pages):
    lay = img2pdf.get_layout_fun((img2pdf.mm_to_pt(210), img2pdf.mm_to_pt(297)))
    (OUT / name).write_bytes(img2pdf.convert(pages, layout_fun=lay))

truth = {}
pdf("zh.pdf", [page(ZH, CJK, 44)]); truth["zh.pdf"] = ["".join(ZH)]
pdf("zh-tilt.pdf", [page(ZH, CJK, 44, tilt=2.0)]); truth["zh-tilt.pdf"] = ["".join(ZH)]
pdf("en.pdf", [page(EN, LAT, 40)]); truth["en.pdf"] = [" ".join(EN)]
pdf("mixed-2p.pdf", [page(ZH[:3] + EN[:3], CJK, 42), page(EN[3:] + ZH[3:], CJK, 42)])
truth["mixed-2p.pdf"] = ["".join(ZH[:3]) + " ".join(EN[:3]), " ".join(EN[3:]) + "".join(ZH[3:])]
(OUT / "truth.json").write_text(json.dumps(truth, ensure_ascii=False, indent=1))
print("ok", sorted(p.name for p in OUT.iterdir()))
