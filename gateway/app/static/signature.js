/*
 * Signatures
 *
 * - Make a signature: draw it, type it in a handwriting font, or upload a photo
 *   (the white paper is made transparent). Saved signatures stay on this
 *   computer (IndexedDB in this browser / the desktop app's own storage).
 * - Place it: click the page; until the edit is finished the signature can be
 *   moved, resized or deleted. Empty signature fields in the PDF show a
 *   "click to sign" box. Everything placed is written in one server edit.
 * - Digital signature: sign with a .p12/.pfx certificate (or a personal one made
 *   here). Signed files are checked on open, and editing one asks first.
 *
 * Loaded after app.js and uses its globals (state, els, activeDoc, apiPost, ...).
 */
(() => {
  "use strict";

  const DB_NAME = "openpdf-signatures";
  const MODE_KEY = "openpdf.signWriteMode";
  const NAME_KEY = "openpdf.signName";
  const DEFAULT_KEY = "openpdf.signDefault";
  const TSA_KEY = "openpdf.tsaUrl";
  const DEFAULT_TSA = "http://timestamp.digicert.com";
  const FONT_KEY = "openpdf.signFont";

  // Handwriting fonts for typed signatures. The labels are marked for translation and translated where shown.
  const FONTS = [
    { id: "GreatVibes", label: N_("Great Vibes"), file: "GreatVibes-Regular.woff2", script: "latin" },
    { id: "DancingScript", label: N_("Dancing Script"), file: "DancingScript.woff2", script: "latin" },
    { id: "MaShanZheng", label: N_("Ma Shan Zheng (Chinese)"), file: "MaShanZheng-Regular.woff2", script: "zh" },
    { id: "ZhiMangXing", label: N_("Zhi Mang Xing (Chinese)"), file: "ZhiMangXing-Regular.woff2", script: "zh" },
    { id: "LiuJianMaoCao", label: N_("Liu Jian Mao Cao (Chinese)"), file: "LiuJianMaoCao-Regular.woff2", script: "zh" },
  ];
  const INKS = [
    { id: "black", color: "#1b1f24", label: N_("Black") },
    { id: "blue", color: "#1d3f9a", label: N_("Blue") },
    { id: "red", color: "#b3261e", label: N_("Red") },
  ];
  const WIDTHS = [
    { id: "thin", px: 2, label: N_("Thin"), title: N_("Thin stroke") },
    { id: "mid", px: 3.2, label: N_("Medium"), title: N_("Medium stroke") },
    { id: "bold", px: 5, label: N_("Thick"), title: N_("Thick stroke") },
  ];

  function isChinese() {
    return /^zh/i.test(window.I18N?.lang || "");
  }

  /** The fonts in display order: Chinese calligraphy first for a Chinese interface, Latin script first otherwise. */
  function orderedFonts() {
    const zhFirst = isChinese();
    return [...FONTS].sort((a, b) => (a.script === b.script ? 0 : (a.script === "zh") === zhFirst ? -1 : 1));
  }

  function defaultFontId() {
    return orderedFonts()[0].id;
  }

  const sig = {
    items: [], // saved signatures {id, kind, blob, w, h, created}
    certs: [], // saved certificates {id, label, fileName, blob, info, created}
    urls: new Map(), // id -> object URL
    currentId: null,
    oneShot: null, // a date / name stamp for the next click {blob, w, h, kind, url}
    selectedId: null, // selected pending placement
    loaded: false,
    dsign: null, // digital signature waiting for a position {options}
  };

  // ------------------------------------------------------------ storage

  let dbPromise = null;
  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve) => {
        try {
          const req = indexedDB.open(DB_NAME, 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("items")) db.createObjectStore("items", { keyPath: "id" });
            if (!db.objectStoreNames.contains("certs")) db.createObjectStore("certs", { keyPath: "id" });
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          req.onblocked = () => resolve(null);
        } catch (_) {
          resolve(null);
        }
      });
    }
    return dbPromise;
  }

  async function dbAll(store) {
    const db = await openDb();
    if (!db) return [];
    return new Promise((resolve) => {
      try {
        const req = db.transaction(store).objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (_) {
        resolve([]);
      }
    });
  }

  async function dbPut(store, value) {
    const db = await openDb();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(value);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (_) {
        resolve(false);
      }
    });
  }

  async function dbDelete(store, id) {
    const db = await openDb();
    if (!db) return;
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).delete(id);
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      } catch (_) {
        resolve();
      }
    });
  }

  function lsGet(key, fallback = "") {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch (_) {
      return fallback;
    }
  }

  function lsSet(key, value) {
    try {
      if (value == null || value === "") localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (_) {
      /* private mode */
    }
  }

  async function loadLibrary() {
    if (sig.loaded) return;
    const [items, certs] = await Promise.all([dbAll("items"), dbAll("certs")]);
    // keep anything added before the database answered
    const ids = new Set(sig.items.map((i) => i.id));
    sig.items = [...sig.items, ...items.filter((i) => !ids.has(i.id))].sort((a, b) => a.created - b.created);
    const cids = new Set(sig.certs.map((c) => c.id));
    sig.certs = [...sig.certs, ...certs.filter((c) => !cids.has(c.id))].sort((a, b) => a.created - b.created);
    sig.loaded = true;
    if (!sig.currentId || !itemById(sig.currentId)) sig.currentId = defaultItem()?.id || null;
  }

  function itemById(id) {
    return sig.items.find((i) => i.id === id) || null;
  }

  function defaultItem() {
    const preferred = itemById(lsGet(DEFAULT_KEY));
    if (preferred) return preferred;
    return [...sig.items].reverse().find((i) => i.kind === "signature") || sig.items[sig.items.length - 1] || null;
  }

  function urlFor(item) {
    if (!item) return "";
    if (item.url) return item.url;
    let url = sig.urls.get(item.id);
    if (!url) {
      url = URL.createObjectURL(item.blob);
      sig.urls.set(item.id, url);
    }
    return url;
  }

  async function addItem(blob, w, h, kind) {
    const item = { id: crypto.randomUUID(), kind, blob, w, h, created: Date.now() };
    sig.items.push(item);
    const stored = await dbPut("items", item);
    if (!stored) showToast(t("This signature can be used only this time: the browser does not allow saving it"), { type: "error" });
    if (kind === "signature" && !itemById(lsGet(DEFAULT_KEY))) lsSet(DEFAULT_KEY, item.id);
    return item;
  }

  async function removeItem(id) {
    sig.items = sig.items.filter((i) => i.id !== id);
    const url = sig.urls.get(id);
    if (url) URL.revokeObjectURL(url);
    sig.urls.delete(id);
    await dbDelete("items", id);
    if (lsGet(DEFAULT_KEY) === id) lsSet(DEFAULT_KEY, "");
    if (sig.currentId === id) sig.currentId = defaultItem()?.id || null;
  }

  // ------------------------------------------------------------ pictures

  /** Crop a canvas to what is drawn on it (alpha), with a little margin. */
  function trimCanvas(source, margin = 6) {
    const ctx = source.getContext("2d", { willReadFrequently: true });
    const { width, height } = source;
    const data = ctx.getImageData(0, 0, width, height).data;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
      const row = y * width * 4;
      for (let x = 0; x < width; x += 1) {
        if (data[row + x * 4 + 3] > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    minX = Math.max(0, minX - margin);
    minY = Math.max(0, minY - margin);
    maxX = Math.min(width - 1, maxX + margin);
    maxY = Math.min(height - 1, maxY + margin);
    const out = document.createElement("canvas");
    out.width = maxX - minX + 1;
    out.height = maxY - minY + 1;
    out.getContext("2d").drawImage(source, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(t("Could not create the image")))), "image/png");
    });
  }

  async function canvasToPicture(canvas) {
    const trimmed = trimCanvas(canvas);
    if (!trimmed) return null;
    return { blob: await canvasToBlob(trimmed), w: trimmed.width, h: trimmed.height };
  }

  const fontLoads = new Map();
  function loadFont(font) {
    if (!fontLoads.has(font.id)) {
      const face = new FontFace(`OpenPDFSign-${font.id}`, `url(/ui/fonts/${font.file})`);
      fontLoads.set(
        font.id,
        face
          .load()
          .then((loaded) => {
            document.fonts.add(loaded);
            return true;
          })
          .catch(() => false)
      );
    }
    return fontLoads.get(font.id);
  }

  /** Text drawn in a font, as a trimmed transparent picture. */
  async function textPicture(text, fontFamily, color, size = 120) {
    const probe = document.createElement("canvas").getContext("2d");
    probe.font = `${size}px ${fontFamily}`;
    const width = Math.ceil(probe.measureText(text).width + size);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.min(width, 4000));
    canvas.height = Math.ceil(size * 1.8);
    const ctx = canvas.getContext("2d");
    ctx.font = `${size}px ${fontFamily}`;
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.fillText(text, size / 2, canvas.height / 2);
    return canvasToPicture(canvas);
  }

  /** A photo of a signature on paper: scale it down and make the paper transparent. */
  async function photoPicture(file, removeBackground) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error(t("Could not read this image")));
        img.src = url;
      });
      const scale = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      if (removeBackground) {
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = image.data;
        // paper brightness: a bright percentile, so uneven light still counts as paper
        const samples = [];
        for (let i = 0; i < d.length; i += 4 * 37) samples.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
        samples.sort((a, b) => a - b);
        const paper = samples[Math.floor(samples.length * 0.9)] || 255;
        const ink = Math.max(0, paper - 90);
        for (let i = 0; i < d.length; i += 4) {
          const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          let alpha = (paper - 12 - lum) / Math.max(1, paper - 12 - ink);
          alpha = Math.max(0, Math.min(1, alpha));
          d[i + 3] = Math.round(d[i + 3] * alpha);
          if (alpha > 0) {
            // deepen faint ink so the signature does not look washed out
            const k = 0.65;
            d[i] = Math.round(d[i] * k);
            d[i + 1] = Math.round(d[i + 1] * k);
            d[i + 2] = Math.round(d[i + 2] * k);
          }
        }
        ctx.putImageData(image, 0, 0);
      }
      const picture = await canvasToPicture(canvas);
      if (!picture) throw new Error(t("No signature found in the image"));
      return picture;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function todayText() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  async function stampPicture(text) {
    const fam = getComputedStyle(document.documentElement).getPropertyValue("--font") || "sans-serif";
    const picture = await textPicture(text, fam, "#1b1f24", 64);
    if (!picture) return null;
    return { ...picture, kind: "stamp", url: URL.createObjectURL(picture.blob) };
  }

  // ------------------------------------------------------------ the "make a signature" dialog

  const ui = {};

  function h(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const child of [].concat(children)) {
      if (child) el.append(child);
    }
    return el;
  }

  /**
   * Fill [data-l10n] text and [data-l10n-title], [data-l10n-aria-label] and
   * [data-l10n-placeholder] attributes from a table of key -> text.
   */
  function localize(root, texts) {
    root.querySelectorAll("[data-l10n]").forEach((el) => {
      el.textContent = texts[el.dataset.l10n] ?? "";
    });
    for (const attr of ["title", "aria-label", "placeholder"]) {
      root.querySelectorAll(`[data-l10n-${attr}]`).forEach((el) => {
        el.setAttribute(attr, texts[el.getAttribute(`data-l10n-${attr}`)] ?? "");
      });
    }
  }

  /** The fixed text of the "make a signature" dialog, in the current language. */
  function signDialogTexts() {
    return {
      title: t("Signature"),
      close: t("Close"),
      tabDraw: t("Draw"),
      tabType: tc("signature method", "Type"),
      tabUpload: t("Upload image"),
      tabLibrary: t("My signatures"),
      pad: t("Draw your signature here"),
      padHint: t("Sign here with a mouse, touchpad or pen"),
      undoStroke: t("Undo stroke"),
      clear: t("Clear"),
      name: t("Name"),
      namePlaceholder: t("Type your name"),
      font: t("Font"),
      removeBg: t("Remove the white background (for a photo of a signature on paper)"),
      libraryHint: t("Signatures are stored only on this computer. Click one to place it on the page."),
      saveAs: t("Save as"),
      kindSignature: t("Signature"),
      kindInitials: t("Initials"),
      cancel: t("Cancel"),
      save: t("Save and use"),
    };
  }

  function buildSignDialog() {
    const dialog = document.createElement("dialog");
    dialog.className = "modal modal-wide";
    dialog.id = "signDialog";
    dialog.setAttribute("aria-labelledby", "signDialogTitle");
    // the text is filled in by applySignDialogText()
    dialog.innerHTML = `
      <form method="dialog" class="modal-card sign-card">
        <div class="sign-head">
          <h2 id="signDialogTitle" data-l10n="title"></h2>
          <button type="button" class="icon-btn" data-sign-close data-l10n-title="close" data-l10n-aria-label="close" data-icon="x" data-icon-size="16"></button>
        </div>
        <div class="sign-tabs" role="tablist">
          <button type="button" role="tab" data-tab="draw" data-l10n="tabDraw"></button>
          <button type="button" role="tab" data-tab="type" data-l10n="tabType"></button>
          <button type="button" role="tab" data-tab="upload" data-l10n="tabUpload"></button>
          <button type="button" role="tab" data-tab="library"><span data-l10n="tabLibrary"></span> <span class="sign-count" id="signCount"></span></button>
        </div>

        <section class="sign-pane" data-pane="draw">
          <div class="sign-pad-wrap">
            <canvas class="sign-pad" id="signPad" data-l10n-aria-label="pad"></canvas>
            <span class="sign-pad-baseline" aria-hidden="true"></span>
            <span class="sign-pad-hint" id="signPadHint" data-l10n="padHint"></span>
          </div>
          <div class="sign-row">
            <div class="sign-inks" data-ink-group></div>
            <span class="tool-hint-sep" aria-hidden="true"></span>
            <div class="sign-widths" id="signWidths"></div>
            <span class="sign-spacer"></span>
            <button type="button" class="ghost-btn" id="signUndoStroke" data-l10n="undoStroke"></button>
            <button type="button" class="ghost-btn" id="signClearPad" data-l10n="clear"></button>
          </div>
        </section>

        <section class="sign-pane" data-pane="type">
          <label for="signTypeName" data-l10n="name"></label>
          <input type="text" id="signTypeName" maxlength="40" autocomplete="name" data-l10n-placeholder="namePlaceholder" />
          <div class="sign-fonts" id="signFonts" role="radiogroup" data-l10n-aria-label="font"></div>
          <div class="sign-row"><div class="sign-inks" data-ink-group></div></div>
        </section>

        <section class="sign-pane" data-pane="upload">
          <label class="sign-drop" id="signDrop">
            <input type="file" id="signUploadInput" accept="image/png,image/jpeg" hidden />
            <span class="sign-drop-preview" id="signUploadPreview"></span>
            <span class="sign-drop-text" id="signDropText"></span>
          </label>
          <label class="sign-check"><input type="checkbox" id="signRemoveBg" checked /> <span data-l10n="removeBg"></span></label>
        </section>

        <section class="sign-pane" data-pane="library">
          <div class="sign-library" id="signLibrary"></div>
          <p class="field-hint" data-l10n="libraryHint"></p>
        </section>

        <div class="sign-foot">
          <div class="sign-kind" id="signKind" role="radiogroup" data-l10n-aria-label="saveAs">
            <label><input type="radio" name="signKind" value="signature" checked /> <span data-l10n="kindSignature"></span></label>
            <label><input type="radio" name="signKind" value="initials" /> <span data-l10n="kindInitials"></span></label>
          </div>
          <span class="sign-spacer"></span>
          <button type="button" class="ghost-btn" data-sign-close data-l10n="cancel"></button>
          <button type="button" class="primary-btn" id="signSaveBtn" data-l10n="save"></button>
        </div>
      </form>`;
    document.body.appendChild(dialog);
    ui.dialog = dialog;
    ui.pad = dialog.querySelector("#signPad");
    ui.padHint = dialog.querySelector("#signPadHint");
    ui.typeName = dialog.querySelector("#signTypeName");
    ui.fonts = dialog.querySelector("#signFonts");
    ui.library = dialog.querySelector("#signLibrary");
    ui.count = dialog.querySelector("#signCount");
    ui.uploadInput = dialog.querySelector("#signUploadInput");
    ui.uploadPreview = dialog.querySelector("#signUploadPreview");
    ui.dropText = dialog.querySelector("#signDropText");
    ui.removeBg = dialog.querySelector("#signRemoveBg");
    ui.saveBtn = dialog.querySelector("#signSaveBtn");
    ui.kind = dialog.querySelector("#signKind");
    window.PdfIcons?.hydrate(dialog);

    dialog.querySelectorAll("[data-sign-close]").forEach((b) => b.addEventListener("click", () => dialog.close()));
    dialog.querySelectorAll("[data-tab]").forEach((b) =>
      b.addEventListener("click", () => showTab(b.dataset.tab))
    );
    dialog.addEventListener("cancel", () => {
      /* Esc closes; nothing else to undo */
    });
    dialog.addEventListener("keydown", (e) => e.stopPropagation());
    dialog.querySelectorAll("[data-ink-group]").forEach((group) => {
      for (const ink of INKS) {
        group.append(
          h("button", {
            type: "button",
            class: "sign-ink",
            "data-ink": ink.id,
            style: `--ink-color:${ink.color}`,
            onclick: () => setInk(ink.id),
          })
        );
      }
    });
    const widths = dialog.querySelector("#signWidths");
    for (const w of WIDTHS) {
      widths.append(
        h("button", { type: "button", class: "sign-width", "data-width": w.id, onclick: () => setWidth(w.id) }, [
          h("span", { class: "sign-width-dot", style: `--dot:${w.px * 2}px` }),
          h("span", { class: "sign-width-label" }),
        ])
      );
    }
    // a font the user picked is kept; otherwise the default follows the language
    fontId = FONTS.some((f) => f.id === lsGet(FONT_KEY)) ? lsGet(FONT_KEY) : defaultFontId();
    applySignDialogText();
    ui.typeName.addEventListener("input", () => {
      lsSet(NAME_KEY, ui.typeName.value.trim());
      updateFontSamples();
    });
    dialog.querySelector("#signUndoStroke").addEventListener("click", () => {
      pad.strokes.pop();
      redrawPad();
    });
    dialog.querySelector("#signClearPad").addEventListener("click", () => {
      pad.strokes = [];
      redrawPad();
    });
    ui.uploadInput.addEventListener("change", () => {
      const file = ui.uploadInput.files?.[0];
      ui.uploadInput.value = "";
      if (file) useUpload(file);
    });
    const drop = dialog.querySelector("#signDrop");
    ["dragenter", "dragover"].forEach((type) =>
      drop.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
        drop.classList.add("over");
      })
    );
    ["dragleave", "drop"].forEach((type) =>
      drop.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
        drop.classList.remove("over");
      })
    );
    drop.addEventListener("drop", (e) => {
      const file = [...(e.dataTransfer?.files || [])].find((f) => /^image\/(png|jpeg)$/.test(f.type));
      if (file) useUpload(file);
      else setDialogError(t("Drop a PNG or JPG image"));
    });
    ui.removeBg.addEventListener("change", () => {
      if (upload.file) useUpload(upload.file);
    });
    ui.saveBtn.addEventListener("click", saveFromDialog);
    setupPad();
    setInk(lsGet("openpdf.signInk", "black"));
    setWidth(lsGet("openpdf.signWidth", "mid"));
  }

  /** (Re)write every piece of text in the sign dialog, e.g. after a language change. */
  function applySignDialogText() {
    const d = ui.dialog;
    if (!d) return;
    localize(d, signDialogTexts());
    d.querySelectorAll("[data-ink]").forEach((b) => {
      const label = t((INKS.find((i) => i.id === b.dataset.ink) || INKS[0]).label);
      b.title = label;
      b.setAttribute("aria-label", label);
    });
    d.querySelectorAll("[data-width]").forEach((b) => {
      const w = WIDTHS.find((x) => x.id === b.dataset.width) || WIDTHS[1];
      b.title = t(w.title);
      b.querySelector(".sign-width-label").textContent = t(w.label);
    });
    ui.uploadPreview.querySelector("img")?.setAttribute("alt", t("Signature preview"));
    renderFontButtons();
    renderDropText();
  }

  /** The font choices, in the order that suits the current language. */
  function renderFontButtons() {
    ui.fonts.replaceChildren(
      ...orderedFonts().map((font) =>
        h("button", {
          type: "button",
          class: "sign-font",
          role: "radio",
          "data-font": font.id,
          onclick: () => setFont(font.id, true),
        }, [
          h("span", { class: "sign-font-sample", style: `font-family:"OpenPDFSign-${font.id}", var(--font)` }),
          h("span", { class: "sign-font-name", text: t(font.label) }),
        ])
      )
    );
    setFont(fontId);
    updateFontSamples();
  }

  function renderDropText() {
    if (!ui.dropText) return;
    if (upload.busy) ui.dropText.textContent = t("Processing the image…");
    else if (upload.file && upload.picture)
      ui.dropText.textContent = t("{file} (click to choose another)", { file: upload.file.name });
    else ui.dropText.textContent = t("Choose a photo or image of your signature (PNG or JPG), or drop it here");
  }

  let currentTab = "draw";
  const upload = { file: null, picture: null, busy: false };

  function showTab(tab) {
    currentTab = tab;
    ui.dialog.querySelectorAll("[data-tab]").forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    ui.dialog.querySelectorAll("[data-pane]").forEach((p) => {
      p.hidden = p.dataset.pane !== tab;
    });
    const making = tab !== "library";
    ui.saveBtn.hidden = !making;
    ui.kind.hidden = !making;
    setDialogError("");
    if (tab === "draw") requestAnimationFrame(sizePad);
    if (tab === "type") {
      FONTS.forEach((f) => loadFont(f).then(updateFontSamples));
      updateFontSamples();
      setTimeout(() => ui.typeName.focus(), 0);
    }
    if (tab === "library") renderLibrary();
  }

  function setDialogError(message) {
    let el = ui.dialog.querySelector(".sign-error");
    if (!message) {
      el?.remove();
      return;
    }
    if (!el) {
      el = h("p", { class: "sign-error", role: "alert" });
      ui.dialog.querySelector(".sign-foot").before(el);
    }
    el.textContent = message;
  }

  let inkId = "black";
  let widthId = "mid";
  let fontId = defaultFontId();

  function inkColor() {
    return (INKS.find((i) => i.id === inkId) || INKS[0]).color;
  }

  function setInk(id) {
    inkId = INKS.some((i) => i.id === id) ? id : "black";
    lsSet("openpdf.signInk", inkId);
    ui.dialog.querySelectorAll("[data-ink]").forEach((b) => b.classList.toggle("active", b.dataset.ink === inkId));
    for (const stroke of pad.strokes) stroke.color = inkColor();
    redrawPad();
    updateFontSamples();
  }

  function setWidth(id) {
    widthId = WIDTHS.some((w) => w.id === id) ? id : "mid";
    lsSet("openpdf.signWidth", widthId);
    ui.dialog.querySelectorAll("[data-width]").forEach((b) => b.classList.toggle("active", b.dataset.width === widthId));
  }

  /** Select a font; `save` only when the user picked it, so the default can follow the language. */
  function setFont(id, save = false) {
    fontId = FONTS.some((f) => f.id === id) ? id : defaultFontId();
    if (save) lsSet(FONT_KEY, fontId);
    ui.fonts.querySelectorAll("[data-font]").forEach((b) => {
      const on = b.dataset.font === fontId;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });
  }

  function updateFontSamples() {
    const text = ui.typeName.value.trim() || tc("signature sample", "Your name");
    ui.fonts.querySelectorAll(".sign-font-sample").forEach((el) => {
      el.textContent = text;
      el.style.color = inkColor();
    });
  }

  // drawing pad: strokes are kept as points, so a stroke can be undone and the
  // signature redrawn sharply at a higher resolution when saved
  const pad = { strokes: [], current: null, cssW: 560, cssH: 200 };

  function setupPad() {
    const c = ui.pad;
    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      const p = padPoint(e);
      pad.current = { color: inkColor(), width: (WIDTHS.find((w) => w.id === widthId) || WIDTHS[1]).px, points: [p] };
      pad.strokes.push(pad.current);
      redrawPad();
    });
    c.addEventListener("pointermove", (e) => {
      if (!pad.current) return;
      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
      for (const ev of events.length ? events : [e]) pad.current.points.push(padPoint(ev));
      redrawPad();
    });
    const end = () => {
      pad.current = null;
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    window.addEventListener("resize", () => {
      if (ui.dialog?.open && currentTab === "draw") sizePad();
    });
  }

  function padPoint(e) {
    const r = ui.pad.getBoundingClientRect();
    const pressure = e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5;
    return { x: e.clientX - r.left, y: e.clientY - r.top, p: pressure, t: performance.now() };
  }

  function sizePad() {
    const c = ui.pad;
    const w = Math.max(200, Math.round(c.parentElement.clientWidth || 560));
    pad.cssW = w;
    pad.cssH = 200;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(w * ratio);
    c.height = Math.round(pad.cssH * ratio);
    c.style.width = `${w}px`;
    c.style.height = `${pad.cssH}px`;
    redrawPad();
  }

  function drawStrokes(ctx, strokes, scale) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of strokes) {
      const pts = s.points;
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0].x * scale, pts[0].y * scale, (s.width * scale) / 1.6, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      // width follows speed (fast = thinner) and pen pressure, smoothed
      let width = s.width;
      for (let i = 1; i < pts.length; i += 1) {
        const a = pts[i - 1];
        const b = pts[i];
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const dt = Math.max(1, b.t - a.t);
        const speed = dist / dt;
        const target = s.width * (0.6 + b.p * 0.8) * Math.max(0.55, Math.min(1.25, 1.3 - speed * 0.35));
        width = width * 0.7 + target * 0.3;
        const prevMid = i > 1 ? { x: (pts[i - 2].x + a.x) / 2, y: (pts[i - 2].y + a.y) / 2 } : a;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        ctx.lineWidth = width * scale;
        ctx.beginPath();
        ctx.moveTo(prevMid.x * scale, prevMid.y * scale);
        ctx.quadraticCurveTo(a.x * scale, a.y * scale, mid.x * scale, mid.y * scale);
        if (i === pts.length - 1) ctx.lineTo(b.x * scale, b.y * scale);
        ctx.stroke();
      }
    }
  }

  function redrawPad() {
    const c = ui.pad;
    if (!c) return;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    drawStrokes(ctx, pad.strokes, c.width / pad.cssW);
    ui.padHint.hidden = pad.strokes.length > 0;
  }

  async function padPicture() {
    if (!pad.strokes.length) return null;
    const scale = 3;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(pad.cssW * scale);
    canvas.height = Math.round(pad.cssH * scale);
    drawStrokes(canvas.getContext("2d"), pad.strokes, scale);
    return canvasToPicture(canvas);
  }

  async function useUpload(file) {
    upload.file = file;
    upload.picture = null;
    setDialogError("");
    upload.busy = true;
    renderDropText();
    try {
      upload.picture = await photoPicture(file, ui.removeBg.checked);
      ui.uploadPreview.replaceChildren(h("img", { src: URL.createObjectURL(upload.picture.blob), alt: t("Signature preview") }));
    } catch (err) {
      ui.uploadPreview.replaceChildren();
      setDialogError(String(err.message || err));
    } finally {
      upload.busy = false;
      renderDropText();
    }
  }

  function renderLibrary() {
    ui.library.replaceChildren();
    ui.count.textContent = sig.items.length ? String(sig.items.length) : "";
    if (!sig.items.length) {
      ui.library.append(h("p", { class: "sign-empty", text: t("No saved signatures yet. Make one with “Draw”, “Type” or “Upload image”.") }));
      return;
    }
    const def = defaultItem()?.id;
    for (const item of [...sig.items].reverse()) {
      const card = h("div", { class: `sign-item${item.id === sig.currentId ? " current" : ""}`, "data-id": item.id }, [
        h("button", {
          type: "button",
          class: "sign-item-use",
          title: t("Place on the page"),
          onclick: () => {
            ui.dialog.close();
            useItem(item.id);
          },
        }, [h("img", { src: urlFor(item), alt: item.kind === "initials" ? t("Initials") : t("Signature") })]),
        h("div", { class: "sign-item-bar" }, [
          h("span", { class: "sign-item-kind", text: item.kind === "initials" ? t("Initials") : t("Signature") }),
          item.id === def ? h("span", { class: "sign-item-default", text: t("Default") }) : null,
          h("span", { class: "sign-spacer" }),
          item.id === def
            ? null
            : h("button", {
                type: "button",
                class: "sign-item-btn",
                text: t("Set as default"),
                onclick: () => {
                  lsSet(DEFAULT_KEY, item.id);
                  renderLibrary();
                },
              }),
          h("button", {
            type: "button",
            class: "sign-item-btn danger",
            text: t("Delete"),
            onclick: async () => {
              await removeItem(item.id);
              renderLibrary();
              syncToolHint();
            },
          }),
        ]),
      ]);
      ui.library.append(card);
    }
  }

  async function saveFromDialog() {
    setDialogError("");
    let picture = null;
    try {
      if (currentTab === "draw") {
        picture = await padPicture();
        if (!picture) return setDialogError(t("Sign in the box first"));
      } else if (currentTab === "type") {
        const name = ui.typeName.value.trim();
        if (!name) return setDialogError(t("Type a name first"));
        const font = FONTS.find((f) => f.id === fontId) || FONTS.find((f) => f.id === defaultFontId());
        if (!(await loadFont(font))) return setDialogError(t("The font could not be loaded. Choose another font."));
        picture = await textPicture(name, `"OpenPDFSign-${font.id}"`, inkColor(), 140);
      } else if (currentTab === "upload") {
        picture = upload.picture;
        if (!picture) return setDialogError(t("Choose an image first"));
      }
    } catch (err) {
      return setDialogError(String(err.message || err));
    }
    if (!picture) return;
    const kind = ui.kind.querySelector("input:checked")?.value === "initials" ? "initials" : "signature";
    const item = await addItem(picture.blob, picture.w, picture.h, kind);
    pad.strokes = [];
    redrawPad();
    ui.dialog.close();
    useItem(item.id);
  }

  async function openSignDialog(tab) {
    if (!ui.dialog) buildSignDialog();
    await loadLibrary();
    if (!ui.typeName.value) ui.typeName.value = lsGet(NAME_KEY);
    showTab(tab || (sig.items.length ? "library" : "draw"));
    ui.count.textContent = sig.items.length ? String(sig.items.length) : "";
    if (!ui.dialog.open) ui.dialog.showModal();
    if (currentTab === "draw") requestAnimationFrame(sizePad);
  }

  // ------------------------------------------------------------ placing signatures

  function currentPicture() {
    return sig.oneShot || itemById(sig.currentId);
  }

  function useItem(id) {
    sig.currentId = id;
    sig.oneShot = null;
    if (state.editMode !== "sign") setEditMode("sign");
    else syncToolHint();
    setStatus(t("Signature: click the page to place it, then drag to move it or drag a corner to resize it"), "ok");
  }

  /** A one-time stamp of plain text; `kind` is "date" or "name". */
  async function useStamp(text, kind) {
    const picture = await stampPicture(text);
    if (!picture) return;
    if (sig.oneShot?.url) URL.revokeObjectURL(sig.oneShot.url);
    sig.oneShot = picture;
    if (state.editMode !== "sign") setEditMode("sign");
    else syncToolHint();
    setStatus(kind === "date" ? t("Date: click the page to place it") : t("Name: click the page to place it"), "ok");
  }

  async function enterSignMode() {
    await loadLibrary();
    if (state.editMode !== "sign") return;
    if (!itemById(sig.currentId)) sig.currentId = defaultItem()?.id || null;
    syncToolHint();
    const doc = activeDoc();
    if (doc) {
      ensureFormFieldsLoaded(doc)
        .then(() => renderOverlays())
        .catch(() => {});
    }
    renderOverlays();
    if (!currentPicture()) openSignDialog("draw");
  }

  function leaveSignMode() {
    sig.dsign = null;
    sig.selectedId = null;
    const doc = activeDoc();
    if (doc?.pendingSigns?.length) commitPending(doc);
    renderOverlays();
  }

  function shellFor(pageIndex) {
    return els.viewerPages.querySelector(`.page-shell[data-page="${pageIndex + 1}"]`);
  }

  /** Displayed page size in points, from the page placeholder (drawn or not). */
  function pageSize(shell) {
    const scale = Number(shell?.dataset.scale) || 1;
    const w = parseFloat(shell?.style.width) || shell?.offsetWidth || 612 * scale;
    const hgt = parseFloat(shell?.style.height) || shell?.offsetHeight || 792 * scale;
    return { width: w / scale, height: hgt / scale };
  }

  function clampToPage(item, size) {
    item.width = Math.min(item.width, size.width);
    item.height = Math.min(item.height, size.height);
    item.x = Math.max(0, Math.min(item.x, size.width - item.width));
    item.y = Math.max(0, Math.min(item.y, size.height - item.height));
    return item;
  }

  function emptySignatureFields(doc, pageIndex = null) {
    return (doc?.formFields || []).filter(
      (f) =>
        f.kind === "signature" &&
        !f.signed &&
        f.width > 0 &&
        f.height > 0 &&
        (pageIndex == null || f.pageIndex === pageIndex)
    );
  }

  function fitInto(picture, box, fill = 0.92) {
    const ratio = Math.min((box.width * fill) / picture.w, (box.height * fill) / picture.h);
    const width = picture.w * ratio;
    const height = picture.h * ratio;
    return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
  }

  function placePicture(doc, picture, pageIndex, px, py, shell) {
    const field = emptySignatureFields(doc, pageIndex).find(
      (f) => px >= f.x && px <= f.x + f.width && py >= f.y && py <= f.y + f.height
    );
    let box;
    if (field) {
      box = fitInto(picture, field);
    } else {
      let width;
      let height;
      if (picture.kind === "stamp") {
        height = 14;
        width = (picture.w / picture.h) * height;
      } else {
        width = picture.kind === "initials" ? 60 : 150;
        height = (picture.h / picture.w) * width;
        const maxH = picture.kind === "initials" ? 36 : 60;
        if (height > maxH) {
          height = maxH;
          width = (picture.w / picture.h) * height;
        }
      }
      box = { x: px - width / 2, y: py - height / 2, width, height };
    }
    const item = clampToPage(
      {
        id: crypto.randomUUID(),
        pageIndex,
        ...box,
        blob: picture.blob,
        url: picture.url || urlFor(picture),
        kind: picture.kind,
        field: field?.name || null,
      },
      pageSize(shell)
    );
    if (!doc.pendingSigns) doc.pendingSigns = [];
    doc.pendingSigns.push(item);
    doc.dirty = true;
    sig.selectedId = item.id;
    if (sig.oneShot) {
      // a date or name stamp is used once; the signature comes back
      sig.oneShot = null;
    }
    syncToolHint();
    renderOverlays();
    renderTabs();
    setStatus(
      field
        ? t("Signed in the signature field “{name}”. Press Enter or click “Done” to add it to the file.", { name: field.name })
        : t("Placed. Drag to move, drag a corner to resize, Delete to remove. Press Enter or click “Done” to add it to the file."),
      "ok"
    );
  }

  function removePending(id) {
    const doc = activeDoc();
    if (!doc?.pendingSigns) return;
    doc.pendingSigns = doc.pendingSigns.filter((p) => p.id !== id);
    if (sig.selectedId === id) sig.selectedId = null;
    syncToolHint();
    renderOverlays();
  }

  function copyToAllPages() {
    const doc = activeDoc();
    const src = doc?.pendingSigns?.find((p) => p.id === sig.selectedId);
    if (!src) {
      setStatus(t("Place a signature and select it first"), "error");
      return;
    }
    let added = 0;
    for (let i = 0; i < doc.pageCount; i += 1) {
      if (i === src.pageIndex) continue;
      if (doc.pendingSigns.some((p) => p.pageIndex === i && p.copyOf === src.id)) continue;
      const shell = shellFor(i);
      doc.pendingSigns.push(clampToPage({ ...src, id: crypto.randomUUID(), pageIndex: i, field: null, copyOf: src.id }, pageSize(shell)));
      added += 1;
    }
    renderOverlays();
    setStatus(
      added
        ? tn(added, "Copied to {n} other page. Press Enter or click “Done” to add it to the file.",
            "Copied to {n} other pages. Press Enter or click “Done” to add them to the file."
          )
        : t("Every page already has this signature"),
      "ok"
    );
  }

  let dragging = false;

  function renderOverlays() {
    if (dragging || !els?.viewerPages) return;
    els.viewerPages.querySelectorAll(".sign-pending, .sign-field-target, .sign-dsign-box").forEach((n) => n.remove());
    const doc = activeDoc();
    if (!doc || doc.contentView === "text") return;
    const editing = state.editMode === "sign";
    if (editing && !sig.dsign) {
      for (const field of emptySignatureFields(doc)) {
        const shell = shellFor(field.pageIndex);
        if (!shell) continue;
        const scale = Number(shell.dataset.scale) || 1;
        shell.appendChild(
          h("div", {
            class: "sign-field-target",
            style: `left:${field.x * scale}px;top:${field.y * scale}px;width:${field.width * scale}px;height:${field.height * scale}px`,
          }, [h("span", { text: t("Click here to sign") })])
        );
      }
    }
    for (const item of doc.pendingSigns || []) {
      const shell = shellFor(item.pageIndex);
      if (!shell) continue;
      shell.appendChild(buildPendingOverlay(item, shell, editing));
    }
  }

  function placeOverlay(el, item, scale) {
    el.style.left = `${item.x * scale}px`;
    el.style.top = `${item.y * scale}px`;
    el.style.width = `${item.width * scale}px`;
    el.style.height = `${item.height * scale}px`;
  }

  function buildPendingOverlay(item, shell, editing) {
    const scale = Number(shell.dataset.scale) || 1;
    const el = h("div", {
      class: `sign-pending${editing ? "" : " readonly"}${item.id === sig.selectedId && editing ? " selected" : ""}`,
      "data-sign-id": item.id,
      title: editing ? t("Drag to move, drag a corner to resize, Delete to remove") : t("Signature not yet added to the file"),
    }, [h("img", { src: item.url, alt: t("Signature"), draggable: "false" })]);
    placeOverlay(el, item, scale);
    if (!editing) return el;
    const del = h("button", {
      type: "button",
      class: "placement-delete-btn",
      title: t("Remove (Delete)"),
      "aria-label": t("Remove signature"),
      text: "×",
      onpointerdown: (e) => e.stopPropagation(),
      onmousedown: (e) => e.stopPropagation(),
      onclick: (e) => {
        e.stopPropagation();
        removePending(item.id);
      },
    });
    el.append(del);
    for (const dir of ["nw", "ne", "sw", "se"]) {
      el.append(h("span", { class: `sign-handle ${dir}`, "data-dir": dir }));
    }
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      sig.selectedId = item.id;
      els.viewerPages.querySelectorAll(".sign-pending.selected").forEach((n) => n.classList.remove("selected"));
      el.classList.add("selected");
      syncToolHint();
      const dir = e.target.closest(".sign-handle")?.dataset.dir || null;
      const start = { cx: e.clientX, cy: e.clientY, x: item.x, y: item.y, w: item.width, h: item.height };
      const size = pageSize(shell);
      const aspect = item.width / item.height;
      dragging = true;
      el.classList.add(dir ? "resizing" : "dragging");
      el.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dx = (ev.clientX - start.cx) / scale;
        const dy = (ev.clientY - start.cy) / scale;
        if (!dir) {
          item.x = Math.max(0, Math.min(start.x + dx, size.width - item.width));
          item.y = Math.max(0, Math.min(start.y + dy, size.height - item.height));
        } else {
          // keep the shape; the corner opposite the handle stays put
          const growX = dir.includes("e") ? dx : -dx;
          const growY = dir.includes("s") ? dy : -dy;
          let w = Math.max(12, start.w + Math.max(growX, growY * aspect));
          w = Math.min(w, size.width);
          let hh = w / aspect;
          if (hh > size.height) {
            hh = size.height;
            w = hh * aspect;
          }
          item.width = w;
          item.height = hh;
          item.x = dir.includes("w") ? start.x + start.w - w : start.x;
          item.y = dir.includes("n") ? start.y + start.h - hh : start.y;
          clampToPage(item, size);
        }
        placeOverlay(el, item, scale);
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        el.classList.remove("dragging", "resizing");
        dragging = false;
        item.field = null;
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
    return el;
  }

  /** Called by the page's mousedown handler while the signature tool is on. */
  function pageMouseDown(ev, shell, meta) {
    if (ev.target.closest(".sign-pending")) return;
    const doc = activeDoc();
    if (!doc) return;
    ev.preventDefault();
    if (sig.dsign) {
      startDsignDrag(ev, shell, meta);
      return;
    }
    const picture = currentPicture();
    if (!picture) {
      openSignDialog("draw");
      return;
    }
    const r = shell.getBoundingClientRect();
    const scale = Number(shell.dataset.scale) || meta.scale || 1;
    placePicture(doc, picture, meta.pageIndex, (ev.clientX - r.left) / scale, (ev.clientY - r.top) / scale, shell);
  }

  /** Write every placed signature into the PDF, in one edit. */
  async function commitPending(doc) {
    if (!doc?.pendingSigns?.length) return;
    if (doc._signCommit) return doc._signCommit;
    const items = doc.pendingSigns.slice();
    const blobs = [];
    const index = new Map();
    const placements = items.map((p) => {
      if (!index.has(p.blob)) {
        index.set(p.blob, blobs.length);
        blobs.push(p.blob);
      }
      return { page: p.pageIndex, x: p.x, y: p.y, width: p.width, height: p.height, image: index.get(p.blob) };
    });
    const pages = [...new Set(items.map((p) => p.pageIndex + 1))];
    const mode = lsGet(MODE_KEY) === "annotation" ? "annotation" : "flatten";
    doc._signCommit = (async () => {
      try {
        setStatus(tn(items.length, "Adding the signature to the file…", "Adding {n} signatures to the file…"));
        const result = await queueDocMutation(doc, () => {
          const fd = new FormData();
          appendDocToForm(fd, doc);
          blobs.forEach((b, i) => fd.append("images", b, `signature${i}.png`));
          fd.append("placements", JSON.stringify(placements));
          fd.append("mode", mode);
          return apiPost("/v1/pdf/stamp-signatures", fd);
        });
        doc.dirty = true;
        recordServerStep(
          doc,
          result,
          // the label is shown later (undo tooltip): give it in a form that follows the language
          items.length > 1 ? () => tn(items.length, "{n} signature", "{n} signatures") : N_("Signature"),
          pages
        );
        pages.forEach((n) => markPageStale(doc, n));
        await refreshStalePages(doc, { background: true, silent: true });
        const done = new Set(items.map((p) => p.id));
        doc.pendingSigns = (doc.pendingSigns || []).filter((p) => !done.has(p.id));
        if (done.has(sig.selectedId)) sig.selectedId = null;
        doc.formFields = null; // signature fields may now be covered
        renderOverlays();
        syncToolHint();
        setStatus(
          items.length > 1
            ? tn(items.length, "{n} signature added to the file", "{n} signatures added to the file")
            : t("Signature added to the file"),
          "ok"
        );
      } catch (err) {
        setStatus(t("Could not add the signature: {error}", { error: err.message || err }), "error");
        throw err;
      } finally {
        doc._signCommit = null;
      }
    })();
    return doc._signCommit;
  }

  // ------------------------------------------------------------ the bar above the page

  function buildHint(container) {
    const hintSpan = container.querySelector("span");
    if (sig.dsign) {
      if (hintSpan) hintSpan.textContent = t("Digital signature: drag on the page to mark where it goes (Esc to cancel)");
      container.append(
        h("button", { type: "button", class: "tool-hint-action", text: t("Cancel"), onclick: cancelDsign })
      );
      return;
    }
    const picture = currentPicture();
    const chip = h("button", {
      type: "button",
      class: "sign-chip",
      title: t("Change signature"),
      onclick: () => openSignDialog("library"),
    }, picture ? [h("img", { src: picture.url || urlFor(picture), alt: t("Current signature") })] : [h("span", { text: t("Choose signature") })]);
    if (sig.oneShot) chip.classList.add("stamp");
    const pendingCount = activeDoc()?.pendingSigns?.length || 0;
    container.append(
      chip,
      h("button", { type: "button", class: "tool-hint-action", text: t("New signature"), onclick: () => openSignDialog("draw") }),
      h("button", { type: "button", class: "tool-hint-action", text: t("Date"), title: t("Place today’s date"), onclick: () => useStamp(todayText(), "date") }),
      h("button", {
        type: "button",
        class: "tool-hint-action",
        text: t("Name"),
        title: t("Place your name in plain type"),
        onclick: () => {
          const name = lsGet(NAME_KEY);
          if (name) useStamp(name, "name");
          else {
            openSignDialog("type");
            setStatus(t("Enter your name on the “Type” tab first"), "ok");
          }
        },
      }),
      h("button", {
        type: "button",
        class: "tool-hint-action",
        text: t("Sign every page"),
        title: t("Copy the selected signature to the same spot on every page"),
        disabled: !sig.selectedId,
        onclick: copyToAllPages,
      }),
      h("span", { class: "tool-hint-sep", "aria-hidden": "true" }),
      h("button", {
        type: "button",
        class: "tool-hint-action",
        text: t("Digital signature…"),
        title: t("Sign with a certificate so others can check that the file has not been changed"),
        onclick: () => openDigitalDialog(),
      })
    );
    if (pendingCount && hintSpan) {
      hintSpan.textContent = tn(pendingCount, "{n} signature not yet added (press Enter to add)",
        "{n} signatures not yet added (press Enter to add)"
      );
    }
  }

  // ------------------------------------------------------------ digital signature

  const dui = {};

  /** The fixed text of the digital signature dialog, in the current language. */
  function digitalDialogTexts() {
    return {
      title: t("Digital signature"),
      intro: t("With a digital signature, anyone can check whether the file was changed after signing. Editing the file after signing makes the signature invalid, so sign as the last step."),
      cert: t("Certificate"),
      import: t("Import…"),
      create: t("Create personal certificate…"),
      password: t("Certificate password"),
      passwordPlaceholder: t("Used only for this signature; not saved"),
      where: t("Where to sign"),
      useImage: t("Show my handwritten signature in the signature box"),
      reason: t("Reason (optional)"),
      reasonPlaceholder: t("For example: I agree to the terms above"),
      location: t("Location (optional)"),
      tsa: t("Add a trusted timestamp (needs an internet connection)"),
      cancel: t("Cancel"),
      sign: t("Sign"),
    };
  }

  function buildDigitalDialog() {
    const dialog = document.createElement("dialog");
    dialog.className = "modal";
    dialog.id = "dsignDialog";
    // the text is filled in by localize()
    dialog.innerHTML = `
      <form method="dialog" class="modal-card dsign-card">
        <h2 data-l10n="title"></h2>
        <p class="field-hint dsign-intro" data-l10n="intro"></p>
        <label for="dsignCert" data-l10n="cert"></label>
        <div class="dsign-cert-row">
          <select id="dsignCert"></select>
          <button type="button" class="ghost-btn" id="dsignImport" data-l10n="import"></button>
          <button type="button" class="ghost-btn" id="dsignCreate" data-l10n="create"></button>
        </div>
        <input type="file" id="dsignFile" accept=".p12,.pfx,application/x-pkcs12" hidden />
        <div class="dsign-cert-info" id="dsignCertInfo"></div>
        <label for="dsignPassword" data-l10n="password"></label>
        <input type="password" id="dsignPassword" autocomplete="off" data-l10n-placeholder="passwordPlaceholder" />
        <fieldset class="choice-group" id="dsignWhere"><legend data-l10n="where"></legend></fieldset>
        <label class="sign-check" id="dsignImageRow"><input type="checkbox" id="dsignUseImage" checked /> <span data-l10n="useImage"></span></label>
        <div class="dsign-two">
          <div><label for="dsignReason" data-l10n="reason"></label><input type="text" id="dsignReason" maxlength="120" data-l10n-placeholder="reasonPlaceholder" /></div>
          <div><label for="dsignLocation" data-l10n="location"></label><input type="text" id="dsignLocation" maxlength="120" /></div>
        </div>
        <label class="sign-check"><input type="checkbox" id="dsignTsa" /> <span data-l10n="tsa"></span></label>
        <input type="text" id="dsignTsaUrl" placeholder="${DEFAULT_TSA}" hidden />
        <p class="sign-error" id="dsignError" role="alert" hidden></p>
        <menu class="modal-actions">
          <button type="button" class="ghost-btn" id="dsignCancel" data-l10n="cancel"></button>
          <button type="button" class="primary-btn" id="dsignGo" data-l10n="sign"></button>
        </menu>
      </form>`;
    localize(dialog, digitalDialogTexts());
    document.body.appendChild(dialog);
    dui.dialog = dialog;
    for (const id of ["dsignCert", "dsignImport", "dsignCreate", "dsignFile", "dsignCertInfo", "dsignPassword", "dsignWhere", "dsignImageRow", "dsignUseImage", "dsignReason", "dsignLocation", "dsignTsa", "dsignTsaUrl", "dsignError", "dsignGo"]) {
      dui[id] = dialog.querySelector(`#${id}`);
    }
    dialog.addEventListener("keydown", (e) => e.stopPropagation());
    dialog.querySelector("#dsignCancel").addEventListener("click", () => dialog.close());
    dui.dsignImport.addEventListener("click", () => dui.dsignFile.click());
    dui.dsignFile.addEventListener("change", async () => {
      const file = dui.dsignFile.files?.[0];
      dui.dsignFile.value = "";
      if (!file) return;
      const record = {
        id: crypto.randomUUID(),
        label: file.name.replace(/\.(p12|pfx)$/i, ""),
        fileName: file.name,
        blob: file.slice(0, file.size, "application/x-pkcs12"),
        info: null,
        created: Date.now(),
      };
      sig.certs.push(record);
      await dbPut("certs", record);
      fillCerts(record.id);
      dui.dsignPassword.value = "";
      dui.dsignPassword.focus();
    });
    dui.dsignCreate.addEventListener("click", createPersonalCert);
    dui.dsignCert.addEventListener("change", () => {
      dui.dsignPassword.value = "";
      showCertInfo();
    });
    dui.dsignPassword.addEventListener("change", checkCertPassword);
    dui.dsignTsa.addEventListener("change", () => {
      dui.dsignTsaUrl.hidden = !dui.dsignTsa.checked;
      if (dui.dsignTsa.checked && !dui.dsignTsaUrl.value) dui.dsignTsaUrl.value = lsGet(TSA_KEY, DEFAULT_TSA);
    });
    dui.dsignGo.addEventListener("click", startDigitalSign);
  }

  function selectedCert() {
    return sig.certs.find((c) => c.id === dui.dsignCert.value) || null;
  }

  function fillCerts(selectId) {
    dui.dsignCert.replaceChildren();
    if (!sig.certs.length) {
      dui.dsignCert.append(
        h("option", { value: "", text: t("No certificates yet: import a .p12 or .pfx file, or create a personal certificate") })
      );
    }
    for (const cert of [...sig.certs].reverse()) {
      dui.dsignCert.append(
        h("option", {
          value: cert.id,
          text: cert.info?.name ? t("{name} ({label})", { name: cert.info.name, label: cert.label }) : cert.label,
        })
      );
    }
    if (selectId) dui.dsignCert.value = selectId;
    showCertInfo();
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(I18N.lang);
  }

  function showCertInfo() {
    const cert = selectedCert();
    const box = dui.dsignCertInfo;
    box.replaceChildren();
    if (!cert) return;
    const info = cert.info;
    const lines = [];
    if (info) {
      const who = `${info.name}${info.email ? ` <${info.email}>` : ""}${info.organization ? ` · ${info.organization}` : ""}`;
      lines.push(t("Signer: {name}", { name: who }));
      lines.push(
        t("Issuer: {issuer}", {
          issuer: info.selfSigned ? t("Self-signed (a personal certificate: others cannot confirm your identity)") : info.issuer,
        })
      );
      const dates = { from: fmtDate(info.notBefore), to: fmtDate(info.notAfter) };
      lines.push(
        info.currentlyValid
          ? t("Valid from {from} to {to}", dates)
          : t("Valid from {from} to {to} (expired or not yet valid)", dates)
      );
    } else {
      lines.push(t("File: {file} (enter the password to see the certificate details)", { file: cert.fileName }));
    }
    for (const line of lines) box.append(h("div", { text: line }));
    box.append(
      h("div", { class: "dsign-cert-actions" }, [
        h("button", {
          type: "button",
          class: "link-btn",
          text: t("Back up certificate file"),
          onclick: () => downloadBlob(cert.blob, cert.fileName || `${cert.label}.p12`),
        }),
        h("button", {
          type: "button",
          class: "link-btn danger",
          text: t("Remove from list"),
          onclick: async () => {
            const question = t("Remove this certificate from the list? The certificate file itself is not affected. Back up a personal certificate first.");
            if (!window.confirm(question)) return;
            sig.certs = sig.certs.filter((c) => c.id !== cert.id);
            await dbDelete("certs", cert.id);
            fillCerts();
          },
        }),
      ])
    );
  }

  async function checkCertPassword() {
    const cert = selectedCert();
    if (!cert) return false;
    const fd = new FormData();
    fd.append("cert", cert.blob, cert.fileName || "cert.p12");
    fd.append("cert_password", dui.dsignPassword.value);
    try {
      const info = await apiPost("/v1/pdf/cert-info", fd);
      cert.info = info;
      await dbPut("certs", cert);
      const keep = cert.id;
      fillCerts(keep);
      dsignError("");
      return true;
    } catch (err) {
      dsignError(String(err.message || err));
      return false;
    }
  }

  function dsignError(message) {
    dui.dsignError.textContent = message || "";
    dui.dsignError.hidden = !message;
  }

  async function createPersonalCert() {
    const esc = escapeAttr;
    const data = await showToolDialog(
      t("Create personal certificate"),
      `<p class="field-hint">${esc(t("This makes a signing certificate just for you, stored on this computer. It proves the file has not been changed since you signed it, but other people’s PDF readers will show “identity not verified”. For official documents, use a certificate issued by a trusted organization."))}</p>
       <label for="certName">${esc(t("Name"))}</label>
       <input id="certName" data-field="name" type="text" maxlength="60" value="${esc(lsGet(NAME_KEY))}" required />
       <label for="certEmail">${esc(t("Email (optional)"))}</label>
       <input id="certEmail" data-field="email" type="text" maxlength="120" />
       <label for="certOrg">${esc(t("Organization (optional)"))}</label>
       <input id="certOrg" data-field="organization" type="text" maxlength="120" />
       <label for="certPw">${esc(t("Certificate password (at least 4 characters; you will need it to sign)"))}</label>
       <input id="certPw" data-field="password" type="password" autocomplete="new-password" />
       <label for="certPw2">${esc(t("Repeat the password"))}</label>
       <input id="certPw2" data-field="password2" type="password" autocomplete="new-password" />`
    );
    if (!data) return;
    if (!data.name.trim()) return dsignError(t("Enter your name"));
    if (data.password.length < 4) return dsignError(t("The certificate password must be at least 4 characters"));
    if (data.password !== data.password2) return dsignError(t("The passwords do not match"));
    const fd = new FormData();
    fd.append("name", data.name.trim());
    fd.append("email", data.email.trim());
    fd.append("organization", data.organization.trim());
    fd.append("cert_password", data.password);
    try {
      dsignError("");
      setStatus(t("Creating the certificate…"));
      const { blob } = await apiPost("/v1/pdf/generate-cert", fd);
      const record = {
        id: crypto.randomUUID(),
        label: t("Personal certificate"),
        fileName: t("{name} - personal certificate.p12", { name: data.name.trim() }),
        blob,
        info: null,
        created: Date.now(),
      };
      sig.certs.push(record);
      await dbPut("certs", record);
      fillCerts(record.id);
      dui.dsignPassword.value = data.password;
      await checkCertPassword();
      setStatus(t("Personal certificate created. Use “Back up certificate file” to keep a copy."), "ok");
    } catch (err) {
      dsignError(String(err.message || err));
    }
  }

  function escapeAttr(value) {
    return String(value || "").replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]);
  }

  async function openDigitalDialog() {
    const doc = activeDoc();
    if (!doc) return;
    if (!dui.dialog) buildDigitalDialog();
    await loadLibrary();
    await ensureFormFieldsLoaded(doc).catch(() => {});
    fillCerts(dui.dsignCert.value || sig.certs[sig.certs.length - 1]?.id);
    dsignError("");
    dui.dsignPassword.value = dui.dsignPassword.value || "";
    renderWhere(doc, null);
    const hasPicture = !!itemById(sig.currentId) || !!defaultItem();
    dui.dsignImageRow.hidden = !hasPicture;
    if (!dui.dialog.open) dui.dialog.showModal();
    (sig.certs.length ? dui.dsignPassword : dui.dsignCreate).focus();
  }

  /** The "Where to sign" choices; `keep` is the value to leave selected (else the first). */
  function renderWhere(doc, keep) {
    const where = dui.dsignWhere;
    where.querySelectorAll(".choice").forEach((n) => n.remove());
    const fields = emptySignatureFields(doc);
    const options = [
      ...fields.map((f) => ({
        value: `field:${f.name}`,
        title: t("Signature field “{name}”", { name: f.name }),
        note: t("Page {page}", { page: f.pageIndex + 1 }),
      })),
      {
        value: "drag",
        title: t("Drag out a box on the page"),
        note: t("The box shows the signer and the date, and can include your handwritten signature"),
      },
      { value: "invisible", title: t("Not shown on the page"), note: t("Visible only in the signature panel of a PDF reader") },
    ];
    const selected = options.some((o) => o.value === keep) ? keep : options[0].value;
    options.forEach((o) => {
      where.append(
        h("label", { class: "choice" }, [
          h("input", { type: "radio", name: "dsignWhere", value: o.value, checked: o.value === selected }),
          h("span", {}, [h("strong", { text: o.title }), h("small", { text: o.note })]),
        ])
      );
    });
  }

  function collectDsignOptions() {
    const cert = selectedCert();
    if (!cert) {
      dsignError(t("Import a certificate or create a personal certificate first"));
      return null;
    }
    const where = dui.dsignWhere.querySelector("input:checked")?.value || "drag";
    const tsaUrl = dui.dsignTsa.checked ? dui.dsignTsaUrl.value.trim() || DEFAULT_TSA : "";
    if (tsaUrl) lsSet(TSA_KEY, tsaUrl);
    const picture = dui.dsignUseImage.checked && !dui.dsignImageRow.hidden ? itemById(sig.currentId) || defaultItem() : null;
    return {
      cert,
      password: dui.dsignPassword.value,
      where,
      reason: dui.dsignReason.value.trim(),
      location: dui.dsignLocation.value.trim(),
      tsaUrl,
      image: picture?.blob || null,
    };
  }

  async function startDigitalSign() {
    const options = collectDsignOptions();
    if (!options) return;
    dsignError("");
    // check the password before the user drags a box for nothing
    dui.dsignGo.disabled = true;
    const ok = await checkCertPassword().finally(() => {
      dui.dsignGo.disabled = false;
    });
    if (!ok) return;
    if (selectedCert()?.info && !selectedCert().info.currentlyValid) {
      dsignError(t("This certificate has expired or is not yet valid, so it cannot be used to sign"));
      return;
    }
    dui.dialog.close();
    const doc = activeDoc();
    if (!doc) return;
    if (options.where === "drag") {
      sig.dsign = { options };
      if (state.editMode !== "sign") setEditMode("sign");
      syncToolHint();
      renderOverlays();
      setStatus(t("Digital signature: drag on the page to mark where it goes"), "ok");
      return;
    }
    await runDigitalSign(doc, options, null);
  }

  function cancelDsign() {
    sig.dsign = null;
    syncToolHint();
    renderOverlays();
    setStatus(t("Digital signature canceled"));
  }

  function startDsignDrag(ev, shell, meta) {
    const r = shell.getBoundingClientRect();
    const sx = ev.clientX - r.left;
    const sy = ev.clientY - r.top;
    const box = h("div", { class: "sign-dsign-box" });
    shell.appendChild(box);
    const scale = Number(shell.dataset.scale) || meta.scale || 1;
    const layout = (x, y) => {
      box.style.left = `${Math.min(sx, x)}px`;
      box.style.top = `${Math.min(sy, y)}px`;
      box.style.width = `${Math.abs(x - sx)}px`;
      box.style.height = `${Math.abs(y - sy)}px`;
    };
    layout(sx, sy);
    const move = (e) => layout(e.clientX - r.left, e.clientY - r.top);
    const up = async (e) => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      box.remove();
      let rect = {
        x: Math.min(sx, x) / scale,
        y: Math.min(sy, y) / scale,
        width: Math.abs(x - sx) / scale,
        height: Math.abs(y - sy) / scale,
      };
      if (rect.width < 30 || rect.height < 14) {
        // a click: a box of the usual size, centered on it
        rect = { x: sx / scale - 100, y: sy / scale - 30, width: 200, height: 60 };
      }
      clampToPage(rect, pageSize(shell));
      const options = sig.dsign?.options;
      sig.dsign = null;
      if (!options) return;
      await runDigitalSign(activeDoc(), options, { pageIndex: meta.pageIndex, ...rect });
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  async function runDigitalSign(doc, options, rect) {
    if (!doc) return;
    setBusy(true, t("Digital signature"));
    try {
      // everything else goes into the file first: edits after signing break the signature
      await commitPending(doc);
      // (a file signed before only needs this when text boxes really changed)
      if (doc.placementsDirty || (!doc.signatures?.length && (doc.placedTexts?.length || doc.callouts?.length))) {
        await embedPlacementsIntoSession(doc);
        doc.placementsDirty = false;
      }
      if (doc.formFields?.length && formsPanelOpen()) await persistFormFieldValues(doc);
      await waitForDocMutations(doc);
      setStatus(t("Adding the digital signature…"));
      const fieldName = options.where.startsWith("field:") ? options.where.slice(6) : "";
      const result = await queueDocMutation(
        doc,
        () => {
          const fd = new FormData();
          appendDocToForm(fd, doc);
          fd.append("cert", options.cert.blob, options.cert.fileName || "cert.p12");
          fd.append("cert_password", options.password);
          fd.append("reason", options.reason);
          fd.append("location", options.location);
          if (options.tsaUrl) fd.append("tsa_url", options.tsaUrl);
          if (options.image) fd.append("image", options.image, "signature.png");
          if (fieldName) {
            fd.append("field_name", fieldName);
          } else if (rect) {
            fd.append("visible", "true");
            fd.append("page_index", String(rect.pageIndex));
            fd.append("x", String(rect.x));
            fd.append("y", String(rect.y));
            fd.append("width", String(rect.width));
            fd.append("height", String(rect.height));
          } else {
            fd.append("visible", "false");
          }
          return apiPost("/v1/pdf/digital-sign", fd);
        },
        { allowSigned: true }
      );
      doc.dirty = true;
      const field = fieldName ? (doc.formFields || []).find((f) => f.name === fieldName) : null;
      const page = rect ? rect.pageIndex + 1 : field ? field.pageIndex + 1 : doc.pageNum;
      recordServerStep(doc, result, N_("Digital signature"), [page]);
      doc.formFields = null;
      markPageStale(doc, page);
      await refreshStalePages(doc, { background: true, silent: true });
      await recheck(doc, { force: true });
      if (state.editMode === "sign") setEditMode("select");
      setStatus(t("Digitally signed. Press Ctrl+S to save it to the file, and make no other changes before saving."), "ok");
      showToast(t("Digitally signed. It takes effect when you save."), { type: "ok" });
    } catch (err) {
      const message = t("Digital signing failed: {error}", { error: err.message || err });
      setStatus(message, "error");
      showToast(message, { type: "error" });
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------ signed files

  /** Look for signature dictionaries in the bytes without parsing the file. */
  async function looksSigned(blob) {
    if (!blob) return false;
    const needle = "/ByteRange";
    const chunk = 4 * 1024 * 1024;
    const decoder = new TextDecoder("latin1");
    for (let start = 0; start < blob.size; start += chunk - needle.length) {
      const text = decoder.decode(await blob.slice(start, start + chunk).arrayBuffer());
      if (text.includes(needle)) return true;
    }
    return false;
  }

  async function verifyDoc(doc) {
    const data = await withDocSession(doc, () => {
      const fd = new FormData();
      appendDocToForm(fd, doc);
      return apiPost("/v1/pdf/verify-signatures", fd);
    });
    return Array.isArray(data?.signatures) ? data.signatures : [];
  }

  /** Re-read the signature status (after opening, signing, or editing a signed file). */
  async function recheck(doc, { force = false } = {}) {
    if (!doc) return;
    if (!force && !doc.signatures?.length && !(await looksSigned(doc.blob || doc.file))) {
      doc.signatures = [];
      renderBanner();
      return;
    }
    try {
      await doc._registerPromise;
      doc.signatures = await verifyDoc(doc);
    } catch (_) {
      doc.signatures = doc.signatures || [];
    }
    doc._signedEditOk = false;
    renderBanner();
  }

  let recheckTimer = null;
  function scheduleRecheck(doc) {
    if (!doc?.signatures?.length) return;
    clearTimeout(recheckTimer);
    recheckTimer = setTimeout(() => recheck(doc), 600);
  }

  function summary(signatures) {
    const n = signatures.length;
    const bad = signatures.filter((s) => s.status === "invalid").length;
    const last = signatures[n - 1];
    if (bad) {
      return {
        level: "bad",
        text: tn(n, "{n} digital signature · {bad} invalid", "{n} digital signatures · {bad} invalid", { bad }),
      };
    }
    if (last && last.coversWholeFile === false) {
      return {
        level: "warn",
        text: tn(n, "{n} digital signature · the document was changed after signing",
          "{n} digital signatures · the document was changed after signing"
        ),
      };
    }
    if (signatures.some((s) => s.status === "untrusted" || s.status === "warning")) {
      return {
        level: "info",
        text: tn(n, "{n} digital signature · document unchanged (identity not verified)",
          "{n} digital signatures · document unchanged (identity not verified)"
        ),
      };
    }
    return { level: "ok", text: tn(n, "{n} digital signature · valid", "{n} digital signatures · valid") };
  }

  function renderBanner() {
    let banner = document.getElementById("sigBanner");
    const doc = activeDoc();
    const list = doc?.signatures || [];
    if (!list.length || doc.contentView === "text") {
      banner?.remove();
      return;
    }
    if (!banner) {
      banner = h("button", { type: "button", id: "sigBanner", class: "sig-banner", onclick: () => openInfoDialog() });
      document.querySelector(".viewer-wrap")?.appendChild(banner);
    }
    const s = summary(list);
    banner.dataset.level = s.level;
    banner.replaceChildren(
      h("span", { class: "sig-banner-icon", "aria-hidden": "true", text: s.level === "bad" ? "!" : "✓" }),
      h("span", { text: s.text })
    );
    banner.title = t("Show signature details");
  }

  let infoDialog = null;

  /** The fixed text of the signature details dialog, in the current language. */
  function infoDialogTexts() {
    return {
      title: t("Digital signatures"),
      close: t("Close"),
      hint: t("“Identity not verified” means the certificate was not issued by a trusted authority (a personal certificate, for example); the document itself has not been changed. Whether a certificate has been revoked is not checked online here."),
    };
  }

  function statusLabel(status) {
    switch (status) {
      case "valid":
        return t("Valid");
      case "untrusted":
        return t("Document unchanged · identity not verified");
      case "warning":
        return t("Needs attention");
      case "unsupported":
        return t("Cannot be verified");
      default:
        return t("Invalid");
    }
  }

  function openInfoDialog() {
    const doc = activeDoc();
    if (!doc) return;
    if (!infoDialog) {
      infoDialog = document.createElement("dialog");
      infoDialog.className = "modal modal-wide";
      infoDialog.id = "sigInfoDialog";
      infoDialog.innerHTML = `<div class="modal-card sig-info-card">
          <div class="sign-head"><h2 data-l10n="title"></h2>
          <button type="button" class="icon-btn" data-close data-l10n-title="close" data-l10n-aria-label="close" data-icon="x" data-icon-size="16"></button></div>
          <div id="sigInfoList" class="sig-info-list"></div>
          <p class="field-hint" data-l10n="hint"></p>
        </div>`;
      localize(infoDialog, infoDialogTexts());
      document.body.appendChild(infoDialog);
      window.PdfIcons?.hydrate(infoDialog);
      infoDialog.querySelector("[data-close]").addEventListener("click", () => infoDialog.close());
    }
    renderInfoList(doc);
    if (!infoDialog.open) infoDialog.showModal();
  }

  function renderInfoList(doc) {
    const listEl = infoDialog.querySelector("#sigInfoList");
    listEl.replaceChildren();
    const sigs = doc?.signatures || [];
    sigs.forEach((s, i) => {
      const later = s.coversWholeFile === false;
      const level = s.status === "invalid" ? "bad" : s.status === "valid" ? "ok" : "info";
      const when = s.timeStampDate || s.signDate;
      const time = when ? new Date(when).toLocaleString(I18N.lang) : "";
      const cert = s.certificate || {};
      listEl.append(
        h("div", { class: "sig-info-item", "data-level": level }, [
          h("div", { class: "sig-info-top" }, [
            h("strong", { text: `${i + 1}. ${s.name || cert.name || t("Unknown signer")}` }),
            h("span", { class: "sig-info-status", text: statusLabel(s.status) }),
          ]),
          h("div", { class: "sig-info-msg", text: s.message || "" }),
          h("div", { class: "sig-info-meta", text: [
            when
              ? s.timeStamped
                ? t("Time: {time} (trusted timestamp)", { time })
                : t("Time: {time} (signer’s computer clock)", { time })
              : "",
            s.reason ? t("Reason: {reason}", { reason: s.reason }) : "",
            s.location ? t("Location: {location}", { location: s.location }) : "",
          ].filter(Boolean).join(" · ") }),
          cert.name
            ? h("div", {
                class: "sig-info-meta",
                text: t("Certificate: {name} · Issuer: {issuer} · Valid until {date}", {
                  name: `${cert.name}${cert.email ? ` <${cert.email}>` : ""}`,
                  issuer: cert.selfSigned ? t("Self-signed") : cert.issuer,
                  date: fmtDate(cert.notAfter),
                }),
              })
            : null,
          later && i < sigs.length - 1
            ? h("div", { class: "sig-info-meta", text: t("The document was revised after this signature (for example, by a later signature).") })
            : null,
          later && i === sigs.length - 1
            ? h("div", { class: "sig-info-warn", text: t("The document was changed after signing. The signature covers only the content as it was when signed.") })
            : null,
          s.page != null
            ? h("button", {
                type: "button",
                class: "link-btn",
                text: t("Go to page {page}", { page: s.page + 1 }),
                onclick: () => {
                  infoDialog.close();
                  goToPage(s.page + 1);
                },
              })
            : null,
        ])
      );
    });
  }

  /**
   * Before any edit to a file that carries digital signatures. Asked once per
   * signed state; saying no cancels the edit.
   */
  async function guardEdit(doc) {
    if (!doc?.signatures?.length || doc._signedEditOk) return;
    if (doc.signatures.every((s) => s.status === "invalid")) return;
    const ok = window.confirm(
      t("This document has a digital signature. If you change it, the existing signatures will show as “changed after signing” or become invalid.\n\nChange it anyway? (You can use “Undo” to go back to the signed version.)")
    );
    if (!ok) {
      const err = new Error(t("Canceled: the document has a digital signature and was not changed"));
      err.cancelled = true;
      throw err;
    }
    doc._signedEditOk = true;
  }

  // ------------------------------------------------------------ wiring

  function onKeyDown(e) {
    if (state.editMode !== "sign") return;
    if (ui.dialog?.open || dui.dialog?.open || infoDialog?.open || els.toolDialog?.open) return;
    const active = document.activeElement;
    if (active && (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || active.isContentEditable)) return;
    const doc = activeDoc();
    if (e.key === "Escape" && sig.dsign) {
      e.preventDefault();
      e.stopImmediatePropagation();
      cancelDsign();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && sig.selectedId && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      removePending(sig.selectedId);
      return;
    }
    if (e.key === "Enter" && doc?.pendingSigns?.length) {
      e.preventDefault();
      e.stopImmediatePropagation();
      commitPending(doc).catch(() => {});
    }
  }

  function wireSettings() {
    const radios = document.querySelectorAll('input[name="signWriteMode"]');
    const mode = lsGet(MODE_KEY) === "annotation" ? "annotation" : "flatten";
    radios.forEach((r) => {
      r.checked = r.value === mode;
      r.addEventListener("change", () => {
        if (r.checked) lsSet(MODE_KEY, r.value === "annotation" ? "annotation" : "");
      });
    });
  }

  /** The interface language changed: rewrite whatever this file has put on screen. */
  function onLanguageChange() {
    if (ui.dialog) {
      // without a font picked by the user, the default (and the order) follows the language
      if (!FONTS.some((f) => f.id === lsGet(FONT_KEY))) fontId = defaultFontId();
      applySignDialogText();
      renderLibrary();
    }
    if (dui.dialog) {
      localize(dui.dialog, digitalDialogTexts());
      fillCerts(dui.dsignCert.value);
      const doc = activeDoc();
      if (dui.dialog.open && doc) renderWhere(doc, dui.dsignWhere.querySelector("input:checked")?.value || null);
    }
    if (infoDialog) {
      localize(infoDialog, infoDialogTexts());
      if (infoDialog.open) renderInfoList(activeDoc());
    }
    renderBanner();
    renderOverlays();
    if (state.editMode === "sign") syncToolHint();
  }

  function init() {
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("i18n:change", onLanguageChange);
    wireSettings();
    loadLibrary();
  }

  window.OpenPDFSign = {
    enterSignMode,
    leaveSignMode,
    buildHint,
    pageMouseDown,
    renderOverlays,
    commitPending,
    hasPending: (doc) => !!doc?.pendingSigns?.length,
    onDocOpened: (doc) => recheck(doc),
    onDocChanged: (doc) => scheduleRecheck(doc),
    renderBanner,
    guardEdit,
    openSignDialog,
    openDigitalDialog,
    openInfoDialog,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
