"""Character set for the glyphs the Arabic pack composes and substitutes."""

from __future__ import annotations

import json
from importlib.resources import files
from typing import Any

from counterpunch_arabic.connections import CONNECTIONS, image_markup, set_id


def _union_categories(left: Any, right: Any) -> list[str]:
    categories: list[str] = []
    for source in (left, right):
        if not isinstance(source, list):
            continue
        for category in source:
            if isinstance(category, str) and category not in categories:
                categories.append(category)
    return categories


class ArabicCharacterSetProvider:
    provider_id = "space.counterpunch.arabic"
    display_name = "Arabic Language Pack"
    glyph_categories = [
        {"id": "bases", "label": "Bases"},
        {"id": "dots", "label": "Dots"},
        {"id": "marks", "label": "Marks"},
        {"id": "ligatures", "label": "Ligatures"},
    ]

    def __init__(self) -> None:
        path = files("counterpunch_arabic").joinpath("data/arabic.json")
        self._data = json.loads(path.read_text(encoding="utf-8"))

    def metadata(self) -> dict[str, Any]:
        tree = [{"id": "arabic", "label": "Arabic", "selectable": True}]
        details: dict[str, dict[str, str]] = {}
        for item in CONNECTIONS:
            identifier = set_id(str(item["id"]))
            tree.append(
                {
                    "id": identifier,
                    "label": item["title"],
                    "selectable": True,
                }
            )
            details[identifier] = {
                "title": item["title"],
                "description": item["description"],
                "image": image_markup(item["image"]),
            }
        return {
            "id": self.provider_id,
            "name": self.display_name,
            "version": "1.0.0",
            "tree": tree,
            "set_details": details,
            "glyph_categories": self.glyph_categories,
        }

    def characters(self, set_ids: list[str], levels: list[str]) -> list[dict[str, Any]]:
        requested = set(levels)
        selected = set(set_ids)
        characters: dict[str, dict[str, Any]] = {}
        for leaf in self._data["leaves"]:
            if selected and leaf["id"] not in selected:
                continue
            for entry in leaf["entries"]:
                if requested and entry["level"] not in requested:
                    continue
                key = (
                    f"u{entry['codepoint']}"
                    if "codepoint" in entry
                    else f"g{entry['glyph_name']}"
                )
                incoming = dict(entry)
                existing = characters.get(key)
                if existing is None:
                    characters[key] = incoming
                    continue
                categories = _union_categories(
                    existing.get("categories"), incoming.get("categories")
                )
                if entry["level_rank"] < existing["level_rank"]:
                    incoming["categories"] = categories
                    characters[key] = incoming
                else:
                    existing["categories"] = categories
        return list(characters.values())

    def members_by_set(self, set_ids: list[str], levels: list[str]) -> dict[str, dict[str, list]]:
        """Return each selected list's defined glyphs, deduped within the list."""
        requested = set(levels)
        selected = set(set_ids)
        grouped: dict[str, dict[str, list]] = {}
        for leaf in self._data["leaves"]:
            if selected and leaf["id"] not in selected:
                continue
            codepoints: dict[int, int] = {}
            names: dict[str, int] = {}
            for entry in leaf["entries"]:
                if requested and entry["level"] not in requested:
                    continue
                rank = entry["level_rank"]
                if "codepoint" in entry:
                    codepoint = entry["codepoint"]
                    existing = codepoints.get(codepoint)
                    if existing is None or rank < existing:
                        codepoints[codepoint] = rank
                elif entry.get("glyph_name"):
                    name = entry["glyph_name"]
                    existing = names.get(name)
                    if existing is None or rank < existing:
                        names[name] = rank
            grouped[leaf["id"]] = {
                "codepoints": list(codepoints),
                "glyph_names": list(names),
            }
        return grouped
