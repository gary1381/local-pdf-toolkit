//! Document reading add-ons, installed from the editor's settings:
//!
//! - the **structure component** (Docling: headings, reading order, tables;
//!   Markdown and JSON export), a PyInstaller pack like the OCR add-on;
//! - the **reading model** (docs/OCR-MODELS.md): llama.cpp's llama-server (a
//!   pack, downloaded once) and the model files of a tier from
//!   services/model/catalog.json (compiled in), fetched from their pinned
//!   addresses and checked against their SHA-256. Tiers: `fast` (PaddleOCR-VL,
//!   GPU or CPU) and `best` (Unlimited-OCR, GPU only, experimental).
//!
//! The editor navigates to `openpdf-action://addons?do=<status|install|select|remove>&what=<structure|fast|best|off>`;
//! answers go to `window.__openpdfAddons({kind, what, text, status})`: "status"
//! (a JSON description, see `status`), "line" (`STEP n/m`, `PCT n` lines),
//! "done" or "error".
//!
//! Data folder: `structure/openpdf-structure/`, `llama/openpdf-llama/`,
//! `models/<tier>/`, `models/selected` (the tier in use, or "off").

use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime, Url};

use crate::backend::{exe, plain, Backend};
use crate::ocr::{js_string, mb, pump, unpack};

const CATALOG_JSON: &str = include_str!("../../../services/model/catalog.json");
/// SHA-256 of the packs built together with this app (packaging/linux/build-all.sh).
const STRUCTURE_SHA256: Option<&str> = option_env!("OPENPDF_STRUCTURE_SHA256");
const LLAMA_SHA256: Option<&str> = option_env!("OPENPDF_LLAMA_SHA256");

static RUNNING: AtomicBool = AtomicBool::new(false);

pub fn catalog() -> Value {
    serde_json::from_str(CATALOG_JSON).expect("services/model/catalog.json is valid JSON")
}

fn tier(name: &str) -> Option<Value> {
    catalog()["tiers"].get(name).cloned()
}

fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    Some(plain(app.path().app_data_dir().ok()?))
}

/// The installed structure component's program.
pub fn structure_program<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let p = data_dir(app)?.join("structure").join("openpdf-structure").join(exe("openpdf-structure"));
    p.is_file().then_some(p)
}

/// The installed llama-server.
pub fn llama_program<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let p = data_dir(app)?.join("llama").join("openpdf-llama").join(exe("llama-server"));
    p.is_file().then_some(p)
}

/// Whether a tier's files are all there (by size; their SHA-256 was checked when
/// they were downloaded).
fn downloaded<R: Runtime>(app: &AppHandle<R>, name: &str) -> bool {
    let (Some(spec), Some(data)) = (tier(name), data_dir(app)) else { return false };
    spec["files"].as_array().is_some_and(|files| {
        files.iter().all(|f| {
            let path = data.join("models").join(name).join(f["name"].as_str().unwrap_or(""));
            fs::metadata(path).map(|m| Some(m.len()) == f["size"].as_u64()).unwrap_or(false)
        })
    })
}

/// The tier in use: chosen, downloaded, and its runtime installed.
pub fn selected<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let name = fs::read_to_string(data_dir(app)?.join("models").join("selected")).ok()?.trim().to_string();
    (tier(&name).is_some() && downloaded(app, &name) && llama_program(app).is_some()).then_some(name)
}

/// The structure service's prompt profile for the selected tier (empty: no model).
pub fn profile<R: Runtime>(app: &AppHandle<R>) -> String {
    selected(app).and_then(|t| tier(&t)).and_then(|s| s["profile"].as_str().map(String::from)).unwrap_or_default()
}

/// Free memory of the largest GPU llama-server can use (Vulkan), in MiB.
pub fn gpu_free_mb(llama: &Path) -> Option<u64> {
    let out = Command::new(llama).arg("--list-devices").stdin(Stdio::null()).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    // "  Vulkan0: NVIDIA GeForce RTX 3060 (12288 MiB, 10512 MiB free)"
    text.lines()
        .filter_map(|line| {
            let i = line.find(" MiB free")?;
            let digits: String = line[..i].chars().rev().take_while(|c| c.is_ascii_digit()).collect();
            digits.chars().rev().collect::<String>().parse().ok()
        })
        .max()
}

/// The command line for llama-server with `tier`'s model on `port`: on the GPU
/// when it has room for the model, else on the CPU (if the tier allows it).
pub fn model_command<R: Runtime>(app: &AppHandle<R>, name: &str, port: u16) -> Result<Command, String> {
    let spec = tier(name).ok_or("unknown tier")?;
    let llama = llama_program(app).ok_or("the model runtime is not installed")?;
    let folder = data_dir(app).ok_or("no data folder")?.join("models").join(name);
    let file = |role: &str| -> Result<PathBuf, String> {
        spec["files"].as_array().and_then(|fs| fs.iter().find(|f| f["role"] == role))
            .and_then(|f| f["name"].as_str()).map(|n| folder.join(n)).ok_or(format!("no {role} file"))
    };
    let gpu = gpu_free_mb(&llama).unwrap_or(0) >= spec["min_gpu_mb"].as_u64().unwrap_or(u64::MAX);
    if !gpu && !spec["cpu_ok"].as_bool().unwrap_or(false) {
        return Err(format!("{} needs a graphics card with {} MB free", spec["name"].as_str().unwrap_or(name),
                           spec["min_gpu_mb"].as_u64().unwrap_or(0)));
    }
    let mut cmd = Command::new(&llama);
    cmd.arg("-m").arg(file("model")?).arg("--mmproj").arg(file("mmproj")?);
    for a in spec["server_args"].as_array().into_iter().flatten() {
        cmd.arg(a.as_str().unwrap_or_default());
    }
    cmd.args(["--host", "127.0.0.1", "--port", &port.to_string(), "--alias", name]);
    if gpu {
        cmd.args(["-ngl", "99"]);
    } else {
        cmd.args(["-ngl", "0", "--no-mmproj-offload"]);
    }
    if let Some(dir) = llama.parent() {
        cmd.current_dir(dir);
    }
    Ok(cmd)
}

// ---------------------------------------------------------------- the editor's side

fn send<R: Runtime>(app: &AppHandle<R>, kind: &str, what: &str, text: &str, status: Option<Value>) {
    let js = format!(
        "window.__openpdfAddons && window.__openpdfAddons({{kind:{},what:{},text:{},status:{}}})",
        js_string(kind),
        js_string(what),
        js_string(text),
        status.map(|s| s.to_string()).unwrap_or_else(|| "null".into())
    );
    for window in app.webview_windows().values() {
        let _ = window.eval(&js);
    }
}

/// What the settings show: what is installed, the tiers and the GPU.
pub fn status<R: Runtime>(app: &AppHandle<R>) -> Value {
    let installed = app.try_state::<Backend>().is_some();
    let llama = llama_program(app);
    let gpu = llama.as_deref().and_then(gpu_free_mb);
    let chosen = data_dir(app)
        .and_then(|d| fs::read_to_string(d.join("models").join("selected")).ok())
        .map(|t| t.trim().to_string())
        .unwrap_or_else(|| "off".into());
    let mut tiers = serde_json::Map::new();
    for (name, spec) in catalog()["tiers"].as_object().cloned().unwrap_or_default() {
        let size: u64 = spec["files"].as_array().map(|f| f.iter().filter_map(|x| x["size"].as_u64()).sum()).unwrap_or(0);
        tiers.insert(name.clone(), json!({
            "name": spec["name"], "summary": spec["summary"], "licence": spec["licence"],
            "experimental": spec["experimental"].as_bool().unwrap_or(false),
            "cpuOk": spec["cpu_ok"], "minGpuMb": spec["min_gpu_mb"], "sizeMb": size / 1_048_576,
            "downloaded": downloaded(app, &name),
        }));
    }
    json!({
        "desktop": installed,
        "structure": structure_program(app).is_some(),
        "runtime": llama.is_some(),
        "selected": selected(app).unwrap_or_else(|| if chosen == "off" { "off".into() } else { chosen.clone() }),
        "gpuFreeMb": gpu,
        "tiers": tiers,
    })
}

/// Navigation hook: false cancels the navigation (our own action addresses).
pub fn on_navigation<R: Runtime>(app: &AppHandle<R>, url: &Url) -> bool {
    if url.scheme() != "openpdf-action" || url.host_str() != Some("addons") {
        return true;
    }
    let get = |key: &str| url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned()).unwrap_or_default();
    let (action, what) = (get("do"), get("what"));
    let app = app.clone();
    if action == "status" {
        thread::spawn(move || send(&app, "status", "", "", Some(status(&app))));
        return false;
    }
    if RUNNING.swap(true, Ordering::SeqCst) {
        send(&app, "error", &what, "Another download is still running; wait for it to finish.", None);
        return false;
    }
    thread::spawn(move || {
        let result = match action.as_str() {
            "install" => install(&app, &what),
            "select" => select(&app, &what),
            "remove" => remove(&app, &what),
            _ => Err(format!("unknown action {action}")),
        };
        match result {
            Ok(()) => send(&app, "done", &what, "", Some(status(&app))),
            Err(err) => send(&app, "error", &what, &err, Some(status(&app))),
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
    false
}

// ---------------------------------------------------------------- installing

/// Download `source` (an address, or a local file) to `dest` while hashing it
/// and reporting progress; returns its SHA-256.
fn download<R: Runtime>(app: &AppHandle<R>, what: &str, source: &str, dest: &Path) -> Result<String, String> {
    let (mut reader, total): (Box<dyn Read>, Option<u64>) = if source.starts_with("https://") || source.starts_with("http://") {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .timeout(None::<Duration>)
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(source).send().map_err(|e| format!("The download failed; check your network connection: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("The download failed: the server answered {} ({source})", resp.status()));
        }
        let total = resp.content_length();
        (Box::new(resp), total)
    } else {
        let file = File::open(source).map_err(|e| format!("Can't find {source}: {e}"))?;
        let total = file.metadata().ok().map(|m| m.len());
        (Box::new(BufReader::new(file)), total)
    };
    let mut out = File::create(dest).map_err(|e| format!("Can't write the downloaded file: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let (mut done, mut last) = (0u64, Instant::now());
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("The download was interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| format!("Can't write the downloaded file: {e}"))?;
        hasher.update(&buf[..n]);
        done += n as u64;
        if last.elapsed() >= Duration::from_millis(500) {
            last = Instant::now();
            if let Some(total) = total.filter(|t| *t > 0) {
                send(app, "line", what, &format!("PCT {}", done * 100 / total), None);
                send(app, "line", what, &format!("Downloaded {} of {}", mb(done), mb(total)), None);
            } else {
                send(app, "line", what, &format!("Downloaded {}", mb(done)), None);
            }
        }
    }
    out.flush().map_err(|e| format!("Can't write the downloaded file: {e}"))?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// Where a pack comes from: `<ENV>_PACK` (a local file), else this version's release.
fn pack_source<R: Runtime>(app: &AppHandle<R>, kind: &str) -> String {
    let env = format!("OPENPDF_{}_PACK", kind.to_uppercase());
    if let Ok(path) = std::env::var(&env) {
        return path;
    }
    let version = app.package_info().version.to_string();
    format!(
        "https://github.com/gary1381/openpdf-releases/releases/download/v{version}/openpdf-{kind}-{version}-{}-{}.tar.gz",
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

/// Download, check and unpack a pack into `<data>/<kind>/`.
fn install_pack<R: Runtime>(app: &AppHandle<R>, what: &str, kind: &str, expected: Option<&str>, program: &str) -> Result<(), String> {
    let data = data_dir(app).ok_or("no data folder")?;
    fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let source = pack_source(app, kind);
    let remote = source.starts_with("http");
    let archive = data.join(format!("{kind}-download.tar.gz"));
    let digest = download(app, what, &source, &archive)?;
    match expected {
        Some(sum) if !digest.eq_ignore_ascii_case(sum) => {
            let _ = fs::remove_file(&archive);
            return Err("The downloaded file failed its check (SHA-256 mismatch) and was not installed. Please try again.".into());
        }
        None if remote => {
            let _ = fs::remove_file(&archive);
            return Err("This version has no checksum for this component, so it can't be installed from the network.".into());
        }
        _ => {}
    }
    let fresh = data.join(format!("{kind}.new"));
    let _ = fs::remove_dir_all(&fresh);
    fs::create_dir_all(&fresh).map_err(|e| e.to_string())?;
    let unpacked = unpack(&archive, &fresh);
    let _ = fs::remove_file(&archive);
    if unpacked.is_err() || !fresh.join(format!("openpdf-{kind}")).join(exe(program)).is_file() {
        let _ = fs::remove_dir_all(&fresh);
        return Err("The downloaded component is incomplete; unpacking failed.".into());
    }
    let target = data.join(kind);
    let _ = fs::remove_dir_all(&target);
    fs::rename(&fresh, &target).map_err(|e| format!("Can't install: {e}"))
}

/// Download a tier's model files into `<data>/models/<tier>/`, checking each.
fn install_model_files<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<(), String> {
    let spec = tier(name).ok_or("unknown model")?;
    let folder = data_dir(app).ok_or("no data folder")?.join("models").join(name);
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    for f in spec["files"].as_array().into_iter().flatten() {
        let file_name = f["name"].as_str().unwrap_or_default();
        let target = folder.join(file_name);
        if fs::metadata(&target).map(|m| Some(m.len()) == f["size"].as_u64()).unwrap_or(false) {
            continue;
        }
        let part = folder.join(format!("{file_name}.part"));
        send(app, "line", name, &format!("Downloading {file_name}…"), None);
        let digest = download(app, name, f["url"].as_str().unwrap_or_default(), &part)?;
        if !digest.eq_ignore_ascii_case(f["sha256"].as_str().unwrap_or_default()) {
            let _ = fs::remove_file(&part);
            return Err(format!("{file_name} failed its check (SHA-256 mismatch) and was not kept. Please try again."));
        }
        fs::rename(&part, &target).map_err(|e| format!("Can't save {file_name}: {e}"))?;
    }
    Ok(())
}

/// Run on the main thread (services stop with the app only when started there).
fn on_main<R: Runtime, F: FnOnce(&AppHandle<R>) -> Result<(), String> + Send + 'static>(app: &AppHandle<R>, f: F) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(f(&handle));
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

fn wait_for(url: &str, seconds: u64) -> bool {
    let Ok(client) = reqwest::blocking::Client::builder().timeout(Duration::from_secs(3)).build() else { return false };
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(seconds) {
        if client.get(url).send().map(|r| r.status().is_success()).unwrap_or(false) {
            return true;
        }
        thread::sleep(Duration::from_millis(500));
    }
    false
}

/// Development checkout: the containers' install scripts.
fn run_script<R: Runtime>(app: &AppHandle<R>, what: &str, script: &str, args: &[&str]) -> Result<(), String> {
    let root = std::env::current_dir().map_err(|e| e.to_string())?;
    let root = root.ancestors().find(|p| p.join("scripts").join(script).is_file()).ok_or("not an OpenPDF checkout")?.to_path_buf();
    let mut child = Command::new("bash")
        .arg(root.join("scripts").join(script))
        .args(args)
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Can't start {script}: {e}"))?;
    let (tx, rx) = mpsc::channel();
    pump(child.stdout.take().unwrap(), tx.clone(), false);
    pump(child.stderr.take().unwrap(), tx, true);
    for (_, line) in rx {
        send(app, "line", what, &line, None);
    }
    let ok = child.wait().map(|s| s.success()).unwrap_or(false);
    if ok { Ok(()) } else { Err(format!("{script} failed; see the lines above")) }
}

fn install<R: Runtime>(app: &AppHandle<R>, what: &str) -> Result<(), String> {
    let desktop = app.try_state::<Backend>().is_some();
    if !desktop {
        return match what {
            "structure" => run_script(app, what, "install-structure.sh", &[]),
            "fast" | "best" => run_script(app, what, "install-model.sh", &[what]),
            _ => Err("unknown component".into()),
        };
    }
    let model = matches!(what, "fast" | "best");
    if model && tier(what).is_none() {
        return Err("unknown model".into());
    }
    if what != "structure" && !model {
        return Err("unknown component".into());
    }
    if model && what == "best" {
        // refuse before downloading 2.8 GB that could not run here
        if let Some(llama) = llama_program(app) {
            let need = tier(what).and_then(|s| s["min_gpu_mb"].as_u64()).unwrap_or(0);
            if gpu_free_mb(&llama).unwrap_or(0) < need {
                return Err(format!("The best model needs a graphics card with {need} MB free; this computer has less."));
            }
        }
    }
    let steps = if model { 4 } else { 2 };
    if structure_program(app).is_none() {
        send(app, "line", what, &format!("STEP 1/{steps} Downloading the document reading component…"), None);
        install_pack(app, what, "structure", STRUCTURE_SHA256, "openpdf-structure")?;
    }
    if model {
        if llama_program(app).is_none() {
            send(app, "line", what, &format!("STEP 2/{steps} Downloading the model runtime…"), None);
            install_pack(app, what, "llama", LLAMA_SHA256, "llama-server")?;
        }
        if what == "best" {
            let need = tier(what).and_then(|s| s["min_gpu_mb"].as_u64()).unwrap_or(0);
            if gpu_free_mb(&llama_program(app).ok_or("runtime missing")?).unwrap_or(0) < need {
                return Err(format!("The best model needs a graphics card with {need} MB free; this computer has less."));
            }
        }
        send(app, "line", what, &format!("STEP 3/{steps} Downloading the model…"), None);
        install_model_files(app, what)?;
        let data = data_dir(app).ok_or("no data folder")?;
        fs::write(data.join("models").join("selected"), what).map_err(|e| e.to_string())?;
    }
    send(app, "line", what, &format!("STEP {steps}/{steps} Starting…"), None);
    restart(app)
}

/// Start (again) the structure component and the selected model, then wait for them.
fn restart<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    on_main(app, |app| app.state::<Backend>().restart_reading(app).map_err(|e| e.to_string()))?;
    let backend = app.state::<Backend>();
    if selected(app).is_some() && !wait_for(&format!("http://127.0.0.1:{}/health", backend.model_port), 300) {
        return Err("The model didn't start; see model.log in the logs folder.".into());
    }
    if structure_program(app).is_some() && !wait_for(&format!("http://127.0.0.1:{}/health", backend.structure_port), 300) {
        return Err("The document reading component didn't start; see structure.log in the logs folder.".into());
    }
    Ok(())
}

fn select<R: Runtime>(app: &AppHandle<R>, what: &str) -> Result<(), String> {
    if what != "off" && !downloaded(app, what) {
        return install(app, what);
    }
    let data = data_dir(app).ok_or("no data folder")?;
    fs::create_dir_all(data.join("models")).map_err(|e| e.to_string())?;
    fs::write(data.join("models").join("selected"), what).map_err(|e| e.to_string())?;
    if app.try_state::<Backend>().is_some() { restart(app) } else { Ok(()) }
}

fn remove<R: Runtime>(app: &AppHandle<R>, what: &str) -> Result<(), String> {
    if tier(what).is_none() {
        return Err("unknown model".into());
    }
    let data = data_dir(app).ok_or("no data folder")?;
    let was_selected = selected(app).as_deref() == Some(what);
    if was_selected {
        fs::write(data.join("models").join("selected"), "off").map_err(|e| e.to_string())?;
        if app.try_state::<Backend>().is_some() {
            restart(app)?;
        }
    }
    fs::remove_dir_all(data.join("models").join(what)).map_err(|e| format!("Can't remove the model: {e}"))
}
