"""The wheel Automa ships (server/src/services/scripts/terminals/imy/) must be this source.

Automa installs IMY from that wheel in its terminals, so a source change without a
rebuilt wheel would install old code. Rebuild with:
    python -m build --wheel --outdir ../server/src/services/scripts/terminals/imy .
Skipped outside the Automa repository (for example in the sdist).
"""

from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from imy import __version__

ENGINE = Path(__file__).resolve().parent.parent
BUNDLE = ENGINE.parent / "server" / "src" / "services" / "scripts" / "terminals" / "imy"

pytestmark = pytest.mark.skipif(not BUNDLE.is_dir(), reason="not inside the Automa repository")


def test_one_wheel_for_this_version() -> None:
    wheels = sorted(p.name for p in BUNDLE.glob("*.whl"))
    assert wheels == [f"imagenery-{__version__}-py3-none-any.whl"]


def test_wheel_holds_exactly_this_source() -> None:
    wheel = BUNDLE / f"imagenery-{__version__}-py3-none-any.whl"
    with zipfile.ZipFile(wheel) as archive:
        packaged = {name: archive.read(name) for name in archive.namelist() if name.startswith("imy/")}
    source = {f"imy/{p.name}": p.read_bytes() for p in (ENGINE / "src" / "imy").glob("*.py")}
    assert sorted(packaged) == sorted(source)
    stale = [name for name in source if packaged[name] != source[name]]
    assert stale == [], f"rebuild the bundled wheel; these files changed: {stale}"
