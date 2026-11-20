"""Background execution: writes compiled code into .imy/build/ and runs it.

The user's .imy file is only ever read. Programs run in the folder that holds
the .imy file, with the user's own environment minus IMY's key variable.
"""

from __future__ import annotations

import contextlib
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass, field
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .compiler import CompileResult
from .errors import RunnerError
from .languages import Language
from .workspace import Workspace

INSTALL_HINTS: dict[str, str] = {
    "javascript": "Install Node.js (Debian/Ubuntu: sudo apt install nodejs; macOS: brew install node).",
    "typescript": "Install Node.js 22 or newer, or `npm install -g tsx`.",
    "lua": "Install Lua (Debian/Ubuntu: sudo apt install lua5.4; macOS: brew install lua).",
    "ruby": "Install Ruby (Debian/Ubuntu: sudo apt install ruby).",
    "php": "Install PHP (Debian/Ubuntu: sudo apt install php-cli).",
    "perl": "Install Perl (Debian/Ubuntu: sudo apt install perl).",
    "bash": "Install bash.",
    "powershell": "Install PowerShell (pwsh).",
    "r": "Install R (Debian/Ubuntu: sudo apt install r-base).",
    "julia": "Install Julia from julialang.org.",
    "go": "Install Go (Debian/Ubuntu: sudo apt install golang).",
    "rust": "Install Rust from rustup.rs.",
    "c": "Install a C compiler (Debian/Ubuntu: sudo apt install build-essential).",
    "cpp": "Install a C++ compiler (Debian/Ubuntu: sudo apt install build-essential).",
    "java": "Install Java 17 or newer (Debian/Ubuntu: sudo apt install default-jdk).",
    "kotlin": "Install the Kotlin compiler (kotlinc) and Java.",
    "csharp": "Install the .NET SDK from dot.net.",
    "swift": "Install Swift from swift.org.",
    "dart": "Install Dart from dart.dev.",
    "scala": "Install scala-cli from scala-cli.virtuslab.org.",
    "sql": "Install SQLite (Debian/Ubuntu: sudo apt install sqlite3).",
    "elixir": "Install Elixir from elixir-lang.org.",
    "haskell": "Install GHC (runghc) from haskell.org.",
    "nim": "Install Nim from nim-lang.org.",
    "zig": "Install Zig from ziglang.org.",
    "crystal": "Install Crystal from crystal-lang.org.",
    "groovy": "Install Groovy from groovy-lang.org.",
    "ocaml": "Install OCaml from ocaml.org.",
    "fsharp": "Install the .NET SDK from dot.net.",
}
NOT_RUNNABLE = frozenset({"html", "css"})


@dataclass(frozen=True)
class BuildArtifact:
    path: Path
    language: Language
    run_dir: Path
    folder: Path


@dataclass(frozen=True)
class Toolchain:
    run: list[str]
    steps: list[list[str]] = field(default_factory=list)


@dataclass(frozen=True)
class RunOutcome:
    exit_code: int
    command: list[str]
    pid: int | None = None
    log_path: Path | None = None
    timed_out: bool = False


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".build.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def _copy_site_assets(result: CompileResult, folder: Path) -> list[Path]:
    source = result.parsed.path
    if source is None:
        return []
    base = source.parent.resolve()
    copied: list[Path] = []
    for _, value in result.parsed.string_values():
        relative = value.strip()
        if not relative or "://" in relative or relative.startswith(("/", "\\")):
            continue
        candidate = (base / relative).resolve()
        if not candidate.is_file() or base not in candidate.parents:
            continue
        target = folder / candidate.relative_to(base)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(candidate, target)
        copied.append(target)
    return copied


def build_artifact(
    result: CompileResult, workspace: Workspace, *, stem: str | None = None, run_dir: Path | None = None
) -> BuildArtifact:
    """Write the compiled program into .imy/build/ (the .imy source is never touched)."""
    workspace.ensure()
    language = result.language
    base = stem or (result.parsed.path.stem if result.parsed.path is not None else "console")
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", base).strip(".") or "program"
    if run_dir is None:
        run_dir = result.parsed.path.parent if result.parsed.path is not None else workspace.root
    folder = workspace.build
    if language.name == "java":
        match = re.search(r"\bpublic\s+(?:final\s+|abstract\s+)*class\s+([A-Za-z_]\w*)", result.code)
        folder = workspace.build / f"{safe}-java"
        path = folder / f"{match.group(1) if match else 'Main'}.java"
    elif language.name == "csharp":
        folder = workspace.build / f"{safe}-csharp"
        path = folder / "Program.cs"
    elif language.name == "go":
        folder = workspace.build / f"{safe}-go"
        path = folder / "main.go"
    elif language.name == "html":
        folder = workspace.build / f"{safe}-site"
        path = folder / "index.html"
    else:
        path = workspace.build / f"{safe}{language.extension}"
    try:
        _write_atomic(path, result.code)
        if language.name == "html":
            _copy_site_assets(result, folder)
    except OSError as exc:
        raise RunnerError(f"Can't write the build output {path}: {exc.strerror or exc}") from exc
    return BuildArtifact(path=path, language=language, run_dir=run_dir, folder=folder)


def _find(*names: str) -> str | None:
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return None


def _need(language: Language, *names: str) -> str:
    found = _find(*names)
    if found is None:
        raise RunnerError(
            f"Running {language.display} needs `{names[0]}`, which isn't installed or isn't on PATH.",
            hint=INSTALL_HINTS.get(language.name, f"Or use `imy convert --to {language.name}` and run the file yourself."),
        )
    return found


def python_command() -> str:
    """The Python that runs compiled programs: IMY_PYTHON, else python3/python on PATH, else IMY's own."""
    return os.environ.get("IMY_PYTHON") or _find("python3", "python") or sys.executable


def _dotnet_framework(dotnet: str) -> str:
    try:
        version = subprocess.run([dotnet, "--version"], capture_output=True, text=True, timeout=60).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        version = ""
    match = re.match(r"(\d+)\.", version)
    return f"net{match.group(1)}.0" if match else "net8.0"


def toolchain_for(artifact: BuildArtifact) -> Toolchain | None:
    """How to build and run the artifact, or None when the language has no runner."""
    language = artifact.language
    name = language.name
    path = str(artifact.path)
    exe_suffix = ".exe" if os.name == "nt" else ""
    binary = str(artifact.path.with_suffix(exe_suffix))
    if name == "python":
        return Toolchain(run=[python_command(), path])
    if name == "javascript":
        return Toolchain(run=[_need(language, "node", "nodejs"), path])
    if name == "typescript":
        tsx = _find("tsx")
        if tsx:
            return Toolchain(run=[tsx, path])
        return Toolchain(run=[_need(language, "node"), "--experimental-strip-types", "--no-warnings", path])
    if name == "lua":
        return Toolchain(run=[_need(language, "lua", "lua5.4", "lua5.3", "luajit"), path])
    if name in ("ruby", "php", "perl", "julia", "elixir", "groovy", "ocaml"):
        return Toolchain(run=[_need(language, name), path])
    if name == "bash":
        return Toolchain(run=[_need(language, "bash", "sh"), path])
    if name == "powershell":
        return Toolchain(run=[_need(language, "pwsh", "powershell"), "-File", path])
    if name == "r":
        return Toolchain(run=[_need(language, "Rscript"), path])
    if name == "swift":
        return Toolchain(run=[_need(language, "swift"), path])
    if name == "dart":
        return Toolchain(run=[_need(language, "dart"), "run", path])
    if name == "haskell":
        return Toolchain(run=[_need(language, "runghc", "runhaskell"), path])
    if name == "nim":
        return Toolchain(run=[_need(language, "nim"), "r", "--hints:off", path])
    if name == "zig":
        return Toolchain(run=[_need(language, "zig"), "run", path])
    if name == "crystal":
        return Toolchain(run=[_need(language, "crystal"), "run", path])
    if name == "fsharp":
        return Toolchain(run=[_need(language, "dotnet"), "fsi", path])
    if name == "scala":
        cli = _find("scala-cli")
        if cli:
            return Toolchain(run=[cli, "run", path])
        return Toolchain(run=[_need(language, "scala"), path])
    if name == "sql":
        return Toolchain(run=[_need(language, "sqlite3"), ":memory:", f".read {path}"])
    if name == "go":
        return Toolchain(run=[_need(language, "go"), "run", path])
    if name == "java":
        return Toolchain(run=[_need(language, "java"), path])
    if name == "rust":
        return Toolchain(
            steps=[[_need(language, "rustc"), "--edition", "2021", "-O", path, "-o", binary]], run=[binary]
        )
    if name == "c":
        return Toolchain(steps=[[_need(language, "cc", "gcc", "clang"), "-std=c11", "-O2", path, "-o", binary, "-lm"]], run=[binary])
    if name == "cpp":
        return Toolchain(steps=[[_need(language, "c++", "g++", "clang++"), "-std=c++17", "-O2", path, "-o", binary]], run=[binary])
    if name == "kotlin":
        jar = str(artifact.path.with_suffix(".jar"))
        return Toolchain(
            steps=[[_need(language, "kotlinc"), path, "-include-runtime", "-d", jar]], run=[_need(language, "java"), "-jar", jar]
        )
    if name == "csharp":
        dotnet = _need(language, "dotnet")
        project = artifact.folder / f"{artifact.folder.name}.csproj"
        if not project.exists():
            project.write_text(
                '<Project Sdk="Microsoft.NET.Sdk">\n'
                "  <PropertyGroup>\n"
                "    <OutputType>Exe</OutputType>\n"
                f"    <TargetFramework>{_dotnet_framework(dotnet)}</TargetFramework>\n"
                "    <ImplicitUsings>enable</ImplicitUsings>\n"
                "    <Nullable>disable</Nullable>\n"
                "  </PropertyGroup>\n"
                "</Project>\n",
                encoding="utf-8",
            )
        return Toolchain(run=[dotnet, "run", "--project", str(project), "--"])
    return None


def program_environment(workspace: Workspace) -> dict[str, str]:
    env = dict(os.environ)
    env.pop("IMY_API_KEY", None)
    env["IMY_PROJECT_ROOT"] = str(workspace.root)
    env["IMY_VFS_ROOT"] = str(workspace.vfs)
    env.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    return env


def run_artifact(
    artifact: BuildArtifact,
    workspace: Workspace,
    *,
    args: Sequence[str] = (),
    timeout: float | None = None,
    detach: bool = False,
) -> RunOutcome:
    """Build (when the language needs it) and run the program with the terminal's input and output."""
    language = artifact.language
    toolchain = toolchain_for(artifact)
    if toolchain is None:
        if language.name in NOT_RUNNABLE:
            raise RunnerError(
                f"{language.display} isn't a program to run.",
                hint=f"It was built at {artifact.path}; open it in a browser, or run `imy run --serve` to serve it.",
            )
        raise RunnerError(
            f"IMY can convert to {language.display} but has no runner for it here.",
            hint=f"Use `imy convert --to {language.name}` and run the file with your own tools.",
        )
    env = program_environment(workspace)
    for step in toolchain.steps:
        try:
            built = subprocess.run(step, cwd=artifact.run_dir, env=env, capture_output=True, text=True, timeout=600)
        except subprocess.TimeoutExpired as exc:
            raise RunnerError(f"Building the {language.display} program took longer than 10 minutes.") from exc
        except OSError as exc:
            raise RunnerError(f"Couldn't start `{step[0]}`: {exc.strerror or exc}") from exc
        if built.returncode != 0:
            tail = (built.stderr or built.stdout).strip().splitlines()[-15:]
            raise RunnerError(f"Building the {language.display} program failed:\n" + "\n".join(tail))
    command = [*toolchain.run, *args]
    if detach:
        log_path = artifact.path.with_name(artifact.path.stem + ".log")
        try:
            log = open(log_path, "wb")
        except OSError as exc:
            raise RunnerError(f"Can't open the log {log_path}: {exc.strerror or exc}") from exc
        with log:
            try:
                proc = subprocess.Popen(
                    command,
                    cwd=artifact.run_dir,
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
            except OSError as exc:
                raise RunnerError(f"Couldn't start `{command[0]}`: {exc.strerror or exc}") from exc
        return RunOutcome(exit_code=0, command=command, pid=proc.pid, log_path=log_path)
    try:
        proc = subprocess.Popen(command, cwd=artifact.run_dir, env=env)
    except OSError as exc:
        raise RunnerError(f"Couldn't start `{command[0]}`: {exc.strerror or exc}") from exc
    try:
        return RunOutcome(exit_code=proc.wait(timeout=timeout), command=command)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        return RunOutcome(exit_code=124, command=command, timed_out=True)
    except KeyboardInterrupt:
        with contextlib.suppress(OSError):
            proc.send_signal(signal.SIGINT)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        return RunOutcome(exit_code=130, command=command)


def serve_folder(folder: Path, port: int) -> None:
    """Serve a built website on http://127.0.0.1:<port> until Ctrl+C."""
    handler = partial(SimpleHTTPRequestHandler, directory=str(folder))
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    except OSError as exc:
        raise RunnerError(f"Can't serve on port {port}: {exc.strerror or exc}", hint="Pick another port with --port.") from exc
    with server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
