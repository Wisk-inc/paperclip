from __future__ import annotations

import io
import threading
import time

import pytest
from rich.console import Console

from imy.progress import format_seconds, working


@pytest.mark.parametrize(
    "seconds, text",
    [(0, "0 s"), (0.4, "0 s"), (7.6, "8 s"), (59.4, "59 s"), (60, "1 min 00 s"), (65.2, "1 min 05 s"), (3725, "62 min 05 s"), (-3, "0 s")],
)
def test_seconds_are_short_enough_for_a_phone(seconds: float, text: str) -> None:
    assert format_seconds(seconds) == text


def test_piped_output_gets_the_timing_and_no_drawing() -> None:
    stream = io.StringIO()
    console = Console(file=stream, force_terminal=False)
    with working(console, "Compiling hello.imy") as elapsed:
        time.sleep(0.05)
        assert 0.04 <= elapsed() < 5
    assert stream.getvalue() == ""
    assert not [thread for thread in threading.enumerate() if thread.name == "imy-progress"]


def test_a_terminal_sees_the_label_and_the_ticker_stops() -> None:
    stream = io.StringIO()
    console = Console(file=stream, force_terminal=True, width=80)
    with working(console, "Compiling hello.imy", hint="free models often take a minute", hint_after=0.0) as elapsed:
        time.sleep(1.3)
        assert elapsed() >= 1.2
    shown = stream.getvalue()
    assert "Compiling hello.imy" in shown
    assert "1 s" in shown and "free models often take a minute" in shown
    assert not [thread for thread in threading.enumerate() if thread.name == "imy-progress"]


def test_an_error_inside_still_stops_the_ticker() -> None:
    console = Console(file=io.StringIO(), force_terminal=True, width=80)
    with pytest.raises(RuntimeError):
        with working(console, "Compiling"):
            raise RuntimeError("the model failed")
    assert not [thread for thread in threading.enumerate() if thread.name == "imy-progress"]
