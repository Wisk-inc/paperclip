"""`imy console`: write IMY line by line, as in a file, then :check, :run or :convert it.

The screen is kept the way an editor keeps a file: the name of the program file on top
(main.rb when the code becomes Ruby), a number and a bar before each line, and under a
line the code it became. Nothing is said that was not asked for.

The buffer lives in memory and in ``.imy/console/console.imy`` (IMY's own scratch file).
Files you :load are only read; :save writes only where you say.
"""

from __future__ import annotations

import contextlib
import os
import re
import select
import shlex
import subprocess
import sys
import threading
from collections.abc import Callable
from pathlib import Path

from rich.cells import cell_len
from rich.console import Console
from rich.markup import escape
from rich.syntax import Syntax
from rich.table import Table
from rich.text import Text

from . import __version__
from .compiler import CompileOptions, CompileResult
from .errors import CompilationFailed, ConfigError, Diagnostic, ErrorCode, ImyError, LLMRateLimitError
from .languages import resolve_language
from .live import LiveJob, LiveOutcome, LivePreview, changed_lines
from .parser import parse_header, parse_text
from .progress import working
from .runner import program_file_name, start_program
from .workspace import prepare_virtual_files

try:  # Not on Windows: there a result waits for the next line instead of being drawn while idle.
    import termios
except ImportError:  # pragma: no cover
    termios = None  # type: ignore[assignment]

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
    (":quit", "leave (or Ctrl+D on an empty line)"),
    ("!<command>", "run a shell command, e.g. !ls"),
)

# Commands whose text is code or plain words, kept exactly as typed: quotes need no closing
# and the spaces that indent a line stay.
RAW_COMMANDS = frozenset({"edit", "insert", "header"})

# The program file is called main: main.rb, main.py, main.rs (see runner.program_file_name).
PROGRAM_STEM = "main"
# An editor's margin: the line's number, a bar, the line. The code a line became is set under
# it behind a broken bar, with its own number in the program file.
BAR = "│"
BECAME = "┆"
NUMBER_WIDTH = 3
# What is coloured in a line of IMY: text in quotes, a shortcut, a number. IMY's syntax is the
# writer's own, so nothing else can be told apart.
_COLOURED = re.compile(r"""("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\.auto[\w.]*)|(\b\d+(?:\.\d+)?\b)""")
_COLOURS = ("yellow", "magenta", "cyan")
# Colours from the terminal's own palette, on the terminal's own background.
CODE_THEME = "ansi_dark"
# A command is a colon and then a letter (:run, :q) or a question mark; an exclamation mark
# starts a shell command. Anything else that begins with a colon is code: `:: end` closes a
# block in one of IMY's own examples.
_COMMAND = re.compile(r":[A-Za-z?]|!")
# Tab indents by this many spaces until the code itself shows another habit.
INDENT = 4


def is_command(line: str) -> bool:
    """Whether a line is one of the console's commands and not a line of the program."""
    return _COMMAND.match(line) is not None


def typed_rows(text: str) -> list[str]:
    """What one Enter brought, line break by line break, as the terminal showed it."""
    return text.replace("\r\n", "\n").replace("\r", "\n").split("\n")


def entered_lines(text: str) -> list[str]:
    """What one Enter brought: a line, or several pasted at once. Pasted lines are taken one
    by one, as if each had been typed; the line breaks a paste ends with are not lines."""
    lines = typed_rows(text)
    while len(lines) > 1 and not lines[-1]:
        lines.pop()
    return lines


def indentation(line: str) -> str:
    """The spaces and tabs a line begins with."""
    return line[: len(line) - len(line.lstrip(" \t"))]


def colour_source(line: str, *, header: bool = False) -> Text:
    """A line of IMY as an editor would colour it."""
    if header:
        return Text(line, style="green")
    text = Text(line)
    for match in _COLOURED.finditer(line):
        text.stylize(_COLOURS[match.lastindex - 1], match.start(), match.end())  # type: ignore[operator]
    return text


def colour_program(code: str, language: str) -> list[Text]:
    """The program's lines in its language's own colours."""
    lines = code.rstrip("\n").split("\n") if code.strip() else []
    try:
        coloured = Syntax(code, language, theme=CODE_THEME, background_color="default").highlight(code.rstrip("\n")).split("\n")
    except Exception:  # A language rich has no colours for is shown plain.
        return [Text(line) for line in lines]
    return list(coloured) if len(coloured) == len(lines) else [Text(line) for line in lines]


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
        try:
            # By the language's own name (js is javascript), as :target sets it.
            self.target = resolve_language(target).name
        except ValueError as exc:
            raise ConfigError(f"{target!r} is not a language name.") from exc
        self.console = console
        self._input = input_fn
        self.lines: list[str] = []
        self.last: CompileResult | None = None
        self.workspace = self.session.workspace
        self.scratch = self.workspace.console / "console.imy"
        self._history: Path | None = None
        self._readline: object | None = None
        # GNU readline (not the editline stand-in): Tab and the next line's indentation need it.
        self._gnu_readline = False
        self._matches: list[str] = []
        # What the next line begins with, as an editor keeps a block's indentation. None: as the
        # last line of the buffer begins.
        self._indent: str | None = None
        # The indentation the console itself put before the line now being typed, and how many
        # bytes the keyboard had ready when its first key came: one for a key pressed, a
        # whole line and more for text that arrived at once.
        self._prefilled = ""
        self._burst = 0
        # Whether a key has been pressed behind the margin now shown.
        self._typing = False
        self._setup_history()
        self._setup_keys()
        # Live conversion: each line entered is converted in the background (see live.py).
        self.live_on = live
        # Convert in step with the typing instead of in the background (tests, piped input).
        self._live_inline = live_inline
        self._live = LivePreview(convert=self._live_convert, deliver=self._live_deliver)
        # Results the background worker handed over. Only this thread writes to the screen:
        # the worker leaves a result here and wakes the wait for a key (see _wait_for_key).
        self._held: list[LiveOutcome] = []
        self._held_lock = threading.Lock()
        self._wake_pipe: tuple[int, int] | None = None
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

    def _setup_keys(self) -> None:
        """Tab as in an editor: it indents a line of code, and completes a file's name after a
        command. Several lines pasted at once arrive as one entry, not as keys typed."""
        readline = self._readline
        if readline is None:
            return
        if getattr(readline, "backend", "") == "editline" or "libedit" in (readline.__doc__ or ""):
            return
        self._gnu_readline = True
        with contextlib.suppress(Exception):
            readline.set_completer(self._complete)
            readline.set_completer_delims(" \t\n")
            readline.parse_and_bind("tab: complete")
            readline.parse_and_bind("set enable-bracketed-paste on")

    def _indent_unit(self) -> int:
        """How far one step of indentation goes: the smallest the code already uses, else four."""
        widths = [len(line) - len(line.lstrip(" ")) for line in self.lines if line.strip()]
        widths = [width for width in widths if width]
        return min(widths) if widths else INDENT

    def _complete(self, text: str, state: int) -> str | None:
        """What Tab gives (readline asks for the choices one by one)."""
        readline = self._readline
        try:
            if state == 0:
                if is_command(readline.get_line_buffer().lstrip()):
                    self._matches = self._file_names(text)
                else:
                    unit = self._indent_unit()
                    self._matches = [text + " " * (unit - readline.get_endidx() % unit)]
            return self._matches[state] if state < len(self._matches) else None
        except Exception:  # A failed completion must never end the console.
            return None

    @staticmethod
    def _file_names(begun: str) -> list[str]:
        """The files and folders whose names begin as typed."""
        import glob

        names = sorted(glob.glob(glob.escape(os.path.expanduser(begun)) + "*"))
        return [name + os.sep if os.path.isdir(name) else name for name in names]

    def _next_indent(self) -> str:
        """What the next line begins with: what the line before it began with."""
        if self._indent is not None:
            return self._indent
        return indentation(self.lines[-1]) if self.lines else ""

    # ── How the screen is kept ───────────────────────────────────────────

    def file_name(self) -> str:
        """The program file this code becomes: main.rb, main.py, Main.java."""
        return program_file_name(resolve_language(self.target), PROGRAM_STEM)

    def banner(self) -> None:
        """One line, like the title of an open file: the program file's name. What this is and
        where the commands are listed follow it, dimmed. Nothing about what it can do."""
        self.console.print(f"[bold cyan]{escape(self.file_name())}[/bold cyan]  [dim]IMY {__version__} · :help[/dim]", soft_wrap=False)

    def _margin(self, number: int | None, bar: str = BAR) -> str:
        """What stands before a line: its number and a bar; the same width without a number."""
        label = "" if number is None else str(number)
        return f"{label:>{NUMBER_WIDTH}} {bar} "

    def _prompt(self, number: int) -> str:
        """The margin as the place to type the next line. readline is told which characters
        take no room on the screen (the dimming), or its wrapping would be off."""
        margin = self._margin(number)
        if not self._can_redraw() or self.console.no_color or self._readline is None:
            return margin
        return f"\x01\x1b[2m\x02{margin[:-1]}\x01\x1b[0m\x02 "

    def _row(self, margin: str, body: Text) -> Table:
        """A line behind its margin. A line too long for the terminal continues under its own
        beginning, not under the margin."""
        grid = Table.grid(padding=0)
        grid.add_column(no_wrap=True)
        grid.add_column(overflow="fold")
        grid.add_row(Text(margin, style="dim"), body)
        return grid

    def _print_line(self, number: int, line: str) -> None:
        header = number == 1 and line.lstrip().startswith("#")
        self.console.print(self._row(self._margin(number), colour_source(line, header=header)))

    def _print_listing(self) -> None:
        for number, line in enumerate(self.lines, start=1):
            self._print_line(number, line)

    def _program_row(self, number: int, width: int, body: Text) -> Table:
        """A line of the program file: behind a broken bar and its own number in that file."""
        return self._row(f"{self._margin(None, BECAME)}{number:>{width}} ", body)

    def _print_counted(self, renderable: object) -> int:
        """Print it; the number of rows of the terminal it takes."""
        rows = len(self.console.render_lines(renderable, self.console.options, pad=False))
        self.console.print(renderable)
        return rows

    def _print_program(self, result: CompileResult) -> None:
        """The whole program file as the code became it: its name, then its lines, each
        behind its number, in the language's own colours."""
        self.console.print(f"[bold cyan]{escape(program_file_name(result.language, PROGRAM_STEM, result.code))}[/bold cyan]")
        coloured = colour_program(result.code, result.language.name)
        width = len(str(len(coloured)))
        for number, body in enumerate(coloured, start=1):
            self.console.print(self._program_row(number, width, body))

    def _can_redraw(self) -> bool:
        """Whether this is a real terminal, where a line can be drawn again in place and a
        result written while the next line is waited for."""
        try:
            keyboard = sys.stdin.isatty()
        except (AttributeError, ValueError):
            return False
        return (
            termios is not None
            and self._input is input
            and keyboard
            and self.console.is_terminal
            and not self.console.is_dumb_terminal
        )

    def _columns(self) -> int | None:
        """The terminal's width as the terminal itself reports it."""
        try:
            return os.get_terminal_size(self.console.file.fileno()).columns
        except (AttributeError, OSError, ValueError):
            return None

    def _rows_of(self, typed: list[str], number: int) -> int | None:
        """How many rows of the terminal what was just entered takes (one line, or the lines of
        a paste, the first behind the margin), or None where that cannot be told for sure:
        then it is left on the screen as it was typed."""
        columns = self._columns()
        # A width set in the environment that is not the terminal's own: readline wrapped by the terminal's.
        if columns is None or columns != self.console.width or columns < 20:
            return None
        rows = 0
        for index, line in enumerate(typed):
            # Letters that take two places, tabs and the like wrap in ways only the terminal knows.
            if not line.isprintable() or cell_len(line) != len(line):
                return None
            cells = len(line) + (len(self._margin(number)) if index == 0 else 0)
            # A line that ends exactly at the right edge: where the cursor went is the terminal's business.
            if cells and cells % columns == 0:
                return None
            rows += cells // columns + 1
        # A paste that ends in a line break leaves the cursor on an empty last row, and Enter
        # then stays on it.
        if len(typed) > 1 and not typed[-1]:
            rows -= 1
        return rows if rows < self.console.height else None

    def _take_back(self, number: int, typed: list[str]) -> bool:
        """Clear from the screen what was just typed or pasted, so that it can be set again the
        way an editor shows it. False where its rows cannot be told: then it stays as typed."""
        if not self._can_redraw():
            return False
        rows = self._rows_of(typed, number)
        if rows is None:
            return False
        stream = self.console.file
        stream.write(f"\x1b[{rows}A\r\x1b[J")
        stream.flush()
        return True

    def _draw_entered(self, line: str) -> None:
        """A line just entered, set the way an editor shows it: coloured, and where it is too
        long for the terminal, continued between words under its own beginning. A command is
        set without a number, so the numbered lines read as the file."""
        if is_command(line):
            self.console.print(self._row(self._margin(None, " "), Text(line, style="dim")))
        else:
            self._print_line(len(self.lines) + 1, line)

    def _read_line(self, number: int) -> str:
        """Ask for line ``number``; the answer is what was typed, as it stood on the screen.

        On a real terminal the margin is first only drawn, and results that come in are
        written above it by this thread; readline takes the line over at the first key. So
        nothing is ever written over a line being typed. The line begins where the one before
        it began, as in an editor (Backspace takes the indentation away)."""
        prompt = self._prompt(number)
        if not self._can_redraw():
            return self._input(prompt)
        stream = self.console.file
        readline = self._readline
        indent = self._next_indent() if self._gnu_readline else ""
        # Keys already waiting are a paste or typing ahead: those lines bring their own indentation.
        if indent and select.select([sys.stdin.fileno()], [], [], 0)[0]:
            indent = ""
        shown = f"\x1b[2m{self._margin(number)[:-1]}\x1b[0m " if not self.console.no_color else self._margin(number)
        self._typing = False
        self._burst = self._wait_for_key(shown + indent)
        self._typing = True
        # readline draws the margin itself: the drawn one makes room for it.
        stream.write("\r\x1b[2K")
        stream.flush()
        if not indent:
            return self._input(prompt)
        self._prefilled = indent
        readline.set_startup_hook(lambda: readline.insert_text(indent))
        try:
            return self._input(prompt)
        finally:
            readline.set_startup_hook(None)

    def _wait_for_key(self, shown: str) -> int:
        """Show the margin and wait until a key is pressed, writing the results that come in
        meanwhile above it. Keys are neither taken nor shown here: they stay for readline.
        Returns how many bytes the keyboard then has ready."""
        stream = self.console.file
        keyboard = sys.stdin.fileno()
        if self._wake_pipe is None:
            self._wake_pipe = os.pipe()
            os.set_blocking(self._wake_pipe[0], False)
            os.set_blocking(self._wake_pipe[1], False)
        wake = self._wake_pipe[0]
        saved = termios.tcgetattr(keyboard)
        waiting = termios.tcgetattr(keyboard)
        # A key is known at once, not at Enter, and is not shown twice.
        waiting[3] &= ~(termios.ICANON | termios.ECHO)
        # The rows of program lines this wait has written right above the margin, and the
        # program as it was shown before them: a newer result takes their place, so a line of
        # the program is not shown twice. None once anything else was written.
        above: int | None = 0
        before = list(self._preview_lines)
        try:
            termios.tcsetattr(keyboard, termios.TCSANOW, waiting)
            stream.write(shown)
            stream.flush()
            while True:
                ready, _, _ = select.select([keyboard, wake], [], [])
                if wake in ready:
                    with contextlib.suppress(OSError):
                        os.read(wake, 4096)
                    if self._held:
                        stream.write("\r\x1b[2K")
                        if above and self._columns() == self.console.width and all(outcome.result is not None for outcome in self._held):
                            stream.write(f"\x1b[{above}A\r\x1b[J")
                            self._preview_lines = list(before)
                            above = 0
                        stream.flush()
                        written = self._show_held()
                        above = None if written is None or above is None else above + written
                        if above is not None and above >= self.console.height - 1:
                            above = None
                        stream.write(shown)
                        stream.flush()
                if keyboard in ready:
                    return self._bytes_ready(keyboard)
        finally:
            # A terminal that was closed meanwhile has nothing to put back.
            with contextlib.suppress(termios.error, OSError):
                termios.tcsetattr(keyboard, termios.TCSANOW, saved)

    @staticmethod
    def _bytes_ready(keyboard: int) -> int:
        """How many bytes the keyboard has ready to be read (0 where that cannot be asked)."""
        try:
            import array
            import fcntl

            count = array.array("i", [0])
            fcntl.ioctl(keyboard, termios.FIONREAD, count)
            return max(0, count[0])
        except (ImportError, AttributeError, OSError):
            return 0

    def _own_indentation(self, text: str, prefilled: str) -> str:
        """What was entered, without the indentation the console put first, where the text
        brought its own. That is so for text that arrived at once: several lines (a paste),
        or a line that came whole, together with its Enter (a paste the terminal did not
        mark, a phone keyboard that commits a line). What was typed key by key is left alone:
        spaces typed behind the indentation are more indentation."""
        if not prefilled or not text.startswith(prefilled):
            return text
        rest = text[len(prefilled) :]
        if rest[:1] not in (" ", "\t"):
            return text
        first = typed_rows(rest)[0]
        at_once = len(typed_rows(rest)) > 1 or self._burst > len(first.encode("utf-8", "replace"))
        return rest if at_once else text

    def _leave_on_signals(self) -> Callable[[], None]:
        """A closed terminal, or a plain kill, ends the console as :quit does: the terminal is
        put back as it was and the lines typed are kept for next time. Returns the undoing."""
        import signal

        def leave(signum: int, frame: object) -> None:
            raise SystemExit(128 + signum)

        previous: dict[int, object] = {}
        for name in ("SIGHUP", "SIGTERM"):
            number = getattr(signal, name, None)
            if number is None:
                continue
            # Only the main thread may set them; elsewhere the console runs without.
            with contextlib.suppress(ValueError, OSError):
                previous[number] = signal.signal(number, leave)

        def undo() -> None:
            for number, handler in previous.items():
                with contextlib.suppress(ValueError, OSError, TypeError):
                    signal.signal(number, handler)  # type: ignore[arg-type]

        return undo

    def loop(self) -> int:
        undo_signals = self._leave_on_signals()
        self.banner()
        try:
            while True:
                self._show_held()
                number = len(self.lines) + 1
                try:
                    text = self._read_line(number)
                except EOFError:
                    self.console.print()
                    break
                except KeyboardInterrupt:
                    if self._can_redraw() and not self._typing:
                        # Ctrl+C with nothing typed: the margin stays where it is.
                        self.console.file.write("\r\x1b[2K")
                        self.console.file.flush()
                    else:
                        self.console.print()
                    continue
                if not self._entered(number, text):
                    break
        finally:
            self._live.close()
            self._save_history()
            if self._wake_pipe is not None:
                for end in self._wake_pipe:
                    with contextlib.suppress(OSError):
                        os.close(end)
                self._wake_pipe = None
            undo_signals()
        return 0

    def _entered(self, number: int, text: str) -> bool:
        """Enter was pressed behind the margin of line ``number``. False when a command says to leave."""
        prefilled, self._prefilled = self._prefilled, ""
        drawn = self._take_back(number, typed_rows(text))
        # What came in while this was being typed belongs to the lines before it: where the
        # line can be set again it goes above it, under the lines it came from.
        self._show_held()
        return self._take_lines(entered_lines(self._own_indentation(text, prefilled)), drawn=drawn, prefilled=prefilled)

    def _take_lines(self, typed: list[str], *, drawn: bool, prefilled: str = "") -> bool:
        """Take what was entered, line by line: a line of the program is added, a command is
        carried out. ``drawn`` says the typed text was cleared from the screen and each line
        is to be set again; ``prefilled`` is the indentation the console put before the first
        line. False when a command says to leave."""
        added = False
        for position, line in enumerate(typed):
            # A command typed behind the indentation the console put there is still a command.
            if position == 0 and prefilled and line.startswith(prefilled) and is_command(line[len(prefilled) :]):
                line = line[len(prefilled) :]
            if is_command(line):
                if drawn:
                    self._draw_entered(line)
                if added:
                    added = False
                    self._buffer_changed()
                try:
                    if line.startswith("!"):
                        self.shell(line[1:].strip())
                    elif not self.command(line[1:].strip()):
                        return False
                except KeyboardInterrupt:
                    # Ctrl+C stops the compile or command in progress, not the console.
                    self.console.print("[yellow]Stopped.[/yellow]")
                    return True
                # A command may have changed the buffer: the next line begins as its last line does.
                self._indent = None
                continue
            # Enter on an empty first line adds nothing.
            if not line.strip() and not self.lines:
                continue
            # The next line begins as this one did; a line of nothing but indentation is an empty line.
            self._indent = indentation(line) if line.strip() else line
            line = line if line.strip() else ""
            if drawn:
                self._draw_entered(line)
            self.lines.append(line)
            added = True
        if added:
            self._buffer_changed()
        return True

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

    def _live_deliver(self, outcome: LiveOutcome) -> None:
        """Called on the worker thread when a preview is in. The worker writes nothing: the
        result is left for the console's own thread, which is woken if it is waiting for a key."""
        with self._held_lock:
            self._held.append(outcome)
        pipe = self._wake_pipe
        if pipe is not None:
            with contextlib.suppress(OSError):
                os.write(pipe[1], b"\0")

    def _show_held(self) -> int | None:
        """Results that came in from the background, in the order they came. Of several
        conversions that came in together only the newest is shown: it is the program as it
        is now. Returns the rows of program lines written, or None when something else was."""
        with self._held_lock:
            held, self._held = self._held, []
        newest = max((index for index, outcome in enumerate(held) if outcome.result is not None), default=-1)
        rows: int | None = 0
        for index, outcome in enumerate(held):
            if outcome.result is not None and index != newest:
                continue
            written = self._show_outcome(outcome)
            rows = None if written is None or rows is None else rows + written
        return rows

    def _show_problems(self, diagnostics: list[Diagnostic]) -> int:
        """The problems not shown before; how many that were."""
        fresh = []
        for diag in diagnostics:
            key = (diag.code.value, diag.line, diag.message)
            if key not in self._shown_problems:
                self._shown_problems.add(key)
                fresh.append(diag)
        for diag in fresh:
            colour = "magenta" if diag.family == "SyntaxError" else "red"
            self.console.print(f"[{colour}]✗ {escape(diag.location)} · {escape(diag.code.value)}[/{colour}]: {escape(diag.message)}")
        return len(fresh)

    def _show_outcome(self, outcome: LiveOutcome) -> int | None:
        """Show what a conversion in the background brought. Returns the rows of program lines
        written (0 when there was nothing to show), or None when something else was written."""
        if outcome.error is not None:
            error = outcome.error
            if isinstance(error, LLMRateLimitError) and error.kind in ("busy", "rate_limit"):
                # Busy passes by itself: the next line asks again. Said once, not after every line.
                if self._busy_noted:
                    return 0
                self._busy_noted = True
                self.console.print(f"[yellow]live:[/yellow] {escape(error.message)}")
                return None
            self.live_on = False
            self.console.print(f"[yellow]live off:[/yellow] {escape(error.message)}")
            if error.hint:
                self.console.print(f"  [dim]{escape(error.hint)}[/dim]")
            return None
        if outcome.failure is not None:
            return None if self._show_problems(list(outcome.failure.diagnostics)) else 0
        result = outcome.result
        if result is None:
            return 0
        self._busy_noted = False
        current = result.code.rstrip("\n").split("\n") if result.code.strip() else []
        changed = changed_lines(self._preview_lines, current)
        self._preview_lines = current
        self.last = result
        if not changed:
            return 0
        # The lines of the program file that are new or different, in the file's own colours,
        # each behind its number in that file.
        coloured = colour_program(result.code, result.language.name)
        limit = 12
        width = len(str(len(current)))
        rows = 0
        for number, line in changed[:limit]:
            body = coloured[number - 1] if number <= len(coloured) else Text(line)
            rows += self._print_counted(self._program_row(number, width, body))
        if len(changed) > limit:
            rows += self._print_counted(self._row(self._margin(None, BECAME), Text(f"… {len(changed) - limit} more lines", style="dim")))
        return rows

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
            self.console.print(f"live {choice}")
            if self.live_on:
                self._buffer_changed()
            else:
                self._live.forget()
            return True
        if args:
            self.console.print("Usage: :live on|off")
            return True
        self.console.print(f"live {'on' if self.live_on else 'off'}")
        return True

    def source(self) -> str:
        return "\n".join(self.lines) + "\n"

    def _write_scratch(self) -> Path:
        self.workspace.console.mkdir(parents=True, exist_ok=True)
        self.scratch.write_text(self.source(), encoding="utf-8")
        return self.scratch

    def _compile(self, target: str, *, save_memory: bool) -> CompileResult | None:
        if not self.lines:
            self.console.print("[yellow]nothing to compile[/yellow]")
            return None
        from .cli import render_failure, render_error

        self._live.forget()
        path = self._write_scratch()
        try:
            # The seconds show while the model is waited for and leave no line behind.
            with working(self.console, f"Compiling to {target}"):
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
            self.console.print(f"[red]Unknown command :{escape(name)}[/red] (:help)")
            return True
        return handler(args, raw_rest)

    def _quit(self, args: list[str], raw: str) -> bool:
        return False

    def _import(self, args: list[str], raw: str) -> bool:
        """:import <folder, file or repository address>: save what an existing project defines to memory."""
        if len(args) != 1:
            self.console.print("Usage: :import <folder, file or repository address>")
            return True
        from .cli import import_source, render_error, run_import

        try:
            root = import_source(self.session, args[0], self.console)
            run_import(self.session, root, self.console, shown=args[0], hints=False)
        except ImyError as exc:
            render_error(exc, self.console)
        return True

    def _help(self, args: list[str], raw: str) -> bool:
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
        self._print_listing()
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
            # The line as it stands in the file now.
            self._print_line(number, self.lines[number - 1])
            self._buffer_changed()
        return True

    def _insert_line(self, args: list[str], raw: str) -> bool:
        if not args:
            self.console.print("Usage: :insert N <text>")
            return True
        number = self._line_number(args[0], allow_end=True)
        if number is not None:
            self.lines.insert(number - 1, self._text_after_number(raw, args[0]))
            self._print_line(number, self.lines[number - 1])
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
        else:
            self.lines.insert(0, line)
        # The answer is the first line of the file as it stands now.
        self._print_line(1, line)
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
        self._print_listing()
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
        self.last = None
        # A file that fits the screen is shown, as an editor opens it; a longer one is counted (:show lists it).
        if len(self.lines) <= max(self.console.height - 3, 1):
            self._print_listing()
        else:
            self.console.print(f"[dim]loaded {len(self.lines)} lines[/dim]")
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
            self.console.print(escape(self.target))
            return True
        try:
            self.target = resolve_language(args[0]).name
        except ValueError:
            self.console.print(f"[red]{escape(args[0])} is not a language name[/red]")
            return True
        # The code now becomes another file: its name, as on the first line of the console.
        self.console.print(f"[bold cyan]{escape(self.file_name())}[/bold cyan]")
        self._buffer_changed(fresh=True)
        return True

    def _reopen(self) -> None:
        try:
            self.session = self._session_factory(self._provider, self._model)
        except ImyError as exc:
            self.console.print(f"[red]{escape(exc.message)}[/red]")
            return
        config = self.session.config
        self.console.print(f"now using {escape(config.provider)}/{escape(config.resolved_model())}")

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
            self.console.print(escape(self.session.config.resolved_model()))
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
            return True
        if args:
            self.console.print(escape("Usage: :models [check]"))
            return True
        for line in model_lines(self.session.config, self.session.env):
            self.console.print(" " + line)
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
        self._print_program(self.last)
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
        from .cli import build_with_repair, render_error

        try:
            # A program its own build tool refuses goes back to the model for a correction first;
            # here that leaves no line behind either (the spinner shows it while it lasts).
            result, artifact, toolchain = build_with_repair(
                self.session, result, self.console, stem=PROGRAM_STEM, run_dir=Path.cwd(), notes=False
            )
            self.last = result
            prepare_virtual_files(result.vfs, self.workspace)
            if toolchain is None:
                self.console.print(f"[green]built[/green] {escape(str(artifact.path))}")
                return True
            outcome = start_program(toolchain, artifact, self.workspace, args=args)
        except ImyError as exc:
            render_error(exc, self.console)
            return True
        # As a shell does it: a program that ended well says nothing more.
        if outcome.exit_code != 0:
            self.console.print(f"[red]exit code {outcome.exit_code}[/red]")
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
            self._print_program(result)
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
