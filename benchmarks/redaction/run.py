"""Run every redaction tool on every case and check the results.

    python run.py OUT_DIR [tool ...]     (default: all tools)

Writes OUT_DIR/corpus/ (the test documents), OUT_DIR/<tool>/<case>.pdf (what
each tool produced), OUT_DIR/results.json and OUT_DIR/report.md.
"""
import json
import sys
import time
import traceback
from pathlib import Path

import check
import corpus
import tools


def verdict(res):
    if res["status"] != "ok":
        return res["status"]
    if res["check"]["leaks"]:
        return "leak"
    if res["check"]["partial"]:
        return "partial"
    return "clean"


def main():
    out = Path(sys.argv[1])
    wanted = set(sys.argv[2:])
    corpus_dir = out / "corpus"
    if corpus_dir.exists():
        for f in corpus_dir.iterdir():
            f.unlink()
    sys.argv = ["corpus.py", str(corpus_dir)]
    corpus.main()
    cases = json.loads((corpus_dir / "cases.json").read_text())
    # how many of the words to keep are text in the original (scanned pages: none)
    # and the checks must find every secret in the unredacted documents
    for case in cases:
        before = check.check(corpus_dir / f"{case['id']}.pdf", case)
        found = {l["secret"] for l in before["leaks"]}
        if found != set(case["secrets"]) or before["keep_found"] != before["keep_total"]:
            raise SystemExit(f"the checks miss something in the unredacted {case['id']}.pdf: {before}")
        case["keep_as_text_before"] = before["keep_as_text"]
    selected = [t for t in tools.ALL if not wanted or t.key in wanted]
    results = {"cases": cases, "tools": [], "runs": {}}
    try:
        for tool in selected:
            try:
                version = tool.version()
            except Exception as exc:  # noqa: BLE001
                version = f"? ({exc})"
            results["tools"].append({"key": tool.key, "label": tool.label, "version": version})
            (out / tool.key).mkdir(parents=True, exist_ok=True)
            for case in cases:
                src = corpus_dir / f"{case['id']}.pdf"
                dst = out / tool.key / f"{case['id']}.pdf"
                dst.unlink(missing_ok=True)
                mode_ok = (case["terms"] and tool.terms) or (case["regions"] and tool.regions)
                if not mode_ok:
                    res = {"status": "n/a", "note": "the tool cannot be asked this way"}
                else:
                    t0 = time.time()
                    try:
                        res = tool.run(src, case, dst)
                    except Exception as exc:  # noqa: BLE001
                        res = {"status": "error", "note": f"{type(exc).__name__}: {exc}"[:500]}
                        traceback.print_exc()
                    res["seconds"] = round(time.time() - t0, 2)
                    res.pop("report", None)
                    if res["status"] == "ok":
                        res["check"] = check.check(dst, case)
                res["verdict"] = verdict(res)
                results["runs"].setdefault(tool.key, {})[case["id"]] = res
                where = ""
                if res.get("check", {}).get("leaks"):
                    where = "; ".join(f"{l['secret']}: {', '.join(l['found_by'] + l['where'])}" for l in res["check"]["leaks"])
                print(f"{tool.key:16} {case['id']:13} {res['verdict']:8} {where or res.get('note', '')}"[:220], flush=True)
    finally:
        tools.OpenPdfBrowser.close()
        tools.PdfCraft.close()
    (out / "results.json").write_text(json.dumps(results, indent=1, ensure_ascii=False))
    (out / "report.md").write_text(report(results))
    print(f"\n{out / 'report.md'}")


MARK = {"clean": "✅", "leak": "❌", "partial": "⚠️", "refused": "⛔", "error": "💥", "n/a": "–"}


def report(results):
    tools_ = results["tools"]
    lines = ["# Redaction comparison", "",
             "✅ nothing of the secret found · ❌ the secret can still be read (where) · ⚠️ part of it left ·",
             "⛔ the tool refused and said why · 💥 the tool failed · – the tool can't be asked this way.",
             "Below each mark: share of the words that should survive that are still there.", ""]
    lines.append("| Case | " + " | ".join(t["label"] for t in tools_) + " |")
    lines.append("|---|" + "---|" * len(tools_))
    for case in results["cases"]:
        row = [f"**{case['title']}**<br><sub>{case['where']}</sub>"]
        for t in tools_:
            r = results["runs"][t["key"]][case["id"]]
            cell = MARK[r["verdict"]]
            c = r.get("check")
            if c:
                if c["leaks"]:
                    places = sorted({p for l in c["leaks"] for p in l["where"]} | {f for l in c["leaks"] for f in l["found_by"] if f != "objects"})
                    cell += "<br><sub>" + ", ".join(places) + "</sub>"
                cell += f"<br><sub>kept {c['keep_found']}/{c['keep_total']}</sub>"
                if case["keep_as_text_before"] and c["keep_as_text"] < case["keep_as_text_before"]:
                    cell += f"<br><sub>still text {c['keep_as_text']}/{case['keep_as_text_before']}</sub>"
            row.append(cell)
        lines.append("| " + " | ".join(row) + " |")
    lines += ["", "## Totals", "",
              "*Words kept*: the words that should survive, still readable (as text, or by OCR of a picture).",
              "*Still text*: of those that were text, how many still are (searchable, selectable); pages turned into pictures lose them.", "",
              "| Tool | Version | Clean | Leaks | Partly | Refused | Failed | Words kept | Still text |", "|---|---|---|---|---|---|---|---|---|"]
    before = {c["id"]: c["keep_as_text_before"] for c in results["cases"]}
    for t in tools_:
        runs = results["runs"][t["key"]].values()
        count = lambda v: sum(1 for r in runs if r["verdict"] == v)  # noqa: E731
        checked = [(cid, r["check"]) for cid, r in results["runs"][t["key"]].items() if r.get("check")]
        kept = sum(c["keep_found"] for _, c in checked)
        total = sum(c["keep_total"] for _, c in checked)
        text_kept = sum(min(c["keep_as_text"], before[cid]) for cid, c in checked)
        text_total = sum(before[cid] for cid, _ in checked)
        pct = lambda a, b: f"{100 * a / b:.0f}%" if b else "-"  # noqa: E731
        lines.append(f"| {t['label']} | {t['version']} | {count('clean')} | {count('leak')} | {count('partial')} | {count('refused')} | {count('error')} | "
                     f"{pct(kept, total)} | {pct(text_kept, text_total)} |")
    notes = [(t["label"], cid, r["note"]) for t in tools_ for cid, r in results["runs"][t["key"]].items()
             if r["verdict"] in ("refused", "error") and r.get("note")]
    if notes:
        lines += ["", "## Refusals and failures", ""] + [f"- {label}, {cid}: {note}" for label, cid, note in notes]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    main()
