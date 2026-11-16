# Demos

Three tasks an agent can now do on your computer without uploading anything.
The sample files come from `python engine/tests/make_fixtures.py ~/Documents/pdf-demo`
(a contract with personal data, a vendor form, a scanned invoice); the W-9 is the
current form from irs.gov. Timings are from a laptop running the container.

## 1. Redact a contract before sending it

> Remove the client's name and SSN from `~/Documents/pdf-demo/contract.pdf`, then
> show me the first page.

What the agent does:

1. `pdf_find_text(terms=["John Smith", "123-45-6789"])`: 4 matches on 2 pages.
2. `pdf_redact(terms=[...])`, about 10 seconds. The report:

   ```json
   {
    "output": "/Users/you/Documents/pdf-demo/contract.redacted.pdf",
    "redactedPages": [{"page": 1, "boxes": 3, "method": "text"}, {"page": 2, "boxes": 2, "method": "text"}],
    "termMatches": {"John Smith": 3, "123-45-6789": 2},
    "alsoRemoved": ["1 annotation(s) mentioning a term or holding an attachment, with their popups and replies",
                    "1 bookmark title(s)", "metadata field Title"],
    "remainingMatches": 0,
    "rawObjectHits": [],
    "verified": true,
    "textRestored": false
   }
   ```

3. `pdf_render_page(page=1)` to show you the result.

The redaction found one more "John Smith" than the search: a letter-spaced
witness line ("J o h n  S m i t h"). The name was also in a bookmark, the
document title and a sticky note; those are gone too. Copying text from the
output or running `pdftotext` on it finds neither term, while the rest of the
page is still searchable.

## 2. Fill an IRS Form W-9

> Fill in `~/Documents/pdf-demo/fw9.pdf` for Ana Example, individual, 12 Harbor
> St, Portland, ME 04101, SSN 123-45-6789.

The W-9's fields are named `f1_01[0]`, `c1_1[0]` and so on. `pdf_form_fields`
reads the printed caption next to each one:

```json
{"name": "topmostSubform[0].Page1[0].f1_01[0]", "kind": "text",
 "label": "1 Name of entity/individual. An entry is required. ..."},
{"name": "topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[0]", "kind": "checkbox",
 "label": "Individual/sole proprietor"},
{"name": "topmostSubform[0].Page1[0].f1_11[0]", "kind": "text", "maxLength": 3,
 "label": "Social security number"}
```

So the agent can call `pdf_fill_form` with the right names (the SSN goes into
three boxes of 3, 2 and 4 digits). The tool then reads the values back from the
new file and reports any field that did not take. It finishes with
`pdf_render_page` so you can check before signing.

## 3. Read a scanned invoice, then sign the approval

> `~/Documents/pdf-demo/scan.pdf` is a scanned invoice. What's the total? Then
> sign it as approved with a certificate for Ana Example.

1. `pdf_info`: one page, `textChars: 0` → a scan.
2. `pdf_ocr`, about 4 seconds: `scan.ocr.pdf`, looks the same, now searchable.
3. `pdf_read_text`: "Total due ... $275.00".
4. `pdf_create_certificate(name="Ana Example", ...)`: a self-signed `.p12`.
5. `pdf_sign(certificate=..., reason="Approved")`: a visible signature box at the
   bottom right of the last page, then an automatic check:

   ```json
   {"page": 1, "name": "Ana Example", "reason": "Approved",
    "subFilter": "ETSI.CAdES.detached", "coversWholeFile": true, "status": "untrusted",
    "message": "Intact and unchanged; the certificate is self-signed, so the signer's identity is not confirmed"}
   ```

For signatures that recipients' PDF readers trust, use a certificate from a
certificate authority instead of a self-signed one.
