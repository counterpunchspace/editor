"""Arabic composition recipes keyed by Unicode identity."""

from __future__ import annotations

import json
from importlib.resources import files
from typing import Any

from counterpunch_arabic.anchor_positions import position_anchor


def _load() -> dict[str, Any]:
    path = files("counterpunch_arabic").joinpath("data/arabic.json")
    return json.loads(path.read_text(encoding="utf-8"))


def identity_for(codepoint: int) -> str:
    if codepoint <= 0xFFFF:
        return f"uni{codepoint:04X}"
    return f"uni{codepoint:X}"


class ArabicCompositionProvider:
    provider_id = "space.counterpunch.arabic"
    capability = "composition:arabic:default"
    version = "1.0.0"

    def __init__(self) -> None:
        data = _load()
        self._characters = data["characters"]
        self._unencoded = data["unencoded"]
        self._anchors = data["anchors"]

    def recipe(self, codepoint: int, lookup: Any = None) -> dict[str, Any] | None:
        record = lookup(int(codepoint)) if lookup is not None else None
        if record is not None and record.get("script") not in ("Arabic", None, ""):
            return None
        if record is not None and record.get("script") != "Arabic":
            return None
        stored = self._characters.get(identity_for(int(codepoint)))
        if stored is None:
            return None
        recipe = {"source": "arabic", "positions": stored["positions"]}
        if stored.get("decompose"):
            recipe["decompose"] = stored["decompose"]
        return recipe

    def recipe_for_name(self, name: str) -> dict[str, Any] | None:
        entry = self._unencoded.get(name)
        if entry is None:
            return None
        recipe: dict[str, Any] = {
            "source": "arabic",
            "positions": entry.get("positions") or {},
            "category": entry.get("category") or "Mark",
        }
        if entry.get("components"):
            recipe["components"] = list(entry["components"])
        return recipe

    def anchors(self, identity_or_name: int | str) -> list[str]:
        if isinstance(identity_or_name, int):
            key = identity_for(identity_or_name)
        else:
            key = str(identity_or_name)
        names = list(self._anchors.get(key) or [])
        entry = self._unencoded.get(key)
        if entry and entry.get("anchors"):
            for name in entry["anchors"]:
                if name not in names:
                    names.append(name)
        return names

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
