"""`imy console`: type IMY line by line, then :check, :run or :convert it.

The buffer lives in memory and in ``.imy/console/console.imy`` (IMY's own
scratch file). Files you :load are only read; :save writes only where you say.
"""

from __future__ import annotations

import contextlib
import shlex
import subprocess
from collections.abc import Callable
from pathlib import Path

from rich.console import Console
from rich.markup import escape
from rich.syntax import Syntax

from . import __version__
from .compiler import CompileOptions, CompileResult
from .errors import CompilationFailed, ImyError
from .languages import resolve_language
from .parser import parse_header
from .progress import working
from .runner import build_artifact, run_artifact
from .workspace import prepare_virtual_files

HELP = """[bold]Type IMY code line by line[/bold], starting with a header such as
  # ("prints a greeting with the user's name")
Then use a command:
  :run [args]        validate, compile and run the code (saves new symbols to memory)
  :check             validate only (rules + AI validator), nothing runs
  :convert <lang> [file]   show the code in another language, or write it to a file
  :header <words>    write the header line for you:  :header prints a greeting by name
  :examples          list the ready programs              :example <name>  load one
  :show              list the code with line numbers      :code   show the last compiled code
  :undo              remove the last line                 :del N  remove line N
  :edit N <text>     replace line N                       :insert N <text>  insert before line N
  :clear             start over                           :load <file>  read an .imy file
  :save <file>       write the code to a file (:save! overwrites)
  :target <lang>     compile to another language (now: {target})
  :provider <name>   switch provider for this session     :model <id>   switch model
  :models            list models and what was last found  :models check  ask each if it answers now
  :memory            list saved symbols
  :help              this help                            :quit    leave (or Ctrl+D)
  !<command>         run a shell command, e.g. !ls"""

# Commands whose text is code or plain words, kept exactly as typed: quotes need no closing
# and the spaces that indent a line stay.
RAW_COMMANDS = frozenset({"edit", "insert", "header"})


class ImyConsole:
    def __init__(
        self,
        session_factory: Callable[[str | None, str | None], object],
        *,
        target: str,
        console: Console,
        input_fn: Callable[[str], str] = input,
        provider: str | None = None,
        model: str | None = None,
    ) -> None:
        self._session_factory = session_factory
        self._provider = provider
        self._model = model
        self.session = session_factory(provider, model)
        self.target = target
        self.console = console
        self._input = input_fn
        self.lines: list[str] = []
        self.last: CompileResult | None = None
        self.workspace = self.session.workspace
        self.scratch = self.workspace.console / "console.imy"
        self._history: Path | None = None
        self._setup_history()

    def _setup_history(self) -> None:
        try:
            import readline
        except ImportError:
            return
        self._history = self.workspace.console / "history"
        with contextlib.suppress(OSError):
            self.workspace.console.mkdir(parents=True, exist_ok=True)
            if self._history.exists():
                readline.read_history_file(str(self._history))
        readline.set_history_length(2000)

    def _save_history(self) -> None:
        if self._history is None:
            return
        try:
            import readline
        except ImportError:
            return
        with contextlib.suppress(OSError):
            readline.write_history_file(str(self._history))

    def banner(self) -> None:
        config = self.session.config
        self.console.print(
            f"[bold cyan]IMY console[/bold cyan] {__version__} · {escape(config.provider)}/"
            f"{escape(config.resolved_model())} · target [bold]{escape(self.target)}[/bold]"
        )
        self.console.print('1. Say what you are building: [green]# ("what it builds and how it works")[/green]')
        self.console.print("   or let IMY write that line: [bold]:header[/bold] what it builds and how it works")
        self.console.print("2. Code every step under it, line by line, in your own syntax.")
        self.console.print("3. [bold]:run[/bold] it. [bold]:example hello[/bold] loads a ready program, [bold]:help[/bold] lists everything.")

    def loop(self) -> int:
        self.banner()
        try:
            while True:
                try:
                    text = self._input(f"{len(self.lines) + 1:>3} imy> ")
                except EOFError:
                    self.console.print()
                    break
                except KeyboardInterrupt:
                    self.console.print()
                    continue
                try:
                    if text.startswith(":"):
                        if not self.command(text[1:].strip()):
                            break
                        continue
                    if text.startswith("!"):
                        self.shell(text[1:].strip())
                        continue
                except KeyboardInterrupt:
                    # Ctrl+C stops the compile or command in progress, not the console.
                    self.console.print("[yellow]Stopped.[/yellow]")
                    continue
                if not text.strip() and not self.lines:
                    continue
                self.lines.append(text.rstrip("\r\n"))
        finally:
            self._save_history()
        return 0

    def source(self) -> str:
        return "\n".join(self.lines) + "\n"

    def _write_scratch(self) -> Path:
        self.workspace.console.mkdir(parents=True, exist_ok=True)
        self.scratch.write_text(self.source(), encoding="utf-8")
        return self.scratch

    def _compile(self, target: str, *, save_memory: bool) -> CompileResult | None:
        if not self.lines:
            self.console.print("[yellow]Nothing to compile yet: type a header and some code first.[/yellow]")
            return None
        from .cli import render_failure, render_error

        from .cli import SLOW_HINT, compile_note

        path = self._write_scratch()
        config = self.session.config
        try:
            with working(self.console, f"Compiling to {target}", hint=SLOW_HINT if config.provider == "automa" else ""):
                result = self.session.compiler.compile_file(
                    path, CompileOptions(target=target, save_memory=save_memory, run_dir=Path.cwd())
                )
        except CompilationFailed as exc:
            render_failure(exc, self.console)
            return None
        except ImyError as exc:
            render_error(exc, self.console)
            return None
        self.last = result
        self.console.print(f"[dim]compiled to {escape(result.language.name)} ({escape(compile_note(result))})[/dim]")
        return result

    def command(self, text: str) -> bool:
        stripped = text.strip()
        if not stripped:
            return True
        name = stripped.split(None, 1)[0].lower()
        # What follows the command name, as typed (the space after the name aside).
        rest = stripped[len(name) :]
        rest = rest[1:] if rest[:1] in (" ", "\t") else rest
        if name in RAW_COMMANDS:
            # Code and plain words: an apostrophe is not an unclosed quote, and indentation counts.
            first = rest.split(None, 1)
            args = first[:1]
            raw_rest = rest
        else:
            try:
                args = shlex.split(rest)
            except ValueError as exc:
                self.console.print(f"[red]{escape(str(exc))}[/red] (put a file name with spaces in quotes)")
                return True
            raw_rest = rest.strip()
        handler = {
            "q": self._quit, "quit": self._quit, "exit": self._quit,
            "help": self._help, "h": self._help, "?": self._help,
            "show": self._show, "list": self._show, "ls": self._show,
            "undo": self._undo, "del": self._delete, "edit": self._edit, "insert": self._insert_line,
            "clear": self._clear, "new": self._clear,
            "load": self._load, "save": self._save, "save!": self._save_force,
            "target": self._target, "to": self._target,
            "provider": self._provider_cmd, "model": self._model_cmd, "models": self._models,
            "memory": self._memory, "code": self._code,
            "check": self._check, "run": self._run, "convert": self._convert,
            "header": self._header, "examples": self._examples, "example": self._example,
        }.get(name)
        if handler is None:
            self.console.print(f"[red]Unknown command :{escape(name)}[/red] (type :help)")
            return True
        return handler(args, raw_rest)

    def _quit(self, args: list[str], raw: str) -> bool:
        return False

    def _help(self, args: list[str], raw: str) -> bool:
        self.console.print(HELP.format(target=escape(self.target)))
        return True

    def _show(self, args: list[str], raw: str) -> bool:
        if not self.lines:
            self.console.print("[dim](empty)[/dim]")
        for number, line in enumerate(self.lines, start=1):
            self.console.print(f"[dim]{number:>3} |[/dim] {escape(line)}")
        return True

    def _undo(self, args: list[str], raw: str) -> bool:
        if self.lines:
            removed = self.lines.pop()
            self.console.print(f"[dim]removed: {escape(removed)}[/dim]")
        return True

    def _line_number(self, value: str, *, allow_end: bool = False) -> int | None:
        try:
            number = int(value)
        except ValueError:
            self.console.print(f"[red]{escape(value)} is not a line number[/red]")
            return None
        limit = len(self.lines) + (1 if allow_end else 0)
        if not 1 <= number <= limit:
            self.console.print(f"[red]Line {number} doesn't exist (1 to {limit}).[/red]")
            return None
        return number

    def _delete(self, args: list[str], raw: str) -> bool:
        if len(args) != 1:
            self.console.print("Usage: :del N")
            return True
        number = self._line_number(args[0])
        if number is not None:
            removed = self.lines.pop(number - 1)
            self.console.print(f"[dim]removed line {number}: {escape(removed)}[/dim]")
        return True

    def _edit(self, args: list[str], raw: str) -> bool:
        if not args:
            self.console.print("Usage: :edit N <new text>")
            return True
        number = self._line_number(args[0])
        if number is not None:
            self.lines[number - 1] = self._text_after_number(raw, args[0])
        return True

    def _insert_line(self, args: list[str], raw: str) -> bool:
        if not args:
            self.console.print("Usage: :insert N <text>")
            return True
        number = self._line_number(args[0], allow_end=True)
        if number is not None:
            self.lines.insert(number - 1, self._text_after_number(raw, args[0]))
        return True

    @staticmethod
    def _text_after_number(raw: str, number: str) -> str:
        """The line typed after `:edit N ` or `:insert N `: one space separates, the rest is the line's own."""
        text = raw.lstrip()[len(number) :]
        return text[1:] if text[:1] in (" ", "\t") else text

    def _header(self, args: list[str], raw: str) -> bool:
        words = " ".join(raw.split())
        if not words:
            self.console.print("Usage: :header <what this code builds and how it works>")
            return True
        if words.startswith("#"):
            line = words
        else:
            line = '# ("' + words.replace("\\", "\\\\").replace('"', '\\"') + '")'
        described, problem = parse_header(line)
        if described is None:
            self.console.print(f"[red]{escape(problem or 'that is not a header')}[/red]")
            return True
        if self.lines and self.lines[0].lstrip().startswith("#"):
            self.lines[0] = line
            self.console.print(f"[dim]header replaced:[/dim] {escape(line)}")
        else:
            self.lines.insert(0, line)
            self.console.print(f"[dim]header set:[/dim] {escape(line)}")
        return True

    def _examples(self, args: list[str], raw: str) -> bool:
        from .examples import list_examples

        if args:
            return self._example(args, raw)
        listing = list_examples()
        if not listing:
            self.console.print("[dim]This install has no examples.[/dim]")
            return True
        width = max(len(example.name) for example in listing)
        for example in listing:
            self.console.print(f"  [bold]{escape(example.name.ljust(width))}[/bold]  {escape(example.shows)}")
        self.console.print("[dim]:example <name> loads one here; then :show it or :run it.[/dim]")
        return True

    def _example(self, args: list[str], raw: str) -> bool:
        from .examples import get_example

        if len(args) != 1:
            return self._examples([], raw)
        try:
            example = get_example(args[0])
        except ImyError as exc:
            self.console.print(f"[red]{escape(exc.message)}[/red]" + (f" {escape(exc.hint)}" if exc.hint else ""))
            return True
        replaced = len(self.lines)
        self.lines = example.lines
        self.last = None
        note = f" (it replaced the {replaced} line{'' if replaced == 1 else 's'} you had)" if replaced else ""
        self.console.print(f"[dim]loaded {escape(example.name)}: {len(self.lines)} lines{note}[/dim]")
        for number, line in enumerate(self.lines, start=1):
            self.console.print(f"[dim]{number:>3} |[/dim] {escape(line)}")
        return True

    def _clear(self, args: list[str], raw: str) -> bool:
        self.lines = []
        self.last = None
        self.console.print("[dim]cleared[/dim]")
        return True

    def _load(self, args: list[str], raw: str) -> bool:
        if len(args) != 1:
            self.console.print("Usage: :load <file.imy>")
            return True
        from .parser import read_source

        try:
            text = read_source(Path(args[0]).expanduser())
        except ImyError as exc:
            self.console.print(f"[red]{escape(exc.message)}[/red]")
            return True
        self.lines = text.replace("\r\n", "\n").rstrip("\n").split("\n")
        self.console.print(f"[dim]loaded {len(self.lines)} lines (the file itself is never changed)[/dim]")
        return True

    def _write_to(self, target: Path, *, force: bool) -> None:
        if target.exists() and not force:
            self.console.print(f"[yellow]{escape(str(target))} exists; use :save! to overwrite it.[/yellow]")
            return
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(self.source(), encoding="utf-8")
        except OSError as exc:
            self.console.print(f"[red]Can't write {escape(str(target))}: {escape(exc.strerror or str(exc))}[/red]")
            return
        self.console.print(f"[green]saved {escape(str(target))}[/green]")

    def _save(self, args: list[str], raw: str) -> bool:
        if len(args) != 1:
            self.console.print("Usage: :save <file.imy>")
            return True
        self._write_to(Path(args[0]).expanduser(), force=False)
        return True

    def _save_force(self, args: list[str], raw: str) -> bool:
        if len(args) != 1:
            self.console.print("Usage: :save! <file.imy>")
            return True
        self._write_to(Path(args[0]).expanduser(), force=True)
        return True

    def _target(self, args: list[str], raw: str) -> bool:
        if len(args) != 1:
            self.console.print(f"Target: {escape(self.target)} (change with :target <lang>)")
            return True
        try:
            self.target = resolve_language(args[0]).name
        except ValueError:
            self.console.print(f"[red]{escape(args[0])} is not a language name[/red]")
            return True
        self.console.print(f"target is now [bold]{escape(self.target)}[/bold]")
        return True

    def _reopen(self) -> None:
        try:
            self.session = self._session_factory(self._provider, self._model)
        except ImyError as exc:
            self.console.print(f"[red]{escape(exc.message)}[/red]")
            return
        config = self.session.config
        self.console.print(f"now using {escape(config.provider)}/{escape(config.resolved_model())} (run `imy init` to save it)")

    def _provider_cmd(self, args: list[str], raw: str) -> bool:
        from .config import PROVIDERS

        if len(args) != 1 or args[0] not in PROVIDERS:
            self.console.print("Usage: :provider " + " | ".join(PROVIDERS))
            return True
        self._provider = args[0]
        self._model = None
        self._reopen()
        return True

    def _model_cmd(self, args: list[str], raw: str) -> bool:
        if len(args) != 1:
            self.console.print(f"Model: {escape(self.session.config.resolved_model())} (change with :model <id>)")
            return True
        self._model = args[0]
        self._reopen()
        return True

    def _models(self, args: list[str], raw: str) -> bool:
        from .cli import model_lines, render_error, run_model_check

        if args and args[0].lower() == "check":
            try:
                run_model_check(self.session.config, self.session.env, self.console)
            except ImyError as exc:
                render_error(exc, self.console)
            else:
                self.console.print("[dim]:model <id> switches to one of them.[/dim]")
            return True
        if args:
            self.console.print("Usage: :models   or   :models check")
            return True
        for line in model_lines(self.session.config, self.session.env):
            self.console.print(" " + line)
        self.console.print("[dim]:models check asks each one whether it answers now.[/dim]")
        return True

    def _memory(self, args: list[str], raw: str) -> bool:
        try:
            entries = self.session.memory.entries()
        except ImyError as exc:
            self.console.print(f"[red]{escape(exc.message)}[/red]")
            return True
        if not entries:
            self.console.print("[dim]memory is empty[/dim]")
        for scope, symbol in entries:
            self.console.print(f"  {escape(symbol.name)} [dim]({symbol.kind.value}, {scope}, {escape(symbol.origin_label)})[/dim]: {escape(symbol.meaning)}")
        return True

    def _code(self, args: list[str], raw: str) -> bool:
        if self.last is None:
            self.console.print("[dim]Nothing compiled yet.[/dim]")
            return True
        self.console.print(Syntax(self.last.code, self.last.language.name, line_numbers=True, word_wrap=True))
        return True

    def _check(self, args: list[str], raw: str) -> bool:
        result = self._compile(self.target, save_memory=False)
        if result is not None:
            from .cli import render_valid

            render_valid(result, self.console, "console")
        return True

    def _run(self, args: list[str], raw: str) -> bool:
        result = self._compile(self.target, save_memory=True)
        if result is None:
            return True
        from .cli import render_error, render_memory

        render_memory(result, self.console)
        try:
            artifact = build_artifact(result, self.workspace, stem="console", run_dir=Path.cwd())
            prepare_virtual_files(result.vfs, self.workspace)
            if result.language.name in ("html", "css"):
                self.console.print(f"[green]built[/green] {escape(str(artifact.path))}")
                return True
            outcome = run_artifact(artifact, self.workspace, args=args)
        except ImyError as exc:
            render_error(exc, self.console)
            return True
        colour = "green" if outcome.exit_code == 0 else "red"
        self.console.print(f"[{colour}]exit code {outcome.exit_code}[/{colour}]")
        return True

    def _convert(self, args: list[str], raw: str) -> bool:
        if not args:
            self.console.print("Usage: :convert <lang> [output file]")
            return True
        result = self._compile(args[0], save_memory=False)
        if result is None:
            return True
        if len(args) > 1:
            target = Path(args[1]).expanduser()
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(result.code, encoding="utf-8")
            except OSError as exc:
                self.console.print(f"[red]Can't write {escape(str(target))}: {escape(exc.strerror or str(exc))}[/red]")
                return True
            self.console.print(f"[green]wrote {escape(str(target))}[/green]")
        else:
            self.console.print(Syntax(result.code, result.language.name, line_numbers=False, word_wrap=True))
        return True

    def shell(self, command: str) -> None:
        if not command:
            self.console.print("Usage: !<shell command>")
            return
        try:
            subprocess.run(command, shell=True, check=False)
        except KeyboardInterrupt:
            self.console.print()
        except OSError as exc:
            self.console.print(f"[red]{escape(exc.strerror or str(exc))}[/red]")
