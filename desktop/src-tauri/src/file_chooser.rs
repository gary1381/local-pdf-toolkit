//! Linux: show our own "Open" dialog for the web page's file picker.
//!
//! WebKitGTK's built-in picker opens on GTK's "Recent" view, which checks
//! every recently used file on disk before it appears and can take seconds.
//! This one starts in the folder of the last file opened here (or in
//! Documents), following the "Where Open starts" setting in the editor. Its title and
//! buttons come from the editor too, in the language it is showing.

use std::path::PathBuf;
use std::time::Instant;

use gtk::prelude::*;
use webkit2gtk::{FileChooserRequest, FileChooserRequestExt, SettingsExt, WebView, WebViewExt};

/// The editor's "Where Open starts" setting and the dialog's words in the editor's
/// language, separated by U+0001: mode, title, Cancel, Open.
const SETTING_SCRIPT: &str = "(() => { let mode = 'last'; try { mode = localStorage.getItem('openpdf.openStart') || 'last'; } catch (_) {} \
const t = window.t || ((s) => s); return [mode, t('Open'), t('Cancel'), t('Open')].join('\\u0001'); })()";

/// What the editor told us: the start mode and the dialog's labels.
pub struct Labels {
    pub title: String,
    pub cancel: String,
    pub open: String,
}

impl Default for Labels {
    fn default() -> Self {
        Labels { title: "Open".into(), cancel: "Cancel".into(), open: "Open".into() }
    }
}

fn parse_setting(raw: &str) -> (String, Labels) {
    let mut parts = raw.split('\u{1}');
    let mode = parts.next().filter(|m| !m.is_empty()).unwrap_or("last").to_string();
    let mut labels = Labels::default();
    if let (Some(title), Some(cancel), Some(open)) = (parts.next(), parts.next(), parts.next()) {
        labels = Labels { title: title.into(), cancel: cancel.into(), open: open.into() };
    }
    (mode, labels)
}

fn state_file() -> Option<PathBuf> {
    Some(glib::user_config_dir().join("openpdf").join("last-open-dir"))
}

fn documents_dir() -> PathBuf {
    glib::user_special_dir(glib::UserDirectory::Documents).unwrap_or_else(glib::home_dir)
}

fn last_dir() -> Option<PathBuf> {
    let text = std::fs::read_to_string(state_file()?).ok()?;
    let dir = PathBuf::from(text.trim());
    dir.is_dir().then_some(dir)
}

fn remember_dir(file: &std::path::Path) {
    let (Some(dir), Some(state)) = (file.parent(), state_file()) else { return };
    if let Some(parent) = state.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(state, dir.to_string_lossy().as_bytes());
}

fn start_dir(mode: &str) -> PathBuf {
    if mode == "documents" {
        return documents_dir();
    }
    last_dir().unwrap_or_else(documents_dir)
}

/// The Open dialog: starts in the folder the setting asks for.
pub fn build_dialog(
    view: &WebView,
    mode: &str,
    labels: &Labels,
    filter: Option<gtk::FileFilter>,
) -> gtk::FileChooserDialog {
    let parent = view.toplevel().and_then(|w| w.downcast::<gtk::Window>().ok());
    let dialog = gtk::FileChooserDialog::with_buttons(
        Some(labels.title.as_str()),
        parent.as_ref(),
        gtk::FileChooserAction::Open,
        &[(labels.cancel.as_str(), gtk::ResponseType::Cancel), (labels.open.as_str(), gtk::ResponseType::Accept)],
    );
    if let Some(filter) = filter {
        dialog.add_filter(filter);
    }
    dialog.set_current_folder(start_dir(mode));
    dialog
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn run(view: &WebView, request: &FileChooserRequest, mode: &str, labels: &Labels, started: Instant) {
    let dialog = build_dialog(view, mode, labels, request.mime_types_filter());
    dialog.set_select_multiple(request.selects_multiple());
    let t_prepared = started.elapsed();
    let drawn = std::rc::Rc::new(std::cell::Cell::new(None));
    let d2 = drawn.clone();
    dialog.connect_draw(move |_, _| {
        if d2.get().is_none() {
            d2.set(Some(started.elapsed()));
        }
        glib::Propagation::Proceed
    });
    // Diagnostics: OPENPDF_AUTOTEST_PICK=/path/file.pdf picks that file by itself.
    if let Some(pick) = std::env::var_os("OPENPDF_AUTOTEST_PICK") {
        dialog.set_filename(&pick);
        let dlg = dialog.clone();
        glib::timeout_add_local_once(std::time::Duration::from_millis(1500), move || {
            dlg.response(gtk::ResponseType::Accept)
        });
    }
    let answer = dialog.run();
    // One line per dialog, so a slow open can be traced in the terminal log.
    eprintln!(
        "[openpdf] dialog at {}: ready {:?}, shown {:?}, closed {:?}",
        now_ms(),
        t_prepared,
        drawn.get(),
        started.elapsed()
    );
    if answer == gtk::ResponseType::Accept {
        let files = dialog.filenames();
        dialog.close();
        if let Some(first) = files.first() {
            remember_dir(first);
        }
        for file in &files {
            crate::save::remember_opened(file);
        }
        let paths: Vec<String> = files.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
        request.select_files(&refs);
    } else {
        dialog.close();
        request.cancel();
    }
}

pub fn install(view: &WebView) {
    // The editor prints one "[openpdf] open ..." timing line per file.
    if let Some(settings) = WebViewExt::settings(view) {
        settings.set_enable_write_console_messages_to_stdout(true);
    }
    view.connect_run_file_chooser(|view, request| {
        let started = Instant::now();
        let view = view.clone();
        let request = request.clone();
        view.clone().evaluate_javascript(
            SETTING_SCRIPT,
            None,
            None,
            None::<&gio::Cancellable>,
            move |result| {
                let raw = result
                    .ok()
                    .map(|value| javascriptcore::ValueExt::to_str(&value).to_string())
                    .unwrap_or_default();
                let (mode, labels) = parse_setting(&raw);
                run(&view, &request, &mode, &labels, started);
            },
        );
        true
    });
}
