from __future__ import annotations

import io
from pathlib import Path

import pytest
from rich.console import Console
from typer.testing import CliRunner

from conftest import FakeLLM, reply
from imy.cli import app, open_session
from imy.console import ImyConsole
from imy.errors import ConfigError
from imy.examples import ORDER, SHOWS, example_names, get_example, list_examples
from imy.parser import parse_text
from imy.static_rules import check

runner = CliRunner()


class TestShippedExamples:
    def test_every_example_is_listed_in_order_with_what_it_shows(self) -> None:
        assert example_names() == list(ORDER)
        assert set(SHOWS) == set(ORDER)
        for example in list_examples():
            assert example.shows
            assert len(example.description.split()) >= 3, example.name
            assert example.text.endswith("\n") and example.lines[0].startswith("# (")

    def test_every_example_passes_imys_own_rules(self) -> None:
        # session2 uses what session1 saved to memory.
        saved = {"greet", "XYZ"}
        for example in list_examples():
            report = check(parse_text(example.text), saved if example.name == "session2" else ())
            assert [d.headline() for d in report.diagnostics] == [], example.name

    def test_names_with_the_extension_or_a_clear_start_are_found(self) -> None:
        assert get_example("hello").name == "hello"
        assert get_example("hello.imy").name == "hello"
        assert get_example("count").name == "countdown"
        with pytest.raises(ConfigError) as caught:
            get_example("session")
        assert "session1, session2" in (caught.value.hint or "")
        with pytest.raises(ConfigError) as caught:
            get_example("nope")
        assert "hello" in (caught.value.hint or "")


class TestExamplesCommand:
    def test_lists_shows_and_copies(self, isolated: Path) -> None:
        listing = runner.invoke(app, ["examples"])
        assert listing.exit_code == 0
        for name in ORDER:
            assert name in listing.stdout
        assert "syntax you invent" in listing.stdout and ":example hello" in listing.stdout

        shown = runner.invoke(app, ["examples", "hello"])
        assert shown.exit_code == 0 and shown.stdout == get_example("hello").text

        copied = runner.invoke(app, ["examples", "hello", "--copy"])
        assert copied.exit_code == 0, copied.stderr
        assert (isolated / "hello.imy").read_text(encoding="utf-8") == get_example("hello").text
        assert "wrote hello.imy" in copied.stderr and "imy run hello.imy" in copied.stderr

    def test_copy_never_replaces_a_file_unless_told(self, isolated: Path) -> None:
        (isolated / "hello.imy").write_text("my own work\n", encoding="utf-8")
        refused = runner.invoke(app, ["examples", "--copy", "--all"])
        assert refused.exit_code == 2
        assert "hello.imy already exists here; nothing was written" in " ".join(refused.stderr.split())
        assert (isolated / "hello.imy").read_text(encoding="utf-8") == "my own work\n"
        assert not (isolated / "tip.imy").exists()

        forced = runner.invoke(app, ["examples", "--copy", "--all", "--force"])
        assert forced.exit_code == 0, forced.stderr
        assert sorted(p.name for p in isolated.glob("*.imy")) == sorted(f"{name}.imy" for name in ORDER)
        assert (isolated / "hello.imy").read_text(encoding="utf-8") == get_example("hello").text

    def test_wrong_combinations_say_what_to_type(self) -> None:
        assert "imy examples hello --copy" in " ".join(runner.invoke(app, ["examples", "--copy"]).stderr.split())
        assert "--all goes with --copy" in " ".join(runner.invoke(app, ["examples", "--all"]).stderr.split())
        missing = runner.invoke(app, ["examples", "nope"])
        assert missing.exit_code == 2 and "There is no example named 'nope'" in " ".join(missing.stderr.split())


class TestConsoleExamples:
    def make(self, isolated: Path, monkeypatch: pytest.MonkeyPatch, lines: list[str], llm: FakeLLM) -> tuple[ImyConsole, Console]:
        monkeypatch.setattr("imy.cli.make_client", lambda config, env: llm)
        console = Console(record=True, width=120, force_terminal=False, file=io.StringIO())
        feed = iter(lines)

        def read(prompt: str) -> str:
            try:
                return next(feed)
            except StopIteration:
                raise EOFError from None

        session = open_session(isolated / "console.imy")
        return ImyConsole(lambda p, m: session, target="python", console=console, input_fn=read), console

    def test_an_example_is_loaded_shown_and_runs(self, isolated: Path, monkeypatch: pytest.MonkeyPatch, capfd: pytest.CaptureFixture[str]) -> None:
        llm = FakeLLM([reply('count = 5\nwhile count > 0:\n    print(count)\n    count = count - 1\nprint("Liftoff!")\n')])
        repl, console = self.make(isolated, monkeypatch, [":examples", ":example countdown", ":run", ":quit"], llm)
        assert repl.loop() == 0
        text = console.export_text()
        assert "countdown   syntax you invent" in text
        assert "loaded countdown: 7 lines" in text
        assert "  2 │ count <- 5" in text
        assert repl.lines == get_example("countdown").lines
        assert capfd.readouterr().out == "5\n4\n3\n2\n1\nLiftoff!\n"
        # The list and the program, with no line telling what to type next and none after a run that ended well.
        assert "exit code" not in text and ":example <name>" not in text and "compiled to" not in text

    def test_loading_says_what_it_replaced_and_unknown_names_list_the_choices(self, isolated: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        repl, console = self.make(isolated, monkeypatch, ['# ("my own program that prints one line")', 'show ("mine")', ":example hello", ":example nope", ":example"], FakeLLM())
        repl.loop()
        text = console.export_text()
        assert "loaded hello: 5 lines (it replaced the 2 lines you had)" in text
        assert "There is no example named 'nope'" in text and "The examples are: hello, tip" in text
        assert repl.lines == get_example("hello").lines
