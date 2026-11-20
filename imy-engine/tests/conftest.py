from __future__ import annotations

import json
import os
import shutil
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

import pytest

from imy.compiler import Compiler
from imy.config import ImyConfig
from imy.llm_client import LLMReply, LLMRequest
from imy.memory import Memory
from imy.workspace import Workspace

FIXTURES = Path(__file__).parent / "fixtures"

_PROVIDER_VARIABLES = (
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "IMY_API_KEY",
    "IMY_PROVIDER",
    "IMY_MODEL",
    "IMY_BASE_URL",
    "IMY_AUTOMA_BRIDGE",
    "IMY_TARGET",
    "IMY_API_KEY_ENV",
    "IMY_MAX_TOKENS",
    "IMY_TIMEOUT",
    "IMY_EFFORT",
    "IMY_REPAIR_ATTEMPTS",
    "IMY_PYTHON",
)


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption("--live", action="store_true", default=False, help="also run tests that call a real AI provider")


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if config.getoption("--live"):
        return
    skip = pytest.mark.skip(reason="calls a real AI provider; run with --live")
    for item in items:
        if "live" in item.keywords:
            item.add_marker(skip)


@pytest.fixture(autouse=True)
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest) -> Path:
    """Every test gets its own IMY_HOME and working folder, and no provider keys."""
    if "live" in request.keywords:
        return tmp_path
    home = tmp_path / "imy-home"
    monkeypatch.setenv("IMY_HOME", str(home))
    for name in _PROVIDER_VARIABLES:
        monkeypatch.delenv(name, raising=False)
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.chdir(work)
    return work


@pytest.fixture
def fixtures_dir(isolated: Path) -> Path:
    """A writable copy of tests/fixtures inside the test's folder."""
    target = isolated / "fixtures"
    shutil.copytree(FIXTURES, target)
    return target


def reply(
    code: str = 'print("hi")\n',
    *,
    symbols: Iterable[dict[str, str]] = (),
    status: str = "ok",
    errors: Iterable[dict[str, Any]] = (),
    target: str = "python",
) -> str:
    return json.dumps(
        {
            "status": status,
            "errors": list(errors),
            "extracted_symbols": list(symbols),
            "target_language": target,
            "compiled_code": code if status == "ok" else "",
        }
    )


def symbol(name: str, kind: str, meaning: str, fragment: str = "") -> dict[str, str]:
    return {"name": name, "kind": kind, "meaning": meaning, "source_fragment": fragment}


class FakeLLM:
    """A scripted model: returns the queued replies in order and records every request."""

    provider = "fake"
    model = "fake-model"

    def __init__(self, replies: Iterable[str | Callable[[LLMRequest], str]] = ()) -> None:
        self.replies = list(replies)
        self.requests: list[LLMRequest] = []

    def queue(self, *replies: str | Callable[[LLMRequest], str]) -> None:
        self.replies.extend(replies)

    def complete(self, request: LLMRequest) -> LLMReply:
        self.requests.append(request)
        if not self.replies:
            raise AssertionError("FakeLLM was called more times than expected")
        item = self.replies.pop(0)
        text = item(request) if callable(item) else item
        return LLMReply(text=text, provider=self.provider, model=self.model, input_tokens=10, output_tokens=20)

    @property
    def calls(self) -> int:
        return len(self.requests)

    def last_prompt(self) -> str:
        return self.requests[-1].messages[0].content


@pytest.fixture
def fake_llm() -> FakeLLM:
    return FakeLLM()


def make_compiler(root: Path, llm: FakeLLM, **config: Any) -> Compiler:
    workspace = Workspace(root)
    workspace.ensure()
    home = Path(os.environ["IMY_HOME"])
    memory = Memory.open(home, workspace.dot)
    settings = {"provider": "anthropic", "model": "claude-opus-5-5", **config}
    return Compiler(config=ImyConfig(**settings), workspace=workspace, memory=memory, client_factory=lambda: llm)


@pytest.fixture
def compiler_for(fake_llm: FakeLLM) -> Callable[..., Compiler]:
    def build(root: Path, **config: Any) -> Compiler:
        return make_compiler(root, fake_llm, **config)

    return build


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path
