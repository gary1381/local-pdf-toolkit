#!/usr/bin/env python3
"""Interface translations: collect the English texts and check the catalogs.

The web interface is written in English (gateway/app/static: index.html and the
scripts, through t / tn / tc / N_ from i18n.js). Each other language is
gateway/app/static/locales/<code>.js:

    I18N.register("de", {
      "Open…": "Öffnen…",
      "{n} page": {"one": "{n} Seite", "other": "{n} Seiten"},
    });

    python3 scripts/i18n.py check          missing / unused entries, placeholder errors
    python3 scripts/i18n.py sync           add missing keys (empty = English for now),
                                           drop unused ones, order as in the source
    python3 scripts/i18n.py keys           the English texts, one JSON object per line
"""
from __future__ import annotations

import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "gateway" / "app" / "static"
LOCALES = STATIC / "locales"
SCRIPTS = ["app.js", "signature.js", "offline.js"]
CTX = "\u0004"
# Text in index.html that is not words to translate (font names).
HTML_IGNORE = {"Helvetica", "Times New Roman", "Courier New", "Arial"}
ATTRS = {"title", "aria-label", "placeholder", "alt", "data-drop-label"}
SKIP_TAGS = {"script", "style", "kbd", "code", "textarea", "title"}  # <title> is the product name
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
STR = r'"((?:[^"\\\n]|\\.)*)"'
PLURAL_FORMS = {"zero", "one", "two", "few", "many", "other"}


def js_keys(path: Path) -> list[tuple[str, dict]]:
    src = path.read_text(encoding="utf-8")
    out = []
    for m in re.finditer(r"(?<![\w.$])(t|tn|tc|N_)\(", src):
        fn, rest = m.group(1), src[m.end():]
        if fn == "tn":
            hit = re.match(rf"\s*[^,]+?,\s*{STR}\s*,\s*{STR}", rest)
        elif fn == "tc":
            hit = re.match(rf"\s*{STR}\s*,\s*{STR}", rest)
        else:
            hit = re.match(rf"\s*{STR}", rest)
        if not hit:
            continue  # t(variable): the text is collected where it is marked with N_
        dec = lambda s: json.loads(f'"{s}"')  # noqa: E731
        line = src.count("\n", 0, m.start()) + 1
        where = f"{path.name}:{line}"
        if fn == "tn":
            out.append((dec(hit.group(1)), {"plural": dec(hit.group(2)), "where": where}))
        elif fn == "tc":
            out.append((dec(hit.group(1)) + CTX + dec(hit.group(2)), {"context": dec(hit.group(1)), "where": where}))
        else:
            out.append((dec(hit.group(1)), {"where": where}))
    return out


class _Html(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, bool]] = []
        self.found: list[tuple[str, dict]] = []

    def _skipping(self) -> bool:
        return any(skip for _, skip in self.stack)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        skip = tag in SKIP_TAGS or "data-no-i18n" in a
        if not self._skipping() and "data-no-i18n" not in a:  # attributes count even on <textarea>
            for name, value in attrs:
                if name in ATTRS and value and value.strip():
                    self._add(value.strip())
        if tag not in VOID:
            self.stack.append((tag, skip))

    def handle_endtag(self, tag):
        while self.stack:
            if self.stack.pop()[0] == tag:
                break

    def handle_data(self, data):
        text = data.strip()
        if text and not self._skipping():
            self._add(text)

    def _add(self, text: str) -> None:
        if text in HTML_IGNORE or not re.search(r"[A-Za-z]", text):
            return
        self.found.append((text, {"where": f"index.html:{self.getpos()[0]}"}))


def all_keys() -> dict[str, dict]:
    parser = _Html()
    parser.feed((STATIC / "index.html").read_text(encoding="utf-8"))
    keys: dict[str, dict] = {}
    for key, info in parser.found + [k for s in SCRIPTS for k in js_keys(STATIC / s)]:
        if key in keys:
            keys[key].setdefault("also", []).append(info["where"])
        else:
            keys[key] = info
    return keys


def read_catalog(path: Path) -> tuple[str, dict]:
    text = path.read_text(encoding="utf-8")
    m = re.match(r'\s*(?://[^\n]*\n|/\*.*?\*/\s*)*\s*I18N\.register\("([\w-]+)",\s*(\{.*\})\s*\);\s*$', text, re.S)
    if not m:
        raise SystemExit(f"{path}: not in the form I18N.register(\"xx\", {{...}});")
    return m.group(1), json.loads(m.group(2))


def write_catalog(path: Path, code: str, entries: dict) -> None:
    body = json.dumps(entries, ensure_ascii=False, indent=2)
    path.write_text(
        f"// {code} interface texts: English (as written in the code) -> translation.\n"
        "// Generated layout: edit the values; run scripts/i18n.py sync after changing the code.\n"
        f'I18N.register("{code}", {body});\n',
        encoding="utf-8",
    )


def placeholders(s: str) -> set[str]:
    return set(re.findall(r"\{(\w+)\}", s))


def check() -> int:
    keys = all_keys()
    problems = 0
    for path in sorted(LOCALES.glob("*.js")):
        code, cat = read_catalog(path)
        missing = [k for k in keys if k not in cat or cat[k] in ("", None)]
        unused = [k for k in cat if k not in keys]
        bad = []
        for k, v in cat.items():
            info = keys.get(k)
            if info is None or v in ("", None):
                continue
            source = k.split(CTX)[-1]
            if "plural" in info:
                want = placeholders(source) | placeholders(info["plural"])
                if isinstance(v, str):
                    forms = {"other": v}
                elif isinstance(v, dict) and "other" in v and set(v) <= PLURAL_FORMS:
                    forms = v
                else:
                    bad.append(f"{k!r}: plural needs {{other, ...}}")
                    continue
                for form, s in forms.items():
                    extra = placeholders(s) - want
                    if extra:
                        bad.append(f"{k!r} [{form}]: unknown placeholder(s) {sorted(extra)}")
                if "n" in want and "n" not in placeholders(forms["other"]):
                    bad.append(f"{k!r}: the 'other' form must contain {{n}}")
            elif not isinstance(v, str):
                bad.append(f"{k!r}: expected a string")
            elif placeholders(v) != placeholders(source):
                bad.append(f"{k!r}: placeholders {sorted(placeholders(v))} != {sorted(placeholders(source))}")
        print(f"{code}: {len(keys) - len(missing)}/{len(keys)} translated, {len(missing)} missing, "
              f"{len(unused)} unused, {len(bad)} errors")
        for k in missing[:20]:
            print(f"   missing: {k!r}  ({keys[k]['where']})")
        if len(missing) > 20:
            print(f"   ... and {len(missing) - 20} more")
        for k in unused:
            print(f"   unused: {k!r}")
        for b in bad:
            print(f"   error: {b}")
        problems += len(missing) + len(bad) + len(unused)
    return 1 if problems else 0


def sync() -> None:
    keys = all_keys()
    for path in sorted(LOCALES.glob("*.js")):
        code, cat = read_catalog(path)
        write_catalog(path, code, {k: cat.get(k, "") for k in keys})
        print(f"{code}: {len(keys)} entries")


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd == "check":
        return check()
    if cmd == "sync":
        sync()
        return 0
    if cmd == "keys":
        for k, info in all_keys().items():
            print(json.dumps({"key": k, **info}, ensure_ascii=False))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
