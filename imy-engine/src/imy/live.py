"""Live conversion: the console converts the program while it is being typed.

Each time a line is entered the buffer is handed to a background worker, which
asks the model for a preview conversion (CompileOptions.preview) and reports it
back. Only one request runs at a time; lines entered meanwhile replace each
other, so the worker always goes on to the newest buffer. A result is reported
even when more lines were typed since: it is still the conversion of the lines
it covers, and the next one follows.

The preview never saves to memory and never stands in for the strict compile
that :run does.
"""

from __future__ import annotations

import difflib
import threading
from collections.abc import Callable
from dataclasses import dataclass, field

from .compiler import CompileResult
from .errors import CompilationFailed, ImyError


@dataclass(frozen=True)
class LiveJob:
    number: int
    lines: tuple[str, ...]
    target: str
    # Which buffer this belongs to: clearing, loading or running the buffer starts a new one.
    generation: int = 0

    @property
    def source(self) -> str:
        return "\n".join(self.lines) + "\n"


@dataclass
class LiveOutcome:
    """What one preview found: the conversion, the rule errors, or why the model could not be asked."""

    job: LiveJob
    result: CompileResult | None = None
    failure: CompilationFailed | None = None
    error: ImyError | None = None
    # True when lines were entered after this job was taken.
    stale: bool = False


def changed_lines(previous: list[str], current: list[str]) -> list[tuple[int, str]]:
    """The lines of ``current`` that are new or different from ``previous``, with their 1-based numbers."""
    if not previous:
        return list(enumerate(current, start=1))
    matcher = difflib.SequenceMatcher(a=previous, b=current, autojunk=False)
    changed: list[tuple[int, str]] = []
    for tag, _i1, _i2, j1, j2 in matcher.get_opcodes():
        if tag in ("replace", "insert"):
            changed.extend((index + 1, current[index]) for index in range(j1, j2))
    return changed


@dataclass
class LivePreview:
    """Runs preview conversions one at a time on a worker thread; the newest buffer wins."""

    convert: Callable[[LiveJob], CompileResult]
    deliver: Callable[[LiveOutcome], None]
    _pending: LiveJob | None = field(default=None, init=False)
    _latest: int = field(default=0, init=False)
    _generation: int = field(default=0, init=False)
    _busy: bool = field(default=False, init=False)
    _closed: bool = field(default=False, init=False)
    _thread: threading.Thread | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        self._wake = threading.Condition()

    def submit(self, lines: list[str], target: str) -> None:
        """Ask for a preview of ``lines``; replaces any buffer still waiting its turn."""
        with self._wake:
            if self._closed:
                return
            self._latest += 1
            self._pending = LiveJob(number=self._latest, lines=tuple(lines), target=target, generation=self._generation)
            if self._thread is None:
                self._thread = threading.Thread(target=self._work, name="imy-live", daemon=True)
                self._thread.start()
            self._wake.notify_all()

    def forget(self) -> None:
        """Drop the buffer waiting its turn, and the answer of the one in flight (the buffer was cleared, loaded or run)."""
        with self._wake:
            self._generation += 1
            self._pending = None

    def idle(self) -> bool:
        with self._wake:
            return self._pending is None and not self._busy

    def wait_idle(self, timeout: float = 30.0) -> bool:
        """Wait until nothing is running or waiting (tests, and leaving the console)."""
        with self._wake:
            return self._wake.wait_for(lambda: self._pending is None and not self._busy, timeout)

    def close(self) -> None:
        with self._wake:
            self._closed = True
            self._pending = None
            self._wake.notify_all()

    def _work(self) -> None:
        while True:
            with self._wake:
                self._wake.wait_for(lambda: self._pending is not None or self._closed)
                if self._closed:
                    return
                job = self._pending
                self._pending = None
                self._busy = True
            assert job is not None
            outcome = LiveOutcome(job=job)
            try:
                outcome.result = self.convert(job)
            except CompilationFailed as exc:
                outcome.failure = exc
            except ImyError as exc:
                outcome.error = exc
            except Exception as exc:  # a preview must never take the console down
                outcome.error = ImyError(f"{type(exc).__name__}: {exc}")
            with self._wake:
                forgotten = self._generation != job.generation
                outcome.stale = self._latest != job.number
                closed = self._closed
            try:
                # A buffer that was cleared or run since has nothing to say any more.
                if not closed and not forgotten:
                    self.deliver(outcome)
            finally:
                with self._wake:
                    self._busy = False
                    self._wake.notify_all()
