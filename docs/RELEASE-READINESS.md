# Release readiness review — 2026-10-13

**Decision: not ready for a general-user release.** The core processing engine passes its current integration suite, and the tested interface layouts are usable at desktop widths. However, saved output compatibility, desktop persistence, and form handling still have release blockers. Passing these checks does not establish that every function is correct or that the application is bug-free.

## Scope and environment

Reviewed a development build of OpenPDF before the v0.2.0 release.

Used generated contracts, a rotated page, a scan, an AcroForm, signed forms, encrypted PDFs, and redaction fixtures. Ran isolated source gateway/qpdf services and the existing PDFBox development JAR plus OCR pack on loopback ports 28090–28093. The JAR was newer than the checked Java sources; it was not rebuilt during this audit.

## Open release blockers

### P1 — Text edits are not portable PDF content

Reproduction: open the contract fixture, choose Edit text, type `Release audit edit`, save, and reopen the downloaded PDF in OpenPDF. The edit returns. Read/render the same output with independent PDF tools: the edit is absent. `pypdf` found the string in document metadata but not in extracted page text; Poppler rendering also omitted it.

`PdfboxServer.embedPlacements` only calls `setPlacementsJson` and saves the document (`services/pdfbox/src/main/java/com/pdfgateway/PdfboxServer.java`). The same serialization stores cover boxes and callouts. These tools are documented as editor metadata, but ordinary users reasonably expect their visible edits to appear in a shared or printed PDF. Covering also does not securely remove underlying information.

Required: provide a portable export representation for these objects (with appropriate appearances/rendering), preserve the editable originals, and compare exports in independent readers. Keep secure redaction separate from visual covering. Until then, describe this limitation prominently in the product and restrict release claims.

**Status (fixed on `claude/desktop-i18n`):** `embed-placements` now also draws the text boxes and comments into the pages (one form XObject per page in the optional content group “OpenPDF edits”, replaced on every save, removed when no boxes remain) and keeps the editable copy in the metadata; OpenPDF hides that layer on screen because it draws the boxes itself. “Cover” became **Edit text**: on save, the characters under each box are cut out of the content streams (forms used by other pages are copied first), covered picture pixels are painted white and annotations there removed; the page otherwise stays text. What cannot be removed (image masks) is reported to the user. The old “Edit text” is now **Add text**. Checks: `scripts/check_baked_edits.py` (PDFBox level, 20 checks: rotated page, shared form, scan, repeated saves) and `scripts/check_edit_text.py` (browser, 12 checks, through the saved file). Secure redaction stays a separate operation.

### P1 — Desktop preferences and signature storage depend on a changing URL

`desktop/src-tauri/src/backend.rs` selects a fresh gateway port using `free_port()` on startup. The desktop opens the editor at that port. Language/save preferences use localStorage; saved signatures and certificates use IndexedDB (`gateway/app/static/i18n.js`, `app.js`, and `signature.js`). Those stores belong to the page origin, including its port.

Reproduction with identical current app bytes and the same browser profile: select German at port 28090, reload (German remains), then serve the same app at port 28094. The saved language is absent and the interface returns to English. This directly verifies the origin behavior; an installed-app restart was not exercised here. Signature-library loss of visibility follows from the same IndexedDB origin design, rather than a native signature-library restart test.

Required: a stable trusted editor origin or native persistent storage with a migration strategy, then restart tests covering language, save mode, signatures, and certificates. Merely remembering a preferred port needs a defined behavior when that port is occupied.

**Status (partly fixed on `claude/desktop-i18n`):** the editor now always uses the same port (47380, remembered in `<app data>/editor-port`) and the app runs as a single instance, so preferences, signatures and certificates persist across restarts. When that port is taken by another program, the app uses a free one for that start only (the remembered port is tried again next time) and the editor tells the user that language, save setting and saved signatures may be missing until that program is closed. Native storage would remove even this; restart tests on installed builds are still to do.

### P1 — Choice fields can silently acquire the first option

On the test AcroForm, the backend returned the `tax_class` choice value as the string `[]`. The UI compares that directly with option strings, finds no match, and the HTML select displays `Individual`. The overlay and side panel then disagree with the actual field value. `fieldToMap` uses `getValueAsString`; the frontend expects a scalar matching an option.

Reproduction: fill a text field, save, digitally sign that form, open the signed PDF and its Forms panel, and save without editing anything. The UI tries to change `tax_class` from `[]` to `Individual` and asks to invalidate/change the signature. Dismissing the warning prevents saving. Accepting would authorize an unintended form change. The new export checker retains this as a failing regression.

Required: normalize PDF choice values and represent an empty selection without automatically choosing the first option. Cover single/multiple selection and export/display values. An unchanged signed form must save byte-for-byte without an edit warning.

**Status (fixed on `claude/desktop-i18n`):** `/form-fields` returns the selected export value of choice fields (plus `values`, `optionLabels`, `multiSelect`); the drop-downs keep an empty entry while nothing is selected. `scripts/check_export_workflows.py` passes 7/7.

### Desktop save lifecycle still needs broader verification

**Status (fixed on `claude/desktop-i18n`):** the app passes the download URL back with the result, so a save is marked done only when the app confirms it, only for that document, and only if nothing changed meanwhile; a failed write marks that document unsaved and names it (`scripts/check_desktop_save.py`, simulated). Files opened from the command line or the system's "Open with" now have a native end-to-end test on installed builds (`packaging/linux/test/test-open-file.sh`, .deb and AppImage, 2026-10-23): Save writes back to each opened file and the document then counts as saved. Files picked in the Open dialog still lack one.

The filename collision below is fixed, but the save bridge still identifies destinations by names rather than a per-document identity. The frontend also clears `dirty` before the asynchronous native write finishes, and the failure callback marks the currently active tab dirty. Review and test delayed/failed saves, switching tabs during a save, drag-and-drop files, renamed/generated documents, and files with the same name. These remaining scenarios are source-review concerns, not all independently reproduced in this audit.

## Fixes made during the audit

1. **Print and encrypted export dropped unsaved form input.** Before the fix, independently inspected printed/encrypted PDFs had an empty `legal_name`; ordinary Save retained it. Save, Print, and encrypted export now share `prepareDocumentForExport`, which commits pending input, images and signatures, persists changed form values, waits for mutations, and embeds editor metadata. The exported field and widget values now contain `Ana Müller` / `Zoë García`, with appearance streams present. This does not solve the portable-overlay blocker or certify other export paths.
2. **Desktop Save could overwrite the wrong same-named file.** Opening `/a/contract.pdf` and `/b/contract.pdf` replaced the filename-to-path mapping. The regression failed by resolving the first name to the second path. Ambiguous names now permanently fall back to a separate copy for that process; unambiguous repeated opens retain overwrite behavior. A real numbered filename is not mistaken for a browser-generated suffix. The Rust regression now passes. A native dialog/save end-to-end test is still required.
3. **The language checker reported clipped controls but exited successfully.** It now counts overflow as a failure. An injected overflow produced exit 0 before the change and exit 1 afterwards. Added rotation, split, encryption, unlock, OCR-install, and print-preview dialog snapshots.
4. **The package checker could report failures and still exit successfully.** A new log gate requires one nonempty, completely passing DONE summary and no FAIL lines. The package script now enforces probe success, service shutdown, OCR restart availability, and refusal of the tampered OCR pack. Eight synthetic success/failure log cases pass. Fresh package runs remain outstanding.

## Test results

| Area | Result and limit |
|---|---|
| Translation catalogs | Seven non-English catalogs each pass 545/545 entries, placeholder validation, and missing/unused checks; English is the code baseline. Linguistic quality was not certified. |
| Original UI language matrix | English, German, French, Spanish, Simplified Chinese passed at 960, 1024 and 1280 pixels, including live English-to-German switching. |
| Expanded current language matrix | All eight current languages passed the expanded suite at 1024 and 1280 pixels: zero detected untranslated strings, clipped controls, or script errors; live English-to-German switching passed. Checks inspect selected screens, not every possible dynamic state. |
| Extra dialogs | Thirty supplemental dialog checks passed across the original five languages: rotate, split, encrypt, unlock, OCR and OCR-install. Selected screenshots were visually reviewed. |
| Core MCP integration | **43/43 passed**, including text/search/render, scan OCR, forms, signing/verification, merge/split/reorder/rotate, highlight, flatten, encrypt/decrypt, redaction object checks and path restrictions. |
| Original REST smoke suite | Passed merge, split, extract, annotate, OCR, draw-text, encrypt/unlock and flatten. Some assertions are shallow; this is not full endpoint coverage. |
| Browser editing smoke | Open, four view modes, search, rotate/undo/redo, delete/undo, text metadata save/reopen, and language switching with typed form content passed. The portability failure was found by inspecting the saved PDF independently. |
| Form export regressions | The original six checks pass in Chromium and Firefox after the fix. Final Chromium run: **6/7 passed**, with one failing unchanged-signed-form case exposing the open choice-field blocker. |
| Rust | `cargo test --offline`: one regression passed. `cargo check --offline` passed. These do not prove native interaction correctness. |
| Package result gate | **8/8** synthetic log cases passed; shell syntax checks passed. |
| WebKit | Could not launch: host lacks `libavif13`. No WebKit success is claimed. |
| Installers | Existing local .deb is dated October 11, before the October 13 multilingual commit. Neither fresh installers nor clean-machine installation were validated in this review. |

## Usability assessment

The tested desktop UI has a consistent toolbar, tabs, page thumbnails, shortcuts, and translated dialogs. Compact toolbars fit the tested desktop sizes. This is a technical usability review, not testing with representative nontechnical users.

The largest usability problems are expectations and document integrity: “Edit text” does not produce universally visible text, covering is not secure redaction, some exports previously ignored what the user had typed, and desktop storage/save behavior is not yet dependable enough. Lower-priority polish includes localized backend errors, native-speaker review of terminology, and clear limits on OCR languages versus interface languages. Touch/mobile layouts, keyboard-only navigation, screen readers, dark mode, long filenames, large-file memory use, and long-running failure/recovery paths were not comprehensively tested.

## Release acceptance checklist

- Resolve the three P1 blockers above and add reproductions to automated checks.
- Verify all export paths with pending form, text, image and signature edits, including split ZIPs and whole-document operations.
- Complete desktop save identity/acknowledgment tests and restart-persistence tests.
- Rebuild .deb and AppImage from the exact reviewed revision; test clean installations, upgrades, OCR download/hash/install/restart, shutdown, and uninstall behavior on supported distributions.
- Verify native file dialogs, actual printing, read-only/disk-full failures, and browser-engine compatibility. Test Windows separately before claiming support there.
- Review translations with native speakers; validate newly added languages against the final packaged build.
- Keep a representative real-world PDF corpus and run it before each release. Include empty-choice forms, multi-select forms, signed/encrypted documents, rotated pages, large scans, and non-Latin text.

## Re-running the audit checks

With the gateway and its helper services running, and the appropriate Python/Playwright dependencies installed:

```bash
python engine/tests/make_fixtures.py /tmp/openpdf-audit-fixtures
python scripts/i18n.py check
python scripts/check_ui_languages.py http://127.0.0.1:8090 /tmp/openpdf-audit-fixtures/contract.pdf /tmp/openpdf-ui-check 1024
python scripts/check_export_workflows.py http://127.0.0.1:8090 /tmp/openpdf-audit-fixtures /tmp/openpdf-export-check chromium
python scripts/check_export_workflows.py http://127.0.0.1:8090 /tmp/openpdf-audit-fixtures /tmp/openpdf-export-firefox firefox
bash scripts/e2e.sh
bash packaging/linux/test/test-probe-gate.sh
(cd desktop/src-tauri && cargo test --offline && cargo check --offline)
```

The export checker should currently return nonzero for the documented unchanged-signed-form blocker. Do not interpret the passing engine suite as overriding that failure.
