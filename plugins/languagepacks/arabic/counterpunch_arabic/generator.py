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
_FORM_SUFFIX = {"init", "medi", "fina"}


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

    def needs_rebuild(self, batch: dict[str, Any], context: dict[str, Any]) -> bool:
        intent = (batch.get("intents") or {}).get("arabic") or {}
        if intent.get("add") or intent.get("remove"):
            return True
        if batch.get("lifecycle"):
            return True
        for change in batch.get("changes") or []:
            if change.get("type") == "glyph.unicode.changed":
                return True
        return False

    def generate(self, batch: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
        present = set(context.get("font_glyphs") or [])
        names = dict(context.get("identity_names") or {})
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

        ccmp_inputs = set(context.get("ccmp_inputs") or [])
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
                "code": self._rlig_code(context, names, present),
                "placement": "first",
            }
        )
        languages = _languagesystem_block(context.get("languagesystem_text") or "")
        if languages:
            blocks_out.append(
                {
                    "block": "languagesystems",
                    "tag": "languagesystems",
                    "code": languages,
                    "placement": "prefix",
                }
            )
        return {"blocks": blocks_out, "diagnostics": diagnostics}

    def _rlig_code(
        self,
        context: dict[str, Any],
        names: dict[str, str],
        present: set[str],
    ) -> str:
        lookups = []
        decompose_lines = []
        lam_init = names.get("uni0644.init")
        lam_medi = names.get("uni0644.medi")
        lam_class = [name for name in (lam_init, lam_medi) if name and name in present]
        for composite in context.get("alef_composites") or []:
            identity = composite.get("identity")
            if identity not in set(self._lam_alef_alefs) and not str(identity).endswith(".fina"):
                continue
            if not str(identity).startswith("uni") or not str(identity).endswith(".fina"):
                continue
            # Only alef variants listed in the pack.
            root = str(identity).split(".")[0]
            if root not in self._lam_alef_alefs:
                continue
            target = names.get(identity)
            components = [
                name for name in composite.get("components") or [] if name in present
            ]
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
        for ligature in context.get("vowel_ligatures") or []:
            glyph = ligature.get("glyph")
            components = ligature.get("components") or []
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


def _languagesystem_block(text: str) -> str:
    if "languagesystem" not in text:
        return ""
    if re.search(r"languagesystem\s+arab\b", text):
        return ""
    return "languagesystem arab dflt;"
