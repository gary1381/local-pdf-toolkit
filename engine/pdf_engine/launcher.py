"""Start the PDF services and serve MCP: the container's entry point.

    pdf-engine mcp      services on 127.0.0.1, MCP on stdin/stdout (for
                        `docker run -i ...` in an MCP client's config)
    pdf-engine serve    services, the REST API + web editor on :8090 and MCP
                        over streamable HTTP on :8765/mcp (a long-running
                        engine several clients can share)

Service output goes to log files (PDF_ENGINE_LOG_DIR), never to stdout, which
belongs to the MCP protocol in `mcp` mode. Set PDF_ENGINE_OCR=0 to leave the
OCR service off (saves about 400 MB of memory). The document structure service
(Docling) only exists in images built with WITH_STRUCTURE=1; PDF_ENGINE_STRUCTURE=0
leaves it off there.
"""
from __future__ import annotations

import atexit
import importlib.util
import os
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

APP = Path(os.environ.get("PDF_ENGINE_APP", "/app"))
LOGS = Path(os.environ.get("PDF_ENGINE_LOG_DIR", "/tmp/pdf-engine/logs"))
JAVA = os.environ.get("PDF_ENGINE_JAVA", "/opt/jre/bin/java")
PY = sys.executable

PORTS = {"gateway": 8090, "ocr": 8091, "pdfbox": 8092, "qpdf": 8093, "structure": 8094}
children: list[subprocess.Popen] = []


def log(msg: str) -> None:
    print(f"[pdf-engine] {msg}", file=sys.stderr, flush=True)


def spawn(name: str, cmd: list[str], cwd: Path, env: dict[str, str]) -> None:
    LOGS.mkdir(parents=True, exist_ok=True)
    out = open(LOGS / f"{name}.log", "ab", buffering=0)
    proc = subprocess.Popen(cmd, cwd=cwd, env={**os.environ, **env}, stdin=subprocess.DEVNULL,
                            stdout=out, stderr=out, start_new_session=True)
    children.append(proc)


def stop_all() -> None:
    for p in children:
        if p.poll() is None:
            p.terminate()
    deadline = time.monotonic() + 5
    for p in children:
        try:
            p.wait(max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            p.kill()


def start_services(gateway_host: str) -> None:
    session_dir = os.environ.get("SESSION_DIR", "/tmp/pdf-engine/sessions")
    Path(session_dir).mkdir(parents=True, exist_ok=True)
    spawn("pdfbox", [JAVA, "-Xms64m", "-Xmx1g", "-XX:+UseSerialGC", "-Djava.awt.headless=true",
                     "--add-opens=java.base/java.nio=ALL-UNNAMED",
                     "--add-opens=java.base/jdk.internal.ref=ALL-UNNAMED",
                     "-jar", str(APP / "pdfbox" / "app.jar")],
          APP / "pdfbox", {"PORT": str(PORTS["pdfbox"])})
    spawn("qpdf", [PY, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(PORTS["qpdf"]),
                   "--log-level", "warning"], APP / "qpdf", {})
    ocr_on = os.environ.get("PDF_ENGINE_OCR", "1") != "0" and (APP / "ocr" / "app").is_dir()
    if ocr_on:
        spawn("ocr", [PY, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(PORTS["ocr"]),
                      "--log-level", "warning"], APP / "ocr", {"ORT_DISABLE_TELEMETRY": "1"})
    structure_on = (os.environ.get("PDF_ENGINE_STRUCTURE", "1") != "0" and (APP / "structure" / "app").is_dir()
                    and importlib.util.find_spec("docling") is not None)
    if structure_on:
        spawn("structure", [PY, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
                            "--port", str(PORTS["structure"]), "--log-level", "warning"], APP / "structure", {})
    spawn("gateway", [PY, "-m", "uvicorn", "app.main:app", "--host", gateway_host, "--port", str(PORTS["gateway"]),
                      "--log-level", "warning"], APP / "gateway", {
        "PDFBOX_URL": f"http://127.0.0.1:{PORTS['pdfbox']}",
        "QPDF_URL": f"http://127.0.0.1:{PORTS['qpdf']}",
        "OCR_URL": f"http://127.0.0.1:{PORTS['ocr']}",
        "STRUCTURE_URL": f"http://127.0.0.1:{PORTS['structure']}",
        "SESSION_DIR": session_dir,
        "ALLOWED_HOSTS": os.environ.get("ALLOWED_HOSTS", "127.0.0.1,localhost"),
    })
    atexit.register(stop_all)
    log(f"services starting (OCR {'on' if ocr_on else 'off'}, document structure "
        f"{'on' if structure_on else 'off'}); logs in {LOGS}")


def wait_ready(timeout: float = 60) -> bool:
    deadline = time.monotonic() + timeout
    url = f"http://127.0.0.1:{PORTS['gateway']}/v1/pdf/engine/ready"
    key = os.environ.get("PDF_ENGINE_API_KEY") or os.environ.get("API_KEY", "")
    while time.monotonic() < deadline:
        try:
            req = urllib.request.Request(url, headers={"X-API-Key": key} if key else {})
            with urllib.request.urlopen(req, timeout=2) as r:
                if b'"ready":true' in r.read():
                    return True
        except OSError:
            pass
        time.sleep(0.3)
    return False


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "mcp"
    os.environ.setdefault("PDF_ENGINE_GATEWAY", f"http://127.0.0.1:{PORTS['gateway']}")
    if os.environ.get("API_KEY") and not os.environ.get("PDF_ENGINE_API_KEY"):
        os.environ["PDF_ENGINE_API_KEY"] = os.environ["API_KEY"]
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    if mode == "mcp":
        start_services("127.0.0.1")
        from .server import mcp  # tools wait for the services on their first call

        mcp.run()
    elif mode == "serve":
        start_services("0.0.0.0")
        if not wait_ready():
            log(f"services did not start; see {LOGS}")
            sys.exit(1)
        log(f"ready: editor and REST API on :{PORTS['gateway']}, MCP on :8765/mcp")
        from mcp.server.transport_security import TransportSecuritySettings

        from .server import mcp

        mcp.settings.host = "0.0.0.0"
        mcp.settings.port = int(os.environ.get("PDF_ENGINE_MCP_PORT", "8765"))
        # Only answer requests addressed to this computer, and no web page origins
        # (blocks DNS-rebinding attacks from sites open in the user's browser).
        hosts = [h.strip() for h in os.environ.get("PDF_ENGINE_ALLOWED_HOSTS", "127.0.0.1,localhost").split(",") if h.strip()]
        mcp.settings.transport_security = TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=[f"{h}:*" for h in hosts] + hosts,
            allowed_origins=[],
        )
        mcp.run(transport="streamable-http")
    elif mode == "check":
        start_services("127.0.0.1")
        ok = wait_ready()
        log("ready" if ok else f"not ready; see {LOGS}")
        sys.exit(0 if ok else 1)
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
