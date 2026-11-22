from __future__ import annotations

import io
import sys
from pathlib import Path

import pytest
from rich.console import Console
from typer.testing import CliRunner

from conftest import FIXTURES, write
from imy.cli import app, open_session
from imy.console import ImyConsole

runner = CliRunner()

# A stand-in for Automa's free-models bridge: three models, one of them taken offline by its provider.
BRIDGE = r'''
import json, sys, time
request = json.loads(sys.stdin.read())
if request.get("op") == "models":
    print(json.dumps({"ok": True, "models": [
        {"id": "free/fast", "label": "Fast"}, {"id": "free/gone", "label": "Gone"}, {"id": "free/slow", "label": "Slow"}]}))
    raise SystemExit(0)
model = request["model"]
if model == "free/gone":
    print(json.dumps({"ok": False, "error": {"kind": "withdrawn", "message": "Gone could not answer (400: Model not found: free/gone)."}}))
else:
    if model == "free/slow":
        time.sleep(0.4)
    print(json.dumps({"ok": True, "text": "OK", "model": model}))
'''


def flat(text: str) -> str:
    return " ".join(text.split())


@pytest.fixture
def bridge(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    script = tmp_path / "bridge.py"
    script.write_text(BRIDGE, encoding="utf-8")
    monkeypatch.setenv("IMY_AUTOMA_BRIDGE", f"{sys.executable} {script}")
    monkeypatch.setenv("IMY_MODEL", "free/fast")
    return script


class TestModelsCheck:
    def test_asks_every_model_and_remembers_what_it_found(self, bridge: Path) -> None:
        before = runner.invoke(app, ["models"])
        assert before.exit_code == 0
        assert "✓" not in before.stdout and "✗" not in before.stdout and "imy models --check" in before.stdout

        checked = runner.invoke(app, ["models", "--check"])
        assert checked.exit_code == 0, checked.stderr
        lines = [flat(line) for line in checked.stdout.splitlines()]
        assert any(line.startswith("✓") and line.endswith("free/fast") for line in lines)
        assert any(line.startswith("✓") and line.endswith("free/slow") for line in lines)
        assert "✗ not served now free/gone" in lines
        assert "2 of 3 answer now. Fastest: free/fast" in flat(checked.stdout)
        assert "--free-model <id>" in checked.stdout

        after = [flat(line) for line in runner.invoke(app, ["models"]).stdout.splitlines()]
        assert "● free/fast Fast ✓ answers (just now)" in after
        assert "free/gone Gone ✗ not served now (just now)" in after
        assert "free/slow Slow ✓ answers (just now)" in after

    def test_without_the_bridge_it_says_so_once(self) -> None:
        result = runner.invoke(app, ["models", "--provider", "automa", "--check"])
        assert result.exit_code == 2
        assert flat(result.stderr).count("free models need the bridge") == 1

    def test_a_compile_on_a_model_that_is_gone_is_remembered_too(self, bridge: Path, isolated: Path) -> None:
        source = write(isolated / "hello.imy", (FIXTURES / "valid_hello.imy").read_text(encoding="utf-8"))
        failed = runner.invoke(app, ["check", str(source), "--free-model", "free/gone"])
        assert failed.exit_code == 3
        message = flat(failed.stderr)
        assert "Gone could not answer" in message and "imy models --check" in message
        listing = [flat(line) for line in runner.invoke(app, ["models"]).stdout.splitlines()]
        assert "free/gone Gone ✗ not served now (just now)" in listing

    def test_the_console_checks_and_lists(self, bridge: Path, isolated: Path) -> None:
        console = Console(record=True, width=120, force_terminal=False, file=io.StringIO())
        feed = iter([":models check", ":models", ":models nonsense"])

        def read(prompt: str) -> str:
            try:
                return next(feed)
            except StopIteration:
                raise EOFError from None

        session = open_session(isolated / "console.imy")
        ImyConsole(lambda p, m: session, target="python", console=console, input_fn=read).loop()
        text = flat(console.export_text())
        assert "✗ not served now free/gone" in text
        assert "2 of 3 answer now." in text
        assert "free/gone Gone ✗ not served now (just now)" in text
        assert "Usage: :models [check]" in text
        # The findings and the list, without a line on what to do with them.
        assert ":model <id>" not in text and "asks each one" not in text
