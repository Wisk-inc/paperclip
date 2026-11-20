"""Deterministic checks on what the model returned, before anything runs.

* strips markdown fences and chat prose around the code
* proves the code holds zero comments (language-aware: strings are skipped)
* Python: the code must parse; docstrings and bare strings count as comments
* websites: no invented styling, assets or text (everything must come from the IMY code)
* every message string from the IMY code survives character for character
"""

from __future__ import annotations

import ast
import html
import io
import json
import re
import tokenize
from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import unquote

from .errors import Diagnostic, ErrorCode, Stage
from .languages import CommentSyntax, Language, resolve_language
from .parser import URL_PATTERN, ParsedSource

_CHAR_LITERAL = re.compile(r"'(?:\\(?:x[0-9A-Fa-f]{1,8}|u\{?[0-9A-Fa-f]{1,8}\}?|.)|[^'\\\n])'")
_RUST_RAW = re.compile(r'b?r(#*)"')
_LUA_LONG = re.compile(r"\[(=*)\[")
_FENCE = re.compile(r"^```[^\n`]*\n(.*?)^```[ \t]*$", re.DOTALL | re.MULTILINE)
_CHAT_LINE = re.compile(
    r"^(?:here(?:'s| is| are)\b|sure\b|certainly\b|of course\b|below is\b|the (?:above|following) "
    r"(?:code|program|script)\b|this (?:code|program|script)\b|i(?:'ve| have)\b|note\b|explanation\b|output\b)",
    re.IGNORECASE,
)
_CODE_CHARS = set("=(){}[];<>")
_STYLE_WORDS = frozenset(
    {
        "style", "styles", "styled", "styling", "css", "color", "colour", "colors", "colours", "font", "fonts",
        "theme", "themes", "background", "bg", "margin", "padding", "border", "bold", "italic", "underline",
        "animation", "animate", "animated", "transition", "class", "classes", "width", "height", "size", "align",
        "center", "centre", "layout", "grid", "flex", "shadow", "rounded", "radius", "opacity", "gradient",
    }
)
_LEGACY_STYLE_ATTRS = ("bgcolor", "color", "background", "face")


@dataclass(frozen=True)
class CommentHit:
    line: int
    column: int
    text: str


@dataclass
class OutputCheck:
    code: str
    diagnostics: list[Diagnostic] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.diagnostics


def clean_output(raw: str) -> tuple[str, list[str]]:
    """Remove markdown fences and chat prose around the code."""
    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    notes: list[str] = []
    fenced = _FENCE.search(text)
    if fenced:
        outside = (text[: fenced.start()] + text[fenced.end() :]).strip()
        text = fenced.group(1)
        notes.append("removed a markdown code fence" + (" and the prose around it" if outside else ""))
    else:
        lines = text.split("\n")
        while lines and _is_chat_line(lines[0]):
            notes.append(f"removed a prose line: {lines[0].strip()[:60]}")
            lines.pop(0)
        while lines and _is_chat_line(lines[-1]):
            notes.append(f"removed a prose line: {lines[-1].strip()[:60]}")
            lines.pop()
        text = "\n".join(lines)
    text = text.strip("\n")
    return (text + "\n" if text else ""), notes


def _is_chat_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    if any(ch in _CODE_CHARS for ch in stripped):
        return False
    return bool(_CHAT_LINE.match(stripped)) and stripped[-1] in ":.!"


def _at_line_start(code: str, index: int, line_start: int) -> bool:
    return code[line_start:index].strip() == ""


def _regex_allowed(code: str, index: int) -> bool:
    j = index - 1
    while j >= 0 and code[j] in " \t":
        j -= 1
    if j < 0 or code[j] == "\n":
        return True
    if code[j] in "(,=:[!&|?{};+-*%<>~^":
        return True
    word = re.search(r"([A-Za-z_]+)$", code[: j + 1])
    return bool(word and word.group(1) in {"return", "typeof", "case", "in", "of", "delete", "void", "throw"})


def scan_comments(code: str, syntax: CommentSyntax, *, line_offset: int = 0) -> list[CommentHit]:
    """Find comments in code, skipping strings, characters, raw strings and regex literals."""
    hits: list[CommentHit] = []
    n = len(code)
    i = 0
    line = 1 + line_offset
    line_start = 0

    def advance_to(target: int) -> None:
        nonlocal i, line, line_start
        segment_newlines = code.count("\n", i, target)
        if segment_newlines:
            line += segment_newlines
            line_start = code.rfind("\n", i, target) + 1
        i = target

    def end_of_line(start: int) -> int:
        stop = code.find("\n", start)
        return n if stop == -1 else stop

    while i < n:
        ch = code[i]
        if ch == "\n":
            line += 1
            i += 1
            line_start = i
            continue

        if syntax.line_start_blocks and _at_line_start(code, i, line_start):
            matched = False
            for start, end in syntax.line_start_blocks:
                if code.startswith(start, i):
                    hits.append(CommentHit(line, i - line_start, code[i:end_of_line(i)][:80]))
                    search = re.compile(rf"^[ \t]*{re.escape(end)}.*$", re.MULTILINE)
                    found = search.search(code, end_of_line(i))
                    advance_to(found.end() if found else n)
                    matched = True
                    break
            if matched:
                continue

        if syntax.lua_long and code.startswith("--[", i):
            long_open = _LUA_LONG.match(code, i + 2)
            if long_open:
                close = "]" + long_open.group(1) + "]"
                stop = code.find(close, long_open.end())
                hits.append(CommentHit(line, i - line_start, code[i:end_of_line(i)][:80]))
                advance_to(n if stop == -1 else stop + len(close))
                continue

        matched_block = False
        for start, end in syntax.block:
            if code.startswith(start, i):
                stop = code.find(end, i + len(start))
                hits.append(CommentHit(line, i - line_start, code[i:end_of_line(i)][:80]))
                advance_to(n if stop == -1 else stop + len(end))
                matched_block = True
                break
        if matched_block:
            continue

        matched_line = False
        for marker in syntax.line:
            if not code.startswith(marker, i):
                continue
            if marker == "#" and syntax.hash_word_start and i > line_start and code[i - 1] not in " \t;&|(":
                continue
            if marker == "#" and syntax.php_attributes and code.startswith("#[", i):
                continue
            hits.append(CommentHit(line, i - line_start, code[i:end_of_line(i)][:80]))
            advance_to(end_of_line(i))
            matched_line = True
            break
        if matched_line:
            continue

        if syntax.line_start_only and _at_line_start(code, i, line_start):
            starts = [m for m in syntax.line_start_only if code.startswith(m, i)]
            if starts:
                hits.append(CommentHit(line, i - line_start, code[i:end_of_line(i)][:80]))
                advance_to(end_of_line(i))
                continue

        if syntax.rust_raw and ch in "rb" and (i == 0 or not (code[i - 1].isalnum() or code[i - 1] == "_")):
            raw = _RUST_RAW.match(code, i)
            if raw:
                close = '"' + raw.group(1)
                stop = code.find(close, raw.end())
                advance_to(n if stop == -1 else stop + len(close))
                continue

        if syntax.lua_long and ch == "[":
            long_open = _LUA_LONG.match(code, i)
            if long_open:
                close = "]" + long_open.group(1) + "]"
                stop = code.find(close, long_open.end())
                advance_to(n if stop == -1 else stop + len(close))
                continue

        if syntax.triple_strings and (code.startswith('"""', i) or code.startswith("'''", i)):
            quote = code[i : i + 3]
            stop = code.find(quote, i + 3)
            advance_to(n if stop == -1 else stop + 3)
            continue

        if ch == "'" and syntax.char_literals and "'" not in syntax.strings:
            literal = _CHAR_LITERAL.match(code, i)
            advance_to(literal.end() if literal else i + 1)
            continue

        if ch in syntax.strings:
            j = i + 1
            while j < n and code[j] != ch and code[j] != "\n":
                j += 2 if code[j] == "\\" else 1
            advance_to(min(j + 1, n) if j < n and code[j] == ch else j)
            continue

        if ch == "`" and syntax.backtick_strings:
            j = i + 1
            while j < n and code[j] != "`":
                j += 2 if (code[j] == "\\" and not syntax.raw_backticks) else 1
            advance_to(min(j + 1, n))
            continue

        if ch == "/" and syntax.regex_literals and not code.startswith("//", i) and not code.startswith("/*", i):
            if _regex_allowed(code, i):
                j = i + 1
                in_class = False
                while j < n and code[j] != "\n":
                    cj = code[j]
                    if cj == "\\":
                        j += 2
                        continue
                    if cj == "[":
                        in_class = True
                    elif cj == "]":
                        in_class = False
                    elif cj == "/" and not in_class:
                        break
                    j += 1
                if j < n and code[j] == "/":
                    advance_to(j + 1)
                    continue
        i += 1
    return hits


def python_problems(code: str) -> tuple[list[CommentHit], list[tuple[int, str]]]:
    """Comments (incl. docstrings and bare strings) and syntax errors in Python code."""
    hits: list[CommentHit] = []
    errors: list[tuple[int, str]] = []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(code).readline):
            if tok.type == tokenize.COMMENT:
                hits.append(CommentHit(tok.start[0], tok.start[1], tok.string[:80]))
    except (tokenize.TokenError, SyntaxError) as exc:
        lineno = exc.args[1][0] if isinstance(exc, tokenize.TokenError) and len(exc.args) > 1 else getattr(exc, "lineno", 0)
        errors.append((int(lineno or 0), f"Python can't read the code: {exc.args[0] if exc.args else exc}"))
    offset = 0
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        errors.append((exc.lineno or 0, f"Python syntax error: {exc.msg}"))
        wrapped = "async def _imy_fragment():\n" + "".join(f"    {line}\n" for line in code.split("\n"))
        try:
            tree = ast.parse(wrapped)
        except SyntaxError:
            return hits, errors
        offset = 1
    for node in ast.walk(tree):
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            hits.append(CommentHit(node.lineno - offset, node.col_offset, "docstring or bare string used as a comment"))
    return hits, errors


class _HtmlScan(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.comments: list[CommentHit] = []
        self.styles: list[tuple[int, str]] = []
        self.assets: list[tuple[int, str, str, str]] = []
        self.texts: list[tuple[int, str]] = []
        self.embedded: list[tuple[str, int, str]] = []
        self._raw_tag: str | None = None
        self._raw_line = 0
        self._raw: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        line = self.getpos()[0]
        values = {key.lower(): (value or "") for key, value in attrs}
        if tag in ("script", "style"):
            self._raw_tag = tag
            self._raw_line = line
            self._raw = []
        if tag == "style":
            self.styles.append((line, "a <style> block"))
        if tag == "font":
            self.styles.append((line, "a <font> tag"))
        if "style" in values:
            self.styles.append((line, f'style="{values["style"][:40]}" on <{tag}>'))
        if values.get("class"):
            self.styles.append((line, f'class="{values["class"][:40]}" on <{tag}>'))
        for attr in _LEGACY_STYLE_ATTRS:
            if values.get(attr) and tag not in ("img", "input"):
                self.styles.append((line, f'{attr}="{values[attr][:30]}" on <{tag}>'))
        if tag == "link":
            rel = values.get("rel", "").lower()
            href = values.get("href", "")
            if "stylesheet" in rel:
                self.styles.append((line, f"a stylesheet link ({href})"))
            elif href and ("icon" in rel or "preload" in rel or "manifest" in rel):
                self.assets.append((line, "link", "href", href))
        if tag in ("img", "source", "video", "audio", "embed", "iframe", "track", "input", "object"):
            for key in ("src", "poster", "srcset", "data"):
                if values.get(key) and not (tag == "input" and values.get("type", "").lower() != "image"):
                    self.assets.append((line, tag, key, values[key]))
        if tag == "svg":
            self.assets.append((line, "svg", "", "an inline <svg> graphic"))
        for key in ("alt", "title", "aria-label", "placeholder"):
            if values.get(key):
                self.texts.append((line, values[key]))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag in ("script", "style"):
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        if tag == self._raw_tag:
            self.embedded.append((tag, self._raw_line, "".join(self._raw)))
            self._raw_tag = None
            self._raw = []

    def handle_data(self, data: str) -> None:
        if self._raw_tag is not None:
            self._raw.append(data)
            return
        if data.strip():
            self.texts.append((self.getpos()[0], data))

    def handle_comment(self, data: str) -> None:
        self.comments.append(CommentHit(self.getpos()[0], self.getpos()[1], f"<!--{data[:60]}-->"))

    def unknown_decl(self, data: str) -> None:
        lowered = data.strip().lower()
        if lowered.startswith("if") or lowered.startswith("endif"):
            self.comments.append(CommentHit(self.getpos()[0], self.getpos()[1], f"<![{data[:40]}]>"))


def scan_html(code: str) -> _HtmlScan:
    scanner = _HtmlScan()
    scanner.feed(code)
    scanner.close()
    if scanner._raw_tag is not None:
        scanner.embedded.append((scanner._raw_tag, scanner._raw_line, "".join(scanner._raw)))
    js = resolve_language("javascript").comments
    css = resolve_language("css").comments
    for tag, line, content in scanner.embedded:
        syntax = js if tag == "script" else css
        scanner.comments.extend(scan_comments(content, syntax, line_offset=line - 1))
    return scanner


def find_comments(code: str, language: Language) -> list[CommentHit]:
    if language.name == "python":
        return python_problems(code)[0]
    if language.name == "html":
        return scan_html(code).comments
    return scan_comments(code, language.comments)


def _source_vocabulary(parsed: ParsedSource) -> set[str]:
    words: set[str] = set()
    for line in parsed.code_lines():
        stmt = line.statement
        for literal in line.strings:
            words.update(w.casefold() for w in re.findall(r"[^\W_]+", literal.value))
        if stmt is None:
            continue
        for tok in stmt.tokens:
            if tok.kind in ("ident", "chain", "member", "num"):
                words.update(w.casefold() for w in re.findall(r"[^\W_]+", tok.text))
    return words


def _source_references(parsed: ParsedSource) -> set[str]:
    refs: set[str] = set()
    for line in parsed.code_lines():
        for literal in line.strings:
            value = literal.value.strip()
            if value:
                refs.add(value.casefold())
                refs.add(value.rsplit("/", 1)[-1].casefold())
        if line.statement is None:
            continue
        for tok in line.statement.tokens:
            if tok.kind == "chain":
                refs.add(tok.text.casefold())
    return refs


def _check_html(code: str, parsed: ParsedSource, scanner: _HtmlScan) -> list[Diagnostic]:
    found: list[Diagnostic] = []
    vocabulary = _source_vocabulary(parsed)
    styling_coded = bool(vocabulary & _STYLE_WORDS)
    if not styling_coded:
        for line, what in scanner.styles:
            found.append(
                Diagnostic(
                    ErrorCode.INVENTED_STYLING,
                    line,
                    f"the page adds styling the IMY code never defines: {what}",
                    stage=Stage.OUTPUT,
                )
            )
    references = _source_references(parsed)
    for line, tag, attribute, url in scanner.assets:
        if tag == "svg":
            if "svg" not in vocabulary:
                found.append(
                    Diagnostic(ErrorCode.INVENTED_ASSET, line, "the page adds an inline <svg> graphic the IMY code never names", stage=Stage.OUTPUT)
                )
            continue
        if attribute == "srcset":
            candidates = [part.split()[0] for part in url.split(",") if part.split()]
        else:
            candidates = [url.strip()]
        for candidate in candidates:
            if not candidate:
                continue
            decoded = unquote(candidate).strip()
            name = decoded.rsplit("/", 1)[-1].casefold()
            if decoded.casefold() in references or name in references:
                continue
            found.append(
                Diagnostic(
                    ErrorCode.INVENTED_ASSET,
                    line,
                    f'the page uses "{decoded[:80]}" on <{tag}>, which the IMY code never names',
                    stage=Stage.OUTPUT,
                )
            )
    for line, text in scanner.texts:
        words = re.findall(r"[^\W_]+", text)
        missing = [w for w in words if w.casefold() not in vocabulary]
        if missing:
            shown = ", ".join(dict.fromkeys(missing[:6]))
            found.append(
                Diagnostic(
                    ErrorCode.INVENTED_CONTENT,
                    line,
                    f"the page shows words the IMY code never wrote: {shown}",
                    stage=Stage.OUTPUT,
                )
            )
    return found


def _is_message(value: str) -> bool:
    stripped = value.strip()
    if " " not in stripped or sum(ch.isalpha() for ch in stripped) < 2:
        return False
    return not URL_PATTERN.match(stripped)


def _check_messages(code: str, parsed: ParsedSource, haystack_extra: str = "") -> list[Diagnostic]:
    found: list[Diagnostic] = []
    virtual = {v.path for v in parsed.virtual_paths}
    haystack = code + "\n" + haystack_extra
    for line, value in parsed.string_values():
        if value in virtual or not _is_message(value):
            continue
        candidates = {value, value.strip(), json.dumps(value)[1:-1], html.escape(value, quote=False)}
        if any(candidate and candidate in haystack for candidate in candidates):
            continue
        items = [item.strip() for item in value.split(",") if item.strip()]
        if len(items) > 1 and all(item in haystack for item in items):
            continue
        found.append(
            Diagnostic(
                ErrorCode.MESSAGE_NOT_PRESERVED,
                line,
                f'the compiled code lost the exact message "{value.strip()[:80]}" (it must appear character for character)',
                stage=Stage.LLM,
            )
        )
    return found


def check_output(raw_code: str, language: Language, parsed: ParsedSource, *, fragment: bool = False) -> OutputCheck:
    """Clean the model's code and run every deterministic output rule on it.

    ``fragment`` marks a snippet for repository injection: it can't be parsed on
    its own (a Python ``return`` outside its function), so its syntax is checked
    after it is spliced into the file.
    """
    code, notes = clean_output(raw_code)
    result = OutputCheck(code=code, notes=notes)
    if not code.strip():
        result.diagnostics.append(
            Diagnostic(ErrorCode.INVALID_OUTPUT, 0, "the model returned no code", stage=Stage.OUTPUT)
        )
        return result
    extra_text = ""
    if language.name == "python":
        hits, errors = python_problems(code)
        if not fragment:
            for line, message in errors:
                result.diagnostics.append(Diagnostic(ErrorCode.INVALID_OUTPUT, line, message, stage=Stage.OUTPUT))
    elif language.name == "html":
        scanner = scan_html(code)
        hits = scanner.comments
        result.diagnostics.extend(_check_html(code, parsed, scanner))
        extra_text = "\n".join(text for _, text in scanner.texts)
    else:
        hits = scan_comments(code, language.comments)
    for hit in hits[:25]:
        result.diagnostics.append(
            Diagnostic(
                ErrorCode.COMMENTS_IN_OUTPUT,
                hit.line,
                f"the compiled code contains a comment ({hit.text.strip()[:60]!r}); IMY output must have zero comments",
                stage=Stage.OUTPUT,
            )
        )
    result.diagnostics.extend(_check_messages(code, parsed, extra_text))
    return result
