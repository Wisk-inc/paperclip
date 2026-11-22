"""A spinner that says what IMY is waiting for, and for how long.

A compile on a free model can take a minute or more. A spinner that only spins
looks stuck; the seconds next to it show that the model is still being waited
for, and the same number is reported once the answer is in.
"""

from __future__ import annotations

import contextlib
import os
import sys
import threading
import time
from collections.abc import Callable, Iterator

from rich.console import Console
from rich.markup import escape

try:  # Not on Windows, where the terminal is not changed.
    import termios
except ImportError:  # pragma: no cover
    termios = None  # type: ignore[assignment]


def format_seconds(seconds: float) -> str:
    """12 s, 1 min 05 s: short enough for a phone's terminal."""
    whole = max(0, int(round(seconds)))
    if whole < 60:
        return f"{whole} s"
    minutes, rest = divmod(whole, 60)
    return f"{minutes} min {rest:02d} s"


def _own_keyboard() -> int | None:
    """The keyboard, when it is a terminal this program is in the foreground of."""
    if termios is None:
        return None
    try:
        keyboard = sys.stdin.fileno()
        # A program in the background that changes the terminal is stopped by the system.
        if not os.isatty(keyboard) or os.tcgetpgrp(keyboard) != os.getpgrp():
            return None
    except (AttributeError, OSError, ValueError):
        return None
    return keyboard


@contextlib.contextmanager
def keys_unseen() -> Iterator[None]:
    """Keys pressed meanwhile are not shown on the screen. Shown, they would land in the line
    that is being redrawn, and a pressed Enter would leave that line behind. They are not
    lost: whatever reads the keyboard next gets them as typed."""
    keyboard = _own_keyboard()
    if keyboard is None:
        yield
        return
    try:
        saved = termios.tcgetattr(keyboard)
        unseen = termios.tcgetattr(keyboard)
        unseen[3] &= ~termios.ECHO
        termios.tcsetattr(keyboard, termios.TCSANOW, unseen)
    except (termios.error, OSError):
        yield
        return
    try:
        yield
    finally:
        with contextlib.suppress(termios.error, OSError):
            termios.tcsetattr(keyboard, termios.TCSANOW, saved)


@contextlib.contextmanager
def working(console: Console, label: str, *, hint_after: float = 20.0, hint: str = "") -> Iterator[Callable[[], float]]:
    """Show ``label`` with the seconds that have passed. Yields a function that returns them.

    On a terminal the line is redrawn each second. Where output is piped or
    captured nothing is drawn (there is no line to redraw), and the caller
    still gets the timing. ``hint`` is added once ``hint_after`` seconds have
    passed, for a wait that is normal but long.
    """
    started = time.monotonic()

    def elapsed() -> float:
        return time.monotonic() - started

    if not console.is_terminal:
        yield elapsed
        return

    stop = threading.Event()
    text = escape(label)
    with keys_unseen(), console.status(f"{text}…") as status:

        def tick() -> None:
            while not stop.wait(1.0):
                waited = elapsed()
                extra = f"  [dim]{escape(hint)}[/dim]" if hint and waited >= hint_after else ""
                with contextlib.suppress(Exception):
                    status.update(f"{text}… [bold]{format_seconds(waited)}[/bold]{extra}")

        thread = threading.Thread(target=tick, name="imy-progress", daemon=True)
        thread.start()
        try:
            yield elapsed
        finally:
            stop.set()
            thread.join(timeout=2.0)
