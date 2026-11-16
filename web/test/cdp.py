"""Drive headless Chrome over the DevTools protocol (no Playwright needed)."""
import itertools
import json
import shutil
import subprocess
import tempfile
import time
import urllib.request

import websocket


class Chrome:
    def __init__(self, port=9341):
        self.profile = tempfile.mkdtemp(prefix="openpdf-web-test-")
        self.proc = subprocess.Popen(
            ["google-chrome", "--headless=new", "--no-sandbox", "--disable-gpu", f"--user-data-dir={self.profile}",
             f"--remote-debugging-port={port}", "--no-first-run", "--window-size=1400,1000", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json"))
                page = next(t for t in tabs if t["type"] == "page")
                break
            except Exception:
                time.sleep(0.1)
        self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=120, suppress_origin=True)
        self.ids = itertools.count(1)
        self.events = []
        self.cdp("Page.enable")
        self.cdp("Runtime.enable")
        self.cdp("Log.enable")
        # workers are targets of their own: attach to them to see their requests too
        self.cdp("Target.setAutoAttach", autoAttach=True, waitForDebuggerOnStart=False, flatten=True)

    def cdp(self, method, session=None, **params):
        i = next(self.ids)
        message = {"id": i, "method": method, "params": params}
        if session:
            message["sessionId"] = session
        self.ws.send(json.dumps(message))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == i:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})
            self.events.append(msg)
            if msg.get("method") == "Target.attachedToTarget":
                child = msg["params"]["sessionId"]
                for m in ("Network.enable", "Log.enable"):
                    self.ws.send(json.dumps({"id": next(self.ids), "method": m, "params": {}, "sessionId": child}))

    def js(self, expr):
        r = self.cdp("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True)
        if "exceptionDetails" in r:
            d = r["exceptionDetails"]
            raise RuntimeError(d.get("exception", {}).get("description") or d.get("text"))
        return r["result"].get("value")

    def wait_for(self, expr, timeout=30):
        end = time.time() + timeout
        last = None
        while time.time() < end:
            try:
                value = self.js(expr)
                if value:
                    return value
            except RuntimeError as exc:
                last = exc
            time.sleep(0.25)
        return None

    def goto(self, url):
        self.cdp("Page.navigate", url=url)
        time.sleep(0.5)
        self.wait_for("document.readyState === 'complete'")

    def errors(self):
        out = []
        for e in self.events:
            if e.get("method") == "Log.entryAdded" and e["params"]["entry"]["level"] == "error":
                out.append(e["params"]["entry"]["text"])
            if e.get("method") == "Runtime.exceptionThrown":
                out.append(e["params"]["exceptionDetails"].get("exception", {}).get("description", "exception"))
        return out

    def close(self):
        self.proc.terminate()
        self.proc.wait(5)
        shutil.rmtree(self.profile, ignore_errors=True)
