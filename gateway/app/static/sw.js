/*
 * Service worker for the installed app (PWA).
 *
 * Everything goes to the local services as usual. The only thing this adds:
 * when the services are not running (the desktop app is closed, the
 * containers are stopped), opening the app shows offline.html instead of the
 * browser's "can't connect" page. offline.html keeps any PDFs the app was
 * opened with and switches to the editor once the services answer.
 */
const CACHE = "openpdf-offline-v1";
const LOCALES = ["de", "es", "fr", "ja", "ko", "zh-CN", "zh-TW"];
const OFFLINE_FILES = [
  "/ui/offline.html",
  "/ui/offline.js",
  "/ui/i18n.js",
  "/ui/favicon.svg",
  ...LOCALES.map((code) => `/ui/locales/${code}.js`),
];
const OFFLINE_SET = new Set(OFFLINE_FILES);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(OFFLINE_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/ui/offline.html")));
    return;
  }
  if (OFFLINE_SET.has(url.pathname)) {
    // the network first, so the offline page's files stay current
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(url.pathname, copy));
          }
          return response;
        })
        .catch(() => caches.match(url.pathname))
    );
  }
});
