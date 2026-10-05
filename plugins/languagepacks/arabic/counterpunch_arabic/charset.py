"""Character set for the glyphs the Arabic pack composes and substitutes."""

from __future__ import annotations

import json
from importlib.resources import files
from typing import Any


class ArabicCharacterSetProvider:
    provider_id = "space.counterpunch.arabic"
    display_name = "Arabic Language Pack"

    def __init__(self) -> None:
        path = files("counterpunch_arabic").joinpath("data/arabic.json")
        self._data = json.loads(path.read_text(encoding="utf-8"))

    def metadata(self) -> dict[str, Any]:
        return {
            "id": self.provider_id,
            "name": self.display_name,
            "version": "1.0.0",
            "coverage_levels": [
                {"id": "essential", "label": "Essential", "default": True},
                {"id": "recommended", "label": "Recommended", "default": False},
                {"id": "optional", "label": "Optional", "default": False},
            ],
            "tree": [
                {
                    "id": "arabic",
                    "label": "Arabic",
                    "selectable": False,
                    "children": [
                        {
                            "id": leaf["id"],
                            "label": leaf["label"],
                            "selectable": True,
                        }
                        for leaf in self._data["leaves"]
                    ],
                }
            ],
        }

    def characters(self, set_ids: list[str], levels: list[str]) -> list[dict[str, Any]]:
        requested = set(levels)
        selected = set(set_ids)
        characters: dict[str, dict[str, Any]] = {}
        for leaf in self._data["leaves"]:
            if leaf["id"] not in selected:
                continue
            for entry in leaf["entries"]:
                if requested and entry["level"] not in requested:
                    continue
                key = (
                    f"u{entry['codepoint']}"
                    if "codepoint" in entry
                    else f"g{entry['glyph_name']}"
                )
                existing = characters.get(key)
                if existing is None or entry["level_rank"] < existing["level_rank"]:
                    characters[key] = dict(entry)
        return list(characters.values())
