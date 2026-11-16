#!/usr/bin/env python3
"""Build the OpenPDF desktop installer on Windows or macOS.

Everything is built natively on the machine it runs on (the GitHub Actions
workflow .github/workflows/desktop.yml runs it on Windows and macOS runners;
Linux packages are built with packaging/linux/ instead, in containers):

    python packaging/desktop/build.py              services, OCR add-on, installer
    python packaging/desktop/build.py --no-ocr     without the OCR add-on
    python packaging/desktop/build.py --only services|ocr|app

Needs on the machine: Python 3.12, a JDK 17 (JAVA_HOME), Maven, Rust, Node.

Output, in packaging/build/dist/:
    Windows  OpenPDF_<version>_x64-setup.exe, OpenPDF_<version>_x64_en-US.msi
    macOS    OpenPDF_<version>_<arch>.dmg
    both     openpdf-ocr-<version>-<os>-<arch>.tar.gz, SHA256SUMS

The services folder the app carries (see desktop/src-tauri/src/backend.rs):
    backend/server/openpdf-server[.exe]   gateway + qpdf service (PyInstaller)
    backend/qpdf/bin/qpdf[.exe]           qpdf, official build (checked against its SHA-256)
    backend/pdfbox/jre/                   Java runtime cut down by jlink
    backend/pdfbox/app.jar, fonts/        PDFBox service and the CJK font
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
B = ROOT / "packaging" / "build"
DIST = B / "dist"
WINDOWS = sys.platform == "win32"
MACOS = sys.platform == "darwin"
EXE = ".exe" if WINDOWS else ""
PYINSTALLER = "pyinstaller==6.22.3"

QPDF_VERSION = "12.4.2"
QPDF_ZIPS = {
    # name in the release -> folder inside the zip that holds bin/ (and lib/)
    ("windows", "x86_64"): ("qpdf-12.4.2-msvc64.zip", "qpdf-12.4.2-msvc64"),
    ("macos", "aarch64"): ("qpdf-12.4.2-bin-macos-arm64.zip", ""),
    ("macos", "x86_64"): ("qpdf-12.4.2-bin-macos-x86_64.zip", ""),
}
# WenQuanYi Micro Hei (Chinese text written into PDFs), from Debian, as on Linux.
FONT_DEB = "http://deb.debian.org/debian/pool/main/f/fonts-wqy-microhei/fonts-wqy-microhei_0.2.0-beta-3.1_all.deb"
FONT_DEB_SHA256 = "239163df984eea5c9da3b551aee374936222cdbd67f1a1be3cdcf3d76143ad66"


def system() -> tuple[str, str]:
    os_name = "windows" if WINDOWS else "macos" if MACOS else "linux"
    machine = platform.machine().lower()
    arch = {"amd64": "x86_64", "x86_64": "x86_64", "arm64": "aarch64", "aarch64": "aarch64"}.get(machine, machine)
    return os_name, arch


def version() -> str:
    return json.loads((ROOT / "desktop" / "src-tauri" / "tauri.conf.json").read_text())["version"]


def run(cmd: list, **kw) -> None:
    print("+", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], check=True, **kw)


def fresh(path: Path) -> Path:
    if path.exists():
        shutil.rmtree(path, onerror=_writable)
    path.mkdir(parents=True)
    return path


def _writable(func, path, _exc):
    os.chmod(path, stat.S_IWRITE)
    func(path)


def download(url: str, dest: Path) -> Path:
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"download {url}", flush=True)
        with urllib.request.urlopen(url, timeout=300) as resp, open(dest.with_suffix(".part"), "wb") as fh:
            shutil.copyfileobj(resp, fh)
        dest.with_suffix(".part").replace(dest)
    return dest


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def venv(name: str, *requirements: str) -> Path:
    """A clean virtual environment per program, so its licence list is exact."""
    env = B / f"venv-{name}"
    if not env.exists():
        run([sys.executable, "-m", "venv", env])
    py = env / ("Scripts/python.exe" if WINDOWS else "bin/python")
    run([py, "-m", "pip", "install", "-q", "--upgrade", "pip"])
    run([py, "-m", "pip", "install", "-q", *requirements])
    return py


# ------------------------------------------------------------------ services

def build_server() -> Path:
    """gateway + qpdf service as one PyInstaller program (onedir)."""
    work = fresh(B / "work-server")
    out = B / "server"
    shutil.copytree(ROOT / "gateway" / "app", work / "app", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy(ROOT / "services" / "qpdf" / "app" / "main.py", work / "qpdf_service.py")
    shutil.copy(ROOT / "packaging" / "linux" / "server" / "openpdf_server.py", work)
    py = venv("server", "-r", str(ROOT / "gateway" / "requirements.txt"),
              "-r", str(ROOT / "services" / "qpdf" / "requirements.txt"), PYINSTALLER)
    run([py, "-m", "PyInstaller", "--noconfirm", "--clean", "--log-level", "WARN", "--onedir",
         "--name", "openpdf-server", "--distpath", out, "--workpath", work / "build", "--specpath", work,
         "--add-data", f"{work / 'app' / 'static'}:app/static",
         "--collect-submodules", "app", "--hidden-import", "qpdf_service",
         "--exclude-module", "uvloop", "--exclude-module", "httptools", "--exclude-module", "watchfiles",
         "--exclude-module", "websockets", "--exclude-module", "tkinter",
         work / "openpdf_server.py"], cwd=work)
    run([py, ROOT / "packaging" / "linux" / "collect-licenses.py", out / "openpdf-server"])
    return out / "openpdf-server"


def build_pdfbox() -> Path:
    """app.jar (Maven), a jlink Java runtime from the JDK in JAVA_HOME, the font."""
    out = fresh(B / "pdfbox")
    src = fresh(B / "work-pdfbox") / "pdfbox"
    shutil.copytree(ROOT / "services" / "pdfbox", src, ignore=shutil.ignore_patterns("target"))
    mvn = shutil.which("mvn") or shutil.which("mvn.cmd")
    run([mvn, "-q", "-B", "-DskipTests", "package"], cwd=src)
    jar = next((src / "target").glob("pdfbox-service-*.jar"))  # not original-*.jar (unshaded)
    shutil.copy(jar, out / "app.jar")

    java_home = Path(os.environ["JAVA_HOME"])
    jdeps = java_home / "bin" / f"jdeps{EXE}"
    jlink = java_home / "bin" / f"jlink{EXE}"
    mods = subprocess.run([str(jdeps), "--ignore-missing-deps", "--print-module-deps", "--multi-release", "17",
                           str(out / "app.jar")], check=True, capture_output=True, text=True).stdout.strip()
    # Added by hand (jdeps cannot see them): EC keys for signatures, extra
    # charsets, the zip file system, DNS lookups for time-stamp servers.
    mods += ",jdk.crypto.ec,jdk.charsets,jdk.zipfs,jdk.naming.dns"
    if WINDOWS:
        mods += ",jdk.crypto.mscapi"
    print("java modules:", mods)
    run([jlink, "--add-modules", mods, "--strip-debug", "--no-man-pages", "--no-header-files",
         "--compress=2", "--output", out / "jre"])
    run([out / "jre" / "bin" / f"java{EXE}", "-version"])

    fonts = out / "fonts"
    fonts.mkdir()
    deb = download(FONT_DEB, B / "dl" / Path(FONT_DEB).name)
    if sha256(deb) != FONT_DEB_SHA256:
        sys.exit(f"{deb}: SHA-256 does not match")
    data = _deb_member(deb, "data.tar")
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        for member, target in (("./usr/share/fonts/truetype/wqy/wqy-microhei.ttc", "wqy-microhei.ttc"),
                               ("./usr/share/doc/fonts-wqy-microhei/copyright", "wqy-microhei.copyright")):
            (fonts / target).write_bytes(tar.extractfile(member).read())
    return out


def _deb_member(deb: Path, prefix: str) -> bytes:
    """A member of a .deb (an `ar` archive), e.g. data.tar.xz."""
    raw = deb.read_bytes()
    assert raw[:8] == b"!<arch>\n", "not a .deb"
    pos = 8
    while pos < len(raw):
        header = raw[pos:pos + 60]
        name = header[:16].decode().strip().rstrip("/")
        size = int(header[48:58])
        body = raw[pos + 60:pos + 60 + size]
        if name.startswith(prefix):
            return body
        pos += 60 + size + (size % 2)
    raise SystemExit(f"{deb}: no {prefix}*")


def fetch_qpdf() -> Path:
    os_name, arch = system()
    zip_name, inner = QPDF_ZIPS[(os_name, arch)]
    base = f"https://github.com/qpdf/qpdf/releases/download/v{QPDF_VERSION}"
    z = download(f"{base}/{zip_name}", B / "dl" / zip_name)
    sums = download(f"{base}/qpdf-{QPDF_VERSION}.sha256", B / "dl" / f"qpdf-{QPDF_VERSION}.sha256")
    expected = next(line.split()[0] for line in sums.read_text().splitlines() if line.endswith(" " + zip_name))
    if sha256(z) != expected:
        sys.exit(f"{zip_name}: SHA-256 does not match the qpdf release")
    out = fresh(B / "qpdf")
    prefix = f"{inner}/" if inner else ""
    with zipfile.ZipFile(z) as zf:
        links = {}
        for info in zf.infolist():
            if not info.filename.startswith(prefix) or info.is_dir():
                continue
            rel = info.filename[len(prefix):]
            if not (rel.startswith("bin/") or rel.startswith("lib/") or rel.upper().startswith(("LICENSE", "NOTICE"))):
                continue
            target = out / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                links[target] = zf.read(info).decode()  # the app's resources cannot hold links
                continue
            target.write_bytes(zf.read(info))
            if mode & 0o111:
                target.chmod(0o755)
        for link, dest in links.items():
            shutil.copy2(link.parent / dest, link)
    run([out / "bin" / f"qpdf{EXE}", "--version"])
    return out


# ------------------------------------------------------------------ OCR add-on

def build_ocr() -> Path:
    """services/ocr (OCRmyPDF + RapidOCR + models) as one program, packed as .tar.gz."""
    work = fresh(B / "work-ocr")
    shutil.copytree(ROOT / "services" / "ocr" / "app", work / "app", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy(ROOT / "packaging" / "linux" / "ocr" / "openpdf_ocr.py", work)
    py = venv("ocr", "-r", str(ROOT / "services" / "ocr" / "requirements.txt"), PYINSTALLER)
    env = dict(os.environ, ORT_DISABLE_TELEMETRY="1")
    run([py, "-m", "app.ocr_models"], cwd=work, env=env)  # the models it uses, into rapidocr/models
    dist = work / "dist"
    run([py, "-m", "PyInstaller", "--noconfirm", "--clean", "--log-level", "WARN", "--onedir",
         "--name", "openpdf-ocr", "--distpath", dist, "--workpath", work / "build", "--specpath", work,
         "--collect-all", "rapidocr",
         "--collect-submodules", "ocrmypdf", "--collect-data", "ocrmypdf",
         # modules pikepdf loads only when a PDF needs them (pikepdf.jbig2: JBIG2 scans)
         "--collect-submodules", "pikepdf",
         "--collect-submodules", "app", "--hidden-import", "app.rapid_engine", "--hidden-import", "app.pdfium_nosmooth",
         *[a for m in ("ocrmypdf", "rapidocr", "pikepdf", "pypdfium2", "img2pdf", "fpdf2", "pdfminer.six", "onnxruntime")
           for a in ("--copy-metadata", m)],
         "--exclude-module", "tkinter", "--exclude-module", "onnxruntime.transformers",
         "--exclude-module", "onnxruntime.quantization", "--exclude-module", "onnxruntime.tools",
         work / "openpdf_ocr.py"], cwd=work, env=env)
    run([py, ROOT / "packaging" / "linux" / "collect-licenses.py", dist / "openpdf-ocr"])
    shutil.copy(ROOT / "THIRD-PARTY-NOTICES.md", dist / "openpdf-ocr")
    out = B / "ocr"
    out.mkdir(exist_ok=True)
    pack = out / "openpdf-ocr.tar.gz"
    with tarfile.open(pack, "w:gz") as tar:
        tar.add(dist / "openpdf-ocr", arcname="openpdf-ocr")
    print(f"OCR add-on: {pack} ({pack.stat().st_size // 1_048_576} MB), SHA-256 {sha256(pack)}")
    return pack


# ------------------------------------------------------------------ app

def assemble() -> Path:
    r = fresh(B / "backend")
    shutil.copytree(B / "server" / "openpdf-server", r / "server")
    shutil.copytree(B / "pdfbox", r / "pdfbox")
    shutil.copytree(B / "qpdf", r / "qpdf")
    shutil.copy(ROOT / "THIRD-PARTY-NOTICES.md", r)
    for path in r.rglob("*"):  # jlink leaves read-only files; the next build must replace them
        if path.is_file():
            path.chmod(path.stat().st_mode | stat.S_IWRITE)
    return r


def build_app(with_ocr: bool) -> list[Path]:
    os_name, arch = system()
    env = dict(os.environ)
    pack = B / "ocr" / "openpdf-ocr.tar.gz"
    if with_ocr and pack.exists():
        env["OPENPDF_OCR_SHA256"] = sha256(pack)  # built into the app: downloads are checked against it
    if MACOS and env.get("APPLE_SIGNING_IDENTITY"):
        run(["bash", ROOT / "packaging" / "macos" / "sign-backend.sh", B / "backend"], env=env)
    desktop = ROOT / "desktop"
    npm = shutil.which("npm") or shutil.which("npm.cmd")
    run([npm, "ci" if (desktop / "package-lock.json").exists() else "install"], cwd=desktop, env=env)
    config = ROOT / "packaging" / ("windows" if WINDOWS else "macos") / "tauri.bundle.json"
    bundles = "nsis,msi" if WINDOWS else "app,dmg"
    npx = shutil.which("npx") or shutil.which("npx.cmd")
    run([npx, "tauri", "build", "--config", config, "--bundles", bundles], cwd=desktop, env=env)

    DIST.mkdir(parents=True, exist_ok=True)
    bundle = desktop / "src-tauri" / "target" / "release" / "bundle"
    made = []
    patterns = ["nsis/*.exe", "msi/*.msi"] if WINDOWS else ["dmg/*.dmg"]
    for pattern in patterns:
        for f in bundle.glob(pattern):
            made.append(shutil.copy2(f, DIST / f.name))
    if with_ocr and pack.exists():
        name = f"openpdf-ocr-{version()}-{os_name}-{arch}.tar.gz"
        made.append(shutil.copy2(pack, DIST / name))
    with open(DIST / f"SHA256SUMS-{os_name}-{arch}", "w") as fh:
        for f in sorted(Path(p) for p in made):
            fh.write(f"{sha256(f)}  {f.name}\n")
    return [Path(p) for p in made]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--no-ocr", action="store_true", help="skip the OCR add-on")
    parser.add_argument("--only", choices=["services", "ocr", "app"], help="build one part")
    args = parser.parse_args()
    if not (WINDOWS or MACOS):
        sys.exit("On Linux use packaging/linux/build-all.sh")
    print("system:", *system(), "version:", version())
    if args.only in (None, "services"):
        build_server()
        build_pdfbox()
        fetch_qpdf()
        assemble()
    if args.only in (None, "ocr") and not args.no_ocr:
        build_ocr()
    if args.only in (None, "app"):
        for f in build_app(with_ocr=not args.no_ocr):
            print("built", f, f"{f.stat().st_size // 1_048_576} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
