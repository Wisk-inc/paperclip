"""Which models answer right now, and how fast.

Free models come and go: a provider takes a free version offline for a day or
a month, and the model then answers "not found". IMY never swaps in another
model, so the person has to pick one that answers. `imy models --check` asks
every listed model for one word and says which did; what it found, and what
each compile finds, is kept in IMY's home so `imy models` can show it later.
"""

from __future__ import annotations

import contextlib
import json
import os
import tempfile
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .errors import (
    ConfigError,
    ImyError,
    LLMAuthError,
    LLMConnectionError,
    LLMError,
    LLMRateLimitError,
    LLMTimeoutError,
)

RECORD_NAME = "model-checks.json"
# A finding older than this says little about today.
FRESH_SECONDS = 24 * 3600

OK = "ok"
NOT_SERVED = "not_served"
BUSY = "busy"
DAILY_LIMIT = "daily_limit"
TIMEOUT = "timeout"
NETWORK = "network"
NO_KEY = "no_key"
ERROR = "error"

# What each finding is called on screen.
WORDS: dict[str, str] = {
    OK: "answers",
    NOT_SERVED: "not served now",
    BUSY: "busy",
    DAILY_LIMIT: "daily limit used up",
    TIMEOUT: "too slow to answer",
    NETWORK: "no connection",
    NO_KEY: "key refused",
    ERROR: "failed",
}

# Bridge error kinds (see Automa's free-complete.mjs) as findings.
KIND_STATES: dict[str, str] = {
    "withdrawn": NOT_SERVED,
    "restricted": NOT_SERVED,
    "charged": NOT_SERVED,
    "no_tools": NOT_SERVED,
    "busy": BUSY,
    "rate_limit": BUSY,
    "daily_limit": DAILY_LIMIT,
    "timeout": TIMEOUT,
    "network": NETWORK,
}


@dataclass(frozen=True)
class ModelCheck:
    model: str
    label: str
    state: str
    seconds: float = 0.0
    detail: str = ""

    @property
    def answered(self) -> bool:
        return self.state == OK

    @property
    def words(self) -> str:
        return WORDS.get(self.state, self.state)


def state_of(error: BaseException) -> str:
    """The finding an error stands for."""
    kind = getattr(error, "kind", None)
    if isinstance(kind, str) and kind in KIND_STATES:
        return KIND_STATES[kind]
    if isinstance(error, LLMTimeoutError):
        return TIMEOUT
    if isinstance(error, LLMConnectionError):
        return NETWORK
    if isinstance(error, LLMRateLimitError):
        return BUSY
    if isinstance(error, LLMAuthError):
        return NO_KEY
    message = str(getattr(error, "message", error)).casefold()
    if "not found" in message or "does not exist" in message or "no such model" in message or "unknown model" in message:
        return NOT_SERVED
    return ERROR


# ── What was found, kept between runs ────────────────────────────────────


def record_path(home: Path) -> Path:
    return home / RECORD_NAME


def load_record(home: Path) -> dict[str, dict[str, dict[str, Any]]]:
    """{provider: {model: {"state", "checked_at", "seconds"}}}; empty when there is none or it can't be read."""
    try:
        data = json.loads(record_path(home).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    clean: dict[str, dict[str, dict[str, Any]]] = {}
    for provider, models in data.items():
        if not isinstance(provider, str) or not isinstance(models, dict):
            continue
        kept = {
            model: entry
            for model, entry in models.items()
            if isinstance(model, str) and isinstance(entry, dict) and isinstance(entry.get("state"), str) and isinstance(entry.get("checked_at"), str)
        }
        if kept:
            clean[provider] = kept
    return clean


def note_result(home: Path, provider: str, model: str, state: str, *, seconds: float = 0.0, now: datetime | None = None) -> None:
    """Remember what one call found. Never raises: a record that can't be written is not worth a failed compile."""
    stamp = (now or datetime.now(UTC)).isoformat(timespec="seconds")
    try:
        record = load_record(home)
        record.setdefault(provider, {})[model] = {"state": state, "checked_at": stamp, "seconds": round(max(0.0, seconds), 1)}
        home.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".model-checks.", suffix=".json", dir=home)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(record, handle, indent=2, sort_keys=True)
                handle.write("\n")
            os.replace(tmp, record_path(home))
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise
    except (OSError, ValueError):
        return


def _age(checked_at: str, now: datetime) -> float | None:
    try:
        then = datetime.fromisoformat(checked_at)
    except ValueError:
        return None
    if then.tzinfo is None:
        then = then.replace(tzinfo=UTC)
    return (now - then).total_seconds()


def age_words(seconds: float) -> str:
    if seconds < 90:
        return "just now"
    if seconds < 90 * 60:
        return f"{int(round(seconds / 60))} min ago"
    return f"{int(round(seconds / 3600))} h ago"


def remembered(home: Path, provider: str, *, now: datetime | None = None) -> dict[str, tuple[str, str]]:
    """{model: (state, "12 min ago")} for findings still fresh enough to show."""
    current = now or datetime.now(UTC)
    found: dict[str, tuple[str, str]] = {}
    for model, entry in load_record(home).get(provider, {}).items():
        age = _age(entry["checked_at"], current)
        if age is None or age < -300 or age > FRESH_SECONDS:
            continue
        found[model] = (entry["state"], age_words(max(0.0, age)))
    return found


def status_words(home: Path, provider: str, model: str, *, now: datetime | None = None) -> str:
    """"answers (12 min ago)" for a model with a fresh finding, else ""."""
    entry = remembered(home, provider, now=now).get(model)
    if entry is None:
        return ""
    state, age = entry
    return f"{WORDS.get(state, state)} ({age})"


# ── Asking every model for one word ──────────────────────────────────────


def check_models(
    rows: Sequence[tuple[str, str]],
    ask: Callable[[str], float],
    *,
    workers: int = 2,
    on_result: Callable[[ModelCheck], None] | None = None,
) -> list[ModelCheck]:
    """Ask each model in ``rows`` ((id, label)) with ``ask``, a few at a time.

    ``ask(model)`` sends one tiny request and returns the seconds it took, or
    raises the error it got. Findings come back in the order of ``rows``;
    ``on_result`` hears each one as it arrives. A missing bridge or key ends
    the whole check: no model can answer without it.
    """
    if not rows:
        return []
    results: dict[str, ModelCheck] = {}

    def one(model: str, label: str) -> ModelCheck:
        try:
            seconds = ask(model)
        except ConfigError:
            raise
        except ImyError as exc:
            detail = exc.message if isinstance(exc, LLMError) else str(exc)
            return ModelCheck(model=model, label=label, state=state_of(exc), detail=" ".join(detail.split())[:200])
        return ModelCheck(model=model, label=label, state=OK, seconds=seconds)

    with ThreadPoolExecutor(max_workers=max(1, min(workers, len(rows))), thread_name_prefix="imy-check") as pool:
        futures = {pool.submit(one, model, label): model for model, label in rows}
        try:
            for future in as_completed(futures):
                finding = future.result()
                results[finding.model] = finding
                if on_result is not None:
                    on_result(finding)
        except BaseException:
            for future in futures:
                future.cancel()
            raise
    return [results[model] for model, _ in rows if model in results]


def summary(findings: Sequence[ModelCheck]) -> str:
    """"13 of 23 answer now. Fastest: X (0.7 s)."""
    answering = [finding for finding in findings if finding.answered]
    if not findings:
        return "No models to check."
    line = f"{len(answering)} of {len(findings)} answer now."
    if answering:
        fastest = min(answering, key=lambda finding: finding.seconds)
        line += f" Fastest: {fastest.model} ({fastest.seconds:.1f} s)."
    if any(finding.state == NETWORK for finding in findings):
        line += " Some could not be reached: check the connection and ask again."
    elif any(finding.state == BUSY for finding in findings):
        line += " The busy ones may answer in a minute."
    return line
