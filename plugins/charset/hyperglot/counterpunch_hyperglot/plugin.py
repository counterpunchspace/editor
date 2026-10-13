"""Expose Hyperglot character sets without runtime third-party dependencies."""

import json
from importlib.resources import files


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
                existing = characters.get(codepoint)
                if existing is None or character["level_rank"] < existing["level_rank"]:
                    characters[codepoint] = character
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
