"""OpenPDF's Python services in one program, for the desktop installer.

    openpdf-server gateway --port 8090    the editor + REST API (gateway/app)
    openpdf-server qpdf    --port 8093    merge / split / rotate ... (services/qpdf)

The desktop app starts one process per service with free ports and passes
the other services' addresses through the environment (PDFBOX_URL, ...).
Both listen on 127.0.0.1 only.
"""
import argparse
import os
import sys
import threading
import time


def exit_with_parent() -> None:
    """Stop when the desktop app that started us is gone, even if it could not
    stop us itself (crash, killed). It passes its process id in
    OPENPDF_PARENT_PID. (Linux also has PR_SET_PDEATHSIG; Windows and macOS
    have nothing like it.)"""
    raw = os.environ.get("OPENPDF_PARENT_PID", "")
    if not raw.isdigit():
        return
    pid = int(raw)

    def watch() -> None:
        if sys.platform == "win32":
            import ctypes

            synchronize, infinite = 0x00100000, 0xFFFFFFFF
            handle = ctypes.windll.kernel32.OpenProcess(synchronize, False, pid)
            if handle:
                ctypes.windll.kernel32.WaitForSingleObject(handle, infinite)
            os._exit(0)
        while os.getppid() == pid:  # reparented once the app is gone
            time.sleep(1)
        os._exit(0)

    threading.Thread(target=watch, name="parent-watch", daemon=True).start()


def main() -> None:
    parser = argparse.ArgumentParser(prog="openpdf-server")
    parser.add_argument("service", choices=["gateway", "qpdf"])
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    exit_with_parent()

    if args.service == "gateway":
        from app.main import app  # gateway/app
    else:
        from qpdf_service import app  # services/qpdf/app/main.py

    import uvicorn

    # Plain asyncio + h11: nothing to discover at run time, so nothing that
    # PyInstaller could miss.
    uvicorn.run(app, host="127.0.0.1", port=args.port, loop="asyncio", http="h11",
                lifespan="on", log_level=os.environ.get("OPENPDF_LOG_LEVEL", "warning"),
                access_log=False)


if __name__ == "__main__":
    sys.exit(main())
