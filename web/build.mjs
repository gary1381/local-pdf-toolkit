// Build the browser version of OpenPDF: the editor of gateway/app/static, with
// its services running in a Web Worker instead of on a server.
//
//   node build.mjs              -> dist/ (a static site: serve it from any web server; see DEPLOY.md)
//   node build.mjs --serve      -> also serve dist/ on http://127.0.0.1:28300
//   node build.mjs --sourcemap  -> also write source maps (*.map), for debugging; not for publishing
//
// dist/ui/ is the editor as it is, plus web-backend.js (answers the editor's
// /v1/pdf/* requests in the page by passing them to the worker) and
// web-worker.js (the services: LibPDF and PDFium in WebAssembly).
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const STATIC = join(here, "..", "gateway", "app", "static");
const DIST = join(here, "dist");
const UI = join(DIST, "ui");

rmSync(DIST, { recursive: true, force: true });
mkdirSync(UI, { recursive: true });
cpSync(STATIC, UI, { recursive: true });

// The editor page loads the in-page backend before anything else talks to it.
const indexPath = join(UI, "index.html");
const index = readFileSync(indexPath, "utf8");
const marker = '<script src="/ui/i18n.js"></script>';
if (!index.includes(marker)) throw new Error("index.html changed: cannot find where to load web-backend.js");
writeFileSync(indexPath, index.replace(marker, `<script src="/ui/web-backend.js"></script>\n    ${marker}`));
// "/" opens the editor, like the gateway's redirect.
writeFileSync(
  join(DIST, "index.html"),
  '<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=/ui/index.html"><title>OpenPDF</title>\n'
);

// The CJK font for text the services write (WenQuanYi Micro Hei, Apache-2.0 /
// GPLv3 with font exception; used under Apache-2.0): the first face of the
// collection, as a plain TrueType file (LibPDF cannot read collections).
const CJK_SOURCES = [
  process.env.OPENPDF_CJK_FONT,
  join(here, "..", "packaging", "build", "backend", "pdfbox", "fonts", "wqy-microhei.ttc"),
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
].filter(Boolean);
const cjkSource = CJK_SOURCES.find((p) => existsSync(p));
if (cjkSource) {
  mkdirSync(join(UI, "fonts"), { recursive: true });
  const data = readFileSync(cjkSource);
  writeFileSync(join(UI, "fonts", "cjk.ttf"), data.subarray(0, 4).toString("latin1") === "ttcf" ? firstFace(data) : data);
} else {
  console.warn("No CJK font found (set OPENPDF_CJK_FONT): text the services write in Chinese, Japanese or Korean will fail");
}

/** The first font of a TrueType collection, as a standalone font file. */
function firstFace(ttc) {
  const offset = ttc.readUInt32BE(12);
  const numTables = ttc.readUInt16BE(offset + 4);
  const records = [];
  for (let i = 0; i < numTables; i += 1) {
    const r = offset + 12 + i * 16;
    records.push({ tag: ttc.subarray(r, r + 4), checksum: ttc.readUInt32BE(r + 4), from: ttc.readUInt32BE(r + 8), length: ttc.readUInt32BE(r + 12) });
  }
  const headerSize = 12 + numTables * 16;
  let size = headerSize;
  for (const t of records) size += (t.length + 3) & ~3;
  const out = Buffer.alloc(size);
  ttc.copy(out, 0, offset, offset + 12);
  let at = headerSize;
  records.forEach((t, i) => {
    const r = 12 + i * 16;
    t.tag.copy(out, r);
    out.writeUInt32BE(t.checksum, r + 4);
    out.writeUInt32BE(at, r + 8);
    out.writeUInt32BE(t.length, r + 12);
    ttc.copy(out, at, t.from, t.from + t.length);
    at += (t.length + 3) & ~3;
  });
  return out;
}

mkdirSync(join(UI, "vendor", "pdfium"), { recursive: true });
cpSync(require.resolve("@embedpdf/pdfium/pdfium.wasm"), join(UI, "vendor", "pdfium", "pdfium.wasm"));

// Text recognition: the PaddleOCR models (Apache-2.0; downloaded once into
// .cache/) and ONNX Runtime Web's WebAssembly, served with the editor so OCR
// never contacts anyone else. Fetched by the page the first time OCR is used.
const OCR_MODELS = ["PP-OCRv6_tiny_det", "PP-OCRv6_small_rec"];
const MODEL_BASE = "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0";
const cache = join(here, ".cache");
mkdirSync(cache, { recursive: true });
mkdirSync(join(UI, "vendor", "ocr"), { recursive: true });
for (const model of OCR_MODELS) {
  const file = `${model}_onnx_infer.tar`;
  const cached = join(cache, file);
  if (!existsSync(cached)) {
    console.log(`downloading ${file}`);
    const resp = await fetch(`${MODEL_BASE}/${file}`);
    if (!resp.ok) throw new Error(`could not download ${file}: HTTP ${resp.status}`);
    writeFileSync(cached, Buffer.from(await resp.arrayBuffer()));
  }
  cpSync(cached, join(UI, "vendor", "ocr", file));
}
mkdirSync(join(UI, "vendor", "ort"), { recursive: true });
const ortDist = join(here, "node_modules", "onnxruntime-web", "dist");
for (const f of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) cpSync(join(ortDist, f), join(UI, "vendor", "ort", f));

// Source maps only when asked: they are 20 MB that users never need and they
// would publish the readable source.
const sourcemap = process.argv.includes("--sourcemap");
const common = { bundle: true, minify: true, sourcemap, target: "es2022", logLevel: "info", legalComments: "external" };
const shimBuild = await esbuild.build({ ...common, metafile: true, entryPoints: [join(here, "src", "shim.js")], outfile: join(UI, "web-backend.js"), format: "iife" });
const workerBuild = await esbuild.build({
  ...common,
  entryPoints: { "web-worker": join(here, "src", "worker.js") },
  outdir: UI,
  splitting: true, // PDFium, OCR and the signature code load when first used
  chunkNames: "worker/[name]-[hash]",
  // OCR runs on the CPU: ONNX Runtime's WebAssembly-only build (14 MB) rather
  // than its WebGPU-capable default (28 MB)
  alias: { "onnxruntime-web": "onnxruntime-web/wasm" },
  format: "esm",
  platform: "browser",
  metafile: true,
  // Node-only branches inside the libraries; never reached in the browser.
  external: ["node:*", "fs", "path", "url", "module", "crypto", "worker_threads"],
});

// ---------------------------------------------------------------- licences
// Every package bundled into the worker, and the files served next to it,
// must allow commercial use. The notices (with the licence texts) go to
// ui/THIRD-PARTY-LICENSES.txt; an unknown or copyleft licence stops the build.
const PERMISSIVE = /^(MIT|ISC|0BSD|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|BSL-1\.0|Zlib|OFL-1\.1|Unlicense|CC0-1\.0|BlueOak-1\.0\.0)$/;
// Packages whose package.json names their licence loosely; checked by hand.
const LICENCE_FIXES = {
  // "BSL": clipper.js's header says "Boost Software License Ver 1" (http://www.boost.org/LICENSE_1_0.txt)
  "clipper-lib": { license: "BSL-1.0", text: "Boost Software License - Version 1.0 - August 17th, 2003. Use, modification & distribution is subject to the Boost Software License, Version 1.0 (http://www.boost.org/LICENSE_1_0.txt): permission is granted, free of charge, to use, reproduce, display, distribute, execute and transmit the software, and to prepare derivative works, provided the copyright notices and this licence are kept in source distributions." },
};
function permissive(expr) {
  const text = String(expr || "").replace(/[()]/g, " ").trim();
  if (!text) return false;
  // "A OR B": one permissive choice is enough; "A AND B": all must be
  if (/\bOR\b/.test(text)) return text.split(/\s+OR\s+/).some((p) => permissive(p));
  return text.split(/\s+AND\s+/).every((p) => PERMISSIVE.test(p.trim()));
}
const packages = new Map();
for (const build of [shimBuild, workerBuild]) {
  for (const input of Object.keys(build.metafile.inputs)) {
    const path = input.split("\\").join("/");
    const at = path.lastIndexOf("node_modules/");
    if (at < 0) continue;
    const rest = path.slice(at + "node_modules/".length).split("/");
    const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
    const dir = join(here, path.slice(0, at + "node_modules/".length + name.length));
    if (!packages.has(dir)) packages.set(dir, name);
  }
}
// served files that are not bundled code
for (const name of ["@embedpdf/pdfium", "onnxruntime-web"]) packages.set(join(here, "node_modules", name), name);
const notices = ["Third-party software in the OpenPDF browser version", "=".repeat(52), ""];
const problems = [];
for (const [dir, name] of [...packages].sort((a, b) => a[1].localeCompare(b[1]))) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const fix = LICENCE_FIXES[name];
  const license = fix?.license ?? (typeof pkg.license === "string" ? pkg.license : pkg.license?.type);
  if (!permissive(license)) problems.push(`${name}@${pkg.version}: ${license || "no licence"}`);
  notices.push(`${name} ${pkg.version} (${license})`);
  if (fix?.text) notices.push("", fix.text);
  for (const file of readdirSync(dir).filter((f) => /^(licen[cs]e|notice|copying)/i.test(f))) {
    notices.push("", readFileSync(join(dir, file), "utf8").trim());
  }
  notices.push("", "-".repeat(72), "");
}
notices.push(
  "PaddleOCR models PP-OCRv6_tiny_det and PP-OCRv6_small_rec (vendor/ocr/), Apache-2.0,",
  "Copyright PaddlePaddle Authors. https://github.com/PaddlePaddle/PaddleOCR", "", "-".repeat(72), "",
  "WenQuanYi Micro Hei (fonts/cjk.ttf, first face of wqy-microhei.ttc), used under the",
  "Apache License 2.0 (dual-licensed: Apache-2.0 or GPLv3 with the font embedding exception).",
);
const wqyCopyright = cjkSource && join(dirname(cjkSource), "wqy-microhei.copyright");
if (wqyCopyright && existsSync(wqyCopyright)) notices.push("", readFileSync(wqyCopyright, "utf8").trim());
notices.push("", "-".repeat(72), "", "pdf.js (vendor/pdfjs/), Apache-2.0: see vendor/pdfjs/LICENSE.", "");
if (problems.length) {
  throw new Error(`Licences that do not allow closed commercial use:\n  ${problems.join("\n  ")}`);
}
writeFileSync(join(UI, "THIRD-PARTY-LICENSES.txt"), notices.join("\n"));
console.log(`licences: ${packages.size} packages, all permissive`);

// The service worker for offline use: the editor's files kept at install,
// the large parts (PDFium, OCR, the CJK font, worker chunks) when first used.
const LARGE = ["vendor/pdfium/", "vendor/ort/", "vendor/ocr/", "vendor/pdfjs/cmaps/", "vendor/pdfjs/standard_fonts/", "fonts/", "worker/"];
const files = [];
const hash = createHash("sha256");
(function walk(dir) {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else {
      const rel = relative(UI, path).split("\\").join("/");
      if (rel === "sw.js" || /\.map$|LEGAL\.txt$/.test(rel)) continue;
      hash.update(rel).update(readFileSync(path));
      if (!LARGE.some((p) => rel.startsWith(p))) files.push(`/ui/${rel}`);
    }
  }
})(UI);
const sw = readFileSync(join(here, "src", "sw-web.js"), "utf8")
  .replace("__VERSION__", hash.digest("hex").slice(0, 16))
  .replace("__PRECACHE__", JSON.stringify(files))
  .replace("__LARGE__", JSON.stringify(LARGE.map((p) => `/ui/${p}`)));
writeFileSync(join(UI, "sw.js"), sw);

// Caching rules for hosts that read a _headers file (Cloudflare Pages,
// Netlify; see DEPLOY.md for other servers). Most file names stay the same
// between versions, so the browser must check them on every load, or a new
// service worker could keep files of the old version. (The service worker
// keeps the large parts itself, so this costs no downloads.)
writeFileSync(
  join(DIST, "_headers"),
  ["/*", "  Cache-Control: no-cache", "  X-Content-Type-Options: nosniff", "  Referrer-Policy: no-referrer", ""].join("\n")
);

if (process.argv.includes("--serve")) {
  const { hosts, port } = await (
    await esbuild.context({ entryPoints: [], outdir: DIST, write: false })
  ).serve({ servedir: DIST, host: "127.0.0.1", port: 28300 });
  console.log(`serving ${DIST} on http://${hosts[0]}:${port}/`);
}
