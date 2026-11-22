"""Deterministic pre-flight rules. They run before any AI call and cost nothing.

Rules enforced here:

* header contract: the file (and every function block) starts with ``# ("...")``
* code-only body: English requests or sentences in the body -> PromptingDetected
* no comments in the body (the header is the only description)
* at most one ``.auto*`` shortcut per file, at most 20 characters, dot included
* no magic toggles (``Feature = True`` that nothing reads; ``thing.feature.on``)
* strict top-to-bottom order: nothing is used before the line that defines it,
  and a shortcut never comes after code that depends on it
"""

from __future__ import annotations

import re
from collections.abc import Collection, Iterable
from dataclasses import dataclass

from .errors import Diagnostic, ErrorCode, Stage
from .parser import (
    CONTROL_WORDS,
    STRING_MASK,
    LineKind,
    ParsedSource,
    SourceLine,
    Statement,
    Token,
)

MAX_SHORTCUTS = 1
MAX_SHORTCUT_LENGTH = 20

_STRONG_OPS = frozenset(
    {
        "=", ":=", "==", "!=", "<=", ">=", "=>", "->", "::", "+", "*", "/", "%", "<", ">", "&", "|",
        "^", "~", "@", "$", "\\", ";", "**", "//", "&&", "||", "+=", "-=", "*=", "/=", "%=",
    }
)
_REQUEST_RE = re.compile(
    "|".join(
        (
            r"\b(?:make|build|write|create|code|give|show|help|get|send|tell|teach|find) me\b",
            r"\b(?:can|could|would|will) you\b",
            r"\bplease\b",
            r"\bpls\b",
            r"\bplz\b",
            r"\bi (?:want|need|wanna|would like)\b",
            r"\bi'd like\b",
            r"\bi'm (?:trying|looking|wanting)\b",
            r"\blet'?s (?:make|build|create|write|code)\b",
            r"\b(?:make|write|create|build|generate|code|program|design) (?:a|an|the|some|my|me|it)\b",
            r"\b(?:that|which) (?:does|do|can|will|should|would)\b",
            r"\bsomething (?:that|like|cool|nice)\b",
            r"\bblah\b",
            r"^(?:hello|hi|hey|yo|thanks|thank you|ok so|so basically|basically)\b",
            r"\bhow (?:do|can|would|should) (?:i|you|we)\b",
            r"\bwhat (?:is|are|does|do)\b",
            r"\bfor me\b",
        )
    )
)
_STOPWORDS = frozenset(
    {
        "a", "an", "the", "me", "my", "mine", "you", "your", "yours", "i", "im", "i'm", "we", "us", "our",
        "he", "she", "him", "her", "they", "them", "their", "it", "its", "it's", "this", "that", "these",
        "those", "is", "are", "was", "were", "be", "been", "being", "am", "does", "did", "to", "for", "of",
        "about", "so", "some", "something", "anything", "can", "could", "would", "should", "will", "shall",
        "may", "might", "must", "want", "wants", "need", "needs", "like", "just", "really", "very", "please",
        "make", "makes", "create", "write", "build", "generate", "cool", "nice", "awesome", "stuff", "thing",
        "things", "what", "how", "why", "who", "because", "also", "too", "there", "here", "have", "has",
        "had", "get", "gets", "got", "let", "lets", "let's", "thanks", "hello", "hi", "hey", "blah", "okay",
        "ok", "maybe", "sure", "when", "should",
    }
)
_WORD_RE = re.compile(r"[^\W\d_][\w'’]*")
_CAMEL_OR_SNAKE = re.compile(r"(?:[a-z0-9][A-Z])|(?:[A-Za-z0-9]_[A-Za-z0-9])")

INIT_METHODS = frozenset(
    {
        "new", "getinstance", "instance", "init", "initialize", "initialise", "open", "create", "connect",
        "setup", "attach", "spawn", "register", "mount", "load", "boot",
    }
)
_BOOL_WORDS = frozenset(
    {"true", "false", "on", "off", "yes", "no", "enabled", "disabled", "enable", "disable", "active", "inactive"}
)
_TOGGLE_VERBS = frozenset(
    {"turnon", "turnoff", "enabled", "disabled", "enable", "disable", "toggle", "activate", "deactivate", "on", "off"}
)
_TOGGLE_PROPS = frozenset({"on", "enabled", "enable", "active", "activated", "toggled", "switch", "switched"})


@dataclass(frozen=True)
class StaticReport:
    parsed: ParsedSource
    diagnostics: tuple[Diagnostic, ...]

    @property
    def ok(self) -> bool:
        return not self.diagnostics


def _diag(code: ErrorCode, line: int, message: str, related: Iterable[int] = ()) -> Diagnostic:
    return Diagnostic(code=code, line=line, message=message, stage=Stage.STATIC, related=tuple(related))


def _snippet(line: SourceLine, width: int = 60) -> str:
    text = " ".join(line.text.split())
    return text if len(text) <= width else text[: width - 3] + "..."


def check(parsed: ParsedSource, known_symbols: Collection[str] = ()) -> StaticReport:
    """Run every static rule. ``known_symbols`` are names saved in cross-session memory."""
    known = set(known_symbols)
    diagnostics: list[Diagnostic] = []
    diagnostics.extend(_structure(parsed))
    diagnostics.extend(_prompting(parsed))
    diagnostics.extend(_shortcuts(parsed))
    diagnostics.extend(_magic_toggles(parsed, known))
    diagnostics.extend(_execution_order(parsed))
    unique: dict[tuple[str, int, str], Diagnostic] = {}
    for diag in diagnostics:
        unique.setdefault((diag.code.value, diag.line, diag.message), diag)
    ordered = sorted(unique.values(), key=lambda d: (d.line, d.code.value))
    return StaticReport(parsed=parsed, diagnostics=tuple(ordered))


def _structure(parsed: ParsedSource) -> list[Diagnostic]:
    found: list[Diagnostic] = []
    first = next((line for line in parsed.lines if line.kind is not LineKind.BLANK), None)
    if first is None:
        found.append(
            _diag(ErrorCode.MISSING_HEADER, 0, 'the file is empty; start it with # ("what this code builds and how it works")')
        )
        return found
    if first.kind not in (LineKind.HEADER, LineKind.BAD_HEADER):
        found.append(
            _diag(
                ErrorCode.MISSING_HEADER,
                first.number,
                'every IMY file must start with a header line: # ("what this code builds and how it works")',
            )
        )
    for line in parsed.lines:
        if line.kind is LineKind.BAD_HEADER:
            found.append(
                _diag(
                    ErrorCode.MALFORMED_HEADER,
                    line.number,
                    f"{line.header_problem or 'invalid header'} (a line that starts with # is always a header)",
                )
            )
        elif line.kind is LineKind.COMMENT:
            found.append(
                _diag(
                    ErrorCode.COMMENT_IN_SOURCE,
                    line.number,
                    'IMY has no comments; put the description in the # ("...") header and keep the body code-only',
                )
            )
        elif line.is_code and line.unterminated_at is not None:
            found.append(
                _diag(
                    ErrorCode.UNTERMINATED_STRING,
                    line.number,
                    f"the string that starts at column {line.unterminated_at + 1} is never closed",
                )
            )
    for block in parsed.blocks:
        has_code = any(parsed.line(n).is_code for n in range(block.first_line, block.last_line + 1))
        if not has_code:
            found.append(
                _diag(
                    ErrorCode.EMPTY_BODY,
                    block.header_line,
                    "this header has no code under it; code every step the header describes",
                )
            )
    for fn in parsed.functions:
        previous = None
        for number in range(fn.line - 1, 0, -1):
            candidate = parsed.line(number)
            if candidate.kind is not LineKind.BLANK:
                previous = candidate
                break
        if previous is None or previous.kind is not LineKind.HEADER:
            found.append(
                _diag(
                    ErrorCode.MISSING_HEADER,
                    fn.line,
                    f'function block `{fn.name}` needs its own # ("what it builds and how it works") header on the line above it',
                )
            )
    return found


def _has_strong_signal(tokens: Iterable[Token]) -> bool:
    for tok in tokens:
        if tok.kind in ("chain", "member", "open", "close"):
            return True
        if tok.kind == "op" and tok.text in _STRONG_OPS:
            return True
        if tok.kind == "ident" and _CAMEL_OR_SNAKE.search(tok.text):
            return True
    return False


def _word_runs(tokens: Iterable[Token]) -> list[list[str]]:
    runs: list[list[str]] = [[]]
    for tok in tokens:
        if tok.kind == "ident":
            runs[-1].append(tok.text.lower().replace("’", "'"))
        elif runs[-1]:
            runs.append([])
    return [run for run in runs if run]


def _stopword_ratio(words: list[str]) -> float:
    if not words:
        return 0.0
    return sum(1 for w in words if w in _STOPWORDS) / len(words)


def prompting_reason(line: SourceLine) -> str | None:
    """Why this code line reads like a chat request or prose, or None when it reads like code."""
    if line.statement is None:
        return None
    tokens = line.statement.tokens
    visible = line.masked.replace(STRING_MASK, " ")
    words = [w.lower().replace("’", "'") for w in _WORD_RE.findall(visible)]
    if not words:
        return None
    joined = " ".join(words)
    if not _has_strong_signal(tokens):
        if len(words) >= 3 and _REQUEST_RE.search(joined):
            return "this line reads like a request to an assistant"
        weak = bool(line.strings) or any(tok.kind in ("num", "op") for tok in tokens)
        if not weak and len(words) >= 5:
            return "this line is an English sentence with no code structure"
        stop = sum(1 for w in words if w in _STOPWORDS)
        if len(words) >= 5 and stop >= 2 and _stopword_ratio(words) >= 0.34:
            return "this line reads like English prose"
        return None
    for run in _word_runs(tokens):
        if len(run) >= 6 and (_REQUEST_RE.search(" ".join(run)) or _stopword_ratio(run) >= 0.5):
            return "this line hides an English request inside code"
    return None


def _prompting(parsed: ParsedSource) -> list[Diagnostic]:
    found: list[Diagnostic] = []
    for line in parsed.code_lines():
        reason = prompting_reason(line)
        if reason:
            found.append(
                _diag(
                    ErrorCode.PROMPTING_DETECTED,
                    line.number,
                    f'{reason}: "{_snippet(line)}". The body must be code (assignments, calls, operators, blocks); '
                    'say what you are building in the # ("...") header and code every step yourself',
                )
            )
    return found


def _shortcuts(parsed: ParsedSource) -> list[Diagnostic]:
    found: list[Diagnostic] = []
    for shortcut in parsed.shortcuts:
        if shortcut.length > MAX_SHORTCUT_LENGTH:
            found.append(
                _diag(
                    ErrorCode.SHORTCUT_LENGTH_EXCEEDED,
                    shortcut.line,
                    f"`{shortcut.token}` is {shortcut.length} characters; a shortcut may be at most "
                    f"{MAX_SHORTCUT_LENGTH} (dot included) so one command name can't carry a whole request",
                )
            )
    if len(parsed.shortcuts) > MAX_SHORTCUTS:
        listing = ", ".join(f"{s.token} (line {s.line})" for s in parsed.shortcuts)
        found.append(
            _diag(
                ErrorCode.SHORTCUT_LIMIT_EXCEEDED,
                parsed.shortcuts[MAX_SHORTCUTS].line,
                f"{len(parsed.shortcuts)} auto-helper shortcuts in one file: {listing}. IMY allows at most "
                f"{MAX_SHORTCUTS} per file; code the other mechanics yourself",
                related=[s.line for s in parsed.shortcuts],
            )
        )
    return found


def _is_boolean_value(tokens: tuple[Token, ...]) -> str | None:
    meaningful = [tok for tok in tokens if tok.kind not in ("open", "close")]
    if len(meaningful) != 1:
        return None
    tok = meaningful[0]
    if tok.kind == "ident" and tok.text.lower() in _BOOL_WORDS:
        return tok.text
    if tok.kind == "str" and tok.value is not None and tok.value.strip().lower() in _BOOL_WORDS:
        return f'"{tok.value.strip()}"'
    return None


def _toggle_targets(stmt: Statement) -> list[Token]:
    targets: list[Token] = []
    for segment in stmt.segments[:-1]:
        named = [tok for tok in segment if tok.kind in ("ident", "chain")]
        if named:
            targets.append(named[-1])
    return targets


def _defined_names(parsed: ParsedSource, skip: Collection[tuple[int, int]] = ()) -> set[str]:
    """Names the file assigns, plus what those assignments code: `physics.gravity.strength = 9.8`
    codes `physics.gravity`. Toggle assignments (positions in ``skip``) code nothing."""
    names: set[str] = set()
    for line in parsed.code_lines():
        stmt = line.statement
        if stmt is None:
            continue
        if stmt.is_assignment:
            for segment in stmt.segments[:-1]:
                for tok in segment:
                    if tok.kind not in ("ident", "chain") or (line.number, tok.start) in skip:
                        continue
                    names.add(tok.text)
                    parts = tok.text.split(".")
                    for size in range(1, len(parts)):
                        names.add(".".join(parts[:size]))
        if stmt.function_name:
            names.add(stmt.function_name)
    names.update(pack.name for pack in parsed.packs)
    return names


def _magic_toggles(parsed: ParsedSource, known: set[str]) -> list[Diagnostic]:
    found: list[Diagnostic] = []
    toggle_positions: set[tuple[int, int]] = set()
    toggle_lines: list[tuple[SourceLine, Statement, str]] = []
    for line in parsed.code_lines():
        stmt = line.statement
        if stmt is None or not stmt.is_assignment:
            continue
        value = _is_boolean_value(stmt.value_tokens)
        if value is None:
            continue
        toggle_lines.append((line, stmt, value))
        for tok in _toggle_targets(stmt):
            toggle_positions.add((line.number, tok.start))

    reads: dict[str, set[int]] = {}
    for line in parsed.code_lines():
        stmt = line.statement
        if stmt is None:
            continue
        for tok in stmt.tokens:
            if (line.number, tok.start) in toggle_positions:
                continue
            names: list[str] = []
            if tok.kind == "ident":
                names.append(tok.text)
            elif tok.kind in ("chain", "member"):
                names.extend(tok.parts)
            elif tok.kind == "str" and tok.value:
                names.append(tok.value.strip())
            for name in names:
                reads.setdefault(name, set()).add(line.number)

    defined = _defined_names(parsed, toggle_positions)
    for line, stmt, value in toggle_lines:
        for tok in _toggle_targets(stmt):
            if tok.kind == "ident":
                name = tok.text
                if name in known or reads.get(name):
                    continue
                found.append(
                    _diag(
                        ErrorCode.MISSING_MECHANICS,
                        line.number,
                        f"`{name} = {value}` is a magic toggle: nothing in this file reads `{name}` or codes what "
                        "it does. Code the real mechanics (instances, hooks, state variables, math, key bindings, "
                        "assets, positions) instead of switching a feature on by name",
                    )
                )
            else:
                parts = tok.parts
                prefix = ".".join(parts[:-1])
                if parts[-1].lower() in _TOGGLE_PROPS and prefix not in defined and prefix not in known:
                    found.append(
                        _diag(
                            ErrorCode.MISSING_MECHANICS,
                            line.number,
                            f"`{tok.text} = {value}` switches `{prefix}` on by name, but nothing in this file codes "
                            f"`{prefix}`. Code its mechanics step by step",
                        )
                    )

    for line in parsed.code_lines():
        stmt = line.statement
        if stmt is None or stmt.is_assignment or stmt.function_name:
            continue
        meaningful = list(stmt.tokens)
        if len(meaningful) >= 2 and meaningful[-1].text == ")" and meaningful[-2].text == "(":
            meaningful = meaningful[:-2]
        if not meaningful:
            continue
        last = meaningful[-1]
        if last.kind not in ("chain", "member"):
            continue
        parts = last.parts
        if len(parts) < 2 or parts[-1].lower() not in _TOGGLE_VERBS:
            continue
        prefix = ".".join(parts[:-1])
        root = parts[0]
        if prefix in defined or prefix in known:
            continue
        if len(parts) == 2 and (root in defined or root in known):
            continue
        found.append(
            _diag(
                ErrorCode.MISSING_MECHANICS,
                line.number,
                f"`{last.text}` turns `{prefix}` {parts[-1]} by name, but nothing in this file codes `{prefix}`. "
                "Code its mechanics step by step instead of a magic toggle",
            )
        )
    return found


def _is_action(stmt: Statement | None) -> bool:
    """A line that works on an object (`World.detect(walls)`, `gallery.count`) and so may
    depend on a hook installed later. Plain calls such as `show ("starting")`, assignments,
    function blocks and set-up calls (`Client.getInstance()`, `World.connect()`) are not."""
    if stmt is None or stmt.is_assignment or stmt.function_name or stmt.shortcuts:
        return False
    return any(chain.split(".")[-1].lower() not in INIT_METHODS for chain in stmt.chains)


def _execution_order(parsed: ParsedSource) -> list[Diagnostic]:
    """Use before definition, inside this file only. A name saved in memory does not excuse
    it: a file that defines a name itself is compiled with its own definition, so a line
    above that definition has nothing to use."""
    found: list[Diagnostic] = []
    first_def = parsed.first_definitions()
    pack_lines: dict[str, int] = {}
    for pack in parsed.packs:
        pack_lines.setdefault(pack.name.casefold(), pack.line)
    reported: set[tuple[str, int]] = set()

    for line in parsed.code_lines():
        stmt = line.statement
        if stmt is None or line.in_function or stmt.function_name:
            continue
        refs: list[tuple[str, str]] = [(name, "uses") for name in stmt.operand_refs]
        for call in stmt.calls:
            if not (call.method is None and call.root.lower() in CONTROL_WORDS):
                refs.append((call.root, "calls"))
            refs.extend((arg, "passes") for arg in call.args)
        for shortcut in stmt.shortcuts:
            if shortcut.receiver:
                refs.append((shortcut.receiver.split(".")[0], "hooks"))
        for name, verb in refs:
            def_line = first_def.get(name)
            if def_line is None or def_line <= line.number or (name, line.number) in reported:
                continue
            reported.add((name, line.number))
            found.append(
                _diag(
                    ErrorCode.EXECUTION_ORDER_VIOLATION,
                    line.number,
                    f"line {line.number} {verb} `{name}` before line {def_line} defines it. IMY never reorders "
                    f"code: move the definition of `{name}` above line {line.number}",
                    related=[def_line],
                )
            )
        for tok in stmt.tokens:
            if tok.kind != "str" or not tok.value:
                continue
            folded = tok.value.strip().casefold()
            pack_line = pack_lines.get(folded)
            if pack_line is None or pack_line <= line.number:
                continue
            key = ("pack:" + folded, line.number)
            if key in reported:
                continue
            reported.add(key)
            found.append(
                _diag(
                    ErrorCode.EXECUTION_ORDER_VIOLATION,
                    line.number,
                    f'line {line.number} uses the variable pack "{tok.value.strip()}" before line {pack_line} '
                    "declares it. IMY never reorders code: declare the pack first",
                    related=[pack_line],
                )
            )

    for shortcut in parsed.shortcuts:
        if parsed.line(shortcut.line).in_function:
            continue
        for line in parsed.code_lines():
            if line.number >= shortcut.line:
                break
            if line.in_function or not _is_action(line.statement):
                continue
            key = ("shortcut:" + shortcut.token, line.number)
            if key in reported:
                continue
            reported.add(key)
            found.append(
                _diag(
                    ErrorCode.EXECUTION_ORDER_VIOLATION,
                    line.number,
                    f"line {line.number} runs `{_snippet(line)}` before the `{shortcut.token}` shortcut on line "
                    f"{shortcut.line} sets up what it depends on. IMY never reorders code: move line "
                    f"{shortcut.line} above line {line.number}",
                    related=[shortcut.line],
                )
            )
    return found
