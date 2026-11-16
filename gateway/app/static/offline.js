/*
 * offline.html: the installed app was opened while the services are not
 * running. Keep the PDFs it was opened with (IndexedDB "openpdf-launch", read
 * by app.js) and go to the editor as soon as the services answer.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  $("title").textContent = t("{app} isn't running");
  $("body").textContent = t(
    "Its services run on this computer. Open the {app} app (or start its services), and this window continues by itself."
  );
  $("waiting").textContent = t("Waiting for {app}…");

  function keep(handles) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("openpdf-launch", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("pending", { autoIncrement: true });
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction("pending", "readwrite");
        for (const handle of handles) tx.objectStore("pending").add({ handle, at: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
    });
  }

  if ("launchQueue" in window) {
    window.launchQueue.setConsumer(async (params) => {
      const files = (params.files || []).filter((handle) => handle.kind === "file");
      if (!files.length) return;
      await keep(files);
      const pending = $("pending");
      pending.textContent = tn(
        files.length,
        "{n} PDF will open as soon as {app} is running.",
        "{n} PDFs will open as soon as {app} is running."
      );
      pending.hidden = false;
    });
  }

  async function poll() {
    try {
      const resp = await fetch("/health", { cache: "no-store" });
      if (resp.ok) {
        window.location.replace("/ui/index.html");
        return;
      }
    } catch (_) {
      // not running yet
    }
    setTimeout(poll, 2000);
  }
  poll();
})();
