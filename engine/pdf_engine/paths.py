"""Where the tools may read and write, and how paths cross the container wall.

Agents pass paths as they see them on their own computer. In a container the
same folder is mounted somewhere else, so ``PDF_ENGINE_PATH_MAP`` maps
prefixes: ``/Users/ana/Documents=/data`` or ``C:\\Users\\ana\\Docs=/data``
(several separated by ``;``). Results are reported with host paths again.

``PDF_ENGINE_ROOTS`` (``;``-separated, local paths) limits access to those
folders. Without it, mapped folders are the roots; without a map either, a
container may use what was mounted into it and a native run is limited to the
user's home folder.
"""
from __future__ import annotations

import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath


class PathError(ValueError):
    pass


_UMASK = os.umask(0)  # read once at import (os.umask can only be read by setting it)
os.umask(_UMASK)


def _norm_host(p: str) -> str:
    p = p.strip().replace("\\", "/")
    if re.match(r"^[A-Za-z]:", p):  # Windows: case-insensitive, one form
        p = p[0].upper() + p[1:]
    return p.rstrip("/") or "/"


def _is_windows_host(p: str) -> bool:
    return bool(re.match(r"^[A-Za-z]:", p))


@dataclass
class Mapping:
    host: str
    local: str


class PathPolicy:
    def __init__(self, path_map: str | None = None, roots: str | None = None, in_container: bool | None = None):
        path_map = os.environ.get("PDF_ENGINE_PATH_MAP", "") if path_map is None else path_map
        roots = os.environ.get("PDF_ENGINE_ROOTS", "") if roots is None else roots
        if in_container is None:
            in_container = os.environ.get("PDF_ENGINE_CONTAINER") == "1"
        self.maps: list[Mapping] = []
        for part in path_map.split(";"):
            if "=" not in part:
                continue
            host, local = part.rsplit("=", 1)
            if host.strip() and local.strip():
                self.maps.append(Mapping(_norm_host(host), local.strip().rstrip("/") or "/"))
        # longest prefix first
        self.maps.sort(key=lambda m: len(m.host), reverse=True)
        if roots.strip():
            self.roots = [Path(r).expanduser().resolve() for r in roots.split(";") if r.strip()]
        elif self.maps:
            self.roots = [Path(m.local).resolve() for m in self.maps]
        elif in_container:
            self.roots = mounted_folders()  # only what the user shared, never the image itself
        else:
            self.roots = [Path.home().resolve()]

    # ------------------------------------------------------------ host <-> local

    def to_local(self, raw: str) -> Path:
        if not raw or not str(raw).strip():
            raise PathError("A path is required")
        raw = str(raw).strip()
        host = _norm_host(raw)
        for m in self.maps:
            matches = (
                host.lower() == m.host.lower() or host.lower().startswith(m.host.lower() + "/")
                if _is_windows_host(m.host)
                else host == m.host or host.startswith(m.host.rstrip("/") + "/")
            )
            if matches:
                rest = host[len(m.host):].lstrip("/")
                return Path(str(PurePosixPath(m.local) / rest)) if rest else Path(m.local)
        if _is_windows_host(raw):
            raise PathError(
                f"{raw} is a Windows path that is not shared with the engine; "
                "add its folder to PDF_ENGINE_PATH_MAP"
            )
        path = Path(raw).expanduser()
        if not path.is_absolute():
            raise PathError(f"Use an absolute path (got {raw})")
        return path

    def to_host(self, local: Path | str) -> str:
        s = str(local)
        for m in sorted(self.maps, key=lambda m: len(m.local), reverse=True):
            if s == m.local or s.startswith(m.local.rstrip("/") + "/"):
                rest = s[len(m.local):].lstrip("/")
                if not rest:
                    return m.host
                sep = "\\" if _is_windows_host(m.host) else "/"
                return m.host.rstrip("/") + sep + rest.replace("/", sep)
        return s

    # ------------------------------------------------------------ checks

    def _inside_roots(self, path: Path) -> bool:
        resolved = path.resolve()
        return any(resolved == r or r in resolved.parents for r in self.roots)

    def _no_roots(self) -> PathError:
        return PathError(
            "No folder is shared with the engine. Mount one, e.g. docker run -v \"$HOME/Documents:$HOME/Documents\" ..."
        )

    def readable(self, raw: str, *, suffixes: tuple[str, ...] = (".pdf",)) -> Path:
        if not self.roots:
            raise self._no_roots()
        path = self.to_local(raw)
        resolved = path.resolve()  # from here on only the resolved path is used
        if not self._inside_roots(resolved):  # before any existence check: no probing outside
            raise PathError(f"{raw} is outside the folders this engine may use")
        if not resolved.exists():
            raise PathError(f"File not found: {raw}")
        if not resolved.is_file():
            raise PathError(f"Not a file: {raw}")
        if suffixes and resolved.suffix.lower() not in suffixes:
            raise PathError(f"Expected a {' or '.join(suffixes)} file: {raw}")
        return resolved

    def writable(self, raw: str, *, overwrite: bool = False, suffixes: tuple[str, ...] = (".pdf",),
                 inputs: tuple[Path, ...] = ()) -> Path:
        if not self.roots:
            raise self._no_roots()
        path = self.to_local(raw)
        if suffixes and path.suffix.lower() not in suffixes:
            raise PathError(f"The output must end in {' or '.join(suffixes)}: {raw}")
        path = path.parent.resolve() / path.name
        if not self._inside_roots(path):  # before any existence check: no probing outside
            raise PathError(f"{raw} is outside the folders this engine may use")
        if not path.parent.is_dir():
            raise PathError(f"The output folder does not exist: {self.to_host(path.parent)}")
        if path.is_symlink():
            raise PathError(f"{raw} is a symbolic link; choose another output name")
        for src in inputs:
            if path.exists() and os.path.samefile(path, src):
                raise PathError("The output cannot be one of the input files: originals are never replaced")
        if path.exists() and not overwrite:
            raise PathError(f"{raw} already exists; pass overwrite=true or choose another name")
        return path

    def output_for(self, source: Path, label: str, output: str = "", *, overwrite: bool = False,
                   suffix: str = ".pdf") -> Path:
        """The given output, or ``<name>.<label>.pdf`` next to the source (never clobbering a file)."""
        if output and output.strip():
            return self.writable(output, overwrite=overwrite, suffixes=(suffix,), inputs=(source,))
        stem = source.name[: -len(source.suffix)] if source.suffix else source.name
        candidate = source.with_name(f"{stem}.{label}{suffix}")
        n = 2
        while candidate.exists() or candidate.is_symlink():
            candidate = source.with_name(f"{stem}.{label}-{n}{suffix}")
            n += 1
        if not self._inside_roots(candidate):
            raise PathError(f"{self.to_host(candidate)} is outside the folders this engine may use")
        return candidate


def write_atomic(path: Path, data: bytes, *, overwrite: bool = False) -> None:
    """Write via a fresh temporary file (random name, created exclusively, never a
    symlink), then publish it. Without ``overwrite`` an existing file is never
    replaced, even one created a moment ago."""
    fd, tmp = tempfile.mkstemp(prefix=".", suffix=".part", dir=path.parent)
    try:
        # mkstemp makes the file owner-only; give it normal permissions (or keep those of
        # the file being replaced), so the user can open what the engine wrote.
        if overwrite and path.exists():
            mode = path.stat().st_mode & 0o7777
        else:
            mode = 0o666 & ~_UMASK
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        if overwrite:
            os.replace(tmp, path)
            return
        try:
            os.link(tmp, path)  # fails if path exists
        except FileExistsError:
            raise PathError(f"{path.name} appeared while writing; nothing was replaced") from None
        except OSError:
            # file systems without hard links (some shared folders): exclusive create instead
            try:
                out = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644)
            except FileExistsError:
                raise PathError(f"{path.name} appeared while writing; nothing was replaced") from None
            with os.fdopen(out, "wb") as fh:
                fh.write(data)
    finally:
        if os.path.lexists(tmp):
            os.unlink(tmp)


# File systems that are part of the container itself, never a shared folder.
_SYSTEM_FS = {"overlay", "proc", "sysfs", "tmpfs", "devpts", "mqueue", "cgroup", "cgroup2", "devtmpfs",
              "securityfs", "nsfs", "shm", "bpf", "tracefs", "debugfs", "fusectl", "configfs", "pstore",
              "binfmt_misc", "autofs", "hugetlbfs", "rpc_pipefs", "fuse.lxcfs"}
_SYSTEM_PATHS = ("/proc", "/sys", "/dev", "/etc", "/run", "/usr", "/lib", "/bin", "/sbin", "/app", "/opt")


def mounted_folders(mountinfo: str = "/proc/self/mountinfo") -> list[Path]:
    """Folders bind-mounted into this container: the only places the tools may use."""
    roots: list[Path] = []
    try:
        lines = Path(mountinfo).read_text().splitlines()
    except OSError:
        return roots
    for line in lines:
        left, _, right = line.partition(" - ")
        fields, rfields = left.split(), right.split()
        if len(fields) < 5 or not rfields:
            continue
        point = fields[4].replace("\\040", " ")
        fstype = rfields[0]
        bind_of_subfolder = fields[3] != "/"  # e.g. a host /tmp folder that happens to be on tmpfs
        if (fstype in _SYSTEM_FS and not (fstype == "tmpfs" and bind_of_subfolder)) or point == "/" \
                or any(point == p or point.startswith(p + "/") for p in _SYSTEM_PATHS):
            continue
        if Path(point).is_dir():
            roots.append(Path(point).resolve())
    return roots
