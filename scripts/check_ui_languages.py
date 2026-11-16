#!/usr/bin/env python3
"""Look at the editor in every interface language.

For each language: open the editor, open a PDF, open the menus, a tool, the
settings, the shortcuts and the signature dialog; save a screenshot of each;
report text that overflows its control, interface text left untranslated,
and script errors. Then switch language live with a document open.

    python3 scripts/check_ui_languages.py http://127.0.0.1:8090 /path/to/sample.pdf OUT_DIR [WIDTH]

Needs: pip install playwright (and its Chromium).
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
LOCALES = ROOT / "gateway" / "app" / "static" / "locales"
sys.path.insert(0, str(Path(__file__).resolve().parent))
import i18n  # noqa: E402

LANGS = ["en", "de", "fr", "es", "ja", "ko", "zh-CN", "zh-TW"]
CJK = re.compile(r"[一-鿿]")

# Visible text nodes, and controls whose text does not fit.
PROBE = r"""
() => {
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && !el.closest("[hidden]");
  };
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const v = n.nodeValue.trim();
    if (!v || !visible(n.parentElement)) continue;
    if (n.parentElement.closest("kbd, code, .viewer-pages, .thumbnails, textarea, select, [data-no-i18n]")) continue;
    texts.push(v);
  }
  const attrs = [];
  for (const el of document.querySelectorAll("[title], [aria-label], [placeholder]")) {
    if (el.closest(".viewer-pages, .thumbnails, [data-no-i18n]")) continue;
    for (const a of ["title", "aria-label", "placeholder"]) {
      const v = el.getAttribute(a);
      if (v) attrs.push(v);
    }
  }
  const overflow = [];
  const sel = "button:not(.visually-hidden), .menu-item, .tool-label, .menu-text, legend, label, h1, h2, h3, .status-message, .tool-hint-text, .tab, dt, dd, .choice strong, .choice small";
  for (const el of document.querySelectorAll(sel)) {
    if (!visible(el) || el.classList.contains("visually-hidden") || el.closest(".status-message")) continue;
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== "visible") {
      overflow.push({ text: el.textContent.trim().slice(0, 60), cls: el.className, sw: el.scrollWidth, cw: el.clientWidth });
    }
  }
  const tb = document.querySelector(".toolbar");
  const tray = document.querySelector(".tool-tray");
  const toolbar = tb ? { sw: Math.max(tb.scrollWidth - tb.clientWidth, tray.scrollWidth - tray.clientWidth), cw: 0 } : null;
  return { texts, attrs, overflow, toolbar };
}
"""


def untranslated(lang: str, seen: list[str], catalogs: dict) -> list[str]:
    """Visible strings that are English catalog keys although this language translates them."""
    if lang == "en":
        return []
    cat = catalogs[lang]
    out = []
    for s in set(seen):
        v = cat.get(s)
        if isinstance(v, str) and v and v != s:
            out.append(s)
        if lang in ("en", "de", "fr", "es") and CJK.search(s):
            out.append(s)
    return sorted(out)


def main() -> int:
    base, pdf, out = sys.argv[1], sys.argv[2], Path(sys.argv[3])
    width = int(sys.argv[4]) if len(sys.argv) > 4 else 1280
    out.mkdir(parents=True, exist_ok=True)
    catalogs = dict(i18n.read_catalog(p) for p in LOCALES.glob("*.js"))
    report: dict = {}
    problems = 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for lang in LANGS:
            ctx = browser.new_context(viewport={"width": width, "height": 820}, locale="en-US")
            ctx.add_init_script(f"try {{ localStorage.setItem('openpdf_language', {json.dumps(lang)}); }} catch (e) {{}}")
            page = ctx.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda e, errors=errors: errors.append(str(e)))
            page.on("console", lambda m, errors=errors: errors.append(m.text) if m.type == "error" else None)
            page.goto(f"{base}/ui/index.html")
            page.wait_for_function("() => window.I18N && document.documentElement.lang")
            seen: list[str] = []
            overflow: list = []

            def snap(name: str) -> None:
                page.wait_for_timeout(250)
                page.screenshot(path=str(out / f"{lang}-{width}-{name}.png"))
                r = page.evaluate(PROBE)
                seen.extend(r["texts"] + r["attrs"])
                for o in r["overflow"]:
                    overflow.append({"where": name, **o})
                if r["toolbar"] and r["toolbar"]["sw"] > 1:
                    overflow.append({"where": name, "text": "TOOLBAR cut off by px", **r["toolbar"]})

            snap("1-welcome")
            page.set_input_files("#fileInput", pdf)
            page.wait_for_function("() => typeof state !== 'undefined' && state.docs[0] && state.docs[0].documentId", timeout=30000)
            page.wait_for_timeout(800)
            snap("2-document")
            page.click(".file-menu-btn")
            snap("3-file-menu")
            page.keyboard.press("Escape")
            page.click('[data-menu="toolsMenu"]')
            snap("4-tools-menu")
            page.keyboard.press("Escape")
            page.click('[data-menu="pageMenu"]')
            snap("5-page-menu")
            page.keyboard.press("Escape")
            page.click('[data-mode="highlight"]')
            snap("6-highlight-tool")
            page.keyboard.press("Escape")
            page.click('[data-mode="replace-text"]')
            snap("7-edit-text-tool")
            page.keyboard.press("Escape")
            page.click('[data-action="forms"]')
            snap("8-forms-panel")
            page.click('[data-action="forms"]')
            page.click("#settingsBtn")
            snap("9-settings")
            page.keyboard.press("Escape")
            page.evaluate("() => document.getElementById('helpDialog').showModal()")
            snap("10-shortcuts")
            page.keyboard.press("Escape")
            page.click('[data-mode="sign"]')
            snap("11-sign")
            page.keyboard.press("Escape")

            # Dynamic dialogs were previously outside the language/layout check.
            for action in ("rotate", "split", "encrypt", "unlock"):
                page.evaluate("(name) => { actions[name](); }", action)
                page.wait_for_selector("#toolDialog[open]")
                snap(f"dialog-{action}")
                page.click("#toolCancelBtn")
            page.evaluate("() => { offerOcrInstall(); }")
            page.wait_for_selector("#ocrInstallDialog[open]")
            snap("dialog-ocr-install")
            page.click('[data-ocr="cancel"]')
            page.evaluate("() => openPrintPreview()")
            page.wait_for_selector("#printDialog[open]")
            snap("dialog-print")
            page.click("#printCloseBtn")

            bad = untranslated(lang, seen, catalogs)
            report[lang] = {"untranslated": bad, "overflow": overflow, "errors": errors}
            problems += len(bad) + len(overflow) + len(errors)
            print(f"{lang} @{width}: {len(set(seen))} texts seen, {len(bad)} untranslated, "
                  f"{len(overflow)} overflowing, {len(errors)} script errors")
            for b in bad[:15]:
                print("   untranslated:", b)
            for o in overflow[:15]:
                print("   overflow:", o)
            for e in errors[:10]:
                print("   error:", e[:200])
            ctx.close()

        # live switch with a document open
        ctx = browser.new_context(viewport={"width": width, "height": 820}, locale="en-US")
        ctx.add_init_script("try { localStorage.setItem('openpdf_language', 'en'); } catch (e) {}")
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"{base}/ui/index.html")
        page.set_input_files("#fileInput", pdf)
        page.wait_for_function("() => typeof state !== 'undefined' && state.docs[0] && state.docs[0].documentId", timeout=30000)
        page.wait_for_timeout(1000)
        page.click('[data-mode="highlight"]')
        page.wait_for_function("() => state.editMode === 'highlight'", timeout=5000)
        page.evaluate("() => I18N.setLanguage('de')")
        page.wait_for_timeout(400)
        live = page.evaluate("""() => ({
          label: document.querySelector('[data-mode="highlight"] .tool-label').textContent,
          hint: document.getElementById('toolHintText').textContent,
          undo: document.querySelector('[data-action="undo"]').title,
          lang: document.documentElement.lang,
          stored: localStorage.getItem('openpdf_language'),
        })""")
        page.screenshot(path=str(out / f"live-switch-de-{width}.png"))
        de = catalogs["de"]
        ok = (live["label"] == de.get("Highlight") and live["lang"] == "de" and live["stored"] == "de"
              and live["hint"] and "drag" not in live["hint"].lower())
        print("live switch en -> de:", "PASS" if ok and not errors else "FAIL", json.dumps(live, ensure_ascii=False), errors[:3])
        problems += 0 if ok and not errors else 1
        ctx.close()
        browser.close()
    (out / f"report-{width}.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
