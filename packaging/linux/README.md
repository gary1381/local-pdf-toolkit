# Linux packages (.deb / AppImage)

The installed version ships all background services and works right after installation. The user's computer does not need Python, Java or qpdf, and does not need podman or Docker.

## What the installed version contains

| Part | Contents | Source |
|---|---|---|
| Desktop app | Tauri window; starts and stops the services below | `desktop/` |
| `backend/server/openpdf-server` | The gateway and the qpdf service, combined into one program (PyInstaller) | `gateway/`, `services/qpdf/` |
| `backend/qpdf/` | Official qpdf 12.4.2 Linux build (SHA-256 checked at build time) | github.com/qpdf/qpdf |
| `backend/pdfbox/` | The PDFBox service, a trimmed Java 17 runtime (jlink), the WenQuanYi Micro Hei font | `services/pdfbox/` |

- When the app starts, it picks free ports on 127.0.0.1 for each service, so it does not conflict with the development containers (port 8090 and others).
- When the app closes, these services stop with it. If the app exits unexpectedly, Linux also ends these services.
- The app is registered for PDF files: double-click or **Open with OpenPDF** in the file manager opens the file in the app (in the running window if it is already open), and **Save** writes back to that file.
- It is also offered for pictures (JPEG, PNG, TIFF, GIF, BMP) under **Open with**, not as their default program: a picture opens as a new PDF (its text recognised when the OCR add-on is installed), and the picture file is left as it is.
- Data (editing sessions, logs) is kept under `~/.local/share/com.pdfgateway.desktop/`, with logs in its `logs/` folder.

## OCR add-on

The OCR component is too large (168 MB compressed, 384 MB unpacked), so it is not included in the package.

- The first time a user uses OCR, they click **Download and install**, and the app downloads `openpdf-ocr-<version>-linux-x86_64.tar.gz`.
- After the download, the file is checked against the SHA-256 built into the app. If it does not match, installation is refused.
- Once the check passes, the file is unpacked into the data folder and started right away, with no need to restart the app.

The default download location is the public release repository `gary1381/openpdf-releases` (installers and add-ons are published there, separately from the source code): `https://github.com/gary1381/openpdf-releases/releases/download/v<version>/openpdf-ocr-<version>-linux-x86_64.tar.gz`. So for every release, this file (and the .deb / AppImage) must be uploaded to the Release with the same name in the release repository; see “Release checklist” below. You can also set `OPENPDF_OCR_URL` at build time to use a different address; `{version}` is replaced with the version number.

Offline installation: set `OPENPDF_OCR_PACK=/path/to/openpdf-ocr.tar.gz` before running the app, and it installs from this local file. The file must pass the same check.

## Document reading add-ons

Two more optional parts, chosen in **Settings → Reading tables, formulas and
scans** (code: `desktop/src-tauri/src/addons.rs`; design: `docs/OCR-MODELS.md`):

- **Document reading component** (`openpdf-structure-<version>-linux-x86_64.tar.gz`,
  about 780 MB, 1.6 GB unpacked): Docling with its layout and table models, CPU.
  Markdown and JSON export, and the place the reading model plugs into.
- **Reading model**: the runtime (`openpdf-llama-<version>-linux-x86_64.tar.gz`,
  llama.cpp's llama-server with every CPU variant and Vulkan for any GPU) plus
  the model files of a tier, downloaded from the addresses pinned in
  `services/model/catalog.json` and checked against its SHA-256: **Fast**
  (PaddleOCR-VL 1.6, 0.9 GB, GPU or CPU) or **Best** (Unlimited-OCR 3B,
  2.8 GB, only with a GPU that has 5 GB free; experimental).

The packs come from the same release repository as the OCR add-on and are
checked against the SHA-256 built into the app; `OPENPDF_STRUCTURE_PACK` /
`OPENPDF_LLAMA_PACK` install from local files instead. At start the app runs
the structure component (the gateway knows its port) and the selected model
(on the GPU when `llama-server --list-devices` shows enough free memory, else on
the CPU), and tells the structure component the model's address and profile.

## Building

Requires: podman (the services are built in containers), Rust (cargo), Node (npm).

```bash
packaging/linux/build-ocr.sh      # OCR add-on → packaging/build/ocr/openpdf-ocr.tar.gz
packaging/linux/build-structure.sh   # document reading component → packaging/build/structure/
packaging/linux/build-llama.sh    # model runtime → packaging/build/llama/
packaging/linux/build-all.sh      # all services + .deb + AppImage
# when only the desktop app changed: SKIP_SERVICES=1 packaging/linux/build-all.sh
```

- Build the OCR component first, then run build-all.sh. build-all.sh builds the SHA-256 of the OCR component into the app. When the OCR component is rebuilt, the app must be rebuilt too.
- The output is in `desktop/src-tauri/target/release/bundle/deb/` and `.../appimage/`.
- The Python services are built in Debian bullseye (glibc 2.31). The desktop app is compiled on the build machine (currently Ubuntu 22.04), so the packages need at least glibc 2.35: Ubuntu 22.04+, Debian 12+, Fedora 36+, etc.

## Testing

Install the package in a clean distribution container, open the app on a virtual display, and then call the bundled services from inside the app:

```bash
packaging/linux/test/test-package.sh deb      docker.io/library/ubuntu:24.04
packaging/linux/test/test-package.sh appimage docker.io/library/debian:12
# the OCR add-on installation flow (needs a scanned document):
OCR=1 AUTOTEST_SECS=60 SAMPLE=scan.pdf packaging/linux/test/test-package.sh deb docker.io/library/ubuntu:24.04
```

For the services check (`probe-installed.js`) the test also starts the app with a PDF path, as the system's launcher does, then once more with a second PDF while it runs (`test-open-file.sh`, `probe-open-file.js`): both must open in the editor, the second start must hand its file over and quit, and **Save** must write back to each file without leaving a copy anywhere else. This part installs `dbus` in the container, because a second start finds the running app over the session bus.

`test/sample.pdf` can be any PDF that contains text (`*.pdf` is not in git, so you need to add one yourself).

Test results from 2026-10-11:

- All 11 checks passed, on Ubuntu 22.04 / 24.04 and Debian 12, for both .deb and AppImage. The checks cover opening a file, extracting text, merging, splitting, writing Chinese text, creating a certificate, digital signing, rendering a page and OCR status.
- Every time the app exited, the services stopped with it.

Test results from 2026-10-23 (.deb on Ubuntu 24.04, AppImage on Debian 12): the 11 checks passed, the launcher has `Exec=pdf-gateway-desktop %F` and `MimeType=application/pdf;`, and the open-file test passed 8/8: a PDF given on the command line and one given to a second start both opened, and Save wrote back to both files.
- OCR component: installation, recognizing a Chinese scan right after installation, automatic start after a restart, and refusal of a modified component.

## Release checklist

1. Change the version number in `desktop/src-tauri/tauri.conf.json`.
2. Run `build-ocr.sh`, `build-structure.sh` and `build-llama.sh`, then `build-all.sh`.
3. Run the tests above.
4. In the public release repository `gary1381/openpdf-releases` (not the code repository), create the Release `v<version>` and upload the .deb, the .AppImage, `openpdf-ocr-<version>-linux-x86_64.tar.gz`, `openpdf-structure-<version>-linux-x86_64.tar.gz`, `openpdf-llama-<version>-linux-x86_64.tar.gz` and `SHA256SUMS`. Rename the components to exactly these names, because the app downloads them from these addresses.
5. Download the OCR component once without signing in to GitHub, to confirm that the address works and that the SHA-256 matches the one in the app.

The OCR component and the service folders both include `licenses/` (the full license text of each Python package) and `SOURCES.md` (versions and source download addresses), generated at build time by `collect-licenses.py`.
