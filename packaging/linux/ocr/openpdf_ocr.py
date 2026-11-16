"""OpenPDF's OCR add-on for the desktop app: services/ocr as one program.

    openpdf-ocr --port 8091

The desktop app downloads this add-on the first time OCR is used, unpacks it
into its data folder and starts it on a port the gateway already knows.
Listens on 127.0.0.1 only. Models are inside; nothing is downloaded at run
time.
"""
import argparse
import multiprocessing
import os
import sys
import threading
import time

# Before ONNX Runtime loads: no usage telemetry (see services/ocr/Dockerfile).
os.environ.setdefault("ORT_DISABLE_TELEMETRY", "1")


def exit_with_parent() -> None:
    """Stop when the desktop app that started us is gone (it passes its process
    id in OPENPDF_PARENT_PID); see packaging/linux/server/openpdf_server.py."""
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
        while os.getppid() == pid:
            time.sleep(1)
        os._exit(0)

    threading.Thread(target=watch, name="parent-watch", daemon=True).start()


def main() -> None:
    parser = argparse.ArgumentParser(prog="openpdf-ocr")
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    exit_with_parent()

    from app.main import app  # services/ocr/app

    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=args.port, loop="asyncio", http="h11",
                lifespan="on", log_level=os.environ.get("OPENPDF_LOG_LEVEL", "warning"),
                access_log=False)


if __name__ == "__main__":
    multiprocessing.freeze_support()
    sys.exit(main())
