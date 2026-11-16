# PDF Engine

**Local PDF tools for AI agents.** Let Claude, Cursor or any MCP client read,
search, OCR, fill, redact, sign and rearrange PDF files on your own computer.
Nothing is uploaded: the files stay on your disk and are processed by services
running on `127.0.0.1`.

- **Redaction that actually removes things.** Most "redaction" draws a black box
  over text that can still be copied out. Here every affected page is rebuilt,
  forms, annotations, attachments, tags and metadata are cleaned, and the whole
  file is scanned again. If a term can still be found anywhere, nothing is saved.
- **Sees what it edits.** `pdf_render_page` hands the agent an image of the page,
  and every tool uses the same coordinates, so "put the date next to the
  signature line" works.
- **Real digital signatures.** Sign with a `.p12`/`.pfx` certificate, then verify:
  who signed, whether the document changed afterwards, whether the certificate
  is trusted.
- **OCR built in.** Scanned PDFs become searchable (English and Chinese), offline.
- **Safe by default.** Originals are never modified; outputs are written next to
  them (`contract.pdf` → `contract.redacted.pdf`) and existing files are never
  replaced unless you say so. The engine can only see the folders you give it.

## Quick start

You need Docker (or Podman). The image is about 1 GB because it contains the OCR
models and a Java runtime; the first start of a session takes a few seconds.

> The prebuilt image `ghcr.io/gary1381/pdf-engine` is **not published yet**.
> Until it is, build the image yourself (see [Building](#building)) and use
> `pdf-engine` in place of `ghcr.io/gary1381/pdf-engine:0.1` below.

### Claude Desktop, Cursor and other clients with a JSON config

Share a folder with the engine **at the same path** it has on your computer, so
the paths the agent sees just work. macOS / Linux:

```json
{
  "mcpServers": {
    "pdf": {
      "command": "docker",
      "args": ["run", "-i", "--rm",
               "-v", "/Users/you/Documents:/Users/you/Documents",
               "ghcr.io/gary1381/pdf-engine:0.1", "mcp"]
    }
  }
}
```

Claude Desktop: *Settings → Developer → Edit Config* (`claude_desktop_config.json`).
Cursor: `.cursor/mcp.json` in a project or `~/.cursor/mcp.json`.

Windows paths cannot exist inside a Linux container, so mount the folder anywhere
and tell the engine how the paths map:

```json
{
  "mcpServers": {
    "pdf": {
      "command": "docker",
      "args": ["run", "-i", "--rm",
               "-v", "C:\\Users\\you\\Documents:/docs",
               "-e", "PDF_ENGINE_PATH_MAP=C:\\Users\\you\\Documents=/docs",
               "ghcr.io/gary1381/pdf-engine:0.1", "mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add pdf -- docker run -i --rm -v "$HOME/Documents:$HOME/Documents" ghcr.io/gary1381/pdf-engine:0.1 mcp
```

### One shared engine (HTTP)

Start it once and point any number of clients at `http://127.0.0.1:8765/mcp`:

```bash
docker run -d --name pdf-engine -p 127.0.0.1:8765:8765 -p 127.0.0.1:8090:8090 \
  -v "$HOME/Documents:$HOME/Documents" ghcr.io/gary1381/pdf-engine:0.1 serve
```

Port 8090 also serves the REST API behind the tools, for your own scripts
(OpenAPI docs at `http://127.0.0.1:8090/docs`). Both ports only answer requests
addressed to `127.0.0.1`/`localhost`, so web pages in your browser cannot reach
them.

On Linux, run the engine as yourself so it can write next to your files and
what it writes belongs to you: with Docker add `--user "$(id -u):$(id -g)"`,
with rootless Podman add `--userns=keep-id --user "$(id -u):$(id -g)"`.
(Docker Desktop on macOS and Windows needs neither.)

## Try it

Ask your agent things like:

- "Redact every Social Security number and the client's name in
  `~/Documents/contract.pdf`, then show me page 1."
- "Fill in `~/Documents/vendor-form.pdf` with our company details from
  `~/Documents/company.txt` and check the boxes that apply."
- "Make `~/Documents/scans/invoice.pdf` searchable and tell me the total."
- "Create a signing certificate for Ana Example and sign `~/Documents/nda.pdf`
  on the last page, reason 'Approved'."

[DEMOS.md](DEMOS.md) walks through three of these step by step.

## Tools

| Tool | What it does |
| --- | --- |
| `pdf_info` | Pages, sizes, metadata, form fields, signatures; flags scanned pages |
| `pdf_read_text` | Text page by page (fast; optionally sorted by position, for forms in rows, not for columns) |
| `pdf_outline` | The headings as printed: level, page, size of each section (add-on) |
| `pdf_read_markdown` | The pages as Markdown: headings, columns in order, tables, no running headers (add-on) |
| `pdf_structure` | Blocks with kind, page, box and section; tables as rows of cells (add-on) |
| `pdf_find_text` | Where words appear: page and boxes |
| `pdf_render_page` | A page as an image, so the agent can look at it |
| `pdf_form_fields` | Fillable fields: names, kinds, options, positions |
| `pdf_fill_form` | Fill fields by name, then read the values back to confirm |
| `pdf_redact` | Remove words or areas for real, with a verification report |
| `pdf_ocr` | Make scanned pages searchable, and the text in pictures on other pages (English, Chinese) |
| `pdf_extract_images` | Save the pictures as image files (JPEGs unchanged) with their page, box and the text read in them |
| `pdf_from_images` | Make a PDF from photos or scans (JPEG, PNG, TIFF, GIF, BMP), with their text recognised |
| `pdf_export` | Save the document as Markdown or JSON together with its pictures (add-on) |
| `pdf_add_text` | Write text onto a page (forms without fields, stamps) |
| `pdf_add_note` | Add a sticky-note comment |
| `pdf_highlight` | Highlight words wherever they appear |
| `pdf_merge` | Join PDFs |
| `pdf_extract_pages` | Copy pages into a new PDF |
| `pdf_select_pages` | Reorder or delete pages |
| `pdf_rotate_pages` | Rotate pages |
| `pdf_flatten` | Make fields and annotations part of the page |
| `pdf_sign` | Digitally sign with a certificate, then verify |
| `pdf_create_certificate` | Make a self-signed `.p12` for signing |
| `pdf_verify_signatures` | Check existing signatures |
| `pdf_encrypt` / `pdf_decrypt` | Add or remove a password (AES-256) |

Positions are PDF points (1/72 inch) measured from the top-left corner of the
page as displayed. `pdf_render_page` tells the agent how to convert its pixels.

### Reading documents: the structure add-on

`pdf_read_text` gives a page's characters; for reports, papers and contracts an
agent needs more: which lines are headings, which column comes first, what is
a table. The three *add-on* tools get that from [Docling](https://github.com/docling-project/docling)
(MIT; IBM's layout and TableFormer models), on the CPU, offline:

- `pdf_outline` first, to see the sections and how long they are;
- `pdf_read_markdown` for the pages needed, with `<!-- page N of M -->` markers
  to cite;
- `pdf_structure` for tables as cells, or for the box of a passage to highlight
  or redact.

Scanned pages (no text layer) and the pictures on the other pages (charts,
photos, pasted scans) are OCR'd first when the OCR add-on is installed; the
file itself is not changed (`ocr=false` skips it). The text in a picture is
quoted under it in the Markdown (not for logos and letterheads in the top or
bottom margin, which would bring running headers back) and is the picture's
`text` in `pdf_structure`. When a document reading model is installed
(`scripts/install-model.sh`, or the desktop app's settings), tables, formulas
and scanned pages are read again by it (`model`: `auto` by default, `on`,
`off`; docs/OCR-MODELS.md): 67.5 on olmOCR-Bench with PaddleOCR-VL. On
[olmOCR-Bench](../benchmarks/parsing/README.md) this reading scores 53.5 (71.3
without the two formula categories), against 31.0 for `pdf_read_text`.

Headings get their level from their numbering (1 / 1.1, I. / A., 第一章 / 第一节,
一、 / （一）) or, without numbering, from their type size; the first unnumbered
heading on page 1 is the title. Pages that still have no text (OCR not
installed) are reported. Formulas are left out (`<!-- formula-not-decoded -->`).

The add-on adds about 1.5 GB to the image, so the published image leaves it out; the tools
then say so and point to `pdf_read_text`. Build an image with it:

```bash
podman build --ignorefile engine/Dockerfile.dockerignore -f engine/Dockerfile --build-arg WITH_STRUCTURE=1 -t pdf-engine:structure .
```

Conversion takes a few seconds per page; the last six results are kept, so
outline-then-read does not convert twice.

## How redaction works

1. Form fields are flattened into the page and the form is removed, including
   digital signatures and their validation data (any redaction changes the
   file, so a signature could not stay valid anyway). XFA data goes too.
2. Annotations that mention a term (note text, author, link address) are
   removed with their pop-ups and replies; attachments in annotations go. The
   other visible annotations (stamps, text boxes, highlights) on **every** page
   are then flattened into the page, so their text is searched like any other
   text. They stop being editable annotations; the report says how many
   (`annotationsFlattened`). If flattening fails, nothing is written.
3. Scanned pages (pictures of text, no text layer) are OCR'd, so terms printed on
   them are found too. Without OCR the report warns that those pages were not
   searched.
4. Terms are located on every page, also when the text is letter-spaced
   ("J o h n"). Matches in OCR text get a wider margin, because OCR positions
   only approximate the pixels. Given areas are added.
5. Annotations that still mention a term are removed, and so are pop-ups and
   replies whose parent annotation is gone.
6. On every page with something to remove, what lies under the boxes is taken
   out of the page content: every character that a box covers (a fifth of it is
   enough), also invisible OCR text and the words given again as `/ActualText`;
   the covered pixels of pictures; shapes mostly inside a box; annotations over
   it. Forms shared with other pages are copied first. Then black boxes are
   drawn, and the page is checked: no character may be found under a box. The
   rest of the page stays text, selectable and searchable.
   A page where this cannot be done or checked (tiling patterns, a picture used
   as a mask, content that cannot be read; or every page with
   `keep_text=false`) is rewritten in place as an image of itself with the boxes
   burnt in, without any annotations. The report gives each page's `method`.
   The old content is not kept anywhere in the file, even where another page
   shares its fonts and images: every page not rebuilt gets its own resources,
   cut down to what it actually draws.
7. Accessibility tags, embedded files and document JavaScript are removed;
   bookmark titles and metadata that mention a term are cleaned
   (`remove_metadata` clears all metadata).
8. With OCR available, pages rebuilt as images get a new text layer, so the
   words that were *not* redacted stay searchable.
9. The output is checked: the text of every page is searched again (this covers
   everything a reader can see or copy), and every string in every object and
   every metadata, XML and attachment stream is scanned for the terms. If a term
   is found, the tool fails and writes nothing. If none of the terms occur at
   all, it also fails rather than report success; terms that were not found are
   listed in the report.

What it cannot see: words inside pictures on pages that *also* have a text layer
(a scanned page with a typed stamp, say). The report lists such pages under
`otherPagesWithPictures`; check them, and redact by region if needed.
Pages rebuilt as images (200 dpi by default) are larger, no longer vector, and
their text comes from OCR. On pages kept as text, the fonts still contain the
shapes of the removed characters (not their order or position). Always look at
the result before sending it.

## Privacy and security

- All processing happens on your machine. The only network request the engine
  can make is to an RFC 3161 timestamp server, and only if you pass
  `timestamp_url` to `pdf_sign`; only well-known public timestamp servers are
  accepted (set `PDF_ENGINE_ALLOW_ANY_TSA=1` to allow others). If you never
  timestamp, you can run the container with `--network none`. ONNX Runtime's
  usage telemetry is turned off.
- In the container, the tools can only use the folders you mount; everything
  else, including the image itself, is refused. Natively, they are limited to
  `PDF_ENGINE_ROOTS` (default: your home folder).
- Originals are never modified: an output may not be one of the inputs, and an
  existing file is never replaced unless `overwrite` is true. Outputs are
  written to a new temporary file first and never follow symbolic links.
- The container runs as an unprivileged user; its internal services listen
  only on `127.0.0.1` inside the container.
- `serve` mode has no login: any program on your computer can use the shared
  engine, within the mounted folders. Publish its ports only on `127.0.0.1` (as
  in the example), never on all interfaces, and set `API_KEY` to protect the
  REST API.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PDF_ENGINE_PATH_MAP` | none | `host=container` folder pairs, `;`-separated |
| `PDF_ENGINE_ROOTS` | the mounted folders | Folders the tools may read and write, `;`-separated |
| `PDF_ENGINE_ALLOW_ANY_TSA` | `0` | `1` allows timestamp servers other than the well-known public ones |
| `PDF_ENGINE_OCR` | `1` | `0` leaves the OCR service off (saves ~400 MB memory) |
| `PDF_ENGINE_STRUCTURE` | `1` | `0` leaves the document structure service off in images built with it (saves ~1.4 GB memory) |
| `API_KEY` | none | Require this key on the REST API (`serve` mode) |
| `PDF_ENGINE_LOG_DIR` | `/tmp/pdf-engine/logs` | Service logs inside the container |

## Building

```bash
podman build --ignorefile engine/Dockerfile.dockerignore -f engine/Dockerfile -t pdf-engine .
python engine/tests/test_mcp.py --server "podman run -i --rm --userns=keep-id --user $(id -u):$(id -g) -v /tmp/pdf-engine-test:/tmp/pdf-engine-test pdf-engine mcp"
```

## License

Apache License 2.0, like the rest of this repository ([LICENSE](../LICENSE)).
Third-party components keep their own licences; see
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).
