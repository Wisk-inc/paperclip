"""Structural parser for IMY source.

IMY lets people invent their own syntax, so this parser never tries to
understand meaning. It finds the structure every IMY file shares: the
``# ("...")`` headers, string literals, identifiers, dotted chains, calls,
assignments (``=`` chains), auto-helper shortcuts (``.auto*``), variable packs
(``... = name variablepack = "XYZ"``), virtual paths (``ship ("/file:paths")``)
and web resources (``"https://..."``).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path

from .errors import SourceFileError

MAX_SOURCE_BYTES = 1_000_000
STRING_MASK = "\x01"

DOUBLE_QUOTES = frozenset({'"', "“", "”"})
SINGLE_QUOTES = frozenset({"'", "‘", "’"})
SINGLE_OPENERS = frozenset({"'", "‘"})

FUNCTION_KEYWORDS = frozenset(
    {"def", "fn", "func", "function", "fun", "define", "block", "proc", "sub", "method", "routine"}
)
CONTROL_WORDS = frozenset(
    {
        "if", "elif", "else", "while", "for", "foreach", "switch", "when", "return", "until", "unless",
        "and", "or", "not", "in", "then", "do", "with", "catch", "except", "match", "case", "repeat", "loop",
    }
)
OPERAND_OPS = frozenset(
    {"+", "-", "*", "/", "%", "**", "//", "<", ">", "<=", ">=", "==", "!=", "&&", "||", "^", "&", "|"}
)
PACK_KEYWORD = re.compile(r"^(?:var(?:i?a?b?l?e?)?|v)?_?pack$", re.IGNORECASE)
PACK_NAME = re.compile(r"^[^\W\d]\w{0,31}$")
URL_PATTERN = re.compile(r"^https?://[^\s\"'<>]+$", re.IGNORECASE)
SHIP_KEYWORD = "ship"

_TOKEN_RE = re.compile(
    r"(?P<str>\x01+)"
    r"|(?P<num>\d+(?:\.\d+)?)"
    r"|(?P<chain>[^\W\d]\w*(?:\.[^\W\d]\w*)+)"
    r"|(?P<member>\.[^\W\d]\w*(?:\.[^\W\d]\w*)*)"
    r"|(?P<ident>[^\W\d]\w*(?:['’][^\W\d]+)?)"
    r"|(?P<op>\*\*|//|==|!=|<=|>=|=>|->|::|:=|\+=|-=|\*=|/=|%=|&&|\|\||[=+\-*/%<>!&|^~?:;,@$#\\.])"
    r"|(?P<open>[(\[{])"
    r"|(?P<close>[)\]}])"
    r"|(?P<ws>\s+)"
    r"|(?P<other>.)",
    re.DOTALL,
)
_ASSIGN_OPS = frozenset({"=", ":="})
_AUGMENTED_OPS = frozenset({"+=", "-=", "*=", "/=", "%="})


class LineKind(StrEnum):
    BLANK = "blank"
    HEADER = "header"
    BAD_HEADER = "bad_header"
    COMMENT = "comment"
    CODE = "code"


@dataclass(frozen=True)
class StringLiteral:
    value: str
    start: int
    end: int


@dataclass(frozen=True)
class Token:
    kind: str
    text: str
    start: int
    end: int
    value: str | None = None

    @property
    def root(self) -> str:
        if self.kind == "chain":
            return self.text.split(".", 1)[0]
        if self.kind == "member":
            return self.text.lstrip(".").split(".", 1)[0]
        return self.text

    @property
    def parts(self) -> list[str]:
        return [p for p in self.text.split(".") if p]


@dataclass(frozen=True)
class ShortcutToken:
    token: str
    column: int
    receiver: str | None


@dataclass(frozen=True)
class Call:
    target: str
    root: str
    method: str | None
    args: tuple[str, ...]
    has_args: bool
    column: int


@dataclass(frozen=True)
class Statement:
    """What one code line does, structurally."""

    tokens: tuple[Token, ...]
    segments: tuple[tuple[Token, ...], ...]
    is_assignment: bool
    targets: tuple[str, ...]
    operand_refs: tuple[str, ...]
    calls: tuple[Call, ...]
    chains: tuple[str, ...]
    identifiers: tuple[str, ...]
    shortcuts: tuple[ShortcutToken, ...]
    function_name: str | None = None
    function_params: tuple[str, ...] = ()
    value_refs: tuple[str, ...] = ()
    plain_identifiers: tuple[str, ...] = ()

    @property
    def value_tokens(self) -> tuple[Token, ...]:
        return self.segments[-1] if self.segments else ()


@dataclass
class SourceLine:
    number: int
    text: str
    kind: LineKind
    indent: int
    strings: tuple[StringLiteral, ...] = ()
    masked: str = ""
    header: str | None = None
    header_problem: str | None = None
    unterminated_at: int | None = None
    statement: Statement | None = None
    in_function: bool = False

    @property
    def is_code(self) -> bool:
        return self.kind is LineKind.CODE


@dataclass(frozen=True)
class Block:
    header_line: int
    description: str
    first_line: int
    last_line: int


@dataclass(frozen=True)
class Shortcut:
    token: str
    line: int
    column: int
    receiver: str | None

    @property
    def length(self) -> int:
        return len(self.token)


@dataclass(frozen=True)
class VariablePack:
    name: str
    line: int
    members: tuple[str, ...]
    text: str


@dataclass(frozen=True)
class VirtualPath:
    path: str
    line: int


@dataclass(frozen=True)
class WebResource:
    url: str
    line: int
    mirrored: bool


@dataclass(frozen=True)
class FunctionDef:
    name: str
    line: int
    end_line: int
    params: tuple[str, ...]
    text: str


@dataclass
class ParsedSource:
    """Everything the parser found in one IMY file."""

    path: Path | None
    text: str
    lines: list[SourceLine]
    blocks: list[Block] = field(default_factory=list)
    shortcuts: list[Shortcut] = field(default_factory=list)
    packs: list[VariablePack] = field(default_factory=list)
    virtual_paths: list[VirtualPath] = field(default_factory=list)
    web_resources: list[WebResource] = field(default_factory=list)
    functions: list[FunctionDef] = field(default_factory=list)

    def line(self, number: int) -> SourceLine:
        return self.lines[number - 1]

    @property
    def raw_lines(self) -> list[str]:
        return [line.text for line in self.lines]

    @property
    def header(self) -> str:
        return " ".join(block.description for block in self.blocks)

    def code_lines(self) -> list[SourceLine]:
        return [line for line in self.lines if line.is_code]

    def body_is_empty(self) -> bool:
        return not self.code_lines()

    def top_level_assignments(self) -> dict[str, list[int]]:
        found: dict[str, list[int]] = {}
        for line in self.code_lines():
            if line.in_function or line.statement is None or not line.statement.is_assignment:
                continue
            for name in line.statement.targets:
                found.setdefault(name, []).append(line.number)
        return found

    def first_definitions(self) -> dict[str, int]:
        """Name -> first line that defines it at top level (assignments, functions, packs)."""
        defs: dict[str, int] = {}
        for name, numbers in self.top_level_assignments().items():
            defs[name] = min(numbers)
        for fn in self.functions:
            if not self.line(fn.line).in_function:
                defs[fn.name] = min(defs.get(fn.name, fn.line), fn.line)
        return defs

    def string_values(self) -> list[tuple[int, str]]:
        return [(line.number, lit.value) for line in self.code_lines() for lit in line.strings]

    def identifiers(self) -> set[str]:
        names: set[str] = set()
        for line in self.code_lines():
            if line.statement is not None:
                names.update(line.statement.identifiers)
        return names

    def value_references(self) -> set[str]:
        """Names used as values somewhere in the file (see analyze_statement)."""
        names: set[str] = set()
        for line in self.code_lines():
            if line.statement is not None:
                names.update(line.statement.value_refs)
        return names

    def plain_identifiers(self) -> set[str]:
        """Names that appear other than as the thing being called (``count`` in ``count(x)`` is not one)."""
        names: set[str] = set()
        for line in self.code_lines():
            if line.statement is not None:
                names.update(line.statement.plain_identifiers)
        return names

    def mention_line(self, name: str) -> int | None:
        """First code line whose code (strings aside) holds ``name`` as written, e.g. ``repeat until``
        or ``extract.font123``; None when no line does."""
        pieces = name.split()
        if not pieces:
            return None
        pattern = re.compile(r"(?<![\w.])" + r"\s+".join(re.escape(piece) for piece in pieces) + r"(?!\w)")
        for line in self.code_lines():
            if pattern.search(line.masked):
                return line.number
        return None

    def chains(self) -> set[str]:
        """Every dotted chain, plus each of its prefixes (``a.b.c`` gives ``a.b`` and ``a.b.c``)."""
        found: set[str] = set()
        for line in self.code_lines():
            if line.statement is None:
                continue
            for chain in line.statement.chains:
                parts = chain.split(".")
                for size in range(2, len(parts) + 1):
                    found.add(".".join(parts[:size]))
        return found

    def find_pack(self, name: str) -> VariablePack | None:
        folded = name.casefold()
        for pack in self.packs:
            if pack.name.casefold() == folded:
                return pack
        return None

    def find_function(self, name: str) -> FunctionDef | None:
        for fn in self.functions:
            if fn.name == name:
                return fn
        return None

    def first_line_mentioning(self, name: str) -> int | None:
        for line in self.code_lines():
            stmt = line.statement
            if stmt is None:
                continue
            if name in stmt.identifiers or name in stmt.chains:
                return line.number
            if any(name in chain.split(".") or chain.startswith(name + ".") for chain in stmt.chains):
                return line.number
        return None

    def numbered(self) -> str:
        width = max(2, len(str(len(self.lines))))
        return "\n".join(f"{line.number:>{width}} | {line.text}" for line in self.lines)


def normalize_source(text: str) -> str:
    """Canonical text: no BOM, NFC, LF endings, no trailing spaces or trailing blank lines."""
    if text.startswith("﻿"):
        text = text[1:]
    text = unicodedata.normalize("NFC", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.rstrip() for line in text.split("\n")]
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines) + ("\n" if lines else "")


def read_source(path: Path) -> str:
    """Read an .imy file as UTF-8 text without ever writing to it."""
    try:
        if not path.exists():
            raise SourceFileError(f"{path} does not exist.", hint="Check the path, or create it with your editor.")
        if path.is_dir():
            raise SourceFileError(f"{path} is a folder, not an IMY file.")
        size = path.stat().st_size
        if size > MAX_SOURCE_BYTES:
            raise SourceFileError(f"{path} is {size:,} bytes; IMY files are limited to {MAX_SOURCE_BYTES:,} bytes.")
        data = path.read_bytes()
    except OSError as exc:
        raise SourceFileError(f"Can't read {path}: {exc.strerror or exc}") from exc
    if b"\x00" in data:
        raise SourceFileError(f"{path} looks like a binary file, not IMY source.")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SourceFileError(
            f"{path} is not UTF-8 text (byte {exc.start}).", hint="Save the file as UTF-8 in your editor."
        ) from exc


def scan_strings(text: str) -> tuple[list[StringLiteral], str, int | None]:
    """Find string literals. Returns them, the line with each literal masked, and
    the column of an unterminated double-quoted string (or None)."""
    strings: list[StringLiteral] = []
    masked = list(text)
    i = 0
    length = len(text)
    while i < length:
        ch = text[i]
        is_double = ch in DOUBLE_QUOTES
        is_single = ch in SINGLE_OPENERS and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] == "_"))
        if not (is_double or is_single):
            i += 1
            continue
        closers = DOUBLE_QUOTES if is_double else SINGLE_QUOTES
        j = i + 1
        value: list[str] = []
        closed = False
        while j < length:
            cj = text[j]
            if cj == "\\" and j + 1 < length:
                nxt = text[j + 1]
                value.append({"n": "\n", "t": "\t", "r": "\r", "0": "\0"}.get(nxt, nxt))
                j += 2
                continue
            if cj in closers:
                closed = True
                break
            value.append(cj)
            j += 1
        if not closed:
            if is_double:
                return strings, "".join(masked), i
            i += 1
            continue
        strings.append(StringLiteral(value="".join(value), start=i, end=j + 1))
        for k in range(i, j + 1):
            masked[k] = STRING_MASK
        i = j + 1
    return strings, "".join(masked), None


def tokenize(masked: str, strings: list[StringLiteral]) -> list[Token]:
    """Split a masked line into tokens. Whitespace is dropped."""
    by_start = {lit.start: lit for lit in strings}
    tokens: list[Token] = []
    for match in _TOKEN_RE.finditer(masked):
        kind = match.lastgroup or "other"
        if kind == "ws":
            continue
        start, end = match.span()
        value = None
        if kind == "str":
            literal = by_start.get(start)
            if literal is not None and literal.end == end:
                value = literal.value
            else:
                pieces = [lit.value for lit in strings if start <= lit.start < end]
                value = "".join(pieces)
        tokens.append(Token(kind=kind, text=match.group(), start=start, end=end, value=value))
    return tokens


def parse_header(text: str) -> tuple[str | None, str | None]:
    """Return (description, problem). Both None when the line isn't a header attempt."""
    stripped = text.strip()
    if not stripped.startswith("#"):
        return None, None
    rest = stripped[1:].lstrip()
    if not rest.startswith("("):
        return None, 'a header must look like # ("what this code builds and how it works")'
    rest = rest[1:].lstrip()
    if not rest or (rest[0] not in DOUBLE_QUOTES and rest[0] not in SINGLE_QUOTES):
        return None, 'put the header description in quotes: # ("...")'
    closers = DOUBLE_QUOTES if rest[0] in DOUBLE_QUOTES else SINGLE_QUOTES
    chars: list[str] = []
    i = 1
    closed_at = -1
    while i < len(rest):
        ch = rest[i]
        if ch == "\\" and i + 1 < len(rest):
            chars.append(rest[i + 1])
            i += 2
            continue
        if ch in closers:
            closed_at = i
            break
        chars.append(ch)
        i += 1
    if closed_at == -1:
        return None, "the header's quoted description is never closed"
    tail = rest[closed_at + 1 :].strip()
    if not tail.startswith(")"):
        return None, 'close the header with a parenthesis: # ("...")'
    if tail[1:].strip():
        return None, "nothing may follow the header on the same line"
    description = " ".join("".join(chars).split())
    if len(description.split()) < 3:
        return None, "the header must say what the code builds and how it works (at least 3 words)"
    return description, None


def _is_comment_start(stripped: str) -> bool:
    if stripped.startswith(("//", "/*", "<!--", "*/", "-->")):
        return True
    if stripped == "--" or stripped.startswith(("-- ", "--\t")):
        return True
    return False


def _split_segments(tokens: list[Token]) -> tuple[list[list[Token]], list[Token]]:
    """Split on top-level assignment operators. Returns (segments, augmented-assignment targets)."""
    segments: list[list[Token]] = [[]]
    augmented: list[Token] = []
    depth = 0
    for index, tok in enumerate(tokens):
        if tok.kind == "open":
            depth += 1
        elif tok.kind == "close":
            depth = max(0, depth - 1)
        if depth == 0 and tok.kind == "op" and tok.text in _ASSIGN_OPS:
            segments.append([])
            continue
        if depth == 0 and tok.kind == "op" and tok.text in _AUGMENTED_OPS:
            previous = [t for t in tokens[:index] if t.kind in ("ident", "chain")]
            if previous:
                augmented.append(previous[-1])
        segments[-1].append(tok)
    return segments, augmented


def _matching_close(tokens: list[Token], open_index: int) -> int:
    depth = 0
    for index in range(open_index, len(tokens)):
        tok = tokens[index]
        if tok.kind == "open":
            depth += 1
        elif tok.kind == "close":
            depth -= 1
            if depth == 0:
                return index
    return len(tokens) - 1


def analyze_statement(tokens: list[Token]) -> Statement:
    """Find assignments, calls, operands, chains and shortcuts in one line's tokens."""
    function_name: str | None = None
    function_params: tuple[str, ...] = ()
    if (
        len(tokens) >= 2
        and tokens[0].kind == "ident"
        and tokens[0].text.lower() in FUNCTION_KEYWORDS
        and tokens[1].kind == "ident"
    ):
        # `def name(...)`, or `def name:` / `def name {` with nothing after. A line such as
        # `define speed = 5`, `sub total = a + b` or `block door` only starts with one of those words.
        third = tokens[2] if len(tokens) > 2 else None
        has_params = third is not None and third.kind == "open" and third.text == "("
        bare = len(tokens) == 3 and third is not None and third.text in (":", "{")
        if has_params:
            close = _matching_close(tokens, 2)
            function_params = tuple(t.text for t in tokens[3:close] if t.kind == "ident")
        if has_params or bare:
            function_name = tokens[1].text

    segments, augmented = _split_segments(tokens)
    is_assignment = function_name is None and len(segments) >= 2 and any(segments[:-1])

    targets: list[str] = []
    if is_assignment:
        for segment in segments[:-1]:
            for tok in segment:
                if tok.kind in ("ident", "chain"):
                    targets.append(tok.text)

    calls: list[Call] = []
    operand_refs: list[str] = [tok.root for tok in augmented]
    plain: list[str] = []
    if function_name is None:
        for index, tok in enumerate(tokens):
            if tok.kind not in ("ident", "chain"):
                continue
            nxt = tokens[index + 1] if index + 1 < len(tokens) else None
            if tok.kind == "chain" or not (nxt is not None and nxt.kind == "open" and nxt.text == "("):
                plain.append(tok.root)
            if nxt is not None and nxt.kind == "open" and nxt.text == "(":
                close = _matching_close(tokens, index + 1)
                inner = tokens[index + 2 : close]
                args = tuple(t.root for t in inner if t.kind in ("ident", "chain"))
                parts = tok.parts
                calls.append(
                    Call(
                        target=tok.text,
                        root=parts[0],
                        method=parts[-1] if len(parts) > 1 else None,
                        args=args,
                        has_args=bool(inner),
                        column=tok.start,
                    )
                )
            prev = tokens[index - 1] if index > 0 else None
            if (prev is not None and prev.kind == "op" and prev.text in OPERAND_OPS) or (
                nxt is not None and nxt.kind == "op" and nxt.text in OPERAND_OPS
            ):
                operand_refs.append(tok.root)

    chains = tuple(tok.text for tok in tokens if tok.kind == "chain")
    # Names used as values: beside an operator, passed to a call, the object a dotted
    # chain starts from, or on the right of the last `=`.
    value_refs: list[str] = list(operand_refs)
    for call in calls:
        value_refs.extend(call.args)
    value_refs.extend(tok.root for tok in tokens if tok.kind == "chain")
    if is_assignment:
        last = segments[-1]
        for index, tok in enumerate(last):
            nxt = last[index + 1] if index + 1 < len(last) else None
            if tok.kind == "ident" and not (nxt is not None and nxt.kind == "open" and nxt.text == "("):
                value_refs.append(tok.text)
    identifiers: list[str] = []
    for tok in tokens:
        if tok.kind == "ident":
            identifiers.append(tok.text)
        elif tok.kind == "chain":
            identifiers.append(tok.root)
        elif tok.kind == "member":
            identifiers.extend(tok.parts)

    shortcuts: list[ShortcutToken] = []
    for tok in tokens:
        if tok.kind not in ("chain", "member"):
            continue
        parts = tok.text.split(".")
        offset = tok.start
        for position, part in enumerate(parts):
            if position == 0 and tok.kind == "chain":
                offset += len(part) + 1
                continue
            if part and part.lower().startswith("auto"):
                receiver = ".".join(p for p in parts[:position] if p) or None
                shortcuts.append(ShortcutToken(token="." + part, column=offset - 1, receiver=receiver))
            offset += len(part) + 1

    return Statement(
        tokens=tuple(tokens),
        segments=tuple(tuple(seg) for seg in segments),
        is_assignment=is_assignment,
        targets=tuple(targets),
        operand_refs=tuple(operand_refs),
        calls=tuple(calls),
        chains=chains,
        identifiers=tuple(identifiers),
        shortcuts=tuple(shortcuts),
        function_name=function_name,
        function_params=function_params,
        value_refs=tuple(dict.fromkeys(value_refs)),
        plain_identifiers=tuple(dict.fromkeys(plain)),
    )


def _classify(number: int, text: str, in_block_comment: bool) -> tuple[SourceLine, bool]:
    indent = len(text) - len(text.lstrip(" \t"))
    stripped = text.strip()
    if not stripped:
        return SourceLine(number=number, text=text, kind=LineKind.BLANK, indent=indent), in_block_comment
    if in_block_comment:
        still_open = "*/" not in stripped and "-->" not in stripped
        return SourceLine(number=number, text=text, kind=LineKind.COMMENT, indent=indent), still_open
    if stripped.startswith("#"):
        description, problem = parse_header(stripped)
        kind = LineKind.HEADER if description is not None else LineKind.BAD_HEADER
        line = SourceLine(
            number=number, text=text, kind=kind, indent=indent, header=description, header_problem=problem
        )
        return line, False
    if _is_comment_start(stripped):
        opens_block = (stripped.startswith("/*") and "*/" not in stripped[2:]) or (
            stripped.startswith("<!--") and "-->" not in stripped[4:]
        )
        return SourceLine(number=number, text=text, kind=LineKind.COMMENT, indent=indent), opens_block
    strings, masked, unterminated = scan_strings(text)
    line = SourceLine(
        number=number,
        text=text,
        kind=LineKind.CODE,
        indent=indent,
        strings=tuple(strings),
        masked=masked,
        unterminated_at=unterminated,
    )
    if unterminated is None:
        line.statement = analyze_statement(tokenize(masked, strings))
    return line, False


def _function_extent(lines: list[SourceLine], start: int) -> int:
    """Index (0-based) of the last line belonging to the function defined at ``start``."""
    opener = lines[start]
    depth = opener.masked.count("{") - opener.masked.count("}")
    if depth > 0:
        for index in range(start + 1, len(lines)):
            line = lines[index]
            if line.kind is LineKind.HEADER:
                return index - 1
            if line.is_code:
                depth += line.masked.count("{") - line.masked.count("}")
                if depth <= 0:
                    return index
        return len(lines) - 1
    last = start
    for index in range(start + 1, len(lines)):
        line = lines[index]
        if line.kind is LineKind.BLANK:
            continue
        if line.kind is LineKind.HEADER or line.indent <= opener.indent:
            break
        last = index
    return last


def parse_text(text: str, path: Path | None = None) -> ParsedSource:
    """Parse IMY source text (normalized first)."""
    normalized = normalize_source(text)
    raw_lines = normalized.split("\n")[:-1] if normalized else []
    lines: list[SourceLine] = []
    in_block_comment = False
    for number, raw in enumerate(raw_lines, start=1):
        line, in_block_comment = _classify(number, raw, in_block_comment)
        lines.append(line)
    parsed = ParsedSource(path=path, text=normalized, lines=lines)

    header_runs: list[tuple[int, str]] = []
    for line in lines:
        if line.kind is LineKind.HEADER and line.header is not None:
            if header_runs and _only_headers_between(lines, header_runs[-1][0], line.number):
                first, description = header_runs[-1]
                header_runs[-1] = (first, f"{description} {line.header}")
            else:
                header_runs.append((line.number, line.header))
    for position, (header_line, description) in enumerate(header_runs):
        next_header = header_runs[position + 1][0] if position + 1 < len(header_runs) else len(lines) + 1
        parsed.blocks.append(
            Block(header_line=header_line, description=description, first_line=header_line + 1, last_line=next_header - 1)
        )

    for index, line in enumerate(lines):
        stmt = line.statement
        if stmt is None or stmt.function_name is None or line.in_function:
            continue
        end = _function_extent(lines, index)
        for inner in lines[index + 1 : end + 1]:
            inner.in_function = True
        text_block = "\n".join(l.text for l in lines[index : end + 1])
        parsed.functions.append(
            FunctionDef(name=stmt.function_name, line=line.number, end_line=end + 1, params=stmt.function_params, text=text_block)
        )

    for line in lines:
        stmt = line.statement
        if stmt is None:
            continue
        for sc in stmt.shortcuts:
            parsed.shortcuts.append(Shortcut(token=sc.token, line=line.number, column=sc.column, receiver=sc.receiver))
        _collect_packs(parsed, line, stmt)
        _collect_paths(parsed, line, stmt)
    return parsed


def _only_headers_between(lines: list[SourceLine], first: int, last: int) -> bool:
    for line in lines[first : last - 1]:
        if line.kind not in (LineKind.HEADER, LineKind.BLANK):
            return False
    return True


def _collect_packs(parsed: ParsedSource, line: SourceLine, stmt: Statement) -> None:
    """Variable packs, in the two shapes people write them:

    ``A = B = C = name variablepack = "XYZ"`` (members first, the name after the keyword's ``=``) and
    ``pack "XYZ" = A, B, C`` (the name right after the keyword, members after the ``=``).
    """
    if not stmt.is_assignment:
        return
    segments = stmt.segments
    for index, segment in enumerate(segments):
        keyword_at = next(
            (i for i, tok in enumerate(segment) if tok.kind == "ident" and PACK_KEYWORD.match(tok.text)), None
        )
        if keyword_at is None:
            continue
        after_keyword = segment[keyword_at + 1] if keyword_at + 1 < len(segment) else None
        following = segments[index + 1] if index + 1 < len(segments) else ()
        if after_keyword is not None and after_keyword.kind == "str" and after_keyword.value is not None:
            name = after_keyword.value.strip()
            member_segments = segments[:index] + segments[index + 1 :]
        elif after_keyword is None and following and following[0].kind == "str" and following[0].value is not None:
            name = following[0].value.strip()
            member_segments = segments[:index]
        else:
            continue
        if not PACK_NAME.match(name):
            continue
        members: list[str] = []
        for member_segment in member_segments:
            for position, tok in enumerate(member_segment):
                if tok.kind not in ("ident", "chain"):
                    continue
                nxt = member_segment[position + 1] if position + 1 < len(member_segment) else None
                if tok.text.lower() == SHIP_KEYWORD or (nxt is not None and nxt.kind == "open" and nxt.text == "("):
                    continue
                members.append(tok.text)
        if not members:
            continue
        parsed.packs.append(
            VariablePack(name=name, line=line.number, members=tuple(dict.fromkeys(members)), text=line.text.strip())
        )
        return


def _collect_paths(parsed: ParsedSource, line: SourceLine, stmt: Statement) -> None:
    shipped: set[int] = set()
    tokens = stmt.tokens
    for index, tok in enumerate(tokens):
        if tok.kind != "ident" or tok.text.lower() != SHIP_KEYWORD:
            continue
        cursor = index + 1
        if cursor < len(tokens) and tokens[cursor].kind == "open" and tokens[cursor].text == "(":
            cursor += 1
        if cursor < len(tokens) and tokens[cursor].kind == "str" and tokens[cursor].value:
            value = tokens[cursor].value.strip()
            shipped.add(tokens[cursor].start)
            if URL_PATTERN.match(value):
                parsed.web_resources.append(WebResource(url=value, line=line.number, mirrored=True))
            elif value:
                parsed.virtual_paths.append(VirtualPath(path=value, line=line.number))
    for literal in line.strings:
        if literal.start in shipped:
            continue
        value = literal.value.strip()
        if URL_PATTERN.match(value):
            parsed.web_resources.append(WebResource(url=value, line=line.number, mirrored=False))


def parse_file(path: Path) -> ParsedSource:
    return parse_text(read_source(path), path=path.resolve())
