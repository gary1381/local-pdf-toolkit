"""Start llama-server with the catalog's model for MODEL_TIER (fast | best).

The model's files are downloaded into MODELS_DIR/<tier>/ the first time and
checked against the SHA-256 in catalog.json; a file that does not match is
deleted and the server does not start. Also usable without the container:

    python3 serve.py --download-only best        # just fetch and check the files
"""
import hashlib
import json
import os
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CATALOG = json.loads((HERE / "catalog.json").read_text())


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def fetch(tier: str, models: Path) -> dict[str, Path]:
    spec = CATALOG["tiers"][tier]
    folder = models / tier
    folder.mkdir(parents=True, exist_ok=True)
    paths = {}
    for f in spec["files"]:
        target = folder / f["name"]
        if not (target.exists() and target.stat().st_size == f["size"] and sha256(target) == f["sha256"]):
            part = target.with_suffix(target.suffix + ".part")
            print(f"downloading {f['name']} ({f['size'] / 1e6:.0f} MB)", flush=True)
            urllib.request.urlretrieve(f["url"], part)
            if sha256(part) != f["sha256"]:
                part.unlink()
                sys.exit(f"{f['name']}: checksum does not match the catalog; not started")
            part.rename(target)
        paths[f["role"]] = target
    return paths


def main() -> None:
    args = sys.argv[1:]
    models = Path(os.environ.get("MODELS_DIR", "/models"))
    if args[:1] == ["--download-only"]:
        for tier in args[1:] or ["fast"]:
            print(fetch(tier, models))
        return
    tier = os.environ.get("MODEL_TIER", "fast")
    if tier not in CATALOG["tiers"]:
        sys.exit(f"MODEL_TIER must be one of {', '.join(CATALOG['tiers'])}")
    paths = fetch(tier, models)
    spec = CATALOG["tiers"][tier]
    server = os.environ.get("LLAMA_SERVER", "/opt/llama/llama-server")
    cmd = [server, "-m", str(paths["model"]), "--mmproj", str(paths["mmproj"]), *spec["server_args"],
           "--host", os.environ.get("HOST", "0.0.0.0"), "--port", os.environ.get("PORT", "8080"),
           "-ngl", os.environ.get("GPU_LAYERS", "99"), "--alias", tier]
    if os.environ.get("GPU_LAYERS") == "0":
        cmd.append("--no-mmproj-offload")  # CPU only: the vision part too
    print(" ".join(cmd), flush=True)
    os.execv(server, cmd)


if __name__ == "__main__":
    main()
