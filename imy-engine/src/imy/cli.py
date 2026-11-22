"""The `imy` command."""

from __future__ import annotations

import contextlib
import os
import platform
import re
import shutil
import sys
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, Optional

import typer
from rich.console import Console
from rich.markup import escape
from rich.prompt import Confirm, Prompt
from rich.syntax import Syntax
from rich.table import Table

from . import __version__
from .compiler import CompileOptions, Compiler, CompileResult
from .config import (
    PROVIDER_INFO,
    PROVIDERS,
    EnvView,
    ImyConfig,
    config_file,
    environment,
    imy_home,
    load_config,
    load_stored,
    save_config,
)
from .errors import BuildFailed, CompilationFailed, ConfigError, Diagnostic, ImyError, LLMError, Stage
from .llm_client import AutomaBridgeClient, ChatMessage, LLMClient, LLMRequest, build_client
from .memory import Memory, MemoryStore
from .parser import parse_file, read_source
from .progress import format_seconds, working
from .languages import known_languages, resolve_language
from .runner import (
    INSTALL_HINTS,
    NOT_RUNNABLE,
    RUNNER_TOOLS,
    BuildArtifact,
    Toolchain,
    build_artifact,
    install_hint,
    prepare_program,
    python_command,
    runner_tool,
    report_headline,
    serve_folder,
    start_program,
)
from .workspace import Workspace, prepare_virtual_files

# Below this many columns the terminal is a phone's: its own wrapping would cut words in half.
NARROW_TERMINAL = 80


class ImyConsoleOutput(Console):
    """Rich console that leaves long text lines (messages, file paths) for the terminal to wrap,
    so a path stays in one piece. On a narrow terminal, where that wrapping would cut words in
    half, the text is wrapped between words instead. Tables and code keep Rich's own layout."""

    def print(self, *objects: Any, **kwargs: Any) -> None:
        if "soft_wrap" not in kwargs and all(isinstance(item, str) for item in objects):
            kwargs["soft_wrap"] = self.width >= NARROW_TERMINAL
        super().print(*objects, **kwargs)


err = ImyConsoleOutput(stderr=True, highlight=False)
out = ImyConsoleOutput(highlight=False)

app = typer.Typer(
    name="imy",
    help="Imagenery (IMY): a strict blueprint compiler. Write your own syntax under a # (\"...\") header, "
    "code every mechanic, and IMY validates, compiles and runs it without touching your .imy file.",
    no_args_is_help=True,
    add_completion=False,
    rich_markup_mode="rich",
    pretty_exceptions_enable=False,
)
memory_app = typer.Typer(help="Inspect and manage cross-session memory (variables, packs, functions, syntax).", no_args_is_help=True)
app.add_typer(memory_app, name="memory")

ProviderOpt = Annotated[Optional[str], typer.Option("--provider", help="anthropic, openai, gemini, openai-compatible or automa (this run only).")]
ModelOpt = Annotated[Optional[str], typer.Option("--model", "-m", help="Model id for this run only.")]
FreeModelOpt = Annotated[Optional[str], typer.Option("--free-model", help="Use this Automa free model (no key) for this run.")]
NoCacheOpt = Annotated[bool, typer.Option("--no-cache", help="Ignore the compile cache and ask the model again.")]
UpdateMemoryOpt = Annotated[bool, typer.Option("--update-memory", help="Let this file replace saved symbols it redefines.")]


@dataclass
class Session:
    config: ImyConfig
    env: EnvView
    workspace: Workspace
    memory: Memory
    compiler: Compiler


def make_client(config: ImyConfig, env: EnvView) -> LLMClient:
    return build_client(config, env)


def choose_model(provider: str | None, model: str | None, free_model: str | None) -> tuple[str | None, str | None]:
    """--free-model X means Automa's free models with model X (what Automa's model picker passes)."""
    if free_model is None:
        return provider, model
    if provider not in (None, "automa"):
        raise ConfigError(f"--free-model uses Automa's free models; it can't be combined with --provider {provider}.")
    if model is not None and model != free_model:
        raise ConfigError("Give either --model or --free-model, not both.")
    return "automa", free_model


def open_session(anchor: Path, *, provider: str | None = None, model: str | None = None, ensure: bool = True) -> Session:
    if provider is not None and provider not in PROVIDERS:
        raise ConfigError(f"Unknown provider {provider!r}.", hint="Use one of: " + ", ".join(PROVIDERS))
    home = imy_home()
    workspace = Workspace.discover(anchor, home=home)
    env = environment(workspace.root)
    config = load_config(workspace.root, env=env, overrides={"provider": provider, "model": model})
    if ensure:
        workspace.ensure()
    memory = Memory.open(imy_home(env.values), workspace.dot)
    compiler = Compiler(config=config, workspace=workspace, memory=memory, client_factory=lambda: make_client(config, env))
    return Session(config=config, env=env, workspace=workspace, memory=memory, compiler=compiler)


def _frame(lines: list[str], number: int, console: Console, *, marker: str = "❱", radius: int = 1) -> None:
    if not lines or number <= 0:
        return
    start = max(1, number - radius)
    end = min(len(lines), number + radius)
    width = len(str(end))
    for current in range(start, end + 1):
        pointer = marker if current == number else " "
        style = "bold" if current == number else "dim"
        console.print(f"  [{style}]{pointer} {current:>{width}} │ {escape(lines[current - 1])}[/{style}]")


def render_failure(exc: CompilationFailed, console: Console = err) -> None:
    console.print(f"[bold red]✗ {escape(exc.message)}[/bold red]")
    for diag in exc.diagnostics:
        console.print()
        _render_diagnostic(diag, exc, console)


def _render_diagnostic(diag: Diagnostic, exc: CompilationFailed, console: Console) -> None:
    colour = "magenta" if diag.family == "SyntaxError" else "red"
    console.print(f"[bold {colour}]{diag.family} [{escape(diag.code.value)}][/bold {colour}] [bold]{escape(diag.location)}[/bold]")
    console.print(f"  {escape(diag.message)}")
    if diag.stage is Stage.OUTPUT:
        _frame(exc.output_lines, diag.line, console)
    else:
        _frame(exc.source_lines, diag.line, console)
    for related in diag.related:
        if related != diag.line and 0 < related <= len(exc.source_lines):
            console.print(f"  [dim]see line {related}: {escape(exc.source_lines[related - 1].strip())}[/dim]")


def render_error(exc: ImyError, console: Console = err) -> None:
    label = "Model error" if isinstance(exc, LLMError) else "Error"
    console.print(f"[bold red]✗ {label}:[/bold red] {escape(exc.message)}")
    if exc.hint:
        console.print(f"  [yellow]→ {escape(exc.hint)}[/yellow]")


def render_valid(result: CompileResult, console: Console, name: str) -> None:
    parsed = result.parsed
    details = [
        f"{len(parsed.shortcuts)} shortcut" + ("" if len(parsed.shortcuts) == 1 else "s"),
        f"{len(result.symbols)} symbol" + ("" if len(result.symbols) == 1 else "s"),
    ]
    if result.relevant_memory:
        details.append(f"{len(result.relevant_memory)} from memory")
    details.append("cached" if result.from_cache else f"{result.provider}/{result.model}")
    console.print(f"[bold green]✓ VALID[/bold green] {escape(name)} → {escape(result.language.name)}  [dim]({escape(' · '.join(details))})[/dim]")
    for note in result.notes:
        console.print(f"  [dim]{escape(note)}[/dim]")


def render_memory(result: CompileResult, console: Console = err) -> None:
    report = result.memory_report
    if report is None or not report.changed:
        return
    parts = []
    if report.added:
        parts.append(f"saved {', '.join(s.name for s in report.added)}")
    if report.updated:
        parts.append(f"updated {', '.join(s.name for s in report.updated)} (redefined in this file)")
    if report.replaced:
        parts.append(f"replaced {', '.join(s.name for s in report.replaced)} (--update-memory)")
    console.print(f"[cyan]memory:[/cyan] {escape('; '.join(parts))}")


@contextlib.contextmanager
def guarded(console: Console = err) -> Iterator[None]:
    try:
        yield
    except CompilationFailed as exc:
        render_failure(exc, console)
        raise typer.Exit(exc.exit_code) from None
    except ImyError as exc:
        render_error(exc, console)
        raise typer.Exit(exc.exit_code) from None
    except KeyboardInterrupt:
        console.print("[yellow]Stopped.[/yellow]")
        raise typer.Exit(130) from None


def _compile(session: Session, file: Path, target: str, **options: object) -> CompileResult:
    """The free checks first (a rule error shows at once, with no model named), then the model."""
    parsed = parse_file(file)
    session.compiler.static_check(parsed)
    config = session.config
    label = f"Compiling {file.name} → {target} with {config.provider}/{config.resolved_model()}"
    with working(err, label, hint=SLOW_HINT if config.provider == "automa" else ""):
        return session.compiler.compile_parsed(parsed, CompileOptions(target=target, **options))  # type: ignore[arg-type]


# Shown beside the seconds once a free-model compile has run for a while.
SLOW_HINT = "free models often take a minute"


def build_with_repair(
    session: Session,
    result: CompileResult,
    console: Console,
    *,
    stem: str | None = None,
    run_dir: Path | None = None,
    notes: bool = True,
) -> tuple[CompileResult, BuildArtifact, Toolchain | None]:
    """Write the program into .imy/build/ and build it; nothing of it runs yet.

    When the language's own build tool (or its syntax check, for code that is
    new) refuses the program, what the tool said goes back to the model for a
    corrected version, as often as the repair setting allows. A program that
    still does not build leaves the cache, so the next run starts afresh.
    Web pages have nothing to build: the toolchain is None.

    ``notes`` off leaves out the two lines that say a correction was asked for
    and made (the console, which prints a program's output and nothing else);
    the wait still shows, and a program that cannot be corrected still fails
    with the tool's own words.
    """
    compiler = session.compiler
    budget = session.config.repair_attempts
    while True:
        artifact = build_artifact(result, session.workspace, stem=stem, run_dir=run_dir)
        if result.language.name in NOT_RUNNABLE:
            return result, artifact, None
        try:
            return result, artifact, prepare_program(artifact, session.workspace, check_syntax=not result.from_cache)
        except BuildFailed as failure:
            if budget <= 0:
                compiler.forget(result)
                raise
            budget -= 1
            said = report_headline(failure.report)
            if notes:
                console.print(f"[yellow]{escape(failure.tool)} refused the program:[/yellow] [dim]{escape(said[:200])}[/dim]")
            config = session.config
            label = f"Asking {config.provider}/{config.resolved_model()} to correct it"
            try:
                with working(console, label, hint=SLOW_HINT if config.provider == "automa" else ""):
                    result = compiler.repair(result, tool=failure.tool, report=failure.report)
            except ImyError as exc:
                compiler.forget(result)
                raise BuildFailed(
                    failure.message,
                    tool=failure.tool,
                    report=failure.report,
                    hint=f"The model could not correct it ({exc.message.rstrip('.')}). Run it again, or pick another model.",
                ) from exc
            if notes:
                console.print(f"[dim]corrected ({escape(compile_note(result))})[/dim]")


def compile_note(result: CompileResult) -> str:
    """Where the program came from: the cache, or which model and how long it took."""
    if result.from_cache:
        return "cached"
    model = result.model or "the model"
    return f"{model}, {format_seconds(result.seconds)}" if result.seconds >= 1 else model


# How often a watched file is looked at. Module-level so a test can stand in for the wait.
WATCH_INTERVAL = 0.4
_watch_sleep: Callable[[float], None] = time.sleep


def _file_signature(path: Path) -> tuple[int, int] | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    return (stat.st_mtime_ns, stat.st_size)


def wait_for_change(path: Path, last: tuple[int, int] | None) -> tuple[int, int]:
    """Wait until the file is saved again: its time or size differs from ``last`` and has settled.

    An editor may write a file in steps (empty first, then the text); two looks
    in a row must agree before the save counts. A file that is deleted is
    waited for until it is back.
    """
    while True:
        _watch_sleep(WATCH_INTERVAL)
        current = _file_signature(path)
        if current is None or current == last:
            continue
        _watch_sleep(WATCH_INTERVAL / 2)
        if _file_signature(path) == current:
            return current


def watch_runs(file: Path, once: Callable[[], int]) -> int:
    """Run ``once`` now and again after each save of ``file``, until Ctrl+C. A broken rule is shown and waited out."""
    seen = _file_signature(file)
    try:
        while True:
            try:
                once()
            except CompilationFailed as exc:
                render_failure(exc)
            except ImyError as exc:
                render_error(exc)
            err.print(f"[dim]watching {escape(file.name)}: save it to run again, Ctrl+C to stop[/dim]")
            seen = wait_for_change(file, seen)
            err.print(f"[dim]── {escape(file.name)} changed ──[/dim]")
    except KeyboardInterrupt:
        err.print("[dim]stopped watching[/dim]")
        return 0


def _require_source(file: Path) -> None:
    """Fail on a missing or unreadable .imy file before anything is created next to it."""
    read_source(file)


def _version_callback(value: bool) -> None:
    if value:
        out.print(f"imy {__version__}")
        raise typer.Exit()


@app.callback()
def _root(
    version: Annotated[bool, typer.Option("--version", "-V", callback=_version_callback, is_eager=True, help="Show the version.")] = False,
) -> None:
    """Imagenery (IMY)."""


@app.command()
def version() -> None:
    """Show the IMY version."""
    out.print(f"imy {__version__}")


@app.command()
def check(
    file: Annotated[Path, typer.Argument(help="The .imy file to validate.")],
    to: Annotated[Optional[str], typer.Option("--to", "-t", help="Target language (default from config).")] = None,
    static: Annotated[bool, typer.Option("--static", help="Only the free deterministic rules; no model call.")] = False,
    no_cache: NoCacheOpt = False,
    provider: ProviderOpt = None,
    model: ModelOpt = None,
    free_model: FreeModelOpt = None,
) -> None:
    """Run the static rules and the strict model validator. Nothing runs."""
    with guarded():
        provider, model = choose_model(provider, model, free_model)
        _require_source(file)
        session = open_session(file, provider=provider, model=model, ensure=not static)
        if static:
            session.compiler.static_check(parse_file(file))
            out.print(f"[bold green]✓ VALID[/bold green] {escape(file.name)} [dim](static rules only)[/dim]")
            return
        target = to or session.config.default_target
        result = _compile(session, file, target, save_memory=False, use_cache=not no_cache)
        render_valid(result, out, file.name)


@app.command(context_settings={"allow_extra_args": True, "ignore_unknown_options": True})
def run(
    ctx: typer.Context,
    file: Annotated[Path, typer.Argument(help="The .imy file to run. Arguments after -- go to the program.")],
    to: Annotated[Optional[str], typer.Option("--to", "-t", help="Language to compile to (default from config, usually python).")] = None,
    update_memory: UpdateMemoryOpt = False,
    no_cache: NoCacheOpt = False,
    timeout: Annotated[Optional[float], typer.Option("--timeout", help="Stop the program after this many seconds.")] = None,
    detach: Annotated[bool, typer.Option("--detach", help="Run in the background; output goes to a log in .imy/build/.")] = False,
    offline: Annotated[bool, typer.Option("--offline", help="Don't download web resources.")] = False,
    refresh_web: Annotated[bool, typer.Option("--refresh-web", help="Download mirrored web resources again.")] = False,
    show_code: Annotated[bool, typer.Option("--show-code", help="Print the compiled code before running it.")] = False,
    serve: Annotated[bool, typer.Option("--serve", help="For websites: serve the built page on localhost.")] = False,
    port: Annotated[int, typer.Option("--port", help="Port for --serve.")] = 8000,
    watch: Annotated[bool, typer.Option("--watch", help="Run again each time the file is saved (Ctrl+C stops).")] = False,
    provider: ProviderOpt = None,
    model: ModelOpt = None,
    free_model: FreeModelOpt = None,
) -> None:
    """Validate, save new symbols to memory, compile into .imy/build/ and run."""
    code = 0
    with guarded():
        provider, model = choose_model(provider, model, free_model)
        _require_source(file)
        if watch and (detach or serve):
            raise ConfigError("--watch runs the program here each time the file is saved; it can't be combined with --detach or --serve.")
        session = open_session(file, provider=provider, model=model)
        target = to or session.config.default_target

        def once() -> int:
            result = _compile(session, file, target, update_memory=update_memory, use_cache=not no_cache)
            render_memory(result)
            result, artifact, toolchain = build_with_repair(session, result, err)
            downloaded = prepare_virtual_files(result.vfs, session.workspace, offline=offline, refresh=refresh_web)
            for url in downloaded:
                err.print(f"[dim]mirrored {escape(url)}[/dim]")
            if show_code:
                err.print(Syntax(result.code, result.language.name, line_numbers=True, word_wrap=True))
            if result.language.name in ("html", "css"):
                err.print(f"[bold green]✓ built[/bold green] {escape(str(artifact.path))}")
                if serve:
                    err.print(f"Serving http://127.0.0.1:{port}/ (Ctrl+C to stop)")
                    serve_folder(artifact.folder, port)
                return 0
            err.print(f"[dim]▶ {escape(file.name)} ({escape(result.language.name)}, {escape(compile_note(result))})[/dim]")
            assert toolchain is not None
            outcome = start_program(toolchain, artifact, session.workspace, args=list(ctx.args), timeout=timeout, detach=detach)
            if outcome.pid is not None:
                err.print(f"[green]running in the background[/green] (pid {outcome.pid}); output: {escape(str(outcome.log_path))}")
            if outcome.timed_out:
                err.print(f"[yellow]Stopped after {timeout:g} seconds (--timeout).[/yellow]")
            return outcome.exit_code

        code = watch_runs(file, once) if watch else once()
    raise typer.Exit(code)


@app.command()
def convert(
    file: Annotated[Path, typer.Argument(help="The .imy file to convert.")],
    to: Annotated[str, typer.Option("--to", "-t", help="python, javascript, typescript, lua, html, java, rust, go, c, cpp, csharp, ...")],
    output: Annotated[Optional[Path], typer.Option("--output", "-o", help="Write here instead of printing.")] = None,
    save_memory: Annotated[bool, typer.Option("--save-memory", help="Also save this file's symbols to memory.")] = False,
    update_memory: UpdateMemoryOpt = False,
    no_cache: NoCacheOpt = False,
    provider: ProviderOpt = None,
    model: ModelOpt = None,
    free_model: FreeModelOpt = None,
) -> None:
    """Validate and convert to another language, with zero comments and the exact layout."""
    with guarded():
        if output is not None and output.resolve() == file.resolve():
            raise ConfigError("IMY never overwrites your .imy source; pick another --output path.")
        provider, model = choose_model(provider, model, free_model)
        _require_source(file)
        session = open_session(file, provider=provider, model=model)
        result = _compile(session, file, to, save_memory=save_memory or update_memory, update_memory=update_memory, use_cache=not no_cache)
        render_memory(result)
        if output is None:
            sys.stdout.write(result.code)
            sys.stdout.flush()
            return
        try:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(result.code, encoding="utf-8")
        except OSError as exc:
            raise ConfigError(f"Can't write {output}: {exc.strerror or exc}") from exc
        err.print(f"[bold green]✓[/bold green] wrote {escape(str(output))} ({escape(result.language.display)})")


@app.command()
def inject(
    repo_url: Annotated[str, typer.Argument(help="GitHub URL, owner/repo, another .git URL, or a local repository.")],
    target: Annotated[str, typer.Option("--target", help="File inside the repository to inject into.")],
    imy: Annotated[Path, typer.Option("--imy", help="The .imy file to compile and inject.")],
    line: Annotated[Optional[int], typer.Option("--line", help="Insert so the code starts at this line.")] = None,
    anchor: Annotated[Optional[str], typer.Option("--anchor", help="Insert after the line containing this text.")] = None,
    before: Annotated[bool, typer.Option("--before", help="With --anchor: insert before that line instead.")] = False,
    run: Annotated[Optional[str], typer.Option("--run", help="Command to run in the repository afterwards.")] = None,
    to: Annotated[Optional[str], typer.Option("--to", help="Language of the injected code (default: from the file extension).")] = None,
    dest: Annotated[Optional[Path], typer.Option("--dest", help="Clone here instead of .imy/repos/.")] = None,
    branch: Annotated[Optional[str], typer.Option("--branch", help="Branch or tag to clone.")] = None,
    fresh: Annotated[bool, typer.Option("--fresh", help="Delete an earlier clone and clone again.")] = False,
    timeout: Annotated[Optional[float], typer.Option("--timeout", help="Stop the --run command after this many seconds.")] = None,
    update_memory: UpdateMemoryOpt = False,
    no_cache: NoCacheOpt = False,
    provider: ProviderOpt = None,
    model: ModelOpt = None,
    free_model: FreeModelOpt = None,
) -> None:
    """Clone a repository, inject the compiled IMY code into a file, and optionally run it."""
    from .repo_injector import inject as do_inject

    code = 0
    with guarded():
        provider, model = choose_model(provider, model, free_model)
        _require_source(imy)
        session = open_session(imy, provider=provider, model=model)
        session.compiler.static_check(parse_file(imy))
        with working(err, f"Cloning {repo_url} and compiling {imy.name}", hint=SLOW_HINT if session.config.provider == "automa" else ""):
            result = do_inject(
                session.compiler,
                repo_url=repo_url,
                target=target,
                imy_file=imy,
                line=line,
                anchor=anchor,
                before=before,
                to=to,
                destination=dest,
                branch=branch,
                fresh=fresh,
                update_memory=update_memory,
                use_cache=not no_cache,
                run_command=None,
            )
        render_memory(result.compile_result)
        relative = result.target.relative_to(result.repo_dir)
        err.print(
            f"[bold green]✓ injected[/bold green] {len(result.inserted_lines)} line(s) of {escape(result.language.name)} "
            f"into {escape(str(relative))} ({escape(result.point.position)} line {result.point.line}) in {escape(str(result.repo_dir))}"
        )
        if result.diff:
            err.print(Syntax(result.diff, "diff", word_wrap=True))
        if run:
            from .repo_injector import run_in_repo

            err.print(f"[dim]▶ {escape(run)}[/dim]")
            code = run_in_repo(result.repo_dir, run, timeout=timeout)
            colour = "green" if code == 0 else "red"
            err.print(f"[{colour}]exit code {code}[/{colour}]")
    raise typer.Exit(code)


@app.command("console")
def console_command(
    to: Annotated[Optional[str], typer.Option("--to", "-t", help="Language to compile to.")] = None,
    live: Annotated[
        Optional[bool],
        typer.Option("--live/--no-live", help="Convert each line as you enter it, in the background (on by default with Automa's free models)."),
    ] = None,
    provider: ProviderOpt = None,
    model: ModelOpt = None,
    free_model: FreeModelOpt = None,
) -> None:
    """Interactive console: type IMY line by line, see it converted as you go, and :run it."""
    from .console import ImyConsole

    with guarded():
        provider, model = choose_model(provider, model, free_model)
        cwd = Path.cwd()

        def factory(chosen_provider: str | None, chosen_model: str | None) -> Session:
            return open_session(cwd / "console.imy", provider=chosen_provider, model=chosen_model)

        first = factory(provider, model)
        target = to or first.config.default_target
        repl = ImyConsole(lambda p, m: first if (p, m) == (provider, model) else factory(p, m),
                          target=target, console=out, provider=provider, model=model,
                          live=live_by_default(first.config.provider, first.env, sys.stdin.isatty()) if live is None else live)
        repl.loop()


def live_by_default(provider: str, env: EnvView, interactive: bool) -> bool:
    """Whether the console converts each line as it is entered when nobody said either way.

    On with Automa's free models at a real terminal: they cost nothing. Off with
    a key of your own, where every line entered would be a paid request. IMY_LIVE
    (1 or 0) decides for any provider.
    """
    # Only from the real environment: a project's .env must not be able to turn paid requests on.
    wanted = "" if env.origins.get("IMY_LIVE") else (env.get("IMY_LIVE") or "").strip().casefold()
    if wanted in ("1", "true", "yes", "on"):
        return True
    if wanted in ("0", "false", "no", "off"):
        return False
    return interactive and provider == "automa"


def model_rows(config: ImyConfig, env: EnvView) -> list[tuple[str, str, str]]:
    info = PROVIDER_INFO[config.provider]
    current = config.resolved_model()
    rows: list[tuple[str, str]] = [(model_id, model_id) for model_id in info.models]
    if config.provider == "automa":
        bridge = config.resolve_bridge(env)
        if bridge:
            try:
                client = build_client(config, env)
                if isinstance(client, AutomaBridgeClient):
                    listed = client.list_models()
                    if listed:
                        rows = listed
            except ImyError:
                pass
    if current not in [model_id for model_id, _ in rows]:
        rows.insert(0, (current, current))
    return [(model_id, label, "●" if model_id == current else " ") for model_id, label in rows]


# How long one model gets to say its one word during a check.
CHECK_TIMEOUT = 45.0
_STATE_STYLE = {"ok": "green", "not_served": "red"}


def _finding_markup(state: str, text: str) -> str:
    style = _STATE_STYLE.get(state, "yellow")
    mark = "✓" if state == "ok" else "✗" if state == "not_served" else "…"
    return f"[{style}]{mark} {escape(text)}[/{style}]"


def model_lines(config: ImyConfig, env: EnvView) -> list[str]:
    """The model list as markup lines: ● for the one in use, and what the last check or compile found."""
    from .availability import remembered

    found = remembered(imy_home(env.values), config.provider)
    lines = []
    for model_id, label, marker in model_rows(config, env):
        line = f" {marker} {escape(model_id)}"
        if label != model_id:
            line += f"  [dim]{escape(label)}[/dim]"
        if model_id in found:
            state, age = found[model_id]
            from .availability import WORDS

            line += "  " + _finding_markup(state, f"{WORDS.get(state, state)} ({age})")
        lines.append(line)
    return lines


def run_model_check(config: ImyConfig, env: EnvView, console: Console) -> list[Any]:
    """Ask every listed model for one word; print each finding as it arrives, then the count."""
    from .availability import check_models, note_result, summary

    rows = [(model_id, label) for model_id, label, _ in model_rows(config, env)]
    home = imy_home(env.values)
    request = LLMRequest(
        system="You are a connectivity check. Reply with exactly the word OK.",
        messages=(ChatMessage("user", "Reply with OK."),),
        max_output_tokens=4096,
    )
    # One client first: a missing bridge or key is reported once, not once per model.
    build_client(config, env)

    def ask(model_id: str) -> float:
        quick = config.model_copy(update={"model": model_id, "timeout_seconds": min(config.timeout_seconds, CHECK_TIMEOUT)})
        client = build_client(quick, env)
        started = time.monotonic()
        client.complete(request)
        return time.monotonic() - started

    def heard(finding: Any) -> None:
        note_result(home, config.provider, finding.model, finding.state, seconds=finding.seconds)
        text = f"{finding.seconds:.1f} s" if finding.answered else finding.words
        console.print(f"  {_finding_markup(finding.state, text)}  {escape(finding.model)}")

    count = len(rows)
    with working(console, f"Asking {count} model{'' if count == 1 else 's'} for one word"):
        findings = check_models(rows, ask, on_result=heard)
    console.print(escape(summary(findings)))
    return findings


@app.command()
def models(
    provider: ProviderOpt = None,
    check: Annotated[bool, typer.Option("--check", help="Ask every model for one word: which answer now, and how fast.")] = False,
) -> None:
    """List the models IMY knows for a provider (● = in use). --check asks each one whether it answers now."""
    with guarded():
        env = environment(Path.cwd())
        config = load_config(Path.cwd(), env=env, overrides={"provider": provider})
        info = config.info
        out.print(f"[bold]{escape(info.label)}[/bold]")
        if check:
            findings = run_model_check(config, env, out)
            if any(finding.answered for finding in findings):
                flag = "--free-model" if config.provider == "automa" else "--model"
                out.print(f"[dim]Use one for a run with {flag} <id>, or keep it with imy init.[/dim]")
            return
        for line in model_lines(config, env):
            out.print(line)
        if info.notes:
            out.print(f"[dim]{escape(info.notes)}[/dim]")
        out.print("[dim]imy models --check asks each one whether it answers now.[/dim]")


def language_groups() -> tuple[list[str], list[str], list[str], list[str]]:
    """(ready, need a tool, web pages, convert only): the languages IMY knows, by what this machine can do with them."""
    ready: list[str] = []
    missing: list[str] = []
    pages: list[str] = []
    convert_only: list[str] = []
    for language in known_languages():
        if language.name in NOT_RUNNABLE:
            pages.append(language.name)
        elif language.name not in RUNNER_TOOLS:
            convert_only.append(language.name)
        elif runner_tool(language.name):
            ready.append(language.name)
        else:
            missing.append(language.name)
    return ready, missing, pages, convert_only


def render_languages(console: Console, name: str | None = None) -> None:
    """What `imy languages` and the console's :languages print."""
    if name is not None:
        try:
            language = resolve_language(name)
        except ValueError as exc:
            raise ConfigError(f"{name!r} is not a language name.") from exc
        if language.name in NOT_RUNNABLE:
            console.print(f"[bold]{escape(language.display)}[/bold] is built, not run: imy run page.imy --to {escape(language.name)} --serve shows it.")
            return
        if language.name not in RUNNER_TOOLS:
            console.print(
                f"[bold]{escape(language.display)}[/bold] converts: imy convert file.imy --to {escape(language.name)}. "
                "IMY has no runner for it, so run the converted file yourself."
            )
            return
        tool = runner_tool(language.name)
        if tool:
            console.print(f"[green]✓[/green] [bold]{escape(language.display)}[/bold] is ready: it runs with {escape(tool)}.")
        else:
            wanted = RUNNER_TOOLS[language.name][0]
            hint = install_hint(language.name) or f"Install `{wanted}`."
            console.print(f"[red]✗[/red] [bold]{escape(language.display)}[/bold] needs `{escape(wanted)}`. {escape(hint)}")
            console.print(f"[dim]Converting works without it: imy convert file.imy --to {escape(language.name)}[/dim]")
        return
    ready, missing, pages, convert_only = language_groups()
    console.print(f"[bold green]Ready on this machine[/bold green] ({len(ready)}): {escape(', '.join(ready))}")
    if missing:
        console.print(f"[bold]Need a tool installed[/bold] ({len(missing)}): {escape(', '.join(missing))}")
    console.print(f"[bold]Web pages[/bold]: {escape(', '.join(pages))} (built; --serve shows them)")
    if convert_only:
        console.print(f"[bold]Convert only[/bold]: {escape(', '.join(convert_only))}")
    console.print(
        "[dim]Pick one with --to <name> (or :target <name> in the console). imy languages <name> says how to get one "
        "running. Any other language name converts too.[/dim]"
    )


@app.command()
def languages(
    name: Annotated[Optional[str], typer.Argument(help="Say whether this one runs here, and how to get it running.")] = None,
) -> None:
    """List the languages IMY can run on this machine, and the ones that need a tool installed."""
    with guarded():
        render_languages(out, name)


@app.command()
def examples(
    name: Annotated[Optional[str], typer.Argument(help="The example to show. Leave out to list them all.")] = None,
    copy: Annotated[bool, typer.Option("--copy", help="Write the example into this folder as <name>.imy.")] = False,
    every: Annotated[bool, typer.Option("--all", help="With --copy: write every example.")] = False,
    force: Annotated[bool, typer.Option("--force", help="With --copy: replace a file that is already there.")] = False,
) -> None:
    """List the example programs that come with IMY, show one, or copy it into this folder."""
    from .examples import get_example, list_examples

    with guarded():
        if every and not copy:
            raise ConfigError("--all goes with --copy.", hint="imy examples --copy --all writes every example into this folder.")
        if copy:
            if name is None and not every:
                raise ConfigError("Name the example to copy, or add --all.", hint="For instance: imy examples hello --copy")
            chosen = list_examples() if name is None else [get_example(name)]
            targets = [(example, Path.cwd() / f"{example.name}.imy") for example in chosen]
            taken = [path.name for _, path in targets if path.exists()]
            if taken and not force:
                raise ConfigError(
                    f"{', '.join(taken)} already exist{'s' if len(taken) == 1 else ''} here; nothing was written.",
                    hint="Add --force to replace, or copy into another folder.",
                )
            for example, path in targets:
                try:
                    path.write_text(example.text, encoding="utf-8")
                except OSError as exc:
                    raise ConfigError(f"Can't write {path}: {exc.strerror or exc}") from exc
                err.print(f"[bold green]✓[/bold green] wrote {escape(path.name)}")
            first = targets[0][1].name
            err.print(f"Run one with [bold]imy run {escape(first)}[/bold].")
            return
        if name is not None:
            sys.stdout.write(get_example(name).text)
            sys.stdout.flush()
            return
        listing = list_examples()
        if not listing:
            out.print("[dim]This install has no examples.[/dim]")
            return
        width = max(len(example.name) for example in listing)
        for example in listing:
            out.print(f"  [bold]{escape(example.name.ljust(width))}[/bold]  {escape(example.shows)}")
        out.print("[dim]imy examples hello[/dim] shows one, [dim]imy examples hello --copy[/dim] writes hello.imy here, and in the console [dim]:example hello[/dim] loads it.")


def _ask_choice(title: str, options: list[tuple[str, str]], default_value: str) -> str:
    err.print(f"[bold]{escape(title)}[/bold]")
    default_index = 1
    for index, (value, label) in enumerate(options, start=1):
        if value == default_value:
            default_index = index
        err.print(f"  {index}. {escape(label)}")
    while True:
        answer = Prompt.ask("Choose a number, or type a value", default=str(default_index), console=err)
        if answer.isdigit() and 1 <= int(answer) <= len(options):
            return options[int(answer) - 1][0]
        if answer.strip() and not answer.isdigit():
            return answer.strip()
        err.print("[red]Pick one of the numbers.[/red]")


@app.command()
def init(
    provider: Annotated[Optional[str], typer.Option("--provider", help="anthropic, openai, gemini, openai-compatible or automa.")] = None,
    model: Annotated[Optional[str], typer.Option("--model", "-m", help="Model id.")] = None,
    base_url: Annotated[Optional[str], typer.Option("--base-url", help="Server URL for openai-compatible (e.g. http://localhost:11434/v1).")] = None,
    api_key_env: Annotated[Optional[str], typer.Option("--api-key-env", help="Read the key from this environment variable.")] = None,
    api_key_stdin: Annotated[bool, typer.Option("--api-key-stdin", help="Read the key from standard input (never put keys in arguments).")] = False,
    target: Annotated[Optional[str], typer.Option("--target", help="Default language for run/check (python).")] = None,
    local_memory: Annotated[bool, typer.Option("--local-memory", help="Give this project its own memory.json.")] = False,
    no_workspace: Annotated[bool, typer.Option("--no-workspace", help="Don't create .imy/ in this folder.")] = False,
    yes: Annotated[bool, typer.Option("--yes", "-y", help="Accept defaults; ask nothing.")] = False,
) -> None:
    """Set up the provider, model and API key, plus the .imy/ workspace and memory store."""
    with guarded():
        env = environment(Path.cwd())
        stored = load_stored(env.values)
        interactive = sys.stdin.isatty() and not yes and not api_key_stdin
        if provider is not None and provider not in PROVIDERS:
            raise ConfigError(f"Unknown provider {provider!r}.", hint="Use one of: " + ", ".join(PROVIDERS))

        default_provider = provider or ("automa" if env.get("IMY_AUTOMA_BRIDGE") and stored.provider == "anthropic" and not config_file(env.values).exists() else stored.provider)
        chosen = provider or default_provider
        if provider is None and interactive:
            options = [(name, PROVIDER_INFO[name].label) for name in PROVIDERS]
            chosen = _ask_choice("AI provider", options, default_provider)
            if chosen not in PROVIDERS:
                raise ConfigError(f"Unknown provider {chosen!r}.")
        info = PROVIDER_INFO[chosen]

        default_model = model or (stored.model if stored.provider == chosen and stored.model else info.default_model)
        chosen_model = default_model
        if model is None and interactive:
            listing = [(m, m) for m in info.models]
            if chosen == "automa" and env.get("IMY_AUTOMA_BRIDGE"):
                try:
                    probe = build_client(ImyConfig(provider="automa", model=info.default_model), env)
                    if isinstance(probe, AutomaBridgeClient):
                        listing = probe.list_models() or listing
                except ImyError:
                    pass
            if not listing:
                chosen_model = Prompt.ask("Model id", default=default_model, console=err)
            else:
                chosen_model = _ask_choice("Model (or type any model id)", listing, default_model)

        chosen_base = base_url or (stored.base_url if stored.provider == chosen else None)
        if chosen == "openai-compatible" and interactive and base_url is None:
            chosen_base = Prompt.ask("Server URL (its /v1 endpoint)", default=chosen_base or info.default_base_url or "", console=err)

        key_value: Optional[str] = None
        key_env = api_key_env
        if stored.provider == chosen and key_env is None:
            key_value = stored.api_key.get_secret_value() if stored.api_key else None
            key_env = stored.api_key_env
        if api_key_stdin:
            key_value = sys.stdin.readline().strip() or None
            key_env = None
        elif chosen != "automa" and interactive and api_key_env is None:
            found_env = next((name for name in info.key_env if env.get(name)), None)
            options = [
                ("paste", "Paste the key now (saved in ~/.imy/config.json, readable only by you)"),
                ("env", f"Read it from an environment variable{f' ({found_env} is set)' if found_env else ''}"),
                ("keep" if key_value or key_env else "skip", "Keep the current key" if key_value or key_env else "Skip for now"),
            ]
            if not info.needs_key:
                options[2] = ("skip", "No key (local servers usually need none)")
            default_choice = "env" if found_env and not key_value else ("keep" if key_value or key_env else "paste")
            how = _ask_choice("API key", options, default_choice)
            if how == "paste":
                if info.key_url:
                    err.print(f"[dim]Get a key at {escape(info.key_url)}[/dim]")
                key_value = Prompt.ask("Paste your API key (hidden)", password=True, console=err).strip() or None
                key_env = None
            elif how == "env":
                key_env = Prompt.ask("Environment variable name", default=found_env or (info.key_env[0] if info.key_env else "IMY_API_KEY"), console=err)
                key_value = None
            elif how == "skip":
                key_value = None
                key_env = None

        base = stored.model_dump()
        base.update(
            {
                "provider": chosen,
                "model": chosen_model,
                "api_key": key_value,
                "api_key_env": key_env,
                "base_url": chosen_base if chosen == "openai-compatible" else (chosen_base if base_url else None),
            }
        )
        if target:
            base["default_target"] = target
        try:
            config = ImyConfig.model_validate(base)
        except ValueError as exc:
            raise ConfigError(f"Invalid settings: {exc}") from exc
        path = save_config(config, env.values)

        home = imy_home(env.values)
        MemoryStore(home / "memory.json", "global").create()
        workspace_note = "not created (--no-workspace)"
        if not no_workspace:
            workspace = Workspace(Path.cwd())
            workspace.ensure()
            if local_memory:
                MemoryStore(workspace.local_memory, "local").create()
            workspace_note = str(workspace.dot) + (" (with its own memory.json)" if local_memory else "")

        key, source = config.resolve_api_key(environment(Path.cwd()))
        key_note = "not needed" if chosen == "automa" else (f"set ({source})" if key else "not set yet")
        err.print("[bold green]✓ IMY is set up[/bold green]")
        err.print(f"  provider   {escape(config.info.label)}")
        err.print(f"  model      {escape(config.resolved_model())}")
        if config.resolved_base_url() and chosen == "openai-compatible":
            err.print(f"  server     {escape(config.resolved_base_url() or '')}")
        err.print(f"  api key    {escape(key_note)}")
        err.print(f"  config     {escape(str(path))}")
        err.print(f"  memory     {escape(str(home / 'memory.json'))}")
        err.print(f"  workspace  {escape(workspace_note)}")
        if chosen == "automa" and not env.get("IMY_AUTOMA_BRIDGE") and not config.automa_bridge:
            err.print("  [yellow]→ Automa's free models work inside Automa's IMY terminal (it provides the bridge).[/yellow]")
        err.print("Next: write hello.imy and run [bold]imy run hello.imy[/bold], or try [bold]imy console[/bold].")


@app.command()
def doctor(
    ping: Annotated[bool, typer.Option("--ping", help="Send one tiny request to test the key and model.")] = False,
    provider: ProviderOpt = None,
    model: ModelOpt = None,
    free_model: FreeModelOpt = None,
) -> None:
    """Show what IMY will use and check the toolchains (and the key, with --ping)."""
    with guarded():
        provider, model = choose_model(provider, model, free_model)
        session = open_session(Path.cwd() / "doctor.imy", provider=provider, model=model, ensure=False)
        config, env = session.config, session.env
        table = Table(show_header=False, box=None, pad_edge=False)
        table.add_column(style="bold")
        table.add_column()
        table.add_row("imy", f"{__version__} (Python {platform.python_version()}, {escape(sys.executable)})")
        table.add_row("config", escape(str(config_file(env.values))) + ("" if config_file(env.values).exists() else " (not created; run imy init)"))
        table.add_row("provider", escape(config.info.label))
        table.add_row("model", escape(config.resolved_model()))
        if config.resolved_base_url():
            table.add_row("base url", escape(config.resolved_base_url() or ""))
        if config.provider == "automa":
            bridge = config.resolve_bridge(env)
            table.add_row("bridge", "set" if bridge else "[red]missing[/red] (open IMY from Automa's terminals)")
        else:
            key, source = config.resolve_api_key(env)
            table.add_row("api key", f"[green]set[/green] ({escape(source)})" if key else f"[red]missing[/red] ({escape(source)})")
        table.add_row("workspace", escape(str(session.workspace.dot)))
        for store in session.memory.stores():
            try:
                count = len(store.load().symbols)
                table.add_row(f"memory ({store.scope})", f"{escape(str(store.path))}: {count} symbol(s)")
            except ImyError as exc:
                table.add_row(f"memory ({store.scope})", f"[red]{escape(exc.message)}[/red]")
        tools = {
            "python": python_command(),
            "node": shutil.which("node"),
            "lua": shutil.which("lua") or shutil.which("lua5.4"),
            "java": shutil.which("java"),
            "go": shutil.which("go"),
            "rustc": shutil.which("rustc"),
            "cc": shutil.which("cc") or shutil.which("gcc"),
            "git": shutil.which("git"),
        }
        found = [name for name, where in tools.items() if where]
        missing = [name for name, where in tools.items() if not where]
        table.add_row("toolchains", ", ".join(found) + (f"  [dim](missing: {', '.join(missing)})[/dim]" if missing else ""))
        out.print(table)
        if ping:
            client = make_client(config, env)
            with working(err, "Asking the model for a one-word answer"):
                reply = client.complete(
                    LLMRequest(
                        system="You are a connectivity check. Reply with exactly the word OK.",
                        messages=(ChatMessage("user", "Reply with OK."),),
                        max_output_tokens=4096,
                    )
                )
            answer = " ".join(reply.text.split())[:60] or "(empty)"
            out.print(f"[bold green]✓ {escape(reply.provider)} answered[/bold green] with {escape(reply.model)}: {escape(answer)}")


# ── Importing an existing project ────────────────────────────────────────


def _plural(count: int, word: str) -> str:
    if count == 1:
        return f"1 {word}"
    return f"{count} {word[:-1] + 'es' if word.endswith('s') else word + 's'}"


def _found_words(functions: int, classes: int, variables: int) -> str:
    parts = [_plural(count, word) for count, word in ((functions, "function"), (classes, "class"), (variables, "variable")) if count]
    return ", ".join(parts) if parts else "nothing at its top level"


def import_source(session: Session, source: str, console: Console, *, branch: str | None = None, subdir: str | None = None) -> Path:
    """The folder or file to import: ``source`` itself when it is on this machine, else a clone of the repository it names."""
    from .repo_injector import clone_repository, parse_repo_url

    local = Path(source).expanduser()
    remote = "://" in source or re.match(r"^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:", source) is not None
    if local.exists() and not remote:
        if branch or subdir:
            raise ConfigError("--branch and --subdir are for a repository that is cloned; this is a folder on this machine.")
        return local.resolve()
    if not remote:
        raise ConfigError(
            f"There is no file or folder at {source}.",
            hint="To import a repository from the internet, give its address: imy import https://github.com/<owner>/<repo>",
        )
    ref = parse_repo_url(source)
    destination = session.workspace.repos / ref.folder
    with working(console, f"Cloning {ref.display}"):
        clone_repository(ref, destination, branch=branch)
    if not subdir:
        return destination.resolve()
    inside = (destination / subdir.strip().lstrip("/\\")).resolve()
    if destination.resolve() != inside and destination.resolve() not in inside.parents:
        raise ConfigError(f"--subdir {subdir!r} points outside the repository.")
    if not inside.exists():
        raise ConfigError(f"{subdir} does not exist in {ref.display}.")
    return inside


def _local_store(session: Session) -> tuple[Memory, MemoryStore]:
    """This project's own memory (created when missing), and the memory reopened with it."""
    home = imy_home(session.env.values)
    try:
        same = session.workspace.dot.resolve() == home.resolve()
    except OSError:
        same = False
    if same:
        raise ConfigError(
            "This folder's workspace is IMY's own home, so it has no separate project memory.",
            hint="Leave --local out: what is imported here is saved to the one memory there is.",
        )
    session.workspace.ensure()
    store = MemoryStore(session.workspace.local_memory, "local")
    store.create()
    return Memory.open(home, session.workspace.dot), store


def run_import(
    session: Session,
    root: Path,
    console: Console,
    *,
    name: str | None = None,
    max_files: int = 25,
    include_tests: bool = False,
    update: bool = False,
    fresh: bool = False,
    local: bool = False,
    shown: str | None = None,
    hints: bool = True,
) -> int:
    """Read ``root`` and save what it defines to memory, saying what was found. Returns the exit code.

    ``shown`` is the folder as the person named it, for the line that says how to undo the import.
    ``hints`` off ends at what was saved, without the example of using it and the two commands
    that list and undo it (the console's :import).
    """
    from . import importer

    memory, store = _local_store(session) if local else (session.memory, None)
    config = session.config
    model_label = f"{config.provider}/{config.resolved_model()}"
    started: list[contextlib.AbstractContextManager[object]] = []

    def on_model(count: int) -> None:
        console.print(f"[dim]{_plural(count, 'file')} in other languages than Python: {escape(model_label)} reads them (their text is sent to it).[/dim]")
        spinner = working(console, f"Reading {_plural(count, 'file')} with {model_label}", hint=SLOW_HINT if config.provider == "automa" else "")
        spinner.__enter__()
        started.append(spinner)

    def on_read(read: importer.FileRead) -> None:
        where = f"[bold]{escape(read.file.relative)}[/bold] [dim]{escape(read.file.language.display)}[/dim]"
        if read.error is not None:
            console.print(f"[red]✗[/red] {where}  {escape(read.error)}")
            return
        how = {"model": f"  [dim]({escape(read.model or 'model')}, {format_seconds(read.seconds)})[/dim]", "saved": "  [dim](read before, unchanged)[/dim]"}.get(read.how, "")
        console.print(f"[green]✓[/green] {where}  {_found_words(read.count('function'), read.count('class'), read.count('variable'))}{how}")
        for symbol_name, reason in read.skipped:
            console.print(f"    [dim]left out {escape(symbol_name)}: {escape(reason)}[/dim]")

    index = importer.ImportIndex(session.workspace.dot / "imports.json")
    session.workspace.ensure()
    try:
        outcome = importer.import_project(
            root,
            memory=memory,
            index=index,
            config=config,
            client_factory=session.compiler.client,
            project=name,
            max_files=max_files,
            include_tests=include_tests,
            update=update,
            fresh=fresh,
            store=store,
            on_read=on_read,
            on_model=on_model,
        )
    finally:
        for spinner in started:
            spinner.__exit__(None, None, None)
    collected = outcome.collected
    for relative, reason in collected.skipped:
        console.print(f"[dim]- {escape(relative)}: {escape(reason)}[/dim]")
    asides = []
    if collected.left_out:
        asides.append(f"{_plural(collected.left_out, 'more file')} beyond the limit of {max_files} (--max-files raises it)")
    if collected.tests:
        asides.append(f"{_plural(collected.tests, 'test file')} (--include-tests reads them)")
    if asides:
        console.print(f"[dim]Not read: {escape('; '.join(asides))}.[/dim]")
    if not collected.files:
        console.print(f"[yellow]No source files to import in {escape(str(outcome.root))}.[/yellow]")
        return 2
    if outcome.model_error is not None:
        render_error(outcome.model_error, console)
        if outcome.unread:
            console.print(f"[yellow]Not read: {escape(', '.join(file.relative for file in outcome.unread))}. Import again to read them; what was read is kept.[/yellow]")
    report = outcome.report
    if report is None:
        console.print("[yellow]Nothing to save: the files that were read define no functions or variables at their top level.[/yellow]")
        return 3 if outcome.model_error is not None else 0
    scope = "this project's memory" if store is not None or memory.local_store is not None else "memory"
    saved = report.added + report.updated + report.replaced
    parts = []
    if report.added:
        parts.append(f"{len(report.added)} new")
    if report.updated:
        parts.append(f"{len(report.updated)} updated")
    if report.replaced:
        parts.append(f"{len(report.replaced)} replaced (--update-memory)")
    if report.unchanged:
        parts.append(f"{len(report.unchanged)} already saved and unchanged")
    console.print(f"[cyan]Saved to {scope}:[/cyan] {escape(', '.join(parts) or 'nothing')}  [dim]({escape(str(report.store))})[/dim]")
    for diagnostic in report.conflicts:
        console.print(f"[yellow]Not saved:[/yellow] {escape(diagnostic.message)}")
    # The example names something that was saved: a plain function first, then a class, then a variable.
    kept = {symbol.name for symbol in (*saved, *report.unchanged)}
    found = [symbol for symbol in outcome.symbols if symbol.name in kept and not symbol.name.startswith("_")]
    example = next((symbol for what in ("function", "class", "variable") for symbol in found if symbol.what == what), None)
    if example is not None and hints:
        call = example.name if example.what == "variable" else f"{example.name}({', '.join(param.lstrip('*') for param in example.params[:3])})"
        console.print("Use them by name in a .imy file, for example:")
        console.print(f"  [green]show ({escape(call)})[/green]")
        console.print(f"[dim]imy memory list shows everything saved; imy import {escape(shown or str(root))} --forget removes this import.[/dim]")
    return 3 if outcome.model_error is not None else 0


@app.command("import")
def import_command(
    source: Annotated[str, typer.Argument(help="A folder or file on this machine, or the address of a git repository.")],
    name: Annotated[Optional[str], typer.Option("--name", help="What to call the project in the saved meanings (default: the folder's name).")] = None,
    max_files: Annotated[int, typer.Option("--max-files", min=1, max=500, help="Read at most this many source files, the shallowest first.")] = 25,
    include_tests: Annotated[bool, typer.Option("--include-tests", help="Also read test files and test folders.")] = False,
    update_memory: UpdateMemoryOpt = False,
    fresh: Annotated[bool, typer.Option("--fresh", help="Read every file again, also the ones that have not changed.")] = False,
    local: Annotated[bool, typer.Option("--local", help="Save into this project's own memory (.imy/memory.json), creating it.")] = False,
    dry_run: Annotated[bool, typer.Option("--dry-run", help="List the files that would be read, and which the model would see. Reads and saves nothing.")] = False,
    forget: Annotated[bool, typer.Option("--forget", help="Remove what an earlier import of this folder or file saved.")] = False,
    branch: Annotated[Optional[str], typer.Option("--branch", help="For a repository address: the branch or tag to clone.")] = None,
    subdir: Annotated[Optional[str], typer.Option("--subdir", help="For a repository address: import only this folder inside it.")] = None,
    provider: ProviderOpt = None,
    model: ModelOpt = None,
    free_model: FreeModelOpt = None,
) -> None:
    """Bring an existing project in: its functions and variables are saved to memory, for .imy files to use by name."""
    from . import importer

    code = 0
    with guarded():
        provider, model = choose_model(provider, model, free_model)
        session = open_session(Path.cwd() / "import.imy", provider=provider, model=model)
        root = import_source(session, source, err, branch=branch, subdir=subdir)
        if forget:
            removed = session.memory.forget_imported(root)
            index = importer.ImportIndex(session.workspace.dot / "imports.json")
            index.drop(root)
            index.save()
            if removed:
                out.print(f"[green]removed[/green] {_plural(len(removed), 'saved definition')} that came from {escape(str(root))}")
            else:
                out.print(f"[dim]Nothing saved came from {escape(str(root))}.[/dim]")
            raise typer.Exit(0)
        if dry_run:
            collected = importer.collect(root, max_files=max_files, include_tests=include_tests)
            config = session.config
            out.print(f"Would read {_plural(len(collected.files), 'file')} from {escape(str(collected.root))}:")
            for file in collected.files:
                how = "read here, by Python's own parser" if file.language.name == "python" else f"read by {config.provider}/{config.resolved_model()} (its text is sent to that model)"
                out.print(f"  [bold]{escape(file.relative)}[/bold] [dim]{escape(file.language.display)}[/dim]  {escape(how)}")
            for relative, reason in collected.skipped:
                out.print(f"[dim]- {escape(relative)}: {escape(reason)}[/dim]")
            asides = [text for count, text in (
                (collected.left_out, f"{_plural(collected.left_out, 'file')} beyond --max-files {max_files}"),
                (collected.tests, _plural(collected.tests, "test file")),
                (collected.other, f"{_plural(collected.other, 'other file')} (not source code)"),
            ) if count]
            if asides:
                out.print(f"[dim]Not read: {escape('; '.join(asides))}.[/dim]")
            out.print("[dim]Nothing was read or saved.[/dim]")
            raise typer.Exit(0)
        code = run_import(
            session, root, out, name=name, max_files=max_files, include_tests=include_tests, update=update_memory, fresh=fresh,
            local=local, shown=source,
        )
    raise typer.Exit(code)


def _open_memory(project: Path) -> Memory:
    workspace = Workspace.discover(project / "anchor.imy", home=imy_home())
    return Memory.open(imy_home(), workspace.dot)


def _scope(value: str) -> Optional[str]:
    if value not in ("all", "global", "local"):
        raise ConfigError("--scope must be all, global or local.")
    return None if value == "all" else value


@memory_app.command("list")
def memory_list(
    kind: Annotated[Optional[str], typer.Option("--kind", help="variable, variable_pack, function, syntax_rule or virtual_path.")] = None,
    scope: Annotated[str, typer.Option("--scope", help="all, global or local.")] = "all",
    project: Annotated[Path, typer.Option("--project", help="Project folder (for its local memory).")] = Path("."),
) -> None:
    """List saved symbols."""
    with guarded():
        wanted = _scope(scope)
        memory = _open_memory(project)
        rows = [(s, sym) for s, sym in memory.entries() if (wanted is None or s == wanted) and (kind is None or sym.kind.value == kind)]
        if not rows:
            out.print("[dim]Memory is empty.[/dim]" if kind is None else f"[dim]No {escape(kind)} symbols saved.[/dim]")
            return
        table = Table(title="IMY memory", show_lines=False)
        table.add_column("name", style="bold")
        table.add_column("kind")
        table.add_column("meaning", overflow="fold")
        table.add_column("from")
        table.add_column("scope", style="dim")
        for store_scope, symbol in rows:
            came_from = f"{symbol.origin_label} ({resolve_language(symbol.language).display})" if symbol.language else symbol.origin_label
            table.add_row(escape(symbol.name), symbol.kind.value, escape(symbol.meaning), escape(came_from), store_scope)
        out.print(table)


@memory_app.command("show")
def memory_show(
    name: Annotated[str, typer.Argument(help="Symbol name.")],
    project: Annotated[Path, typer.Option("--project", help="Project folder (for its local memory).")] = Path("."),
) -> None:
    """Show everything saved for a symbol."""
    with guarded():
        matches = _open_memory(project).find(name)
        if not matches:
            err.print(f"[yellow]Nothing named {escape(name)} is saved.[/yellow]")
            raise typer.Exit(1)
        for store_scope, symbol in matches:
            out.print(f"[bold]{escape(symbol.name)}[/bold] [dim]({symbol.kind.value}, {store_scope} memory)[/dim]")
            out.print(f"  meaning   {escape(symbol.meaning)}")
            if symbol.members:
                out.print(f"  members   {escape(', '.join(symbol.members))}")
            out.print(f"  from      {escape(symbol.origin)} line {symbol.origin_line}")
            if symbol.language:
                out.print(f"  imported  {escape(resolve_language(symbol.language).display)} code, brought in with imy import")
            if symbol.uses:
                out.print(f"  needs     {escape(', '.join(symbol.uses))}")
            out.print(f"  saved     {escape(symbol.created_at)} (updated {escape(symbol.updated_at)})")
            out.print("  defined as:")
            out.print(Syntax(symbol.source_fragment or "", symbol.language or "text", word_wrap=True))


@memory_app.command("delete")
def memory_delete(
    name: Annotated[str, typer.Argument(help="Symbol name.")],
    file: Annotated[Optional[Path], typer.Option("--file", help="Only the entry saved from this .imy file.")] = None,
    scope: Annotated[str, typer.Option("--scope", help="all, global or local.")] = "all",
    yes: Annotated[bool, typer.Option("--yes", "-y", help="Don't ask for confirmation.")] = False,
    project: Annotated[Path, typer.Option("--project", help="Project folder (for its local memory).")] = Path("."),
) -> None:
    """Delete a saved symbol."""
    with guarded():
        memory = _open_memory(project)
        wanted = _scope(scope)
        matches = [m for m in memory.find(name) if (wanted is None or m[0] == wanted)]
        if file is not None:
            target = str(file.resolve())
            matches = [m for m in matches if m[1].origin == target]
        if not matches:
            err.print(f"[yellow]Nothing named {escape(name)} is saved.[/yellow]")
            raise typer.Exit(1)
        if not yes and sys.stdin.isatty() and not Confirm.ask(f"Delete {len(matches)} saved symbol(s) named {escape(name)}?", console=err, default=False):
            err.print("Kept.")
            return
        removed = memory.delete(name, scope=wanted, origin=str(file.resolve()) if file else None)  # type: ignore[arg-type]
        err.print(f"[green]deleted[/green] {len(removed)} symbol(s) named {escape(name)}")


@memory_app.command("clear")
def memory_clear(
    scope: Annotated[str, typer.Option("--scope", help="all, global or local.")] = "all",
    cache: Annotated[bool, typer.Option("--cache", help="Also clear this project's compile cache.")] = False,
    yes: Annotated[bool, typer.Option("--yes", "-y", help="Don't ask for confirmation.")] = False,
    project: Annotated[Path, typer.Option("--project", help="Project folder (for its local memory).")] = Path("."),
) -> None:
    """Forget every saved symbol (in one scope or all)."""
    with guarded():
        wanted = _scope(scope)
        workspace = Workspace.discover(project / "anchor.imy", home=imy_home())
        memory = Memory.open(imy_home(), workspace.dot)
        if not yes:
            if not sys.stdin.isatty():
                raise ConfigError("Refusing to clear memory without confirmation.", hint="Add --yes.")
            if not Confirm.ask(f"Forget every saved symbol ({scope})?", console=err, default=False):
                err.print("Kept.")
                return
        count = memory.clear(wanted)  # type: ignore[arg-type]
        err.print(f"[green]cleared[/green] {count} symbol(s)")
        if cache:
            from .memory import CompileCache

            removed = CompileCache(workspace.cache).clear()
            err.print(f"[green]cleared[/green] {removed} cached compile(s)")


def main() -> None:
    try:
        app()
    except ImyError as exc:
        render_error(exc)
        raise SystemExit(exc.exit_code) from None
    except KeyboardInterrupt:
        err.print("[yellow]Stopped.[/yellow]")
        raise SystemExit(130) from None
    except Exception as exc:
        if os.environ.get("IMY_DEBUG"):
            raise
        err.print(f"[bold red]✗ Internal error:[/bold red] {escape(type(exc).__name__)}: {escape(str(exc))}")
        err.print("  [yellow]→ Run again with IMY_DEBUG=1 for the full traceback.[/yellow]")
        raise SystemExit(70) from None


if __name__ == "__main__":
    main()
