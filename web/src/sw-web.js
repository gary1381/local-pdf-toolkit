/*
 * Service worker of the browser version (replaces the editor's sw.js in web/dist).
 *
 * Here the services run in the page, so the whole editor works offline once
 * loaded: the editor's own files are kept at install time; the large parts
 * (PDFium, the OCR runtime and models, fonts, pdf.js character maps) are kept
 * the first time they are used. A new build changes VERSION, so the old copies are dropped.
 */
const VERSION = "__VERSION__";
const SHELL = `openpdf-web-shell-${VERSION}`;
const LARGE = `openpdf-web-large-${VERSION}`;
const PRECACHE = __PRECACHE__;
const LARGE_PREFIXES = __LARGE__;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("openpdf-") && k !== SHELL && k !== LARGE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/ui/")) return;
  const large = LARGE_PREFIXES.some((p) => url.pathname.startsWith(p));
  event.respondWith(
    (async () => {
      const cached = await caches.match(url.pathname, { ignoreSearch: true });
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === "basic") {
        const copy = response.clone();
        caches.open(large ? LARGE : SHELL).then((cache) => cache.put(url.pathname, copy));
      }
      return response;
    })()
  );
});
