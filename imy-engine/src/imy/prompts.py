"""The strict compiler prompt and the JSON contract every model must return."""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from .errors import ErrorCode
from .memory import MemorySymbol, SymbolKind
from .parser import ParsedSource

PROMPT_VERSION = "imy-compiler-2"

# The six codes the model is asked for (the contract and the JSON schema).
LLM_ERROR_CODES: tuple[str, ...] = (
    "ExecutionOrderViolation",
    "MissingMechanics",
    "HeaderMismatch",
    "AmbiguousIntent",
    "PromptingDetected",
    "ShortcutViolation",
)
# Also understood when a model names one of IMY's own rules more precisely, or writes a
# code in another letter case ("missing_mechanics"). Anything else is sent back for repair.
ACCEPTED_ERROR_CODES: tuple[str, ...] = LLM_ERROR_CODES + (
    ErrorCode.MISSING_HEADER.value,
    ErrorCode.MALFORMED_HEADER.value,
    ErrorCode.EMPTY_BODY.value,
    ErrorCode.COMMENT_IN_SOURCE.value,
    ErrorCode.UNTERMINATED_STRING.value,
    ErrorCode.SHORTCUT_LIMIT_EXCEEDED.value,
    ErrorCode.SHORTCUT_LENGTH_EXCEEDED.value,
)
_CODE_BY_LETTERS: dict[str, str] = {re.sub(r"[^a-z]", "", code.lower()): code for code in ACCEPTED_ERROR_CODES}
_KIND_BY_LETTERS: dict[str, str] = {
    **{re.sub(r"[^a-z]", "", kind.value): kind.value for kind in SymbolKind},
    "pack": SymbolKind.VARIABLE_PACK.value,
    "variablepack": SymbolKind.VARIABLE_PACK.value,
    "constant": SymbolKind.VARIABLE.value,
    "const": SymbolKind.VARIABLE.value,
    "var": SymbolKind.VARIABLE.value,
    "method": SymbolKind.FUNCTION.value,
    "procedure": SymbolKind.FUNCTION.value,
    "syntax": SymbolKind.SYNTAX_RULE.value,
    "rule": SymbolKind.SYNTAX_RULE.value,
    "keyword": SymbolKind.SYNTAX_RULE.value,
    "path": SymbolKind.VIRTUAL_PATH.value,
    "file": SymbolKind.VIRTUAL_PATH.value,
}


class CompilerErrorItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    code: str
    line: int = Field(default=0, ge=0)
    message: str = Field(min_length=1, max_length=4000)

    @field_validator("code", mode="before")
    @classmethod
    def _known_code(cls, value: Any) -> Any:
        if isinstance(value, str):
            known = _CODE_BY_LETTERS.get(re.sub(r"[^a-z]", "", value.lower()))
            if known is not None:
                return known
        raise ValueError("code must be one of " + ", ".join(LLM_ERROR_CODES))

    @field_validator("line", mode="before")
    @classmethod
    def _whole_file_when_missing(cls, value: Any) -> Any:
        if value is None or (isinstance(value, str) and not value.strip()):
            return 0
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value < 0:
            return 0
        return value


class ExtractedSymbol(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str = Field(min_length=1, max_length=200)
    kind: SymbolKind
    meaning: str = Field(min_length=1, max_length=4000)
    source_fragment: str = Field(default="", max_length=20000)


def _usable_symbols(value: Any) -> Any:
    """Keep the symbols that can be saved; one malformed entry must not sink a good program."""
    if not isinstance(value, list):
        return []
    usable: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        name, meaning, kind = item.get("name"), item.get("meaning"), item.get("kind")
        if not (isinstance(name, str) and name.strip() and isinstance(meaning, str) and meaning.strip()):
            continue
        if not isinstance(kind, str):
            continue
        known = _KIND_BY_LETTERS.get(re.sub(r"[^a-z]", "", kind.lower()))
        if known is None:
            continue
        fragment = item.get("source_fragment")
        usable.append(
            {
                "name": name.strip()[:200],
                "kind": known,
                "meaning": meaning.strip()[:4000],
                "source_fragment": fragment[:20000] if isinstance(fragment, str) else "",
            }
        )
    return usable


class CompilerResponse(BaseModel):
    """The JSON object the model must return."""

    model_config = ConfigDict(extra="ignore")

    status: Literal["ok", "error"]
    errors: list[CompilerErrorItem] = Field(default_factory=list)
    extracted_symbols: list[ExtractedSymbol] = Field(default_factory=list)
    target_language: str
    compiled_code: str = ""

    @field_validator("extracted_symbols", mode="before")
    @classmethod
    def _keep_usable_symbols(cls, value: Any) -> Any:
        return _usable_symbols(value)

    @field_validator("errors", mode="before")
    @classmethod
    def _errors_list(cls, value: Any) -> Any:
        return [] if value is None else value

    @field_validator("compiled_code", mode="before")
    @classmethod
    def _code_text(cls, value: Any) -> Any:
        return "" if value is None else value

    @model_validator(mode="after")
    def _consistent(self) -> CompilerResponse:
        if self.status == "ok" and self.errors:
            raise ValueError('status "ok" must come with an empty errors list')
        if self.status == "error" and not self.errors:
            raise ValueError('status "error" needs at least one entry in errors')
        if self.status == "ok" and not self.compiled_code.strip():
            raise ValueError('status "ok" needs the program in compiled_code')
        return self


RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["ok", "error"]},
        "errors": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "code": {"type": "string", "enum": list(LLM_ERROR_CODES)},
                    "line": {"type": "integer"},
                    "message": {"type": "string"},
                },
                "required": ["code", "line", "message"],
                "additionalProperties": False,
            },
        },
        "extracted_symbols": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "kind": {"type": "string", "enum": [kind.value for kind in SymbolKind]},
                    "meaning": {"type": "string"},
                    "source_fragment": {"type": "string"},
                },
                "required": ["name", "kind", "meaning", "source_fragment"],
                "additionalProperties": False,
            },
        },
        "target_language": {"type": "string"},
        "compiled_code": {"type": "string"},
    },
    "required": ["status", "errors", "extracted_symbols", "target_language", "compiled_code"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """You are the IMY compiler. IMY (Imagenery) is a strict, syntax-agnostic blueprint language: people invent their own syntax, variable names and variable packs, and they must code every mechanic themselves. You validate one IMY program and compile it into the requested target language. You are a compiler, not a chat assistant: you never add features, never explain and never chat.

VALIDATION RULES (check every line from top to bottom, report every violation you find, then stop)
1. Header contract. Each block starts with # ("..."), which says what the code builds and how it works. The header only guides how you read the code. Implement only what the code lines define. Never add a feature, screen, asset, style or behaviour that appears only in the header. If a code line contradicts its header, report HeaderMismatch on that line.
2. Code only. A body line written as an English request or sentence instead of code is PromptingDetected.
3. Shortcuts. A file may use at most one auto-helper shortcut (.auto...), at most 20 characters long. A shortcut may stand only for the single narrow helper step its name states (for example .autohook installs one hook). If a shortcut stands in for a whole feature or for several mechanics, report ShortcutViolation.
4. Explicit mechanics. High-level toggles or one-word features with no coded mechanics (Feature = True, thing.feature.on) are MissingMechanics. The user must code the real mechanics: instances, hooks, state variables, math and velocity changes, key bindings, assets, animations and positions. If finishing the program would need behaviour the code does not define, report MissingMechanics and name exactly what is missing. The target language's own boilerplate is always your job and never a missing mechanic: imports, entry points, type declarations, and for a website the document skeleton and the HTML elements that show what the code defines. Missing styling is never missing mechanics: render the bare, unstyled element.
5. Strict order. Code runs top to bottom exactly as written. If a line needs, at run time, a hook, instance, variable or variable pack that a later line creates or initialises (it calls it, reads its value or hooks into it), report ExecutionOrderViolation citing both line numbers. Never reorder the code and never fix it yourself. A blueprint line that only names a part a later line fills in (a page structure naming its menu) needs nothing at run time and is not a violation.
6. Ambiguity. If a line's meaning stays genuinely unclear after reading the header, the surrounding code and the saved memory, do not guess: report AmbiguousIntent naming the line and asking the user to sharpen the code or the header. Report it only when two genuinely different programs could result, never because the syntax is invented: invented syntax is what IMY is for.

READING CUSTOM SYNTAX
- Any word can be a user variable, including words such as if, then, from or name: `if = menu.home page.structure` binds the name `if` to the home page structure of the menu. IMY lines are never English grammar, so `x = y` always binds x to y.
- Chop compound tokens into logical pieces and map a meaning to each piece. A dotted chain such as menu.home, page.structure, web.structure.home or extract.font123 is a custom syntax name: read each piece by its plain meaning and combine them. It refers to an object only when an earlier line creates that object.
- Read verbs and nouns by their plain meaning: `call image "menu logo.png"` shows the image file menu logo.png, `options "home, game, play"` lists the options home, game and play, and `show (...)` prints or displays.
- A chain such as A = B = C = name variablepack = "XYZ" groups A, B and C into the variable pack XYZ. Pack names match without regard to case.
- ship ("...") declares a virtual path. Use the real location listed under VIRTUAL PATHS wherever the program touches that path.
- A URL in a string is a web resource. A mirrored resource is downloaded before the program runs: read the local copy listed under WEB RESOURCES. Other URLs may be fetched at run time with the target language's standard library.
- Definitions under MEMORY were saved from the user's earlier sessions. They are authoritative: use them exactly as saved and never redefine them.
- When the code calls something it never defines and memory does not define (for example show, count or Folder.open), map it to the closest standard construct of the target language only when its meaning is unambiguous from the call, its arguments and the header. Otherwise report AmbiguousIntent.

WORKED EXAMPLES
- A valid website blueprint, which compiles:
    1 # ("creates the home page directory with menus and logos for each")
    2 if = menu.home page.structure
    3 menu = options "home, game, play"
    4 call image "menu logo.png"
  Line 2 names the home page structure, line 3 fills its menu with three options and line 4 shows the image file menu logo.png. Line 2 needs nothing at run time, so there is no order violation and nothing is ambiguous. The output is a page whose menu offers home, game and play, followed by <img src="menu logo.png" alt="menu logo">.
- A real order violation: line 2 `total = price * 2` reads price before line 3 `price = 5` sets it. Report ExecutionOrderViolation on line 2, citing line 3.
- A feature that exists only in the header: # ("home page with a cool logo") over `page = "arcade stuff"`. No logo file is named, so output a bare page that shows arcade stuff, or report MissingMechanics for the logo. Never invent a logo.

OUTPUT RULES FOR compiled_code
- Zero comments of any kind: no #, //, /* */, <!-- -->, -- or docstrings, and no string literals used as comments. Zero prose. Only code.
- Preserve the user's layout: the same order, one target statement per IMY line wherever the target language allows, the same block structure, the same names (change a name only when the target language forbids it) and every string message character for character.
- Produce a complete program that runs as it is: include the imports and the entry point the target language needs, use only the standard library unless the IMY code names a library, and read input only when the IMY code asks for input.

RESPONSE FORMAT
Reply with exactly one JSON object and nothing else:
{"status": "ok" or "error", "errors": [{"code": "...", "line": <IMY line number>, "message": "..."}], "extracted_symbols": [{"name": "...", "kind": "variable_pack" or "variable" or "function" or "syntax_rule" or "virtual_path", "meaning": "...", "source_fragment": "..."}], "target_language": "<target>", "compiled_code": "..."}
- status "ok": errors is [] and compiled_code holds the whole program.
- status "error": errors lists every violation with the IMY line number from the numbered listing (0 for the whole file) and a specific explanation of what is missing, ambiguous or out of order; compiled_code is "".
- Error codes: ExecutionOrderViolation, MissingMechanics, HeaderMismatch, AmbiguousIntent, PromptingDetected, ShortcutViolation.
- extracted_symbols lists every variable, variable pack, function, custom syntax rule and virtual path the user defined or used, with its exact meaning and the original IMY fragment."""

WEB_RULES = """STRICT WEBSITE RULES
- Render strictly line for line what the IMY code defines, in the same order.
- No <style> blocks, style attributes, class names, colours, fonts, themes, layouts, animations, transitions or scripts unless the IMY code defines them.
- No images, icons, logos, favicons or SVG graphics unless the IMY code names the file or URL; use exactly the file name the code gives.
- Every visible word must come from the IMY code. Add no titles, headings, footers, placeholder text or copyright lines of your own.
- If the code describes styling or an asset without defining it (for example a "cool logo" with no file), either report MissingMechanics naming what is missing or output only the bare unstyled structure the code defines, showing its literal text.
- Output a complete minimal document: <!DOCTYPE html>, <html>, a <head> holding only <meta charset="utf-8">, and a <body>."""

TARGET_NOTES: dict[str, str] = {
    "python": "Python 3.11 or newer. Top-level statements run in order.",
    "javascript": "Node.js 20 or newer, one CommonJS file run with node. Print with console.log.",
    "typescript": "TypeScript that runs with node --experimental-strip-types: no enums, namespaces or parameter properties.",
    "java": "Java 17 or newer, run as a single source file: one public class named Main with public static void main(String[] args) and no package line.",
    "kotlin": "Kotlin/JVM with a top-level fun main().",
    "rust": "Rust 2021 edition with fn main(), standard library only.",
    "go": "Go with package main and func main(), standard library only.",
    "c": "C11 with int main(void), standard library only.",
    "cpp": "C++17 with int main(), standard library only.",
    "csharp": "C# 12 with top-level statements; no namespace or Program class needed.",
    "lua": "Lua 5.4. Print with print().",
    "ruby": "Ruby 3. Print with puts.",
    "php": "PHP 8 command-line script that starts with <?php.",
    "bash": "Bash 5 script, run with bash.",
    "swift": "Swift 5 script run with swift.",
    "dart": "Dart 3 with void main().",
    "r": "R script run with Rscript.",
    "julia": "Julia script.",
    "perl": "Perl 5 script with use strict; and use warnings;.",
    "html": "A single HTML5 document.",
    "css": "A single CSS stylesheet.",
    "sql": "SQLite-compatible SQL statements.",
    "scala": "Scala 3 script with a top-level @main def.",
    "powershell": "PowerShell 7 script.",
    "elixir": "Elixir script (.exs), top-level expressions run in order.",
    "haskell": "Haskell with main :: IO (), base library only.",
    "ocaml": "OCaml script run with the ocaml toplevel; standard library only.",
    "fsharp": "F# script (.fsx) run with dotnet fsi.",
    "nim": "Nim 2, top-level statements, standard library only.",
    "zig": "Zig with pub fn main() !void, standard library only.",
    "crystal": "Crystal, top-level statements.",
    "groovy": "Groovy script.",
    "clojure": "Clojure script, top-level forms run in order.",
    "d": "D with void main(), standard library (Phobos) only.",
    "fortran": "Free-form Fortran 2008: one program unit, implicit none.",
    "pascal": "Free Pascal program with a program header and a begin ... end. block.",
    "cobol": "GnuCOBOL in free format (compiled with cobc -x -free): IDENTIFICATION, PROCEDURE DIVISION, STOP RUN.",
    "scheme": "Guile Scheme script, top-level forms run in order.",
    "lisp": "Common Lisp script run with sbcl --script.",
    "tcl": "Tcl 8.6 script.",
    "awk": "POSIX awk program whose work is in a BEGIN block (no input is read unless the code reads it).",
    "v": "V with fn main().",
    "odin": "Odin with package main and main :: proc(), core library only.",
    "ada": "Ada 2012: one main procedure.",
    "objc": "Objective-C with int main, Foundation only.",
}

# Assembly depends on the machine it is written for.
_MACHINE_NAMES = {"x86_64": "x86-64", "amd64": "x86-64", "aarch64": "64-bit ARM (AArch64)", "arm64": "64-bit ARM (AArch64)", "armv7l": "32-bit ARM"}


def machine_name() -> str:
    """The processor IMY runs on, as the assembly note names it."""
    import platform

    raw = platform.machine().lower() or "unknown"
    return _MACHINE_NAMES.get(raw, raw)


def target_note(target: str) -> str | None:
    """What the model is told about the target language, with the machine filled in for assembly."""
    if target == "asm":
        return (
            f"Assembly for {machine_name()} Linux in GNU assembler syntax, assembled and linked by the C compiler "
            "(cc program.s): define a global `main`, call C library functions such as puts and printf for output, "
            "keep the stack aligned, and return 0 from main."
        )
    return TARGET_NOTES.get(target)


class ResponseFormatError(Exception):
    """The model's reply isn't the JSON object the contract requires."""

    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


_THINK_BLOCK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_FENCED_JSON = re.compile(r"^```[A-Za-z0-9_-]*\s*\n(.*?)\n?```\s*$", re.DOTALL)


def extract_json_object(text: str) -> dict[str, Any]:
    """Pull the JSON object out of a reply (tolerates code fences, think blocks and stray prose)."""
    cleaned = _THINK_BLOCK.sub("", text).strip()
    fenced = _FENCED_JSON.match(cleaned)
    if fenced:
        cleaned = fenced.group(1).strip()
    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError:
        decoder = json.JSONDecoder()
        value = None
        start = cleaned.find("{")
        attempts = 0
        while start != -1 and attempts < 200:
            attempts += 1
            try:
                value, _ = decoder.raw_decode(cleaned, start)
                if isinstance(value, dict):
                    break
            except json.JSONDecodeError:
                pass
            value = None
            start = cleaned.find("{", start + 1)
        if value is None:
            raise ResponseFormatError(["the reply contains no JSON object"]) from None
    if not isinstance(value, dict):
        raise ResponseFormatError(["the reply is JSON but not an object"])
    return value


def parse_compiler_response(text: str) -> CompilerResponse:
    data = extract_json_object(text)
    try:
        return CompilerResponse.model_validate(data)
    except ValidationError as exc:
        problems = []
        for error in exc.errors():
            where = ".".join(str(part) for part in error.get("loc", ())) or "object"
            problems.append(f"{where}: {error.get('msg', 'invalid value')}")
        raise ResponseFormatError(problems) from exc


@dataclass(frozen=True)
class WebResourceNote:
    url: str
    line: int
    local_path: str | None


@dataclass(frozen=True)
class RepoContext:
    """Where an IMY snippet will be injected inside a repository file."""

    file: str
    language: str
    insert_line: int
    position: str
    indent: str
    before: str
    after: str
    defined_names: tuple[str, ...]

    def describe(self) -> str:
        names = ", ".join(self.defined_names) if self.defined_names else "(none found)"
        return (
            "REPOSITORY CONTEXT (injection mode)\n"
            f"- Target file: {self.file} ({self.language})\n"
            f"- The compiled code is inserted {self.position} line {self.insert_line} at indentation {self.indent!r}.\n"
            "- compiled_code must be ONLY the snippet to insert (no surrounding file content), written at column 0; "
            "IMY indents it. It must fit the surrounding code, reuse names the file already defines when the IMY "
            "code refers to them, and keep the file valid.\n"
            f"- Names defined in the file: {names}\n"
            f"--- code before the insertion point ---\n{self.before}\n"
            f"--- code after the insertion point ---\n{self.after}\n"
            "--- end of repository context ---"
        )

    def fingerprint_text(self) -> str:
        return json.dumps(
            {
                "file": self.file,
                "language": self.language,
                "insert_line": self.insert_line,
                "position": self.position,
                "indent": self.indent,
                "before": self.before,
                "after": self.after,
            },
            sort_keys=True,
        )


def system_prompt() -> str:
    return SYSTEM_PROMPT


# Added to the request while the console converts a program that is still being typed.
# A normal compile never carries it, so its prompt (and PROMPT_VERSION) is unchanged.
LIVE_PREVIEW_NOTE = (
    "LIVE PREVIEW: the person is still typing this program, and more lines may follow. Convert exactly "
    "the lines that are here, in order. Do not report HeaderMismatch or MissingMechanics for something "
    "the header describes that the code has not reached yet, and never add code for lines that are not "
    "written. A line that is here and breaks a rule by itself is still an error: an English request in "
    "place of code, a line whose meaning is unclear, something used before the line that defines it, a "
    "switch that turns on a feature no line codes."
)


def build_user_prompt(
    *,
    parsed: ParsedSource,
    target: str,
    memory: Iterable[MemorySymbol] = (),
    virtual_paths: dict[str, str] | None = None,
    web_resources: Iterable[WebResourceNote] = (),
    repo_context: RepoContext | None = None,
    preview: bool = False,
) -> str:
    sections: list[str] = [f"TARGET LANGUAGE: {target}"]
    note = target_note(target)
    if note:
        sections.append(f"TARGET NOTES: {note}")
    if target == "html":
        sections.append(WEB_RULES)
    sections.append("IMY SOURCE (numbered; cite these line numbers):\n" + parsed.numbered())

    facts: list[str] = []
    if parsed.shortcuts:
        facts.append("- shortcuts: " + ", ".join(f"{s.token} (line {s.line})" for s in parsed.shortcuts))
    else:
        facts.append("- shortcuts: none")
    for pack in parsed.packs:
        facts.append(f'- variable pack "{pack.name}" (line {pack.line}): members {", ".join(pack.members)}')
    for fn in parsed.functions:
        params = ", ".join(fn.params)
        facts.append(f"- function {fn.name}({params}) (lines {fn.line}-{fn.end_line})")
    sections.append("STATIC ANALYSIS (deterministic; already verified)\n" + "\n".join(facts))

    if virtual_paths:
        lines = [f'- "{virtual}" -> "{real}"' for virtual, real in sorted(virtual_paths.items())]
        sections.append(
            "VIRTUAL PATHS (relative to the folder the program runs in; IMY creates each parent folder, the "
            "program creates the final file or folder itself)\n" + "\n".join(lines)
        )
    web = list(web_resources)
    if web:
        lines = []
        for resource in web:
            if resource.local_path:
                lines.append(f"- {resource.url} (line {resource.line}) -> mirrored at \"{resource.local_path}\"")
            else:
                lines.append(f"- {resource.url} (line {resource.line}) -> fetch at run time if the code needs it")
        sections.append("WEB RESOURCES\n" + "\n".join(lines))

    saved = list(memory)
    if saved:
        lines = []
        for symbol in saved:
            members = f" members: {', '.join(symbol.members)};" if symbol.members else ""
            fragment = symbol.source_fragment.strip().replace("\n", "\n    ")
            lines.append(
                f"- {symbol.name} ({symbol.kind.value}, from {symbol.origin_label}):{members} meaning: {symbol.meaning}\n"
                f"    defined as: {fragment}"
            )
        sections.append("MEMORY (saved definitions from earlier sessions; use them exactly)\n" + "\n".join(lines))
    else:
        sections.append("MEMORY: nothing saved applies to this file.")

    if repo_context is not None:
        sections.append(repo_context.describe())
    if preview:
        sections.append(LIVE_PREVIEW_NOTE)
    sections.append(f'Return the JSON object now, with target_language "{target}".')
    return "\n\n".join(sections)


def build_repair_prompt(problems: Iterable[str], target: str) -> str:
    listing = "\n".join(f"- {problem}" for problem in problems)
    return (
        "Your previous reply could not be used:\n"
        f"{listing}\n"
        f'Return the complete corrected JSON object only, same schema, target_language "{target}". '
        "Keep every rule: zero comments, exact layout and messages, nothing invented."
    )
