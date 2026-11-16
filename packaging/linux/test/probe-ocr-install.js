// Installed app, OCR add-on (OPENPDF_AUTOTEST_PRE with a scanned file open):
// status -> install through the desktop app (as the "Download and install" button does)
// -> status -> OCR the open file -> Chinese text in the result.
(async () => {
  const log = (m) => console.info("[installed-test] " + m);
  let pass = 0, total = 0;
  const check = (ok, what) => { total += 1; if (ok) pass += 1; log(`${ok ? "PASS" : "FAIL"} ${what}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const docId = () => (typeof state !== "undefined" && state.docs[0] && state.docs[0].documentId) || null;
    for (let i = 0; i < 150 && !docId(); i++) await sleep(200);
    check(!!docId(), "scanned file opened");
    const status = async () => (await (await fetch("/v1/pdf/ocr/status")).json()).installed;
    check((await status()) === false, "OCR not installed at first");

    const events = [];
    let finished = null;
    window.__openpdfOcrInstall = (e) => {
      events.push(e);
      if (e.kind === "line" && /^STEP /.test(e.text)) log(`  ${e.text}`);
      if (e.kind === "done" || e.kind === "error") finished = e;
    };
    const t0 = Date.now();
    window.location.href = "openpdf-action://install-ocr";
    for (let i = 0; i < 3000 && !finished; i++) await sleep(200);  // up to 10 min (real download)
    check(finished && finished.kind === "done", `install: ${finished ? finished.kind + " " + (finished.text || "") : "timeout"} after ${Math.round((Date.now() - t0) / 1000)}s`);
    check(events.some((e) => e.kind === "line" && /^PCT \d+$/.test(e.text)) || events.some((e) => /^STEP 2\//.test(e.text || "")), "progress reported");
    check((await status()) === true, "OCR installed afterwards (no restart)");

    const pdf = await (await fetch(`/v1/pdf/document/${docId()}`)).blob();
    const fd = new FormData();
    fd.append("file", pdf, "scan.pdf");
    fd.append("languages", "eng,chi_sim");
    const t1 = Date.now();
    const r = await fetch("/v1/pdf/ocr", { method: "POST", body: fd });
    const out = await r.blob();
    const fd2 = new FormData();
    fd2.append("file", out, "o.pdf");
    const text = JSON.stringify(await (await fetch("/v1/pdf/extract", { method: "POST", body: fd2 })).json());
    check(r.ok && /开源软件|合同|识别/.test(text), `OCR of the open scan: HTTP ${r.status} in ${Date.now() - t1} ms, Chinese text ${/开源软件|合同|识别/.test(text) ? "found" : "missing"}`);
  } catch (e) {
    check(false, `exception: ${e && e.stack ? e.stack : e}`);
  }
  log(`DONE ${pass}/${total}`);
})();
