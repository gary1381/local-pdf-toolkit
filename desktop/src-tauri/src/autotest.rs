//! Diagnostics: OPENPDF_AUTOTEST_OPEN=/path/file.pdf opens that file as soon
//! as the editor has loaded, prints how long each step took (and the longest
//! frame stall) to the terminal, then quits. Used to measure opening speed on
//! the real display without anyone clicking through the dialog.

use std::time::Duration;

use gtk::prelude::*;
use webkit2gtk::{LoadEvent, SettingsExt, WebView, WebViewExt};

const MEASURE: &str = r#"
(async () => {
  const log = (m) => console.info("[openpdf-autotest] " + m);
  while (typeof openFile !== "function" || !window.pdfjsLib) await new Promise((r) => setTimeout(r, 20));
  const bytes = Uint8Array.from(atob(window.__autotestData), (c) => c.charCodeAt(0));
  delete window.__autotestData;
  let worst = 0, worstAt = 0, last = performance.now(), running = true;
  const t0 = performance.now();
  const tick = (now) => { if (now - last > worst) { worst = now - last; worstAt = now - t0; } last = now; if (running) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  let painted = null;
  const watch = () => {
    const c = document.querySelector('.page-shell[data-page="1"] canvas');
    if (c) requestAnimationFrame(() => requestAnimationFrame(() => { painted = performance.now() - t0; }));
    else setTimeout(watch, 5);
  };
  watch();
  await openFile(new File([bytes], "__NAME__", { type: "application/pdf" }));
  const done = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 6000));
  running = false;
  log(`openFile ${Math.round(done)}ms, first page painted ${Math.round(painted)}ms, longest frame gap ${Math.round(worst)}ms at ${Math.round(worstAt)}ms, dpr ${devicePixelRatio}`);
  log("done");
})();
"#;

/// OPENPDF_AUTOTEST_DIALOG=1: open the Open dialog the way the app does,
/// twice, print when it first draws, close it, and quit.
pub fn install_dialog_test(view: &WebView) {
    if std::env::var_os("OPENPDF_AUTOTEST_DIALOG").is_none() {
        return;
    }
    let started = std::cell::Cell::new(false);
    view.connect_load_changed(move |view, event| {
        if event != LoadEvent::Finished || started.get() || !view.uri().map(|u| u.contains("/ui/")).unwrap_or(false) {
            return;
        }
        started.set(true);
        let view = view.clone();
        glib::timeout_add_local_once(Duration::from_millis(1500), move || {
            for round in 1..=2 {
                let t0 = std::time::Instant::now();
                let labels = crate::file_chooser::Labels::default();
                let dialog = crate::file_chooser::build_dialog(&view, "last", &labels, {
                    let f = gtk::FileFilter::new();
                    f.add_mime_type("application/pdf");
                    Some(f)
                });
                let drawn = std::rc::Rc::new(std::cell::Cell::new(false));
                let d2 = drawn.clone();
                dialog.connect_draw(move |_, _| {
                    if !d2.get() {
                        d2.set(true);
                        eprintln!("[openpdf-autotest] dialog round {round}: first draw after {:?}", t0.elapsed());
                    }
                    glib::Propagation::Proceed
                });
                let dlg = dialog.clone();
                glib::timeout_add_local_once(Duration::from_secs(4), move || dlg.response(gtk::ResponseType::Cancel));
                dialog.run();
                eprintln!("[openpdf-autotest] dialog round {round}: closed after {:?}", t0.elapsed());
                dialog.close();
            }
            std::process::exit(0);
        });
    });
}

/// OPENPDF_AUTOTEST_PICK=/path/file.pdf: press "Open" in the editor; the
/// dialog then picks that file by itself (see file_chooser.rs). Quits after 20 s.
pub fn install_pick_test(view: &WebView) {
    if std::env::var_os("OPENPDF_AUTOTEST_PICK").is_none() {
        return;
    }
    if let Some(settings) = WebViewExt::settings(view) {
        settings.set_enable_write_console_messages_to_stdout(true);
    }
    let started = std::cell::Cell::new(false);
    view.connect_load_changed(move |view, event| {
        if event != LoadEvent::Finished || started.get() || !view.uri().map(|u| u.contains("/ui/")).unwrap_or(false) {
            return;
        }
        started.set(true);
        let pre = std::env::var_os("OPENPDF_AUTOTEST_PRE")
            .and_then(|p| std::fs::read_to_string(p).ok())
            .unwrap_or_default();
        let view = view.clone();
        glib::timeout_add_local_once(Duration::from_millis(1500), move || {
            let script = format!("{pre}\n(async () => {{ while (typeof pickAndOpenPdf !== 'function' || !window.pdfjsLib) await new Promise((r) => setTimeout(r, 20)); pickAndOpenPdf(); }})();");
            view.evaluate_javascript(&script, None, None, None::<&gio::Cancellable>, |_| {});
        });
        glib::timeout_add_local_once(Duration::from_secs(run_secs()), || std::process::exit(0));
    });
}

/// OPENPDF_AUTOTEST_RUN=/path/probe.js: run that script once the editor has
/// loaded, without opening anything (the files come from the command line).
/// Quits after OPENPDF_AUTOTEST_SECS.
pub fn install_run_test(view: &WebView) {
    let Some(script) = std::env::var_os("OPENPDF_AUTOTEST_RUN").and_then(|p| std::fs::read_to_string(p).ok()) else {
        return;
    };
    if let Some(settings) = WebViewExt::settings(view) {
        settings.set_enable_write_console_messages_to_stdout(true);
    }
    let started = std::cell::Cell::new(false);
    view.connect_load_changed(move |view, event| {
        if event != LoadEvent::Finished || started.get() || !view.uri().map(|u| u.contains("/ui/")).unwrap_or(false) {
            return;
        }
        started.set(true);
        view.evaluate_javascript(&script, None, None, None::<&gio::Cancellable>, |_| {});
        glib::timeout_add_local_once(Duration::from_secs(run_secs()), || std::process::exit(0));
    });
}

/// How long a test run lasts before the app quits (OPENPDF_AUTOTEST_SECS, default 20).
fn run_secs() -> u64 {
    std::env::var("OPENPDF_AUTOTEST_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(20)
}

pub fn install(view: &WebView) {
    let Some(path) = std::env::var_os("OPENPDF_AUTOTEST_OPEN") else { return };
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("[openpdf-autotest] cannot read {:?}", path);
        return;
    };
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().replace('"', ""))
        .unwrap_or_else(|| "test.pdf".into());
    if let Some(settings) = WebViewExt::settings(view) {
        settings.set_enable_write_console_messages_to_stdout(true);
    }
    let data = glib::base64_encode(&bytes).to_string();
    let started = std::cell::Cell::new(false);
    view.connect_load_changed(move |view, event| {
        if event != LoadEvent::Finished || started.get() {
            return;
        }
        if !view.uri().map(|u| u.contains("/ui/")).unwrap_or(false) {
            return;
        }
        started.set(true);
        // OPENPDF_AUTOTEST_PRE=/path/probe.js runs first (extra timing probes).
        let pre = std::env::var_os("OPENPDF_AUTOTEST_PRE")
            .and_then(|p| std::fs::read_to_string(p).ok())
            .unwrap_or_default();
        let script = format!("{}\nwindow.__autotestData = \"{}\";{}", pre, data, MEASURE.replace("__NAME__", &name));
        let view = view.clone();
        glib::timeout_add_local_once(Duration::from_millis(1500), move || {
            view.evaluate_javascript(&script, None, None, None::<&gio::Cancellable>, |_| {});
        });
        glib::timeout_add_local_once(Duration::from_secs(run_secs()), || std::process::exit(0));
    });
}
