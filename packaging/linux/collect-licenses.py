"""Collect the licences of the Python packages bundled into a PyInstaller program.

    python collect-licenses.py OUT_DIR

Writes OUT_DIR/licenses/<package>-<version>/ (the licence / notice files the
package ships) and OUT_DIR/SOURCES.md (name, version, licence, where to get
the source). Every package is used unmodified; its source is the published
release of that version.
"""
import importlib.metadata as md
import re
import shutil
import sys
from pathlib import Path

out = Path(sys.argv[1])
lic_root = out / "licenses"
lic_root.mkdir(parents=True, exist_ok=True)
SKIP = {"pip"}  # build tool only, not in the program
LICENSE_FILE = re.compile(r"(^|/)(licen[cs]e|copying|notice|authors)[^/]*$", re.I)

rows = []
APACHE_TEXT = [None]  # a copy of the Apache-2.0 text found along the way
for dist in sorted(md.distributions(), key=lambda d: d.metadata["Name"].lower()):
    name, version = dist.metadata["Name"], dist.version
    if name.lower() in SKIP:
        continue
    meta = dist.metadata
    licence = meta.get("License-Expression") or ""
    if not licence:
        classifiers = [c.split(" :: ")[-1] for c in meta.get_all("Classifier") or [] if c.startswith("License ::")]
        licence = ", ".join(classifiers)
    if not licence:
        raw = (meta.get("License") or "").strip()
        licence = raw.splitlines()[0][:60] if raw else "see licence files"
    dest = lic_root / f"{name}-{version}"
    copied = 0
    for f in dist.files or []:
        path = str(f)
        src = Path(dist.locate_file(f))
        if not src.is_file():
            continue
        if ".dist-info/licenses/" in path:
            # PEP 639 folder: copy all of it, sub-folders too (e.g. the
            # licences of what pypdfium2's PDFium build includes)
            target = dest / path.split(".dist-info/licenses/", 1)[1]
        elif LICENSE_FILE.search(path) and (".dist-info" in path or path.count("/") <= 1):
            target = dest / src.name
        else:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(src, target)
        copied += 1
        if APACHE_TEXT[0] is None and "Apache-2.0" in src.name:
            APACHE_TEXT[0] = src
    rows.append([name, version, licence.replace("|", "/"), copied,
                 f"https://pypi.org/project/{name}/{version}/#files"])

# Packages that ship no licence file but are Apache-2.0 (e.g. flatbuffers):
# add the licence text itself, taken from a package that ships it.
for row in rows:
    if row[3] == 0 and "apache" in row[2].lower() and APACHE_TEXT[0] is not None:
        dest = lic_root / f"{row[0]}-{row[1]}"
        dest.mkdir(exist_ok=True)
        shutil.copy(APACHE_TEXT[0], dest / "LICENSE-Apache-2.0.txt")
        row[3] = 1

with open(out / "SOURCES.md", "w", encoding="utf-8") as fh:
    fh.write("# Bundled Python packages\n\n")
    fh.write("All are used unmodified. The source of each is its published release "
             "(\"Source\" column: the sdist on PyPI, or the project's repository linked from there). "
             "Licence texts are in licenses/<package>-<version>/.\n\n")
    fh.write("| Package | Version | Licence | Licence files | Source |\n|---|---|---|---|---|\n")
    for name, version, licence, copied, url in rows:
        fh.write(f"| {name} | {version} | {licence} | {copied} | {url} |\n")
print(f"{len(rows)} packages, licences in {lic_root}")
