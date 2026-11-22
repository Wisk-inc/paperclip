"""Clone a repository, inject compiled IMY code into one of its files, and run it.

Only the chosen file inside the clone changes; every other line of it is kept
byte for byte. The spliced file is validated before it is written (Python files
must still parse, and the inserted lines must hold no comments or docstrings).
"""

from __future__ import annotations

import ast
import difflib
import io
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import textwrap
import tokenize
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlparse

from .compiler import CompileOptions, Compiler, CompileResult
from .errors import InjectionError
from .languages import Language, language_for_extension, resolve_language
from .prompts import RepoContext

_OWNER = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})"
_REPO = r"[A-Za-z0-9._-]{1,100}"
_SHORTHAND = re.compile(rf"^(?P<owner>{_OWNER})/(?P<repo>{_REPO})$")
_KNOWN_HOSTS = ("gitlab.com", "bitbucket.org", "codeberg.org", "git.sr.ht", "gitea.com")
_CONTEXT_BEFORE = 40
_CONTEXT_AFTER = 20


@dataclass(frozen=True)
class RepoRef:
    url: str
    folder: str
    display: str
    local: bool = False


def _folder_name(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", text).strip("._") or "repo"


_SCP_LIKE = re.compile(r"^(?P<user>[A-Za-z0-9._-]+)@(?P<host>[A-Za-z0-9.-]+):(?P<path>[A-Za-z0-9._~/-]+)$")


def _github_ref(owner: str, repo: str, original: str) -> RepoRef:
    repo = repo.removesuffix(".git")
    if not re.fullmatch(_OWNER, owner) or not re.fullmatch(_REPO, repo) or repo in (".", ".."):
        raise InjectionError(f"{original!r} is not a GitHub repository address.", hint="Use https://github.com/<owner>/<repo>.")
    return RepoRef(url=f"https://github.com/{owner}/{repo}.git", folder=_folder_name(f"{owner}__{repo}"), display=f"{owner}/{repo}")


def parse_repo_url(text: str) -> RepoRef:
    """Validate a repository reference.

    Accepted: a GitHub URL (a page inside the repository, such as .../tree/main/src, is
    fine), git@host:owner/repo.git, owner/repo (GitHub), an https or ssh URL on another
    host, file://, or a local repository folder. Anything git could read as an option or
    as a command-running transport is refused.
    """
    value = text.strip()
    if not value:
        raise InjectionError("Give the repository to clone, for example https://github.com/huggingface/transformers.")
    if value.startswith("-") or any(ch.isspace() for ch in value) or "::" in value:
        raise InjectionError(f"{text!r} is not a git repository URL.")
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if parsed.scheme in ("http", "https") and host in ("github.com", "www.github.com"):
        segments = [segment for segment in parsed.path.split("/") if segment]
        if len(segments) < 2:
            raise InjectionError(f"{text!r} names no repository.", hint="Use https://github.com/<owner>/<repo>.")
        return _github_ref(segments[0], segments[1], text)
    scp = _SCP_LIKE.match(value)
    if scp:
        path = scp.group("path").strip("/")
        if path.count("/") < 1:
            raise InjectionError(f"{text!r} names no repository.")
        name = path.rsplit("/", 1)[-1].removesuffix(".git")
        host_name = scp.group("host").lower()
        if host_name == "github.com" and path.count("/") == 1:
            owner = path.split("/", 1)[0]
            return RepoRef(url=value, folder=_folder_name(f"{owner}__{name}"), display=f"{owner}/{name}")
        return RepoRef(url=value, folder=_folder_name(f"{host_name}__{name}"), display=f"{host_name}:{path}")
    if value.startswith("file://"):
        local = Path(unquote(parsed.path))
        if not _is_git_repo(local):
            raise InjectionError(f"{value} is not a git repository.")
        return RepoRef(url=value, folder=_folder_name(local.name), display=str(local), local=True)
    candidate = Path(value).expanduser()
    if candidate.exists():
        if not _is_git_repo(candidate):
            raise InjectionError(f"{candidate} exists but is not a git repository.")
        resolved = candidate.resolve()
        return RepoRef(url=resolved.as_uri(), folder=_folder_name(resolved.name), display=str(resolved), local=True)
    match = _SHORTHAND.match(value)
    if match:
        return _github_ref(match.group("owner"), match.group("repo"), text)
    if parsed.scheme in ("https", "http", "ssh") and parsed.netloc:
        segments = [segment for segment in parsed.path.split("/") if segment]
        if len(segments) >= 2 and (value.endswith(".git") or host in _KNOWN_HOSTS or host.endswith(tuple("." + h for h in _KNOWN_HOSTS))):
            name = segments[-1].removesuffix(".git")
            return RepoRef(url=value, folder=_folder_name(f"{host}__{name}"), display=f"{host}/{'/'.join(segments)}")
    raise InjectionError(
        f"{text!r} is not a git repository URL.",
        hint="Use https://github.com/<owner>/<repo>, git@github.com:<owner>/<repo>.git, <owner>/<repo>, "
        "another host's .git URL, or a local repository folder.",
    )


def _is_git_repo(path: Path) -> bool:
    return path.is_dir() and ((path / ".git").exists() or ((path / "HEAD").is_file() and (path / "objects").is_dir()))


def _git() -> str:
    git = shutil.which("git")
    if git is None:
        raise InjectionError("git is not installed.", hint="Install git (Debian/Ubuntu: sudo apt install git).")
    return git


def _git_env() -> dict[str, str]:
    env = dict(os.environ)
    env.update({"GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never", "GIT_ASKPASS": "echo", "SSH_ASKPASS": "echo"})
    env.pop("IMY_API_KEY", None)
    return env


def clone_repository(ref: RepoRef, destination: Path, *, branch: str | None = None, depth: int | None = 1, timeout: float = 900) -> Path:
    """Clone (or reuse an existing clone of the same repository) into ``destination``."""
    git = _git()
    if destination.exists():
        if (destination / ".git").exists():
            current = _origin_url(destination)
            if current and current != ref.url:
                raise InjectionError(
                    f"{destination} already holds another repository ({current}).",
                    hint="Pass --dest to clone somewhere else, or --fresh to replace it.",
                )
            return destination
        if any(destination.iterdir()):
            raise InjectionError(f"{destination} exists and is not a git checkout.", hint="Pass --dest with an empty folder.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    command = [git, "-c", "protocol.ext.allow=never", "clone", "--quiet"]
    if depth and not (ref.local and not ref.url.startswith("file://")):
        command += ["--depth", str(depth)]
    if branch:
        command += ["--branch", branch]
    command += ["--", ref.url, str(destination)]
    try:
        proc = subprocess.run(command, capture_output=True, text=True, timeout=timeout, env=_git_env())
    except subprocess.TimeoutExpired as exc:
        shutil.rmtree(destination, ignore_errors=True)
        raise InjectionError(f"Cloning {ref.display} took longer than {timeout:g} seconds.") from exc
    if proc.returncode != 0:
        shutil.rmtree(destination, ignore_errors=True)
        detail = (proc.stderr or proc.stdout).strip().splitlines()
        tail = detail[-1] if detail else f"git exited with {proc.returncode}"
        lowered = " ".join(detail).lower()
        hint = None
        if "not found" in lowered or "does not exist" in lowered:
            hint = "Check the owner and repository name; private repositories need your git credentials."
        elif "could not read username" in lowered or "authentication" in lowered or "permission denied" in lowered:
            hint = "This repository needs credentials. Set up git access for it (ssh key or credential helper) first."
        elif "could not resolve host" in lowered or "unable to access" in lowered:
            hint = "Check your internet connection."
        elif branch and "remote branch" in lowered:
            hint = f"The branch {branch!r} doesn't exist in this repository."
        raise InjectionError(f"git clone of {ref.display} failed: {tail}", hint=hint)
    return destination


def _origin_url(folder: Path) -> str:
    if not (folder / ".git").exists():
        return ""
    probe = subprocess.run(
        [_git(), "-C", str(folder), "config", "--get", "remote.origin.url"], capture_output=True, text=True, env=_git_env()
    )
    return probe.stdout.strip()


def remove_earlier_clone(ref: RepoRef, folder: Path) -> None:
    """--fresh: delete ``folder`` only when it is an earlier clone of this same repository.

    With --dest the folder is the user's choice, so anything else there (another project,
    a folder of documents) is left alone and reported instead.
    """
    if not folder.is_dir() or folder.is_symlink():
        raise InjectionError(f"{folder} is not a folder IMY cloned; --fresh will not delete it.")
    if _origin_url(folder) != ref.url:
        raise InjectionError(
            f"{folder} is not an earlier clone of {ref.display}, so --fresh will not delete it.",
            hint="Pick another --dest, or remove that folder yourself if you no longer need it.",
        )
    shutil.rmtree(folder)


@dataclass(frozen=True)
class InsertionPoint:
    index: int
    line: int
    position: str
    indent: str


def _indent_of(text: str) -> str:
    return text[: len(text) - len(text.lstrip(" \t"))]


def indent_unit(lines: list[str]) -> str:
    if any(line.startswith("\t") for line in lines):
        return "\t"
    widths = sorted({len(_indent_of(line)) for line in lines if line.strip() and _indent_of(line)})
    if not widths:
        return "    "
    step = widths[0]
    for width in widths[1:]:
        while width % step:
            step -= 1
    return " " * max(step, 2) if step in (2, 3, 4, 8) else "    "


def _opens_block(text: str, language: Language) -> bool:
    stripped = text.rstrip()
    if language.name == "python":
        code = stripped.split("#", 1)[0].rstrip()
        return code.endswith(":")
    return stripped.endswith("{") or stripped.endswith("(") or stripped.endswith("[")


def find_insertion(
    lines: list[str],
    *,
    language: Language,
    line: int | None = None,
    anchor: str | None = None,
    before: bool = False,
    file_label: str = "the file",
) -> InsertionPoint:
    if line is not None and anchor is not None:
        raise InjectionError("Use --line or --anchor, not both.")
    unit = indent_unit(lines)
    if line is not None:
        if line < 1 or line > len(lines) + 1:
            raise InjectionError(f"--line {line} is outside {file_label}, which has {len(lines)} lines (use 1 to {len(lines) + 1}).")
        index = line - 1
        if index < len(lines) and lines[index].strip():
            indent = _indent_of(lines[index])
        else:
            previous = next((lines[i] for i in range(index - 1, -1, -1) if lines[i].strip()), "")
            indent = _indent_of(previous) + (unit if previous and _opens_block(previous, language) else "")
        return InsertionPoint(index=index, line=line, position="at", indent=indent)
    if anchor is not None:
        if not anchor.strip():
            raise InjectionError("--anchor can't be empty.")
        matches = [i for i, text in enumerate(lines) if anchor in text]
        if not matches:
            raise InjectionError(f"The anchor {anchor!r} does not appear in {file_label}.")
        if len(matches) > 1:
            listed = ", ".join(str(i + 1) for i in matches[:10])
            raise InjectionError(
                f"The anchor {anchor!r} appears {len(matches)} times in {file_label} (lines {listed}).",
                hint="Make the anchor unique, or use --line.",
            )
        found = matches[0]
        if before:
            return InsertionPoint(index=found, line=found + 1, position="before", indent=_indent_of(lines[found]))
        indent = _indent_of(lines[found]) + (unit if _opens_block(lines[found], language) else "")
        return InsertionPoint(index=found + 1, line=found + 1, position="after", indent=indent)
    return InsertionPoint(index=len(lines), line=len(lines), position="at the end, after", indent="")


def _string_continuation_lines(code: str) -> set[int]:
    inside: set[int] = set()
    try:
        for tok in tokenize.generate_tokens(io.StringIO(code).readline):
            if tok.type == tokenize.STRING and tok.end[0] > tok.start[0]:
                inside.update(range(tok.start[0] + 1, tok.end[0] + 1))
    except (tokenize.TokenError, SyntaxError):
        pass
    return inside


def reindent(snippet: str, indent: str, language: Language) -> list[str]:
    body = textwrap.dedent(snippet.strip("\n"))
    keep = _string_continuation_lines(body) if language.name == "python" else set()
    result = []
    for number, text in enumerate(body.split("\n"), start=1):
        if not text.strip() or number in keep:
            result.append(text if number in keep else "")
        else:
            result.append(indent + text)
    return result


def defined_names(text: str, language: Language) -> tuple[str, ...]:
    names: list[str] = []
    if language.name == "python":
        try:
            tree = ast.parse(text)
        except SyntaxError:
            tree = None
        if tree is not None:
            for node in tree.body:
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    names.append(node.name)
                elif isinstance(node, ast.Assign):
                    names.extend(t.id for t in node.targets if isinstance(t, ast.Name))
                elif isinstance(node, (ast.Import, ast.ImportFrom)):
                    names.extend((alias.asname or alias.name).split(".")[0] for alias in node.names)
            return tuple(dict.fromkeys(names))[:80]
    pattern = re.compile(r"\b(?:function|def|fn|func|class|struct|interface|const|let|var|local)\s+([A-Za-z_]\w*)")
    for match in pattern.finditer(text):
        names.append(match.group(1))
    return tuple(dict.fromkeys(names))[:80]


def build_context(path: Path, relative: str, lines: list[str], point: InsertionPoint, language: Language) -> RepoContext:
    before = "\n".join(lines[max(0, point.index - _CONTEXT_BEFORE) : point.index])
    after = "\n".join(lines[point.index : point.index + _CONTEXT_AFTER])
    return RepoContext(
        file=relative,
        language=language.name,
        insert_line=point.line,
        position=point.position,
        indent=point.indent,
        before=before,
        after=after,
        defined_names=defined_names("\n".join(lines), language),
    )


def _validate_spliced(text: str, language: Language, inserted: range, file_label: str) -> None:
    if language.name == "python":
        try:
            tree = ast.parse(text)
        except SyntaxError as exc:
            raise InjectionError(
                f"The injected code would break {file_label} (Python syntax error at line {exc.lineno}: {exc.msg}).",
                hint="Nothing was written. Sharpen the IMY code or pick another --line/--anchor.",
            ) from exc
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Expr)
                and isinstance(node.value, ast.Constant)
                and isinstance(node.value.value, str)
                and node.lineno in inserted
            ):
                raise InjectionError(
                    f"The injected code adds a docstring at line {node.lineno} of {file_label}; IMY output must have zero comments.",
                    hint="Nothing was written.",
                )
        return
    if language.name == "javascript":
        node = shutil.which("node")
        if node is None:
            return
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as handle:
            handle.write(text)
            temp = handle.name
        try:
            proc = subprocess.run([node, "--check", temp], capture_output=True, text=True, timeout=60)
        finally:
            os.unlink(temp)
        if proc.returncode != 0:
            detail = proc.stderr.strip().splitlines()
            raise InjectionError(
                f"The injected code would break {file_label}: {detail[-1] if detail else 'syntax error'}",
                hint="Nothing was written.",
            )


@dataclass
class InjectResult:
    repo_dir: Path
    target: Path
    language: Language
    point: InsertionPoint
    inserted_lines: list[str]
    diff: str
    compile_result: CompileResult
    run_exit_code: int | None = None


def inject(
    compiler: Compiler,
    *,
    repo_url: str,
    target: str,
    imy_file: Path,
    line: int | None = None,
    anchor: str | None = None,
    before: bool = False,
    to: str | None = None,
    destination: Path | None = None,
    branch: str | None = None,
    fresh: bool = False,
    update_memory: bool = False,
    use_cache: bool = True,
    run_command: str | None = None,
    run_timeout: float | None = None,
) -> InjectResult:
    ref = parse_repo_url(repo_url)
    repo_dir = destination or (compiler.workspace.repos / ref.folder)
    if fresh and repo_dir.exists():
        remove_earlier_clone(ref, repo_dir)
    clone_repository(ref, repo_dir, branch=branch)

    relative = target.strip().lstrip("/\\")
    if not relative:
        raise InjectionError("--target must name a file inside the repository.")
    target_path = (repo_dir / relative).resolve()
    root = repo_dir.resolve()
    if root not in target_path.parents:
        raise InjectionError(f"--target {target!r} points outside the repository.")
    if not target_path.is_file():
        raise InjectionError(f"{relative} does not exist in {ref.display}.", hint="Check the path relative to the repository root.")
    try:
        original = target_path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise InjectionError(f"{relative} is not UTF-8 text.") from exc
    except OSError as exc:
        raise InjectionError(f"Can't read {relative}: {exc.strerror or exc}") from exc

    if to:
        try:
            language = resolve_language(to)
        except ValueError as exc:
            raise InjectionError(f"{to!r} is not a language name.") from exc
    else:
        detected = language_for_extension(target_path.suffix)
        if detected is None:
            raise InjectionError(f"IMY can't tell the language of {relative}.", hint="Pass --to <language>.")
        language = detected

    ends_with_newline = original.endswith("\n")
    lines = original.split("\n")
    if ends_with_newline:
        lines = lines[:-1]
    point = find_insertion(lines, language=language, line=line, anchor=anchor, before=before, file_label=relative)
    context = build_context(target_path, relative, lines, point, language)
    result = compiler.compile_file(
        imy_file,
        CompileOptions(
            target=language.name,
            update_memory=update_memory,
            use_cache=use_cache,
            save_memory=True,
            run_dir=root,
            repo_context=context,
            fragment=True,
        ),
    )
    inserted = reindent(result.code, point.indent, language)
    new_lines = lines[: point.index] + inserted + lines[point.index :]
    new_text = "\n".join(new_lines) + ("\n" if ends_with_newline else "")
    inserted_range = range(point.index + 1, point.index + len(inserted) + 1)
    _validate_spliced(new_text, language, inserted_range, relative)
    diff = "".join(
        difflib.unified_diff(
            original.splitlines(keepends=True),
            new_text.splitlines(keepends=True),
            fromfile=f"a/{relative}",
            tofile=f"b/{relative}",
        )
    )
    try:
        target_path.write_text(new_text, encoding="utf-8")
    except OSError as exc:
        raise InjectionError(f"Can't write {relative}: {exc.strerror or exc}") from exc
    outcome = InjectResult(
        repo_dir=root,
        target=target_path,
        language=language,
        point=point,
        inserted_lines=inserted,
        diff=diff,
        compile_result=result,
    )
    if run_command:
        outcome.run_exit_code = run_in_repo(root, run_command, timeout=run_timeout)
    return outcome


def run_in_repo(repo_dir: Path, command: str, *, timeout: float | None = None) -> int:
    try:
        argv = shlex.split(command)
    except ValueError as exc:
        raise InjectionError(f"--run is not a valid command: {exc}") from exc
    if not argv:
        raise InjectionError("--run is empty.")
    env = _git_env()
    try:
        proc = subprocess.Popen(argv, cwd=repo_dir, env=env)
    except FileNotFoundError as exc:
        raise InjectionError(f"`{argv[0]}` isn't installed or isn't on PATH.") from exc
    except OSError as exc:
        raise InjectionError(f"Couldn't start `{argv[0]}`: {exc.strerror or exc}") from exc
    try:
        return proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        return 124
    except KeyboardInterrupt:
        proc.terminate()
        proc.wait()
        return 130
