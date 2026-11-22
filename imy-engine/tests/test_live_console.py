"""The console's live conversion: each line entered is checked at once and converted in the background."""

from __future__ import annotations

import io
import threading
import time
from pathlib import Path

import pytest
from rich.console import Console

from conftest import FakeLLM, reply
from imy.cli import live_by_default, open_session
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
        console = Console(record=True, width=width, force_terminal=False, file=io.StringIO())
        feed = iter(lines)

        def read(prompt: str) -> str:
            try:
                return next(feed)
            except StopIteration:
                raise EOFError from None

        session = open_session(isolated / "console.imy")
        return ImyConsole(lambda p, m: session, target="python", console=console, input_fn=read, live=True, live_inline=True), console

    def test_the_opening_lines_wrap_between_words(self, isolated: Path, llm: FakeLLM) -> None:
        repl, console = self.narrow(isolated, [])
        repl.loop()
        lines = console.export_text().split("\n")
        assert max(len(line) for line in lines) <= 52
        text = " ".join(" ".join(lines).split())
        # Every word is whole: wrapped by the terminal at 52 columns, "how" and "and" came apart.
        for phrase in ('# ("what it builds and how it works")', ":header what it builds and how it works", "picks another language", "in the background and shown as it arrives"):
            assert phrase in text, phrase

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

    def test_the_live_line_drops_the_models_name_when_it_does_not_fit(self, isolated: Path, llm: FakeLLM) -> None:
        llm.model = "nvidia/nemotron-3-ultra-550b-a55b:free"
        llm.queue(reply('person = "Bo"\n'))
        repl, console = self.narrow(isolated, [HEADER, 'person = "Bo"'])
        repl.loop()
        text = console.export_text()
        assert "┄ python for lines 1–2 (" in text and "nemotron" not in text
        assert max(len(line) for line in text.split("\n")) <= 52

        llm.queue(reply('person = "Bo"\n'))
        wide, wide_console = self.narrow(isolated, [HEADER, 'person = "Cy"'], width=120)
        wide.loop()
        assert "┄ python for lines 1–2 (nvidia/nemotron-3-ultra-550b-a55b:free" in wide_console.export_text()


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
        assert "python for lines 1–2" in text and "python for lines 1–3" in text
        assert "exit code 0" in text and "target is now ruby" in text
        after = text.split("target is now ruby")[1]
        assert "ruby for lines 1–3" in after
        assert 'puts("Hi, " + person + "!")' in after
        # A switch of language shows the whole program again, not only what differs from the Python.
        assert '1 │ person = "Bo"' in after
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
        assert "┄ python for lines 1–2" in text
        assert '1 │ person = "Bo"' in text
        assert "┄ python for lines 1–3" in text
        assert '2 │ print("Hi, " + person + "!")' in text
        assert "┄ python for lines 1–4" in text
        assert '3 │ print("Your name has " + str(len(person)) + " letters.")' in text
        # Each converted line is shown once, when it is new.
        assert text.count('│ person = "Bo"') == 1
        assert text.count('│ print("Hi, " + person + "!")') == 1
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
        assert ":undo removes the last line" in text
        # Said once, not again after the next line.
        assert text.count("PromptingDetected") == 1
        # Once the line is gone the program converts.
        assert "┄ python for lines 1–2" in text
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
        text = flat(console.export_text())
        assert "live conversion is off: nothing is converted until :run" in text
        assert "live conversion is off (:live on, :live off)" in text
        assert "live conversion is on: each line is converted to python as you enter it" in text
        # Turning it on converts what is already typed.
        assert "┄ python for lines 1–2" in text and llm.calls == 1
        assert "Usage: :live on or :live off" in text

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
        assert "It is asked again with your next line." in text
        assert "live conversion paused: Flint could not answer (400: Model not found)." in text
        assert "imy models --check" in text and ":live on turns it back on" in text
        # Paused: the last line asked nothing.
        assert llm.calls == 3 and repl.live_on is False

    def test_the_banner_says_whether_live_is_on(self, isolated: Path, llm: FakeLLM) -> None:
        repl, console = make(isolated, [])
        repl.loop()
        assert "Live: each line you enter is converted to python in the background" in flat(console.export_text())
        repl, console = make(isolated, [], live=False)
        repl.loop()
        assert "Live conversion is off, as every line would use your key. :live on turns it on." in flat(console.export_text())

    def test_replacing_the_buffer_starts_the_preview_over(self, isolated: Path, llm: FakeLLM) -> None:
        llm.queue(reply('person = "Bo"\n'), reply('person = "Bo"\n'))
        repl, console = make(isolated, [HEADER, 'person = "Bo"', ":clear", HEADER, 'person = "Bo"'])
        repl.loop()
        text = console.export_text()
        # The same conversion is shown again for the new buffer (from the cache: one request).
        assert text.count("┄ python for lines 1–2") == 2
        assert llm.calls == 1


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
        # Not a terminal, so nothing was written over the prompt: the result was kept...
        assert len(repl._held) == 1
        repl._show_held()
        assert "┄ python for lines 1–2" in console.export_text()


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
