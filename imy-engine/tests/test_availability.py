from __future__ import annotations

import json
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from imy.availability import (
    BUSY,
    DAILY_LIMIT,
    ERROR,
    NETWORK,
    NO_KEY,
    NOT_SERVED,
    OK,
    TIMEOUT,
    ModelCheck,
    check_models,
    load_record,
    note_result,
    record_path,
    remembered,
    state_of,
    status_words,
    summary,
)
from imy.errors import (
    ConfigError,
    LLMAuthError,
    LLMConnectionError,
    LLMProviderError,
    LLMRateLimitError,
    LLMRefusalError,
    LLMTimeoutError,
)

NOW = datetime(2026, 11, 22, 12, 0, 0, tzinfo=UTC)


def refused(kind: str) -> LLMProviderError:
    error = LLMProviderError(f"free model said {kind}")
    error.kind = kind
    return error


class TestFindings:
    @pytest.mark.parametrize(
        "kind, state",
        [("withdrawn", NOT_SERVED), ("restricted", NOT_SERVED), ("charged", NOT_SERVED), ("busy", BUSY),
         ("daily_limit", DAILY_LIMIT), ("timeout", TIMEOUT), ("network", NETWORK)],
    )
    def test_the_providers_own_word_decides(self, kind: str, state: str) -> None:
        assert state_of(refused(kind)) == state

    def test_other_providers_are_read_from_the_error_itself(self) -> None:
        assert state_of(LLMTimeoutError("no answer in 45 seconds")) == TIMEOUT
        assert state_of(LLMConnectionError("could not reach the server")) == NETWORK
        assert state_of(LLMRateLimitError("slow down")) == BUSY
        assert state_of(LLMAuthError("the key was refused")) == NO_KEY
        assert state_of(LLMProviderError("404: model gpt-9 does not exist")) == NOT_SERVED
        assert state_of(LLMProviderError("Model not found: x/y:free")) == NOT_SERVED
        assert state_of(LLMRefusalError("declined")) == ERROR
        assert state_of(LLMProviderError("500 internal error")) == ERROR


class TestRecord:
    def test_findings_are_kept_and_shown_while_fresh(self, tmp_path: Path) -> None:
        home = tmp_path / "home"
        note_result(home, "automa", "free/one", OK, seconds=1.84, now=NOW - timedelta(minutes=12))
        note_result(home, "automa", "free/gone", NOT_SERVED, now=NOW - timedelta(hours=3))
        note_result(home, "automa", "free/old", OK, now=NOW - timedelta(hours=30))
        note_result(home, "openai", "gpt-x", OK, now=NOW)

        stored = json.loads(record_path(home).read_text())
        assert stored["automa"]["free/one"] == {"state": "ok", "checked_at": "2026-11-22T11:48:00+00:00", "seconds": 1.8}
        assert remembered(home, "automa", now=NOW) == {"free/one": (OK, "12 min ago"), "free/gone": (NOT_SERVED, "3 h ago")}
        assert remembered(home, "openai", now=NOW) == {"gpt-x": (OK, "just now")}
        assert status_words(home, "automa", "free/one", now=NOW) == "answers (12 min ago)"
        assert status_words(home, "automa", "free/gone", now=NOW) == "not served now (3 h ago)"
        assert status_words(home, "automa", "free/old", now=NOW) == ""
        assert status_words(home, "automa", "never-asked", now=NOW) == ""

    def test_a_newer_finding_replaces_the_older_one(self, tmp_path: Path) -> None:
        note_result(tmp_path, "automa", "free/one", NOT_SERVED, now=NOW - timedelta(hours=2))
        note_result(tmp_path, "automa", "free/one", OK, seconds=2, now=NOW)
        assert remembered(tmp_path, "automa", now=NOW) == {"free/one": (OK, "just now")}

    def test_a_broken_or_missing_record_is_an_empty_one(self, tmp_path: Path) -> None:
        assert load_record(tmp_path / "nowhere") == {}
        record_path(tmp_path).write_text("{not json", encoding="utf-8")
        assert load_record(tmp_path) == {}
        record_path(tmp_path).write_text(json.dumps({"automa": {"x": "ok", "y": {"state": "ok"}, "z": {"state": "ok", "checked_at": "never"}}}), encoding="utf-8")
        assert remembered(tmp_path, "automa", now=NOW) == {}
        # Writing over it works again.
        note_result(tmp_path, "automa", "free/one", OK, now=NOW)
        assert remembered(tmp_path, "automa", now=NOW) == {"free/one": (OK, "just now")}

    def test_a_record_that_cannot_be_written_is_let_go(self, tmp_path: Path) -> None:
        blocker = tmp_path / "file-not-folder"
        blocker.write_text("x", encoding="utf-8")
        note_result(blocker / "home", "automa", "free/one", OK, now=NOW)
        assert not (blocker / "home").exists()


class TestCheck:
    ROWS = [("free/one", "Free One"), ("free/gone", "Free Gone"), ("free/busy", "Free Busy"), ("free/two", "Free Two")]

    def test_every_model_is_asked_and_findings_keep_the_lists_order(self) -> None:
        asked: list[str] = []
        lock = threading.Lock()

        def ask(model: str) -> float:
            with lock:
                asked.append(model)
            if model == "free/gone":
                raise refused("withdrawn")
            if model == "free/busy":
                raise refused("busy")
            return 0.7 if model == "free/two" else 1.8

        heard: list[str] = []
        findings = check_models(self.ROWS, ask, on_result=lambda finding: heard.append(finding.model))
        assert sorted(asked) == sorted(model for model, _ in self.ROWS)
        assert sorted(heard) == sorted(asked)
        assert [(finding.model, finding.state) for finding in findings] == [
            ("free/one", OK), ("free/gone", NOT_SERVED), ("free/busy", BUSY), ("free/two", OK),
        ]
        assert findings[1].detail == "free model said withdrawn" and findings[1].words == "not served now"
        assert summary(findings) == "2 of 4 answer now. Fastest: free/two (0.7 s). The busy ones may answer in a minute."

    def test_a_missing_bridge_or_key_ends_the_check(self) -> None:
        def ask(model: str) -> float:
            raise ConfigError("Automa's free models need the bridge that Automa's IMY terminal provides.")

        with pytest.raises(ConfigError):
            check_models(self.ROWS, ask)

    def test_nothing_to_check(self) -> None:
        assert check_models([], lambda model: 0.0) == []
        assert summary([]) == "No models to check."
        assert summary([ModelCheck("a", "A", NETWORK)]) == "0 of 1 answer now. Some could not be reached: check the connection and ask again."
