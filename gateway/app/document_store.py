"""Disk-backed editing sessions.

Each session is a folder under ``SESSION_DIR`` holding ``meta.json`` plus one
file per kept revision (``rev-<n>.pdf``). Sessions survive gateway restarts,
every write is atomic, and the most recent revisions are kept so the editor
can undo and redo. A per-session asyncio lock serialises read-modify-write
edits so concurrent requests can no longer overwrite each other.

The store assumes a single gateway process (one uvicorn worker).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

from app.config import settings

log = logging.getLogger("openpdf.sessions")

_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


@dataclass
class DocumentEntry:
    doc_id: str
    filename: str
    revision: int
    created_at: float
    last_access: float
    revisions: list[int] = field(default_factory=list)
    sizes: dict[str, int] = field(default_factory=dict)
    etag: str = ""

    @property
    def size(self) -> int:
        return self.sizes.get(str(self.revision), 0)

    @property
    def disk_bytes(self) -> int:
        return sum(self.sizes.values())


class SessionNotFound(KeyError):
    pass


class RevisionNotFound(KeyError):
    pass


_index: dict[str, DocumentEntry] = {}
_locks: dict[str, asyncio.Lock] = {}
_loaded = False


def _root() -> Path:
    root = Path(settings.session_dir)
    root.mkdir(parents=True, exist_ok=True)
    return root


def _doc_dir(doc_id: str) -> Path:
    return _root() / doc_id


def _rev_path(doc_id: str, revision: int) -> Path:
    return _doc_dir(doc_id) / f"rev-{revision}.pdf"


def valid_id(doc_id: str) -> bool:
    return bool(doc_id) and bool(_ID_RE.match(doc_id))


def content_etag(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _atomic_write(path: Path, data: bytes) -> None:
    # Write-then-rename keeps every file whole if the gateway stops mid-write.
    # No fsync: sessions are scratch copies (the user's file is saved
    # separately), and on a busy disk each fsync can take seconds, which made
    # opening a file and every edit wait. After a power cut, _load_index
    # checks sizes and falls back to the last intact revision.
    tmp = path.with_suffix(path.suffix + f".tmp-{uuid.uuid4().hex}")
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)


def _write_meta(entry: DocumentEntry) -> None:
    _atomic_write(_doc_dir(entry.doc_id) / "meta.json", json.dumps(asdict(entry)).encode("utf-8"))


def _intact(doc_id: str, revision: int, size: int | None) -> bool:
    try:
        return _rev_path(doc_id, revision).stat().st_size == size
    except OSError:
        return False


def _trim_to_intact(entry: DocumentEntry) -> None:
    """Drop revisions whose file is missing or cut short (e.g. after a power cut)."""
    good = [r for r in entry.revisions if _intact(entry.doc_id, r, entry.sizes.get(str(r)))]
    if not good:
        raise FileNotFoundError("no intact revision")
    if good != entry.revisions or entry.revision not in good:
        dropped = set(entry.revisions) - set(good)
        entry.revisions = good
        if entry.revision not in good:
            entry.revision = max(r for r in good if r <= entry.revision) if any(
                r <= entry.revision for r in good
            ) else good[-1]
        for rev in dropped:
            entry.sizes.pop(str(rev), None)
        entry.etag = content_etag(_read_sync(entry.doc_id, entry.revision))
        _write_meta(entry)
        log.warning("Session %s: dropped damaged revisions %s", entry.doc_id, sorted(dropped))


def _load_index() -> None:
    global _loaded
    if _loaded:
        return
    _loaded = True
    for child in _root().iterdir():
        if not child.is_dir() or not valid_id(child.name):
            continue
        meta = child / "meta.json"
        try:
            data = json.loads(meta.read_text("utf-8"))
            entry = DocumentEntry(**data)
            _trim_to_intact(entry)
            _index[entry.doc_id] = entry
        except Exception as exc:  # corrupt or half-written session: drop it
            log.warning("Dropping unreadable session %s: %s", child.name, exc)
            shutil.rmtree(child, ignore_errors=True)
    log.info("Loaded %d editing sessions from %s", len(_index), _root())


def lock(doc_id: str) -> asyncio.Lock:
    found = _locks.get(doc_id)
    if found is None:
        found = asyncio.Lock()
        _locks[doc_id] = found
    return found


def get(doc_id: str) -> DocumentEntry | None:
    _load_index()
    if not valid_id(doc_id):
        return None
    entry = _index.get(doc_id)
    if entry is not None:
        entry.last_access = time.time()
    return entry


def require(doc_id: str) -> DocumentEntry:
    entry = get(doc_id)
    if entry is None:
        raise SessionNotFound(doc_id)
    return entry


def _read_sync(doc_id: str, revision: int) -> bytes:
    return _rev_path(doc_id, revision).read_bytes()


async def read(doc_id: str, revision: int | None = None) -> bytes:
    entry = require(doc_id)
    rev = entry.revision if revision is None else revision
    if rev not in entry.revisions:
        raise RevisionNotFound(rev)
    return await asyncio.to_thread(_read_sync, doc_id, rev)


def _create_sync(content: bytes, filename: str) -> DocumentEntry:
    doc_id = str(uuid.uuid4())
    _doc_dir(doc_id).mkdir(parents=True, exist_ok=False)
    now = time.time()
    entry = DocumentEntry(
        doc_id=doc_id,
        filename=filename,
        revision=1,
        created_at=now,
        last_access=now,
        revisions=[1],
        sizes={"1": len(content)},
        etag=content_etag(content),
    )
    _atomic_write(_rev_path(doc_id, 1), content)
    _write_meta(entry)
    return entry


async def create(content: bytes, filename: str) -> str:
    _load_index()
    entry = await asyncio.to_thread(_create_sync, content, filename)
    _index[entry.doc_id] = entry
    await evict()
    return entry.doc_id


def _update_sync(entry: DocumentEntry, content: bytes) -> list[int]:
    new_rev = entry.revision + 1
    _atomic_write(_rev_path(entry.doc_id, new_rev), content)
    entry.revisions.append(new_rev)
    entry.sizes[str(new_rev)] = len(content)
    entry.revision = new_rev
    entry.etag = content_etag(content)
    dropped: list[int] = []
    while len(entry.revisions) > max(1, settings.session_history):
        dropped.append(entry.revisions.pop(0))
    for rev in dropped:
        entry.sizes.pop(str(rev), None)
    _write_meta(entry)
    for rev in dropped:
        try:
            _rev_path(entry.doc_id, rev).unlink()
        except FileNotFoundError:
            pass
    return dropped


async def update(doc_id: str, content: bytes, filename: str | None = None) -> tuple[int, int]:
    """Store a new revision. Returns (previous_revision, new_revision)."""
    entry = require(doc_id)
    previous = entry.revision
    if filename:
        entry.filename = filename
    entry.last_access = time.time()
    await asyncio.to_thread(_update_sync, entry, content)
    await evict()
    return previous, entry.revision


async def restore(doc_id: str, revision: int) -> tuple[int, int]:
    """Make an older (or newer, for redo) kept revision current again."""
    content = await read(doc_id, revision)
    return await update(doc_id, content)


def _delete_sync(doc_id: str) -> None:
    shutil.rmtree(_doc_dir(doc_id), ignore_errors=True)


async def delete(doc_id: str) -> None:
    _index.pop(doc_id, None)
    _locks.pop(doc_id, None)
    await asyncio.to_thread(_delete_sync, doc_id)


async def evict() -> None:
    """Drop idle sessions, then the least recently used ones over the size cap."""
    now = time.time()
    ttl = settings.session_ttl_hours * 3600
    busy = {doc_id for doc_id, lk in _locks.items() if lk.locked()}
    for doc_id, entry in list(_index.items()):
        if doc_id not in busy and now - entry.last_access > ttl:
            log.info("Evicting idle session %s", doc_id)
            await delete(doc_id)
    cap = settings.session_max_total_mb * 1024 * 1024
    total = sum(e.disk_bytes for e in _index.values())
    if total <= cap:
        return
    for entry in sorted(_index.values(), key=lambda e: e.last_access):
        if total <= cap:
            break
        if entry.doc_id in busy:
            continue
        # never evict something used in the last hour
        if now - entry.last_access < 3600:
            continue
        log.info("Evicting session %s to stay under %d MB", entry.doc_id, settings.session_max_total_mb)
        total -= entry.disk_bytes
        await delete(entry.doc_id)


def stats() -> dict:
    _load_index()
    return {
        "sessions": len(_index),
        "disk_mb": round(sum(e.disk_bytes for e in _index.values()) / 1024 / 1024, 1),
    }
