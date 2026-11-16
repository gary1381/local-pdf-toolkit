// In-page backend of the browser version.
//
// The editor talks to its services with fetch("/v1/pdf/...") as it does with
// the gateway. Here those requests never leave the page: they are handed to a
// Web Worker (web-worker.js) that does the PDF work with WebAssembly and
// answers with the same responses the gateway gives. Every other request goes
// to the network as usual.

(function () {
  "use strict";

  window.__OPENPDF_WEB = true;
  // Everything runs here, so the editor can work offline once loaded (web/src/sw-web.js).
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/ui/sw.js", { scope: "/ui/" }).catch(() => {});
  }
  const worker = new Worker("/ui/web-worker.js", { type: "module", name: "openpdf-services" });
  const pending = new Map();
  let nextId = 1;

  worker.addEventListener("message", (event) => {
    const { id, status, headers, body } = event.data || {};
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    call.resolve(new Response(status === 204 ? null : body, { status, headers }));
  });
  worker.addEventListener("error", (event) => {
    console.error("[openpdf] services worker failed", event.message || event);
    for (const call of pending.values()) {
      call.resolve(
        new Response(JSON.stringify({ detail: "The PDF services in this page stopped. Reload the page." }), {
          status: 500,
          headers: { "content-type": "application/json" },
        })
      );
    }
    pending.clear();
  });

  function handled(url) {
    return url.origin === window.location.origin && (url.pathname.startsWith("/v1/") || url.pathname === "/health");
  }

  async function bodyOf(input, init) {
    const body = init.body !== undefined ? init.body : input instanceof Request ? await input.clone().formData().catch(() => null) : null;
    if (body == null) return null;
    if (body instanceof FormData) return { form: [...body.entries()] };
    if (typeof body === "string") return { text: body };
    if (body instanceof Blob) return { blob: body };
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { blob: new Blob([body]) };
    if (body instanceof URLSearchParams) return { form: [...body.entries()] };
    throw new TypeError("Unsupported request body for the in-page services");
  }

  const networkFetch = window.fetch.bind(window);
  window.fetch = async function fetch(input, init = {}) {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (!handled(url)) return networkFetch(input, init);
    const method = (init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers || (input instanceof Request ? input.headers : undefined)));
    const body = await bodyOf(input, init);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, path: url.pathname, query: url.search, headers, body });
    });
  };
})();
