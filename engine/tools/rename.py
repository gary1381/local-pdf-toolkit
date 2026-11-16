"""Give the engine its final name everywhere in one go.

    python engine/tools/rename.py "PDFern" [--slug pdfern] [--root ENGINE_TREE] [--dry-run]

Replaces the display name ("PDF Engine"), the slug ("pdf-engine": image,
repository, MCP server name), the Python package ("pdf_engine") and the
environment prefix ("PDF_ENGINE_") in the engine's files, and renames the
package folder. Run it on the private tree (engine/ and the files it uses) or
on an exported public tree (--root).
"""
import argparse
import re
from pathlib import Path

OLD = {"display": "PDF Engine", "slug": "pdf-engine", "module": "pdf_engine", "env": "PDF_ENGINE_"}
TEXT_SUFFIXES = {".py", ".md", ".json", ".yml", ".yaml", ".sh", ".txt", ""}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("display")
    ap.add_argument("--slug")
    ap.add_argument("--root", default=None)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    slug = a.slug or re.sub(r"[^a-z0-9]+", "-", a.display.lower()).strip("-")
    new = {"display": a.display, "slug": slug, "module": slug.replace("-", "_"),
           "env": slug.replace("-", "_").upper() + "_"}
    root = Path(a.root) if a.root else Path(__file__).resolve().parents[2]
    targets = [p for p in root.rglob("*") if p.is_file() and (p.suffix in TEXT_SUFFIXES or p.name == "Dockerfile")
               and not any(part in {".git", "node_modules", "target", "__pycache__", "desktop", "packaging", "prototypes"}
                           for part in p.relative_to(root).parts)]
    changed = 0
    for p in targets:
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        out = text
        for key in ("env", "module", "slug", "display"):
            out = out.replace(OLD[key], new[key])
        if out != text:
            changed += 1
            print(("would change " if a.dry_run else "changed ") + str(p.relative_to(root)))
            if not a.dry_run:
                p.write_text(out, encoding="utf-8")
    for pkg in root.rglob(OLD["module"]):
        if pkg.is_dir() and "node_modules" not in pkg.parts:
            dest = pkg.with_name(new["module"])
            print(("would rename " if a.dry_run else "renamed ") + f"{pkg.relative_to(root)} -> {dest.name}")
            if not a.dry_run:
                pkg.rename(dest)
    print(f"{changed} files; new names: {new}")


if __name__ == "__main__":
    main()
