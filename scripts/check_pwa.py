#!/usr/bin/env python3
"""Browser check of the editor installed as an app (PWA), in Chrome.

Usage: python scripts/check_pwa.py PDF [PDFBOX_URL QPDF_URL]
Run with the gateway's Python (it starts the gateway with `-m uvicorn`).
PDFBOX_URL / QPDF_URL default to the dev stack (engine/tools/devstack.sh).
Needs google-chrome and websocket-client; talks to Chrome over the DevTools
protocol.

Starts a gateway of its own on port 28190, then checks: the manifest (a .pdf
file handler) and that Chrome finds the app installable; the service worker;
with the gateway stopped, the "isn't running" page, which keeps a file the app
was opened with; with the gateway back, the switch to the editor, which opens
that file; and that Save after a change writes back to the file itself (a file
in the origin-private file system stands in for one opened from the system).
"""
import base64
import itertools
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

import websocket

import os
from pathlib import Path

GATEWAY_DIR = Path(__file__).resolve().parent.parent / "gateway"
PDF = sys.argv[1]
PDFBOX_URL = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:28092"
QPDF_URL = sys.argv[3] if len(sys.argv) > 3 else "http://127.0.0.1:28093"
BASE = "http://127.0.0.1:28190"
sessions = tempfile.mkdtemp(prefix="pwa-sessions-")
gateway = None


def start_gateway():
    global gateway
    env = dict(os.environ, PDFBOX_URL=PDFBOX_URL, QPDF_URL=QPDF_URL, SESSION_DIR=sessions,
               ALLOWED_HOSTS="127.0.0.1,localhost", API_KEY="")
    gateway = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
                                "--port", "28190"], cwd=GATEWAY_DIR, env=env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        try:
            urllib.request.urlopen(f"{BASE}/health", timeout=1)
            return
        except Exception:
            time.sleep(0.2)


def stop_gateway():
    gateway.terminate()
    gateway.wait(10)


start_gateway()
PORT = 9339
profile = tempfile.mkdtemp(prefix="pwa-test-")
chrome = subprocess.Popen(
    ["google-chrome", "--headless=new", "--no-sandbox", "--disable-gpu", f"--user-data-dir={profile}",
     f"--remote-debugging-port={PORT}", "--no-first-run", "about:blank"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
results = []


def record(name, ok, detail=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'} {name}{': ' + str(detail)[:300] if detail != '' else ''}", flush=True)


try:
    for _ in range(50):
        try:
            tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
            page = next(t for t in tabs if t["type"] == "page")
            break
        except Exception:
            time.sleep(0.2)
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60, suppress_origin=True)
    ids = itertools.count(1)
    events = []

    def cdp(method, **params):
        i = next(ids)
        ws.send(json.dumps({"id": i, "method": method, "params": params}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == i:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})
            events.append(msg)

    def js(expr):
        r = cdp("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True)
        if "exceptionDetails" in r:
            raise RuntimeError(r["exceptionDetails"].get("exception", {}).get("description") or r["exceptionDetails"])
        return r["result"].get("value")

    def wait_for(expr, timeout=30):
        end = time.time() + timeout
        while time.time() < end:
            try:
                v = js(expr)
                if v:
                    return v
            except RuntimeError:
                pass
            time.sleep(0.3)
        return None

    def goto(url):
        cdp("Page.navigate", url=url)
        time.sleep(1.0)
        wait_for("document.readyState === 'complete'")

    cdp("Page.enable")
    cdp("Runtime.enable")
    cdp("Log.enable")
    goto(f"{BASE}/ui/index.html")

    m = cdp("Page.getAppManifest")
    manifest = json.loads(m.get("data") or "{}")
    record("manifest parsed without errors", not m.get("errors") and manifest.get("name") == "OpenPDF",
           m.get("errors") or m.get("url"))
    fh = manifest.get("file_handlers", [{}])[0]
    record("manifest declares .pdf file handler", fh.get("accept", {}).get("application/pdf") == [".pdf"], fh)
    try:
        inst = cdp("Page.getInstallabilityErrors")
        errs = [e["errorId"] for e in inst.get("installabilityErrors", [])]
        record("installable (no installability errors)", not errs, errs)
    except RuntimeError as exc:
        record("installable (no installability errors)", False, exc)

    reg = wait_for("navigator.serviceWorker.getRegistration('/ui/').then(r => !!(r && r.active))", 20)
    record("service worker active", bool(reg))
    record("launchQueue available", js("'launchQueue' in window"))
    record("desktop-only menu item hidden in Chrome",
           js("document.querySelector('[data-action=openInBrowser]').hidden === true"))

    # ---- a file the app was "opened with": a handle in the origin-private file system
    pdf_b64 = base64.b64encode(open(PDF, "rb").read()).decode()
    js(f"""(async () => {{
      const root = await navigator.storage.getDirectory();
      const h = await root.getFileHandle('launched.pdf', {{create: true}});
      const w = await h.createWritable();
      await w.write(Uint8Array.from(atob('{pdf_b64}'), c => c.charCodeAt(0)));
      await w.close();
      window.__testHandle = h;
      return true;
    }})()""")
    original_size = js("window.__testHandle.getFile().then(f => f.size)")

    # ---- services down: the offline page instead of Chrome's error page
    stop_gateway()
    goto(f"{BASE}/ui/index.html")
    title = wait_for("document.getElementById('title')?.textContent", 10)
    record("offline page shown when services are down", title and "isn't running" in title, title)
    # keep the launched file as offline.js does with launchQueue files
    js("""(async () => {
      const root = await navigator.storage.getDirectory();
      const h = await root.getFileHandle('launched.pdf');
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('openpdf-launch', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('pending', {autoIncrement: true});
        req.onsuccess = () => { const tx = req.result.transaction('pending', 'readwrite');
          tx.objectStore('pending').add({handle: h, at: Date.now()}); tx.oncomplete = resolve; tx.onerror = reject; };
      });
      return true;
    })()""")
    start_gateway()
    back = wait_for("location.pathname === '/ui/index.html' && !!document.getElementById('app')", 20)
    record("offline page switches to the editor when services return", bool(back))

    opened = wait_for("document.querySelector('.tab-title') && "
                      "[...document.querySelectorAll('.tab-title')].map(t => t.textContent).join('|')", 30)
    record("kept file opens in the editor", opened and "launched" in opened, opened)
    record("pending list emptied", js("""new Promise(r => { const q = indexedDB.open('openpdf-launch', 1);
      q.onsuccess = () => { const g = q.result.transaction('pending').objectStore('pending').count();
      g.onsuccess = () => r(g.result === 0); }; })"""))

    # ---- write back: change the document (rotate page 1), Save, read the original file again
    has_handle = wait_for("typeof activeDoc === 'function' && activeDoc() && !!activeDoc().fileHandle"
                          " && !!activeDoc().documentId", 30)
    record("document keeps its file handle", bool(has_handle))
    js("navigator.storage.getDirectory().then(r => r.getFileHandle('launched.pdf')).then(h => (window.__testHandle = h, true))")
    js("runPageAction('rotate-cw', 1)")
    wait_for("activeDoc().serverRevision > 1", 30)
    js("actions.save()")
    saved = wait_for("window.__testHandle.getFile().then(f => f.size !== %d || f.lastModified > Date.now() - 20000)"
                     % original_size, 30)
    rotated = js("""window.__testHandle.getFile().then(f => f.arrayBuffer())
      .then(b => pdfjsLib.getDocument({data: b}).promise).then(d => d.getPage(1)).then(p => p.rotate === 90)""")
    record("Save writes back to the opened file", bool(saved) and rotated,
           f"size {original_size} -> {js('window.__testHandle.getFile().then(f => f.size)')}, rotated={rotated}")

    errors = [e["params"]["entry"]["text"] for e in events
              if e.get("method") == "Log.entryAdded" and e["params"]["entry"]["level"] == "error"
              and "ERR_CONNECTION_REFUSED" not in e["params"]["entry"]["text"]]
    record("no console errors (besides the simulated outage)", not errors, errors[:3])
finally:
    if gateway and gateway.poll() is None:
        stop_gateway()
    shutil.rmtree(sessions, ignore_errors=True)
    chrome.terminate()
    chrome.wait(5)
    shutil.rmtree(profile, ignore_errors=True)

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
