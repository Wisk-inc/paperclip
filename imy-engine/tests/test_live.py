"""Real-provider tests. Run with: pytest --live

They use your real settings (`imy init` or IMY_* / provider key variables),
with a temporary memory store so your saved symbols are left alone.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

from imy.cli import open_session
from imy.compiler import CompileOptions
from imy.config import imy_home
from imy.errors import CompilationFailed
from imy.runner import build_artifact, run_artifact

pytestmark = pytest.mark.live

EXAMPLES = Path(__file__).resolve().parent.parent / "src" / "imy" / "examples"


@pytest.fixture
def live_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    real = imy_home() / "config.json"
    home = tmp_path / "imy-home"
    home.mkdir()
    if real.exists():
        shutil.copy2(real, home / "config.json")
    monkeypatch.setenv("IMY_HOME", str(home))
    monkeypatch.chdir(tmp_path)
    return home


def copy_example(name: str, folder: Path) -> Path:
    target = folder / name
    shutil.copy2(EXAMPLES / name, target)
    return target


def test_hello_compiles_and_runs(live_home: Path, tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
    path = copy_example("hello.imy", tmp_path)
    session = open_session(path)
    result = session.compiler.compile_file(path, CompileOptions(target="python", use_cache=False))
    outcome = run_artifact(build_artifact(result, session.workspace), session.workspace)
    output = capfd.readouterr().out
    assert outcome.exit_code == 0, output
    assert "Hello, Ava!" in output
    assert "Your name has 3 letters." in output


def test_physics_example_runs_to_the_landing(live_home: Path, tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
    path = copy_example("jump.imy", tmp_path)
    session = open_session(path)
    result = session.compiler.compile_file(path, CompileOptions(target="python", use_cache=False))
    outcome = run_artifact(build_artifact(result, session.workspace), session.workspace, timeout=60)
    output = capfd.readouterr().out
    assert outcome.exit_code == 0, output
    assert "landed after" in output


def test_strict_website(live_home: Path, tmp_path: Path) -> None:
    path = copy_example("website.imy", tmp_path)
    session = open_session(path)
    try:
        result = session.compiler.compile_file(path, CompileOptions(target="html", use_cache=False, save_memory=False))
    except CompilationFailed as exc:
        pytest.fail("\n".join(d.headline() for d in exc.diagnostics))
    assert "<style" not in result.code.lower()
    assert "menu logo.png" in result.code or "menu%20logo.png" in result.code


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
def test_convert_to_javascript_runs_with_node(live_home: Path, tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
    path = copy_example("hello.imy", tmp_path)
    session = open_session(path)
    result = session.compiler.compile_file(path, CompileOptions(target="javascript", use_cache=False, save_memory=False))
    outcome = run_artifact(build_artifact(result, session.workspace), session.workspace)
    assert outcome.exit_code == 0
    assert "Hello, Ava!" in capfd.readouterr().out


def test_live_settings_are_present() -> None:
    assert os.environ.get("IMY_HOME") is None or Path(os.environ["IMY_HOME"]).exists()
