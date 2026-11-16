//! "Save" writes back to the file that was opened.
//!
//! The editor saves by handing the PDF over as a download. Left alone, the
//! webview would put every download in ~/Downloads with " (1)", " (2)"...
//! added. When the editor's setting is "Save to the original file" (the default) it names
//! the download "<file name>.openpdf-save"; such a download goes back to the
//! file of that name picked in our Open dialog (or, if we don't know where it
//! came from, e.g. it was dragged in, to Downloads under a free name). Plain
//! downloads ("Save a new copy", exported pages...) keep the usual Downloads
//! behaviour. Either way the editor is told where the file went.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::webview::DownloadEvent;
use tauri::{Runtime, Webview};

const SAVE_SUFFIX: &str = ".openpdf-save";

/// File name -> unique original path. None means multiple originals share the
/// name: the download bridge cannot distinguish them, so save a new copy.
static OPENED: Mutex<Option<HashMap<String, Option<PathBuf>>>> = Mutex::new(None);

pub fn remember_opened(path: &Path) {
    if let Some(name) = path.file_name() {
        let mut map = OPENED.lock().unwrap();
        map.get_or_insert_with(HashMap::new)
            .entry(name.to_string_lossy().into_owned())
            .and_modify(|original| {
                if original.as_deref() != Some(path) {
                    *original = None;
                }
            })
            .or_insert_with(|| Some(path.to_path_buf()));
    }
}

pub(crate) fn opened(name: &str) -> Option<PathBuf> {
    OPENED.lock().unwrap().as_ref()?.get(name).cloned().flatten()
}

fn was_opened(name: &str) -> bool {
    OPENED.lock().unwrap().as_ref().is_some_and(|paths| paths.contains_key(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_names_never_choose_another_original() {
        let first = Path::new("/tmp/openpdf-a/collision-fixture.pdf");
        let second = Path::new("/tmp/openpdf-b/collision-fixture.pdf");
        remember_opened(first);
        remember_opened(first);
        assert_eq!(opened("collision-fixture.pdf"), Some(first.to_path_buf()));
        remember_opened(second);
        assert_eq!(opened("collision-fixture.pdf"), None);
        remember_opened(first);
        assert_eq!(opened("collision-fixture.pdf"), None);
        // A real numbered filename must not be mistaken for webview numbering.
        remember_opened(Path::new("/tmp/openpdf-a/collision-fixture (1).pdf"));
        remember_opened(Path::new("/tmp/openpdf-b/collision-fixture (1).pdf"));
        assert_eq!(original_name("collision-fixture (1).pdf.openpdf-save"), Some("collision-fixture (1).pdf".into()));
    }
}

fn downloads_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Downloads"))
        .filter(|p| p.is_dir())
        .unwrap_or_else(std::env::temp_dir)
}

/// "name.pdf", then "name (1).pdf", "name (2).pdf"... whichever is free.
fn free_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

/// The webview may already have numbered the marker name ("a (1).pdf.openpdf-save").
fn original_name(file_name: &str) -> Option<String> {
    let base = file_name.strip_suffix(SAVE_SUFFIX)?;
    if was_opened(base) {
        return Some(base.to_string());
    }
    // undo " (n)" inserted before the first dot
    let (head, tail) = base.split_once('.').map(|(h, t)| (h, format!(".{t}"))).unwrap_or((base, String::new()));
    if let Some(open) = head.rfind(" (") {
        if head.ends_with(')') && head[open + 2..head.len() - 1].chars().all(|c| c.is_ascii_digit()) {
            return Some(format!("{}{}", &head[..open], tail));
        }
    }
    Some(base.to_string())
}

pub(crate) fn js_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 || c == '\u{2028}' || c == '\u{2029}' => {
                out.push_str(&format!("\\u{:04x}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Handler for WebviewWindowBuilder::on_download.
pub fn on_download<R: Runtime>(webview: Webview<R>, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { destination, .. } => {
            let file_name = destination
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if let Some(name) = original_name(&file_name) {
                *destination = match opened(&name) {
                    Some(path) if path.parent().map(Path::is_dir).unwrap_or(false) => path,
                    _ => free_path(&downloads_dir(), &name),
                };
            }
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            // the download URL tells the editor which document this was
            let url = js_string(url.as_str());
            let script = match (success, path) {
                (true, Some(path)) => {
                    let shown = path.to_string_lossy().into_owned();
                    eprintln!("[openpdf] saved to {shown}");
                    format!("window.__openpdfSaved && window.__openpdfSaved({}, {url})", js_string(&shown))
                }
                _ => {
                    eprintln!("[openpdf] save failed");
                    format!("window.__openpdfSaveFailed && window.__openpdfSaveFailed({url})")
                }
            };
            let _ = webview.eval(&script);
            true
        }
        _ => true,
    }
}

/// Linux: let a save replace the existing file, and tell the editor it runs
/// in the desktop app (it then leaves saving to us).
#[cfg(target_os = "linux")]
pub fn install(view: &webkit2gtk::WebView) {
    use webkit2gtk::{DownloadExt, LoadEvent, URIRequestExt, WebContextExt, WebViewExt};
    view.connect_load_changed(|view, event| {
        if event == LoadEvent::Finished {
            view.evaluate_javascript("window.__openpdfDesktop = true;", None, None, None::<&gio::Cancellable>, |_| {});
        }
    });
    if let Some(context) = view.context() {
        context.connect_download_started(|_, download| {
            let from_editor = download
                .request()
                .and_then(|r| r.uri())
                .map(|u| u.starts_with("blob:"))
                .unwrap_or(false);
            if from_editor {
                download.set_allow_overwrite(true);
            }
        });
    }
}
