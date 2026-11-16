// Runs inside the installed app's editor page (OPENPDF_AUTOTEST_PRE): calls
// the bundled services through the page's own gateway and prints one
// "[installed-test] PASS|FAIL ..." line per check, then "DONE n/m".
(async () => {
  const log = (m) => console.info("[installed-test] " + m);
  let pass = 0, total = 0;
  const check = (ok, what) => { total += 1; if (ok) pass += 1; log(`${ok ? "PASS" : "FAIL"} ${what}`); };
  try {
    // the file handed to OPENPDF_AUTOTEST_OPEN, once the editor has opened it
    const t0 = Date.now();
    // `state` is a top-level const of app.js: a global, but not on window
    const docId = () => (typeof state !== "undefined" && state.docs[0] && state.docs[0].documentId) || null;
    while (!docId() && Date.now() - t0 < 30000) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const id = docId();
    check(!!id, `editor opened the file (${Date.now() - t0} ms)`);
    const pdf = await (await fetch(`/v1/pdf/document/${id}`)).blob();
    log(`gateway ${location.origin}, file ${pdf.size} bytes`);
    const post = async (path, fields) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) {
        if (Array.isArray(v)) v.forEach((x, i) => fd.append(k, x, `f${i}.pdf`));
        else if (v instanceof Blob) fd.append(k, v, k === "cert" ? "c.p12" : "f.pdf");
        else fd.append(k, String(v));
      }
      return fetch(path, { method: "POST", body: fd });
    };
    const json = async (r) => (r.ok ? r.json() : { status: r.status, body: await r.text() });

    const h = await (await fetch("/health")).json();
    check(h.status === "ok", "gateway /health");
    const info = await json(await post("/v1/pdf/info", { file: pdf }));
    const pages = info.page_count ?? info.pages ?? info.pageCount;
    check(pages > 0, `info (PDFBox, bundled Java): ${pages} pages`);
    const ex = await json(await post("/v1/pdf/extract", { file: pdf }));
    check(JSON.stringify(ex).length > 50, "extract text (PDFBox)");

    const merged = await post("/v1/pdf/merge", { files: [pdf, pdf] });
    const mi = await json(await post("/v1/pdf/info", { file: await merged.blob() }));
    const mp = mi.page_count ?? mi.pages ?? mi.pageCount;
    check(merged.ok && mp === 2 * pages, `merge (bundled qpdf): ${mp} pages`);
    const split = await post("/v1/pdf/split", { file: pdf, pages: "1" });
    check(split.ok, "split (qpdf)");

    const drawn = await post("/v1/pdf/draw-text", { file: pdf, text: "安装版测试 你好", x: 72, y: 600, width: 300, height: 30 });
    const de = await json(await post("/v1/pdf/extract", { file: await drawn.blob() }));
    check(drawn.ok && JSON.stringify(de).includes("安装版测试"), "draw Chinese text (bundled font)");

    const cert = await post("/v1/pdf/generate-cert", { name: "测试 用户", cert_password: "pw-123456", years: 1 });
    check(cert.ok, "generate certificate (BouncyCastle)");
    const signed = await post("/v1/pdf/digital-sign", { file: pdf, cert: await cert.blob(), cert_password: "pw-123456", visible: false });
    const ver = await json(await post("/v1/pdf/verify-signatures", { file: await signed.blob() }));
    const sig = (ver.signatures || [])[0] || {};
    check(signed.ok && ["valid", "untrusted"].includes(sig.status), `digital signature: ${sig.status}`);

    const png = await post("/v1/pdf/render-page", { file: pdf, page_index: 0, scale: 1 });
    check(png.ok && (await png.blob()).size > 1000, "render page (Java AWT, fonts)");

    const ocr = await json(await fetch("/v1/pdf/ocr/status"));
    check(typeof ocr.installed === "boolean", `ocr status: installed=${ocr.installed}`);
  } catch (e) {
    check(false, `exception: ${e && e.stack ? e.stack : e}`);
  }
  log(`DONE ${pass}/${total}`);
})();
