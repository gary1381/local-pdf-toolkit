"""OpenPDF's document structure add-on for the desktop app: services/structure
as one program (Docling with its layout and table models, CPU).

    openpdf-structure --port 8094

The desktop app downloads this add-on when the user asks for it, unpacks it
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

# Models are inside the program (see packaging/linux/build-structure.sh): never fetch.
for k, v in (("HF_HUB_OFFLINE", "1"), ("TRANSFORMERS_OFFLINE", "1"), ("HF_HUB_DISABLE_TELEMETRY", "1")):
    os.environ.setdefault(k, v)
if getattr(sys, "frozen", False):
    os.environ.setdefault("OPENPDF_STRUCTURE_MODELS", os.path.join(sys._MEIPASS, "structure-models"))


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
    parser = argparse.ArgumentParser(prog="openpdf-structure")
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    exit_with_parent()

    from app.main import app  # services/structure/app

    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=args.port, loop="asyncio", http="h11",
                lifespan="on", log_level=os.environ.get("OPENPDF_LOG_LEVEL", "warning"),
                access_log=False)


if __name__ == "__main__":
    multiprocessing.freeze_support()
    sys.exit(main())
