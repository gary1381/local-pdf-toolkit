// Runs inside the installed app's editor page (OPENPDF_AUTOTEST_RUN) when
// test-package.sh starts the app with a PDF path, the way the system's
// "Open with OpenPDF" does, then starts it once more with a second PDF while
// it runs. Checks that each file opens in the editor and that Save writes back
// to it (test-package.sh then checks the files on disk). Prints one
// "[installed-test] PASS|FAIL ..." line per check, then "DONE n/m".
(async () => {
  const DIR = "/tmp/open-test";
  const log = (m) => console.info("[installed-test] " + m);
  let pass = 0, total = 0;
  const check = (ok, what) => { total += 1; if (ok) pass += 1; log(`${ok ? "PASS" : "FAIL"} ${what}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // `state` and `actions` are top-level consts of app.js: globals, but not on window
  const find = (name) => (typeof state !== "undefined" && state.docs.find((d) => d.name === name && d.documentId)) || null;
  // the editor's script may still be loading: wait for it before hooking in
  while (typeof openFile !== "function" || typeof window.__openpdfSaved !== "function") await sleep(50);
  const saved = [];
  const original = window.__openpdfSaved;
  window.__openpdfSaved = (path, url) => { saved.push(path); return original(path, url); };

  async function openedAndSaved(name, seconds) {
    const t0 = Date.now();
    while (!find(name) && Date.now() - t0 < seconds * 1000) await sleep(200);
    const doc = find(name);
    check(!!doc, `editor opened “${name}” (${Date.now() - t0} ms)`);
    if (!doc) return;
    check(activeDoc() === doc, `“${name}” is the active tab`);
    const before = saved.length;
    doc.dirty = true; // as after an edit: the confirmed save must clear it
    await actions.save();
    const t1 = Date.now();
    while (saved.length === before && Date.now() - t1 < 15000) await sleep(100);
    const path = saved[before];
    check(path === `${DIR}/${name}`, `Save wrote back to ${path || "nothing"}`);
    check(!doc.dirty, `“${name}” counts as saved`);
  }

  try {
    await openedAndSaved("open me.pdf", 30);
    log("ready for the second start");
    await openedAndSaved("second.pdf", 60);
    // a picture from the system: the editor asks about OCR, then opens it as a new PDF
    log("ready for the picture");
    const t0 = Date.now();
    const dialog = document.getElementById("toolDialog");
    while (!dialog.open && Date.now() - t0 < 60000) await sleep(200);
    check(dialog.open, `picture dialog shown (${Date.now() - t0} ms)`);
    if (dialog.open) {
      document.getElementById("toolSubmitBtn").click();
      const pdf = await (async () => {
        const t1 = Date.now();
        while (!find("photo.pdf") && Date.now() - t1 < 60000) await sleep(200);
        return find("photo.pdf");
      })();
      check(!!pdf && pdf.pageCount === 1 && activeDoc() === pdf, `picture opened as “photo.pdf”, ${pdf ? pdf.pageCount : 0} page`);
    }
  } catch (err) {
    check(false, `probe error: ${err && err.stack || err}`);
  }
  log(`DONE ${pass}/${total}`);
})();
