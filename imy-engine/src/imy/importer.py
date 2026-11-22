"""Bringing an existing project into the workspace.

`imy import <folder>` reads a project's source files and saves what each one
defines at its top level (functions, classes, constants and other variables)
to IMY's memory, with the project's own code as the definition. A later .imy
file uses them by name, and the compiler carries their exact behaviour into
whatever language that file compiles to.

Python files are read with Python's own parser: exact, instant, no model.
Every other language is read by the model under a JSON contract, and each
thing it reports is checked against the file before it is kept: the name must
be in the file, and the definition saved is the file's own lines, never the
model's words. No project code is ever run.
"""

from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import tempfile
import time
from collections.abc import Callable, Iterable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .config import ImyConfig
from .errors import ConfigError, ImyError, LLMError
from .languages import Language, language_for_extension
from .llm_client import ChatMessage, LLMClient, LLMRequest
from .memory import Memory, MemoryStore, MemorySymbol, MemoryUpdateReport, SymbolKind, fingerprint, now_iso
from .prompts import ResponseFormatError, extract_json_object

# How much one import reads, unless told otherwise.
MAX_FILES = 25
MAX_FILE_BYTES = 40_000
# The longest definition kept (a saved definition may hold 20,000 characters).
MAX_FRAGMENT_CHARS = 16_000
# How much source one request to the model carries.
BATCH_CHARS = 24_000
BATCH_FILES = 6
# Requests to the model that run at the same time.
WORKERS = 2
# Raised when the way files are read changes, so what an older version read is read again.
READER_VERSION = 1

# Folders that hold other people's code, build output or tool state.
SKIP_FOLDERS = frozenset(
    {
        "node_modules", "bower_components", "vendor", "third_party", "site-packages", "venv", "env", "virtualenv",
        "__pycache__", "dist", "build", "out", "target", "bin", "obj", "coverage", "htmlcov", "tmp", "temp",
        "Pods", "DerivedData", "cmake-build-debug", "cmake-build-release",
    }
)
TEST_FOLDERS = frozenset({"test", "tests", "__tests__", "spec", "specs", "testing", "e2e", "fixtures", "testdata"})
# Languages IMY knows that define no functions or variables to bring in.
NOT_CODE = frozenset({"html", "css", "sql"})

_TEST_FILE = re.compile(
    r"^(test_.*\.py|.*_test\.(py|go|rb|rs|c|cc|cpp)|conftest\.py|.*\.(test|spec)\.[cm]?[jt]sx?|.*_spec\.rb|.*Tests?\.(java|kt|cs|swift))$"
)
_GENERATED_FILE = re.compile(r"(\.min\.[cm]?js|\.d\.ts|\.pb\.go|_pb2(_grpc)?\.py|\.generated\.\w+|\.g\.dart|-lock\.\w+|\.bundle\.js)$")
_NAME = re.compile(r"^[A-Za-z_$][\w$]*[?!]?$")
_WORD = re.compile(r"[A-Za-z_$][\w$]*")


@dataclass(frozen=True)
class SourceFile:
    path: Path
    relative: str
    language: Language
    text: str
    digest: str

    @property
    def lines(self) -> list[str]:
        return self.text.split("\n")

    def numbered(self) -> str:
        lines = self.lines
        if lines and lines[-1] == "":
            lines = lines[:-1]
        width = len(str(len(lines)))
        return "\n".join(f"{number:>{width}} | {line}" for number, line in enumerate(lines, start=1))


@dataclass
class FoundSymbol:
    """One thing a file defines at its top level."""

    name: str
    kind: SymbolKind
    line: int
    end_line: int
    fragment: str
    params: tuple[str, ...] = ()
    meaning: str = ""
    # "function", "class" or "variable": a class is saved as a function (it is called by name).
    what: str = "function"
    # Names its code mentions; the ones another imported definition answers to become `uses`.
    refs: tuple[str, ...] = ()
    # Import lines of its file that its code relies on (Python).
    needs: tuple[str, ...] = ()

    def to_json(self) -> dict[str, Any]:
        return {
            "name": self.name, "kind": self.kind.value, "line": self.line, "end_line": self.end_line,
            "fragment": self.fragment, "params": list(self.params), "meaning": self.meaning, "what": self.what,
            "refs": list(self.refs), "needs": list(self.needs),
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> FoundSymbol:
        return cls(
            name=str(data["name"]), kind=SymbolKind(data["kind"]), line=int(data["line"]), end_line=int(data["end_line"]),
            fragment=str(data["fragment"]), params=tuple(str(item) for item in data.get("params", ())),
            meaning=str(data.get("meaning", "")), what=str(data.get("what", "function")),
            refs=tuple(str(item) for item in data.get("refs", ())), needs=tuple(str(item) for item in data.get("needs", ())),
        )


@dataclass
class FileRead:
    """What reading one file found."""

    file: SourceFile
    symbols: list[FoundSymbol] = field(default_factory=list)
    # (name, why it was left out)
    skipped: list[tuple[str, str]] = field(default_factory=list)
    # "parser" (Python's own), "model" or "saved" (read before, the file has not changed).
    how: str = "parser"
    model: str = ""
    seconds: float = 0.0
    # Why the file could not be read at all.
    error: str | None = None

    def count(self, what: str) -> int:
        return sum(1 for symbol in self.symbols if symbol.what == what)


@dataclass
class Collected:
    root: Path
    files: list[SourceFile] = field(default_factory=list)
    # (relative path, why it is not read)
    skipped: list[tuple[str, str]] = field(default_factory=list)
    # Files beyond the limit, test files, and files that are not source code.
    left_out: int = 0
    tests: int = 0
    other: int = 0


# ── Finding the files ────────────────────────────────────────────────────


def _skip_folder(name: str, include_tests: bool) -> bool:
    if name.startswith(".") or name in SKIP_FOLDERS or name.endswith(".egg-info"):
        return True
    return not include_tests and name.lower() in TEST_FOLDERS


def _read_source(path: Path, relative: str, language: Language, max_bytes: int) -> SourceFile | str:
    """The file, or the reason it is not read."""
    try:
        size = path.stat().st_size
        if size > max_bytes:
            return f"larger than {max_bytes // 1000} KB"
        data = path.read_bytes()
    except OSError as exc:
        return f"can't be read ({exc.strerror or exc})"
    if b"\0" in data:
        return "not text"
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return "not UTF-8 text"
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        return "empty"
    return SourceFile(path=path, relative=relative, language=language, text=text, digest=hashlib.sha256(data).hexdigest())


def collect(root: Path, *, max_files: int = MAX_FILES, max_bytes: int = MAX_FILE_BYTES, include_tests: bool = False) -> Collected:
    """The source files of ``root`` (a folder or one file) that an import reads, the shallowest first."""
    root = root.resolve()
    found = Collected(root=root)
    if root.is_file():
        language = language_for_extension(root.suffix)
        if language is None or language.name in NOT_CODE:
            raise ConfigError(f"{root.name} is not a source file IMY can read.", hint="Give a code file (.py, .js, .rb, .rs, .go, .c, ...) or a folder.")
        read = _read_source(root, root.name, language, max_bytes)
        if isinstance(read, str):
            raise ConfigError(f"{root.name} is {read}.")
        found.files.append(read)
        return found
    if not root.is_dir():
        raise ConfigError(f"There is no file or folder at {root}.")
    candidates: list[tuple[int, str, Path, Language]] = []
    for folder, folders, names in os.walk(root, followlinks=False):
        here = Path(folder)
        folders[:] = sorted(name for name in folders if not _skip_folder(name, include_tests) and not (here / name).is_symlink())
        for name in sorted(names):
            path = here / name
            if name.startswith(".") or path.is_symlink() or not path.is_file():
                continue
            language = language_for_extension(path.suffix)
            if language is None or language.name in NOT_CODE:
                found.other += 1
                continue
            relative = path.relative_to(root).as_posix()
            if not include_tests and _TEST_FILE.match(name):
                found.tests += 1
                continue
            if _GENERATED_FILE.search(name):
                found.skipped.append((relative, "generated or minified"))
                continue
            candidates.append((relative.count("/"), relative, path, language))
    for _, relative, path, language in sorted(candidates):
        if len(found.files) >= max_files:
            found.left_out += 1
            continue
        read = _read_source(path, relative, language, max_bytes)
        if isinstance(read, str):
            found.skipped.append((relative, read))
        else:
            found.files.append(read)
    return found


# ── Python: its own parser ───────────────────────────────────────────────


def _first_sentence(text: str | None) -> str:
    if not text:
        return ""
    paragraph = " ".join(text.strip().split("\n\n")[0].split())
    return paragraph if len(paragraph) <= 300 else paragraph[:297].rstrip() + "..."


def _params(arguments: ast.arguments, *, drop_first: bool = False) -> tuple[str, ...]:
    names = [item.arg for item in (*arguments.posonlyargs, *arguments.args)]
    if drop_first and names:
        names = names[1:]
    if arguments.vararg is not None:
        names.append("*" + arguments.vararg.arg)
    names.extend(item.arg for item in arguments.kwonlyargs)
    if arguments.kwarg is not None:
        names.append("**" + arguments.kwarg.arg)
    return tuple(names)


def _names_in(node: ast.AST) -> set[str]:
    """The names a definition reads from outside itself: what it loads, less its own parameters and locals."""
    loads: set[str] = set()
    own: set[str] = set()
    outside: set[str] = set()
    for item in ast.walk(node):
        if isinstance(item, ast.Name):
            (loads if isinstance(item.ctx, ast.Load) else own).add(item.id)
        elif isinstance(item, ast.arg):
            own.add(item.arg)
        elif isinstance(item, (ast.Global, ast.Nonlocal)):
            outside.update(item.names)
    return (loads - (own - outside)) | outside


def _lines_of(file: SourceFile, start: int, end: int) -> str:
    return "\n".join(file.lines[start - 1 : end]).rstrip()


def read_python(file: SourceFile) -> FileRead:
    """Every top-level function, class and variable of a Python file, exactly as Python reads it."""
    read = FileRead(file=file, how="parser")
    try:
        tree = ast.parse(file.text)
    except (SyntaxError, ValueError, RecursionError) as exc:
        line = getattr(exc, "lineno", None)
        read.error = f"Python can't parse it ({f'line {line}: ' if line else ''}{getattr(exc, 'msg', None) or exc})"
        return read
    imports: dict[str, str] = {}
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            statement = " ".join(_lines_of(file, node.lineno, node.end_lineno or node.lineno).split())
            for alias in node.names:
                imports[(alias.asname or alias.name).split(".")[0]] = statement
    seen: set[str] = set()

    def add(symbol: FoundSymbol, node: ast.AST) -> None:
        if symbol.name in seen:
            # A later definition of the same name replaces the earlier one, as it does in Python.
            read.symbols[:] = [earlier for earlier in read.symbols if earlier.name != symbol.name]
        seen.add(symbol.name)
        if len(symbol.fragment) > MAX_FRAGMENT_CHARS:
            read.skipped.append((symbol.name, f"its definition is longer than {MAX_FRAGMENT_CHARS:,} characters"))
            return
        used = _names_in(node)
        symbol.refs = tuple(sorted(used - {symbol.name}))
        symbol.needs = tuple(sorted({imports[name] for name in used if name in imports}))
        read.symbols.append(symbol)

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name == "main":
                read.skipped.append((node.name, "it is the file's own entry point"))
                continue
            start = min([node.lineno, *(decorator.lineno for decorator in node.decorator_list)])
            add(
                FoundSymbol(
                    name=node.name, kind=SymbolKind.FUNCTION, line=start, end_line=node.end_lineno or node.lineno,
                    fragment=_lines_of(file, start, node.end_lineno or node.lineno), params=_params(node.args),
                    meaning=_first_sentence(ast.get_docstring(node)), what="function",
                ),
                node,
            )
        elif isinstance(node, ast.ClassDef):
            start = min([node.lineno, *(decorator.lineno for decorator in node.decorator_list)])
            init = next((item for item in node.body if isinstance(item, ast.FunctionDef) and item.name == "__init__"), None)
            add(
                FoundSymbol(
                    name=node.name, kind=SymbolKind.FUNCTION, line=start, end_line=node.end_lineno or node.lineno,
                    fragment=_lines_of(file, start, node.end_lineno or node.lineno),
                    params=_params(init.args, drop_first=True) if init is not None else (),
                    meaning=_first_sentence(ast.get_docstring(node)), what="class",
                ),
                node,
            )
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if isinstance(node, ast.AnnAssign) and node.value is None:
                continue
            for target in targets:
                if not isinstance(target, ast.Name) or (target.id.startswith("__") and target.id.endswith("__")):
                    continue
                add(
                    FoundSymbol(
                        name=target.id, kind=SymbolKind.VARIABLE, line=node.lineno, end_line=node.end_lineno or node.lineno,
                        fragment=_lines_of(file, node.lineno, node.end_lineno or node.lineno), what="variable",
                    ),
                    node,
                )
    read.symbols.sort(key=lambda symbol: symbol.line)
    return read


# ── Other languages: the model reads, the file decides ───────────────────

READ_SYSTEM_PROMPT = """You read source files and list what each one defines at its top level, so those names can be reused in another program. You never write, change or judge code.

For every file, list:
- each top-level function, and each class, struct, module or type that is used by its name (list these as "function")
- each top-level variable or constant (list these as "variable")
Leave out imports and includes, declarations with no body or value, tests, a `main` entry point, and anything nested inside another definition (methods stay inside their class).

For each one give:
- name: exactly as written in the file
- kind: "function" or "variable"
- line: the number of the line where its definition starts (the numbers at the left of the file)
- end_line: the number of the last line of its definition
- params: the parameter names in order, for a function
- meaning: one plain sentence saying what it does or holds, read from the code itself
- uses: the names of other things defined in these files that its code needs

Reply with exactly one JSON object and nothing else:
{"files": [{"file": <number of the file>, "symbols": [{"name": "...", "kind": "function", "line": 1, "end_line": 9, "params": ["a"], "meaning": "...", "uses": ["..."]}]}]}
A file that defines nothing still gets an entry, with an empty symbols list."""

READ_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "files": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "file": {"type": "integer"},
                    "symbols": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "kind": {"type": "string", "enum": ["function", "variable"]},
                                "line": {"type": "integer"},
                                "end_line": {"type": "integer"},
                                "params": {"type": "array", "items": {"type": "string"}},
                                "meaning": {"type": "string"},
                                "uses": {"type": "array", "items": {"type": "string"}},
                            },
                            "required": ["name", "kind", "line", "end_line", "params", "meaning", "uses"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["file", "symbols"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["files"],
    "additionalProperties": False,
}

_KIND_WORDS = {
    "function": "function", "func": "function", "fn": "function", "method": "function", "procedure": "function",
    "proc": "function", "sub": "function", "subroutine": "function", "class": "function", "struct": "function",
    "module": "function", "type": "function", "enum": "function", "interface": "function", "trait": "function",
    "macro": "function", "def": "function",
    "variable": "variable", "var": "variable", "const": "variable", "constant": "variable", "static": "variable",
    "let": "variable", "global": "variable", "value": "variable", "field": "variable",
}


class _ReportedSymbol(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str
    kind: str = "function"
    line: int = 0
    end_line: int | None = None
    params: list[str] = Field(default_factory=list)
    meaning: str = ""
    uses: list[str] = Field(default_factory=list)

    @field_validator("line", "end_line", mode="before")
    @classmethod
    def _whole_number(cls, value: Any) -> Any:
        if isinstance(value, str) and value.strip().lstrip("-").isdigit():
            return int(value.strip())
        if isinstance(value, float) and value == int(value):
            return int(value)
        return None if isinstance(value, bool) else value

    @field_validator("params", "uses", mode="before")
    @classmethod
    def _names(cls, value: Any) -> Any:
        if value is None:
            return []
        if isinstance(value, str):
            return [part.strip() for part in value.split(",") if part.strip()]
        return [str(item) for item in value] if isinstance(value, (list, tuple)) else []

    @field_validator("meaning", mode="before")
    @classmethod
    def _text(cls, value: Any) -> Any:
        return "" if value is None else str(value)


class _ReportedFile(BaseModel):
    model_config = ConfigDict(extra="ignore")

    file: int
    symbols: list[_ReportedSymbol] = Field(default_factory=list)


class _ReadReply(BaseModel):
    model_config = ConfigDict(extra="ignore")

    files: list[_ReportedFile] = Field(default_factory=list)


def _indent(text: str) -> int:
    return len(text) - len(text.lstrip(" \t")) + 3 * text[: len(text) - len(text.lstrip(" \t"))].count("\t")


# A line that closes a block (`}`, `end`), and a line that leaves one open (`) {`, `} else {`).
_CLOSER = re.compile(r"^(?:[})\]]|(?:end|fi|done|esac)\b)")
_OPENER = re.compile(r"(?:[{(\[:=,\\|]|=>|->|\b(?:do|then|begin))$")
_LONE_OPENERS = ("{", "do", "begin", "then")


def block_end(lines: Sequence[str], start: int) -> int:
    """The last line (1-based) of the definition that starts on line ``start``, judged by indentation.

    The lines that follow belong to it while they are indented deeper; a closing
    line at the definition's own depth (`}`, `end`, `)`) ends it, unless that line
    opens again (`) {`, `} else {`).
    """
    base = _indent(lines[start - 1])
    last = start
    index = start
    while index < len(lines):
        text = lines[index]
        stripped = text.strip()
        if not stripped:
            index += 1
            continue
        depth = _indent(text)
        if depth > base:
            last = index + 1
            index += 1
            continue
        if depth != base:
            break
        # An opening brace on its own line right under the definition (`int f(void)` / `{`).
        opens_here = stripped in _LONE_OPENERS and last == index
        if not opens_here and not _CLOSER.match(stripped):
            break
        last = index + 1
        index += 1
        if not opens_here and not _OPENER.search(stripped):
            break
    return last


def _has_word(line: str, name: str) -> bool:
    return re.search(rf"(?<![\w$]){re.escape(name)}(?![\w$])", line) is not None


def _definition_line(lines: Sequence[str], name: str, reported: int) -> int | None:
    """The line that defines ``name``: the reported one when the name is on it, else the nearest that has it."""
    total = len(lines)
    if total == 0:
        return None
    anchor = min(max(reported, 1), total)
    if _has_word(lines[anchor - 1], name):
        return anchor
    for distance in range(1, total):
        for candidate in (anchor - distance, anchor + distance):
            if 1 <= candidate <= total and _has_word(lines[candidate - 1], name):
                return candidate
    return None


def check_reported(file: SourceFile, reported: Iterable[_ReportedSymbol]) -> tuple[list[FoundSymbol], list[tuple[str, str]]]:
    """Keep what the model reported that the file bears out. The definition kept is the file's own lines."""
    lines = file.lines
    if lines and lines[-1] == "":
        lines = lines[:-1]
    kept: list[FoundSymbol] = []
    skipped: list[tuple[str, str]] = []
    seen: set[str] = set()
    for item in reported:
        name = item.name.strip()
        if not _NAME.match(name) or len(name) > 100:
            skipped.append((name[:40] or "(no name)", "not a name"))
            continue
        if name in seen:
            continue
        seen.add(name)
        if name == "main":
            skipped.append((name, "it is the file's own entry point"))
            continue
        what = _KIND_WORDS.get(item.kind.strip().casefold())
        if what is None:
            skipped.append((name, f"an unknown kind ({item.kind.strip()[:20]})"))
            continue
        start = _definition_line(lines, name, item.line)
        if start is None:
            skipped.append((name, "the file has no such name"))
            continue
        end = item.end_line
        if end is None or end < start or end > len(lines) or end - start > 800:
            end = block_end(lines, start)
        fragment = "\n".join(lines[start - 1 : end]).rstrip()
        if len(fragment) > MAX_FRAGMENT_CHARS:
            skipped.append((name, f"its definition is longer than {MAX_FRAGMENT_CHARS:,} characters"))
            continue
        head = "\n".join(lines[start - 1 : min(end, start + 7)])
        params = tuple(param.strip() for param in item.params if param.strip() and _has_word(head, param.strip().lstrip("*&$@")))
        meaning = " ".join(item.meaning.split())
        if len(meaning) > 300:
            meaning = meaning[:297].rstrip() + "..."
        words = set(_WORD.findall(fragment)) - {name} - {param.lstrip("*&$@") for param in params}
        refs = sorted(words | {use.strip() for use in item.uses if _NAME.match(use.strip()) and _has_word(fragment, use.strip())})
        kept.append(
            FoundSymbol(
                name=name, kind=SymbolKind.FUNCTION if what == "function" else SymbolKind.VARIABLE, line=start, end_line=end,
                fragment=fragment, params=params if what == "function" else (), meaning=meaning, what=what, refs=tuple(refs),
            )
        )
    kept.sort(key=lambda symbol: symbol.line)
    return kept, skipped


def batches(files: Sequence[SourceFile]) -> list[list[SourceFile]]:
    """Files grouped so one request carries a readable amount of source."""
    groups: list[list[SourceFile]] = []
    current: list[SourceFile] = []
    size = 0
    for file in files:
        length = len(file.text)
        if current and (size + length > BATCH_CHARS or len(current) >= BATCH_FILES):
            groups.append(current)
            current, size = [], 0
        current.append(file)
        size += length
    if current:
        groups.append(current)
    return groups


def read_prompt(files: Sequence[SourceFile]) -> str:
    parts = [f"FILE {number}: {file.relative} ({file.language.display})\n{file.numbered()}" for number, file in enumerate(files, start=1)]
    return "\n\n".join(parts) + "\n\nReturn the JSON object now, with one entry for each of the " + (
        f"{len(files)} files." if len(files) != 1 else "file."
    )


def read_with_model(files: Sequence[SourceFile], client: LLMClient, config: ImyConfig) -> list[FileRead]:
    """One request: the model lists what the files define, and each answer is checked against its file."""
    started = time.monotonic()
    messages: list[ChatMessage] = [ChatMessage("user", read_prompt(files))]
    problems: list[str] = []
    for _ in range(1 + config.repair_attempts):
        reply = client.complete(
            LLMRequest(system=READ_SYSTEM_PROMPT, messages=tuple(messages), max_output_tokens=config.max_output_tokens, json_schema=READ_SCHEMA)
        )
        try:
            answer = _ReadReply.model_validate(extract_json_object(reply.text))
        except ResponseFormatError as exc:
            problems = exc.problems
        except ValidationError as exc:
            problems = [f"{'.'.join(str(part) for part in error.get('loc', ())) or 'object'}: {error.get('msg', 'invalid')}" for error in exc.errors()][:8]
        else:
            waited = time.monotonic() - started
            reported = {entry.file: entry.symbols for entry in answer.files}
            reads: list[FileRead] = []
            for number, file in enumerate(files, start=1):
                symbols, skipped = check_reported(file, reported.get(number, []))
                reads.append(FileRead(file=file, symbols=symbols, skipped=skipped, how="model", model=reply.model, seconds=waited))
            return reads
        messages.append(ChatMessage("assistant", reply.text or "(empty reply)"))
        messages.append(
            ChatMessage("user", "Your previous reply could not be used:\n" + "\n".join(f"- {problem}" for problem in problems) + "\nReturn the JSON object only, in the shape asked for.")
        )
    summary = "; ".join(problems)[:200] or "no usable answer"
    return [FileRead(file=file, how="model", error=f"the model's answer could not be used ({summary})") for file in files]


# ── What was read before ─────────────────────────────────────────────────


class ImportIndex:
    """What each imported file was found to define, kept in the workspace so an unchanged file is not read again."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._files: dict[str, dict[str, Any]] = {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        files = data.get("files") if isinstance(data, dict) else None
        if isinstance(files, dict) and data.get("reader") == READER_VERSION:
            self._files = {key: value for key, value in files.items() if isinstance(key, str) and isinstance(value, dict)}

    def get(self, file: SourceFile) -> FileRead | None:
        entry = self._files.get(str(file.path))
        if entry is None or entry.get("digest") != file.digest:
            return None
        try:
            symbols = [FoundSymbol.from_json(item) for item in entry.get("symbols", [])]
        except (KeyError, TypeError, ValueError):
            return None
        return FileRead(file=file, symbols=symbols, how="saved", model=str(entry.get("model", "")))

    def put(self, read: FileRead) -> None:
        self._files[str(read.file.path)] = {
            "digest": read.file.digest,
            "language": read.file.language.name,
            "model": read.model,
            "read_at": now_iso(),
            "symbols": [symbol.to_json() for symbol in read.symbols],
        }

    def drop(self, location: Path) -> None:
        self._files = {key: value for key, value in self._files.items() if Path(key) != location and location not in Path(key).parents}

    def save(self) -> None:
        payload = json.dumps({"format": "imy-imports", "reader": READER_VERSION, "files": self._files}, indent=2, ensure_ascii=False) + "\n"
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            handle, temporary = tempfile.mkstemp(prefix=".imports.", suffix=".json", dir=self.path.parent)
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                stream.write(payload)
            os.replace(temporary, self.path)
        except OSError:
            # A record that can't be written only means the files are read again next time.
            return


# ── From what was read to saved definitions ──────────────────────────────


def _meaning(found: FoundSymbol, file: SourceFile, project: str) -> str:
    language = file.language.display
    where = f"{project}/{file.relative}" if project and project != file.relative else file.relative
    said = found.meaning.strip().rstrip(".")
    if found.what == "class":
        said = f"{said}. A {language} class" if said else f"{language} class {found.name}"
    elif not said and found.what == "function":
        said = f"{language} function {found.name}({', '.join(found.params)})"
    elif not said:
        # A short assignment says what the variable holds better than any sentence about it.
        line = " ".join(found.fragment.split())
        said = f"{language} variable: {line}" if "\n" not in found.fragment.strip() and len(line) <= 100 else f"{language} variable {found.name}"
    text = f"{said}. Imported from {where}."
    if found.needs:
        text += " Its file imports: " + "; ".join(found.needs) + "."
    return text[:4000]


def to_memory(reads: Sequence[FileRead], project: str) -> list[MemorySymbol]:
    """The saved definitions for what was read. A function two files both define is kept from the first."""
    names = {symbol.name for read in reads for symbol in read.symbols}
    stamp = now_iso()
    owners: dict[str, str] = {}
    saved: list[MemorySymbol] = []
    for read in reads:
        kept: list[FoundSymbol] = []
        for found in read.symbols:
            if found.kind is SymbolKind.FUNCTION:
                owner = owners.setdefault(found.name, read.file.relative)
                if owner != read.file.relative:
                    read.skipped.append((found.name, f"{owner} already defines it"))
                    continue
            kept.append(found)
            saved.append(
                MemorySymbol(
                    name=found.name,
                    kind=found.kind,
                    meaning=_meaning(found, read.file, project),
                    source_fragment=found.fragment,
                    fingerprint=fingerprint(found.fragment),
                    origin=str(read.file.path),
                    origin_line=found.line,
                    members=list(found.params),
                    language=read.file.language.name,
                    uses=sorted(name for name in set(found.refs) if name in names and name != found.name),
                    created_at=stamp,
                    updated_at=stamp,
                )
            )
        read.symbols = kept
    return saved


@dataclass
class ImportOutcome:
    root: Path
    project: str
    collected: Collected
    reads: list[FileRead] = field(default_factory=list)
    report: MemoryUpdateReport | None = None
    # The provider problem that stopped the model's reading, when there was one.
    model_error: ImyError | None = None
    # Files the model was to read but was not asked about, after that problem.
    unread: list[SourceFile] = field(default_factory=list)

    @property
    def symbols(self) -> list[FoundSymbol]:
        return [symbol for read in self.reads for symbol in read.symbols]

    def count(self, what: str) -> int:
        return sum(read.count(what) for read in self.reads)


def for_model(files: Sequence[SourceFile]) -> list[SourceFile]:
    """The files the model reads: every language but Python."""
    return [file for file in files if file.language.name != "python"]


def import_project(
    root: Path,
    *,
    memory: Memory,
    index: ImportIndex,
    config: ImyConfig,
    client_factory: Callable[[], LLMClient],
    project: str | None = None,
    max_files: int = MAX_FILES,
    max_bytes: int = MAX_FILE_BYTES,
    include_tests: bool = False,
    update: bool = False,
    fresh: bool = False,
    store: MemoryStore | None = None,
    on_read: Callable[[FileRead], None] | None = None,
    on_model: Callable[[int], None] | None = None,
) -> ImportOutcome:
    """Read ``root`` and save what it defines to memory.

    ``on_read`` hears each file as its reading is known (in file order within a
    request), ``on_model`` how many files the model is about to read.
    """
    collected = collect(root, max_files=max_files, max_bytes=max_bytes, include_tests=include_tests)
    name = project if project is not None else collected.root.name
    outcome = ImportOutcome(root=collected.root, project=name, collected=collected)
    reads: dict[Path, FileRead] = {}

    def done(read: FileRead) -> None:
        reads[read.file.path] = read
        if read.error is None and read.how != "saved":
            index.put(read)
        if on_read is not None:
            on_read(read)

    waiting: list[SourceFile] = []
    for file in collected.files:
        earlier = None if fresh else index.get(file)
        if earlier is not None:
            done(earlier)
        elif file.language.name == "python":
            done(read_python(file))
        else:
            waiting.append(file)

    if waiting:
        if on_model is not None:
            on_model(len(waiting))
        client = client_factory()
        groups = batches(waiting)
        with ThreadPoolExecutor(max_workers=max(1, min(WORKERS, len(groups))), thread_name_prefix="imy-import") as pool:
            futures = [pool.submit(read_with_model, group, client, config) for group in groups]
            for group, future in zip(groups, futures, strict=True):
                if outcome.model_error is not None:
                    future.cancel()
                    if future.cancelled():
                        outcome.unread.extend(group)
                        continue
                try:
                    for read in future.result():
                        done(read)
                except LLMError as exc:
                    if outcome.model_error is None:
                        outcome.model_error = exc
                    outcome.unread.extend(group)

    outcome.reads = [reads[file.path] for file in collected.files if file.path in reads]
    index.save()
    candidates = to_memory([read for read in outcome.reads if read.error is None], name)
    if candidates:
        outcome.report = memory.add_imported(candidates, update=update, store=store)
    return outcome
