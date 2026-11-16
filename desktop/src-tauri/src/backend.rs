//! The installed app's own services.
//!
//! An installed OpenPDF (.deb, AppImage, ...) carries its services in the
//! resource folder `backend/` (built by packaging/linux/build-all.sh):
//!
//! ```text
//! backend/server/openpdf-server    gateway + qpdf service (Python, PyInstaller)
//! backend/qpdf/bin/qpdf            qpdf
//! backend/pdfbox/jre/bin/java      Java runtime cut down to what PDFBox needs
//! backend/pdfbox/app.jar           PDFBox service
//! backend/pdfbox/fonts/            Chinese font written into PDFs
//! ```
//!
//! The app starts them on free local ports when it opens and stops them when
//! it closes. A development checkout has no such folder and keeps using
//! scripts/start.sh and the containers.

use std::fs::{self, File};
use std::io;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime};

pub struct Backend {
    children: Mutex<Vec<(&'static str, Child)>>,
    pub gateway_port: u16,
    /// Reserved for the OCR add-on: the gateway is told this address up front,
    /// so OCR can be started later (after installing) without a restart.
    pub ocr_port: u16,
    /// Reserved for the document reading add-ons (addons.rs): the structure
    /// component (the gateway knows its address) and the reading model (the
    /// structure component knows its).
    pub structure_port: u16,
    pub model_port: u16,
    pub log_dir: PathBuf,
    /// The editor runs on another port than last time (that one was taken):
    /// what it stored in the browser (language, signatures...) is not there.
    pub port_changed: bool,
}

pub(crate) fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// A path the bundled programs can use. On Windows the app's own folders come
/// back as `\\?\C:\...` ("verbatim" paths), which Java cannot open
/// (`java -jar \\?\C:\...\app.jar` fails): drop that prefix.
pub(crate) fn plain(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

/// The bundled services folder, if this is an installed app.
pub fn bundled_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = plain(app.path().resource_dir().ok()?).join("backend");
    dir.join("server").join(exe("openpdf-server")).is_file().then_some(dir)
}

/// A port nobody listens on right now. (Another program could take it before
/// our service does; unlikely enough on 127.0.0.1 for a desktop app.)
fn free_port() -> io::Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

/// First choice for the editor's port (a fixed, rarely used number).
const EDITOR_PORT: u16 = 47_380;
/// Next choices when it is taken: fixed numbers too, so the same address comes
/// back on the next start in the same situation.
const EDITOR_PORT_FALLBACKS: std::ops::RangeInclusive<u16> = 47_381..=47_389;

/// The editor's port, the same every time if at all possible.
///
/// The editor page keeps the user's settings (language, save mode) and saved
/// signatures in browser storage, which belongs to the page's address,
/// port included: a new port each start would look like a new, empty browser.
/// The editor installed as an app from Chrome (PWA) belongs to its address in
/// the same way, and only finds the services there. So the port is remembered
/// in `<data>/editor-port` and reused while it is free; only if something else
/// holds it is another one chosen, for this start only (the editor then tells
/// the user its settings are missing): the next fixed number that is free, a
/// random one only if all are taken. The other services are internal and may
/// use any port.
fn editor_port(data: &Path) -> io::Result<(u16, bool)> {
    let file = data.join("editor-port");
    let saved = fs::read_to_string(&file).ok().and_then(|t| t.trim().parse::<u16>().ok());
    let free = |port: u16| TcpListener::bind(("127.0.0.1", port)).is_ok();
    let port = match saved {
        Some(port) if port != 0 && free(port) => return Ok((port, false)),
        _ => match std::iter::once(EDITOR_PORT).chain(EDITOR_PORT_FALLBACKS).find(|&port| free(port)) {
            Some(port) => port,
            None => free_port()?,
        },
    };
    if saved.is_some() {
        eprintln!("editor port {saved:?} is taken; using {port} (settings stored in the editor start fresh)");
    }
    // Keep the port the editor's settings belong to: the next start tries it
    // again, and once that program is gone the settings are back.
    if saved.is_none() {
        fs::write(&file, port.to_string())?;
    }
    Ok((port, saved.is_some_and(|s| s != port)))
}

/// Start `cmd` with its output in `<log_dir>/<name>.log`. The child is told
/// our process id (OPENPDF_PARENT_PID) and stops by itself once we are gone,
/// even if we die without cleaning up (every service watches for it; on Linux
/// the kernel also sends SIGTERM).
fn spawn(name: &str, mut cmd: Command, log_dir: &Path) -> io::Result<Child> {
    let log = File::create(log_dir.join(format!("{name}.log")))?;
    cmd.stdin(Stdio::null()).stdout(log.try_clone()?).stderr(log);
    cmd.env("OPENPDF_PARENT_PID", std::process::id().to_string());
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        // PR_SET_PDEATHSIG fires when the *thread* that spawned the child
        // exits, so this must run on the main thread (Tauri's setup does).
        unsafe {
            cmd.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

/// Start the bundled services. Call from the main thread.
pub fn start<R: Runtime>(app: &AppHandle<R>, dir: &Path) -> io::Result<Backend> {
    let data = plain(app.path().app_data_dir().map_err(io::Error::other)?);
    let log_dir = data.join("logs");
    let sessions = data.join("sessions");
    fs::create_dir_all(&log_dir)?;
    fs::create_dir_all(&sessions)?;

    let (gateway_port, port_changed) = editor_port(&data)?;
    let other_port = || -> io::Result<u16> {
        loop {
            let port = free_port()?;
            if port != gateway_port {
                return Ok(port);
            }
        }
    };
    let (pdfbox_port, qpdf_port, ocr_port) = (other_port()?, other_port()?, other_port()?);
    let (structure_port, model_port) = (other_port()?, other_port()?);
    let server = dir.join("server").join(exe("openpdf-server"));
    let mut children = Vec::new();

    let pdfbox = dir.join("pdfbox");
    let mut java = Command::new(pdfbox.join("jre").join("bin").join(exe("java")));
    java.args([
        "-Xms32m",
        "-Xmx2g",
        "-XX:+UseG1GC",
        "-XX:ParallelGCThreads=2",
        "-XX:ConcGCThreads=1",
        // give memory back to the system when idle
        "-XX:G1PeriodicGCInterval=30000",
        "-XX:+UseStringDeduplication",
        "-Djava.awt.headless=true",
        // lets PDFBox release memory-mapped files early (else it logs an error)
        "--add-opens=java.base/java.nio=ALL-UNNAMED",
        "--add-opens=java.base/jdk.internal.ref=ALL-UNNAMED",
        "-jar",
    ])
    .arg(pdfbox.join("app.jar"))
    .env("PORT", pdfbox_port.to_string())
    .env("CJK_FONT_PATH", pdfbox.join("fonts").join("wqy-microhei.ttc"))
    .env_remove("JAVA_TOOL_OPTIONS")
    .current_dir(&data);
    children.push(("pdfbox", spawn("pdfbox", java, &log_dir)?));

    let mut qpdf = Command::new(&server);
    qpdf.arg("qpdf")
        .arg("--port")
        .arg(qpdf_port.to_string())
        .env("QPDF_BIN", dir.join("qpdf").join("bin").join(exe("qpdf")))
        .current_dir(&data);
    children.push(("qpdf", spawn("qpdf", qpdf, &log_dir)?));

    let mut gateway = Command::new(&server);
    gateway
        .arg("gateway")
        .arg("--port")
        .arg(gateway_port.to_string())
        .env("PDFBOX_URL", format!("http://127.0.0.1:{pdfbox_port}"))
        .env("QPDF_URL", format!("http://127.0.0.1:{qpdf_port}"))
        // OCR is an add-on; until it runs this address answers nothing and
        // the editor offers to install it
        .env("OCR_URL", format!("http://127.0.0.1:{ocr_port}"))
        // likewise the document structure component (Markdown / JSON, the reading model)
        .env("STRUCTURE_URL", format!("http://127.0.0.1:{structure_port}"))
        .env("SESSION_DIR", &sessions)
        .env("ALLOWED_HOSTS", "127.0.0.1,localhost")
        .env("API_KEY", "")
        .current_dir(&data);
    children.push(("gateway", spawn("gateway", gateway, &log_dir)?));

    let backend = Backend {
        children: Mutex::new(children),
        gateway_port,
        ocr_port,
        structure_port,
        model_port,
        log_dir,
        port_changed,
    };
    if crate::ocr::pack_program(app).is_some() {
        if let Err(err) = backend.start_ocr(app) {
            eprintln!("OCR add-on did not start: {err}");
        }
    }
    if let Err(err) = backend.restart_reading(app) {
        eprintln!("document reading add-ons did not start: {err}");
    }
    Ok(backend)
}

impl Backend {
    /// Stop every service (the app is closing).
    pub fn stop(&self) {
        let mut children = self.children.lock().unwrap_or_else(|e| e.into_inner());
        for (_, child) in children.iter_mut() {
            let _ = child.kill();
        }
        for (_, child) in children.iter_mut() {
            let _ = child.wait();
        }
        children.clear();
    }

    /// (Re)start the document reading add-ons that are installed: the selected
    /// reading model and the structure component (told the model's address and
    /// how to prompt it). Call from the main thread (see `spawn`).
    pub fn restart_reading<R: Runtime>(&self, app: &AppHandle<R>) -> io::Result<()> {
        let mut children = self.children.lock().unwrap_or_else(|e| e.into_inner());
        for (name, child) in children.iter_mut() {
            if *name == "structure" || *name == "model" {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        children.retain(|(name, _)| *name != "structure" && *name != "model");
        let data = plain(app.path().app_data_dir().map_err(io::Error::other)?);
        if let Some(tier) = crate::addons::selected(app) {
            match crate::addons::model_command(app, &tier, self.model_port) {
                Ok(cmd) => children.push(("model", spawn("model", cmd, &self.log_dir)?)),
                Err(err) => eprintln!("reading model {tier} not started: {err}"),
            }
        }
        if let Some(program) = crate::addons::structure_program(app) {
            let profile = crate::addons::profile(app);
            let mut cmd = Command::new(program);
            cmd.arg("--port").arg(self.structure_port.to_string()).current_dir(&data);
            if !profile.is_empty() {
                cmd.env("OPENPDF_VLM_URL", format!("http://127.0.0.1:{}", self.model_port))
                    .env("OPENPDF_VLM_MODEL", profile);
            }
            children.push(("structure", spawn("structure", cmd, &self.log_dir)?));
        }
        Ok(())
    }

    /// Start the installed OCR add-on on the reserved port. Call from the main
    /// thread (see `spawn`).
    pub fn start_ocr<R: Runtime>(&self, app: &AppHandle<R>) -> io::Result<()> {
        let program = crate::ocr::pack_program(app)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "OCR add-on is not installed"))?;
        let mut children = self.children.lock().unwrap_or_else(|e| e.into_inner());
        if children.iter().any(|(name, _)| *name == "ocr") {
            return Ok(());
        }
        let data = plain(app.path().app_data_dir().map_err(io::Error::other)?);
        let mut cmd = Command::new(program);
        cmd.arg("--port").arg(self.ocr_port.to_string()).current_dir(&data);
        children.push(("ocr", spawn("ocr", cmd, &self.log_dir)?));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("openpdf-port-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn editor_port_falls_back_to_fixed_numbers() {
        // whoever holds the first choice (this test, or an OpenPDF already running)
        let _hold = TcpListener::bind(("127.0.0.1", EDITOR_PORT));
        let dir = temp_dir("fallback");
        let (port, changed) = editor_port(&dir).unwrap();
        assert!(EDITOR_PORT_FALLBACKS.contains(&port), "got {port}");
        assert!(!changed);
        assert_eq!(fs::read_to_string(dir.join("editor-port")).unwrap(), port.to_string());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn editor_port_keeps_the_remembered_port_while_it_is_free() {
        let dir = temp_dir("remembered");
        let spare = free_port().unwrap();
        fs::write(dir.join("editor-port"), spare.to_string()).unwrap();
        assert_eq!(editor_port(&dir).unwrap(), (spare, false));
        // taken: another port for this start only, the remembered one stays
        let _hold = TcpListener::bind(("127.0.0.1", spare)).unwrap();
        let (port, changed) = editor_port(&dir).unwrap();
        assert_ne!(port, spare);
        assert!(port == EDITOR_PORT || EDITOR_PORT_FALLBACKS.contains(&port), "got {port}");
        assert!(changed);
        assert_eq!(fs::read_to_string(dir.join("editor-port")).unwrap(), spare.to_string());
        let _ = fs::remove_dir_all(&dir);
    }
}
