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
            "help": "Components builds the glyph from components. ccmp leaves it empty and composes it when text is shaped.",
            "target": "add-glyphs",
            "options": [
                {"value": "materialized", "label": "Components"},
                {"value": "ccmp", "label": "ccmp"},
            ],
            "default": "materialized",
            "regenerates": False,
        }
    ]

    def read_inputs(self, code: str) -> list[str]:
        return [rule[0] for rule in _parse(code)]

    def needs_rebuild(self, batch: dict[str, Any], context: dict[str, Any]) -> bool:
        watched = set(context.get("managed_inputs") or [])
        watched.update(context.get("managed_components") or [])
        intent = (batch.get("intents") or {}).get("ccmp") or {}
        watched.update(intent.get("add") or [])
        watched.update(intent.get("remove") or [])
        # Rebuild can target glyphs whose outlines do not change. The intent
        # is the only signal in that transaction.
        if intent.get("add") or intent.get("remove"):
            return True
        if not watched and not intent:
            return bool(batch.get("lifecycle"))
        names = _batch_names(batch)
        return bool(names & watched) or bool(batch.get("lifecycle"))

    def generate(self, batch: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
        rules = {glyph: components for glyph, components in _parse(context.get("managed_code") or "")}
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
        present = set(context.get("font_glyphs") or [])
        recipes = context.get("recipes") or {}
        # Existing lines win, so a designer's components survive later rebuilds.
        # Intent components are the conversion source. Recipes fill new glyphs only.
        supplied = intent.get("components") or {}
        kept: dict[str, list[str]] = {}
        for glyph in sorted(rules):
            if glyph not in present:
                diagnostics.append(f"Dropped {glyph}: glyph is not in the font.")
                continue
            components = (
                list(rules[glyph])
                if rules[glyph]
                else list(supplied.get(glyph) or []) or recipes.get(glyph)
            )
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
