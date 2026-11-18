"""Add Glyphs catalog for packaged connection sets.

The feature writer and the ccmp conversion do not import this module.
They discover connections from ``.conn-<id>-<step>`` glyph names.
"""

from __future__ import annotations

from importlib.resources import files
from typing import Any

CONNECTIONS: tuple[dict[str, Any], ...] = (
    {
        "id": "high1",
        "title": "High connection",
        "description": (
            "On tooth letters the stroke rises and joins the following "
            "letter above the baseline."
        ),
        "image": "conn-high1.svg",
        "glyphs": (
            "behDotless-ar.medi.conn-high1-1",
            "reh-ar.fina.conn-high1-2",
        ),
    },
    {
        "id": "hah",
        "title": "Hah connection",
        "description": (
            "Initial beh and lam join a following medial hah at the top "
            "of its stroke."
        ),
        "image": "conn-hah.svg",
        "glyphs": (
            "behDotless-ar.init.conn-hah-1",
            "lam-ar.init.conn-hah-1",
            "hah-ar.medi.conn-hah-2",
        ),
    },
)


def set_id(conn_id: str) -> str:
    return f"conn-{conn_id}"


def image_markup(filename: str) -> str:
    path = files("counterpunch_arabic").joinpath(f"data/{filename}")
    return path.read_text(encoding="utf-8")
