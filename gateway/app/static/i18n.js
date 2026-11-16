/*
 * Interface languages.
 *
 * The code and index.html are written in English. Each other language is a
 * catalog in locales/<code>.js mapping the English text to its translation
 * (missing entries fall back to English):
 *
 *   t("Saved to {path}", { path })          a message with a value in it
 *   tn(n, "{n} page", "{n} pages")          singular / plural
 *   tc("verb", "Open")                       same English, different meaning
 *   N_("Highlight")                          marks text in a table for the
 *                                            extractor; translate it with t()
 *                                            where it is shown
 *
 * "{app}" in any message is the product name.
 *
 * The static text of index.html (text and the title, aria-label, placeholder
 * and alt attributes) is translated as the page loads and again whenever the
 * language changes; text built by the scripts is translated with t() when it
 * is built, and the scripts listen for "i18n:change" to rebuild what is on
 * screen.
 *
 * Language: the one chosen in Settings, else the first browser language we
 * have, else English.
 */
(function () {
  "use strict";

  const APP_NAME = "OpenPDF";
  const STORAGE_KEY = "openpdf_language";
  /** Code -> name of the language in itself (shown in the language menu). */
  const LANGUAGES = {
    en: "English",
    de: "Deutsch",
    es: "Español",
    fr: "Français",
    ja: "日本語",
    ko: "한국어",
    "zh-CN": "简体中文",
    "zh-TW": "繁體中文",
  };
  const CTX = "\u0004"; // gettext's context separator: "verb\u0004Open"
  const catalogs = { en: {} };

  function saved() {
    try {
      return localStorage.getItem(STORAGE_KEY) || "";
    } catch {
      return "";
    }
  }

  /** Best supported code for a browser language tag ("de-AT" -> "de", "zh-Hans-SG" -> "zh-CN", "zh-HK" -> "zh-TW"). */
  function match(tag) {
    if (!tag) return null;
    const lower = String(tag).toLowerCase();
    if (lower.startsWith("zh")) {
      // Traditional script: Taiwan, Hong Kong, Macau, or tagged Hant
      return /hant|-tw|-hk|-mo/.test(lower) ? "zh-TW" : "zh-CN";
    }
    for (const code of Object.keys(LANGUAGES)) {
      if (lower === code.toLowerCase()) return code;
    }
    const base = lower.split(/[-_]/)[0];
    return Object.keys(LANGUAGES).find((code) => code.toLowerCase() === base) || null;
  }

  function detect() {
    const chosen = saved();
    if (chosen && LANGUAGES[chosen]) return chosen;
    const tags = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]) || [];
    for (const tag of tags) {
      const code = match(tag);
      if (code) return code;
    }
    return "en";
  }

  let lang = detect();
  let plural = new Intl.PluralRules(lang);

  function format(text, params) {
    if (text.indexOf("{") < 0) return text;
    return text.replace(/\{(\w+)\}/g, (whole, name) => {
      if (name === "app") return APP_NAME;
      if (params && Object.prototype.hasOwnProperty.call(params, name)) {
        const value = params[name];
        return typeof value === "number" ? value.toLocaleString(lang) : String(value);
      }
      return whole;
    });
  }

  function lookup(key) {
    const cat = catalogs[lang];
    const hit = cat && cat[key];
    return hit === undefined || hit === "" ? null : hit;
  }

  function t(message, params) {
    const hit = lookup(message);
    return format(typeof hit === "string" ? hit : message, params);
  }

  function tc(context, message, params) {
    const hit = lookup(context + CTX + message);
    return format(typeof hit === "string" ? hit : message, params);
  }

  /** Plural: the catalog holds {one, few, many, other, ...} under the singular English text. */
  function tn(n, singular, pluralText, params) {
    const all = Object.assign({ n }, params || {});
    const hit = lookup(singular);
    if (hit && typeof hit === "object") {
      const form = hit[plural.select(n)] ?? hit.other;
      if (form) return format(form, all);
    } else if (typeof hit === "string" && n === 1) {
      return format(hit, all);
    }
    return format(n === 1 ? singular : pluralText, all);
  }

  // ------------------------------------------------------------- static page text

  const ATTRS = ["title", "aria-label", "placeholder", "alt", "data-drop-label"];
  const SKIP = new Set(["SCRIPT", "STYLE", "KBD", "CODE", "TEXTAREA"]);
  /** node -> its English text, and element -> {attr: English}, from the first pass. */
  const sourceText = new WeakMap();
  const sourceAttrs = new WeakMap();
  const staticNodes = [];

  function translateStatic(root) {
    // text: not inside <script>, <kbd> etc. or anything marked data-no-i18n
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          return SKIP.has(node.nodeName) || node.hasAttribute("data-no-i18n")
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_SKIP;
        }
        return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      sourceText.set(node, node.nodeValue.trim());
      staticNodes.push(node);
      apply(node);
    }
    // attributes: on any element (a <textarea> has a label too)
    const selector = ATTRS.map((name) => `[${name}]`).join(",");
    for (const el of root.querySelectorAll(selector)) {
      if (el.closest("[data-no-i18n]")) continue;
      const attrs = {};
      for (const name of ATTRS) {
        const value = el.getAttribute(name);
        if (value && value.trim()) attrs[name] = value;
      }
      if (Object.keys(attrs).length) {
        sourceAttrs.set(el, attrs);
        staticNodes.push(el);
        apply(el);
      }
    }
  }

  function apply(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const english = sourceText.get(node);
      const raw = node.nodeValue;
      const lead = raw.match(/^\s*/)[0];
      const tail = raw.match(/\s*$/)[0];
      node.nodeValue = lead + t(english) + tail;
      return;
    }
    const attrs = sourceAttrs.get(node);
    if (!attrs) return;
    for (const [name, english] of Object.entries(attrs)) node.setAttribute(name, t(english));
  }

  function retranslateStatic() {
    for (const node of staticNodes) apply(node);
  }

  // ------------------------------------------------------------- switching

  function setLanguage(code) {
    if (!LANGUAGES[code] || code === lang) return;
    lang = code;
    plural = new Intl.PluralRules(lang);
    try {
      localStorage.setItem(STORAGE_KEY, code);
    } catch {
      // private window: the choice lasts for this page only
    }
    document.documentElement.lang = lang;
    retranslateStatic();
    window.dispatchEvent(new CustomEvent("i18n:change", { detail: { lang } }));
  }

  /** Fill a <select> with the languages and switch when it changes. */
  function bindSelect(select) {
    if (!select) return;
    select.replaceChildren(
      ...Object.entries(LANGUAGES).map(([code, name]) => {
        const option = document.createElement("option");
        option.value = code;
        option.textContent = name;
        option.lang = code;
        return option;
      }),
    );
    select.value = lang;
    select.addEventListener("change", () => setLanguage(select.value));
    window.addEventListener("i18n:change", () => {
      select.value = lang;
    });
  }

  function register(code, messages) {
    catalogs[code] = Object.assign(catalogs[code] || {}, messages);
  }

  document.documentElement.lang = lang;
  // Before the deferred scripts run (readyState "interactive"), so they see translated text.
  function start() {
    translateStatic(document.body);
    bindSelect(document.getElementById("languageSelect"));
  }
  if (document.readyState === "loading") {
    document.addEventListener("readystatechange", function once() {
      if (document.readyState !== "loading") {
        document.removeEventListener("readystatechange", once);
        start();
      }
    });
  } else {
    start();
  }

  window.I18N = {
    APP_NAME,
    LANGUAGES,
    register,
    setLanguage,
    get lang() {
      return lang;
    },
    t,
    tc,
    tn,
    translateStatic,
  };
  window.t = t;
  window.tc = tc;
  window.tn = tn;
  window.N_ = (message) => message;
})();
