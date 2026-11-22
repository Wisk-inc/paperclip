from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from rich.console import Console
from typer.testing import CliRunner

from conftest import FIXTURES, FakeLLM, reply, symbol, write
from imy import __version__
from imy.cli import app, open_session
from imy.console import ImyConsole

runner = CliRunner()
HELLO_PY = 'name = "Ava"\nletters = len(name)\nprint("Hello, " + name + "!")\nprint("Your name has " + str(letters) + " letters.")\n'


@pytest.fixture
def llm(monkeypatch: pytest.MonkeyPatch) -> FakeLLM:
    fake = FakeLLM()
    monkeypatch.setattr("imy.cli.make_client", lambda config, env: fake)
    return fake


def hello(work: Path) -> Path:
    return write(work / "hello.imy", (FIXTURES / "valid_hello.imy").read_text(encoding="utf-8"))


def test_version() -> None:
    assert runner.invoke(app, ["--version"]).stdout.strip() == f"imy {__version__}"
    assert runner.invoke(app, ["version"]).stdout.strip() == f"imy {__version__}"


class TestInit:
    def test_non_interactive_setup(self, isolated: Path) -> None:
        result = runner.invoke(app, ["init", "--yes", "--provider", "openai-compatible", "--base-url", "http://localhost:11434/v1", "--model", "llama3.1"])
        assert result.exit_code == 0, result.stderr
        config = json.loads((Path(os.environ["IMY_HOME"]) / "config.json").read_text())
        assert config["provider"] == "openai-compatible"
        assert config["model"] == "llama3.1"
        assert config["base_url"] == "http://localhost:11434/v1"
        assert (isolated / ".imy" / "build").is_dir()
        assert (Path(os.environ["IMY_HOME"]) / "memory.json").exists()
        assert "IMY is set up" in result.stderr

    def test_key_from_stdin_is_stored_privately_and_never_printed(self, isolated: Path) -> None:
        result = runner.invoke(app, ["init", "--provider", "anthropic", "--api-key-stdin", "--local-memory"], input="sk-ant-secret-123\n")
        assert result.exit_code == 0, result.stderr
        path = Path(os.environ["IMY_HOME"]) / "config.json"
        assert json.loads(path.read_text())["api_key"] == "sk-ant-secret-123"
        assert oct(path.stat().st_mode & 0o777) == "0o600"
        assert "sk-ant-secret-123" not in result.stdout + result.stderr
        assert "set (stored in" in result.stderr
        assert (isolated / ".imy" / "memory.json").exists()

    def test_unknown_provider(self) -> None:
        result = runner.invoke(app, ["init", "--yes", "--provider", "nope"])
        assert result.exit_code == 2
        assert "Unknown provider" in result.stderr


class TestCheck:
    def test_static_only_needs_no_model(self, isolated: Path) -> None:
        result = runner.invoke(app, ["check", str(hello(isolated)), "--static"])
        assert result.exit_code == 0
        assert "VALID" in result.stdout

    def test_errors_show_codes_lines_and_the_source(self, isolated: Path) -> None:
        path = write(isolated / "order.imy", (FIXTURES / "invalid_order.imy").read_text(encoding="utf-8"))
        result = runner.invoke(app, ["check", str(path), "--static"])
        assert result.exit_code == 1
        text = result.stderr
        assert "CompilerError [ExecutionOrderViolation] line 3" in text
        assert "❱ 3 │ World.detect(walls)" in text
        assert "see line 5: physics.autohook" in text
        assert "nothing was run" in text

    def test_full_check_uses_the_model(self, isolated: Path, llm: FakeLLM) -> None:
        llm.queue(reply(HELLO_PY))
        result = runner.invoke(app, ["check", str(hello(isolated))])
        assert result.exit_code == 0, result.stderr
        assert "✓ VALID" in result.stdout and "→ python" in result.stdout
        assert llm.calls == 1

    def test_missing_file(self, isolated: Path) -> None:
        result = runner.invoke(app, ["check", str(isolated / "nope.imy"), "--static"])
        assert result.exit_code == 2
        assert "does not exist" in " ".join(result.stderr.split())

    def test_a_missing_file_creates_nothing_and_names_no_model(self, isolated: Path, llm: FakeLLM) -> None:
        for command in (["run"], ["check"], ["convert", "--to", "lua"]):
            result = runner.invoke(app, [command[0], str(isolated / "sub" / "nope.imy"), *command[1:]])
            assert result.exit_code == 2
            assert "does not exist" in " ".join(result.stderr.split())
            assert "Compiling" not in result.stderr
        assert not (isolated / "sub").exists() and not (isolated / ".imy").exists()
        assert llm.calls == 0

    def test_rule_errors_show_before_any_model_is_named(self, isolated: Path, llm: FakeLLM) -> None:
        path = write(isolated / "bad.imy", (FIXTURES / "invalid_prompting.imy").read_text(encoding="utf-8"))
        result = runner.invoke(app, ["run", str(path)])
        assert result.exit_code == 1
        assert "PromptingDetected" in result.stderr and "Compiling" not in result.stderr
        assert llm.calls == 0

    def test_missing_key_is_a_clean_error(self, isolated: Path) -> None:
        result = runner.invoke(app, ["check", str(hello(isolated)), "--provider", "openai"])
        assert result.exit_code == 2
        assert "No OpenAI (GPT) API key is set" in result.stderr
        assert "imy init" in result.stderr


class TestRunAndConvert:
    def test_run_saves_memory_and_runs(self, isolated: Path, llm: FakeLLM, capfd: pytest.CaptureFixture[str]) -> None:
        llm.queue(reply(HELLO_PY, symbols=[symbol("name", "variable", "the user's name, Ava")]))
        result = runner.invoke(app, ["run", str(hello(isolated))])
        assert result.exit_code == 0, result.stderr
        assert capfd.readouterr().out == "Hello, Ava!\nYour name has 3 letters.\n"
        assert "memory: saved name" in result.stderr
        listing = runner.invoke(app, ["memory", "list"])
        assert "name" in listing.stdout and "variable" in listing.stdout and "hello.imy" in listing.stdout

    def test_arguments_after_two_dashes_go_to_the_program(self, isolated: Path, llm: FakeLLM, capfd: pytest.CaptureFixture[str]) -> None:
        llm.queue(reply(HELLO_PY + "import sys\nprint(sys.argv[1:])\n"))
        result = runner.invoke(app, ["run", str(hello(isolated)), "--", "--speed", "2", "-x"])
        assert result.exit_code == 0, result.stderr
        assert "['--speed', '2', '-x']" in capfd.readouterr().out

    def test_run_passes_the_exit_code(self, isolated: Path, llm: FakeLLM) -> None:
        llm.queue(reply(HELLO_PY + "import sys\nsys.exit(7)\n"))
        assert runner.invoke(app, ["run", str(hello(isolated))]).exit_code == 7

    def test_convert_prints_or_writes_and_never_overwrites_the_source(self, isolated: Path, llm: FakeLLM) -> None:
        js = 'const name = "Ava";\nconst letters = name.length;\nconsole.log("Hello, " + name + "!");\nconsole.log("Your name has " + letters + " letters.");\n'
        llm.queue(reply(js, target="javascript"))
        path = hello(isolated)
        printed = runner.invoke(app, ["convert", str(path), "--to", "js"])
        assert printed.exit_code == 0, printed.stderr
        assert printed.stdout == js
        written = runner.invoke(app, ["convert", str(path), "--to", "javascript", "-o", str(isolated / "out" / "hello.js")])
        assert written.exit_code == 0 and (isolated / "out" / "hello.js").read_text() == js
        assert llm.calls == 1
        refused = runner.invoke(app, ["convert", str(path), "--to", "python", "-o", str(path)])
        assert refused.exit_code == 2 and "never overwrites" in refused.stderr

    def test_convert_rejects_comments(self, isolated: Path, llm: FakeLLM) -> None:
        bad = reply("// hello\nconsole.log('Hello, Ava!');\n", target="javascript")
        llm.queue(bad, bad)
        result = runner.invoke(app, ["convert", str(hello(isolated)), "--to", "javascript"])
        assert result.exit_code == 1
        assert "CommentsInOutput" in result.stderr and "compiled output line 1" in result.stderr


class TestMemoryCommands:
    def test_show_delete_clear(self, isolated: Path, llm: FakeLLM) -> None:
        session1 = write(isolated / "session1.imy", (FIXTURES / "session1.imy").read_text(encoding="utf-8"))
        llm.queue(reply('def greet(person):\n    print("Hello, " + person + "!")\ngreet("Ava")\n', symbols=[
            symbol("greet", "function", "prints Hello, <person>!"),
            symbol("XYZ", "variable_pack", "velocity pack"),
        ]))
        assert runner.invoke(app, ["run", str(session1)]).exit_code == 0
        shown = runner.invoke(app, ["memory", "show", "xyz"])
        assert shown.exit_code == 0
        assert "members   VelocityX, velocityY, velocityZ" in shown.stdout
        assert runner.invoke(app, ["memory", "show", "nothing"]).exit_code == 1
        deleted = runner.invoke(app, ["memory", "delete", "greet", "--yes"])
        assert "deleted 1 symbol(s)" in deleted.stderr
        assert "greet" not in runner.invoke(app, ["memory", "list"]).stdout
        assert runner.invoke(app, ["memory", "clear"]).exit_code == 2
        cleared = runner.invoke(app, ["memory", "clear", "--yes", "--cache"])
        assert "cleared 1 symbol(s)" in cleared.stderr and "cached compile" in cleared.stderr
        assert "Memory is empty" in runner.invoke(app, ["memory", "list"]).stdout


@pytest.mark.skipif(shutil.which("git") is None, reason="needs git")
def test_inject_command(isolated: Path, llm: FakeLLM, capfd: pytest.CaptureFixture[str]) -> None:
    repo = isolated / "repo"
    repo.mkdir()
    (repo / "main.py").write_text('def report(a, b):\n    return a + b\n\n\nprint(report(2, 3))\n', encoding="utf-8")
    git = ["git", "-c", "user.name=IMY Test", "-c", "user.email=imy@example.invalid"]
    subprocess.run([*git, "init", "-q", str(repo)], check=True)
    subprocess.run([*git, "-C", str(repo), "add", "."], check=True)
    subprocess.run([*git, "-C", str(repo), "commit", "-q", "-m", "init"], check=True)
    imy_file = write(isolated / "sum.imy", '# ("prints the two numbers inside report before adding them")\nshow ("Adding: " + a + " and " + b)\n')
    llm.queue(reply('print("Adding: " + str(a) + " and " + str(b))\n'))
    result = runner.invoke(app, ["inject", str(repo), "--target", "main.py", "--imy", str(imy_file), "--anchor", "def report(a, b):", "--run", "python main.py"])
    assert result.exit_code == 0, result.stderr
    assert "injected 1 line(s) of python into main.py" in result.stderr
    assert capfd.readouterr().out == "Adding: 2 and 3\n5\n"


class TestFreeModels:
    def test_inside_automa_the_free_models_are_the_default_until_imy_init(self, isolated: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        from imy.config import load_config

        monkeypatch.setenv("IMY_AUTOMA_BRIDGE", "node /path/to/free-complete.mjs")
        assert load_config(isolated).provider == "automa"
        result = runner.invoke(app, ["init", "--yes", "--provider", "openai", "--no-workspace"])
        assert result.exit_code == 0, result.stderr
        assert load_config(isolated).provider == "openai"

    def test_free_model_option(self) -> None:
        from imy.cli import choose_model
        from imy.errors import ConfigError

        assert choose_model(None, None, "free/one") == ("automa", "free/one")
        assert choose_model("automa", None, "free/one") == ("automa", "free/one")
        assert choose_model("openai", "gpt-x", None) == ("openai", "gpt-x")
        with pytest.raises(ConfigError):
            choose_model("openai", None, "free/one")
        with pytest.raises(ConfigError):
            choose_model(None, "other", "free/one")

    def test_free_model_flag_reaches_the_session(self, isolated: Path, llm: FakeLLM, monkeypatch: pytest.MonkeyPatch) -> None:
        seen: list[tuple[str, str]] = []

        def client(config, env):  # type: ignore[no-untyped-def]
            seen.append((config.provider, config.resolved_model()))
            return llm

        monkeypatch.setattr("imy.cli.make_client", client)
        llm.queue(reply(HELLO_PY))
        result = runner.invoke(app, ["check", str(hello(isolated)), "--free-model", "nvidia/nemotron-3.5-lightning:free"])
        assert result.exit_code == 0, result.stderr
        assert seen == [("automa", "nvidia/nemotron-3.5-lightning:free")]
        refused = runner.invoke(app, ["check", str(hello(isolated)), "--free-model", "x", "--provider", "gemini"])
        assert refused.exit_code == 2 and "can't be combined" in refused.stderr


class TestDoctorAndModels:
    def test_doctor_reports_missing_key(self, isolated: Path) -> None:
        result = runner.invoke(app, ["doctor"])
        assert result.exit_code == 0
        assert "Anthropic (Claude)" in result.stdout and "missing" in result.stdout

    def test_doctor_ping(self, isolated: Path, llm: FakeLLM) -> None:
        llm.queue("OK")
        result = runner.invoke(app, ["doctor", "--ping"])
        assert result.exit_code == 0, result.stderr
        assert "fake answered" in result.stdout

    def test_models_marks_the_one_in_use(self) -> None:
        result = runner.invoke(app, ["models", "--provider", "anthropic"])
        assert "● claude-opus-5-5" in result.stdout


class TestWatch:
    def saves(self, monkeypatch: pytest.MonkeyPatch, actions: list) -> list[float]:
        """Stand in for the wait between looks at the file: each look runs the next action (a save, or Ctrl+C)."""
        waits: list[float] = []
        pending = list(actions)

        def fake_sleep(seconds: float) -> None:
            waits.append(seconds)
            if pending:
                action = pending.pop(0)
                if action is not None:
                    action()
            else:
                raise KeyboardInterrupt

        monkeypatch.setattr("imy.cli._watch_sleep", fake_sleep)
        return waits

    def test_runs_again_after_each_save_and_stops_on_ctrl_c(self, isolated: Path, llm: FakeLLM, monkeypatch: pytest.MonkeyPatch, capfd: pytest.CaptureFixture[str]) -> None:
        path = write(isolated / "greet.imy", '# ("greets one person by name on the screen")\nshow ("Hi, Bo!")\n')
        llm.queue(reply('print("Hi, Bo!")\n'), reply('print("Hi, Cy!")\n'))

        def save_cy() -> None:
            path.write_text('# ("greets one person by name on the screen")\nshow ("Hi, Cy!")\n', encoding="utf-8")
            os.utime(path, ns=(2_000_000_000_000_000_000, 2_000_000_000_000_000_000))

        # Two looks see nothing new, the third sees the save, the fourth confirms it has settled.
        self.saves(monkeypatch, [None, None, save_cy, None])
        result = runner.invoke(app, ["run", str(path), "--watch"])
        assert result.exit_code == 0, result.stderr
        stderr = " ".join(result.stderr.split())
        assert stderr.count("watching greet.imy: save it to run again, Ctrl+C to stop") == 2
        assert "── greet.imy changed ──" in stderr and "stopped watching" in stderr
        assert capfd.readouterr().out == "Hi, Bo!\nHi, Cy!\n"
        assert llm.calls == 2

    def test_a_broken_rule_is_shown_and_the_next_save_runs(self, isolated: Path, llm: FakeLLM, monkeypatch: pytest.MonkeyPatch, capfd: pytest.CaptureFixture[str]) -> None:
        path = write(isolated / "greet.imy", '# ("greets one person by name on the screen")\nplease make me a greeting app\n')
        llm.queue(reply('print("Hi, Bo!")\n'))

        def fix() -> None:
            path.write_text('# ("greets one person by name on the screen")\nshow ("Hi, Bo!")\n', encoding="utf-8")
            os.utime(path, ns=(2_000_000_000_000_000_000, 2_000_000_000_000_000_000))

        self.saves(monkeypatch, [fix, None])
        result = runner.invoke(app, ["run", str(path), "--watch"])
        assert result.exit_code == 0
        assert "PromptingDetected" in result.stderr
        assert capfd.readouterr().out == "Hi, Bo!\n"
        assert llm.calls == 1

    def test_a_half_written_save_is_waited_out_and_a_deleted_file_is_waited_for(self, isolated: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        from imy.cli import _file_signature, wait_for_change

        path = write(isolated / "greet.imy", "one\n")
        first = _file_signature(path)

        def stamp(text: str, when: int) -> None:
            path.write_text(text, encoding="utf-8")
            os.utime(path, ns=(when, when))

        steps = [
            path.unlink,                                        # deleted: keep waiting
            None,
            lambda: stamp("", 3_000_000_000_000_000_000),      # the editor empties the file...
            lambda: stamp("two\n", 3_000_000_000_500_000_000),  # ...and writes it while we look again: not settled
            None,                                                # the next look sees the finished save
            None,                                                # and the look after it agrees
        ]
        waits = self.saves(monkeypatch, steps)
        settled = wait_for_change(path, first)
        assert settled == _file_signature(path) and path.read_text() == "two\n"
        assert len(waits) == 6

    def test_watch_cannot_be_combined_with_background_or_serving(self, isolated: Path, llm: FakeLLM) -> None:
        path = hello(isolated)
        for flag in ("--detach", "--serve"):
            result = runner.invoke(app, ["run", str(path), "--watch", flag])
            assert result.exit_code == 2 and "--watch" in result.stderr
        assert llm.calls == 0


class TestConsole:
    def make(self, isolated: Path, llm: FakeLLM, lines: list[str]) -> tuple[ImyConsole, Console]:
        console = Console(record=True, width=120, force_terminal=False, file=io.StringIO())
        feed = iter(lines)

        def read(prompt: str) -> str:
            try:
                return next(feed)
            except StopIteration:
                raise EOFError from None

        session = open_session(isolated / "console.imy")
        repl = ImyConsole(lambda p, m: session, target="python", console=console, input_fn=read)
        return repl, console

    def test_type_check_run_and_edit(self, isolated: Path, llm: FakeLLM, capfd: pytest.CaptureFixture[str]) -> None:
        llm.queue(reply('print("Hi, Bo!")\n'))
        repl, console = self.make(isolated, llm, [
            '# ("greets one person by name on the screen")',
            'show ("Hi, Bo!")',
            ":check",
            ":run",
            ":show",
            ":edit 2 show (\"Hi, Cy!\")",
            ":undo",
            ":save greet.imy",
            ":quit",
        ])
        assert repl.loop() == 0
        text = console.export_text()
        assert "✓ VALID console → python" in text
        assert "exit code 0" in text
        assert '  2 | show ("Hi, Bo!")' in text
        assert capfd.readouterr().out.count("Hi, Bo!") == 1
        assert (isolated / "greet.imy").read_text() == '# ("greets one person by name on the screen")\n'
        assert llm.calls == 1

    def test_ctrl_c_stops_the_compile_not_the_console(self, isolated: Path, llm: FakeLLM, capfd: pytest.CaptureFixture[str]) -> None:
        def interrupted(request: object) -> str:
            raise KeyboardInterrupt

        llm.queue(interrupted, reply('print("Hi, Bo!")\n'))
        repl, console = self.make(isolated, llm, ['# ("greets one person by name on the screen")', 'show ("Hi, Bo!")', ":run", ":run", ":quit"])
        assert repl.loop() == 0
        text = console.export_text()
        assert "Stopped." in text and "exit code 0" in text
        assert capfd.readouterr().out.count("Hi, Bo!") == 1

    def test_the_banner_says_how_to_start(self, isolated: Path, llm: FakeLLM) -> None:
        repl, console = self.make(isolated, llm, [])
        repl.loop()
        text = console.export_text()
        assert f"IMY console {__version__}" in text
        assert '# ("what it builds and how it works")' in text
        assert ":header" in text and ":example hello" in text and ":run" in text and ":help" in text
        assert "It becomes python." in text and ":target rust" in text and ":languages" in text

    def test_the_banner_names_the_language_it_was_opened_in(self, isolated: Path, llm: FakeLLM) -> None:
        console = Console(record=True, width=160, force_terminal=False, file=io.StringIO())
        feed = iter([":target", ":quit"])
        session = open_session(isolated / "console.imy")
        repl = ImyConsole(lambda p, m: session, target="rust", console=console, input_fn=lambda prompt: next(feed))
        assert repl.loop() == 0
        text = console.export_text()
        assert "target rust" in text and "It becomes rust." in text
        # The hint never offers the language already chosen.
        assert ":target python" in text and ":target rust" not in text
        assert "Target: rust" in text

    def test_header_command_writes_the_header_line(self, isolated: Path, llm: FakeLLM) -> None:
        repl, console = self.make(isolated, llm, [
            'show ("Hi, Bo!")',
            ":header greets one person by name on the screen",
            ":header   prints a greeting   that says \"hi\" to Bo  ",
            ":header too short",
            ":header",
            ':header # ("counts the letters of one name")',
        ])
        repl.loop()
        text = console.export_text()
        assert "header set:" in text and "header replaced:" in text
        assert "at least 3 words" in text
        assert "Usage: :header" in text
        assert repl.lines == ['# ("counts the letters of one name")', 'show ("Hi, Bo!")']

    def test_header_with_quotes_is_escaped_and_read_back_whole(self, isolated: Path, llm: FakeLLM) -> None:
        from imy.parser import parse_header

        repl, _ = self.make(isolated, llm, [':header prints a greeting that says "hi" to Bo'])
        repl.loop()
        assert repl.lines == ['# ("prints a greeting that says \\"hi\\" to Bo")']
        assert parse_header(repl.lines[0]) == ('prints a greeting that says "hi" to Bo', None)

    def test_edit_and_insert_take_code_as_typed(self, isolated: Path, llm: FakeLLM) -> None:
        repl, console = self.make(isolated, llm, [
            '# ("prints two lines inside a block for one person")',
            "block start",
            "block end",
            ":insert 3   show (\"it's ready\")",
            ":edit 2 when (ready) do: show ('go')",
            ":insert 4     show (\"don't stop\")",
            ":edit 9 nothing",
            ":save \"my file.imy\"",
            ":save 'unclosed",
        ])
        repl.loop()
        assert repl.lines == [
            '# ("prints two lines inside a block for one person")',
            "when (ready) do: show ('go')",
            "  show (\"it's ready\")",
            "    show (\"don't stop\")",
            "block end",
        ]
        text = console.export_text()
        assert "Line 9 doesn't exist" in text
        assert (isolated / "my file.imy").exists()
        assert "No closing quotation" in text and "in quotes" in text

    def test_a_compile_says_which_model_and_reuses_the_cache(self, isolated: Path, llm: FakeLLM, capfd: pytest.CaptureFixture[str]) -> None:
        llm.queue(reply('print("Hi, Bo!")\n'))
        repl, console = self.make(isolated, llm, ['# ("greets one person by name on the screen")', 'show ("Hi, Bo!")', ":run", ":run"])
        repl.loop()
        text = console.export_text()
        assert "compiled to python (fake-model)" in text
        assert "compiled to python (cached)" in text
        assert llm.calls == 1

    def test_console_reports_rule_errors_without_calling_the_model(self, isolated: Path, llm: FakeLLM) -> None:
        repl, console = self.make(isolated, llm, ['# ("greets one person by name on the screen")', "please make me a greeting app", ":run"])
        repl.loop()
        assert "PromptingDetected" in console.export_text()
        assert llm.calls == 0
