# Windows and macOS installers

Like the Linux packages ([../linux/README.md](../linux/README.md)), the
installers carry every background service: no Python, Java, qpdf, Docker or
Podman needed on the user's computer. The difference is how they are built:
PyInstaller and jlink must run on the system they build for, so each
installer is built natively, on a GitHub Actions runner
([github-workflow-desktop.yml](github-workflow-desktop.yml), to be copied to `.github/workflows/desktop.yml`):

| Runner | Output |
|---|---|
| `windows-latest` | `OpenPDF_<version>_x64-setup.exe` (per-user install, no admin rights), `OpenPDF_<version>_x64_en-US.msi` (for IT departments) |
| `macos-15` | `OpenPDF_<version>_aarch64.dmg` (Apple silicon) |
| `macos-15-intel` | `OpenPDF_<version>_x64.dmg` (Intel Macs) |

Each also produces the OCR add-on for its system,
`openpdf-ocr-<version>-<os>-<arch>.tar.gz` (`windows-x86_64`,
`macos-aarch64`, `macos-x86_64`), and a `SHA256SUMS-<os>-<arch>` file. The
app downloads the add-on for its own system from the public release
repository the first time OCR is used and checks it against the SHA-256
built into the app (see `desktop/src-tauri/src/ocr.rs`).

## What a run does

1. `build.py`: the gateway + qpdf service (PyInstaller), the PDFBox service
   (Maven) with a Java runtime cut down by jlink and the CJK font, the official
   qpdf build for the system (checked against the qpdf release's SHA-256
   list), the OCR add-on (PyInstaller), then the installer (`tauri build`).
2. `smoke_test.py`: starts the bundled services the way the app does and
   runs real requests: info, text, combine, split, rotate, password on/off,
   writing Chinese text, page rendering, certificate, digital signature and
   its verification, the editor page, and OCR of a scanned page.
3. `app_test.py`: installs (Windows) or opens the built app (macOS), checks
   that it starts its services and stops them when it quits, and that the
   services stop by themselves when the app is killed (each one watches the
   app's process id, `OPENPDF_PARENT_PID`).
4. The files are attached to the run as artifacts.

Building on your own Windows or Mac works the same way: `python
packaging/desktop/build.py` (needs Python 3.12, JDK 17 with `JAVA_HOME`,
Maven, Rust and Node).

## Signing

Without signing, the installers work but the systems warn:

- **Windows**: SmartScreen shows “Windows protected your PC”; the user clicks
  **More info → Run anyway**. Some antivirus programs distrust unsigned
  PyInstaller programs. A code signing certificate (or Azure Trusted Signing)
  removes this; signing is not wired up yet.
- **macOS**: an unsigned app downloaded from the internet is blocked by
  Gatekeeper. Users can allow it once (System Settings → Privacy & Security →
  **Open Anyway**), but the programs inside the app may be blocked too.
  A Developer ID certificate and notarization (Apple Developer Program) fix
  this. The workflow signs and notarizes when these repository secrets are set:
  `APPLE_CERTIFICATE` (base64 of the .p12), `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific
  password), `APPLE_TEAM_ID`. `packaging/macos/sign-backend.sh` signs every
  program and library in the services folder first (hardened runtime, with the
  JIT exceptions Java needs, `packaging/macos/entitlements.plist`).

## Release

Put the installers, the three OCR add-ons and the checksums in the release
`v<version>` of the public repository `gary1381/openpdf-releases`, next to the
Linux files. The OCR add-ons must keep their names: the app downloads
`openpdf-ocr-<version>-<os>-<arch>.tar.gz` from there.
