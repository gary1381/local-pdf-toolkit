"""Score the converted outputs with olmOCR-Bench and write the comparison.

    python score.py BENCH_DATA SYSTEM [SYSTEM ...]
    python score.py BENCH_DATA --sample SYSTEM [SYSTEM ...]

--sample: for systems run on part of the pages (convert.py --sample): the pass
rate per category over the tests of the converted pages only, printed, not
written to results.json.

Runs olmOCR-Bench's own scorer (olmocr.bench.benchmark) for each system, keeps
its log in BENCH_DATA/SYSTEM/_score.log, and writes results.json and RESULTS.md
here: the score per category (the benchmark's JSONL files), the overall score
(the average of the categories, as the benchmark computes it) with its 95%
interval, and seconds per page from convert.py's timing.
"""
import json
import re
import statistics
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
CATEGORIES = [
    ("arxiv_math", "ArXiv math"),
    ("old_scans_math", "Old scans: math"),
    ("table_tests", "Tables"),
    ("old_scans", "Old scans"),
    ("headers_footers", "Headers / footers"),
    ("multi_column", "Multi-column"),
    ("long_tiny_text", "Long tiny text"),
    ("baseline", "Base"),
]


def blank_to_empty(folder):
    """A page whose output is only whitespace becomes an empty file: olmocr 0.4.27's
    "present" check passes on whitespace-only output (but not on an empty one),
    which would credit a system for pages it returned nothing for."""
    changed = 0
    for md in folder.rglob("*.md"):
        text = md.read_text(encoding="utf-8")
        if text and not text.strip():
            md.write_text("", encoding="utf-8")
            changed += 1
    return changed


def score(bench, system):
    blanked = blank_to_empty(bench / system)
    log = bench / system / "_score.log"
    run = subprocess.run(
        [sys.executable, "-m", "olmocr.bench.benchmark", "--dir", str(bench), "--candidate", system, "--force"],
        capture_output=True, text=True, cwd=bench,
    )
    log.write_text(run.stdout + run.stderr)
    out = run.stdout
    summary = out[out.rfind("Final Summary"):] if "Final Summary" in out else out
    overall = re.search(rf"{re.escape(system)}\s*:\s*Average Score:\s*([\d.]+)%\s*(?:±\s*([\d.]+)%)?", summary)
    per = {}
    for name, rate, passed, total in re.findall(r"^\s+(\S+?)(?:\.jsonl)?\s*:\s*([\d.]+)% \((\d+)/(\d+) tests\)", summary, re.M):
        per[name.replace(".jsonl", "")] = {"rate": float(rate), "passed": int(passed), "total": int(total)}
    timing = json.loads((bench / system / "_timing.json").read_text()) if (bench / system / "_timing.json").exists() else {}
    secs = [v["seconds"] / max(1, v["pages"]) for v in timing.values()]
    failures = (bench / system / "_failures.txt")
    return {
        "overall": float(overall.group(1)) if overall else None,
        "ci": float(overall.group(2)) if overall and overall.group(2) else None,
        "categories": per,
        "seconds_per_page": round(statistics.median(secs), 2) if secs else None,
        "failed_conversions": len([l for l in failures.read_text().splitlines() if l.strip()]) if failures.exists() else 0,
        "blank_pages_emptied": blanked,
    }


def sample_rates(bench, system):
    """Pass rate per category over the tests of the pages this system converted."""
    folder = bench / system
    done = {str(md.relative_to(folder)).split("_pg1_repeat")[0] for md in folder.rglob("*_pg1_repeat1.md")}
    # the scorer evaluates nothing while pages are missing: empty stand-ins, left out below
    stand_ins = []
    for pdf in (bench / "pdfs").rglob("*.pdf"):
        md = folder / pdf.relative_to(bench / "pdfs").with_suffix("").parent / f"{pdf.stem}_pg1_repeat1.md"
        if not md.exists():
            md.parent.mkdir(parents=True, exist_ok=True)
            md.write_text("", encoding="utf-8")
            stand_ins.append(md)
    try:
        score(bench, system)
    finally:
        for md in stand_ins:
            md.unlink()
    failed = set(re.findall(r"\[FAIL\] Test (\S+) on ", (folder / "_score.log").read_text()))
    out = {}
    for jsonl in sorted(bench.glob("*.jsonl")):
        tests = [json.loads(line) for line in jsonl.read_text().splitlines() if line.strip()]
        mine = [t for t in tests if t["pdf"].removesuffix(".pdf") in done]
        if mine:
            passed = sum(1 for t in mine if t["id"] not in failed)
            out[jsonl.stem] = {"rate": round(100 * passed / len(mine), 1), "passed": passed, "total": len(mine),
                               "pages": len({t["pdf"] for t in mine})}
    return out


def main():
    bench = Path(sys.argv[1])
    systems = sys.argv[2:]
    if systems and systems[0] == "--sample":
        for system in systems[1:]:
            print(system, json.dumps(sample_rates(bench, system)), flush=True)
        return
    path = HERE / "results.json"
    results = json.loads(path.read_text()) if path.exists() else {}
    for system in systems:
        print(f"scoring {system}…", flush=True)
        results[system] = score(bench, system)
        print(f"  {results[system]['overall']}%", flush=True)
    path.write_text(json.dumps(results, indent=1))

    head = "| System | " + " | ".join(label for _, label in CATEGORIES) + " | Overall | s/page |"
    rows = [head, "|---|" + "---|" * (len(CATEGORIES) + 2)]
    for system, r in sorted(results.items(), key=lambda kv: -(kv[1]["overall"] or 0)):
        cells = [f"{r['categories'][key]['rate']:.1f}" if key in r["categories"] else "–" for key, _ in CATEGORIES]
        overall = f"**{r['overall']:.1f}**" + (f" ± {r['ci']:.1f}" if r.get("ci") else "") if r["overall"] is not None else "–"
        rows.append(f"| {system} | " + " | ".join(cells) + f" | {overall} | {r['seconds_per_page'] or '–'} |")
    (HERE / "RESULTS.md").write_text("# olmOCR-Bench results\n\n"
        "s/page: median wall time per page on a shared machine (load varies between runs, so only runs\n"
        "made together compare). All on the CPU only, except openpdf-markdown-model: its model ran on the\n"
        "GPU (RTX 3060), the rest of its work on the CPU.\n\n" + "\n".join(rows) + "\n")
    print("\n".join(rows))


if __name__ == "__main__":
    main()
