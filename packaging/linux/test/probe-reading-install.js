// Installed app, document reading add-ons (OPENPDF_AUTOTEST_PRE with a file that
// has a table open): status -> choose "Fast" in the settings (as the radio button
// does: the structure component, the runtime and the model are installed) ->
// status -> read the open file with the model.
(async () => {
  const log = (m) => console.info("[installed-test] " + m);
  let pass = 0, total = 0;
  const check = (ok, what) => { total += 1; if (ok) pass += 1; log(`${ok ? "PASS" : "FAIL"} ${what}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const docId = () => (typeof state !== "undefined" && state.docs[0] && state.docs[0].documentId) || null;
    for (let i = 0; i < 150 && !docId(); i++) await sleep(200);
    check(!!docId(), "file opened");

    let last = null;
    let finished = null;
    const events = [];
    const prev = window.__openpdfAddons;
    window.__openpdfAddons = (e) => {
      events.push(e);
      if (e.status) last = e.status;
      if (e.kind === "line" && /^STEP /.test(e.text)) log(`  ${e.text}`);
      if (e.kind === "done" || e.kind === "error") finished = e;
      if (prev) prev(e);
    };
    window.location.href = "openpdf-action://addons?do=status";
    for (let i = 0; i < 100 && !last; i++) await sleep(100);
    check(last && last.desktop && !last.structure && !last.runtime && last.tiers && last.tiers.fast,
      `status before: ${JSON.stringify(last && { structure: last.structure, runtime: last.runtime, gpu: last.gpuFreeMb })}`);

    const t0 = Date.now();
    window.location.href = "openpdf-action://addons?do=select&what=fast";
    for (let i = 0; i < 9000 && !finished; i++) await sleep(200);  // up to 30 min (real model download)
    check(finished && finished.kind === "done", `choose Fast: ${finished ? finished.kind + " " + (finished.text || "") : "timeout"} after ${Math.round((Date.now() - t0) / 1000)}s`);
    check(events.some((e) => e.kind === "line" && /^PCT \d+$/.test(e.text)), "progress reported");
    check(last && last.structure && last.runtime && last.selected === "fast" && last.tiers.fast.downloaded, `status after: ${JSON.stringify(last && { structure: last.structure, runtime: last.runtime, selected: last.selected })}`);
    const st = await (await fetch("/v1/pdf/structure/status")).json();
    const model = await (await fetch("/v1/pdf/structure/model")).json();
    check(st.installed && model.ready && model.model === "paddleocr-vl", `gateway sees the component and the model: ${JSON.stringify(model)}`);

    const pdf = await (await fetch(`/v1/pdf/document/${docId()}`)).blob();
    const fd = new FormData();
    fd.append("file", pdf, "doc.pdf");
    const t1 = Date.now();
    const r = await fetch("/v1/pdf/structure", { method: "POST", body: fd });
    const d = await r.json();
    const byModel = (d.elements || []).filter((e) => e.readBy === "model").length;
    check(r.ok && d.modelUsed === true, `read with the model by default: HTTP ${r.status}, modelUsed=${d.modelUsed}, ${byModel} blocks read by it, ${Date.now() - t1} ms`);
    window.location.href = "openpdf-action://addons?do=select&what=off";
    finished = null;
    for (let i = 0; i < 600 && !finished; i++) await sleep(200);
    const off = await (await fetch("/v1/pdf/structure/model")).json();
    check(finished && finished.kind === "done" && !off.configured, `turned off: ${JSON.stringify(off)}`);
  } catch (e) {
    check(false, `exception: ${e && e.stack ? e.stack : e}`);
  }
  log(`DONE ${pass}/${total}`);
})();
