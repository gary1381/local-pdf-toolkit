//! PDF files handed to the app by the system: "Open with OpenPDF" or a
//! double-click starts `pdf-gateway-desktop file.pdf ...`; pictures (JPEG,
//! PNG, TIFF, GIF, BMP) come the same way and the editor makes a new PDF of
//! each (openFile hands them to openPictures, by name). When OpenPDF is
//! already running, the second start passes its arguments to this window
//! (single instance). Each file is opened in the editor like one picked in
//! the Open dialog, so Save writes back to it (see save.rs).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use tauri::{Runtime, Url, WebviewWindow};

/// Files waiting for the editor page; `loaded` once it is there.
struct Pending {
    loaded: bool,
    paths: Vec<PathBuf>,
}

static PENDING: Mutex<Pending> = Mutex::new(Pending { loaded: false, paths: Vec::new() });

/// AppImage: its launcher (AppRun) runs the app in the image's own folder,
/// where the bundled WebKit finds its helpers, and the AppImage runtime keeps
/// the folder it was started from in $OWD. Relative paths on the command line
/// mean that folder: start over once with them made absolute, so they are
/// right here and when a second start passes them on to the running app.
#[cfg(unix)]
pub fn absolute_appimage_args() {
    use std::os::unix::process::CommandExt;
    let (Some(_), Some(owd)) = (std::env::var_os("APPIMAGE"), std::env::var_os("OWD")) else { return };
    let args = own_args();
    let relative = |a: &String| !a.is_empty() && !a.starts_with('-') && !a.starts_with("file://") && Path::new(a).is_relative();
    if !args.iter().any(relative) {
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    let owd = PathBuf::from(owd);
    let fixed: Vec<std::ffi::OsString> =
        args.iter().map(|a| if relative(a) { owd.join(a).into_os_string() } else { a.into() }).collect();
    let err = std::process::Command::new(exe).args(fixed).exec();
    eprintln!("[openpdf] could not restart with absolute paths: {err}");
}

/// This program's arguments; one that is not valid UTF-8 (only a file name
/// could be) is skipped rather than ending the program, like std::env::args.
pub fn own_args() -> Vec<String> {
    std::env::args_os().skip(1).filter_map(|a| a.into_string().ok()).collect()
}

/// The files among a command line (`args` without the program name): plain
/// paths, relative to `cwd`, or file:// URIs. Options ("-x") are skipped.
pub fn paths_from_args<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .filter_map(|arg| {
            if arg.starts_with("file://") {
                Url::parse(&arg).ok()?.to_file_path().ok()
            } else if arg.is_empty() || arg.starts_with('-') {
                None
            } else {
                Some(cwd.join(arg))
            }
        })
        .collect()
}

/// Open `paths` in the editor now, or as soon as it has loaded.
pub fn open<R: Runtime>(window: Option<&WebviewWindow<R>>, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    let mut pending = PENDING.lock().unwrap();
    match window {
        Some(window) if pending.loaded => send(window, paths),
        _ => pending.paths.extend(paths),
    }
}

/// Handler for WebviewWindowBuilder::on_page_load: once the editor (not the
/// loading page) has loaded, it gets the files waiting for it.
pub fn on_editor_loaded<R: Runtime>(window: &WebviewWindow<R>, url: &Url) {
    let local = matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"));
    if url.scheme() != "http" || !local || !url.path().starts_with("/ui/") {
        return;
    }
    let mut pending = PENDING.lock().unwrap();
    pending.loaded = true;
    let paths = std::mem::take(&mut pending.paths);
    if !paths.is_empty() {
        send(window, paths);
    }
}

/// Read the files off the main thread and hand them to the editor, in order.
fn send<R: Runtime>(window: &WebviewWindow<R>, paths: Vec<PathBuf>) {
    let window = window.clone();
    std::thread::spawn(move || {
        for path in paths {
            let _ = window.eval(&script(&path));
        }
    });
}

/// The editor's side: wait for it to be ready, then open the file with
/// openFile(). Files open in the order given: each waits until the one before
/// has its tab (not for all of its loading, which goes on in the background).
/// A file that cannot be read gets the same message as one that went missing
/// before the browser app opened it.
fn script(path: &Path) -> String {
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "document.pdf".into());
    let name_js = crate::save::js_string(&name);
    let body = match std::fs::read(&path) {
        Ok(bytes) => {
            crate::save::remember_opened(&path);
            eprintln!("[openpdf] opening {}", path.display());
            let data = base64::engine::general_purpose::STANDARD.encode(bytes);
            format!(
                "const bin = atob(\"{data}\"); const bytes = new Uint8Array(bin.length); \
                 for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); \
                 const tabs = state.docs.length; let done = false; \
                 openFile(new File([bytes], {name_js}, {{ type: \"application/pdf\" }})) \
                   .catch((err) => console.error(\"[openpdf] open failed\", err)).finally(() => (done = true)); \
                 while (!done && state.docs.length === tabs) await new Promise((r) => setTimeout(r, 50));"
            )
        }
        Err(err) => {
            eprintln!("[openpdf] cannot open {}: {err}", path.display());
            format!("setStatus(t(\"Can't open “{{name}}”: the file was moved or can't be read\", {{ name: {name_js} }}), \"error\");")
        }
    };
    format!(
        "window.__openpdfOpening = (window.__openpdfOpening || Promise.resolve()).then(async () => {{ \
         while (typeof openFile !== \"function\" || !window.pdfjsLib) await new Promise((r) => setTimeout(r, 50)); \
         {body} }}).catch((err) => console.error(\"[openpdf] open failed\", err));"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn command_line_files() {
        let cwd = Path::new("/home/u/docs");
        let paths = paths_from_args(
            args(&["a.pdf", "/tmp/b c.pdf", "file:///tmp/%E4%BD%A0%E5%A5%BD.pdf", "--flag", "-", "", "../x.pdf"]),
            cwd,
        );
        assert_eq!(
            paths,
            vec![
                PathBuf::from("/home/u/docs/a.pdf"),
                PathBuf::from("/tmp/b c.pdf"),
                PathBuf::from("/tmp/你好.pdf"),
                PathBuf::from("/home/u/docs/../x.pdf"),
            ]
        );
    }

    #[test]
    fn script_names_the_file_and_remembers_it() {
        let dir = std::env::temp_dir().join(format!("openpdf-open-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("say \"hi\".pdf");
        std::fs::write(&file, b"%PDF-1.4\n").unwrap();
        let js = script(&file);
        assert!(js.contains("\"say \\\"hi\\\".pdf\""), "{js}");
        assert!(js.contains("JVBERi0xLjQK"), "{js}");
        let real = std::fs::canonicalize(&file).unwrap();
        assert_eq!(crate::save::opened("say \"hi\".pdf"), Some(real));
        let missing = script(&dir.join("gone.pdf"));
        assert!(missing.contains("setStatus(") && missing.contains("\"gone.pdf\""), "{missing}");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
