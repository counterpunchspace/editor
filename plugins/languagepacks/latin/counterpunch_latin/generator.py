"""Write smcp and c2sc by walking the font's glyphs."""

from __future__ import annotations

from typing import Any

_OWN = "space.counterpunch.latin"


class LatinSmallCapsGenerator:
    generator_id = _OWN
    capability = "feature:latin:smallcaps"
    representations = {"smcp", "c2sc"}
    version = "1.0.0"
    EVENT_TYPES = ["glyph.unicode.changed"]
    INTENT_KEYS: list[str] = []

    def needs_rebuild(self, batch: dict[str, Any], font: Any, context: dict[str, Any]) -> bool:
        del font, context
        if batch.get("lifecycle"):
            return True
        for change in batch.get("changes") or []:
            if change.get("type") == "glyph.unicode.changed":
                return True
        return False

    def generate(self, batch: dict[str, Any], font: Any, context: dict[str, Any]) -> dict[str, Any]:
        del batch, context
        by_name: dict[str, Any] = {}
        by_codepoint: dict[int, Any] = {}
        for glyph in _glyphs(font):
            name = _text(_field(glyph, "name"))
            if not name or name in by_name:
                continue
            by_name[name] = glyph
            codepoint = _first_codepoint(glyph)
            if codepoint is not None and codepoint not in by_codepoint:
                by_codepoint[codepoint] = glyph
        smcp: list[str] = []
        c2sc: list[str] = []
        for name in sorted(by_name):
            data = _field(by_name[name], "glyphData")
            if _text(_field(data, "script")) != "Latin":
                continue
            category = _text(_field(data, "general_category"))
            if category == "Ll" and not name.endswith(".sc"):
                target = f"{name}.sc"
                if target in by_name:
                    smcp.append(f"sub {name} by {target};")
            elif category == "Lu":
                lower = _one_codepoint(_text(_field(data, "lowercase")))
                lower_glyph = by_codepoint.get(lower) if lower is not None else None
                lower_name = _text(_field(lower_glyph, "name")) if lower_glyph else ""
                target = f"{lower_name}.sc" if lower_name else ""
                if target and target in by_name:
                    c2sc.append(f"sub {name} by {target};")
        return {
            "blocks": [
                {"block": "smcp", "tag": "smcp", "code": "\n".join(smcp)},
                {"block": "c2sc", "tag": "c2sc", "code": "\n".join(c2sc)},
            ],
            "diagnostics": [],
        }


def _one_codepoint(value: str) -> int | None:
    parts = value.split()
    if len(parts) != 1:
        return None
    try:
        return int(parts[0], 16)
    except ValueError:
        return None


def _glyphs(font: Any) -> list[Any]:
    glyphs = _field(font, "glyphs")
    if not glyphs:
        return []
    return list(glyphs)


def _first_codepoint(glyph: Any) -> int | None:
    values = _field(glyph, "codepoints")
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


def _field(obj: Any, key: str) -> Any:
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    try:
        value = obj[key]
    except Exception:
        try:
            value = getattr(obj, key)
        except Exception:
            return None
    return None if value is None else value


def _text(value: Any) -> str:
    if value is None:
        return ""
    return str(value)
