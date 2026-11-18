"""Write the managed ``ccmp`` block from existing lines, conversion components, or recipes."""

from __future__ import annotations

import re
from typing import Any

_RULE = re.compile(r"^\s*sub\s+(\S+)\s+by\s+(.+?)\s*;\s*$")


class CcmpFeatureGenerator:
    generator_id = "space.counterpunch.ccmp"
    capability = "feature:ccmp"
    representations = {"ccmp"}
    version = "1.0.0"
    EVENT_TYPES = ["glyph.unicode.changed"]
    INTENT_KEYS = ["ccmp"]
    SETTINGS = [
        {
            "id": "composition_output",
            "type": "radio",
            "label": "Composition output for new glyphs",
            "help": "For letters that Counterpunch can build from other glyphs, such as Ä from A and ¨. Glyphs already in the font don’t change. To change one later, right-click it in the glyph overview.",
            "target": "add-glyphs",
            "options": [
                {
                    "value": "ccmp",
                    "label": "On-the-fly Composition (ccmp)",
                    "help": "You draw and maintain only the base shapes. Counterpunch and most apps put the complete letters together from them on-the-fly, so you have fewer glyphs to look after. Coming soon: optionally export a font from this with every letter built as components, for apps that can’t put them together.",
                },
                {
                    "value": "materialized",
                    "label": "Components",
                    "help": "Each letter, and each of its joining forms, is its own glyph in the font. They are built from components that point to the base shapes. The result is the same, but you have more glyphs to look after.",
                },
                {
                    "value": "none",
                    "label": "Empty",
                    "help": "The new glyph has nothing in it, and no parts are added. You draw it yourself.",
                },
            ],
            "default": "ccmp",
            "regenerates": False,
        }
    ]

    def read_inputs(self, code: str) -> list[str]:
        return [rule[0] for rule in _parse(code)]

    def needs_rebuild(self, batch: dict[str, Any], font: Any, context: dict[str, Any]) -> bool:
        del font
        intent = (batch.get("intents") or {}).get("ccmp") or {}
        # Rebuild can target glyphs whose outlines do not change. The intent
        # is the only signal in that transaction.
        if intent.get("add") or intent.get("remove"):
            return True
        watched: set[str] = set()
        for glyph, components in _parse(_block(context, "ccmp")):
            watched.add(glyph)
            watched.update(components)
        if not watched:
            return bool(batch.get("lifecycle"))
        return bool(_batch_names(batch) & watched) or bool(batch.get("lifecycle"))

    def generate(self, batch: dict[str, Any], font: Any, context: dict[str, Any]) -> dict[str, Any]:
        rules = {glyph: components for glyph, components in _parse(_block(context, "ccmp"))}
        diagnostics = []
        for change in batch.get("lifecycle") or []:
            if change.get("kind") == "renamed":
                previous = change.get("previousGlyphName")
                current = change.get("glyphName")
                if previous in rules and current:
                    rules[current] = [
                        current if name == previous else name for name in rules.pop(previous)
                    ]
            elif change.get("kind") == "deleted":
                deleted = change.get("glyphName")
                rules.pop(deleted, None)
                for glyph, components in list(rules.items()):
                    if deleted in components:
                        rules.pop(glyph, None)
                        diagnostics.append(
                            f"Dropped {glyph}: missing {deleted}."
                        )
        intent = (batch.get("intents") or {}).get("ccmp") or {}
        for glyph in intent.get("remove") or []:
            rules.pop(glyph, None)
        for glyph in intent.get("add") or []:
            rules.setdefault(glyph, [])
        present, by_codepoint = _index(font)
        # Existing lines win, so a designer's components survive later rebuilds.
        # Intent components are the conversion source. Recipes fill new glyphs only.
        supplied = intent.get("components") or {}
        kept: dict[str, list[str]] = {}
        for glyph in sorted(rules):
            if glyph not in present:
                diagnostics.append(f"Dropped {glyph}: glyph is not in the font.")
                continue
            components = list(rules[glyph]) if rules[glyph] else list(supplied.get(glyph) or [])
            if not components:
                codepoint = _first_codepoint(present[glyph])
                components = _recipe_names(codepoint, by_codepoint) if codepoint is not None else []
            if not components:
                diagnostics.append(f"Dropped {glyph}: no components.")
                continue
            missing = [name for name in components if name not in present]
            if missing:
                diagnostics.append(
                    f"Dropped {glyph}: missing {', '.join(missing)}."
                )
                continue
            kept[glyph] = list(components)
        lines = [f"sub {glyph} by {' '.join(components)};" for glyph, components in kept.items()]
        return {
            "blocks": [
                {
                    "block": "decomposition",
                    "tag": "ccmp",
                    "code": "\n".join(lines),
                    "placement": "first",
                }
            ],
            "diagnostics": diagnostics,
        }


def _parse(code: str) -> list[tuple[str, list[str]]]:
    rules = []
    for line in code.splitlines():
        match = _RULE.match(line)
        if match:
            rules.append((match.group(1), match.group(2).split()))
    return rules


def _block(context: dict[str, Any], tag: str) -> str:
    blocks = context.get("managed_blocks") or {}
    return str(blocks.get(tag) or "")


def _index(font: Any) -> tuple[dict[str, Any], dict[int, Any]]:
    present: dict[str, Any] = {}
    by_codepoint: dict[int, Any] = {}
    glyphs = getattr(font, "glyphs", None) if font is not None else None
    for glyph in list(glyphs or []):
        name = getattr(glyph, "name", None)
        if not isinstance(name, str) or not name or name in present:
            continue
        present[name] = glyph
        codepoint = _first_codepoint(glyph)
        if codepoint is not None and codepoint not in by_codepoint:
            by_codepoint[codepoint] = glyph
    return present, by_codepoint


def _first_codepoint(glyph: Any) -> int | None:
    values = getattr(glyph, "codepoints", None)
    if not values:
        return None
    for value in list(values):
        if isinstance(value, bool) or isinstance(value, str):
            continue
        try:
            number = int(value)
        except (TypeError, ValueError):
            continue
        if number >= 0:
            return number
    return None


def _recipe_names(codepoint: int, by_codepoint: dict[int, Any]) -> list[str]:
    from counterpunch_latin.composition import LatinCompositionProvider

    def lookup(requested: int) -> dict[str, Any] | None:
        glyph = by_codepoint.get(int(requested))
        data = getattr(glyph, "glyphData", None) if glyph is not None else None
        return _record(data)

    recipe = LatinCompositionProvider().recipe(codepoint, lookup)
    if not recipe:
        return []
    names: list[str] = []
    for component in recipe.get("components") or []:
        glyph = by_codepoint.get(int(component["codepoint"]))
        name = getattr(glyph, "name", None) if glyph is not None else None
        if not isinstance(name, str) or not name:
            return []
        names.append(name)
    return names


def _record(data: Any) -> dict[str, Any] | None:
    if data is None:
        return None
    if isinstance(data, dict):
        return data
    return {
        "script": _read(data, "script") or "",
        "general_category": _read(data, "general_category") or "",
        "decomposition": _read(data, "decomposition") or "",
        "combining_class": str(_read(data, "combining_class") or ""),
    }


def _read(obj: Any, key: str) -> Any:
    try:
        value = obj[key]
    except Exception:
        value = getattr(obj, key, None)
    return None if value is None else value


def _batch_names(batch: dict[str, Any]) -> set[str]:
    names = set()
    for change in batch.get("changes") or []:
        glyph_name = (change.get("metadata") or {}).get("glyphName")
        if glyph_name:
            names.add(glyph_name)
    for change in batch.get("lifecycle") or []:
        if change.get("glyphName"):
            names.add(change["glyphName"])
        if change.get("previousGlyphName"):
            names.add(change["previousGlyphName"])
    return names
