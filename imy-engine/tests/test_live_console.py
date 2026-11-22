"""The console's live conversion: each line entered is checked at once and converted in the background."""

from __future__ import annotations

import io
import os
import sys
import threading
import time
from pathlib import Path

import pytest
from rich.console import Console

from conftest import FakeLLM, reply
from imy import __version__
from imy.cli import ImyConsoleOutput, live_by_default, open_session
from imy.compiler import CompileOptions
from imy.config import EnvView
from imy.console import ImyConsole
from imy.errors import LLMProviderError, LLMRateLimitError
from imy.live import LiveJob, LiveOutcome, LivePreview, changed_lines
from imy.prompts import LIVE_PREVIEW_NOTE

HEADER = '# ("greets one person by name and says how long the name is")'


def flat(text: str) -> str:
    return " ".join(text.split())


@pytest.fixture
def llm(monkeypatch: pytest.MonkeyPatch) -> FakeLLM:
    fake = FakeLLM()
    monkeypatch.setattr("imy.cli.make_client", lambda config, env: fake)
    return fake


def make(isolated: Path, lines: list[str], *, live: bool = True, inline: bool = True) -> tuple[ImyConsole, Console]:
    console = Console(record=True, width=120, force_terminal=False, file=io.StringIO())
    feed = iter(lines)

    def read(prompt: str) -> str:
        try:
            return next(feed)
        except StopIteration:
            raise EOFError from None

    session = open_session(isolated / "console.imy")
    return ImyConsole(lambda p, m: session, target="python", console=console, input_fn=read, live=live, live_inline=inline), console


class TestPreviewCompile:
    def test_the_model_is_told_the_program_is_still_being_typed(self, isolated: Path, llm: FakeLLM) -> None:
        session = open_session(isolated / "console.imy")
        llm.queue(reply('person = "Bo"\n'), reply('person = "Bo"\n'))
        source = HEADER + '\nperson = "Bo"\n'
        preview = session.compiler.compile_text(source, CompileOptions(target="python", preview=True), path=isolated / "p.imy")
        assert LIVE_PREVIEW_NOTE in llm.last_prompt()
        assert "more lines may follow" in llm.last_prompt()
        # Nothing is remembered from a preview, whatever was asked.
        assert preview.memory_report is None
        assert session.memory.entries() == []

        # The strict compile is a separate request with the usual prompt: a preview never stands in for it.
        strict = session.compiler.compile_text(source, CompileOptions(target="python"), path=isolated / "p.imy")
        assert LIVE_PREVIEW_NOTE not in llm.last_prompt()
        assert not strict.from_cache and llm.calls == 2
        # Each has its own place in the cache.
        assert session.compiler.compile_text(source, CompileOptions(target="python", preview=True), path=isolated / "p.imy").from_cache
        assert session.compiler.compile_text(source, CompileOptions(target="python"), path=isolated / "p.imy").from_cache
        assert llm.calls == 2


class TestNarrowTerminal:
    """A phone shows about 55 columns: nothing may break in the middle of a word."""

    def narrow(self, isolated: Path, lines: list[str], width: int = 52) -> tuple[ImyConsole, Console]:
        # The console the imy command itself writes to: it leaves long lines to a wide terminal.
        console = ImyConsoleOutput(record=True, width=width, force_terminal=False, file=io.StringIO(), highlight=False)
        feed = iter(lines)

        def read(prompt: str) -> str:
            try:
                return next(feed)
            except StopIteration:
                raise EOFError from None

        session = open_session(isolated / "console.imy")
        return ImyConsole(lambda p, m: session, target="python", console=console, input_fn=read, live=True, live_inline=True), console

    def test_it_opens_with_one_line_that_fits_a_phone(self, isolated: Path, llm: FakeLLM) -> None:
        repl, console = self.narrow(isolated, [])
        repl.loop()
        lines = [line for line in console.export_text().split("\n") if line.strip()]
        assert lines == [f"main.py  IMY {__version__} · :help"]
        assert len(lines[0]) <= 52

    def test_messages_wrap_between_words_on_a_phone_and_stay_whole_on_a_wide_terminal(self, isolated: Path, llm: FakeLLM) -> None:
        said = "this line reads like a request to an assistant, and the body of a program must be code that IMY can check"
        phone = ImyConsoleOutput(record=True, width=52, force_terminal=False, file=io.StringIO(), highlight=False)
        phone.print(said)
        lines = phone.export_text().rstrip("\n").split("\n")
        assert len(lines) == 3 and max(len(line) for line in lines) <= 52
        assert " ".join(line.strip() for line in lines) == said
        wide = ImyConsoleOutput(record=True, width=100, force_terminal=False, file=io.StringIO(), highlight=False)
        path = "/home/someone/a project/with a very long folder name/and another long folder name/and one more/file name.imy"
        wide.print(f"written to {path}")
        # Left in one piece for the terminal to wrap: a copied path has no line break in it.
        assert wide.export_text().rstrip("\n") == f"written to {path}"

    def test_help_gives_each_command_its_own_row(self, isolated: Path, llm: FakeLLM) -> None:
        repl, console = self.narrow(isolated, [":help"])
        repl.loop()
        everything = console.export_text().split("\n")
        assert max(len(line) for line in everything) <= 52
        # The rows start at :run; the sentence above them wraps wherever 52 columns end.
        first = next(index for index, line in enumerate(everything) if line.startswith(":run"))
        lines = [line for line in everything[first:] if line.strip()]
        text = "\n".join(lines)
        starts = [line.split()[0] for line in lines if line.startswith((":", "!"))]
        assert starts == [":run", ":check", ":convert", ":header", ":examples", ":example", ":show", ":code", ":undo", ":del", ":edit", ":insert",
                          ":clear", ":load", ":save", ":target", ":languages", ":live", ":provider", ":model", ":models", ":models", ":memory",
                          ":import", ":help", ":quit", "!<command>"]
        # A long description continues under its own column, not under the command.
        wrapped = [line for line in lines if not line.startswith((":", "!"))]
        assert wrapped and all(line.startswith(" " * 10) for line in wrapped)
        assert "(now: python)" in text and "(now: on)" in text

    def test_help_on_a_wide_terminal_is_one_line_a_command(self, isolated: Path, llm: FakeLLM) -> None:
        console = Console(record=True, width=140, force_terminal=False, file=io.StringIO())
        feed = iter([":help", ":quit"])
        session = open_session(isolated / "console.imy")
        repl = ImyConsole(lambda p, m: session, target="rust", console=console, input_fn=lambda prompt: next(feed))
        repl.loop()
        text = console.export_text().split("Then use a command:")[1]
        lines = [line for line in text.split("\n") if line.strip() and "imy>" not in line]
        assert len(lines) == 27 and all(line.startswith((":", "!")) for line in lines)
        assert "compile to another language (now: rust)" in text and "(now: off)" in text

    def test_a_long_line_of_the_program_continues_under_its_own_beginning(self, isolated: Path, llm: FakeLLM) -> None:
        llm.model = "nvidia/nemotron-3-ultra-550b-a55b:free"
        long_code = 'print("Hi, " + person + "! Your name has " + str(len(person)) + " letters.")'
        llm.queue(reply('person = "Bo"\n' + long_code + "\n"))
        repl, console = self.narrow(isolated, [HEADER, 'person = "Bo"', ":show"])
        repl.loop()
        text = console.export_text()
        lines = [line.rstrip() for line in text.split("\n")]
        assert max(len(line) for line in lines) <= 52
        # Nothing but the code: no model's name, no seconds.
        assert "nemotron" not in text and " s)" not in text
        start = lines.index('    ┆ 1 person = "Bo"')
        # The second line of the program is too long for 52 columns: it goes on between words, under its own text.
        assert lines[start + 1].startswith("    ┆ 2 print(")
        assert lines[start + 2].startswith(" " * 8) and not lines[start + 2].lstrip().startswith("┆")
        assert " ".join(part.strip() for part in lines[start + 1 : start + 3]).removeprefix("┆ 2 ") == long_code
        # The header written by hand is too long as well, and is listed the same way.
        listed = lines.index("  2 │ person = \"Bo\"")
        assert lines[listed - 2].startswith("  1 │ # (") and lines[listed - 1].startswith(" " * 6)


class TestLiveAfterARun:
    def test_a_switch_of_language_after_a_run_shows_the_program_in_the_new_language(
        self, isolated: Path, llm: FakeLLM, capfd: pytest.CaptureFixture[str]
    ) -> None:
        """Typed in a real terminal: lines, :run, then :target ruby. The background worker must still answer."""
        llm.queue(
            reply('person = "Bo"\n'),
            reply('person = "Bo"\nprint("Hi, " + person + "!")\n'),
            reply('person = "Bo"\nprint("Hi, " + person + "!")\n'),
            reply('person = "Bo"\nputs("Hi, " + person + "!")\n', target="ruby"),
            reply('person = "Bo"\nputs("Hi, " + person + "!")\n', target="ruby"),
        )
        console = Console(record=True, width=120, force_terminal=False, file=io.StringIO())
        feed = iter(['# ("greets one person by name on the screen")', 'person = "Bo"', 'show ("Hi, " + person + "!")', ":run", ":target ruby", ":code", ":quit"])
        session = open_session(isolated / "console.imy")
        holder: list[ImyConsole] = []

        def read(prompt: str) -> str:
            # A person types slower than the model answers: each preview is in before the next line.
            assert holder[0]._live.wait_idle(20)
            return next(feed)

        repl = ImyConsole(lambda p, m: session, target="python", console=console, input_fn=read, live=True, live_inline=False)
        holder.append(repl)
        assert repl.loop() == 0
        text = console.export_text()
        assert '    ┆ 1 person = "Bo"' in text and '    ┆ 2 print("Hi, " + person + "!")' in text
        # The answer to :target is the new file's name; the program follows in the new language.
        assert "exit code" not in text and "\nmain.rb\n" in text
        after = text.split("\nmain.rb\n")[1]
        assert '    ┆ 2 puts("Hi, " + person + "!")' in after
        # A switch of language shows the whole program again, not only what differs from the Python.
        assert '    ┆ 1 person = "Bo"' in after
        assert llm.calls == 4


class TestLiveConsole:
    def test_each_line_is_converted_and_only_what_changed_is_shown(self, isolated: Path, llm: FakeLLM, capfd: pytest.CaptureFixture[str]) -> None:
        llm.queue(
            reply('person = "Bo"\n'),
            reply('person = "Bo"\nprint("Hi, " + person + "!")\n'),
            reply('person = "Bo"\nprint("Hi, " + person + "!")\nprint("Your name has " + str(len(person)) + " letters.")\n'),
            reply('person = "Bo"\nprint("Hi, " + person + "!")\nprint("Your name has " + str(len(person)) + " letters.")\n'),
        )
        repl, console = make(isolated, [
            HEADER,
            'person = "Bo"',
            'show ("Hi, " + person + "!")',
            'show ("Your name has " + count(person) + " letters.")',
            ":run",
        ])
        repl.loop()
        text = console.export_text()
        # The header alone is a program not started: nothing is asked and nothing is said.
        assert "EmptyBody" not in text
        # Each line of the program, behind its number in the program file, and nothing around it.
        assert '    ┆ 1 person = "Bo"' in text
        assert '    ┆ 2 print("Hi, " + person + "!")' in text
        assert '    ┆ 3 print("Your name has " + str(len(person)) + " letters.")' in text
        assert "python for lines" not in text and "┄" not in text
        # Each converted line is shown once, when it is new.
        assert text.count('┆ 1 person = "Bo"') == 1
        assert text.count('┆ 2 print("Hi, " + person + "!")') == 1
        # :run is its own strict compile, and it is the one that runs.
        assert llm.calls == 4
        assert capfd.readouterr().out == "Hi, Bo!\nYour name has 2 letters.\n"
        assert all(LIVE_PREVIEW_NOTE in request.messages[0].content for request in llm.requests[:3])
        assert LIVE_PREVIEW_NOTE not in llm.requests[3].messages[0].content

    def test_a_line_that_breaks_a_rule_is_reported_as_it_is_entered_without_the_model(self, isolated: Path, llm: FakeLLM) -> None:
        llm.queue(reply('print("Hi, Bo!")\n'))
        repl, console = make(isolated, [
            HEADER,
            "please make me a greeting app",
            'show ("after")',
            ":undo",
            ":undo",
            'show ("Hi, Bo!")',
        ])
        repl.loop()
        text = flat(console.export_text())
        assert "✗ line 2 · PromptingDetected: this line reads like a request" in text
        # The mistake is named; how to edit a line is in :help, not after every mistake.
        assert ":undo removes" not in text and ":edit N" not in text
        # Said once, not again after the next line.
        assert text.count("PromptingDetected") == 1
        # Once the line is gone the program converts.
        assert '┆ 1 print("Hi, Bo!")' in text
        assert llm.calls == 1

    def test_what_the_model_objects_to_is_shown_once(self, isolated: Path, llm: FakeLLM) -> None:
        unclear = reply(status="error", errors=[{"code": "AmbiguousIntent", "line": 2, "message": "It is not clear what `zap person` does."}])
        llm.queue(unclear, unclear)
        repl, console = make(isolated, [HEADER, "zap person", "zap person again"])
        repl.loop()
        text = flat(console.export_text())
        assert text.count("✗ line 2 · AmbiguousIntent: It is not clear what `zap person` does.") == 1
        assert "nothing was run" not in text

    def test_live_can_be_turned_off_and_on(self, isolated: Path, llm: FakeLLM) -> None:
        llm.queue(reply('person = "Bo"\n'))
        repl, console = make(isolated, [":live off", HEADER, 'person = "Bo"', ":live", ":live on", ":live sideways"])
        repl.loop()
        written = console.export_text()
        text = flat(written)
        lines = [line.strip() for line in written.split("\n") if line.strip()]
        # ":live off", then ":live" asking, then ":live on": the state in two words each time.
        assert lines.count("live off") == 2 and lines.count("live on") == 1
        assert "nothing is converted" not in text and "as you enter it" not in text
        # Turning it on converts what is already typed.
        assert '┆ 1 person = "Bo"' in text and llm.calls == 1
        assert "Usage: :live on|off" in text

    def test_off_by_default_never_asks_the_model_until_run(self, isolated: Path, llm: FakeLLM) -> None:
        repl, console = make(isolated, [HEADER, 'person = "Bo"', "please make me a greeting app"], live=False)
        repl.loop()
        assert llm.calls == 0
        assert "PromptingDetected" not in console.export_text()

    def test_a_model_that_is_gone_pauses_live_and_a_busy_one_is_only_noted_once(self, isolated: Path, llm: FakeLLM) -> None:
        def busy(request: object) -> str:
            error = LLMRateLimitError("Flint is busy at its provider right now.")
            error.kind = "busy"
            raise error

        def gone(request: object) -> str:
            error = LLMProviderError("Flint could not answer (400: Model not found).", hint="See which free models answer now with `imy models --check`.")
            error.kind = "withdrawn"
            raise error

        llm.queue(busy, busy, gone)
        repl, console = make(isolated, [HEADER, 'person = "Bo"', 'show ("one")', 'show ("two")', 'show ("three")'])
        repl.loop()
        text = flat(console.export_text())
        assert text.count("live: Flint is busy at its provider right now.") == 1
        assert "It is asked again" not in text
        assert "live off: Flint could not answer (400: Model not found)." in text
        # The error's own way out is kept; nothing is added about what else the console does.
        assert "imy models --check" in text and "turns it back on" not in text and "still works" not in text
        # Off: the last line asked nothing.
        assert llm.calls == 3 and repl.live_on is False

    def test_it_opens_the_same_with_live_on_or_off_and_says_which_when_asked(self, isolated: Path, llm: FakeLLM) -> None:
        opened = []
        for live in (True, False):
            repl, console = make(isolated, [":live"], live=live)
            repl.loop()
            lines = [line.strip() for line in console.export_text().split("\n") if line.strip()]
            opened.append(lines[0])
            # Nothing about live conversion until it is asked for.
            assert lines[1:] == ["live on" if live else "live off"]
        assert opened[0] == opened[1] == f"main.py  IMY {__version__} · :help"

    def test_replacing_the_buffer_starts_the_preview_over(self, isolated: Path, llm: FakeLLM) -> None:
        llm.queue(reply('person = "Bo"\n'), reply('person = "Bo"\n'))
        repl, console = make(isolated, [HEADER, 'person = "Bo"', ":clear", HEADER, 'person = "Bo"'])
        repl.loop()
        text = console.export_text()
        # The same conversion is shown again for the new buffer (from the cache: one request).
        assert text.count('┆ 1 person = "Bo"') == 2
        assert llm.calls == 1


class TestTheLineJustEntered:
    """On a real terminal what was just entered is set again the way an editor shows it."""

    def on_a_terminal(
        self, isolated: Path, monkeypatch: pytest.MonkeyPatch, *, have: list[str] | None = None, width: int = 55, reported: int | None = None
    ):
        stream = io.StringIO()
        console = ImyConsoleOutput(width=width, height=40, force_terminal=True, file=stream, highlight=False, color_system=None)
        session = open_session(isolated / "console.imy")
        repl = ImyConsole(lambda p, m: session, target="python", console=console, input_fn=lambda prompt: "")
        repl.lines = list(have or [])
        monkeypatch.setattr(repl, "_can_redraw", lambda: True)
        monkeypatch.setattr(repl, "_columns", lambda: width if reported is None else reported)
        return repl, stream

    def drawn(self, stream: io.StringIO) -> list[str]:
        return [line.rstrip() for line in stream.getvalue().split("\n") if line.strip()]

    def test_a_short_line_is_taken_back_and_drawn_behind_its_number(self, isolated: Path, llm: FakeLLM, monkeypatch: pytest.MonkeyPatch) -> None:
        repl, stream = self.on_a_terminal(isolated, monkeypatch, have=[HEADER])
        assert repl._entered(2, 'person = "Bo"')
        # Up one row (the one the line was typed on), everything from there cleared, then the line.
        assert stream.getvalue().startswith("\x1b[1A\r\x1b[J")
        assert self.drawn(stream) == ['\x1b[1A\r\x1b[J  2 │ person = "Bo"']
        assert repl.lines == [HEADER, 'person = "Bo"']

    def test_a_line_longer_than_the_terminal_continues_between_words_under_its_own_beginning(self, isolated: Path, llm: FakeLLM, monkeypatch: pytest.MonkeyPatch) -> None:
        repl, stream = self.on_a_terminal(isolated, monkeypatch, have=[HEADER, 'person = "Bo"'])
        long_line = 'show ("Hi, " + person + "! Your name has " + count(person) + " letters.")'
        repl._entered(3, long_line)
        # Typed, it filled two rows of 55 columns and broke inside "count".
        assert stream.getvalue().startswith("\x1b[2A\r\x1b[J")
        first, second = self.drawn(stream)
        assert first.removeprefix("\x1b[2A\r\x1b[J").startswith("  3 │ show (") and first.endswith("+")
        assert second.startswith(" " * 6) and second.strip() == 'count(person) + " letters.")'

    def test_a_command_is_set_without_a_number(self, isolated: Path, llm: FakeLLM, monkeypatch: pytest.MonkeyPatch) -> None:
        repl, stream = self.on_a_terminal(isolated, monkeypatch, have=[HEADER])
        repl._entered(2, ":target")
        assert self.drawn(stream) == ["\x1b[1A\r\x1b[J      :target", "python"]
        assert repl.lines == [HEADER]

    def test_enter_on_an_empty_first_line_gives_the_row_back(self, isolated: Path, llm: FakeLLM, monkeypatch: pytest.MonkeyPatch) -> None:
        repl, stream = self.on_a_terminal(isolated, monkeypatch)
        repl._entered(1, "")
        assert stream.getvalue() == "\x1b[1A\r\x1b[J"
        assert repl.lines == []

    def test_lines_pasted_at_once_are_set_as_the_lines_of_the_file(self, isolated: Path, llm: FakeLLM, monkeypatch: pytest.MonkeyPatch) -> None:
        repl, stream = self.on_a_terminal(isolated, monkeypatch)
        repl._entered(1, HEADER + '\nperson = "Bo"\n\nshow ("Hi, " + person + "!")')
        # The header filled two rows as pasted, the three lines under it one each.
        assert stream.getvalue().startswith("\x1b[5A\r\x1b[J")
        assert self.drawn(stream) == [
            '\x1b[5A\r\x1b[J  1 │ # ("greets one person by name and says how long',
            '      the name is")',
            '  2 │ person = "Bo"',
            "  3 │",
            '  4 │ show ("Hi, " + person + "!")',
        ]
        assert repl.lines == [HEADER, 'person = "Bo"', "", 'show ("Hi, " + person + "!")']

    def test_a_paste_that_ends_in_a_line_break_took_no_row_for_it(self, isolated: Path, llm: FakeLLM, monkeypatch: pytest.MonkeyPatch) -> None:
        repl, stream = self.on_a_terminal(isolated, monkeypatch, have=[HEADER])
        # The cursor already stood on the empty last row, and Enter stayed on it.
        repl._entered(2, 'person = "Bo"\nshow (person)\n')
        assert stream.getvalue().startswith("\x1b[2A\r\x1b[J")
        assert repl.lines == [HEADER, 'person = "Bo"', "show (person)"]

    def test_what_came_in_while_typing_goes_above_the_line_under_the_lines_it_came_from(self, isolated: Path, llm: FakeLLM, monkeypatch: pytest.MonkeyPatch) -> None:
        repl, stream = self.on_a_terminal(isolated, monkeypatch, have=[HEADER, 'person = "Bo"'])
        llm.queue(reply('person = "Bo"\n'))
        job = LiveJob(number=1, lines=(HEADER, 'person = "Bo"'), target="python")
        repl._live_deliver(LiveOutcome(job=job, result=repl._live_convert(job)))
        repl._entered(3, 'show ("Hi, " + person + "!")')
        assert self.drawn(stream) == ['\x1b[1A\r\x1b[J    ┆ 1 person = "Bo"', '  3 │ show ("Hi, " + person + "!")']

    def test_of_conversions_that_came_in_together_only_the_newest_is_shown(self, isolated: Path, llm: FakeLLM, monkeypatch: pytest.MonkeyPatch) -> None:
        lines = ['# ("greets each person on a list")', 'people = ["Bo", "Ava"]', "for each person in people ::", "  show (person)"]
        repl, stream = self.on_a_terminal(isolated, monkeypatch, have=lines)
        # The model was asked when the loop had nothing in it yet, and again with the line in it.
        llm.queue(reply('people = ["Bo", "Ava"]\nfor person in people:\n    pass\n'), reply('people = ["Bo", "Ava"]\nfor person in people:\n    print(person)\n'))
        for number, upto in enumerate((3, 4), start=1):
            job = LiveJob(number=number, lines=tuple(lines[:upto]), target="python")
            repl._live_deliver(LiveOutcome(job=job, result=repl._live_convert(job)))
        assert repl._show_held() == 3
        assert self.drawn(stream) == ['    ┆ 1 people = ["Bo", "Ava"]', "    ┆ 2 for person in people:", "    ┆ 3     print(person)"]
        # Nothing is held any more, and a result with nothing new writes nothing.
        assert repl._show_held() == 0

    def test_where_the_rows_cannot_be_told_for_sure_the_line_stays_as_typed(self, isolated: Path, llm: FakeLLM, monkeypatch: pytest.MonkeyPatch) -> None:
        repl, stream = self.on_a_terminal(isolated, monkeypatch, have=[HEADER])
        margin = len("  2 │ ")
        for typed in (
            "x" * (55 - margin),  # ends exactly at the right edge
            "x" * (110 - margin),  # and two rows of that
            'show ("日本語")',  # letters two places wide
            "a\tb",  # a tab
            "x" * (55 * 40),  # more rows than the terminal has
            'person = "Bo"\n' + "y" * 55,  # a pasted line that ends exactly at the right edge
        ):
            assert repl._rows_of(typed.split("\n"), 2) is None
            repl._entered(2, typed)
        assert stream.getvalue() == ""
        # The lines are in the file all the same.
        assert repl.lines[1] == "x" * (55 - margin) and repl.lines[-1] == "y" * 55
        # A width set in the environment that is not the terminal's: readline wrapped by the terminal's.
        other, other_stream = self.on_a_terminal(isolated, monkeypatch, have=[HEADER], reported=80)
        other._entered(2, 'person = "Bo"')
        assert other_stream.getvalue() == ""

    def test_nothing_is_drawn_again_where_there_is_no_terminal(self, isolated: Path, llm: FakeLLM) -> None:
        repl, console = make(isolated, [HEADER, 'person = "Bo"'], live=False)
        repl.loop()
        assert "\x1b" not in console.export_text()


class TestWhatCountsAsALine:
    """Lines of the program and the console's commands, however they are entered."""

    def test_lines_pasted_at_once_are_taken_one_by_one(self, isolated: Path, llm: FakeLLM) -> None:
        prompts: list[str] = []
        console = Console(record=True, width=120, force_terminal=False, file=io.StringIO())
        feed = iter([HEADER + '\nperson = "Bo"\r\nshow ("Hi, " + person)\n\n', ":show"])

        def read(prompt: str) -> str:
            prompts.append(prompt)
            try:
                return next(feed)
            except StopIteration:
                raise EOFError from None

        session = open_session(isolated / "console.imy")
        repl = ImyConsole(lambda p, m: session, target="python", console=console, input_fn=read)
        repl.loop()
        # Three lines, each with its own number; the line breaks the paste ended with are not lines.
        assert repl.lines == [HEADER, 'person = "Bo"', 'show ("Hi, " + person)']
        assert prompts == ["  1 │ ", "  4 │ ", "  4 │ "]
        assert '  3 │ show ("Hi, " + person)' in console.export_text()

    def test_a_command_among_pasted_lines_is_carried_out_in_its_place(self, isolated: Path, llm: FakeLLM) -> None:
        repl, console = make(isolated, [HEADER + '\nperson = "Bo"\n:show\nshow (person)'], live=False)
        repl.loop()
        text = console.export_text()
        # The listing came when two lines were in; the third was added after it.
        assert '  2 │ person = "Bo"' in text and "  3 │" not in text
        assert repl.lines == [HEADER, 'person = "Bo"', "show (person)"]

    def test_quit_among_pasted_lines_leaves_at_once(self, isolated: Path, llm: FakeLLM) -> None:
        repl, _ = make(isolated, [HEADER + "\n:quit\nshow (1)", "show (2)"], live=False)
        repl.loop()
        assert repl.lines == [HEADER]

    def test_a_line_that_begins_with_a_colon_and_no_letter_is_code(self, isolated: Path, llm: FakeLLM) -> None:
        # The countdown example closes its loop with `:: end`: it can be typed as it stands.
        repl, console = make(isolated, ['# ("counts down")', "loop while count > 0 ::", "  count <- count - 1", ":: end", ":= x", ":show"], live=False)
        repl.loop()
        text = console.export_text()
        assert repl.lines[3:] == [":: end", ":= x"]
        assert "  4 │ :: end" in text and "Unknown command" not in text

    def test_a_colon_and_a_word_is_always_a_command(self, isolated: Path, llm: FakeLLM) -> None:
        repl, console = make(isolated, [HEADER, ":shwo", ":?"], live=False)
        repl.loop()
        text = console.export_text()
        assert "Unknown command :shwo (:help)" in text and ":quit" in text
        assert repl.lines == [HEADER]

    def test_a_line_of_nothing_but_spaces_is_an_empty_line(self, isolated: Path, llm: FakeLLM) -> None:
        repl, _ = make(isolated, ["   ", HEADER, "    ", "show (1)"], live=False)
        repl.loop()
        # Nothing before the first line; inside the program an empty line, without the spaces.
        assert repl.lines == [HEADER, "", "show (1)"]


class TestIndentation:
    def test_the_next_line_begins_as_the_one_before_it(self, isolated: Path, llm: FakeLLM) -> None:
        repl, _ = make(isolated, [], live=False)
        assert repl._next_indent() == ""
        repl._take_lines([HEADER, "def greet(person):", "    show (person)"], drawn=False)
        assert repl._next_indent() == "    "
        # An empty line inside a block keeps the block's indentation for the line after it.
        repl._take_lines(["    "], drawn=False)
        assert repl.lines[-1] == "" and repl._next_indent() == "    "
        # A line that begins at the margin ends the block.
        repl._take_lines(['greet ("Ava")'], drawn=False)
        assert repl._next_indent() == ""

    def test_a_command_behind_the_indentation_the_console_put_there_is_a_command(self, isolated: Path, llm: FakeLLM) -> None:
        repl, console = make(isolated, [], live=False)
        repl._take_lines([HEADER, "loop while count > 0 ::", "  say >> count"], drawn=False)
        repl._take_lines(["  :undo"], drawn=False, prefilled="  ")
        assert repl.lines == [HEADER, "loop while count > 0 ::"]
        assert "removed:   say >> count" in console.export_text()
        # After a command the next line begins as the last line of the file does.
        assert repl._next_indent() == ""
        # Spaces the writer typed before a colon are the writer's own: that is a line of code.
        repl._take_lines(["  :undo"], drawn=False)
        repl._take_lines(["    :undo"], drawn=False, prefilled="  ")
        assert repl.lines[-2:] == ["  :undo", "    :undo"]

    def test_text_that_arrived_at_once_brings_its_own_indentation(self, isolated: Path, llm: FakeLLM) -> None:
        repl, _ = make(isolated, [], live=False)
        # Typed key by key: spaces behind the indentation the console put there are more indentation.
        repl._burst = 1
        assert repl._own_indentation("    count <- 1", "  ") == "    count <- 1"
        # A whole line that came together with its Enter (a paste the terminal did not mark,
        # a phone keyboard committing a line) has its indentation in it already.
        repl._burst = len("  count <- 1") + 1
        assert repl._own_indentation("    count <- 1", "  ") == "  count <- 1"
        # So have several lines pasted at once, however they came.
        repl._burst = 1
        assert repl._own_indentation('    count <- 1\n  say >> "tick"', "  ") == '  count <- 1\n  say >> "tick"'
        # Text that begins at the cursor is put where the cursor stood.
        repl._burst = 99
        assert repl._own_indentation("  count <- 1", "  ") == "  count <- 1"
        assert repl._own_indentation("count <- 1", "") == "count <- 1"

    def test_tab_indents_to_the_next_stop_in_the_step_the_code_uses(self, isolated: Path, llm: FakeLLM, monkeypatch: pytest.MonkeyPatch) -> None:
        import types

        repl, _ = make(isolated, [], live=False)
        state = {"buffer": "", "end": 0}
        monkeypatch.setattr(repl, "_readline", types.SimpleNamespace(get_line_buffer=lambda: state["buffer"], get_endidx=lambda: state["end"]))
        # Four spaces until the code shows another habit.
        assert repl._complete("", 0) == "    " and repl._complete("", 1) is None
        state.update(buffer="  say", end=5)
        assert repl._complete("say", 0) == "say   "
        repl.lines = [HEADER, "loop ::", "  say >> count"]
        state.update(buffer="", end=0)
        assert repl._complete("", 0) == "  "
        state.update(buffer="   x", end=3)
        assert repl._complete("", 0) == " "

    def test_tab_after_a_command_completes_a_file_name(self, isolated: Path, llm: FakeLLM, monkeypatch: pytest.MonkeyPatch) -> None:
        import types

        (isolated / "notes.imy").write_text(HEADER + "\n", encoding="utf-8")
        (isolated / "notes-old.imy").write_text(HEADER + "\n", encoding="utf-8")
        (isolated / "notebook").mkdir()
        repl, _ = make(isolated, [], live=False)
        monkeypatch.chdir(isolated)
        monkeypatch.setattr(repl, "_readline", types.SimpleNamespace(get_line_buffer=lambda: ":load note", get_endidx=lambda: 10))
        found = [repl._complete("note", state) for state in range(4)]
        assert found == [f"notebook{os.sep}", "notes-old.imy", "notes.imy", None]
        # A completion that fails gives nothing and never ends the console.
        monkeypatch.setattr(repl, "_readline", types.SimpleNamespace())
        assert repl._complete("note", 0) is None


class Terminal:
    """`imy console` in a pseudo-terminal of a phone's width: keys go in, every byte it writes comes out."""

    def __init__(self, folder: Path, env: dict[str, str], *args: str, columns: int = 55, rows: int = 40) -> None:
        import fcntl
        import pty
        import struct
        import termios

        self.out = b""
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(folder)
            os.execve(sys.executable, [sys.executable, "-m", "imy", "console", *args], env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    def read(self, seconds: float) -> bytes:
        """Everything written in the next ``seconds``."""
        import select

        got = b""
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([self.fd], [], [], 0.05)
            if ready:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                got += data
        self.out += got
        return got

    def until(self, marker: str, seconds: float = 30.0) -> bytes:
        """Read until ``marker`` has been written since the last call; return what came."""
        wanted = marker.encode()
        got = b""
        end = time.time() + seconds
        while wanted not in got:
            assert time.time() < end, f"never saw {marker!r} in {got[-400:]!r}"
            got += self.read(0.05)
        return got

    def type(self, keys: str) -> None:
        for key in keys:
            os.write(self.fd, key.encode())
            time.sleep(0.01)

    def paste(self, text: str) -> None:
        """Paste as a terminal does: between the two marks, line breaks as carriage returns."""
        os.write(self.fd, b"\x1b[200~" + text.replace("\n", "\r").encode() + b"\x1b[201~")

    def ended(self, seconds: float = 20.0) -> int:
        """Wait for the console to end by itself; its exit code."""
        end = time.time() + seconds
        while True:
            self.read(0.05)
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                os.close(self.fd)
                return os.waitstatus_to_exitcode(status)
            assert time.time() < end, f"still running after {self.out[-300:]!r}"

    def leave(self) -> int:
        self.type(":quit\n")
        return self.ended()


# Automa's free-models bridge, standing in: the program so far in Python, after a short wait.
COMPILING_BRIDGE = r"""
import json, os, sys, time
request = json.loads(sys.stdin.read())
if request.get("op") == "models":
    print(json.dumps({"ok": True, "models": [{"id": "free/fast", "label": "Fast"}]}))
    raise SystemExit(0)
time.sleep(float(os.environ.get("BRIDGE_WAIT", "0")))
asked = request["messages"][-1]["content"]
code = 'person = "Bo"\n' + ('print("Hi, " + person + "!")\n' if "show (" in asked else "")
answer = {"status": "ok", "errors": [], "extracted_symbols": [], "target_language": "python", "compiled_code": code}
with open(os.environ["BRIDGE_ANSWERED"], "a", encoding="utf-8") as log:
    log.write("answered\n")
print(json.dumps({"ok": True, "text": json.dumps(answer), "model": request["model"]}))
"""


# Another stand-in: a loop with nothing in it yet gets `pass`, as a model writes it; each
# request is logged when it comes and when it is answered.
LOOP_BRIDGE = r"""
import json, os, sys, time
request = json.loads(sys.stdin.read())
if request.get("op") == "models":
    print(json.dumps({"ok": True, "models": [{"id": "free/fast", "label": "Fast"}]}))
    raise SystemExit(0)
def log(word):
    with open(os.environ["BRIDGE_LOG"], "a", encoding="utf-8") as handle:
        handle.write(word + "\n")
log("asked")
time.sleep(float(os.environ.get("BRIDGE_WAIT", "0")))
asked = request["messages"][-1]["content"]
body = "    print(person)\n" if "show (person)" in asked else "    pass\n"
answer = {"status": "ok", "errors": [], "extracted_symbols": [], "target_language": "python", "compiled_code": "for person in people:\n" + body}
log("answered")
print(json.dumps({"ok": True, "text": json.dumps(answer), "model": request["model"]}))
"""


def gnu_readline() -> bool:
    """Tab, kept indentation and pasted blocks need GNU readline (not the editline stand-in)."""
    try:
        import readline
    except ImportError:
        return False
    return getattr(readline, "backend", "") != "editline" and "libedit" not in (readline.__doc__ or "")


@pytest.mark.skipif(sys.platform == "win32", reason="needs a pseudo-terminal")
class TestOnARealTerminal:
    ERASE_ONE = "\x1b[1A\r\x1b[J"
    CLEAR_ROW = "\r\x1b[2K"

    def env(self, home: Path, **extra: str) -> dict[str, str]:
        env = {key: value for key, value in os.environ.items() if key not in ("COLUMNS", "LINES", "NO_COLOR", "IMY_LIVE")}
        env.update(HOME=str(home), IMY_HOME=str(home / "imy-home"), TERM="xterm-256color", **extra)
        return env

    def plain(self, written: bytes | str) -> str:
        """What was written without the colours and cursor moves, one entry per row."""
        import re

        text = written.decode("utf-8", "replace") if isinstance(written, bytes) else written
        return re.sub(r"\x1b\[[0-9;?]*[A-Za-z]|[\x01\x02\r]", "", text)

    def test_it_reads_like_a_file_being_written(self, tmp_path: Path) -> None:
        terminal = Terminal(tmp_path, self.env(tmp_path), "--no-live", "--to", "ruby")
        opened = terminal.until("  1 │")
        # The first line is the program file's name; there is no name before every line.
        assert self.plain(opened).lstrip().startswith("main.rb  IMY ")

        terminal.type(HEADER + "\n")
        header = terminal.until("  2 │").decode("utf-8", "replace")
        # Typed, the header filled two rows of 55 columns; they are taken back and it is set again whole.
        assert "\x1b[2A\r\x1b[J" in header
        again = self.plain(header.split("\x1b[2A\r\x1b[J", 1)[1])
        assert again.split("\n")[0].rstrip() == '  1 │ # ("greets one person by name and says how long'
        assert again.split("\n")[1].strip() == 'the name is")'

        terminal.type('person = "Bo"\n')
        line = terminal.until("  3 │").decode("utf-8", "replace")
        assert self.ERASE_ONE in line and self.plain(line.split(self.ERASE_ONE, 1)[1]).startswith('  2 │ person = "Bo"')
        # Quoted text is coloured where the line is set again.
        assert '\x1b[33m"Bo"' in line.split(self.ERASE_ONE, 1)[1]

        terminal.type(":show\n")
        shown = terminal.until("  3 │").decode("utf-8", "replace")
        # A command keeps no number: the numbered lines are the file.
        after = self.plain(shown.split(self.ERASE_ONE, 1)[1]).split("\n")
        assert after[0].rstrip() == "      :show"
        assert [row.rstrip() for row in after[1:4]] == ['  1 │ # ("greets one person by name and says how long', '      the name is")', '  2 │ person = "Bo"']

        assert terminal.leave() == 0
        assert "imy>" not in self.plain(terminal.out)

    def test_a_result_is_written_while_the_next_line_is_waited_for_and_never_over_one_being_typed(self, tmp_path: Path) -> None:
        bridge = tmp_path / "bridge.py"
        bridge.write_text(COMPILING_BRIDGE, encoding="utf-8")
        answered = tmp_path / "answered"
        env = self.env(tmp_path, IMY_AUTOMA_BRIDGE=f"{sys.executable} {bridge}", BRIDGE_WAIT="1.5", BRIDGE_ANSWERED=str(answered))
        terminal = Terminal(tmp_path, env, "--live", "--free-model", "free/fast")
        terminal.until("  1 │")
        terminal.type(HEADER + "\n")
        terminal.until("  2 │")
        terminal.type('person = "Bo"\n')
        terminal.until("  3 │")

        # The answer for lines 1-2 comes in while line 3 is half typed: nothing is written but the keys.
        terminal.type('show ("Hi, " + p')
        waiting = b""
        deadline = time.time() + 60
        while not answered.exists():
            assert time.time() < deadline, "the model was never asked"
            waiting += terminal.read(0.05)
        during = (waiting + terminal.read(1.0)).decode("utf-8", "replace")
        assert "┆" not in during
        # (The row is cleared once, when the first key hands the line over to the line editor.)
        assert during.count(self.CLEAR_ROW) == 1
        assert self.plain(during.split(self.CLEAR_ROW)[1]) == '  3 │ show ("Hi, " + p'

        # It is shown the moment that line is entered: above the line, under the lines it came from.
        terminal.type('erson + "!")\n')
        entered = terminal.until("  4 │").decode("utf-8", "replace") + terminal.read(0.3).decode("utf-8", "replace")
        rows = self.plain(entered.split(self.ERASE_ONE, 1)[1]).split("\n")
        assert [row.rstrip() for row in rows[:3]] == ['    ┆ 1 person = "Bo"', '  3 │ show ("Hi, " + person + "!")', "  4 │"]

        # Nothing is typed now: the answer for lines 1-3 takes the waiting row, and the row is given back under it.
        idle = terminal.until("┆ 2").decode("utf-8", "replace") + terminal.read(0.5).decode("utf-8", "replace")
        assert idle.count(self.CLEAR_ROW) == 1
        rows = self.plain(idle.split(self.CLEAR_ROW)[1]).split("\n")
        assert [row.rstrip() for row in rows] == ['    ┆ 2 print("Hi, " + person + "!")', "  4 │"]

        assert terminal.leave() == 0

    def rows_after(self, written: bytes, mark: str) -> list[str]:
        """The rows written after ``mark``, without colours."""
        text = written.decode("utf-8", "replace")
        assert mark in text, f"{mark!r} not in {text[-400:]!r}"
        return [row.rstrip() for row in self.plain(text.split(mark, 1)[1]).split("\n")]

    @pytest.mark.skipif(not gnu_readline(), reason="needs GNU readline")
    def test_lines_pasted_at_once_become_the_numbered_lines_of_the_file(self, tmp_path: Path) -> None:
        terminal = Terminal(tmp_path, self.env(tmp_path), "--no-live")
        terminal.until("  1 │")
        terminal.paste(HEADER + '\nperson = "Bo"\n\nshow ("Hi, " + person + "!")\n')
        terminal.until('"!")')
        terminal.type("\n")
        entered = terminal.until("  5 │")
        # As pasted: the header on two rows, three rows under it, and the cursor on an empty one.
        assert self.rows_after(entered, "\x1b[5A\r\x1b[J")[:6] == [
            '  1 │ # ("greets one person by name and says how long',
            '      the name is")',
            '  2 │ person = "Bo"',
            "  3 │",
            '  4 │ show ("Hi, " + person + "!")',
            "  5 │",
        ]
        terminal.type(":del 3\n")
        terminal.until("  4 │")
        terminal.type(":show\n")
        shown = terminal.until("  4 │")
        assert self.rows_after(shown, self.ERASE_ONE)[3:5] == ['  2 │ person = "Bo"', '  3 │ show ("Hi, " + person + "!")']
        assert terminal.leave() == 0

    @pytest.mark.skipif(not gnu_readline(), reason="needs GNU readline")
    def test_a_line_begins_where_the_one_before_it_began(self, tmp_path: Path) -> None:
        terminal = Terminal(tmp_path, self.env(tmp_path), "--no-live")
        terminal.until("  1 │")
        for number, line in enumerate(['# ("counts down")', "loop while count > 0 ::", "  say >> count"], start=2):
            terminal.type(line + "\n")
            terminal.until(f"  {number} │")
        # Nothing but the line is typed: the two spaces are already there.
        terminal.type("count <- count - 1\n")
        assert self.rows_after(terminal.until("  5 │"), self.ERASE_ONE)[0] == "  4 │   count <- count - 1"
        # A command typed behind them is a command.
        terminal.type(":del 4\n")
        assert self.rows_after(terminal.until("  4 │"), self.ERASE_ONE)[:2] == ["      :del 4", "removed line 4:   count <- count - 1"]
        # Backspace takes the indentation away; a colon with no letter after it is code.
        terminal.type("\x7f\x7f:: end\n")
        assert self.rows_after(terminal.until("  5 │"), self.ERASE_ONE)[0] == "  4 │ :: end"
        assert terminal.leave() == 0

    @pytest.mark.skipif(not gnu_readline(), reason="needs GNU readline")
    def test_lines_that_arrive_at_once_in_a_block_keep_their_own_indentation(self, tmp_path: Path) -> None:
        terminal = Terminal(tmp_path, self.env(tmp_path), "--no-live")
        terminal.until("  1 │")
        for number, line in enumerate(['# ("counts down")', "loop while count > 0 ::", "  say >> count"], start=2):
            terminal.type(line + "\n")
            terminal.until(f"  {number} │")
        terminal.read(0.3)
        # Two lines at once, as a terminal without paste marks or a phone keyboard sends them: the
        # console had put two spaces first, and the lines bring two of their own.
        os.write(terminal.fd, b'  count <- count - 1\n  say >> "tick"\n')
        terminal.until("  6 │")
        # With the terminal's paste marks it is the same.
        terminal.paste('  say >> "tock"\n')
        terminal.until('"tock"')
        terminal.type("\n")
        terminal.until("  7 │")
        # Typed key by key, spaces behind the indentation are more indentation.
        terminal.type(" ")
        terminal.read(0.2)
        terminal.type(" deeper\n")
        terminal.until("  8 │")
        terminal.type(":show\n")
        shown = self.rows_after(terminal.until("  8 │"), self.ERASE_ONE)
        assert shown[3:8] == ["  3 │   say >> count", "  4 │   count <- count - 1", '  5 │   say >> "tick"', '  6 │   say >> "tock"', "  7 │     deeper"]
        assert terminal.leave() == 0

    @pytest.mark.skipif(not gnu_readline(), reason="needs GNU readline")
    def test_tab_indents_a_line_of_code_and_completes_a_file_name_after_a_command(self, tmp_path: Path) -> None:
        (tmp_path / "example-file.imy").write_text('# ("from a file")\nshow ("loaded")\n', encoding="utf-8")
        terminal = Terminal(tmp_path, self.env(tmp_path), "--no-live")
        terminal.until("  1 │")
        terminal.type('# ("greets")\n')
        terminal.until("  2 │")
        terminal.type("def greet(person):\n")
        terminal.until("  3 │")
        terminal.type("\tshow (person)\n")
        assert self.rows_after(terminal.until("  4 │"), self.ERASE_ONE)[0] == "  3 │     show (person)"
        terminal.type("\x7f\x7f\x7f\x7f:load exa\t\n")
        assert self.rows_after(terminal.until("  3 │"), self.ERASE_ONE)[:3] == ["      :load example-file.imy", '  1 │ # ("from a file")', '  2 │ show ("loaded")']
        assert terminal.leave() == 0

    def loop_bridge(self, tmp_path: Path, wait: str) -> tuple[dict[str, str], Path]:
        bridge = tmp_path / "bridge.py"
        bridge.write_text(LOOP_BRIDGE, encoding="utf-8")
        log = tmp_path / "bridge.log"
        return self.env(tmp_path, IMY_AUTOMA_BRIDGE=f"{sys.executable} {bridge}", BRIDGE_WAIT=wait, BRIDGE_LOG=str(log)), log

    def logged(self, terminal: Terminal, log: Path, word: str, times: int, seconds: float = 60.0) -> bytes:
        """Read the terminal until the bridge has logged ``word`` that many times."""
        got = b""
        deadline = time.time() + seconds
        while not log.exists() or log.read_text(encoding="utf-8").split().count(word) < times:
            assert time.time() < deadline, f"the bridge never logged {word!r} {times} times"
            got += terminal.read(0.05)
        return got

    def test_a_newer_result_takes_the_place_of_the_one_just_written(self, tmp_path: Path) -> None:
        env, log = self.loop_bridge(tmp_path, "1.0")
        terminal = Terminal(tmp_path, env, "--live", "--free-model", "free/fast")
        terminal.until("  1 │")
        terminal.type('# ("greets each person on a list")\n')
        terminal.until("  2 │")
        # Two lines entered before the first answer is in: the loop is asked about while it is still empty.
        terminal.type("for each person in people ::\n")
        terminal.until("  3 │")
        terminal.type("  show (person)\n")
        terminal.until("  4 │")
        written = self.logged(terminal, log, "answered", 2) + terminal.read(1.0)
        text = written.decode("utf-8", "replace")
        # The first answer was written above the waiting margin...
        first, second = text.split("\x1b[2A\r\x1b[J", 1)
        assert [row.rstrip() for row in self.plain(first.split(self.CLEAR_ROW)[1]).split("\n")[:2]] == ["    ┆ 1 for person in people:", "    ┆ 2     pass"]
        # ...and the second took its two rows: the program stands there once, without the `pass`.
        assert [row.rstrip() for row in self.plain(second).split("\n")] == ["    ┆ 1 for person in people:", "    ┆ 2     print(person)", "  4 │"]
        assert terminal.leave() == 0

    def test_keys_pressed_during_a_compile_are_not_shown_in_the_line_that_counts_the_seconds(self, tmp_path: Path) -> None:
        env, log = self.loop_bridge(tmp_path, "2.0")
        terminal = Terminal(tmp_path, env, "--no-live", "--free-model", "free/fast")
        terminal.until("  1 │")
        terminal.type('# ("greets each person on a list")\n')
        terminal.until("  2 │")
        terminal.type("for each person in people ::\n")
        terminal.until("  3 │")
        terminal.type(":check\n")
        written = self.logged(terminal, log, "asked", 1)
        # Typed while the model is waited for: shown, it would land in the line being redrawn.
        terminal.type(":show\n")
        written += self.logged(terminal, log, "answered", 1)
        deadline = time.time() + 60
        while b"for each person in people ::" not in written:
            assert time.time() < deadline, f"the listing never came: {written[-300:]!r}"
            written += terminal.read(0.05)
        written += terminal.read(0.5)
        waited, answered = written.decode("utf-8", "replace").split("✓", 1)
        assert "Compiling to python" in waited and ":show" not in waited
        # It is not lost: once the answer is in, it is taken as typed.
        assert [row.rstrip() for row in self.plain(answered.split(self.ERASE_ONE)[-1]).split("\n")[:4]] == [
            "      :show", '  1 │ # ("greets each person on a list")', "  2 │ for each person in people ::", "  3 │"]
        assert terminal.leave() == 0

    def test_a_kill_ends_it_like_quit_with_the_terminal_put_back(self, tmp_path: Path) -> None:
        import signal
        import termios

        terminal = Terminal(tmp_path, self.env(tmp_path), "--no-live")
        terminal.until("  1 │")
        terminal.type(HEADER + "\n")
        terminal.until("  2 │")
        terminal.read(0.3)
        # While it waits for a key the terminal reports keys at once and shows none itself.
        assert not termios.tcgetattr(terminal.fd)[3] & (termios.ICANON | termios.ECHO)
        os.kill(terminal.pid, signal.SIGTERM)
        end = time.time() + 20
        while True:
            pid, status = os.waitpid(terminal.pid, os.WNOHANG)
            if pid:
                break
            assert time.time() < end, "still running after SIGTERM"
            terminal.read(0.05)
        assert os.waitstatus_to_exitcode(status) == 128 + signal.SIGTERM
        modes = termios.tcgetattr(terminal.fd)[3]
        os.close(terminal.fd)
        assert modes & termios.ICANON and modes & termios.ECHO
        # The line typed is kept for the next time, as after :quit.
        assert HEADER in (tmp_path / ".imy" / "console" / "history").read_text(encoding="utf-8")

    def test_ctrl_c_with_nothing_typed_leaves_the_margin_where_it_is(self, tmp_path: Path) -> None:
        terminal = Terminal(tmp_path, self.env(tmp_path), "--no-live")
        terminal.until("  1 │")
        terminal.type(HEADER + "\n")
        terminal.until("  2 │")
        terminal.read(0.3)
        terminal.type("\x03")
        again = terminal.until("  2 │").decode("utf-8", "replace")
        # The row is cleared and the same margin drawn on it: no empty numbered row is left behind.
        assert again.startswith(self.CLEAR_ROW) and "\n" not in again
        # With a line half typed, Ctrl+C gives it up: the same number is asked for again on the next row.
        terminal.type('person = "B')
        terminal.read(0.3)
        terminal.type("\x03")
        given_up = terminal.until("  2 │").decode("utf-8", "replace")
        assert "\n" in given_up
        terminal.type('person = "Bo"\n')
        terminal.until("  3 │")
        terminal.type(":show\n")
        assert self.rows_after(terminal.until("  3 │"), self.ERASE_ONE)[1:4] == ['  1 │ # ("greets one person by name and says how long', '      the name is")', '  2 │ person = "Bo"']
        assert terminal.leave() == 0

    def test_ctrl_d_on_an_empty_line_leaves(self, tmp_path: Path) -> None:
        terminal = Terminal(tmp_path, self.env(tmp_path), "--no-live")
        terminal.until("  1 │")
        terminal.type(HEADER + "\n")
        terminal.until("  2 │")
        terminal.type("\x04")
        assert terminal.ended() == 0


class TestBackgroundWorker:
    def test_results_arrive_in_order_and_the_newest_buffer_is_next(self) -> None:
        started = threading.Event()
        release = threading.Event()
        seen: list[tuple[tuple[str, ...], bool]] = []
        done = threading.Event()

        def convert(job: LiveJob):  # type: ignore[no-untyped-def]
            if len(job.lines) == 1:
                started.set()
                assert release.wait(5)
            return None

        def deliver(outcome: LiveOutcome) -> None:
            seen.append((outcome.job.lines, outcome.stale))
            if len(seen) == 2:
                done.set()

        live = LivePreview(convert=convert, deliver=deliver)  # type: ignore[arg-type]
        live.submit(["a"], "python")
        assert started.wait(5)
        # Three more lines are entered while the first request is out: only the newest is converted next.
        live.submit(["a", "b"], "python")
        live.submit(["a", "b", "c"], "python")
        live.submit(["a", "b", "c", "d"], "python")
        release.set()
        assert done.wait(5)
        assert live.wait_idle(5)
        assert seen == [(("a",), True), (("a", "b", "c", "d"), False)]
        live.close()

    def test_a_cleared_or_run_buffer_never_reports(self) -> None:
        started = threading.Event()
        release = threading.Event()
        seen: list[tuple[str, ...]] = []

        def convert(job: LiveJob):  # type: ignore[no-untyped-def]
            started.set()
            assert release.wait(5)
            return None

        live = LivePreview(convert=convert, deliver=lambda outcome: seen.append(outcome.job.lines))  # type: ignore[arg-type]
        live.submit(["old program"], "python")
        assert started.wait(5)
        live.forget()
        started.clear()
        live.submit(["new program"], "python")
        release.set()
        assert live.wait_idle(5)
        assert seen == [("new program",)]
        live.close()
        live.submit(["after closing"], "python")
        assert live.idle()

    def test_an_unexpected_failure_is_reported_not_raised(self) -> None:
        seen: list[LiveOutcome] = []

        def convert(job: LiveJob):  # type: ignore[no-untyped-def]
            raise RuntimeError("boom")

        live = LivePreview(convert=convert, deliver=seen.append)  # type: ignore[arg-type]
        live.submit(["a"], "python")
        assert live.wait_idle(5)
        time.sleep(0.05)
        assert len(seen) == 1 and seen[0].error is not None and "boom" in seen[0].error.message
        live.close()

    def test_a_result_that_arrives_during_a_command_waits_for_the_next_prompt(self, isolated: Path, llm: FakeLLM) -> None:
        llm.queue(reply('person = "Bo"\n'))
        gate = threading.Event()
        typed = iter([HEADER, 'person = "Bo"'])
        repl_box: list[ImyConsole] = []

        def read(prompt: str) -> str:
            try:
                return next(typed)
            except StopIteration:
                # The third prompt: wait until the background conversion has come in.
                assert repl_box[0]._live.wait_idle(10)
                gate.set()
                raise EOFError from None

        console = Console(record=True, width=120, force_terminal=False, file=io.StringIO())
        session = open_session(isolated / "console.imy")
        repl = ImyConsole(lambda p, m: session, target="python", console=console, input_fn=read, live=True)
        repl_box.append(repl)
        repl.loop()
        assert gate.is_set()
        # The worker writes nothing itself: the result was left for the console's own thread...
        assert len(repl._held) == 1
        assert "┆" not in console.export_text()
        repl._show_held()
        assert '    ┆ 1 person = "Bo"' in console.export_text()


class TestChangedLines:
    def test_new_and_changed_lines_with_their_numbers(self) -> None:
        assert changed_lines([], ["a", "b"]) == [(1, "a"), (2, "b")]
        assert changed_lines(["a", "b"], ["a", "b"]) == []
        assert changed_lines(["a", "b"], ["a", "b", "c"]) == [(3, "c")]
        assert changed_lines(["a", "b", "c"], ["a", "B", "c"]) == [(2, "B")]
        assert changed_lines(["a", "b", "c"], ["a", "c"]) == []
        assert changed_lines(["a"], ["x", "a", "y"]) == [(1, "x"), (3, "y")]


class TestDefault:
    def env(self, values: dict[str, str], origins: dict[str, str] | None = None) -> EnvView:
        return EnvView(values=values, origins=origins or {})

    def test_on_with_the_free_models_at_a_terminal_and_off_with_a_paid_key(self) -> None:
        assert live_by_default("automa", self.env({}), True) is True
        assert live_by_default("automa", self.env({}), False) is False
        assert live_by_default("anthropic", self.env({}), True) is False
        assert live_by_default("anthropic", self.env({"IMY_LIVE": "1"}), False) is True
        assert live_by_default("automa", self.env({"IMY_LIVE": "off"}), True) is False

    def test_a_projects_env_file_cannot_turn_paid_requests_on(self) -> None:
        from_file = self.env({"IMY_LIVE": "1"}, {"IMY_LIVE": "/project/.env"})
        assert live_by_default("anthropic", from_file, True) is False
        assert live_by_default("automa", from_file, True) is True
