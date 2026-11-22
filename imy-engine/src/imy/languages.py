"""Target languages: names, aliases, file extensions and comment syntax."""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class CommentSyntax:
    """How a language writes comments and strings (enough to find comments safely)."""

    line: tuple[str, ...] = ()
    block: tuple[tuple[str, str], ...] = ()
    strings: tuple[str, ...] = ('"', "'")
    char_literals: bool = False
    backtick_strings: bool = False
    raw_backticks: bool = False
    triple_strings: bool = False
    lua_long: bool = False
    rust_raw: bool = False
    regex_literals: bool = False
    hash_word_start: bool = False
    php_attributes: bool = False
    line_start_only: tuple[str, ...] = ()
    line_start_blocks: tuple[tuple[str, str], ...] = ()


C_FAMILY = CommentSyntax(line=("//",), block=(("/*", "*/"),), strings=('"',), char_literals=True)
# The same, for languages with multi-line text blocks, where // or # inside the block is just text.
C_TEXT_BLOCKS = CommentSyntax(
    line=("//",), block=(("/*", "*/"),), strings=('"',), char_literals=True, triple_strings=True
)
JS_FAMILY = CommentSyntax(
    line=("//",), block=(("/*", "*/"),), strings=('"', "'"), backtick_strings=True, regex_literals=True
)
HASH_FAMILY = CommentSyntax(line=("#",), strings=('"', "'"))
GENERIC = CommentSyntax(
    strings=('"', "'"),
    block=(("/*", "*/"), ("<!--", "-->")),
    line_start_only=("//", "#", "--", ";;"),
)


@dataclass(frozen=True)
class Language:
    name: str
    extension: str
    aliases: tuple[str, ...] = ()
    comments: CommentSyntax = field(default=GENERIC)
    label: str = ""

    @property
    def display(self) -> str:
        return self.label or self.name


_LANGS: tuple[Language, ...] = (
    Language("python", ".py", ("py", "python3", "py3"), HASH_FAMILY, "Python"),
    Language("javascript", ".js", ("js", "node", "nodejs", "mjs", "cjs"), JS_FAMILY, "JavaScript"),
    Language("typescript", ".ts", ("ts", "tsx"), JS_FAMILY, "TypeScript"),
    Language("java", ".java", ("jdk",), C_TEXT_BLOCKS, "Java"),
    Language("kotlin", ".kt", ("kt", "kts"), C_TEXT_BLOCKS, "Kotlin"),
    Language("scala", ".scala", ("sc",), C_TEXT_BLOCKS, "Scala"),
    Language(
        "rust",
        ".rs",
        ("rs",),
        CommentSyntax(line=("//",), block=(("/*", "*/"),), strings=('"',), char_literals=True, rust_raw=True),
        "Rust",
    ),
    Language(
        "go",
        ".go",
        ("golang",),
        CommentSyntax(
            line=("//",), block=(("/*", "*/"),), strings=('"',), char_literals=True, backtick_strings=True, raw_backticks=True
        ),
        "Go",
    ),
    Language("c", ".c", ("ansi-c", "c11", "c99"), C_FAMILY, "C"),
    Language("cpp", ".cpp", ("c++", "cxx", "cc", "cplusplus"), C_FAMILY, "C++"),
    Language("csharp", ".cs", ("c#", "cs", "dotnet"), C_TEXT_BLOCKS, "C#"),
    Language(
        "swift",
        ".swift",
        (),
        CommentSyntax(line=("//",), block=(("/*", "*/"),), strings=('"',), triple_strings=True),
        "Swift",
    ),
    Language(
        "dart",
        ".dart",
        (),
        CommentSyntax(line=("//",), block=(("/*", "*/"),), strings=('"', "'"), triple_strings=True),
        "Dart",
    ),
    Language(
        "lua",
        ".lua",
        ("luajit", "lua5.4"),
        CommentSyntax(line=("--",), strings=('"', "'"), lua_long=True),
        "Lua",
    ),
    Language(
        "ruby",
        ".rb",
        ("rb",),
        CommentSyntax(line=("#",), strings=('"', "'"), backtick_strings=True, line_start_blocks=(("=begin", "=end"),)),
        "Ruby",
    ),
    Language(
        "php",
        ".php",
        (),
        CommentSyntax(line=("//", "#"), block=(("/*", "*/"),), strings=('"', "'"), php_attributes=True),
        "PHP",
    ),
    Language(
        "bash",
        ".sh",
        ("sh", "shell", "zsh", "shellscript"),
        CommentSyntax(line=("#",), strings=('"', "'"), backtick_strings=True, hash_word_start=True),
        "Bash",
    ),
    Language(
        "powershell",
        ".ps1",
        ("ps1", "pwsh"),
        CommentSyntax(line=("#",), block=(("<#", "#>"),), strings=('"', "'")),
        "PowerShell",
    ),
    Language("r", ".R", ("rscript",), HASH_FAMILY, "R"),
    Language(
        "julia",
        ".jl",
        ("jl",),
        CommentSyntax(line=("#",), block=(("#=", "=#"),), strings=('"',), triple_strings=True),
        "Julia",
    ),
    Language(
        "perl",
        ".pl",
        ("pl",),
        CommentSyntax(line=("#",), strings=('"', "'"), line_start_blocks=(("=pod", "=cut"), ("=head", "=cut"))),
        "Perl",
    ),
    Language(
        "elixir",
        ".exs",
        ("ex", "exs"),
        CommentSyntax(line=("#",), strings=('"', "'"), triple_strings=True),
        "Elixir",
    ),
    Language("crystal", ".cr", ("cr",), HASH_FAMILY, "Crystal"),
    Language(
        "nim",
        ".nim",
        (),
        CommentSyntax(line=("#",), block=(("#[", "]#"),), strings=('"',), triple_strings=True),
        "Nim",
    ),
    Language(
        "haskell", ".hs", ("hs",), CommentSyntax(line=("--",), block=(("{-", "-}"),), strings=('"',)), "Haskell"
    ),
    Language(
        "sql",
        ".sql",
        ("sqlite", "sqlite3"),
        CommentSyntax(line=("--",), block=(("/*", "*/"),), strings=("'", '"')),
        "SQL",
    ),
    Language("css", ".css", (), CommentSyntax(block=(("/*", "*/"),), strings=('"', "'")), "CSS"),
    Language("html", ".html", ("htm", "web", "website", "webpage", "page"), GENERIC, "HTML"),
    Language("zig", ".zig", (), CommentSyntax(line=("//",), strings=('"',), char_literals=True), "Zig"),
    Language(
        "ocaml", ".ml", ("ml",), CommentSyntax(block=(("(*", "*)"),), strings=('"',)), "OCaml"
    ),
    Language(
        "fsharp", ".fsx", ("f#", "fs"), CommentSyntax(line=("//",), block=(("(*", "*)"),), strings=('"',)), "F#"
    ),
    Language("clojure", ".clj", ("clj",), CommentSyntax(line=(";",), strings=('"',)), "Clojure"),
    Language("groovy", ".groovy", (), C_TEXT_BLOCKS, "Groovy"),
    Language("fortran", ".f90", ("f90",), CommentSyntax(line=("!",), strings=('"', "'")), "Fortran"),
    Language(
        "pascal",
        ".pas",
        ("delphi",),
        CommentSyntax(line=("//",), block=(("{", "}"), ("(*", "*)")), strings=("'",)),
        "Pascal",
    ),
    Language("vb", ".vb", ("vbnet", "visualbasic"), CommentSyntax(line=("'",), strings=('"',)), "Visual Basic"),
)

_BY_NAME: dict[str, Language] = {}
for _language in _LANGS:
    _BY_NAME[_language.name] = _language
    for _alias in _language.aliases:
        _BY_NAME[_alias] = _language

_NAME_OK = re.compile(r"^[a-z0-9][a-z0-9+#._-]{0,39}$")


def normalize_language_name(name: str) -> str:
    return name.strip().lower().replace(" ", "")


def resolve_language(name: str) -> Language:
    """The Language for a --to value. Unknown names convert with generic comment checks."""
    key = normalize_language_name(name)
    if not key or not _NAME_OK.match(key):
        raise ValueError(f"{name!r} is not a language name")
    known = _BY_NAME.get(key)
    if known is not None:
        return known
    safe = re.sub(r"[^a-z0-9]", "", key) or "txt"
    return Language(name=key, extension=f".{safe}", comments=GENERIC, label=name.strip())


def language_for_extension(extension: str) -> Language | None:
    ext = extension.lower()
    for language in _LANGS:
        if language.extension.lower() == ext:
            return language
    extra = {".mjs": "javascript", ".cjs": "javascript", ".tsx": "typescript", ".jsx": "javascript", ".hpp": "cpp",
             ".h": "c", ".cc": "cpp", ".cxx": "cpp", ".kts": "kotlin", ".ex": "elixir", ".htm": "html",
             ".zsh": "bash", ".bash": "bash", ".pyw": "python", ".rake": "ruby", ".r": "r"}
    name = extra.get(ext)
    return _BY_NAME.get(name) if name else None


def known_languages() -> list[Language]:
    return list(_LANGS)
