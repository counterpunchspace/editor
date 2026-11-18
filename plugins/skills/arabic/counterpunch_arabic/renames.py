"""Heuristic renames from legacy Arabic mark names to Counterpunch names."""

from __future__ import annotations

from typing import Any

# Legacy token (lowercase, no script tag) -> Counterpunch token.
MARK_ALIASES = {
    "fathatan": "fathaTanween",
    "fathatanween": "fathaTanween",
    "dammatan": "dammaTanween",
    "dammatanween": "dammaTanween",
    "kasratan": "kasraTanween",
    "kasratanween": "kasraTanween",
    "tanwinfatha": "fathaTanween",
    "tanwindamma": "dammaTanween",
    "tanwinkasra": "kasraTanween",
    "fatha": "fatha",
    "damma": "damma",
    "kasra": "kasra",
    "shadda": "shadda",
    "sukun": "sukun",
    "maddah": "maddah",
    "hamzaabove": "hamzaAbove",
    "hamzabelow": "hamzaBelow",
    "superscriptalef": "superscriptAlef",
}

_CANONICAL = set(MARK_ALIASES.values())
_SCRIPT = "-ar"


def _split(name: str) -> tuple[str, str]:
    dot = name.find(".")
    if dot < 0:
        return name, ""
    return name[:dot], name[dot:]


def _rename_one(name: str, taken: set[str]) -> str | None:
    root, suffix = _split(name)
    if not root.endswith(_SCRIPT):
        return None
    tokens = root[: -len(_SCRIPT)].split("_")
    mapped = []
    for token in tokens:
        target = MARK_ALIASES.get(token.lower())
        if target is None:
            return None
        mapped.append(target)
    result = "_".join(mapped) + _SCRIPT + suffix
    if result == name or result in taken:
        return None
    return result


def _from_components(
    glyph: dict[str, Any], already: dict[str, str], taken: set[str]
) -> str | None:
    """An unencoded mark ligature with an unrecognised name takes its parts' names."""
    name = glyph["name"]
    root, suffix = _split(name)
    components = glyph.get("components") or []
    if len(components) < 2 or glyph.get("codepoints") or "_" in root:
        return None
    parts = []
    for component in components:
        comp_root, comp_suffix = _split(already.get(component, component))
        if comp_suffix or not comp_root.endswith(_SCRIPT):
            return None
        token = comp_root[: -len(_SCRIPT)]
        if token not in _CANONICAL:
            return None
        parts.append(token)
    result = "_".join(parts) + _SCRIPT + suffix
    if result == name or result in taken:
        return None
    return result


class ArabicRenames:
    """Suggest renames for glyphs whose names are legacy Arabic mark names."""

    def rename_suggestions(
        self, glyphs: list[dict[str, Any]], renames: dict[str, str] | None = None
    ) -> dict[str, str]:
        already = renames or {}
        taken = {glyph["name"] for glyph in glyphs} | set(already.values())
        suggestions: dict[str, str] = {}
        for glyph in glyphs:
            name = glyph["name"]
            if name in already:
                continue
            target = _rename_one(name, taken) or _from_components(
                glyph, already, taken
            )
            if target is None:
                continue
            suggestions[name] = target
            taken.add(target)
        return suggestions
