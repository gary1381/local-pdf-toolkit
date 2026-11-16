"""Compare two OCR services on the fixtures: success, text accuracy (CER), size, time."""
import json, sys, time, unicodedata, urllib.request, uuid
from pathlib import Path
import pikepdf, pypdfium2 as pdfium

FX = Path(sys.argv[1]); SERVICES = dict(a.split("=", 1) for a in sys.argv[2:])
truth = json.loads((FX / "truth.json").read_text())

def post(url, pdf, **form):
    b = uuid.uuid4().hex; body = b""
    for k, v in form.items():
        body += f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    body += (f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="x.pdf"\r\n'
             f'Content-Type: application/pdf\r\n\r\n').encode() + pdf + f"\r\n--{b}--\r\n".encode()
    req = urllib.request.Request(url + "/ocr", body, {"Content-Type": f"multipart/form-data; boundary={b}"})
    try:
        with urllib.request.urlopen(req, timeout=600) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()

def norm(s): return "".join(c for c in unicodedata.normalize("NFKC", s) if not c.isspace())

def cer(ref, hyp):
    ref, hyp = norm(ref), norm(hyp)
    prev = list(range(len(hyp) + 1))
    for i, rc in enumerate(ref, 1):
        cur = [i]
        for j, hc in enumerate(hyp, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rc != hc)))
        prev = cur
    return prev[-1] / max(1, len(ref))

def text_of(pdf):
    doc = pdfium.PdfDocument(pdf)
    return [doc[i].get_textpage().get_text_range() for i in range(len(doc))]

CASES = [(n, {"languages": "chi_sim,eng"}) for n in truth] + [
    ("zh-tilt.pdf", {"languages": "chi_sim,eng", "deskew": "true"}),
    ("en.pdf", {"languages": "eng", "clean": "true"}),
    ("../fx/contract.pdf", {"languages": "eng"}),   # already has text -> skip
    ("../fx/long.pdf", {"languages": "eng"}),
]
for name, form in CASES:
    src = (FX / name).read_bytes()
    for svc, url in SERVICES.items():
        t = time.time(); code, out = post(url, src, **form); dt = time.time() - t
        line = f"{svc:4} {name:20} {json.dumps(form, ensure_ascii=False):45} HTTP {code} {dt:5.1f}s"
        if code != 200:
            print(line, "ERR", out[:160].decode("utf-8", "replace").replace("\n", " ")); continue
        with pikepdf.open(__import__("io").BytesIO(out)) as p:
            npages, pdfa = len(p.pages), "pdfaid" in str(p.open_metadata())
        line += f" pages={npages} {len(src)//1024}KB->{len(out)//1024}KB pdfa={pdfa}"
        if name in truth:
            got = text_of(out)
            line += " CER=" + ",".join(f"{cer(r, h):.3f}" for r, h in zip(truth[name], got))
        print(line, flush=True)
