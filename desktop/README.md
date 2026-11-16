# OpenPDF Desktop (Tauri)

The desktop version is a separate window that hosts the web editor. The window opens right away and first shows the **Starting** page (“Starting OpenPDF…”). When the background services are ready, it switches to the editor automatically.

The desktop version runs in one of two ways (see `src-tauri/src/main.rs`, `backend.rs`):

- **Installed version** (.deb / AppImage):
  - Ships three services: the gateway, PDFBox and qpdf. They start on free ports on 127.0.0.1 and stop together when the window closes.
  - Needs no Python, Java or containers.
  - OCR is an add-on. It is downloaded the first time it is used, then its SHA-256 is verified, and it is installed and started.
  - For how to build and test it, see [../packaging/linux/README.md](../packaging/linux/README.md).
- **Development mode** (source checkout):
  - The editor is at `http://127.0.0.1:8090`. If the services are not running, the app runs `scripts/start.sh` (Linux / macOS) or `scripts/start.ps1` (Windows) in the background to start the services in containers.
  - The app looks for the OpenPDF folder in this order: the `OPENPDF_HOME` environment variable → the folder that contains the program and its parent folders → the source folder used at build time.

## Requirements (development)

- [Rust](https://rustup.rs/)
- [Node.js](https://nodejs.org/) 18+
- Linux: WebKitGTK development packages (Ubuntu: `sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev librsvg2-dev`), Podman
- Windows: WebView2, Docker Desktop or Podman Desktop

## Running in development

```bash
cd ..
./scripts/start-desktop.sh     # start the services, then the desktop window
```

## Packaging (Linux)

```bash
cd ..
packaging/linux/build-ocr.sh   # OCR add-on
packaging/linux/build-all.sh   # services + .deb + AppImage
```

The packages are written to `src-tauri/target/release/bundle/`. Running `npm run build` directly also produces packages, but they do not include the services and only work together with the containers.

## Notes

- The desktop UI is the same as the browser version; both share `gateway/app/static/`.
- The installed version keeps its data and logs in `~/.local/share/com.pdfgateway.desktop/`.
- If you close the desktop window directly, it does not warn about unsaved changes, so save first. The browser version does warn.
- Windows and macOS installers carry the same services (PyInstaller, jlink, the official qpdf build) but must be built on the matching system: a GitHub Actions workflow does that, see [../packaging/desktop/README.md](../packaging/desktop/README.md).
- The editor always gets the same local port (47380, remembered in the data folder), because its settings and saved signatures live in browser storage tied to that address, and so does the editor installed as an app from Chrome (**File** → **Open in your browser**, then **Install as an app…**). If something else holds the port, the next free one of 47381–47389 is used for that start (a random port only if all are taken). A second start brings the running window forward instead of starting a second copy.
- The packages register OpenPDF for PDF files (`MimeType=application/pdf`, `Exec=pdf-gateway-desktop %F`), so it can be chosen under **Open with** or as the default PDF application. PDF paths on the command line open in the editor (`src-tauri/src/open_files.rs`); a second start hands its files to the running window. **Save** writes back to these files, like files picked in the Open dialog.
- If the app crashes, its services notice (they watch the app's process id) and stop by themselves.
