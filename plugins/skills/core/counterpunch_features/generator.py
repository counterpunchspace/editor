"""Write languagesystem declarations and the aalt feature from the font's feature code."""

from __future__ import annotations

import re
from typing import Any

_LANGUAGE_SYSTEM = re.compile(r"languagesystem\s+(\S+)\s+(\S+)\s*;")
_SCRIPT = re.compile(r"script\s+(\S+)\s*;")
_LANGUAGE = re.compile(r"language\s+(\S+)\s*;")
_TOKEN = re.compile(r"[A-Za-z_][A-Za-z0-9_.\\-]*")

# Unicode Script property name, compared case-insensitively with spaces removed.
_SCRIPT_TAGS = {
    "latin": "latn",
    "arabic": "arab",
    "cyrillic": "cyrl",
    "greek": "grek",
    "hebrew": "hebr",
    "armenian": "armn",
    "georgian": "geor",
    "devanagari": "deva",
    "bengali": "beng",
    "gurmukhi": "guru",
    "gujarati": "gujr",
    "oriya": "orya",
    "odia": "orya",
    "tamil": "taml",
    "telugu": "telu",
    "kannada": "knda",
    "malayalam": "mlym",
    "sinhala": "sinh",
    "thai": "thai",
    "lao": "lao",
    "myanmar": "mymr",
    "khmer": "khmr",
    "hangul": "hang",
    "hiragana": "hira",
    "katakana": "kana",
    "han": "hani",
    "bopomofo": "bopo",
    "tibetan": "tibt",
    "ethiopic": "ethi",
    "cherokee": "cher",
    "canadianaboriginal": "cans",
    "coptic": "copt",
    "syriac": "syrc",
    "thaana": "thaa",
    "nko": "nko ",
    "mongolian": "mong",
    "tifinagh": "tfng",
}


class LanguageSystemGenerator:
    """Declare the script and language systems the feature code actually uses."""

    generator_id = "space.counterpunch.languagesystems"
    capability = "feature:languagesystems"
    representations = set()
    version = "1.0.0"
    EVENT_TYPES: list[str] = []
    INTENT_KEYS: list[str] = []
    follows_features = True
    follow_rank = 0

    def needs_rebuild(self, batch: dict[str, Any], font: Any, context: dict[str, Any]) -> bool:
        del batch, font, context
        return True

    def generate(self, batch: dict[str, Any], font: Any, context: dict[str, Any]) -> dict[str, Any]:
        del batch
        declared = _declared(context.get("languagesystem_text") or "")
        used = _used_systems(font)
        if used:
            used.add(("DFLT", "dflt"))
        lines = [
            f"languagesystem {script} {language};"
            for script, language in _sorted_systems(used - declared)
        ]
        return {
            "blocks": [
                {
                    "block": "languagesystems",
                    "tag": "languagesystems",
                    "code": "\n".join(lines),
                    "placement": "prefix",
                }
            ],
            "diagnostics": [],
        }


class AccessAllAlternatesGenerator:
    """Reference every other feature tag from aalt."""

    generator_id = "space.counterpunch.aalt"
    capability = "feature:aalt"
    representations = {"aalt"}
    version = "1.0.0"
    EVENT_TYPES: list[str] = []
    INTENT_KEYS: list[str] = []
    follows_features = True
    follow_rank = 1

    def needs_rebuild(self, batch: dict[str, Any], font: Any, context: dict[str, Any]) -> bool:
        del batch, font, context
        return True

    def generate(self, batch: dict[str, Any], font: Any, context: dict[str, Any]) -> dict[str, Any]:
        del batch, context
        seen: set[str] = set()
        lines: list[str] = []
        for tag, _code in _feature_entries(font):
            if tag == "aalt" or tag in seen:
                continue
            seen.add(tag)
            lines.append(f"feature {tag};")
        return {
            "blocks": [
                {
                    "block": "aalt",
                    "tag": "aalt",
                    "code": "\n".join(lines),
                    "placement": "first",
                }
            ],
            "diagnostics": [],
        }


def _used_systems(font: Any) -> set[tuple[str, str]]:
    glyphs = _glyphs_by_name(font)
    used: set[tuple[str, str]] = set()
    for _tag, code in _feature_entries(font):
        used.update(_systems_in_code(code, glyphs))
    return used


def _systems_in_code(code: str, glyphs: dict[str, Any]) -> set[tuple[str, str]]:
    used: set[tuple[str, str]] = set()
    current = ""
    saw_language = False
    for raw in code.splitlines():
        line = raw.split("#", 1)[0]
        declared = _LANGUAGE_SYSTEM.search(line)
        if declared:
            _close_script(used, current, saw_language)
            current = ""
            saw_language = False
            used.add((declared.group(1), declared.group(2)))
            continue
        script = _SCRIPT.search(line)
        if script:
            _close_script(used, current, saw_language)
            current = script.group(1)
            saw_language = False
            continue
        language = _LANGUAGE.search(line)
        if language and current:
            used.add((current, language.group(1)))
            saw_language = True
    _close_script(used, current, saw_language)
    stripped = "\n".join(raw.split("#", 1)[0] for raw in code.splitlines())
    for token in _TOKEN.findall(stripped):
        glyph = glyphs.get(token)
        if glyph is None:
            continue
        tag = _script_tag(_text(_field(_field(glyph, "glyphData"), "script")))
        if tag:
            used.add((tag, "dflt"))
    return used


def _close_script(used: set[tuple[str, str]], script: str, saw_language: bool) -> None:
    if script and not saw_language:
        used.add((script, "dflt"))


def _script_tag(script: str) -> str:
    key = re.sub(r"[\s_]+", "", script).lower()
    if key in {"", "common", "inherited", "unknown"}:
        return ""
    return _SCRIPT_TAGS.get(key, "")


def _declared(text: str) -> set[tuple[str, str]]:
    return {(match.group(1), match.group(2)) for match in _LANGUAGE_SYSTEM.finditer(text)}


def _sorted_systems(systems: set[tuple[str, str]]) -> list[tuple[str, str]]:
    return sorted(systems, key=lambda item: (item[0] != "DFLT", item[0], item[1]))


def _feature_entries(font: Any) -> list[tuple[str, str]]:
    features = _field(_field(font, "features"), "features")
    entries: list[tuple[str, str]] = []
    for item in list(features or []):
        try:
            tag, code = item[0], item[1]
        except Exception:
            continue
        entries.append((_text(tag), _text(_field(code, "code"))))
    return entries


def _glyphs_by_name(font: Any) -> dict[str, Any]:
    glyphs = _field(font, "glyphs")
    found: dict[str, Any] = {}
    for glyph in list(glyphs or []):
        name = _text(_field(glyph, "name"))
        if name and name not in found:
            found[name] = glyph
    return found


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
