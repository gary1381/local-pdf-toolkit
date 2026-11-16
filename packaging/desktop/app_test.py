#!/usr/bin/env python3
"""Test an installed (or freshly built) desktop app on Windows or macOS.

1. Start the app with OPENPDF_SELFTEST: it starts its bundled services,
   writes what the gateway reports once they are ready, and quits. Check the
   report, and that no service is left running after the app is gone.
2. Start the app again, wait for its services, then kill the app the hard way
   (as a crash would). Each service watches the app's process id
   (OPENPDF_PARENT_PID) and must stop by itself within a few seconds.

    python packaging/desktop/app_test.py PATH_TO_APP_PROGRAM

Needs: pip install psutil
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import psutil

SERVICE_NAMES = {"openpdf-server", "openpdf-server.exe", "java", "java.exe", "openpdf-ocr", "openpdf-ocr.exe"}


def services_of(app_dir: Path) -> list[psutil.Process]:
    """Our services: programs with the names above, running from inside the app."""
    found = []
    for proc in psutil.process_iter(["name", "exe"]):
        try:
            exe = proc.info["exe"] or ""
            if proc.info["name"] in SERVICE_NAMES and str(app_dir).lower() in exe.lower():
                found.append(proc)
        except (psutil.Error, OSError):
            pass
    return found


def wait_until(test, seconds: float) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        if test():
            return True
        time.sleep(0.5)
    return test()


def main() -> int:
    program = Path(sys.argv[1]).resolve()
    # the services live next to the app's resources; on macOS inside the .app
    app_dir = program.parents[1] if sys.platform == "darwin" else program.parent
    results = []

    def check(ok: bool, what: str) -> None:
        results.append(ok)
        print(f"{'PASS' if ok else 'FAIL'} {what}", flush=True)

    # 1. self-test run: starts, reports, quits, cleans up
    report = Path(tempfile.mkdtemp()) / "selftest.json"
    started = time.time()
    proc = subprocess.Popen([str(program)], env=dict(os.environ, OPENPDF_SELFTEST=str(report)))
    try:
        proc.wait(timeout=360)  # the app gives its services up to 300 s
    except subprocess.TimeoutExpired:
        proc.kill()
    text = report.read_text() if report.exists() else ""
    print("report:", text.strip())
    try:
        ready = json.loads(text).get("ready", {})
    except ValueError:
        ready = {}
    check(isinstance(ready, dict) and ready.get("pdfbox") is True and ready.get("qpdf") is True,
          f"app starts its services (in {time.time() - started:.0f} s)")
    check(wait_until(lambda: not services_of(app_dir), 15), "no service left running after the app quit")

    # 2. crash: the services must notice and stop
    proc = subprocess.Popen([str(program)])
    up = wait_until(lambda: len(services_of(app_dir)) >= 3, 120)
    check(up, f"services running: {[p.info['name'] for p in services_of(app_dir)]}")
    if up:
        time.sleep(3)
        proc.kill()  # TerminateProcess / SIGKILL: no chance to clean up
        proc.wait(timeout=30)
        gone = wait_until(lambda: not services_of(app_dir), 20)
        check(gone, f"services stop by themselves after the app was killed "
                    f"(left: {[p.info['name'] for p in services_of(app_dir)]})")
        for p in services_of(app_dir):
            p.kill()
    else:
        proc.kill()
    print(f"\n{sum(results)}/{len(results)} passed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
