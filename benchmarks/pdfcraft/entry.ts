// Harness: PDFCraft's own processors, called the way its tools call them.
import { searchTextInPDF, applyFindAndRedact, type TextMatch } from './pdfcraft/src/lib/pdf/processors/find-and-redact';
import { createPDFToMarkdownProcessor } from './pdfcraft/src/lib/pdf/processors/pdf-to-markdown';
import { loadPdfjs } from './pdfcraft/src/lib/pdf/loader';

const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
async function toB64(blob: Blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

// terms: Find & Redact (its defaults: not case sensitive, no regex, not whole word);
// regions (points from the top left, as displayed) join the same call as boxes, as in its Redact tool
(window as any).pcRedact = async (b64: string, name: string, terms: string[], regions: any[]) => {
  const file = new File([fromB64(b64)], name, { type: 'application/pdf' });
  let matches: TextMatch[] = [];
  if (terms.length) {
    const found = await searchTextInPDF(file, { searchTerms: terms, caseSensitive: false, useRegex: false, wholeWord: false });
    if (!found.success) return { ok: false, error: found.error || 'search failed' };
    matches = found.matches;
  }
  if (regions.length) {
    const pdfjs = await loadPdfjs();
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    for (const r of regions) {
      const vp = (await pdf.getPage(r.page)).getViewport({ scale: 1 });
      matches.push({ page: r.page, text: '', x: r.x, y: vp.height - r.y - r.height, width: r.width, height: r.height,
                     id: 'region-' + matches.length, selected: true });
    }
  }
  const res = await applyFindAndRedact(file, matches, {});
  if (!res.success || !res.result) return { ok: false, error: res.error || 'no result', matches: matches.length };
  return { ok: true, pdf: await toB64(res.result as Blob), matches: matches.length,
           termMatches: matches.filter((m) => m.text).map((m) => m.text) };
};

(window as any).pcMarkdown = async (b64: string, name: string) => {
  const file = new File([fromB64(b64)], name, { type: 'application/pdf' });
  const out = await createPDFToMarkdownProcessor().process({ files: [file], options: {} });
  if (!out.success || !out.result) return { ok: false, error: (out as any).error?.message || 'failed' };
  return { ok: true, md: await (out.result as Blob).text() };
};
(window as any).__PCH = true;
