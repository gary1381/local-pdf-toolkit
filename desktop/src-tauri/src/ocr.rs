//! Installing the optional OCR component from the editor.
//!
//! The editor navigates to `openpdf-action://install-ocr`; that navigation is
//! cancelled here and the install runs in the background. Progress goes to the
//! page through `window.__openpdfOcrInstall({kind, text})`: "line" (with
//! `STEP n/m ...` and `PCT n` lines for the progress bar), then "done" or
//! "error".
//!
//! - Installed app: the OCR add-on pack (a .tar.gz built with the app) is
//!   downloaded, checked against the SHA-256 built into the app, unpacked
//!   into the app's data folder and started. See `install_pack`.
//! - Development checkout: `scripts/install-ocr.sh` (`.ps1` on Windows) builds
//!   the OCR container.

use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime, Url};

use crate::backend::Backend;

static RUNNING: AtomicBool = AtomicBool::new(false);

/// Navigation hook: false cancels the navigation (our own action addresses).
pub fn on_navigation<R: Runtime>(app: &AppHandle<R>, url: &Url) -> bool {
    if url.scheme() != "openpdf-action" {
        return true;
    }
    if url.host_str() == Some("install-ocr") && !RUNNING.swap(true, Ordering::SeqCst) {
        let app = app.clone();
        thread::spawn(move || {
            install(&app);
            RUNNING.store(false, Ordering::SeqCst);
        });
    }
    false
}

pub(crate) fn js_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            '<' => out.push_str("\\u003c"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => {}
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn send<R: Runtime>(app: &AppHandle<R>, kind: &str, text: &str) {
    let js = format!(
        "window.__openpdfOcrInstall && window.__openpdfOcrInstall({{kind:{},text:{}}})",
        js_string(kind),
        js_string(text)
    );
    for window in app.webview_windows().values() {
        let _ = window.eval(&js);
    }
}

#[cfg(windows)]
fn installer(root: &std::path::Path) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(root.join("scripts").join("install-ocr.ps1"))
        .creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(windows))]
fn installer(root: &std::path::Path) -> Command {
    let mut cmd = Command::new("bash");
    cmd.arg(root.join("scripts").join("install-ocr.sh"));
    cmd
}

pub(crate) fn pump<T: Read + Send + 'static>(stream: T, tx: mpsc::Sender<(bool, String)>, is_err: bool) {
    thread::spawn(move || {
        // podman redraws progress with "\r": treat those as line ends too
        let mut reader = BufReader::new(stream);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&buf);
                    for part in text.split('\r') {
                        let line = part.trim();
                        if !line.is_empty() && tx.send((is_err, line.to_string())).is_err() {
                            return;
                        }
                    }
                }
            }
        }
    });
}

fn install<R: Runtime>(app: &AppHandle<R>) {
    if app.try_state::<Backend>().is_some() {
        if let Err(err) = install_pack(app) {
            send(app, "error", &err);
        }
        return;
    }
    let Some(root) = crate::find_project_root() else {
        send(app, "error", "Can't find the OpenPDF folder, so the OCR component can't be installed (set OPENPDF_HOME)");
        return;
    };
    let mut cmd = installer(&root);
    cmd.current_dir(&root).stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            send(app, "error", &format!("Can't run the installer: {err}"));
            return;
        }
    };
    let (tx, rx) = mpsc::channel();
    if let Some(out) = child.stdout.take() {
        pump(out, tx.clone(), false);
    }
    if let Some(err) = child.stderr.take() {
        pump(err, tx.clone(), true);
    }
    drop(tx);
    let mut last_error = String::new();
    for (is_err, line) in rx {
        if is_err {
            last_error = line.clone();
        }
        send(app, "line", &line);
    }
    match child.wait() {
        Ok(status) if status.success() => send(app, "done", ""),
        Ok(_) => send(
            app,
            "error",
            &format!(
                "The installation didn't finish{}",
                if last_error.is_empty() { String::new() } else { format!(": {last_error}") }
            ),
        ),
        Err(err) => send(app, "error", &format!("The installation didn't finish: {err}")),
    }
}

// ---------------------------------------------------------------------------
// Installed app: the OCR add-on pack

/// SHA-256 of the add-on pack built together with this app (set by
/// packaging/linux/build-all.sh). Downloads that don't match are refused.
const PACK_SHA256: Option<&str> = option_env!("OPENPDF_OCR_SHA256");

/// The installed add-on's program: `<app data>/ocr/openpdf-ocr/openpdf-ocr`.
pub fn pack_program<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let program = crate::backend::plain(app.path().app_data_dir().ok()?)
        .join("ocr")
        .join("openpdf-ocr")
        .join(crate::backend::exe("openpdf-ocr"));
    program.is_file().then_some(program)
}

/// Where the pack comes from: `OPENPDF_OCR_PACK` (a local file: offline
/// install, testing), else this version's release download.
fn pack_source<R: Runtime>(app: &AppHandle<R>) -> String {
    if let Ok(path) = std::env::var("OPENPDF_OCR_PACK") {
        return path;
    }
    let version = app.package_info().version.to_string();
    match option_env!("OPENPDF_OCR_URL") {
        Some(url) => url.replace("{version}", &version),
        None => format!(
            "https://github.com/gary1381/openpdf-releases/releases/download/v{version}/{}",
            pack_name(&version)
        ),
    }
}

/// The add-on built for this system: openpdf-ocr-<version>-<os>-<arch>.tar.gz,
/// e.g. -linux-x86_64, -windows-x86_64, -macos-aarch64.
pub fn pack_name(version: &str) -> String {
    format!("openpdf-ocr-{version}-{}-{}.tar.gz", std::env::consts::OS, std::env::consts::ARCH)
}

/// Unpack a .tar.gz into `dest` (no external `tar`: Windows may not have one).
pub(crate) fn unpack(archive: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|e| format!("Can't unpack: {e}"))?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(BufReader::new(file)));
    tar.set_preserve_permissions(true);
    tar.set_overwrite(true);
    // `unpack` refuses entries that would land outside `dest`.
    tar.unpack(dest).map_err(|e| format!("Can't unpack: {e}"))
}

pub(crate) fn mb(bytes: u64) -> String {
    format!("{:.0} MB", bytes as f64 / 1_048_576.0)
}

/// Copy `from` to `dest` while hashing it and reporting progress; returns the SHA-256.
fn fetch<R: Runtime>(app: &AppHandle<R>, mut from: impl Read, total: Option<u64>, dest: &std::path::Path) -> Result<String, String> {
    let mut file = File::create(dest).map_err(|e| format!("Can't write the downloaded file: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let (mut done, mut last) = (0u64, Instant::now());
    loop {
        let n = from.read(&mut buf).map_err(|e| format!("The download was interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| format!("Can't write the downloaded file: {e}"))?;
        hasher.update(&buf[..n]);
        done += n as u64;
        if last.elapsed() >= Duration::from_millis(500) {
            last = Instant::now();
            match total {
                Some(total) if total > 0 => {
                    send(app, "line", &format!("PCT {}", done * 100 / total));
                    send(app, "line", &format!("Downloaded {} of {}", mb(done), mb(total)));
                }
                _ => send(app, "line", &format!("Downloaded {}", mb(done))),
            }
        }
    }
    file.flush().map_err(|e| format!("Can't write the downloaded file: {e}"))?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn install_pack<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let data = crate::backend::plain(app.path().app_data_dir().map_err(|e| e.to_string())?);
    fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let source = pack_source(app);
    let archive = data.join("ocr-download.tar.gz");
    let remote = source.starts_with("https://") || source.starts_with("http://");

    send(app, "line", "STEP 1/3 Downloading the OCR component…");
    let digest = if remote {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .timeout(None::<Duration>)
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(&source).send().map_err(|e| format!("The download failed; check your network connection: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("The download failed: the server answered {} ({source})", resp.status()));
        }
        let total = resp.content_length();
        fetch(app, resp, total, &archive)?
    } else {
        let file = File::open(&source).map_err(|e| format!("Can't find the OCR component file {source}: {e}"))?;
        let total = file.metadata().ok().map(|m| m.len());
        fetch(app, file, total, &archive)?
    };
    match PACK_SHA256 {
        Some(expected) if !digest.eq_ignore_ascii_case(expected) => {
            let _ = fs::remove_file(&archive);
            return Err("The downloaded file failed its check (SHA-256 mismatch) and was not installed. Please try again.".into());
        }
        None if remote => {
            let _ = fs::remove_file(&archive);
            return Err("This version has no checksum for the OCR component, so it can't be installed from the network.".into());
        }
        _ => {}
    }

    send(app, "line", "STEP 2/3 Unpacking…");
    let fresh = data.join("ocr.new");
    let _ = fs::remove_dir_all(&fresh);
    fs::create_dir_all(&fresh).map_err(|e| e.to_string())?;
    let unpacked = unpack(&archive, &fresh);
    let program = fresh.join("openpdf-ocr").join(crate::backend::exe("openpdf-ocr"));
    if unpacked.is_err() || !program.is_file() {
        let _ = fs::remove_dir_all(&fresh);
        return Err("The OCR component file is incomplete; unpacking failed.".into());
    }
    let target = data.join("ocr");
    let _ = fs::remove_dir_all(&target);
    fs::rename(&fresh, &target).map_err(|e| format!("Can't install: {e}"))?;
    let _ = fs::remove_file(&archive);

    send(app, "line", "STEP 3/3 Starting the OCR component…");
    // Started on the main thread so the add-on stops with the app (see backend::spawn).
    let (tx, rx) = mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = handle.state::<Backend>().start_ocr(&handle).map_err(|e| e.to_string());
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?.map_err(|e| format!("The OCR component didn't start: {e}"))?;

    let health = format!("http://127.0.0.1:{}/health", app.state::<Backend>().ocr_port);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(120) {
        if client.get(&health).send().map(|r| r.status().is_success()).unwrap_or(false) {
            send(app, "line", "DONE OCR component installed");
            send(app, "done", "");
            return Ok(());
        }
        thread::sleep(Duration::from_millis(500));
    }
    Err("The OCR component is installed but didn't start within two minutes. Reopen OpenPDF and try again.".into())
}
