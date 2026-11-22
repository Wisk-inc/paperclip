"""`imy console`: type IMY line by line, then :check, :run or :convert it.

The buffer lives in memory and in ``.imy/console/console.imy`` (IMY's own
scratch file). Files you :load are only read; :save writes only where you say.
"""

from __future__ import annotations

import contextlib
import shlex
import subprocess
import threading
from collections.abc import Callable
from pathlib import Path

from rich.console import Console
from rich.markup import escape
from rich.syntax import Syntax

from . import __version__
from .compiler import CompileOptions, CompileResult
from .errors import CompilationFailed, Diagnostic, ErrorCode, ImyError, LLMRateLimitError
from .languages import resolve_language
from .live import LiveJob, LiveOutcome, LivePreview, changed_lines
from .parser import parse_header, parse_text
from .progress import format_seconds, working
from .runner import start_program
from .workspace import prepare_virtual_files

# The console's commands, one per row: on a phone's narrow terminal each description wraps
# inside its own column instead of running into the next command.
HELP_INTRO = '[bold]Type IMY code line by line[/bold], starting with a header such as [green]# ("prints a greeting by name")[/green]. Then use a command:'
HELP_ROWS: tuple[tuple[str, str], ...] = (
    (":run [args]", "validate, compile and run the code (saves new symbols to memory)"),
    (":check", "validate only (rules + AI validator), nothing runs"),
    (":convert <lang> [file]", "show the code in another language, or write it to a file"),
    (":header <words>", "write the header line for you:  :header prints a greeting by name"),
    (":examples", "list the ready programs"),
    (":example <name>", "load one of them"),
    (":show", "list the code with line numbers"),
    (":code", "show the last compiled code"),
    (":undo", "remove the last line"),
    (":del N", "remove line N"),
    (":edit N <text>", "replace line N"),
    (":insert N <text>", "insert before line N"),
    (":clear", "start over"),
    (":load <file>", "read an .imy file"),
    (":save <file>", "write the code to a file (:save! overwrites)"),
    (":target <lang>", "compile to another language (now: {target})"),
    (":languages", "the languages IMY knows, and which run on this machine"),
    (":live on|off", "convert each line as you enter it, in the background (now: {live})"),
    (":provider <name>", "switch provider for this session"),
    (":model <id>", "switch model"),
    (":models", "list models and what was last found"),
    (":models check", "ask each model if it answers now"),
    (":memory", "list saved symbols"),
    (":import <folder>", "bring an existing project in: its functions and variables can then be used by name"),
    (":help", "this help"),
    (":quit", "leave (or Ctrl+D)"),
    ("!<command>", "run a shell command, e.g. !ls"),
)

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
        live: bool = False,
        live_inline: bool = False,
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
        self._readline: object | None = None
        self._setup_history()
        # Live conversion: each line entered is converted in the background (see live.py).
        self.live_on = live
        # Convert in step with the typing instead of in the background (tests, piped input).
        self._live_inline = live_inline
        self._live = LivePreview(convert=self._live_convert, deliver=self._live_deliver)
        # Who may write to the screen: the command being run, or a live result.
        self._screen = threading.RLock()
        self._at_prompt = False
        self._prompt = ""
        self._held: list[LiveOutcome] = []
        self._preview_lines: list[str] = []
        self._shown_problems: set[tuple[str, int, str]] = set()
        self._busy_noted = False

    def _setup_history(self) -> None:
        try:
            import readline
        except ImportError:
            return
        self._readline = readline
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
        # Wrapped by word at the terminal's own width: a phone shows about 55 columns.
        say = lambda text: self.console.print(text, soft_wrap=False)  # noqa: E731
        say('1. Say what you are building: [green]# ("what it builds and how it works")[/green]')
        say("   or let IMY write that line: [bold]:header[/bold] what it builds and how it works")
        say("2. Code every step under it, line by line, in your own syntax.")
        say("3. [bold]:run[/bold] it. [bold]:example hello[/bold] loads a ready program, [bold]:help[/bold] lists everything.")
        other = "rust" if self.target != "rust" else "python"
        say(
            f"   It becomes {escape(self.target)}. [bold]:target {other}[/bold] picks another language, "
            "[bold]:languages[/bold] lists them all."
        )
        if self.live_on:
            say(
                f"[dim]Live: each line you enter is converted to {escape(self.target)} in the background and shown as it "
                "arrives. :live off stops it.[/dim]"
            )
        elif config.provider != "automa":
            say("[dim]Live conversion is off, as every line would use your key. :live on turns it on.[/dim]")

    def loop(self) -> int:
        self.banner()
        try:
            while True:
                self._show_held()
                prompt = f"{len(self.lines) + 1:>3} imy> "
                with self._screen:
                    self._prompt = prompt
                    self._at_prompt = True
                try:
                    text = self._input(prompt)
                except EOFError:
                    self.console.print()
                    break
                except KeyboardInterrupt:
                    self.console.print()
                    continue
                finally:
                    with self._screen:
                        self._at_prompt = False
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
                self._buffer_changed()
        finally:
            self._live.close()
            self._save_history()
        return 0

    # ── Live conversion ──────────────────────────────────────────────────

    def _buffer_changed(self, *, fresh: bool = False) -> None:
        """A line was entered or edited: check it at once, then convert the buffer in the background.

        ``fresh`` means the buffer was replaced (cleared, loaded, an example): what was shown
        for the old one no longer applies.
        """
        if fresh:
            self._live.forget()
            self._preview_lines = []
            self._shown_problems.clear()
        if not self.live_on or not any(line.strip() for line in self.lines):
            return
        # The free checks need no model: a line that breaks a rule is reported as soon as it is entered.
        try:
            self.session.compiler.static_check(parse_text(self.source(), path=self.scratch))
        except CompilationFailed as exc:
            # A header with nothing under it yet is a program not started, not a mistake.
            real = [d for d in exc.diagnostics if d.code is not ErrorCode.EMPTY_BODY]
            if real:
                self._live.forget()
                self._show_problems(real)
            return
        except ImyError:
            return
        if self._live_inline:
            job = LiveJob(number=0, lines=tuple(self.lines), target=self.target)
            outcome = LiveOutcome(job=job)
            try:
                outcome.result = self._live_convert(job)
            except CompilationFailed as exc:
                outcome.failure = exc
            except ImyError as exc:
                outcome.error = exc
            self._show_outcome(outcome)
        else:
            self._live.submit(self.lines, self.target)

    def _live_convert(self, job: LiveJob) -> CompileResult:
        return self.session.compiler.compile_text(
            job.source,
            CompileOptions(target=job.target, save_memory=False, preview=True, run_dir=Path.cwd()),
            path=self.scratch,
        )

    def _can_redraw(self) -> bool:
        """Whether a result can be written above the line being typed and that line put back."""
        return self._readline is not None and self._input is input and self.console.is_terminal

    def _live_deliver(self, outcome: LiveOutcome) -> None:
        """Called on the worker thread when a preview is in."""
        with self._screen:
            if self._at_prompt and self._can_redraw():
                typed = self._readline.get_line_buffer()  # type: ignore[union-attr]
                stream = self.console.file
                # Clear the line being typed, write the result, then put the prompt and the typed text back.
                stream.write("\r\x1b[2K")
                stream.flush()
                self._show_outcome(outcome)
                stream.write(self._prompt + typed)
                stream.flush()
            else:
                self._held.append(outcome)

    def _show_held(self) -> None:
        """Results that came in while a command was writing are shown before the next prompt."""
        with self._screen:
            held, self._held = self._held, []
        for outcome in held:
            self._show_outcome(outcome)

    def _show_problems(self, diagnostics: list[Diagnostic]) -> None:
        fresh = []
        for diag in diagnostics:
            key = (diag.code.value, diag.line, diag.message)
            if key not in self._shown_problems:
                self._shown_problems.add(key)
                fresh.append(diag)
        for diag in fresh:
            colour = "magenta" if diag.family == "SyntaxError" else "red"
            self.console.print(f"[{colour}]✗ {escape(diag.location)} · {escape(diag.code.value)}[/{colour}]: {escape(diag.message)}")
        if fresh:
            self.console.print("[dim]:undo removes the last line, :edit N <text> changes one.[/dim]")

    def _show_outcome(self, outcome: LiveOutcome) -> None:
        if outcome.error is not None:
            error = outcome.error
            if isinstance(error, LLMRateLimitError) and error.kind in ("busy", "rate_limit"):
                # Busy passes by itself: the next line asks again. Said once, not after every line.
                if not self._busy_noted:
                    self._busy_noted = True
                    self.console.print(f"[yellow]live:[/yellow] {escape(error.message)} [dim]It is asked again with your next line.[/dim]")
                return
            self.live_on = False
            self.console.print(f"[yellow]live conversion paused:[/yellow] {escape(error.message)}")
            hint = f"{error.hint} " if error.hint else ""
            self.console.print(f"  [dim]{escape(hint)}:live on turns it back on; :run still works as before.[/dim]")
            return
        if outcome.failure is not None:
            self._show_problems(list(outcome.failure.diagnostics))
            return
        result = outcome.result
        if result is None:
            return
        self._busy_noted = False
        current = result.code.rstrip("\n").split("\n") if result.code.strip() else []
        changed = changed_lines(self._preview_lines, current)
        self._preview_lines = current
        self.last = result
        if not changed:
            return
        from .cli import compile_note

        covered = len(outcome.job.lines)
        more = ", more typed since" if outcome.stale else ""
        about = f"{result.language.name} for line{'' if covered == 1 else 's'} 1–{covered}"
        header = f"┄ {about} ({compile_note(result)}{more}) ┄"
        if len(header) > self.console.width:
            # A phone's terminal: the seconds stay, the model's long name goes (:models names it).
            short = "cached" if result.from_cache else format_seconds(result.seconds)
            header = f"┄ {about} ({short}{more}) ┄"
        self.console.print(f"[dim]{escape(header)}[/dim]")
        limit = 12
        width = len(str(len(current)))
        for number, line in changed[:limit]:
            self.console.print(f"[dim]{number:>{width}} │[/dim] [green]{escape(line)}[/green]")
        if len(changed) > limit:
            self.console.print(f"[dim]… {len(changed) - limit} more changed lines; :code shows all {len(current)}.[/dim]")

    def _languages(self, args: list[str], raw: str) -> bool:
        from .cli import render_error, render_languages

        try:
            render_languages(self.console, args[0] if args else None)
        except ImyError as exc:
            render_error(exc, self.console)
        return True

    def _live_cmd(self, args: list[str], raw: str) -> bool:
        choice = args[0].lower() if args else ""
        if choice in ("on", "off"):
            self.live_on = choice == "on"
            self._busy_noted = False
            if self.live_on:
                self.console.print(f"live conversion is [bold]on[/bold]: each line is converted to {escape(self.target)} as you enter it")
                self._buffer_changed()
            else:
                self._live.forget()
                self.console.print("live conversion is [bold]off[/bold]: nothing is converted until :run, :check or :convert")
            return True
        if args:
            self.console.print("Usage: :live on   or   :live off")
            return True
        self.console.print(f"live conversion is [bold]{'on' if self.live_on else 'off'}[/bold] (:live on, :live off)")
        return True

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

        self._live.forget()
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
            "live": self._live_cmd, "languages": self._languages, "langs": self._languages,
            "import": self._import,
        }.get(name)
        if handler is None:
            self.console.print(f"[red]Unknown command :{escape(name)}[/red] (type :help)")
            return True
        return handler(args, raw_rest)

    def _quit(self, args: list[str], raw: str) -> bool:
        return False

    def _import(self, args: list[str], raw: str) -> bool:
        """:import <folder, file or repository address>: save what an existing project defines to memory."""
        if len(args) != 1:
            self.console.print("Usage: :import <folder, file or repository address>   (imy import --help lists the options)")
            return True
        from .cli import import_source, render_error, run_import

        try:
            root = import_source(self.session, args[0], self.console)
            run_import(self.session, root, self.console, shown=args[0])
        except ImyError as exc:
            render_error(exc, self.console)
        return True

    def _help(self, args: list[str], raw: str) -> bool:
        from rich.table import Table

        self.console.print(HELP_INTRO, soft_wrap=False)
        table = Table.grid(padding=(0, 2))
        table.add_column(no_wrap=True, style="bold")
        table.add_column(overflow="fold")
        values = {"target": self.target, "live": "on" if self.live_on else "off"}
        for command, meaning in HELP_ROWS:
            table.add_row(escape(command), escape(meaning.format(**values)))
        self.console.print(table)
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
            self._buffer_changed()
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
            self._buffer_changed()
        return True

    def _edit(self, args: list[str], raw: str) -> bool:
        if not args:
            self.console.print("Usage: :edit N <new text>")
            return True
        number = self._line_number(args[0])
        if number is not None:
            self.lines[number - 1] = self._text_after_number(raw, args[0])
            self._buffer_changed()
        return True

    def _insert_line(self, args: list[str], raw: str) -> bool:
        if not args:
            self.console.print("Usage: :insert N <text>")
            return True
        number = self._line_number(args[0], allow_end=True)
        if number is not None:
            self.lines.insert(number - 1, self._text_after_number(raw, args[0]))
            self._buffer_changed()
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
        self._buffer_changed()
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
        self._buffer_changed(fresh=True)
        return True

    def _clear(self, args: list[str], raw: str) -> bool:
        self.lines = []
        self.last = None
        self.console.print("[dim]cleared[/dim]")
        self._buffer_changed(fresh=True)
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
        self._buffer_changed(fresh=True)
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
        self._buffer_changed(fresh=True)
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
        from .cli import build_with_repair, render_error, render_memory

        render_memory(result, self.console)
        try:
            # A program its own build tool refuses goes back to the model for a correction first.
            result, artifact, toolchain = build_with_repair(self.session, result, self.console, stem="console", run_dir=Path.cwd())
            self.last = result
            prepare_virtual_files(result.vfs, self.workspace)
            if toolchain is None:
                self.console.print(f"[green]built[/green] {escape(str(artifact.path))}")
                return True
            outcome = start_program(toolchain, artifact, self.workspace, args=args)
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
