"""Write isol/init/medi/fina form rules and required Arabic ligatures.

Tokens in the pack data are Unicode identities or pack glyph names. A production
name is substituted only while emitting a rule for this font.
"""

from __future__ import annotations

import json
import re
from importlib.resources import files
from typing import Any

_RULE = re.compile(r"^\s*sub\s+(\S+)\s+by\s+(.+?)\s*;\s*$")
_POSITIONS = ("init", "medi", "fina")
_VOWELS = {0x064B, 0x064C, 0x064D, 0x064E, 0x064F, 0x0650, 0x0651, 0x0652, 0x0670}
_ALEF = ("uni0622", "uni0623", "uni0625", "uni0671")
_CCMP = "space.counterpunch.ccmp"


def _load() -> dict[str, Any]:
    path = files("counterpunch_arabic").joinpath("data/arabic.json")
    return json.loads(path.read_text(encoding="utf-8"))


class ArabicFormsGenerator:
    generator_id = "space.counterpunch.arabic"
    capability = "feature:arabic:forms"
    representations = {"isol", "init", "medi", "fina", "rlig"}
    version = "1.0.0"
    EVENT_TYPES = ["glyph.unicode.changed"]
    INTENT_KEYS = ["arabic"]

    def __init__(self) -> None:
        data = _load()
        self._characters = data["characters"]
        self._mark_variants = data["markVariants"]
        self._rlig = data["rlig"]
        self._lam_alef_alefs = data["lamAlefAlefs"]

    def needs_rebuild(self, batch: dict[str, Any], font: Any, context: dict[str, Any]) -> bool:
        del font, context
        intent = (batch.get("intents") or {}).get("arabic") or {}
        if intent.get("add") or intent.get("remove"):
            return True
        if batch.get("lifecycle"):
            return True
        for change in batch.get("changes") or []:
            if change.get("type") == "glyph.unicode.changed":
                return True
        return False

    def generate(self, batch: dict[str, Any], font: Any, context: dict[str, Any]) -> dict[str, Any]:
        glyphs = _index(font)
        present = set(glyphs)
        names = _identity_names(glyphs)
        ccmp_inputs = _ccmp_inputs(font)
        diagnostics: list[str] = []
        intent = (batch.get("intents") or {}).get("arabic") or {}
        removed = set(intent.get("remove") or [])
        added = intent.get("add") or {}
        if isinstance(added, list):
            added = {name: {} for name in added}
        blocks = context.get("managed_blocks") or {}
        existing = {
            tag: _parse(blocks.get(tag) or "")
            for tag in ("isol", "init", "medi", "fina")
        }
        for change in batch.get("lifecycle") or []:
            if change.get("kind") != "renamed":
                continue
            previous = change.get("previousGlyphName")
            current = change.get("glyphName")
            if not previous or not current:
                continue
            for rules in existing.values():
                _rename(rules, previous, current)

        decomposed = set()
        for tag, rules in existing.items():
            for glyph, rhs in rules.items():
                if len(rhs) >= 2:
                    decomposed.add(glyph)
        for glyph in added:
            if glyph not in removed:
                decomposed.add(glyph)
        for glyph in removed:
            decomposed.discard(glyph)

        written: dict[str, list[str]] = {tag: [] for tag in ("isol", "init", "medi", "fina")}
        seen: dict[str, set[str]] = {tag: set() for tag in written}

        def emit(tag: str, glyph: str, rhs: list[str]) -> None:
            if glyph in seen[tag] or not rhs or glyph not in present:
                return
            if any(name not in present for name in rhs):
                return
            seen[tag].add(glyph)
            written[tag].append(f"sub {glyph} by {' '.join(rhs)};")

        for position, rules in existing.items():
            for glyph, rhs in rules.items():
                if glyph in removed or glyph not in present:
                    continue
                if all(name in present for name in rhs):
                    emit(position, glyph, rhs)

        for identity in sorted(self._characters):
            glyph = names.get(identity)
            if not glyph or glyph not in present or glyph in ccmp_inputs:
                continue
            record = self._characters[identity]
            is_decomposed = glyph in decomposed
            positions = ("isol",) + _POSITIONS if is_decomposed else _POSITIONS
            for position in positions:
                if position not in record["positions"] and position != "isol":
                    continue
                existing_rhs = existing.get(position, {}).get(glyph)
                if existing_rhs and glyph not in removed:
                    emit(position, glyph, existing_rhs)
                    continue
                intent_rhs = (added.get(glyph) or {}).get(position) if isinstance(added.get(glyph), dict) else None
                if intent_rhs:
                    missing = [name for name in intent_rhs if name not in present]
                    if missing:
                        diagnostics.append(
                            f"Missing {', '.join(missing)} for {identity} {position}."
                        )
                    else:
                        emit(position, glyph, list(intent_rhs))
                    continue
                sequence = record["positions"].get(position)
                if sequence is None:
                    continue
                if len(sequence) == 1:
                    target = _resolve(sequence[0], names, present)
                    if target and target != glyph:
                        emit(position, glyph, [target])
                    elif target != glyph:
                        diagnostics.append(f"Missing {sequence[0]} for {identity} {position}.")
                    continue
                if is_decomposed:
                    resolved = [_resolve(token, names, present) for token in sequence]
                    if all(resolved):
                        emit(position, glyph, resolved)  # type: ignore[arg-type]
                    else:
                        missing = [
                            token
                            for token, name in zip(sequence, resolved)
                            if not name
                        ]
                        diagnostics.append(
                            f"Missing {', '.join(missing)} for {identity} {position}."
                        )
                    continue
                form = _resolve(f"{identity}.{position}", names, present)
                if form:
                    emit(position, glyph, [form])
                elif position != "isol":
                    diagnostics.append(
                        f"Missing {identity}.{position} for {identity} {position}."
                    )

        for position in ("init", "medi"):
            for source, target in self._mark_variants.get(position, {}).items():
                source_name = source if source in present else None
                target_name = target if target in present else None
                if source_name and target_name:
                    emit(position, source_name, [target_name])

        blocks_out = [
            {"block": "forms", "tag": tag, "code": "\n".join(written[tag]), "placement": "first"}
            for tag in ("isol", "init", "medi", "fina")
        ]
        blocks_out.append(
            {
                "block": "required",
                "tag": "rlig",
                "code": self._rlig_code(glyphs, names, present),
                "placement": "first",
            }
        )
        return {"blocks": blocks_out, "diagnostics": diagnostics}

    def _rlig_code(
        self,
        glyphs: dict[str, Any],
        names: dict[str, str],
        present: set[str],
    ) -> str:
        lookups = []
        decompose_lines = []
        lam_init = names.get("uni0644.init")
        lam_medi = names.get("uni0644.medi")
        lam_class = [name for name in (lam_init, lam_medi) if name and name in present]
        for identity, parts in _alef_composites(glyphs, names):
            root = identity.split(".")[0]
            if root not in self._lam_alef_alefs:
                continue
            target = names.get(identity)
            components = [name for name in parts if name in present]
            if not target or target not in present or len(components) < 2 or not lam_class:
                continue
            group = " ".join(lam_class) if len(lam_class) == 1 else f"[{' '.join(lam_class)}]"
            decompose_lines.append(
                f"sub {group} {target}' by {' '.join(components)};"
            )
        if decompose_lines:
            lookups.append(_lookup("lam_alef_decompose", "IgnoreMarks", decompose_lines))

        ligature_lines = []
        for rule in self._rlig:
            inputs = [_resolve(token, names, present) for token in rule["inputs"]]
            output = rule["output"] if rule["output"] in present else names.get(rule["encodedOutput"])
            if output not in present or not all(inputs):
                continue
            ligature_lines.append(f"sub {' '.join(inputs)} by {output};")  # type: ignore[arg-type]
        if ligature_lines:
            lookups.append(_lookup("lam_alef", "IgnoreMarks", ligature_lines))

        mark_lines = []
        for glyph, components in _vowel_ligatures(glyphs):
            if glyph not in present or len(components) != 2:
                continue
            left = _resolve(components[0], names, present)
            right = _resolve(components[1], names, present)
            if not left or not right:
                continue
            mark_lines.append(f"sub {left} {right} by {glyph};")
            mark_lines.append(f"sub {right} {left} by {glyph};")
        if mark_lines:
            lookups.append(_lookup("mark_ligatures", "0", mark_lines))
        return "\n".join(lookups)


def _resolve(token: str, names: dict[str, str], present: set[str]) -> str | None:
    if token.startswith("uni"):
        name = names.get(token)
        return name if name in present else None
    return token if token in present else None


def _parse(code: str) -> dict[str, list[str]]:
    rules: dict[str, list[str]] = {}
    for line in code.splitlines():
        match = _RULE.match(line)
        if match:
            rules[match.group(1)] = match.group(2).split()
    return rules


def _rename(rules: dict[str, list[str]], previous: str, current: str) -> None:
    if previous in rules:
        rules[current] = [
            current if name == previous else name for name in rules.pop(previous)
        ]
    for glyph, components in list(rules.items()):
        rules[glyph] = [current if name == previous else name for name in components]


def _lookup(name: str, flag: str, lines: list[str]) -> str:
    body = "\n".join(f"  {line}" for line in lines)
    return f"lookup {name} {{\n  lookupflag {flag};\n{body}\n}} {name};"


def _index(font: Any) -> dict[str, Any]:
    glyphs: dict[str, Any] = {}
    values = getattr(font, "glyphs", None) if font is not None else None
    for glyph in list(values or []):
        name = getattr(glyph, "name", None)
        if isinstance(name, str) and name and name not in glyphs:
            glyphs[name] = glyph
    return glyphs


def _identity_names(glyphs: dict[str, Any]) -> dict[str, str]:
    names: dict[str, str] = {}
    for name, glyph in glyphs.items():
        keyed = _glyph_identity(name, glyphs)
        if keyed:
            _prefer(names, keyed[0], name)
            continue
        codepoint = _first_codepoint(glyph)
        if codepoint is None:
            continue
        _prefer(names, _uni(codepoint) + _suffix(name), name)
    return names


def _glyph_identity(name: str, glyphs: dict[str, Any]) -> tuple[str, int] | None:
    root, suffix = _split(name)
    root_glyph = glyphs.get(root)
    if root_glyph is None:
        return None
    codepoint = _first_codepoint(root_glyph)
    if codepoint is None:
        return None
    return _uni(codepoint) + suffix, codepoint


def _prefer(names: dict[str, str], identity: str, candidate: str) -> None:
    current = names.get(identity)
    if not current:
        names[identity] = candidate
        return
    candidate_is_identity = candidate == identity
    current_is_identity = current == identity
    if candidate_is_identity != current_is_identity:
        if current_is_identity:
            names[identity] = candidate
        return
    if candidate < current:
        names[identity] = candidate


def _ccmp_inputs(font: Any) -> set[str]:
    features = getattr(font, "features", None) if font is not None else None
    for entry in list(getattr(features, "features", None) or []):
        tag = entry[0]
        code = entry[1]
        if str(tag) != "ccmp":
            continue
        stamp = _field(_field(code, "format_specific"), "com.counterpunch.generator")
        if _text(_field(stamp, "generator")) != _CCMP:
            continue
        if _text(_field(stamp, "block")) != "decomposition":
            continue
        if _field(code, "automatic") is False:
            continue
        return {glyph for glyph, _rhs in _parse(_text(_field(code, "code"))).items()}
    return set()


def _vowel_ligatures(glyphs: dict[str, Any]) -> list[tuple[str, tuple[str, str]]]:
    found = []
    for name, glyph in glyphs.items():
        if _first_codepoint(glyph) is not None or not name:
            continue
        components = _component_names(glyph)
        if len(components) != 2:
            continue
        identities = [_glyph_identity(component, glyphs) for component in components]
        if any(item is None or item[1] not in _VOWELS for item in identities):
            continue
        found.append((name, (identities[0][0], identities[1][0])))  # type: ignore[index]
    return found


def _alef_composites(
    glyphs: dict[str, Any], names: dict[str, str]
) -> list[tuple[str, list[str]]]:
    found = []
    for root in _ALEF:
        identity = f"{root}.fina"
        glyph = glyphs.get(names.get(identity) or "")
        components = _component_names(glyph) if glyph is not None else []
        if len(components) >= 2:
            found.append((identity, components))
    return found


def _component_names(glyph: Any) -> list[str]:
    for layer in list(getattr(glyph, "layers", None) or []):
        if _field(layer, "is_background"):
            continue
        names = []
        for component in list(_field(layer, "components") or []):
            reference = _field(component, "reference")
            if isinstance(reference, str) and reference:
                names.append(reference)
        return names
    return []


def _split(name: str) -> tuple[str, str]:
    if name.startswith("."):
        return name, ""
    dot = name.find(".")
    if dot <= 0:
        return name, ""
    return name[:dot], name[dot:]


def _suffix(name: str) -> str:
    return _split(name)[1]


def _uni(codepoint: int) -> str:
    if codepoint <= 0xFFFF:
        return f"uni{codepoint:04X}"
    return f"uni{codepoint:X}"


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
