"""Load the bundled Arabic composition font and read ccmp recipes from it."""

from __future__ import annotations

import json
from importlib.resources import files
from typing import Any

_FORM_SUFFIXES = ("init", "medi", "fina")
_RLIG = [
    {
        "inputs": ["uni0644.init", "uni0627.fina"],
        "output": "lam_alef-ar",
        "encodedOutput": "uniFEFB",
        "ignoreMarks": True,
    },
    {
        "inputs": ["uni0644.medi", "uni0627.fina"],
        "output": "lam_alef-ar.fina",
        "encodedOutput": "uniFEFC",
        "ignoreMarks": True,
    },
]
_LAM_ALEF_ALEFS = ["uni0622", "uni0623", "uni0625", "uni0671"]
# Each pair is the order the two marks should keep. rlig swaps the opposite typing order.
MARK_ORDERS = (
    ("uni0651", "uni064E"),
    ("uni0651", "uni064F"),
    ("uni0651", "uni0650"),
    ("uni0651", "uni064B"),
    ("uni0651", "uni064C"),
    ("uni0651", "uni064D"),
    ("uni0651", "uni0670"),
)
# Kasra is drawn with the fatha glyph so the combination sits above the
# letter, under the shadda. The text is still read as a kasra.
KASRA_DISPLAY = {
    "uni0650": "uni064E",
    "uni064D": "uni064B",
}


def _uni(codepoint: int) -> str:
    if codepoint <= 0xFFFF:
        return f"uni{codepoint:04X}"
    return f"uni{codepoint:X}"


def _shift_paths(
    paths: list[dict[str, Any]], dx: float, dy: float
) -> list[dict[str, Any]]:
    if dx == 0 and dy == 0:
        return paths
    shifted = []
    for path in paths:
        nodes = []
        for node in path.get("nodes") or []:
            copied = dict(node)
            copied["x"] = float(node.get("x") or 0) + dx
            copied["y"] = float(node.get("y") or 0) + dy
            nodes.append(copied)
        shifted.append({"closed": path.get("closed", True), "nodes": nodes})
    return shifted


def _split(name: str) -> tuple[str, str]:
    if "." not in name:
        return name, ""
    root, suffix = name.rsplit(".", 1)
    if suffix in _FORM_SUFFIXES:
        return root, suffix
    return name, ""


def _load() -> dict[str, Any]:
    path = files("counterpunch_arabic").joinpath("data/arabic.babelfont")
    return json.loads(path.read_text(encoding="utf-8"))


class ArabicFontSource:
    def __init__(self) -> None:
        font = _load()
        self.upm = int(font.get("upm") or 1000)
        self.glyphs = {glyph["name"]: glyph for glyph in font.get("glyphs") or []}
        self.by_codepoint: dict[int, str] = {}
        for name, glyph in self.glyphs.items():
            codepoints = glyph.get("codepoints") or []
            if len(codepoints) == 1:
                self.by_codepoint[int(codepoints[0])] = name
        self.ccmp = _ccmp_rules(font)
        self.forms = _form_rules(font)
        self.characters = self._characters()
        self.unencoded = self._unencoded()
        self.rlig = _RLIG
        self.mark_orders = MARK_ORDERS
        self.kasra_display = KASRA_DISPLAY
        self.lam_alef_alefs = _LAM_ALEF_ALEFS
        self.mark_variants: dict[str, dict[str, str]] = {"init": {}, "medi": {}}

    def token_for(self, name: str) -> str:
        root, suffix = _split(name)
        glyph = self.glyphs.get(root)
        codepoints = (glyph or {}).get("codepoints") or []
        if len(codepoints) == 1:
            return _uni(int(codepoints[0])) + (f".{suffix}" if suffix else "")
        return name

    def name_for_token(self, token: str) -> str | None:
        root, suffix = _split(token)
        if root.startswith("uni"):
            try:
                codepoint = int(root[3:], 16)
            except ValueError:
                return None
            base = self.by_codepoint.get(codepoint)
            if base is None:
                return None
            name = base + (f".{suffix}" if suffix else "")
            return name if name in self.glyphs else None
        return token if token in self.glyphs else None

    def components(self, name: str) -> list[str]:
        glyph = self.glyphs.get(name)
        if glyph is None:
            return []
        for layer in glyph.get("layers") or []:
            refs = [
                shape.get("reference")
                for shape in layer.get("shapes") or []
                if shape.get("reference")
            ]
            if refs:
                return [ref for ref in refs if isinstance(ref, str)]
        return []

    def anchor_names(self, name: str) -> list[str]:
        glyph = self.glyphs.get(name)
        if glyph is None:
            return []
        names: list[str] = []
        for layer in glyph.get("layers") or []:
            for anchor in layer.get("anchors") or []:
                anchor_name = anchor.get("name")
                if anchor_name and anchor_name not in names:
                    names.append(anchor_name)
        return names

    def category(self, name: str) -> str:
        glyph = self.glyphs.get(name) or {}
        category = glyph.get("category")
        if isinstance(category, dict):
            category = next(iter(category.values()), "")
        return "Mark" if category == "Mark" else "Letter"

    def drawing(
        self, name: str, _depth: int = 0, _stack: frozenset[str] | None = None
    ) -> dict[str, Any] | None:
        if _depth > 5 or name in (_stack or frozenset()):
            return None
        glyph = self.glyphs.get(name)
        if glyph is None:
            return None
        layer = (glyph.get("layers") or [None])[0]
        if not isinstance(layer, dict):
            return None
        paths = []
        for shape in layer.get("shapes") or []:
            nodes = shape.get("nodes")
            if isinstance(nodes, list) and nodes:
                paths.append(
                    {"closed": bool(shape.get("closed", True)), "nodes": nodes}
                )
        anchors = [
            {
                "name": anchor.get("name"),
                "x": float(anchor.get("x") or 0),
                "y": float(anchor.get("y") or 0),
            }
            for anchor in layer.get("anchors") or []
            if anchor.get("name")
        ]
        if not paths:
            paths = self._placed_component_paths(
                layer.get("shapes") or [], _depth, (_stack or frozenset()) | {name}
            )
        if not paths and not anchors:
            return None
        return {
            "upm": self.upm,
            "width": float(layer.get("width") or 0),
            "paths": paths,
            "anchors": anchors,
        }

    def _placed_component_paths(
        self, shapes: list[Any], depth: int, stack: frozenset[str]
    ) -> list[dict[str, Any]]:
        """Stack component outlines, attaching `_top` to the previous `top`."""
        paths: list[dict[str, Any]] = []
        available: dict[str, tuple[float, float]] = {}
        for shape in shapes:
            if not isinstance(shape, dict):
                continue
            reference = shape.get("reference")
            if not isinstance(reference, str) or not reference:
                continue
            child = self.drawing(reference, depth + 1, stack)
            if child is None:
                continue
            child_anchors = {
                anchor["name"]: (anchor["x"], anchor["y"])
                for anchor in child.get("anchors") or []
            }
            dx, dy = 0.0, 0.0
            for anchor_name, (x, y) in child_anchors.items():
                if not anchor_name.startswith("_"):
                    continue
                base = available.get(anchor_name[1:])
                if base is None:
                    continue
                dx, dy = base[0] - x, base[1] - y
                break
            paths.extend(_shift_paths(child.get("paths") or [], dx, dy))
            for anchor_name, (x, y) in child_anchors.items():
                if anchor_name.startswith("_"):
                    continue
                available[anchor_name] = (x + dx, y + dy)
        return paths

    def drawings(self, names: list[str]) -> dict[str, Any]:
        found = {}
        for name in names:
            drawing = self.drawing(str(name))
            if drawing is not None:
                found[str(name)] = drawing
        return found

    def anchor_positions(self, requests: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows = []
        for request in requests:
            name = str(request.get("glyph_name") or "")
            drawing = self.drawing(name)
            if drawing is None and name not in self.glyphs:
                rows.append(
                    {
                        "glyph_name": name,
                        "master_id": request.get("master_id"),
                        "positions": {},
                        "known": False,
                    }
                )
                continue
            located = {
                anchor["name"]: [anchor["x"], anchor["y"]]
                for anchor in (drawing or {}).get("anchors") or []
            }
            if drawing is None:
                located = {
                    anchor_name: [0, 0]
                    for anchor_name in self.anchor_names(name)
                }
                for layer in (self.glyphs.get(name) or {}).get("layers") or []:
                    for anchor in layer.get("anchors") or []:
                        if anchor.get("name"):
                            located[anchor["name"]] = [
                                float(anchor.get("x") or 0),
                                float(anchor.get("y") or 0),
                            ]
            positions = {
                anchor_name: located[anchor_name]
                for anchor_name in request.get("names") or []
                if anchor_name in located
            }
            rows.append(
                {
                    "glyph_name": name,
                    "master_id": request.get("master_id"),
                    "positions": positions,
                    "known": True,
                }
            )
        return rows

    def _has_paths(self, name: str) -> bool:
        glyph = self.glyphs.get(name)
        if glyph is None:
            return False
        for layer in glyph.get("layers") or []:
            for shape in layer.get("shapes") or []:
                nodes = shape.get("nodes")
                if isinstance(nodes, list) and nodes:
                    return True
                if isinstance(nodes, str) and nodes.strip():
                    return True
        return False

    def _positional(self, name: str, position: str) -> list[str] | None:
        """The glyphs that draw ``name`` in ``position``.

        A one-glyph substitution is Fustat's shape reuse and wins over an
        alias form glyph. A drawn form, or a form with several components,
        is that glyph.
        """
        rule = self.forms.get(position, {}).get(name)
        form = f"{name}.{position}"
        refs = self.components(form) if form in self.glyphs else []
        if rule and (form not in self.glyphs or (len(refs) == 1 and not self._has_paths(form))):
            return list(rule)
        if form not in self.glyphs:
            return None
        if refs and not self._has_paths(form):
            return refs
        return [form]

    def _expand(self, components: list[str], position: str) -> list[str]:
        expanded = []
        for name in components:
            resolved = self._positional(name, position)
            expanded.extend(resolved if resolved else [name])
        return expanded

    def _characters(self) -> dict[str, dict[str, Any]]:
        characters: dict[str, dict[str, Any]] = {}
        for name, glyph in self.glyphs.items():
            codepoints = glyph.get("codepoints") or []
            if len(codepoints) != 1:
                continue
            identity = _uni(int(codepoints[0]))
            rule = self.ccmp.get(name)
            positions: dict[str, list[str]] = {}
            if rule:
                positions["isol"] = [self.token_for(part) for part in rule]
                wanted = self._wanted_positions(name)
                for position in _FORM_SUFFIXES:
                    if wanted is not None and position not in wanted:
                        continue
                    explicit = self._explicit_form(name, position)
                    if explicit is not None:
                        positions[position] = explicit
                        continue
                    expanded = self._expand(rule, position)
                    if expanded != rule:
                        positions[position] = [
                            self.token_for(part) for part in expanded
                        ]
            else:
                components = self.components(name)
                positions["isol"] = (
                    [self.token_for(part) for part in components]
                    if components
                    else [identity]
                )
                wanted = self._wanted_positions(name)
                for position in _FORM_SUFFIXES:
                    if wanted is not None and position not in wanted:
                        continue
                    resolved = self._positional(name, position)
                    if not resolved:
                        continue
                    positions[position] = [
                        self.token_for(part) for part in resolved
                    ]
            record: dict[str, Any] = {"positions": positions}
            if rule and self._chain(name, rule, positions):
                record["decompose"] = positions["isol"]
            characters[identity] = record
        return characters

    def _wanted_positions(self, name: str) -> list[str] | None:
        glyph = self.glyphs.get(name) or {}
        specific = glyph.get("format_specific") or {}
        positions = specific.get("positions")
        if not isinstance(positions, list):
            return None
        kept = [str(position) for position in positions if position in ("isol", *_FORM_SUFFIXES)]
        return kept or None

    def _explicit_form(self, name: str, position: str) -> list[str] | None:
        form = f"{name}.{position}"
        if form not in self.glyphs or self._has_paths(form):
            return None
        refs = self.components(form)
        if len(refs) < 2:
            return None
        return [self.token_for(part) for part in refs]

    def _chain(self, name: str, rule: list[str], positions: dict[str, list[str]]) -> bool:
        isol = positions.get("isol") or []
        if len(isol) < 2:
            return False
        wanted = self._wanted_positions(name)
        for position in _FORM_SUFFIXES:
            if wanted is not None and position not in wanted:
                continue
            if self._explicit_form(name, position) is not None:
                continue
            if position not in positions and wanted is None:
                continue
            expanded = [self.token_for(part) for part in self._expand(rule, position)]
            actual = positions.get(position, isol)
            if actual != expanded:
                return False
        return True

    def _unencoded(self) -> dict[str, dict[str, Any]]:
        unencoded: dict[str, dict[str, Any]] = {}
        for name, glyph in self.glyphs.items():
            if glyph.get("codepoints"):
                continue
            root, suffix = _split(name)
            root_glyph = self.glyphs.get(root)
            if suffix and root_glyph and root_glyph.get("codepoints"):
                continue
            if suffix:
                continue
            entry: dict[str, Any] = {"category": self.category(name)}
            components = self.components(name)
            if components:
                entry["components"] = [self.token_for(part) for part in components]
            anchors = self.anchor_names(name)
            if anchors:
                entry["anchors"] = anchors
            positions = {}
            for position in _FORM_SUFFIXES:
                form_name = f"{name}.{position}"
                if form_name not in self.glyphs:
                    continue
                form_components = self.components(form_name)
                if form_components:
                    positions[position] = [
                        self.token_for(part) for part in form_components
                    ]
                else:
                    positions[position] = [form_name]
            if positions:
                entry["positions"] = positions
            unencoded[name] = entry
        return unencoded


def _substitution_rules(font: dict[str, Any], tag: str) -> dict[str, list[str]]:
    rules: dict[str, list[str]] = {}
    for feature, body in (font.get("features") or {}).get("features") or []:
        if feature != tag:
            continue
        code = body.get("code") if isinstance(body, dict) else ""
        for line in str(code).splitlines():
            text = line.strip()
            if not text.startswith("sub ") or " by " not in text:
                continue
            lhs, rhs = text[4:].split(" by ", 1)
            target = lhs.strip()
            if " " in target:
                continue
            rules[target] = rhs.replace(";", "").split()
    return rules


def _ccmp_rules(font: dict[str, Any]) -> dict[str, list[str]]:
    return _substitution_rules(font, "ccmp")


def _form_rules(font: dict[str, Any]) -> dict[str, dict[str, list[str]]]:
    return {tag: _substitution_rules(font, tag) for tag in _FORM_SUFFIXES}
