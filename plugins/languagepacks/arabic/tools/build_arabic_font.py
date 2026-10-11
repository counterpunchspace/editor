#!/usr/bin/env python3
"""Build an Arabic composition Babelfont from Fustat Regular.

Chain letters are empty encoded shells. Their decompositions live in ``ccmp``.
Drawn skeletons, dots, and lam-alef keep Regular outlines and anchors. A
positional sequence that is only another glyph (Fustat's shape reuse, such as
``qafDotless-ar`` initial using ``fehDotless-ar.init``) is an ``init``,
``medi``, or ``fina`` substitution and is not its own glyph. A form Fustat
draws, including ``noonGhunna-ar.fina``, keeps that outline. Encoded glyphs
use glyph-data names so a new font can find those outlines. No axis or GPOS.

Run from the editor repo:
``python3 plugins/languagepacks/arabic/tools/build_arabic_font.py``.
"""

from __future__ import annotations

import gzip
import json
import math
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

from build_arabic_data import (  # noqa: E402
    FORM_OWNER,
    FUSTAT,
    GLYPH_DATA,
    OUTPUT,
    PACK_NAMES,
    build,
)

EDITOR = Path(__file__).resolve().parents[4]
FONT_OUTPUT = OUTPUT.parent / "arabic.babelfont"
REGULAR = "14EEE41F-D714-4243-A717-73445EE7DABA"
FORM_SUFFIXES = ("init", "medi", "fina")
NODE_TYPES = {
    "m": ("Move", False),
    "ms": ("Move", True),
    "l": ("Line", False),
    "ls": ("Line", True),
    "o": ("OffCurve", False),
    "os": ("OffCurve", True),
    "c": ("Curve", False),
    "cs": ("Curve", True),
    "q": ("QCurve", False),
    "qs": ("QCurve", True),
}
INVERSE_PACK = {pack: fustat for fustat, pack in PACK_NAMES.items()}
INVERSE_FORM = {token: fustat for fustat, token in FORM_OWNER.items()}


def split_token(token: str) -> tuple[str, str]:
    if "." not in token:
        return token, ""
    root, suffix = token.rsplit(".", 1)
    if suffix in FORM_SUFFIXES:
        return root, suffix
    return token, ""


def parse_nodes(text: str) -> list[dict]:
    parts = text.split()
    if len(parts) % 3:
        raise ValueError(f"node string length is not a multiple of 3: {text[:80]}")
    nodes = []
    for index in range(0, len(parts), 3):
        kind = parts[index + 2]
        if kind not in NODE_TYPES:
            raise ValueError(f"unknown node type {kind}")
        nodetype, smooth = NODE_TYPES[kind]
        node: dict = {
            "x": float(parts[index]),
            "y": float(parts[index + 1]),
            "nodetype": nodetype,
        }
        if smooth:
            node["smooth"] = True
        nodes.append(node)
    return nodes


def regular_layer(glyph: dict) -> dict | None:
    for layer in glyph.get("layers") or []:
        master = layer.get("master") or {}
        if master.get("master") == REGULAR and master.get("type") == "DefaultForMaster":
            return layer
    return None


def layer_paths(layer: dict) -> list[dict]:
    paths = []
    for shape in layer.get("shapes") or []:
        nodes = shape.get("nodes")
        if isinstance(nodes, str) and nodes.strip():
            paths.append({"nodes": parse_nodes(nodes), "closed": bool(shape.get("closed", True))})
        elif isinstance(nodes, list) and nodes:
            paths.append({"nodes": nodes, "closed": bool(shape.get("closed", True))})
    return paths


def apply_glyphs_transform(x: float, y: float, transform: dict | None) -> tuple[float, float]:
    """Glyphs order: scale, then rotate, then skew, then translate."""
    if not transform:
        return x, y
    scale = transform.get("scale") or [1.0, 1.0]
    x *= float(scale[0] if len(scale) > 0 else 1)
    y *= float(scale[1] if len(scale) > 1 else 1)
    rotation = float(transform.get("rotation") or 0)
    if rotation:
        cosine = math.cos(rotation)
        sine = math.sin(rotation)
        x, y = cosine * x - sine * y, sine * x + cosine * y
    skew = transform.get("skew") or [0.0, 0.0]
    skew_x = float(skew[0] if len(skew) > 0 else 0)
    skew_y = float(skew[1] if len(skew) > 1 else 0)
    if skew_x or skew_y:
        x, y = x + skew_x * y, skew_y * x + y
    translation = transform.get("translation") or [0.0, 0.0]
    return x + float(translation[0]), y + float(translation[1])


def transform_paths(paths: list[dict], transform: dict | None) -> list[dict]:
    if not transform:
        return paths
    moved = []
    for path in paths:
        nodes = []
        for node in path["nodes"]:
            x, y = apply_glyphs_transform(node["x"], node["y"], transform)
            copy = dict(node)
            copy["x"] = x
            copy["y"] = y
            nodes.append(copy)
        moved.append({"nodes": nodes, "closed": path["closed"]})
    return moved


def layer_anchors(layer: dict) -> list[dict]:
    anchors = []
    seen = set()
    for anchor in layer.get("anchors") or []:
        name = anchor.get("name")
        if not name or name in seen:
            continue
        seen.add(name)
        anchors.append(
            {"name": name, "x": float(anchor.get("x") or 0), "y": float(anchor.get("y") or 0)}
        )
    return anchors


class FontBuilder:
    def __init__(self, fustat: dict, data: dict) -> None:
        self.fustat = {glyph["name"]: glyph for glyph in fustat["glyphs"]}
        self.by_codepoint: dict[int, str] = {}
        for name, glyph in self.fustat.items():
            codepoints = glyph.get("codepoints") or []
            if len(codepoints) == 1:
                self.by_codepoint[int(codepoints[0])] = name
        self.data = data
        self.glyphs: dict[str, dict] = {}
        self.ccmp: list[tuple[str, list[str]]] = []
        self.reuse: dict[str, list[tuple[str, str]]] = {
            "init": [],
            "medi": [],
            "fina": [],
        }
        self.glyph_names, self.cp_by_name = load_glyph_names()
        for fustat_name, glyph in self.fustat.items():
            codepoints = glyph.get("codepoints") or []
            if len(codepoints) == 1 and fustat_name not in self.cp_by_name:
                self.cp_by_name[fustat_name] = int(codepoints[0])
        self.regular_metrics = {}
        for master in fustat.get("masters") or []:
            if master.get("id") == REGULAR:
                self.regular_metrics = {
                    key: value
                    for key, value in (master.get("metrics") or {}).items()
                    if not str(key).endswith("overshoot")
                }
                break

    def pack_name(self, token: str) -> str:
        root, suffix = split_token(token)
        if root.startswith("uni"):
            codepoint = int(root[3:], 16)
            base = self.glyph_names.get(codepoint) or self.by_codepoint.get(codepoint)
            if base is None:
                raise KeyError(f"no glyph name for {token}")
            return base + (f".{suffix}" if suffix else "")
        return token

    def fustat_name(self, token: str) -> str | None:
        if token in INVERSE_FORM:
            return INVERSE_FORM[token]
        root, suffix = split_token(token)
        codepoint = None
        if root.startswith("uni"):
            codepoint = int(root[3:], 16)
        else:
            codepoint = self.cp_by_name.get(root)
        if codepoint is not None:
            identity = f"uni{codepoint:04X}" + (f".{suffix}" if suffix else "")
            if identity in INVERSE_FORM:
                return INVERSE_FORM[identity]
            base = self.by_codepoint.get(codepoint)
            if base is None:
                return None
            candidate = base + (f".{suffix}" if suffix else "")
        else:
            base = INVERSE_PACK.get(root, root)
            candidate = base + (f".{suffix}" if suffix else "")
        if candidate in self.fustat:
            return candidate
        return None

    def add(
        self,
        name: str,
        *,
        codepoints: list[int] | None = None,
        category: str = "Base",
        width: float = 600,
        paths: list[dict] | None = None,
        components: list[str] | None = None,
        anchors: list[dict] | None = None,
    ) -> None:
        if name in self.glyphs:
            return
        shapes: list[dict] = []
        for path in paths or []:
            shapes.append({"nodes": path["nodes"], "closed": path["closed"]})
        for reference in components or []:
            shapes.append({"reference": reference})
        self.glyphs[name] = {
            "name": name,
            "category": category,
            "codepoints": list(codepoints or []),
            "exported": True,
            "layers": [
                {
                    "width": width,
                    "id": f"{name}-Regular",
                    "master": {"type": "DefaultForMaster", "master": "Regular"},
                    "shapes": shapes,
                    "anchors": anchors or [],
                    "guides": [],
                    "format_specific": {},
                }
            ],
            "format_specific": {},
        }

    def stamp_positions(self, name: str, record: dict) -> None:
        glyph = self.glyphs.get(name)
        if glyph is None:
            return
        specific = glyph.setdefault("format_specific", {})
        specific["positions"] = list(record["positions"])

    def flatten(self, fustat_name: str, stack: frozenset[str] = frozenset()) -> list[dict]:
        if fustat_name in stack:
            return []
        glyph = self.fustat.get(fustat_name)
        layer = regular_layer(glyph) if glyph else None
        if layer is None:
            return []
        paths: list[dict] = []
        nested = stack | {fustat_name}
        for shape in layer.get("shapes") or []:
            if shape.get("nodes"):
                parsed = layer_paths({"shapes": [shape]})
                paths.extend(transform_paths(parsed, shape.get("transform")))
            elif shape.get("reference"):
                child = self.flatten(shape["reference"], nested)
                paths.extend(transform_paths(child, shape.get("transform")))
        return paths

    def drawing(self, token: str) -> tuple[float, list[dict], list[dict]]:
        source_name = self.fustat_name(token)
        glyph = self.fustat.get(source_name or "")
        layer = regular_layer(glyph) if glyph else None
        if layer is None:
            return 600, [], []
        paths = layer_paths(layer)
        if not paths and source_name:
            paths = self.flatten(source_name)
        return float(layer.get("width") or 0), paths, layer_anchors(layer)

    def build(self) -> dict:
        characters = self.data["characters"]
        unencoded = self.data["unencoded"]
        drawn = drawn_tokens(characters, unencoded)
        chain = {
            identity
            for identity, record in characters.items()
            if record.get("decompose")
        }

        for token in sorted(drawn):
            if token in chain:
                continue
            width, paths, anchors = self.drawing(token)
            codepoints = codepoints_of(token)
            root, _suffix = split_token(token)
            entry = unencoded.get(root if root in unencoded else token)
            category = "Mark" if entry and entry.get("category") == "Mark" else "Base"
            if not paths and not anchors and codepoints and unicodedata_mark(codepoints[0]):
                category = "Mark"
            self.add(
                self.pack_name(token),
                codepoints=codepoints,
                category=category,
                width=width,
                paths=paths,
                anchors=anchors,
            )

        for identity, record in characters.items():
            name = self.pack_name(identity)
            codepoints = codepoints_of(identity)
            if record.get("decompose"):
                width, _paths, _anchors = self.drawing(identity)
                self.add(name, codepoints=codepoints, width=width or 600)
                self.ccmp.append(
                    (name, [self.pack_name(token) for token in record["decompose"]])
                )
                self.stamp_positions(name, record)
                continue
            isol = record["positions"].get("isol") or [identity]
            if isol != [identity]:
                width, _paths, _anchors = self.drawing(identity)
                self.add(
                    name,
                    codepoints=codepoints,
                    width=width or 600,
                    components=[self.pack_name(token) for token in isol],
                )
            elif name not in self.glyphs:
                width, paths, anchors = self.drawing(identity)
                self.add(
                    name,
                    codepoints=codepoints,
                    width=width or 600,
                    paths=paths,
                    anchors=anchors,
                )
            self.stamp_positions(name, record)
            for position, sequence in record["positions"].items():
                if position == "isol" or not sequence:
                    continue
                form = f"{name}.{position}"
                if form in self.glyphs:
                    continue
                component_names = [self.pack_name(token) for token in sequence]
                if component_names == [form]:
                    width, paths, anchors = self.drawing(sequence[0])
                    self.add(form, width=width, paths=paths, anchors=anchors)
                    continue
                # One other glyph is Fustat's reuse (qafDotless init is
                # fehDotless init). The substitution is the recipe; an alias
                # glyph would be created empty in the user's font.
                if len(component_names) == 1:
                    self.reuse[position].append((name, component_names[0]))
                    continue
                self.add(
                    form,
                    width=self.drawing(identity)[0] or 600,
                    components=component_names,
                )

        for name, entry in unencoded.items():
            category = "Mark" if entry.get("category") == "Mark" else "Base"
            if name not in self.glyphs:
                width, paths, anchors = self.drawing(name)
                components = [self.pack_name(token) for token in entry.get("components") or []]
                self.add(
                    name,
                    category=category,
                    width=0 if category == "Mark" else width,
                    paths=paths if not components else [],
                    components=components,
                    anchors=anchors,
                )
            for position, sequence in (entry.get("positions") or {}).items():
                form = f"{name}.{position}"
                if form in self.glyphs or not sequence:
                    continue
                drawn = self.drawing(form)
                self.add(
                    form,
                    category=category,
                    width=drawn[0],
                    paths=drawn[1],
                    anchors=drawn[2],
                )
        self.ensure_referenced()
        return self.document()

    def ensure_referenced(self) -> None:
        pending = True
        while pending:
            pending = False
            for glyph in list(self.glyphs.values()):
                for shape in glyph["layers"][0]["shapes"]:
                    reference = shape.get("reference")
                    if not reference or reference in self.glyphs or reference == glyph["name"]:
                        continue
                    source_name = self.fustat_name(reference) or reference
                    source = self.fustat.get(source_name)
                    codepoints = []
                    if source and len(source.get("codepoints") or []) == 1:
                        codepoints = [int(source["codepoints"][0])]
                    elif reference in self.cp_by_name:
                        codepoints = [self.cp_by_name[reference]]
                    width, paths, anchors = self.drawing_named(reference)
                    category = (
                        "Mark"
                        if codepoints and unicodedata_mark(codepoints[0])
                        else "Base"
                    )
                    self.add(
                        reference,
                        codepoints=codepoints,
                        category=category,
                        width=width,
                        paths=paths,
                        anchors=anchors,
                    )
                    pending = True

    def drawing_named(self, fustat_or_pack: str) -> tuple[float, list[dict], list[dict]]:
        source_name = self.fustat_name(fustat_or_pack) or fustat_or_pack
        glyph = self.fustat.get(source_name)
        layer = regular_layer(glyph) if glyph else None
        if layer is None:
            return 600, [], []
        paths = layer_paths(layer) or self.flatten(source_name)
        return float(layer.get("width") or 0), paths, layer_anchors(layer)

    def document(self) -> dict:
        lines = [
            f"sub {glyph} by {' '.join(components)};"
            for glyph, components in sorted(self.ccmp)
        ]
        features = [["ccmp", {"code": "\n".join(lines), "automatic": False}]]
        for tag in ("init", "medi", "fina"):
            rules = [
                f"sub {glyph} by {target};"
                for glyph, target in sorted(set(self.reuse[tag]))
            ]
            if rules:
                features.append([tag, {"code": "\n".join(rules), "automatic": False}])
        return {
            "upm": 1000,
            "version": [1, 0],
            "axes": [],
            "instances": [],
            "masters": [
                {
                    "name": {"dflt": "Regular"},
                    "id": "Regular",
                    "location": {},
                    "guides": [],
                    "metrics": self.regular_metrics,
                    "kerning": {},
                    "custom_ot_values": {},
                    "format_specific": {},
                }
            ],
            "glyphs": [self.glyphs[name] for name in sorted(self.glyphs)],
            "note": "Arabic composition source. ccmp decompositions and example outlines for Counterpunch.",
            "date": "2026-10-11T00:00:00Z",
            "names": {"family_name": {"dflt": "Arabic Composition"}},
            "features": {
                "classes": {},
                "prefixes": {},
                "features": features,
            },
            "first_kern_groups": {},
            "second_kern_groups": {},
            "format_specific": {},
        }


def load_glyph_names() -> tuple[dict[int, str], dict[str, int]]:
    records = json.loads(gzip.open(GLYPH_DATA, "rt", encoding="utf-8").read())
    by_codepoint: dict[int, str] = {}
    by_name: dict[str, int] = {}
    for record in records:
        codepoint = int(record["codepoint"])
        name = str(record["glyph_name"])
        by_codepoint[codepoint] = name
        by_name[name] = codepoint
    return by_codepoint, by_name


def codepoints_of(token: str) -> list[int]:
    root, suffix = split_token(token)
    if suffix or not root.startswith("uni"):
        return []
    return [int(root[3:], 16)]


def unicodedata_mark(codepoint: int) -> bool:
    import unicodedata

    return unicodedata.category(chr(codepoint)).startswith("M")


def drawn_tokens(characters: dict, unencoded: dict) -> set[str]:
    drawn: set[str] = set()
    for identity, record in characters.items():
        positions = record["positions"]
        if record.get("decompose"):
            continue
        if positions.get("isol") == [identity] and all(
            len(sequence) == 1 for sequence in positions.values()
        ):
            drawn.add(identity)
            for sequence in positions.values():
                drawn.add(sequence[0])
    for name, entry in unencoded.items():
        if entry.get("components"):
            continue
        drawn.add(name)
        for sequence in (entry.get("positions") or {}).values():
            for token in sequence:
                drawn.add(token)
    for record in characters.values():
        for sequence in record["positions"].values():
            for token in sequence:
                root, _suffix = split_token(token)
                if root in unencoded or token in drawn:
                    drawn.add(token)
        for token in record.get("decompose") or []:
            root, _suffix = split_token(token)
            if not root.startswith("uni") or root in drawn or token in drawn:
                drawn.add(token)
            elif root not in characters:
                drawn.add(token)
    return drawn


def main() -> None:
    data = build(center_marks=False)
    fustat = json.loads(FUSTAT.read_text(encoding="utf-8"))
    font = FontBuilder(fustat, data).build()
    FONT_OUTPUT.write_text(json.dumps(font, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    charset = {"leaves": data["leaves"]}
    OUTPUT.write_text(json.dumps(charset, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    ccmp = font["features"]["features"][0][1]["code"]
    print(
        f"Wrote {FONT_OUTPUT.relative_to(EDITOR)} "
        f"({len(font['glyphs'])} glyphs, {ccmp.count(chr(10)) + 1 if ccmp else 0} ccmp rules)"
    )
    print(f"Wrote {OUTPUT.relative_to(EDITOR)} ({len(charset['leaves'])} character-set leaves)")


if __name__ == "__main__":
    main()
