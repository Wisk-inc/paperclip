"""Cross-session memory and the deterministic compile cache.

Memory lives in ``~/.imy/memory.json`` (global) and, when a project has one,
``<project>/.imy/memory.json`` (local; it overrides global entries with the same
key and receives new saves). It keeps every user-defined:

* variable pack (``"XYZ"``), function and virtual path - one global entry per name
* custom syntax rule (``extract.font123``) - first saved meaning wins
* variable - one entry per defining file, so common names never collide

A saved symbol is never overwritten silently: redefining a pack or function
that another file saved halts with ``MemoryConflict`` unless ``--update-memory``
is given, and a file that changes its own definition gets an explicit notice.

Definitions read from an existing project (``imy import``) are saved the same
way, with the language their code is written in and the other imported names
that code needs, so a file that uses one gets its helpers along with it.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import tempfile
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .errors import Diagnostic, ErrorCode, MemoryStoreError, Stage
from .parser import ParsedSource

try:
    import fcntl
except ImportError:
    fcntl = None

Scope = Literal["global", "local"]


class SymbolKind(StrEnum):
    VARIABLE_PACK = "variable_pack"
    VARIABLE = "variable"
    FUNCTION = "function"
    SYNTAX_RULE = "syntax_rule"
    VIRTUAL_PATH = "virtual_path"


class MemorySymbol(BaseModel):
    """One saved definition."""

    model_config = ConfigDict(extra="ignore")

    name: str = Field(min_length=1, max_length=200)
    kind: SymbolKind
    meaning: str = Field(min_length=1, max_length=4000)
    source_fragment: str = Field(default="", max_length=20000)
    fingerprint: str = Field(min_length=8, max_length=128)
    origin: str
    origin_line: int = Field(default=0, ge=0)
    members: list[str] = Field(default_factory=list)
    # Only for a definition read from an existing project (`imy import`): the language
    # source_fragment is written in, and the other imported names that code needs.
    language: str = Field(default="", max_length=40)
    uses: list[str] = Field(default_factory=list)
    created_at: str
    updated_at: str

    @property
    def imported(self) -> bool:
        return bool(self.language)

    @property
    def key(self) -> tuple[str, str, str]:
        if self.kind is SymbolKind.VARIABLE:
            return (self.kind.value, self.name, self.origin)
        if self.kind is SymbolKind.VARIABLE_PACK:
            return (self.kind.value, self.name.casefold(), "")
        return (self.kind.value, self.name, "")

    @property
    def origin_label(self) -> str:
        name = Path(self.origin).name if self.origin else "?"
        return f"{name} line {self.origin_line}" if self.origin_line else name

    def snapshot(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "name": self.name,
            "kind": self.kind.value,
            "meaning": self.meaning,
            "fingerprint": self.fingerprint,
            "members": list(self.members),
            "source_fragment": self.source_fragment,
        }
        if self.language:
            data["language"] = self.language
        if self.uses:
            data["uses"] = list(self.uses)
        return data


class MemoryFile(BaseModel):
    model_config = ConfigDict(extra="ignore")

    format: Literal["imy-memory"] = "imy-memory"
    version: Literal[1] = 1
    symbols: list[MemorySymbol] = Field(default_factory=list)


class SymbolLike(Protocol):
    """The shape of a symbol the compiler extracted (see prompts.ExtractedSymbol)."""

    name: str
    kind: Any
    meaning: str
    source_fragment: str


def fingerprint(text: str) -> str:
    """Stable hash of a definition, ignoring whitespace differences."""
    normalized = " ".join(text.split())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:32]


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _sort_key(symbol: MemorySymbol) -> tuple[str, str, str]:
    return (symbol.kind.value, symbol.name.casefold(), symbol.origin)


def _same_folder(first: Path, second: Path) -> bool:
    try:
        return first.resolve() == second.resolve()
    except OSError:
        return False


# Words every program uses as grammar. A variable saved under one of them (IMY lets `if` or
# `then` be a variable) is reused by another file only where that file clearly uses it as a
# value, so `if = menu.home page.structure` in one file never rewrites every `if` elsewhere.
GENERIC_WORDS: frozenset[str] = frozenset(
    {
        "if", "elif", "else", "then", "while", "for", "foreach", "when", "until", "unless", "repeat", "loop",
        "do", "end", "begin", "start", "stop", "return", "and", "or", "not", "in", "is", "as", "at", "by",
        "of", "on", "to", "from", "into", "with", "the", "a", "an", "it", "this", "that", "be", "name",
        "show", "print", "call", "set", "get", "let", "var", "const", "new", "def", "fn", "func", "function",
        "true", "false", "yes", "no", "none", "null", "ship", "pack", "case", "match", "switch", "try", "catch",
    }
)


# The operators and marks every syntax shares with arithmetic and with writing itself.
_EVERYDAY_MARKS = frozenset(
    "+ - * / % ^ = == === != !== <> < > <= >= += -= *= /= %= ++ -- && || ! & | ~ ** // . , ; : ? ( ) [ ] { }".split()
)


def is_rule_name(name: str) -> bool:
    """Whether ``name`` can be a custom syntax rule: something the user made up.

    extract.font123 and `say >>` are; so is a mark of their own such as `<-` or
    `|>`. An everyday operator, a lone character or a number is not: saved as a
    rule, `+` would carry one file's reading of + ("joins text") into every
    other file, where it adds numbers.
    """
    text = " ".join(name.split())
    if len(text) < 2:
        return False
    if any(character.isalpha() for character in text):
        return sum(character.isalnum() for character in text) >= 2
    if any(character.isdigit() for character in text):
        return False
    return all(len(part) >= 2 and part not in _EVERYDAY_MARKS for part in text.split())


class MemoryStore:
    """One memory.json file."""

    def __init__(self, path: Path, scope: Scope) -> None:
        self.path = path
        self.scope: Scope = scope

    def exists(self) -> bool:
        return self.path.is_file()

    def load(self) -> MemoryFile:
        if not self.path.exists():
            return MemoryFile()
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise MemoryStoreError(
                f"{self.path} is not valid JSON (line {exc.lineno}, column {exc.colno}).",
                hint=f"Fix the file, or reset it with `imy memory clear --scope {self.scope} --yes`.",
            ) from exc
        except OSError as exc:
            raise MemoryStoreError(f"Can't read {self.path}: {exc.strerror or exc}") from exc
        try:
            return MemoryFile.model_validate(raw)
        except ValidationError as exc:
            first = exc.errors()[0] if exc.errors() else {"msg": "invalid data"}
            raise MemoryStoreError(
                f"{self.path} is not an IMY memory file ({first.get('msg')}).",
                hint=f"Reset it with `imy memory clear --scope {self.scope} --yes`.",
            ) from exc

    def save(self, data: MemoryFile) -> None:
        data.symbols.sort(key=_sort_key)
        payload = json.dumps(data.model_dump(mode="json"), indent=2, ensure_ascii=False) + "\n"
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".memory.", suffix=".json", dir=self.path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    handle.write(payload)
                os.chmod(tmp, 0o600)
                os.replace(tmp, self.path)
            except BaseException:
                with contextlib.suppress(OSError):
                    os.unlink(tmp)
                raise
        except OSError as exc:
            raise MemoryStoreError(f"Can't write {self.path}: {exc.strerror or exc}") from exc

    def create(self) -> None:
        if not self.exists():
            self.save(MemoryFile())

    @contextlib.contextmanager
    def transaction(self) -> Iterator[MemoryFile]:
        """Lock, load, let the caller change the data, then save."""
        lock_path = self.path.with_name(self.path.name + ".lock")
        try:
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            handle = open(lock_path, "a+")
        except OSError as exc:
            raise MemoryStoreError(f"Can't lock {self.path}: {exc.strerror or exc}") from exc
        try:
            if fcntl is not None:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            data = self.load()
            yield data
            self.save(data)
        finally:
            if fcntl is not None:
                with contextlib.suppress(OSError):
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()


@dataclass
class RelevantMemory:
    """The saved symbols a file uses but does not define (injected into the prompt)."""

    symbols: list[MemorySymbol] = field(default_factory=list)
    diagnostics: list[Diagnostic] = field(default_factory=list)

    def snapshot(self) -> list[dict[str, Any]]:
        return [symbol.snapshot() for symbol in self.symbols]


@dataclass
class MemoryUpdateReport:
    store: Path
    added: list[MemorySymbol] = field(default_factory=list)
    updated: list[MemorySymbol] = field(default_factory=list)
    replaced: list[MemorySymbol] = field(default_factory=list)
    unchanged: list[MemorySymbol] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    conflicts: list[Diagnostic] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.added or self.updated or self.replaced)


def _line_of_fragment(parsed: ParsedSource, fragment: str) -> int | None:
    lines = [line for line in fragment.splitlines() if line.strip()]
    if not lines:
        return None
    wanted = " ".join(lines[0].split())
    if not wanted:
        return None
    for line in parsed.code_lines():
        if wanted in " ".join(line.text.split()):
            return line.number
    return None


@dataclass(frozen=True)
class _Located:
    name: str
    line: int
    fragment: str
    fingerprint: str
    members: tuple[str, ...]


def _locate(parsed: ParsedSource, kind: SymbolKind, symbol: SymbolLike) -> _Located | None:
    """Find where this file defines an extracted symbol; None when it only uses it.

    Variables, functions and virtual paths count only where the parser sees
    their definition, so a line that merely uses a saved symbol never
    overwrites it. A pack written in unusual syntax is accepted when the line
    the model points at names both a pack keyword and the pack.
    """
    name = symbol.name.strip()
    if not name:
        return None
    if kind is SymbolKind.VARIABLE:
        lines = parsed.top_level_assignments().get(name)
        if not lines:
            return None
        text = parsed.line(lines[0]).text.strip()
        return _Located(name, lines[0], text, fingerprint(text), ())
    if kind is SymbolKind.VARIABLE_PACK:
        pack = parsed.find_pack(name)
        if pack is not None:
            return _Located(pack.name, pack.line, pack.text, fingerprint(pack.text), pack.members)
        number = _line_of_fragment(parsed, symbol.source_fragment)
        if number is None:
            return None
        text = parsed.line(number).text.strip()
        lowered = text.casefold()
        if "pack" not in lowered or name.casefold() not in lowered:
            return None
        return _Located(name, number, text, fingerprint(text), ())
    if kind is SymbolKind.FUNCTION:
        fn = parsed.find_function(name)
        if fn is None:
            return None
        return _Located(fn.name, fn.line, fn.text, fingerprint(fn.text), fn.params)
    if kind is SymbolKind.SYNTAX_RULE:
        name = " ".join(name.split())
        if not is_rule_name(name):
            return None
        number = parsed.mention_line(name)
        if number is None:
            return None
        return _Located(name, number, parsed.line(number).text.strip(), fingerprint(name), ())
    for virtual in parsed.virtual_paths:
        if virtual.path == name:
            return _Located(virtual.path, virtual.line, parsed.line(virtual.line).text.strip(), fingerprint(virtual.path), ())
    return None


class Memory:
    """The global store plus an optional project-local override."""

    def __init__(self, global_store: MemoryStore, local_store: MemoryStore | None = None) -> None:
        self.global_store = global_store
        self.local_store = local_store

    @classmethod
    def open(cls, home: Path, workspace_dir: Path | None = None) -> Memory:
        """The global store in ``home``, plus ``workspace_dir/memory.json`` when a project has one.

        Run from the home folder, the workspace folder is ``home`` itself (~/.imy): its
        memory.json is the global store, not a second, local one.
        """
        local = None
        if workspace_dir is not None and not _same_folder(workspace_dir, home):
            candidate = MemoryStore(workspace_dir / "memory.json", "local")
            if candidate.exists():
                local = candidate
        return cls(MemoryStore(home / "memory.json", "global"), local)

    @property
    def write_store(self) -> MemoryStore:
        return self.local_store if self.local_store is not None else self.global_store

    def stores(self) -> list[MemoryStore]:
        return [self.global_store] + ([self.local_store] if self.local_store is not None else [])

    def store_for(self, scope: Scope) -> MemoryStore | None:
        return self.global_store if scope == "global" else self.local_store

    def entries(self) -> list[tuple[Scope, MemorySymbol]]:
        """Every visible entry; a local entry hides a global one with the same key."""
        merged: dict[tuple[str, str, str], tuple[Scope, MemorySymbol]] = {}
        for store in self.stores():
            for symbol in store.load().symbols:
                merged[symbol.key] = (store.scope, symbol)
        return sorted(merged.values(), key=lambda item: _sort_key(item[1]))

    def find(self, name: str) -> list[tuple[Scope, MemorySymbol]]:
        folded = name.casefold()
        found = []
        for scope, symbol in self.entries():
            if symbol.name == name or (symbol.kind is SymbolKind.VARIABLE_PACK and symbol.name.casefold() == folded):
                found.append((scope, symbol))
        return found

    def known_names(self, exclude_origin: str | None = None) -> set[str]:
        names: set[str] = set()
        for _, symbol in self.entries():
            if exclude_origin is not None and symbol.origin == exclude_origin:
                continue
            names.add(symbol.name)
        return names

    def relevant(self, parsed: ParsedSource, origin: str) -> RelevantMemory:
        """The saved symbols this file uses without defining them.

        * variable: used as a value (beside an operator, passed to a call, on the right of
          an `=`), or named anywhere other than as the thing being called, unless the
          name is a grammar word (GENERIC_WORDS)
        * variable pack: named in a string (any letter case) or as an identifier
        * function: named anywhere
        * syntax rule: its text appears in a code line (strings aside)
        * virtual path: the file ships the same path

        Symbols this file saved itself are left out: its own source already defines them.
        """
        identifiers = parsed.identifiers()
        value_refs = parsed.value_references()
        plain = parsed.plain_identifiers()
        strings = {value.strip().casefold() for _, value in parsed.string_values()}
        defined = set(parsed.first_definitions())
        declared_packs = {pack.name.casefold() for pack in parsed.packs}
        virtual_paths = {virtual.path for virtual in parsed.virtual_paths}
        variables: dict[str, list[MemorySymbol]] = {}
        chosen: list[MemorySymbol] = []
        for _, symbol in self.entries():
            if symbol.origin == origin:
                continue
            kind = symbol.kind
            name = symbol.name
            if kind is SymbolKind.VARIABLE:
                if name in defined:
                    continue
                if name in value_refs or (name in plain and name.casefold() not in GENERIC_WORDS):
                    variables.setdefault(name, []).append(symbol)
            elif kind is SymbolKind.VARIABLE_PACK:
                folded = name.casefold()
                if folded not in declared_packs and (folded in strings or name in identifiers):
                    chosen.append(symbol)
            elif kind is SymbolKind.FUNCTION:
                if name in identifiers and name not in defined:
                    chosen.append(symbol)
            elif kind is SymbolKind.SYNTAX_RULE:
                # An operator saved as a rule by an earlier version is passed over (see is_rule_name).
                if is_rule_name(name) and name not in defined and parsed.mention_line(name) is not None:
                    chosen.append(symbol)
            elif kind is SymbolKind.VIRTUAL_PATH and name in virtual_paths:
                chosen.append(symbol)
        diagnostics: list[Diagnostic] = []
        for name, group in sorted(variables.items()):
            group.sort(key=lambda s: s.origin)
            if len({s.fingerprint for s in group}) > 1:
                places = ", ".join(s.origin_label for s in group)
                diagnostics.append(
                    Diagnostic(
                        code=ErrorCode.MEMORY_CONFLICT,
                        line=parsed.first_line_mentioning(name) or 0,
                        message=(
                            f"`{name}` is saved in memory from {len(group)} files with different definitions "
                            f"({places}). Define `{name}` in this file, or remove one with "
                            f"`imy memory delete {name} --file <path>`"
                        ),
                        stage=Stage.MEMORY,
                    )
                )
            else:
                chosen.append(group[0])
        chosen = self._with_helpers(chosen, defined)
        chosen.sort(key=_sort_key)
        return RelevantMemory(symbols=chosen, diagnostics=diagnostics)

    # The most saved definitions one file's request carries: enough for a function and
    # everything it leans on, without a whole imported project riding along.
    HELPER_LIMIT = 60

    def _with_helpers(self, chosen: list[MemorySymbol], defined: set[str]) -> list[MemorySymbol]:
        """Add what the chosen imported definitions need: the other imported names their code uses.

        A helper from the same file is taken first. One saved from several files
        with different code is left out, and a name the current file defines
        itself is the file's own.
        """
        if not any(symbol.uses for symbol in chosen):
            return chosen
        by_name: dict[str, list[MemorySymbol]] = {}
        for _, symbol in self.entries():
            if symbol.language:
                by_name.setdefault(symbol.name, []).append(symbol)
        result = list(chosen)
        seen = {symbol.key for symbol in chosen}
        waiting = [symbol for symbol in chosen if symbol.uses]
        while waiting and len(result) < self.HELPER_LIMIT:
            current = waiting.pop(0)
            for name in current.uses:
                if name in defined:
                    continue
                candidates = by_name.get(name, [])
                same_file = [candidate for candidate in candidates if candidate.origin == current.origin]
                if same_file:
                    pick = same_file[0]
                elif candidates and len({candidate.fingerprint for candidate in candidates}) == 1:
                    pick = candidates[0]
                else:
                    continue
                if pick.key in seen or len(result) >= self.HELPER_LIMIT:
                    continue
                seen.add(pick.key)
                result.append(pick)
                if pick.uses:
                    waiting.append(pick)
        return result

    def conflicts(self, parsed: ParsedSource, origin: str) -> list[Diagnostic]:
        """Packs and functions this file defines that another file saved differently."""
        found: list[Diagnostic] = []
        entries = self.entries()
        for pack in parsed.packs:
            fp = fingerprint(pack.text)
            for _, symbol in entries:
                if symbol.origin == origin or symbol.kind is SymbolKind.VARIABLE:
                    continue
                if symbol.name.casefold() != pack.name.casefold():
                    continue
                if symbol.kind is SymbolKind.VARIABLE_PACK and symbol.fingerprint == fp:
                    continue
                found.append(self._conflict(pack.line, f'the variable pack "{pack.name}"', symbol))
        for fn in parsed.functions:
            if parsed.line(fn.line).in_function:
                continue
            fp = fingerprint(fn.text)
            for _, symbol in entries:
                if symbol.origin == origin or symbol.kind is SymbolKind.VARIABLE or symbol.name != fn.name:
                    continue
                if symbol.kind is SymbolKind.FUNCTION and symbol.fingerprint == fp:
                    continue
                found.append(self._conflict(fn.line, f"the function `{fn.name}`", symbol))
        return found

    @staticmethod
    def _conflict(line: int, what: str, saved: MemorySymbol) -> Diagnostic:
        fragment = " ".join(saved.source_fragment.split())
        if len(fragment) > 80:
            fragment = fragment[:77] + "..."
        return Diagnostic(
            code=ErrorCode.MEMORY_CONFLICT,
            line=line,
            message=(
                f"{what} is already saved in memory as a {saved.kind.value} from {saved.origin_label} "
                f"(`{fragment}`), and this file defines it differently. Rerun with --update-memory to replace "
                "the saved one, or pick another name"
            ),
            stage=Stage.MEMORY,
        )

    def apply(
        self,
        parsed: ParsedSource,
        origin: str,
        symbols: Iterable[SymbolLike],
        *,
        update: bool = False,
    ) -> MemoryUpdateReport:
        """Save what this file defines. Never overwrites another file's symbol unless ``update``."""
        store = self.write_store
        report = MemoryUpdateReport(store=store.path)
        visible = {symbol.key: symbol for _, symbol in self.entries()}
        stamp = now_iso()
        seen: set[tuple[str, str]] = set()
        try:
            self._apply_into(store, parsed, origin, symbols, update, report, visible, stamp, seen)
        except _AbortTransaction:
            report.added.clear()
            report.updated.clear()
            report.replaced.clear()
        return report

    def _apply_into(
        self,
        store: MemoryStore,
        parsed: ParsedSource,
        origin: str,
        symbols: Iterable[SymbolLike],
        update: bool,
        report: MemoryUpdateReport,
        visible: dict[tuple[str, str, str], MemorySymbol],
        stamp: str,
        seen: set[tuple[str, str]],
    ) -> None:
        with store.transaction() as data:
            positions = {symbol.key: index for index, symbol in enumerate(data.symbols)}
            for extracted in symbols:
                try:
                    kind = SymbolKind(str(getattr(extracted.kind, "value", extracted.kind)))
                except ValueError:
                    report.skipped.append(extracted.name)
                    continue
                marker = (kind.value, extracted.name.strip().casefold())
                if marker in seen:
                    continue
                seen.add(marker)
                located = _locate(parsed, kind, extracted)
                if located is None:
                    report.skipped.append(extracted.name)
                    continue
                meaning = " ".join(extracted.meaning.split()) or located.fragment
                candidate = MemorySymbol(
                    name=located.name,
                    kind=kind,
                    meaning=meaning[:4000],
                    source_fragment=located.fragment,
                    fingerprint=located.fingerprint,
                    origin=origin,
                    origin_line=located.line,
                    members=list(located.members),
                    created_at=stamp,
                    updated_at=stamp,
                )
                existing = visible.get(candidate.key)
                if existing is None:
                    self._put(data, positions, candidate)
                    report.added.append(candidate)
                    continue
                same_definition = existing.fingerprint == candidate.fingerprint and existing.kind is candidate.kind
                if same_definition and not (update and kind is SymbolKind.SYNTAX_RULE):
                    report.unchanged.append(existing)
                    continue
                if kind is SymbolKind.SYNTAX_RULE and not update:
                    report.unchanged.append(existing)
                    continue
                candidate = candidate.model_copy(update={"created_at": existing.created_at})
                if existing.origin == origin:
                    self._put(data, positions, candidate)
                    report.updated.append(candidate)
                elif update:
                    self._put(data, positions, candidate)
                    report.replaced.append(candidate)
                else:
                    report.conflicts.append(
                        self._conflict(located.line, f"`{located.name}` ({kind.value})", existing)
                    )
            if report.conflicts:
                raise _AbortTransaction(report)

    def add_imported(self, candidates: Iterable[MemorySymbol], *, update: bool = False, store: MemoryStore | None = None) -> MemoryUpdateReport:
        """Save definitions read from an existing project.

        Like apply(), it never replaces what another file saved unless ``update``.
        Unlike apply(), one conflict does not hold the rest back: everything that
        can be saved is saved, and each conflict is reported.
        """
        target = store if store is not None else self.write_store
        report = MemoryUpdateReport(store=target.path)
        visible = {symbol.key: symbol for _, symbol in self.entries()}
        with target.transaction() as data:
            positions = {symbol.key: index for index, symbol in enumerate(data.symbols)}
            for candidate in candidates:
                existing = visible.get(candidate.key)
                if existing is None:
                    self._put(data, positions, candidate)
                    report.added.append(candidate)
                    visible[candidate.key] = candidate
                    continue
                same = (
                    existing.fingerprint == candidate.fingerprint
                    and existing.kind is candidate.kind
                    and existing.language == candidate.language
                    and existing.uses == candidate.uses
                    and existing.meaning == candidate.meaning
                    and existing.origin == candidate.origin
                )
                if same:
                    report.unchanged.append(existing)
                    continue
                candidate = candidate.model_copy(update={"created_at": existing.created_at})
                if existing.origin == candidate.origin:
                    self._put(data, positions, candidate)
                    report.updated.append(candidate)
                elif update:
                    self._put(data, positions, candidate)
                    report.replaced.append(candidate)
                else:
                    report.conflicts.append(self._conflict(candidate.origin_line, f"`{candidate.name}` ({candidate.kind.value})", existing))
                    continue
                visible[candidate.key] = candidate
        return report

    def forget_imported(self, location: Path) -> list[tuple[Scope, MemorySymbol]]:
        """Remove every imported definition that came from ``location`` (a file, or a folder and all inside it)."""
        removed: list[tuple[Scope, MemorySymbol]] = []
        for store in self.stores():
            if not store.exists():
                continue
            with store.transaction() as data:
                kept: list[MemorySymbol] = []
                for symbol in data.symbols:
                    origin = Path(symbol.origin)
                    if symbol.language and (origin == location or location in origin.parents):
                        removed.append((store.scope, symbol))
                    else:
                        kept.append(symbol)
                data.symbols = kept
        return removed

    @staticmethod
    def _put(data: MemoryFile, positions: dict[tuple[str, str, str], int], symbol: MemorySymbol) -> None:
        index = positions.get(symbol.key)
        if index is None:
            positions[symbol.key] = len(data.symbols)
            data.symbols.append(symbol)
        else:
            data.symbols[index] = symbol

    def delete(self, name: str, *, scope: Scope | None = None, origin: str | None = None) -> list[tuple[Scope, MemorySymbol]]:
        removed: list[tuple[Scope, MemorySymbol]] = []
        folded = name.casefold()
        for store in self.stores():
            if scope is not None and store.scope != scope:
                continue
            if not store.exists():
                continue
            with store.transaction() as data:
                kept: list[MemorySymbol] = []
                for symbol in data.symbols:
                    matches = symbol.name == name or (
                        symbol.kind is SymbolKind.VARIABLE_PACK and symbol.name.casefold() == folded
                    )
                    if matches and origin is not None:
                        matches = Path(symbol.origin) == Path(origin)
                    if matches:
                        removed.append((store.scope, symbol))
                    else:
                        kept.append(symbol)
                data.symbols = kept
        return removed

    def clear(self, scope: Scope | None = None) -> int:
        count = 0
        for store in self.stores():
            if scope is not None and store.scope != scope:
                continue
            if not store.path.exists():
                continue
            try:
                count += len(store.load().symbols)
            except MemoryStoreError:
                pass
            store.save(MemoryFile())
        return count


class _AbortTransaction(Exception):
    """Raised inside a memory transaction to skip the save (conflicts found)."""

    def __init__(self, report: MemoryUpdateReport) -> None:
        super().__init__("memory conflicts")
        self.report = report


class CacheEntry(BaseModel):
    model_config = ConfigDict(extra="ignore")

    key: str
    target_language: str
    compiled_code: str
    extracted_symbols: list[dict[str, Any]] = Field(default_factory=list)
    provider: str = ""
    model: str = ""
    created_at: str = ""
    imy_version: str = ""


def cache_key(
    *,
    normalized_source: str,
    target: str,
    memory_snapshot: list[dict[str, Any]],
    context: str = "",
    prompt_version: str,
) -> str:
    """sha256 of (normalized source + target language + relevant memory + context + prompt version)."""
    payload = {
        "prompt": prompt_version,
        "source": normalized_source,
        "target": target,
        "memory": memory_snapshot,
        "context": context,
    }
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


class CompileCache:
    """Compiled artifacts on disk, one JSON file per cache key."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory

    def _path(self, key: str) -> Path:
        return self.directory / f"{key}.json"

    def get(self, key: str) -> CacheEntry | None:
        path = self._path(key)
        if not path.is_file():
            return None
        try:
            entry = CacheEntry.model_validate_json(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            with contextlib.suppress(OSError):
                path.unlink()
            return None
        return entry if entry.key == key else None

    def put(self, entry: CacheEntry) -> Path:
        path = self._path(entry.key)
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".cache.", suffix=".json", dir=self.directory)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(entry.model_dump_json(indent=2))
            os.replace(tmp, path)
        except OSError as exc:
            raise MemoryStoreError(f"Can't write the compile cache in {self.directory}: {exc.strerror or exc}") from exc
        return path

    def discard(self, key: str) -> None:
        """Remove one entry (the program it holds turned out not to build)."""
        with contextlib.suppress(OSError):
            self._path(key).unlink()

    def clear(self) -> int:
        if not self.directory.is_dir():
            return 0
        count = 0
        for item in self.directory.glob("*.json"):
            with contextlib.suppress(OSError):
                item.unlink()
                count += 1
        return count
