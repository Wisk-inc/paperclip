"""The example programs that ship inside IMY.

`imy examples` lists them, `imy examples hello` prints one and the console's
`:example hello` loads one into the buffer, so a first program is one command
away, also on a phone, where typing a whole file is slow.
"""

from __future__ import annotations

from dataclasses import dataclass
from importlib import resources
from importlib.resources.abc import Traversable

from .errors import ConfigError
from .parser import parse_header

# Shown in this order: the simplest first, then one idea each.
ORDER: tuple[str, ...] = (
    "hello",
    "tip",
    "countdown",
    "calculator",
    "jump",
    "notes",
    "session1",
    "session2",
    "website",
)

# What each example is there to show, in a few words.
SHOWS: dict[str, str] = {
    "hello": "a first program",
    "tip": "numbers and rounding",
    "countdown": "syntax you invent (<-, say >>, :: end)",
    "calculator": "asking the person for input",
    "jump": "a loop with your own block words",
    "notes": "a made-up file path that becomes a real file",
    "session1": "saving a function and a variable pack to memory",
    "session2": "using what session1 saved, without defining it",
    "website": "a strict web page: only what the code defines",
}


@dataclass(frozen=True)
class Example:
    name: str
    text: str

    @property
    def description(self) -> str:
        """What the program builds, from its own header."""
        for line in self.text.splitlines():
            described, _ = parse_header(line)
            if described:
                return described
        return ""

    @property
    def shows(self) -> str:
        return SHOWS.get(self.name, "")

    @property
    def lines(self) -> list[str]:
        return self.text.replace("\r\n", "\n").rstrip("\n").split("\n")


def _folder() -> Traversable:
    return resources.files("imy").joinpath("examples")


def example_names() -> list[str]:
    try:
        found = {entry.name[: -len(".imy")] for entry in _folder().iterdir() if entry.name.endswith(".imy")}
    except (FileNotFoundError, NotADirectoryError, OSError):
        return []
    ordered = [name for name in ORDER if name in found]
    return ordered + sorted(found.difference(ordered))


def list_examples() -> list[Example]:
    return [get_example(name) for name in example_names()]


def get_example(name: str) -> Example:
    wanted = name.strip()
    if wanted.endswith(".imy"):
        wanted = wanted[: -len(".imy")]
    names = example_names()
    if wanted not in names:
        close = [candidate for candidate in names if candidate.startswith(wanted.casefold())] if wanted else []
        if len(close) == 1:
            wanted = close[0]
        else:
            raise ConfigError(
                f"There is no example named {name!r}.",
                hint="The examples are: " + ", ".join(names) + "." if names else "This install has no examples.",
            )
    try:
        text = _folder().joinpath(f"{wanted}.imy").read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"The example {wanted!r} can't be read: {exc.strerror or exc}") from exc
    return Example(name=wanted, text=text)
