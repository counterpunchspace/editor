"""Latin composition recipes from Unicode, with an empty override slot.

``overrides.json`` maps a codepoint string to a component list::

    {"228": [{"codepoint": 97, "role": "base"}, {"codepoint": 776, "role": "mark"}]}

An override replaces Unicode decomposition for that codepoint. The file ships empty.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from importlib.resources import files
from typing import Any

from counterpunch_latin.anchor_definitions import DEFINED_ANCHOR_NAMES, position_anchor

Lookup = Callable[[int], dict[str, Any] | None]


class LatinCompositionProvider:
    provider_id = "space.counterpunch.latin"
    capability = "composition:latin:default"
    version = "1.0.0"

    def __init__(self) -> None:
        data = files("counterpunch_latin").joinpath("data")
        overrides = json.loads(data.joinpath("overrides.json").read_text(encoding="utf-8"))
        anchors = json.loads(data.joinpath("anchors.json").read_text(encoding="utf-8"))
        self._overrides = {
            int(codepoint): components for codepoint, components in overrides.items()
        }
        self._anchors = anchors

    def recipe(self, codepoint: int, lookup: Lookup) -> dict[str, Any] | None:
        record = lookup(int(codepoint))
        if record is None or record.get("script") not in (None, "", "Latin"):
            if record is not None and record.get("script") != "Latin":
                return None
        override = self._overrides.get(int(codepoint))
        if override is not None:
            components = [dict(component) for component in override]
            source = "override"
        else:
            flat = _flatten(int(codepoint), lookup, set())
            if flat is None:
                return None
            components = [
                {
                    "codepoint": component,
                    "role": "mark" if _is_mark(lookup(component)) else "base",
                }
                for component in flat
            ]
            source = "unicode"
        if not components or components[0]["role"] == "mark":
            return None
        if any(component["role"] != "mark" for component in components[1:]):
            return None
        requested = lookup(int(codepoint))
        if requested is not None and requested.get("script") not in ("Latin", None, ""):
            return None
        if requested is None or requested.get("script") != "Latin":
            return None
        return {"components": components, "source": source}

    def anchors(self, codepoint: int) -> list[str]:
        names = self._anchors.get(_identity(codepoint), [])
        return [name for name in names if name in DEFINED_ANCHOR_NAMES]

    def anchor_positions(self, requests: list[dict[str, Any]]) -> list[dict[str, Any]]:
        positioned = []
        for request in requests:
            positions = {}
            for name in request.get("names") or []:
                point = position_anchor(
                    name,
                    request.get("role") or "upper",
                    request.get("metrics") or {},
                    float(request.get("width") or 0),
                    _bbox(request.get("bbox")),
                    request.get("band"),
                )
                if point is not None:
                    positions[name] = [point[0], point[1]]
            positioned.append(
                {
                    "glyph_name": request.get("glyph_name"),
                    "master_id": request.get("master_id"),
                    "positions": positions,
                }
            )
        return positioned


def _bbox(value: Any) -> tuple[float, float, float, float] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    return tuple(float(item) for item in value)  # type: ignore[return-value]


def _flatten(codepoint: int, lookup: Lookup, seen: set[int]) -> list[int] | None:
    if codepoint in seen:
        return None
    record = lookup(codepoint)
    if record is None:
        return None
    decomposition = str(record.get("decomposition") or "").strip()
    if not decomposition or decomposition.startswith("<"):
        return None
    seen.add(codepoint)
    parts = []
    for token in decomposition.split():
        if token.startswith("<"):
            return None
        parts.append(int(token, 16))
    flat: list[int] = []
    for part in parts:
        nested = lookup(part)
        nested_decomposition = str((nested or {}).get("decomposition") or "").strip()
        if nested_decomposition and not nested_decomposition.startswith("<"):
            expanded = _flatten(part, lookup, seen)
            if expanded is None:
                return None
            flat.extend(expanded)
        else:
            flat.append(part)
    return flat


def _is_mark(record: dict[str, Any] | None) -> bool:
    if record is None:
        return False
    category = str(record.get("general_category") or record.get("category") or "")
    return category.startswith("M")


def _identity(codepoint: int) -> str:
    return f"uni{codepoint:04X}"
