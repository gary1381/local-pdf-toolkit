#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! OpenPDF desktop shell: a window around the local web editor.
//!
//! The window opens immediately on a small loading page (`dist/index.html`)
//! that waits for the editor and then switches to it.
//!
//! - Installed app: the services bundled with it are started on free ports
//!   and stopped when the app closes (`backend.rs`). The loading page learns
//!   the editor's address from `window.__OPENPDF_GATEWAY`.
//! - Development checkout: the editor is expected at http://127.0.0.1:8090;
//!   if it is not running, `scripts/start.sh` (Linux/macOS) or
//!   `scripts/start.ps1` (Windows) starts the containers.

mod addons;
#[cfg(target_os = "linux")]
mod autotest;
mod backend;
#[cfg(target_os = "linux")]
mod file_chooser;
mod ocr;
mod open_files;
mod save;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

const GATEWAY_HEALTH: &str = "http://127.0.0.1:8090/health";

fn gateway_ready() -> bool {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok()
        .and_then(|client| client.get(GATEWAY_HEALTH).send().ok())
        .map(|resp| resp.status().is_success())
        .unwrap_or(false)
}

fn has_start_script(dir: &Path) -> bool {
    dir.join("scripts").join("start.sh").is_file() || dir.join("scripts").join("start.ps1").is_file()
}

/// Where the OpenPDF checkout lives: $OPENPDF_HOME, then any folder above the
/// running program, then the folder this binary was built from.
fn find_project_root() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("OPENPDF_HOME") {
        let dir = PathBuf::from(home);
        if has_start_script(&dir) {
            return Some(dir);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        for dir in exe.ancestors().skip(1) {
            if has_start_script(dir) {
                return Some(dir.to_path_buf());
            }
        }
    }
    let built = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    if has_start_script(&built) {
        return Some(built);
    }
    None
}

#[cfg(windows)]
fn spawn_start_script(root: &Path) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(root.join("scripts").join("start.ps1"))
        .current_dir(root)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
}

#[cfg(not(windows))]
fn spawn_start_script(root: &Path) -> std::io::Result<std::process::Child> {
    Command::new("bash")
        .arg(root.join("scripts").join("start.sh"))
        .current_dir(root)
        .spawn()
}

fn start_backend_if_needed() {
    if gateway_ready() {
        return;
    }
    match find_project_root() {
        Some(root) => {
            if let Err(err) = spawn_start_script(&root) {
                eprintln!("Could not start OpenPDF services from {}: {err}", root.display());
            }
        }
        None => eprintln!(
            "OpenPDF services are not running and no checkout was found. \
             Start them yourself or set OPENPDF_HOME to the OpenPDF folder."
        ),
    }
}

/// Installer test (OPENPDF_SELFTEST=<report file>): wait until the bundled
/// services answer, write what they said to the report file, then quit, so a
/// test can check that the app starts its services and stops them again.
fn selftest(app: tauri::AppHandle, gateway_port: u16, report: PathBuf) {
    thread::spawn(move || {
        let url = format!("http://127.0.0.1:{gateway_port}/v1/pdf/engine/ready");
        let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(3)).build();
        let started = std::time::Instant::now();
        let mut last = String::from("no answer");
        // generous: on a fresh install, antivirus scanning can hold the first start for minutes
        while started.elapsed() < Duration::from_secs(300) {
            if let Ok(client) = &client {
                match client.get(&url).send() {
                    Ok(resp) => {
                        let ok = resp.status().is_success();
                        last = resp.text().unwrap_or_default();
                        if ok && last.contains("\"pdfbox\":true") && last.contains("\"qpdf\":true") {
                            break;
                        }
                    }
                    Err(err) => last = format!("no answer: {err}"),
                }
            }
            thread::sleep(Duration::from_millis(500));
        }
        let text = format!(
            "{{\"pid\":{},\"seconds\":{:.1},\"ready\":{}}}\n",
            std::process::id(),
            started.elapsed().as_secs_f64(),
            if last.starts_with('{') { last } else { js_str(&last) }
        );
        let _ = std::fs::write(&report, text);
        app.exit(0);
    });
}

/// "Open in your browser" in the editor's File menu
/// (`openpdf-action://open-in-browser?url=...`): show the same editor in the
/// default browser, where it can be installed as an app. Only the editor's own
/// local address is opened.
fn open_in_browser(action: &tauri::Url) {
    let Some(url) = browser_target(action) else {
        eprintln!("not opening {action} in the browser: not the local editor");
        return;
    };
    let url = url.as_str();
    #[cfg(target_os = "linux")]
    let result = Command::new("xdg-open").arg(url).spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(url).spawn();
    #[cfg(windows)]
    let result = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new("cmd").args(["/C", "start", "", url]).creation_flags(CREATE_NO_WINDOW).spawn()
    };
    if let Err(err) = result {
        eprintln!("could not open the browser: {err}");
    }
}

/// The editor address in an open-in-browser action, if it is the local editor.
fn browser_target(action: &tauri::Url) -> Option<tauri::Url> {
    let target = action.query_pairs().find(|(k, _)| k == "url").and_then(|(_, v)| tauri::Url::parse(&v).ok())?;
    let local = matches!(target.host_str(), Some("127.0.0.1") | Some("localhost"));
    (target.scheme() == "http" && local && target.port().is_some()).then_some(target)
}

#[cfg(test)]
mod tests {
    use super::browser_target;

    fn action(url: &str) -> tauri::Url {
        tauri::Url::parse(&format!("openpdf-action://open-in-browser?url={}", url.replace(':', "%3A").replace('/', "%2F")))
            .unwrap()
    }

    #[test]
    fn opens_only_the_local_editor() {
        let ok = browser_target(&action("http://127.0.0.1:47380/ui/index.html")).unwrap();
        assert_eq!(ok.as_str(), "http://127.0.0.1:47380/ui/index.html");
        assert!(browser_target(&action("http://localhost:8090/ui/index.html")).is_some());
        for bad in ["https://example.com/", "http://example.com:80/", "file:///etc/passwd", "http://127.0.0.1/ui/",
                    "javascript:alert(1)"] {
            assert!(browser_target(&action(bad)).is_none(), "{bad}");
        }
        assert!(browser_target(&tauri::Url::parse("openpdf-action://open-in-browser").unwrap()).is_none());
    }
}

/// JavaScript string literal (for the values handed to the loading page).
fn js_str(text: &str) -> String {
    format!("{:?}", text).replace('<', "\\u003c")
}

fn main() {
    #[cfg(unix)]
    open_files::absolute_appimage_args();
    tauri::Builder::default()
        // Opening OpenPDF again brings the running window forward: a second
        // copy would start its own services on another port, where the
        // editor's saved settings and signatures are not visible.
        // The PDF files it was given open there.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            use tauri::Manager;
            let window = app.webview_windows().values().next().cloned();
            if let Some(window) = &window {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let paths = open_files::paths_from_args(args.into_iter().skip(1), Path::new(&cwd));
            open_files::open(window.as_ref(), paths);
        }))
        .setup(|app| {
            // "Open with OpenPDF": the PDF files on the command line, once the editor is there
            let cwd = std::env::current_dir().unwrap_or_default();
            open_files::open::<tauri::Wry>(None, open_files::paths_from_args(open_files::own_args(), &cwd));

            // Installed app: start the bundled services here, on the main
            // thread (see backend::spawn). Development: never block the
            // window on the containers, the loading page waits for them.
            let mut page_init = String::new();
            if let Some(dir) = backend::bundled_dir(app.handle()) {
                match backend::start(app.handle(), &dir) {
                    Ok(services) => {
                        page_init = format!(
                            "window.__OPENPDF_GATEWAY={};window.__OPENPDF_LOGS={};window.__OPENPDF_PORT_CHANGED={};",
                            js_str(&format!("http://127.0.0.1:{}", services.gateway_port)),
                            js_str(&services.log_dir.display().to_string()),
                            services.port_changed,
                        );
                        if let Ok(report) = std::env::var("OPENPDF_SELFTEST") {
                            selftest(app.handle().clone(), services.gateway_port, PathBuf::from(report));
                        }
                        use tauri::Manager;
                        app.manage(services);
                    }
                    Err(err) => {
                        page_init = format!("window.__OPENPDF_START_ERROR={};", js_str(&err.to_string()));
                    }
                }
            } else {
                thread::spawn(start_backend_if_needed);
            }

            // The window is built here (not from the config) to route saves.
            let config = app.config().app.windows.first().cloned().unwrap_or_default();
            let handle = app.handle().clone();
            let window = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .initialization_script(&page_init)
                .on_download(save::on_download)
                .on_page_load(|window, payload| {
                    if payload.event() == tauri::webview::PageLoadEvent::Finished {
                        open_files::on_editor_loaded(&window, payload.url());
                    }
                })
                .on_navigation(move |url| {
                    if url.scheme() == "openpdf-action" && url.host_str() == Some("open-in-browser") {
                        open_in_browser(url);
                        return false;
                    }
                    addons::on_navigation(&handle, url) && ocr::on_navigation(&handle, url)
                })
                .build()?;
            let _ = &window;
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                for window in app.webview_windows().values() {
                    window.with_webview(|webview| {
                        let view = webview.inner();
                        file_chooser::install(&view);
                        save::install(&view);
                        autotest::install(&view);
                        autotest::install_dialog_test(&view);
                        autotest::install_pick_test(&view);
                        autotest::install_run_test(&view);
                    })?;
                }
            }
            let _ = app;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while starting OpenPDF")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                if let Some(services) = app.try_state::<backend::Backend>() {
                    services.stop();
                }
            }
        });
}
