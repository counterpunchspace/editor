"""Write isol/init/medi/fina form rules and required Arabic ligatures.

Tokens in the pack data are Unicode identities or pack glyph names. A production
name is substituted only while emitting a rule for this font.
"""

from __future__ import annotations

import re
from typing import Any

from counterpunch_arabic.conn_names import class_name, parse_conn_name
from counterpunch_arabic.font_source import ArabicFontSource

_RULE = re.compile(r"^\s*sub\s+(\S+)\s+by\s+(.+?)\s*;\s*$")
_LOOKUP_NAME = re.compile(r"\blookup\s+(\S+)\s*\{")
_POSITIONS = ("init", "medi", "fina")
_ALEF = ("uni0622", "uni0623", "uni0625", "uni0671")
_CCMP = "space.counterpunch.ccmp"


class ArabicFormsGenerator:
    generator_id = "space.counterpunch.arabic"
    capability = "feature:arabic:forms"
    representations = {"isol", "init", "medi", "fina", "rlig"}
    version = "1.0.0"
    EVENT_TYPES = ["glyph.unicode.changed"]
    INTENT_KEYS = ["arabic"]

    def __init__(self) -> None:
        source = ArabicFontSource()
        self._characters = source.characters
        self._mark_variants = source.mark_variants
        self._rlig = source.rlig
        self._mark_orders = source.mark_orders
        self._kasra_display = source.kasra_display
        self._lam_alef_alefs = source.lam_alef_alefs

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
        unmanaged = _unmanaged_feature_code(font, "rlig")
        blocks_out.append(
            {
                "block": "required",
                "tag": "rlig",
                "code": self._rlig_code(glyphs, names, present, unmanaged),
                "placement": "first",
            }
        )
        # Drop the earlier prefix. Its bare `sub shadda by fatha` lookups ran
        # outside one pair and turned the other mark into fatha.
        blocks_out.append(
            {
                "block": "mark_order",
                "tag": "rlig",
                "code": "",
                "placement": "prefix",
            }
        )
        connection_blocks, connection_classes = _connection_outputs(font, present)
        blocks_out.extend(connection_blocks)
        return {
            "blocks": blocks_out,
            "classes": connection_classes,
            "diagnostics": diagnostics,
        }

    def _rlig_code(
        self,
        glyphs: dict[str, Any],
        names: dict[str, str],
        present: set[str],
        existing: str = "",
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
        defined = _lookup_names(existing)
        if decompose_lines and "lam_alef_decompose" not in defined:
            lookups.append(_lookup("lam_alef_decompose", "IgnoreMarks", decompose_lines))

        ligature_lines = []
        for rule in self._rlig:
            inputs = [_resolve(token, names, present) for token in rule["inputs"]]
            output = rule["output"] if rule["output"] in present else names.get(rule["encodedOutput"])
            if output not in present or not all(inputs):
                continue
            ligature_lines.append(f"sub {' '.join(inputs)} by {output};")  # type: ignore[arg-type]
        if ligature_lines and "lam_alef" not in defined:
            lookups.append(_lookup("lam_alef", "IgnoreMarks", ligature_lines))

        if "mark_order" not in defined:
            lookups.extend(
                _mark_order_lookups(
                    self._mark_orders, self._kasra_display, names, present
                )
            )
        return "\n".join(lookups)


def _resolve(token: str, names: dict[str, str], present: set[str]) -> str | None:
    if token.startswith("uni"):
        name = names.get(token)
        return name if name in present else None
    return token if token in present else None


def _connection_outputs(font: Any, present: set[str]) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    grouped: dict[str, dict[int, list[tuple[str, str]]]] = {}
    for name in present:
        parsed = parse_conn_name(name)
        if parsed is None:
            continue
        source, conn_id, step = parsed
        if source not in present:
            continue
        grouped.setdefault(conn_id, {}).setdefault(step, []).append((source, name))
    complete = {
        conn_id
        for conn_id, steps in grouped.items()
        if steps.get(1) and steps.get(2)
    }
    blocks: list[dict[str, str]] = []
    classes: list[dict[str, str]] = []
    for conn_id in sorted(complete):
        block = f"conn_{conn_id}"
        pairs = {
            step: sorted(grouped[conn_id][step])
            for step in (1, 2)
        }
        blocks.append(
            {
                "block": block,
                "tag": "calt",
                "code": _lookup(
                    block,
                    "RightToLeft IgnoreMarks",
                    [
                        (
                            f"sub @{class_name(conn_id, 1, 'source')}' "
                            f"@{class_name(conn_id, 2, 'source')} "
                            f"by @{class_name(conn_id, 1, 'target')};"
                        ),
                        (
                            f"sub @{class_name(conn_id, 1, 'target')} "
                            f"@{class_name(conn_id, 2, 'source')}' "
                            f"by @{class_name(conn_id, 2, 'target')};"
                        ),
                    ],
                ),
                "placement": "first",
            }
        )
        for step in (1, 2):
            sources = [source for source, _target in pairs[step]]
            targets = [target for _source, target in pairs[step]]
            classes.append(
                {
                    "name": class_name(conn_id, step, "source"),
                    "code": " ".join(sources),
                    "block": block,
                }
            )
            classes.append(
                {
                    "name": class_name(conn_id, step, "target"),
                    "code": " ".join(targets),
                    "block": block,
                }
            )
    live_blocks = {item["block"] for item in blocks}
    for tag, block in _owned_connection_blocks(font):
        if block not in live_blocks:
            blocks.append({"block": block, "tag": tag, "code": ""})
    live_classes = {item["name"] for item in classes}
    for name, block in _owned_connection_classes(font):
        if name not in live_classes:
            classes.append({"name": name, "code": "", "block": block})
    return blocks, classes


def _owned_connection_blocks(font: Any) -> list[tuple[str, str]]:
    features = getattr(font, "features", None) if font is not None else None
    found = []
    for entry in list(getattr(features, "features", None) or []):
        code = entry[1]
        stamp = _field(_field(code, "format_specific"), "com.counterpunch.generator")
        if _text(_field(stamp, "generator")) != ArabicFormsGenerator.generator_id:
            continue
        block = _text(_field(stamp, "block"))
        if block.startswith("conn_"):
            found.append((str(entry[0]), block))
    return found


def _owned_connection_classes(font: Any) -> list[tuple[str, str]]:
    features = getattr(font, "features", None) if font is not None else None
    classes = getattr(features, "classes", None) or {}
    items = classes.items() if isinstance(classes, dict) else []
    found = []
    for name, code in items:
        stamp = _field(_field(code, "format_specific"), "com.counterpunch.generator")
        if _text(_field(stamp, "generator")) != ArabicFormsGenerator.generator_id:
            continue
        block = _text(_field(stamp, "block"))
        if block.startswith("conn_"):
            found.append((str(name), block))
    return found


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


def _lookup_names(code: str) -> set[str]:
    return set(_LOOKUP_NAME.findall(code))


def _unmanaged_feature_code(font: Any, tag: str) -> str:
    features = getattr(font, "features", None) if font is not None else None
    parts: list[str] = []
    for entry in list(getattr(features, "features", None) or []):
        if str(entry[0]) != tag:
            continue
        code = entry[1]
        stamp = _field(_field(code, "format_specific"), "com.counterpunch.generator")
        if _text(_field(stamp, "generator")) == ArabicFormsGenerator.generator_id:
            continue
        parts.append(_text(_field(code, "code")))
    return "\n".join(parts)


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


def _mark_order_lookups(
    orders: tuple[tuple[str, str], ...],
    kasra_display: dict[str, str],
    names: dict[str, str],
    present: set[str],
) -> list[str]:
    """Swap the opposite typing order into the ligature's component order.

    The ligature was stored as shadda then the other mark. Typing the other
    mark first is rewritten in two steps that stay inside this pair: the
    leading mark becomes shadda, then the trailing shadda becomes that mark.

    Kasra is the exception. It is drawn with the fatha glyph so both marks
    sit above the letter, with that glyph under the shadda. The combination
    is still read as a kasra. The second step is its own lookup so it sees
    the doubled shadda from the first step, including when shadda was typed
    first.
    """
    lookups: list[str] = []
    for index, (first, second) in enumerate(orders):
        canonical_first = _resolve(first, names, present)
        canonical_second = _resolve(second, names, present)
        if (
            not canonical_first
            or not canonical_second
            or canonical_first == canonical_second
        ):
            continue
        shown = _resolve(kasra_display.get(second, ""), names, present)
        if shown and shown != canonical_second:
            lookups.append(
                _lookup(
                    f"mark_order_{index}",
                    "0",
                    [
                        f"sub {canonical_second}' {canonical_first} by {canonical_first};",
                        f"sub {canonical_first} {canonical_second}' by {canonical_first};",
                    ],
                )
            )
            lookups.append(
                _lookup(
                    f"mark_order_{index}_shown",
                    "0",
                    [f"sub {canonical_first}' {canonical_first} by {shown};"],
                )
            )
            continue
        lookups.append(
            _lookup(
                f"mark_order_{index}",
                "0",
                [
                    f"sub {canonical_second}' {canonical_first} by {canonical_first};",
                    f"sub {canonical_first} {canonical_first}' by {canonical_second};",
                ],
            )
        )
    return lookups


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
