"""Expose Hyperglot character sets without runtime third-party dependencies."""

import json
from importlib.resources import files


def _union_categories(left, right):
    categories = []
    for source in (left, right):
        if not isinstance(source, list):
            continue
        for category in source:
            if isinstance(category, str) and category not in categories:
                categories.append(category)
    return categories


class HyperglotCharacterSetProvider:
    """Read the build-time-resolved Hyperglot character-set catalogue."""

    provider_id = "org.rosettatype.hyperglot"
    display_name = "Hyperglot"

    def __init__(self):
        data_path = files("counterpunch_hyperglot").joinpath("data.json")
        self._data = json.loads(data_path.read_text(encoding="utf-8"))

    def metadata(self):
        return {
            "id": self.provider_id,
            "name": self.display_name,
            "version": self._data["version"],
            "tree": self._data["tree"],
            "glyph_categories": [
                {"id": "base", "label": "Base"},
                {"id": "auxiliary", "label": "Auxiliary"},
                {"id": "marks", "label": "Marks"},
                {"id": "punctuation", "label": "Punctuation"},
                {"id": "numerals", "label": "Numerals"},
                {"id": "currency", "label": "Currency"},
            ],
        }

    def characters(self, set_ids, levels):
        """Return the deduplicated union of selected leaves and coverage levels."""
        requested_levels = set(levels)
        selected = set(set_ids)
        characters = {}
        for leaf in self._data["leaves"]:
            if leaf["id"] not in selected:
                continue
            for character in leaf["characters"]:
                if requested_levels and character["level"] not in requested_levels:
                    continue
                codepoint = character["codepoint"]
                incoming = dict(character)
                existing = characters.get(codepoint)
                if existing is None:
                    characters[codepoint] = incoming
                    continue
                categories = _union_categories(
                    existing.get("categories"), incoming.get("categories")
                )
                if character["level_rank"] < existing["level_rank"]:
                    incoming["categories"] = categories
                    characters[codepoint] = incoming
                else:
                    existing["categories"] = categories
        return list(characters.values())

    def members_by_set(self, set_ids, levels):
        """Return each selected list's defined codepoints, deduped within the list."""
        requested_levels = set(levels)
        selected = set(set_ids)
        grouped = {}
        for leaf in self._data["leaves"]:
            if leaf["id"] not in selected:
                continue
            codepoints = {}
            for character in leaf["characters"]:
                if requested_levels and character["level"] not in requested_levels:
                    continue
                codepoint = character["codepoint"]
                existing = codepoints.get(codepoint)
                if existing is None or character["level_rank"] < existing:
                    codepoints[codepoint] = character["level_rank"]
            grouped[leaf["id"]] = {
                "codepoints": list(codepoints),
                "glyph_names": [],
            }
        return grouped
