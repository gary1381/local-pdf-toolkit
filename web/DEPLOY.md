# Publishing the browser version

The browser version is a static site: `web/dist/` after a build. There is no
server program to run; any web server or static host can serve it. Users'
files are processed in their own browser and are never uploaded.

## 1. Build

```bash
cd web
npm ci
node build.mjs
```

Publish the whole of `dist/` (about 70 MB, about 260 files; the largest is an
OCR model of 21 MB). It contains no source maps; `node build.mjs --sourcemap`
adds them for debugging, but don't publish that build.

## 2. What the host must provide

| Requirement | Why |
|---|---|
| **HTTPS** | Browsers allow the service worker (offline use), WebCrypto (creating certificates for signatures) and saving back to the original file only on `https://` pages (and on `localhost`). Opened as `http://192.168.x.x`, these parts do not work. |
| **The site root** | The pages use paths such as `/ui/...`: serve `dist/` at `https://pdf.example.com/`, not under a path such as `https://example.com/openpdf/`. |
| `.mjs` served as JavaScript (`text/javascript` or `application/javascript`) | pdf.js and the OCR runtime are `.mjs` modules; browsers refuse to run a module with any other type, and opening a file then hangs. **nginx's standard `mime.types` does not know `.mjs`** (see the configuration below); Cloudflare Pages, Netlify and Caddy do. |
| `.wasm` served as `application/wasm` | WebAssembly is compiled while it downloads only with this type. Most hosts and current nginx/Caddy do it already. |
| Files of up to 21 MB | The OCR model. |
| HTML and scripts revalidated on every load (`Cache-Control: no-cache`, or a short max-age) | File names stay the same between versions; with long caching, an update could keep old files. The large parts are kept by the service worker, so revalidating costs nothing. |

No special headers (COOP/COEP) are needed, and nothing else is: no database,
no API keys, no environment variables.

Don't turn on the host's analytics or script injection (for example Cloudflare
Web Analytics' automatic setup): the site then contacts another server, and
the claim "nothing leaves your computer" is no longer true. The build
contains no tracking.

## 3. Where to host it

### Cloudflare Pages (recommended)

Free, HTTPS, a root domain (`<project>.pages.dev`, or your own), files up to
25 MB. The build writes `dist/_headers`, which Cloudflare reads for the caching
rules above.

```bash
npx wrangler login                      # once, with your Cloudflare account
npx wrangler pages deploy dist --project-name openpdf
```

A custom domain (`pdf.example.com`) is added in the Cloudflare dashboard
under the project's *Custom domains*.

### Netlify

Also reads `dist/_headers`. Drag `dist/` onto app.netlify.com/drop, or:

```bash
npx netlify-cli deploy --dir dist --prod
```

### Your own server (company network or a VPS)

nginx, with a certificate (for example from Let's Encrypt, or the company's
own CA for an internal name):

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name pdf.example.com;
    ssl_certificate     /etc/ssl/pdf.example.com.crt;
    ssl_certificate_key /etc/ssl/pdf.example.com.key;

    root /srv/openpdf;              # the contents of web/dist/
    include mime.types;
    # not in nginx's standard list: without the .mjs line, files do not open
    types {
        text/javascript             mjs;
        application/manifest+json   webmanifest;
        application/wasm            wasm;
    }
    add_header Cache-Control "no-cache" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    gzip on;
    gzip_types application/javascript text/css application/json image/svg+xml application/wasm;
}
```

Caddy (gets a certificate by itself for a public name):

```
pdf.example.com {
    root * /srv/openpdf
    file_server
    encode gzip
    header Cache-Control "no-cache"
    header X-Content-Type-Options "nosniff"
    header Referrer-Policy "no-referrer"
}
```

### GitHub Pages

Only with a custom domain or a `<user>.github.io` site, because a project
page lives under `/<repository>/`. It also needs a public repository (or a
paid plan); the code repository of OpenPDF is private, so publish `dist/`
from a separate one.

## 4. Check the published site

```bash
curl -sI https://pdf.example.com/ui/vendor/pdfium/pdfium.wasm | grep -i content-type   # application/wasm
curl -sI https://pdf.example.com/ui/vendor/pdfjs/pdf.min.mjs | grep -i content-type    # text/javascript (or application/javascript)
curl -sI https://pdf.example.com/ui/sw.js | grep -i cache-control                     # no-cache (or a short max-age)
```

Then run the browser checks against it (Chrome and the fixtures of
`engine/tests/make_fixtures.py`). They open files, use every service, OCR,
work offline, and fail if any request leaves the site:

```bash
python3 web/test/check_web.py https://pdf.example.com FIXTURES
```

## 5. Updating

Build again and publish `dist/` the same way. The service worker notices the
new version on the user's next visit, and the next reload uses it.

## 6. What users need to know

- Open the address in Chrome or Edge, then open or drop a PDF. Files stay on
  the user's computer.
- *Install* (the icon in the address bar) makes it an app that can be set to
  open PDF files, and Save then writes back to the original file. Other
  browsers save a copy as a download instead (Firefox and Safari have not
  been tested yet).
- After the first visit it works offline. The first OCR downloads about 48 MB;
  the first text in Chinese, Japanese or Korean about 5 MB.
- How it differs from the desktop app: [README.md](README.md), *Differences
  from the server version*.

## Licences

`dist/ui/THIRD-PARTY-LICENSES.txt` holds the notices of every bundled
component and must stay published with the site. Every component allows
closed commercial use; the build stops on any that does not (see
[README.md](README.md), *Licences*).
