"""The hidden ``.imy/`` folder next to your code and its virtual file system.

Layout::

    .imy/
      build/          compiled programs (one file per .imy source and target)
      cache/          deterministic compile cache (one JSON file per key)
      vfs/            real locations behind ship ("/virtual:paths") and mirrored web resources
      repos/          repositories cloned by `imy inject`
      console/        the scratch file behind `imy console`
      manifest.json   virtual path -> real path map
      memory.json     optional project-local memory (created by `imy init --local-memory`)
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import httpx2

from .errors import RunnerError
from .parser import ParsedSource
from .prompts import WebResourceNote

WORKSPACE_DIR = ".imy"
MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024


@dataclass(frozen=True)
class Workspace:
    root: Path

    @classmethod
    def discover(cls, start: Path, *, home: Path | None = None) -> Workspace:
        """The nearest folder (from ``start`` upward) that has a .imy/ workspace, else ``start``'s folder."""
        origin = start.resolve()
        if origin.is_file() or not origin.exists():
            origin = origin.parent
        skip = home.resolve() if home is not None else None
        for candidate in (origin, *origin.parents):
            marker = candidate / WORKSPACE_DIR
            if marker.is_dir() and (skip is None or marker.resolve() != skip):
                return cls(candidate)
        return cls(origin)

    @property
    def dot(self) -> Path:
        return self.root / WORKSPACE_DIR

    @property
    def build(self) -> Path:
        return self.dot / "build"

    @property
    def cache(self) -> Path:
        return self.dot / "cache"

    @property
    def vfs(self) -> Path:
        return self.dot / "vfs"

    @property
    def repos(self) -> Path:
        return self.dot / "repos"

    @property
    def console(self) -> Path:
        return self.dot / "console"

    @property
    def manifest(self) -> Path:
        return self.dot / "manifest.json"

    @property
    def local_memory(self) -> Path:
        return self.dot / "memory.json"

    def ensure(self) -> None:
        try:
            for folder in (self.dot, self.build, self.cache, self.vfs):
                folder.mkdir(parents=True, exist_ok=True)
            ignore = self.dot / ".gitignore"
            if not ignore.exists():
                ignore.write_text("*\n", encoding="utf-8")
        except OSError as exc:
            raise RunnerError(f"Can't create the IMY workspace in {self.dot}: {exc.strerror or exc}") from exc


def virtual_location(virtual: str) -> str:
    """'/file:paths' -> 'file/paths' (deterministic, never escapes the vfs folder)."""
    cleaned = virtual.strip().replace("\\", "/").replace(":", "/")
    parts = [part for part in cleaned.split("/") if part not in ("", ".", "..")]
    safe = [re.sub(r"[^A-Za-z0-9._-]", "_", part)[:80] for part in parts]
    return "/".join(safe) if safe else "root"


def web_location(url: str) -> str:
    tail = url.split("?", 1)[0].split("#", 1)[0].rstrip("/").rsplit("/", 1)[-1] or "index"
    name = re.sub(r"[^A-Za-z0-9._-]", "_", tail)[:80]
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:10]
    return f"web/{digest}-{name}"


def _relative(target: Path, start: Path) -> str:
    return Path(os.path.relpath(target, start)).as_posix()


@dataclass
class VirtualFileMap:
    """Where every virtual path and mirrored web resource really lives."""

    virtual_paths: dict[str, str] = field(default_factory=dict)
    absolute: dict[str, Path] = field(default_factory=dict)
    web: list[WebResourceNote] = field(default_factory=list)
    web_files: dict[str, Path] = field(default_factory=dict)


def map_virtual_files(parsed: ParsedSource, workspace: Workspace, run_dir: Path) -> VirtualFileMap:
    vmap = VirtualFileMap()
    for virtual in parsed.virtual_paths:
        real = workspace.vfs / virtual_location(virtual.path)
        vmap.absolute[virtual.path] = real
        vmap.virtual_paths[virtual.path] = _relative(real, run_dir)
    seen: set[str] = set()
    for resource in parsed.web_resources:
        if resource.url in seen:
            continue
        seen.add(resource.url)
        if resource.mirrored:
            real = workspace.vfs / web_location(resource.url)
            vmap.web_files[resource.url] = real
            vmap.web.append(WebResourceNote(url=resource.url, line=resource.line, local_path=_relative(real, run_dir)))
        else:
            vmap.web.append(WebResourceNote(url=resource.url, line=resource.line, local_path=None))
    return vmap


def download(url: str, destination: Path, *, timeout: float = 60.0, transport: object | None = None) -> None:
    """Fetch one web resource into the vfs (size-capped, atomic)."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    options: dict[str, object] = {"timeout": timeout, "follow_redirects": True}
    if transport is not None:
        options["transport"] = transport
    fd, tmp = tempfile.mkstemp(prefix=".download.", dir=destination.parent)
    try:
        with os.fdopen(fd, "wb") as handle, httpx2.Client(**options) as client:
            with client.stream("GET", url) as response:
                if response.status_code >= 400:
                    raise RunnerError(f"Downloading {url} failed with HTTP {response.status_code}.")
                total = 0
                for chunk in response.iter_bytes():
                    total += len(chunk)
                    if total > MAX_DOWNLOAD_BYTES:
                        raise RunnerError(f"{url} is larger than {MAX_DOWNLOAD_BYTES // (1024 * 1024)} MB; IMY won't mirror it.")
                    handle.write(chunk)
        os.replace(tmp, destination)
    except httpx2.TimeoutException as exc:
        raise RunnerError(f"Downloading {url} timed out after {timeout:g} seconds.") from exc
    except httpx2.TransportError as exc:
        raise RunnerError(f"Couldn't download {url}: {exc}") from exc
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def prepare_virtual_files(
    vmap: VirtualFileMap,
    workspace: Workspace,
    *,
    offline: bool = False,
    refresh: bool = False,
    transport: object | None = None,
) -> list[str]:
    """Create parent folders, mirror web resources and write the manifest. Returns what was downloaded."""
    downloaded: list[str] = []
    try:
        for real in vmap.absolute.values():
            real.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise RunnerError(f"Can't create the virtual file folders: {exc.strerror or exc}") from exc
    for url, real in vmap.web_files.items():
        if real.exists() and not refresh:
            continue
        if offline:
            raise RunnerError(
                f"The program needs {url}, which isn't mirrored yet.", hint="Run once without --offline to download it."
            )
        download(url, real, transport=transport)
        downloaded.append(url)
    manifest = {
        "virtual_paths": {virtual: str(real) for virtual, real in sorted(vmap.absolute.items())},
        "web_resources": {url: str(real) for url, real in sorted(vmap.web_files.items())},
    }
    try:
        workspace.dot.mkdir(parents=True, exist_ok=True)
        existing: dict[str, dict[str, str]] = {}
        if workspace.manifest.exists():
            try:
                loaded = json.loads(workspace.manifest.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    existing = {k: v for k, v in loaded.items() if isinstance(v, dict)}
            except (OSError, ValueError):
                existing = {}
        for section, values in manifest.items():
            merged = dict(existing.get(section, {}))
            merged.update(values)
            existing[section] = dict(sorted(merged.items()))
        workspace.manifest.write_text(json.dumps(existing, indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        raise RunnerError(f"Can't write {workspace.manifest}: {exc.strerror or exc}") from exc
    return downloaded
