"""Bench set: 16 random scan-like pages (zh / en / mixed, fonts, sizes, tilt)."""
import json, random, sys
from pathlib import Path
sys.argv = [sys.argv[0], "/w/ocrbench"]; sys.path.insert(0, "/w")
import ocrfx  # writes the 4 basic fixtures into /w/ocrbench too (harmless)
from ocrfx import ZH, EN, page, pdf, OUT

FONTS = ["/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
         "/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
         "/fonts/truetype/arphic/uming.ttc"]
EXTRA_ZH = ["会议纪要已发送至全体成员，请查收并反馈意见。",
            "该软件支持合并、拆分、签名和文字识别等功能。",
            "如有疑问，请致电客服热线或发送电子邮件。",
            "第三条：乙方不得将本协议项下权利转让给第三方。"]
EXTRA_EN = ["Meeting notes were sent to all members for review.",
            "Section 3: rights under this agreement are not transferable.",
            "Contact support by phone or email with any questions."]
rnd = random.Random(42); truth = {}
for i in range(16):
    kind = ["zh", "en", "mix"][i % 3]
    pool = (ZH + EXTRA_ZH) if kind == "zh" else (EN + EXTRA_EN) if kind == "en" else (ZH + EXTRA_ZH + EN + EXTRA_EN)
    lines = rnd.sample(pool, 6)
    font = FONTS[i % len(FONTS)] if kind != "en" else "/fonts/truetype/dejavu/DejaVuSerif.ttf"
    name = f"b{i:02d}-{kind}.pdf"
    pdf(name, [page(lines, font, rnd.choice([36, 40, 44, 48]), tilt=rnd.choice([0, 0, 0.7, 1.5]))])
    sep = " " if kind == "en" else ""
    truth[name] = [sep.join(lines) if kind != "mix" else "".join(lines)]
(OUT / "truth.json").write_text(json.dumps(truth, ensure_ascii=False, indent=1))
print("bench pages:", len(truth))
