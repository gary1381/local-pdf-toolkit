#!/usr/bin/env python3
"""Check the browser version of the editor (web/dist) in headless Chrome.

Usage: python web/test/check_web.py BASE FIXTURES
BASE: where web/dist is served (e.g. http://127.0.0.1:28300).
FIXTURES: made by engine/tests/make_fixtures.py.

Opens fixtures in the real editor and drives it through its own functions;
every request the editor makes is answered inside the page (no server).
Checks the results by reading the session's PDF back with pdf.js.
"""
import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from cdp import Chrome  # noqa: E402

BASE, FIXTURES = sys.argv[1].rstrip("/"), Path(sys.argv[2])
results = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'} {name}{': ' + str(detail)[:300] if detail not in ('', None) else ''}", flush=True)


HELPERS = """
window.__t = {
  async open(b64, name) {
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    await openFile(new File([bin], name, { type: 'application/pdf' }));
    await new Promise(r => { const tick = () => activeDoc()?.documentId ? r() : setTimeout(tick, 100); tick(); });
    return activeDoc().documentId;
  },
  async current() {
    const doc = activeDoc();
    const blob = await downloadDocumentBlob(doc);
    const pdf = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const p = await pdf.getPage(i);
      const text = (await p.getTextContent()).items.map(it => it.str).join(' ');
      const annots = (await p.getAnnotations()).map(a => a.subtype);
      pages.push({ rotate: p.rotate, text, annots });
    }
    return { revision: doc.serverRevision, pages };
  },
};
true
"""


def b64(name):
    return base64.b64encode((FIXTURES / name).read_bytes()).decode()


chrome = Chrome()
try:
    chrome.cdp("Network.enable")
    chrome.goto(f"{BASE}/ui/index.html")
    check("editor loads in browser mode", chrome.wait_for("window.__OPENPDF_WEB === true && typeof openFile === 'function'"))
    health = chrome.js("fetch('/health').then(r => r.json())")
    check("services answer in the page", health.get("mode") == "browser", health)
    chrome.js(HELPERS)

    doc_id = chrome.js(f"__t.open('{b64('contract.pdf')}', 'contract.pdf')")
    check("register: the editor gets a session", bool(doc_id), doc_id)
    state = chrome.js("__t.current()")
    check("session copy reads back", len(state["pages"]) == 2 and "Services Agreement" in state["pages"][0]["text"])

    chrome.js("runPageAction('rotate-cw', 1)")
    chrome.wait_for("activeDoc().serverRevision >= 2")
    state = chrome.js("__t.current()")
    check("rotate page 1", state["pages"][0]["rotate"] == 90 and state["pages"][1]["rotate"] == 90,
          [p["rotate"] for p in state["pages"]])

    chrome.js("runPageAction('move-down', 1)")
    chrome.wait_for("activeDoc().serverRevision >= 3")
    state = chrome.js("__t.current()")
    check("move page 1 down", "Schedule A" in state["pages"][0]["text"] and "Services Agreement" in state["pages"][1]["text"])

    chrome.js("undoLastStep()")
    chrome.wait_for("activeDoc().serverRevision >= 4")
    state = chrome.js("__t.current()")
    check("undo restores the order", "Services Agreement" in state["pages"][0]["text"], state["revision"])

    text = chrome.js("""(async () => { const fd = new FormData(); appendDocToForm(fd, activeDoc());
      return apiPost('/v1/pdf/extract', fd); })()""")
    check("extract text", "Services Agreement" in text.get("text", "") and text.get("pageCount") == 2, str(text)[:80])

    png = chrome.js("""(async () => { const fd = new FormData(); appendDocToForm(fd, activeDoc());
      fd.append('page_index', '0'); fd.append('scale', '1');
      const r = await fetch('/v1/pdf/render-page', { method: 'POST', body: fd });
      const bmp = await createImageBitmap(await r.blob()); return [r.headers.get('content-type'), bmp.width, bmp.height]; })()""")
    check("render a page (PDFium)", png[0] == "image/png" and png[1:] == [792, 612], png)

    chrome.js("runPageAction('delete', 2)")
    chrome.wait_for("activeDoc().pageCount === 1")
    state = chrome.js("__t.current()")
    check("delete page 2", len(state["pages"]) == 1, len(state["pages"]))

    enc = chrome.js("""(async () => { const fd = new FormData(); appendDocToForm(fd, activeDoc());
      fd.append('user_password', 's3cret'); const r = await apiPost('/v1/pdf/encrypt', fd);
      const buf = await r.blob.arrayBuffer();
      try { await pdfjsLib.getDocument({ data: buf.slice(0) }).promise; return 'opened without password'; }
      catch (e) { if (e.name !== 'PasswordException') return 'error ' + e.message; }
      const pdf = await pdfjsLib.getDocument({ data: buf.slice(0), password: 's3cret' }).promise;
      return 'ok ' + pdf.numPages; })()""")
    check("encrypt: a copy that needs the password", enc == "ok 1", enc)

    merged = chrome.js(f"""(async () => {{ const fd = new FormData();
      for (const [n, b] of [['a.pdf', '{b64('contract.pdf')}'], ['b.pdf', '{b64('form.pdf')}']])
        fd.append('files', new File([Uint8Array.from(atob(b), c => c.charCodeAt(0))], n));
      const r = await apiPost('/v1/pdf/merge', fd);
      return (await pdfjsLib.getDocument({{ data: await r.blob.arrayBuffer() }}).promise).numPages; }})()""")
    check("merge two files", merged == 3, merged)

    missing = chrome.js("""(async () => { const r = await fetch('/v1/pdf/document/00000000-0000-0000-0000-000000000000/meta');
      return [r.status, r.headers.get('X-Error-Code')]; })()""")
    check("unknown session: 404 session_expired", missing == [404, "session_expired"], missing)

    # ---- every other service the editor uses, each on a fresh session
    def session(name):
        return chrome.js(f"__t.open('{b64(name)}', '{name}')")

    def post(path, fields, files=""):
        """apiPost with the active document; `files` is JS code appending File fields to fd."""
        return chrome.js(f"""(async () => {{ const fd = new FormData(); appendDocToForm(fd, activeDoc());
          for (const [k, v] of Object.entries({json.dumps(fields)})) fd.append(k, v);
          {files}
          try {{ const r = await apiPost('{path}', fd); return r.blob ? {{ blob: r.blob.size, type: r.blob.type }} : r; }}
          catch (e) {{ return {{ error: e.message, code: e.code }}; }} }})()""")

    session("form.pdf")
    filled = post("/v1/pdf/fill-form", {"values": json.dumps({"legal_name": "Riverside Dental 牙科", "certify": True})})
    fields = chrome.js("""(async () => { const d = await downloadDocumentBlob(activeDoc());
      const pdf = await pdfjsLib.getDocument({ data: await d.arrayBuffer() }).promise;
      const f = await pdf.getFieldObjects(); return [f.legal_name[0].value, f.certify[0].value]; })()""")
    check("fill-form (CJK value)", filled.get("filled_count") == 2 and fields[0] == "Riverside Dental 牙科" and fields[1] not in ("Off", None), [filled, fields])

    session("contract.pdf")
    hl = post("/v1/pdf/highlight", {"page_index": "0", "x": "315", "y": "90", "width": "60", "height": "16"})
    state = chrome.js("__t.current()")
    check("highlight", "Highlight" in state["pages"][0]["annots"], [hl.get("revision"), state["pages"][0]["annots"]])
    rm = post("/v1/pdf/remove-highlight", {"page_index": "0", "x": "300", "y": "80", "width": "20", "height": "20"})
    check("remove-highlight", rm.get("removed_count") == 1, rm)

    items = [{"id": "p1", "kind": "plain", "pageIndex": 0, "x": 72, "y": 250, "width": 300, "height": 20, "text": "Added 新增文字", "fontSize": 12},
             {"id": "c1", "kind": "cover", "pageIndex": 0, "x": 70, "y": 56, "width": 200, "height": 22, "text": "Service Contract", "fontSize": 16,
              "origin": {"pageIndex": 0, "x": 70, "y": 58, "width": 158, "height": 20}, "matchStyle": True}]
    emb = post("/v1/pdf/embed-placements", {"placements": json.dumps(items)})
    layer = chrome.js("""(async () => { const d = await downloadDocumentBlob(activeDoc());
      const pdf = await pdfjsLib.getDocument({ data: await d.arrayBuffer() }).promise;
      const meta = await pdf.getMetadata(); const oc = await pdf.getOptionalContentConfig();
      const groups = Object.values(oc.getGroups() || {}).map(g => g.name);
      const p = await pdf.getPage(1); const tc = await p.getTextContent({ includeMarkedContent: true });
      const tags = tc.items.filter(i => i.type === 'beginMarkedContent').map(i => i.tag);
      return { stored: JSON.parse(meta.info.Custom.PdfGatewayPlacements).length, groups, tags,
        text: tc.items.map(i => i.str || '').join(' ') }; })()""")
    check("embed-placements: drawn, stored, in the hidden layer", emb.get("edits", {}).get("drawn") == 2
          and emb["edits"]["glyphsErased"] > 0 and layer["stored"] == 2 and "OpenPDF edits" in layer["groups"]
          and "OpenPDFEdits" in layer["tags"] and "新增文字" in layer["text"] and "Services Agreement" not in layer["text"],
          [emb.get("edits"), {k: layer[k] for k in ("stored", "groups", "tags")}])
    back = post("/v1/pdf/read-placements", {})
    check("read-placements", len(back.get("placements", [])) == 2, back)

    session("contract.pdf")
    red = post("/v1/pdf/redact", {"terms": json.dumps(["John Smith", "123-45-6789"]), "regions": "[]", "edits": "[]",
                                   "case_sensitive": "false", "remove_metadata": "false"})
    rep = red.get("report", {})
    check("redact (kept as text, checked)", rep.get("verified") is True and rep.get("termMatches", {}).get("John Smith") == 3
          and all(p["method"] == "text" for p in rep.get("redactedPages", [])), str(red)[:300])
    session("contract.pdf")
    red = post("/v1/pdf/redact", {"terms": json.dumps(["John Smith"]), "keep_text": "false", "edits": "[]"})
    rep = red.get("report", {})
    check("redact as pictures (browser canvas)", rep.get("verified") is True
          and all(p["method"] == "picture" for p in rep.get("redactedPages", [])), str(red)[:300])
    # a box on a scanned page: the picture's other pixels must stay as they were
    # (a Flate picture copied with LibPDF's getEncodedData() came out black)
    session("scan.pdf")
    red = post("/v1/pdf/redact", {"regions": json.dumps([{"page": 1, "x": 60, "y": 60, "width": 120, "height": 40}]), "edits": "[]"})
    shade = chrome.js("""(async () => { const d = await downloadDocumentBlob(activeDoc());
      const pdf = await pdfjsLib.getDocument({ data: await d.arrayBuffer() }).promise;
      const page = await pdf.getPage(1); const vp = page.getViewport({ scale: 1 });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      const ctx = c.getContext('2d'); await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const mean = (x, y, w, h) => { const px = ctx.getImageData(x, y, w, h).data; let s = 0;
        for (let i = 0; i < px.length; i += 4) s += px[i] + px[i + 1] + px[i + 2]; return s / (px.length / 4) / 3; };
      return { box: mean(70, 70, 100, 20), rest: mean(0, vp.height / 2, vp.width, vp.height / 2) }; })()""")
    check("redact a box on a scanned page: box black, the rest of the picture kept", red.get("report", {}).get("verified") is True
          and shade["box"] < 40 and shade["rest"] > 200, shade)
    nothing = post("/v1/pdf/redact", {"terms": json.dumps(["Nobody Here"]), "edits": "[]"})
    check("redact refuses when nothing matches", "None of the terms" in nothing.get("error", ""), nothing)

    gen = chrome.js("""(async () => { const fd = new FormData(); fd.append('name', 'Ana Example'); fd.append('cert_password', 'test-1234');
      const r = await apiPost('/v1/pdf/generate-cert', fd); window.__p12 = r.blob;
      const f2 = new FormData(); f2.append('cert', r.blob, 'ana.p12'); f2.append('cert_password', 'test-1234');
      return apiPost('/v1/pdf/cert-info', f2); })()""")
    check("generate-cert + cert-info", gen.get("name") == "Ana Example" and gen.get("selfSigned") is True, gen)
    session("contract.pdf")
    signed = post("/v1/pdf/digital-sign", {"cert_password": "test-1234", "reason": "Approved", "visible": "true",
                                            "page_index": "0", "x": "300", "y": "400", "width": "220", "height": "70"},
                  "fd.append('cert', window.__p12, 'ana.p12');")
    ver = post("/v1/pdf/verify-signatures", {})
    sig = (ver.get("signatures") or [{}])[0]
    check("digital-sign (visible) + verify", signed.get("ok") and sig.get("status") == "untrusted" and sig.get("page") == 0
          and sig.get("coversWholeFile") is True, [signed, sig.get("status"), sig.get("message")])

    stamped = post("/v1/pdf/stamp-signatures", {"mode": "annotation", "placements": json.dumps([{"page": 0, "x": 72, "y": 500, "width": 100, "height": 40, "image": 0}])},
                   "const c = new OffscreenCanvas(40, 20); c.getContext('2d').fillRect(0, 0, 40, 20); fd.append('images', await c.convertToBlob({ type: 'image/png' }), 'sig.png');")
    check("stamp-signatures (annotation)", stamped.get("stamped_count") == 1, stamped)

    session("scan.pdf")
    status = chrome.js("fetch('/v1/pdf/ocr/status').then(r => r.json())")
    ocr = post("/v1/pdf/ocr", {"languages": "eng,chi_sim", "deskew": "false", "clean": "false"})
    text = chrome.js("__t.current()")
    check("OCR in the browser", status.get("installed") and ocr.get("ok") and "Riverside" in text["pages"][0]["text"],
          [status, str(ocr)[:120], text["pages"][0]["text"][:120]])

    # ---- works offline once loaded (web/src/sw-web.js)
    chrome.wait_for("navigator.serviceWorker.getRegistration('/ui/').then(r => !!(r && r.active))", 20)
    chrome.cdp("Network.emulateNetworkConditions", offline=True, latency=0, downloadThroughput=-1, uploadThroughput=-1)
    chrome.goto(f"{BASE}/ui/index.html")
    loaded = chrome.wait_for("typeof openFile === 'function' && window.__OPENPDF_WEB === true", 20)
    if loaded:
        chrome.js(HELPERS)
        session("contract.pdf")
        chrome.js("runPageAction('rotate-cw', 1)")
        rotated = chrome.wait_for("activeDoc().serverRevision >= 2", 30)
    check("works offline (editor and services from the cache)", loaded and rotated)
    chrome.cdp("Network.emulateNetworkConditions", offline=False, latency=0, downloadThroughput=-1, uploadThroughput=-1)

    # ---- nothing but this site was contacted (no CDN, no model servers)
    urls = {e["params"]["request"]["url"] for e in chrome.events if e.get("method") == "Network.requestWillBeSent"}
    foreign = sorted(u for u in urls if not (u.startswith(BASE) or u.startswith(("data:", "blob:", "about:"))))
    seen = sorted(u for u in urls if "/vendor/ocr/" in u or "/vendor/pdfium/" in u or "cjk.ttf" in u)
    check("no request left the site", not foreign and seen, foreign[:5] or f"{len(urls)} requests, e.g. {seen[:3]}")

    expected = ("favicon", "ERR_INTERNET_DISCONNECTED", "beforeunload")  # the test reloads with unsaved changes, offline
    errors = [e for e in chrome.errors() if not any(x in e for x in expected)]
    check("no script errors", not errors, errors[:3])
finally:
    chrome.close()

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
