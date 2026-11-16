#!/usr/bin/env python3
"""Check the services an installer carries, on the system they were built for.

Starts packaging/build/backend/ the way the desktop app does
(desktop/src-tauri/src/backend.rs: same programs, arguments and environment,
free ports on 127.0.0.1), runs real requests through the gateway, then stops
everything and checks nothing is left running.

    python packaging/desktop/smoke_test.py                  services only
    python packaging/desktop/smoke_test.py --ocr PACK.tar.gz   also unpack and use the OCR add-on

Standard library only. Exit code 0 when every check passes.
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "packaging" / "build" / "backend"
EXE = ".exe" if sys.platform == "win32" else ""
results: list[tuple[bool, str]] = []


def check(ok: bool, what: str) -> bool:
    results.append((bool(ok), what))
    print(f"{'PASS' if ok else 'FAIL'} {what}", flush=True)
    return bool(ok)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def sample_pdf(text: str = "Hello OpenPDF smoke test", pages: int = 1) -> bytes:
    """A small valid PDF with Helvetica text on each page (no libraries needed)."""
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", None, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for i in range(pages):
        content = f"BT /F1 18 Tf 72 720 Td ({text} {i + 1}) Tj ET".encode()
        objs.append(f"<< /Length {len(content)} >>\nstream\n{content.decode()}\nendstream")
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                    f"/Resources << /Font << /F1 3 0 R >> >> /Contents {len(objs)} 0 R >>")
        kids.append(f"{len(objs)} 0 R")
    objs[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {pages} >>"
    out = bytearray(b"%PDF-1.7\n")
    offsets = []
    for n, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{n} 0 obj\n{body}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def scan_pdf() -> bytes:
    """A page that is only a picture of text (black glyphs drawn as a bitmap)."""
    # 5x7 bitmap font for the letters we need
    glyphs = {
        "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
        "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
        "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
        "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
        "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
        "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
        " ": ["00000"] * 7,
    }
    word, scale, margin = "OPEN PDF", 12, 40
    w = margin * 2 + len(word) * 6 * scale
    h = margin * 2 + 7 * scale
    rows = []
    for y in range(h):
        row = bytearray(b"\xff" * w)
        gy = (y - margin) // scale
        if 0 <= gy < 7:
            for ci, ch in enumerate(word):
                for gx, bit in enumerate(glyphs[ch][gy]):
                    if bit == "1":
                        x0 = margin + (ci * 6 + gx) * scale
                        row[x0:x0 + scale] = b"\x00" * scale
        rows.append(bytes(row))
    data = zlib.compress(b"".join(rows))
    img = (f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceGray "
           f"/BitsPerComponent 8 /Filter /FlateDecode /Length {len(data)} >>\nstream\n").encode() + data + b"\nendstream"
    pw, ph = w * 72 // 150, h * 72 // 150
    content = f"q {pw} 0 0 {ph} 0 0 cm /Im1 Do Q".encode()
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {pw} {ph}] /Resources << /XObject << /Im1 4 0 R >> >> "
            f"/Contents 5 0 R >>".encode(), img,
            f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream"]
    out = bytearray(b"%PDF-1.7\n")
    offsets = []
    for n, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{n} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def post(base: str, path: str, fields: dict | None = None, files: list | None = None, timeout: float = 180):
    """multipart/form-data POST; files = [(field, filename, bytes)]. Returns (status, headers, body)."""
    boundary = uuid.uuid4().hex
    body = bytearray()
    for key, value in (fields or {}).items():
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n".encode()
    for field, filename, data in files or []:
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{filename}\"\r\n"
                 "Content-Type: application/octet-stream\r\n\r\n").encode() + data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(base + path, data=bytes(body), method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def get(url: str, timeout: float = 3):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.status, resp.read()


def wait_ready(url: str, want=lambda body: True, seconds: float = 120) -> bytes | None:
    end = time.time() + seconds
    while time.time() < end:
        try:
            status, body = get(url)
            if status == 200 and want(body):
                return body
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.5)
    return None


class Services:
    """The services, started like backend.rs does."""

    def __init__(self, data: Path, ocr_program: Path | None = None):
        self.data = data
        self.logs = data / "logs"
        self.logs.mkdir(parents=True, exist_ok=True)
        (data / "sessions").mkdir(exist_ok=True)
        self.ports = {k: free_port() for k in ("pdfbox", "qpdf", "gateway", "ocr")}
        self.children: list[tuple[str, subprocess.Popen]] = []
        server = BACKEND / "server" / f"openpdf-server{EXE}"
        pdfbox = BACKEND / "pdfbox"
        env = dict(os.environ, OPENPDF_PARENT_PID=str(os.getpid()))
        env.pop("JAVA_TOOL_OPTIONS", None)
        self._spawn("pdfbox", [pdfbox / "jre" / "bin" / f"java{EXE}", "-Xms32m", "-Xmx2g", "-XX:+UseG1GC",
                               "-Djava.awt.headless=true", "--add-opens=java.base/java.nio=ALL-UNNAMED",
                               "--add-opens=java.base/jdk.internal.ref=ALL-UNNAMED", "-jar", pdfbox / "app.jar"],
                    dict(env, PORT=str(self.ports["pdfbox"]), CJK_FONT_PATH=str(pdfbox / "fonts" / "wqy-microhei.ttc")))
        self._spawn("qpdf", [server, "qpdf", "--port", self.ports["qpdf"]],
                    dict(env, QPDF_BIN=str(BACKEND / "qpdf" / "bin" / f"qpdf{EXE}")))
        self._spawn("gateway", [server, "gateway", "--port", self.ports["gateway"]],
                    dict(env, PDFBOX_URL=f"http://127.0.0.1:{self.ports['pdfbox']}",
                         QPDF_URL=f"http://127.0.0.1:{self.ports['qpdf']}",
                         OCR_URL=f"http://127.0.0.1:{self.ports['ocr']}",
                         SESSION_DIR=str(data / "sessions"), ALLOWED_HOSTS="127.0.0.1,localhost", API_KEY=""))
        if ocr_program:
            self._spawn("ocr", [ocr_program, "--port", self.ports["ocr"]], env)
        self.base = f"http://127.0.0.1:{self.ports['gateway']}"

    def _spawn(self, name: str, cmd: list, env: dict) -> None:
        log = open(self.logs / f"{name}.log", "wb")
        flags = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW, like the app
        self.children.append((name, subprocess.Popen([str(c) for c in cmd], env=env, cwd=self.data,
                                                     stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                                     creationflags=flags)))

    def stop(self) -> None:
        for _, child in self.children:
            child.kill()
        for _, child in self.children:
            child.wait(timeout=30)

    def show_logs(self) -> None:
        for log in sorted(self.logs.glob("*.log")):
            text = log.read_text(errors="replace")[-3000:]
            print(f"----- {log.name} -----\n{text}")


def run_checks(base: str, with_ocr: bool) -> None:
    pdf = sample_pdf(pages=3)
    status, _, body = post(base, "/v1/pdf/info", files=[("file", "a.pdf", pdf)])
    check(status == 200 and json.loads(body).get("pages", json.loads(body).get("page_count")) in (3, None)
          and b"3" in body, f"info (pdfbox): {status} {body[:120]!r}")
    status, _, body = post(base, "/v1/pdf/extract", files=[("file", "a.pdf", pdf)])
    check(status == 200 and b"Hello OpenPDF" in body, f"extract text: {status}")
    status, _, body = post(base, "/v1/pdf/merge", files=[("files", "a.pdf", pdf), ("files", "b.pdf", sample_pdf())])
    check(status == 200 and body.startswith(b"%PDF"), f"merge (qpdf): {status}")
    status, _, body = post(base, "/v1/pdf/split", {"pages": "2-3"}, [("file", "a.pdf", pdf)])
    check(status == 200 and body.startswith(b"%PDF"), f"split (qpdf): {status}")
    status, _, body = post(base, "/v1/pdf/rotate", {"angle": "90", "pages": "1"}, [("file", "a.pdf", pdf)])
    check(status == 200 and body.startswith(b"%PDF"), f"rotate (qpdf): {status}")
    status, _, enc = post(base, "/v1/pdf/encrypt", {"user_password": "pw-1234"}, [("file", "a.pdf", pdf)])
    ok = status == 200 and enc.startswith(b"%PDF")
    status, _, body = post(base, "/v1/pdf/unlock", {"password": "pw-1234"}, [("file", "e.pdf", enc)])
    check(ok and status == 200 and body.startswith(b"%PDF"), f"encrypt + unlock (qpdf): {status}")
    status, _, body = post(base, "/v1/pdf/draw-text", {"text": "测试 Test 你好", "x": "72", "y": "600",
                                                       "width": "300", "height": "30", "page_index": "0"},
                           [("file", "a.pdf", pdf)])
    drawn = body if status == 200 else b""
    check(status == 200 and drawn.startswith(b"%PDF"), f"draw Chinese text (bundled font): {status} {body[:100]!r}")
    if drawn:
        status, _, body = post(base, "/v1/pdf/extract", files=[("file", "d.pdf", drawn)])
        check("你好" in body.decode("utf-8", "replace"), "Chinese text readable back")
    status, _, body = post(base, "/v1/pdf/render-page", {"page_index": "0", "scale": "1"}, [("file", "a.pdf", pdf)])
    check(status == 200 and body.startswith(b"\x89PNG"), f"render page: {status}")
    status, _, cert = post(base, "/v1/pdf/generate-cert", {"name": "Smoke Test", "cert_password": "pw-123456",
                                                           "years": "1"})
    ok = check(status == 200 and len(cert) > 500, f"generate certificate: {status}")
    if ok:
        status, _, signed = post(base, "/v1/pdf/digital-sign", {"cert_password": "pw-123456", "reason": "smoke",
                                                                "visible": "false"},
                                 [("file", "a.pdf", pdf), ("cert", "c.p12", cert)])
        check(status == 200 and signed.startswith(b"%PDF"), f"digital signature: {status} {signed[:120]!r}")
        if status == 200:
            status, _, body = post(base, "/v1/pdf/verify-signatures", files=[("file", "s.pdf", signed)])
            check(status == 200 and b"Smoke Test" in body, f"verify signature: {status} {body[:160]!r}")
    status, body = get(base + "/ui/index.html")
    check(status == 200 and b"i18n.js" in body, "editor page served")
    if with_ocr:
        status, _, body = post(base, "/v1/pdf/ocr", {"languages": "eng"}, [("file", "scan.pdf", scan_pdf())],
                               timeout=600)
        ok = check(status == 200 and body.startswith(b"%PDF"), f"OCR a scan: {status} {body[:160]!r}")
        if ok:
            status, _, text = post(base, "/v1/pdf/extract", files=[("file", "o.pdf", body)])
            found = text.decode("utf-8", "replace").upper().replace(" ", "")
            check("OPEN" in found or "PDF" in found, f"OCR text found: {found[:80]!r}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ocr", type=Path, help="OCR add-on pack (.tar.gz) to unpack and test")
    parser.add_argument("--backend", type=Path, help="services folder (default packaging/build/backend)")
    args = parser.parse_args()
    if args.backend:
        globals()["BACKEND"] = args.backend
    data = Path(tempfile.mkdtemp(prefix="openpdf-smoke-"))
    ocr_program = None
    if args.ocr:
        with tarfile.open(args.ocr) as tar:
            tar.extractall(data / "ocr", filter="data")
        ocr_program = data / "ocr" / "openpdf-ocr" / f"openpdf-ocr{EXE}"
        check(ocr_program.is_file(), "OCR add-on unpacks")
    services = Services(data, ocr_program)
    try:
        names = ["gateway", "pdfbox", "qpdf"] + (["ocr"] if ocr_program else [])
        up = {n: wait_ready(f"http://127.0.0.1:{services.ports[n]}/health", seconds=240) is not None for n in names}
        if check(all(up.values()), f"services start {up}"):
            run_checks(services.base, with_ocr=ocr_program is not None)
    finally:
        failed = [w for ok, w in results if not ok]
        if failed:
            services.show_logs()
        services.stop()
    print(f"\n{sum(ok for ok, _ in results)}/{len(results)} passed")
    return 1 if any(not ok for ok, _ in results) else 0


if __name__ == "__main__":
    sys.exit(main())
