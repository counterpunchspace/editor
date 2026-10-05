#!/usr/bin/env python3
"""Build Arabic pack data from Fustat, then drop Fustat's glyph names.

The output is identities (``uniXXXX`` plus an optional positional suffix) and
pack names for unencoded i'jam. Improvements over Fustat, applied here:

- Nested composites are flattened. A letter does not stay as a component of
  another letter; dad-with-dot-below expands through dad.
- ccmp sequences and positional sequences use the same mark order: below,
  then center, then above.
- A positional form is the skeleton's identity plus ``.init``, ``.medi`` or
  ``.fina``. Fustat draws keheh's initial and medial on ``kaf-ar.init`` and
  ``kaf-ar.medi``, so those identities are ``uni06A9.init`` and ``uni06A9.medi``.
- Fustat's isolated mapping of ``uni06D5`` (ae) onto heh goal is dropped.
  Teh marbuta final still uses ``uni0647.fina``, and Farsi yeh isolated and
  final still use alef maksura.
- ``.high``, ``.short`` and ``.alt`` are not used. A kept rule that references
  ``.alt`` is an error.

Run from the editor repo: ``python3 plugins/languagepacks/arabic/tools/build_arabic_data.py``.
"""

from __future__ import annotations

import gzip
import json
import re
import unicodedata
from pathlib import Path

EDITOR = Path(__file__).resolve().parents[4]
FUSTAT = (
    EDITOR.parent
    / "gfsources"
    / "babelfont"
    / "ofl"
    / "fustat"
    / "sources"
    / "Fustat.babelfont"
)
GLYPH_DATA = EDITOR / "webapp" / "data" / "glyph-data.json.gz"
OUTPUT = (
    EDITOR
    / "plugins"
    / "languagepacks"
    / "arabic"
    / "counterpunch_arabic"
    / "data"
    / "arabic.json"
)

# Fustat glyph -> pack name. Encoded marks are identities, not pack names.
PACK_NAMES = {
    "dotabove-ar": "dotAbove-ar",
    "twodotshorizontalabove-ar": "twoDotsHorizontalAbove-ar",
    "twodotsverticalabove-ar": "twoDotsVerticalAbove-ar",
    "threedotsupabove-ar": "threeDotsUpAbove-ar",
    "threedotsdownabove-ar": "threeDotsDownAbove-ar",
    "fourdotsabove-ar": "fourDotsAbove-ar",
    "commaabove-ar": "commaAbove-ar",
    "tahabove-ar": "tahAbove-ar",
    "wasla-ar": "wasla-ar",
    "dotbelow-ar": "dotBelow-ar",
    "twodotshorizontalbelow-ar": "twoDotsHorizontalBelow-ar",
    "twodotsverticalbelow-ar": "twoDotsVerticalBelow-ar",
    "threedotsupbelow-ar": "threeDotsUpBelow-ar",
    "threedotsdownbelow-ar": "threeDotsDownBelow-ar",
    "fourdotsbelow-ar": "fourDotsBelow-ar",
    "vbelow-ar": "vBelow-ar",
    "vinvertedbelow-ar": "vInvertedBelow-ar",
    "ring-ar": "ringBelow-ar",
    "doubleverticalbarbelow-ar": "twoVerticalBarsBelow-ar",
    "tahbelow-ar": "tahBelow-ar",
    "dotcenter-ar": "dotCenter-ar",
    "twodotshorizontalcenter-ar": "twoDotsHorizontalCenter-ar",
    "twodotsverticalcenter-ar": "twoDotsVerticalCenter-ar",
    "threedotsupcenter-ar": "threeDotsUpCenter-ar",
    "threedotsdowncenter-ar": "threeDotsDownCenter-ar",
    "fourdotscenter-ar": "fourDotsCenter-ar",
    "vinvertedcenter-ar": "vInvertedCenter-ar",
    "tahcenter-ar": "tahCenter-ar",
    "ringbelow-ar": "ringCenter-ar",
    "gafsarkashabove-ar": "gafSarkash-ar",
    "gafsarkashcenter-ar": "gafSarkashCenter-ar",
    "miniKeheh-ar": "miniKeheh-ar",
    "hehgoalMark-ar": "hehGoalMark-ar",
    "tail-ar": "tail-ar",
    "kafDotless-ar": "kafDotless-ar",
    "lam_alef-ar": "lam_alef-ar",
}

# Drawn on the keheh skeleton, despite the kaf name.
FORM_OWNER = {
    "kaf-ar.init": "uni06A9.init",
    "kaf-ar.medi": "uni06A9.medi",
}

MARK_CODEPOINTS = list(range(0x064B, 0x0656)) + [0x065A, 0x065B, 0x0670]
MARK_LIGATURES = [
    ("shaddaFatha-ar", ["uni0651", "uni064E"]),
    ("shaddaDamma-ar", ["uni0651", "uni064F"]),
    ("shaddaKasra-ar", ["uni0651", "uni0650"]),
    ("shaddaFathatan-ar", ["uni0651", "uni064B"]),
    ("shaddaDammatan-ar", ["uni0651", "uni064C"]),
    ("shaddaKasratan-ar", ["uni0651", "uni064D"]),
    ("shaddaAlefAbove-ar", ["uni0651", "uni0670"]),
]
POSITIONS = ("isol", "init", "medi", "fina")
JOINING_POSITIONS = {"D": POSITIONS, "R": ("isol", "fina"), "U": ("isol",)}


class UnmappedMark(RuntimeError):
    pass


def uni_label(codepoint: int) -> str:
    if codepoint <= 0xFFFF:
        return f"uni{codepoint:04X}"
    return f"uni{codepoint:X}"


def load_glyph_data() -> dict[int, dict]:
    records = json.loads(gzip.open(GLYPH_DATA, "rt", encoding="utf-8").read())
    return {record["codepoint"]: record for record in records}


def strip_comments(code: str) -> str:
    return re.sub(r"#[^\n]*", "", code)


def parse_classes(raw: dict) -> dict[str, list[str]]:
    classes = {}
    for name, body in raw.items():
        text = body.get("code") if isinstance(body, dict) else str(body)
        classes[name] = strip_comments(text).split()
    return classes


def parse_substitutions(code: str) -> dict[str, list[str]]:
    """Single and class substitutions. The last rule for a glyph wins."""
    rules: dict[str, list[str]] = {}
    text = strip_comments(code)
    for match in re.finditer(r"sub\s+(.+?)\s+by\s+(.+?)\s*;", text, re.S):
        lhs = match.group(1).strip()
        rhs = match.group(2).split()
        if any(".alt" in name or ".high" in name or ".short" in name for name in rhs):
            raise UnmappedMark(f"kept rule references a variant: {lhs} -> {rhs}")
        if lhs.startswith("[") and lhs.endswith("]"):
            targets = lhs[1:-1].split()
        elif lhs.startswith("@"):
            continue
        else:
            targets = [lhs]
        for target in targets:
            rules[target] = rhs
    return rules


def class_pairs(code: str, classes: dict[str, list[str]]) -> dict[str, str]:
    text = strip_comments(code)
    match = re.search(r"sub\s+@(\w+)\s+by\s+@(\w+)\s*;", text)
    if not match:
        return {}
    left = classes[match.group(1)]
    right = classes[match.group(2)]
    if len(left) != len(right):
        raise UnmappedMark("center mark classes differ in length")
    return dict(zip(left, right))


def anchors_of(glyph: dict) -> list[str]:
    names: list[str] = []
    for layer in glyph.get("layers") or []:
        for anchor in layer.get("anchors") or []:
            name = anchor.get("name") if isinstance(anchor, dict) else None
            if name and name not in names:
                names.append(name)
    return names


def components_of(glyph: dict) -> list[str]:
    refs: list[str] = []
    for layer in glyph.get("layers") or []:
        for shape in layer.get("shapes") or []:
            reference = shape.get("reference") if isinstance(shape, dict) else None
            if reference and reference not in refs:
                refs.append(reference)
        if refs:
            break
    return refs


def build() -> dict:
    font = json.loads(FUSTAT.read_text(encoding="utf-8"))
    glyph_data = load_glyph_data()
    glyphs = {glyph["name"]: glyph for glyph in font["glyphs"]}
    features = dict(font["features"]["features"])
    classes = parse_classes(font["features"]["classes"])
    rules = {
        tag: parse_substitutions(features[tag]["code"])
        for tag in ("ccmp", "isol", "init", "medi", "fina")
    }
    # Isolated ae -> heh goal is a style choice, not a script fact.
    rules["isol"].pop("ae-ar", None)
    center = class_pairs(font["features"]["prefixes"]["Lookups"]["code"], classes)

    by_codepoint: dict[int, str] = {}
    for name, glyph in glyphs.items():
        codepoints = glyph.get("codepoints") or []
        if len(codepoints) == 1:
            by_codepoint[codepoints[0]] = name

    def expand_name(name: str, seen: set[str]) -> list[str]:
        if name in seen:
            raise UnmappedMark(f"cycle in {name}")
        if name in PACK_NAMES:
            return [PACK_NAMES[name]]
        if ".alt" in name or ".high" in name or ".short" in name:
            raise UnmappedMark(f"variant glyph {name} is not mapped")
        glyph = glyphs.get(name)
        if glyph is None:
            raise UnmappedMark(f"missing glyph {name}")
        codepoints = glyph.get("codepoints") or []
        if len(codepoints) == 1:
            return [uni_label(codepoints[0])]
        if name in FORM_OWNER:
            return [FORM_OWNER[name]]
        if name in PACK_NAMES and not components_of(glyph):
            return [PACK_NAMES[name]]
        if name in PACK_NAMES and name in {"kafDotless-ar", "lam_alef-ar"}:
            return [PACK_NAMES[name]]
        parts = components_of(glyph)
        if parts and name not in PACK_NAMES and "." not in name.split("-ar")[0]:
            # Combined mark, or an unencoded composite mark.
            if not (glyph.get("codepoints") or []) and _is_mark(glyph):
                seen.add(name)
                flat: list[str] = []
                for part in parts:
                    flat.extend(expand_name(part, seen))
                return flat
        root, dot, suffix = name.partition(".")
        if dot and root in glyphs and (glyphs[root].get("codepoints") or []):
            return [uni_label(glyphs[root]["codepoints"][0]) + "." + suffix]
        if dot and root in PACK_NAMES:
            return [PACK_NAMES[root] + "." + suffix]
        if name in PACK_NAMES:
            return [PACK_NAMES[name]]
        raise UnmappedMark(f"unmapped mark or form {name}")

    def _is_mark(glyph: dict) -> bool:
        category = glyph.get("category")
        if isinstance(category, dict):
            category = category.get("Custom")
        return category == "Mark"

    def shape(name: str, position: str) -> list[str]:
        sequence = [name]
        for _ in range(6):
            expanded = _apply(sequence, rules["ccmp"])
            expanded = _apply(expanded, rules[position])
            if position in {"init", "medi"}:
                expanded = [center.get(item, item) for item in expanded]
            if expanded == sequence:
                break
            sequence = expanded
        flat: list[str] = []
        for item in sequence:
            flat.extend(expand_name(item, set()))
        return _order_marks(flat)

    letters = []
    for codepoint, name in sorted(by_codepoint.items()):
        record = glyph_data.get(codepoint)
        if record is None:
            continue
        if record.get("script") != "Arabic" or record.get("general_category") != "Lo":
            continue
        joining = record.get("joining_type") or ""
        if joining not in JOINING_POSITIONS or codepoint >= 0xFB50:
            continue
        letters.append((codepoint, name, joining))

    characters: dict[str, dict] = {}
    for codepoint, name, joining in letters:
        identity = uni_label(codepoint)
        positions = {}
        for position in JOINING_POSITIONS[joining]:
            positions[position] = shape(name, position)
        characters[identity] = {"positions": positions}

    form_rules: dict[str, dict[str, str]] = {position: {} for position in POSITIONS}
    for identity, record in characters.items():
        for position, sequence in record["positions"].items():
            if len(sequence) == 1 and sequence[0] != identity:
                form_rules[position][identity] = sequence[0]

    for identity, record in characters.items():
        isol = record["positions"].get("isol")
        if not isol or isol == [identity]:
            continue
        if all(
            _apply_forms(isol, form_rules[position]) == sequence
            for position, sequence in record["positions"].items()
        ):
            record["decompose"] = isol

    unencoded: dict[str, dict] = {}
    anchors: dict[str, list[str]] = {}
    used_pack: set[str] = set()

    def note_anchor(token: str, fustat_name: str) -> None:
        glyph = glyphs.get(fustat_name)
        if glyph is None:
            return
        found = anchors_of(glyph)
        if found and token not in anchors:
            anchors[token] = found

    # Anchors for encoded identities and the fustat glyph that draws them.
    for name, glyph in glyphs.items():
        try:
            tokens = expand_name(name, set())
        except UnmappedMark:
            continue
        if len(tokens) == 1:
            note_anchor(tokens[0], name)

    for record in characters.values():
        for sequence in record["positions"].values():
            for token in sequence:
                if token.startswith("uni"):
                    continue
                root = token
                if token.rsplit(".", 1)[-1] in {"init", "medi", "fina"}:
                    root = token[: token.rfind(".")]
                used_pack.add(root)

    for pack_name in sorted(used_pack):
        fustat_name = next(
            (name for name, pack in PACK_NAMES.items() if pack == pack_name),
            None,
        )
        category = "Letter" if pack_name in {"kafDotless-ar", "lam_alef-ar"} else "Mark"
        entry: dict = {"category": category}
        if fustat_name and fustat_name in glyphs:
            found = anchors_of(glyphs[fustat_name])
            if found:
                entry["anchors"] = found
        positions = {}
        for suffix, position in (("init", "init"), ("medi", "medi"), ("fina", "fina")):
            form = f"{pack_name}.{suffix}"
            if any(
                form in sequence
                for record in characters.values()
                for sequence in record["positions"].values()
            ) or f"{fustat_name}.{suffix}" in glyphs:
                if category == "Letter":
                    positions[position] = [form]
        if positions:
            entry["positions"] = positions
        unencoded[pack_name] = entry

    # Lam-alef is drawn, not produced by letter decomposition.
    unencoded["lam_alef-ar"] = {
        "category": "Letter",
        "positions": {"fina": ["lam_alef-ar.fina"]},
        "anchors": anchors_of(glyphs["lam_alef-ar"]),
    }
    if "kafDotless-ar" in unencoded and "fina" not in unencoded["kafDotless-ar"].get(
        "positions", {}
    ):
        unencoded["kafDotless-ar"].setdefault("positions", {})["fina"] = [
            "kafDotless-ar.fina"
        ]

    for name, components in MARK_LIGATURES:
        unencoded[name] = {
            "category": "Mark",
            "components": components,
            "anchors": ["_top", "top"],
        }

    mark_variants = {"init": {}, "medi": {}}
    for source, target in center.items():
        source_tokens = expand_name(source, set())
        target_tokens = expand_name(target, set())
        if len(source_tokens) == 1 and len(target_tokens) == 1:
            mark_variants["init"][source_tokens[0]] = target_tokens[0]
            mark_variants["medi"][source_tokens[0]] = target_tokens[0]

    bases = []
    for identity, record in characters.items():
        if all(len(sequence) == 1 for sequence in record["positions"].values()):
            bases.append(identity)
    if "kafDotless-ar" not in unencoded:
        raise UnmappedMark("kafDotless-ar was not produced")

    leaves = _leaves(characters, bases, unencoded)
    data = {
        "characters": characters,
        "unencoded": unencoded,
        "markVariants": mark_variants,
        "anchors": {key: value for key, value in sorted(anchors.items()) if value},
        "rlig": [
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
        ],
        "lamAlefAlefs": ["uni0622", "uni0623", "uni0625", "uni0671"],
        "leaves": leaves,
    }
    return data


def _apply(sequence: list[str], rules: dict[str, list[str]]) -> list[str]:
    output: list[str] = []
    for name in sequence:
        output.extend(rules.get(name, [name]))
    return output


def _apply_forms(sequence: list[str], rules: dict[str, str]) -> list[str]:
    return [rules.get(token, token) for token in sequence]


def _order_marks(sequence: list[str]) -> list[str]:
    def band(token: str) -> int:
        if token.startswith("uni") and "." in token:
            return 0
        if token.startswith("uni"):
            codepoint = int(token[3:], 16)
            if unicodedata.category(chr(codepoint)).startswith("M"):
                combining = unicodedata.combining(chr(codepoint))
                if 0 < combining < 230:
                    return 1
                return 3
            return 0
        if token.split(".")[0] in {"kafDotless-ar", "lam_alef-ar"}:
            return 0
        if "Below" in token:
            return 1
        if "Center" in token:
            return 2
        if "Above" in token or token.startswith("gafSarkash"):
            return 3
        return 4

    return [token for _, token in sorted(enumerate(sequence), key=lambda item: (band(item[1]), item[0]))]


def _leaves(characters: dict, bases: list[str], unencoded: dict) -> list[dict]:
    def encoded(identity: str, level: str) -> dict:
        return {
            "codepoint": int(identity[3:], 16),
            "level": level,
            "level_rank": {"essential": 0, "recommended": 1, "optional": 2}[level],
        }

    def named(name: str, level: str) -> dict:
        entry = unencoded[name]
        item = {
            "glyph_name": name,
            "category": entry["category"],
            "level": level,
            "level_rank": {"essential": 0, "recommended": 1, "optional": 2}[level],
        }
        if entry.get("components"):
            item["components"] = entry["components"]
        return item

    dot_names = [
        name
        for name, entry in unencoded.items()
        if entry["category"] == "Mark" and "components" not in entry
    ]
    return [
        {
            "id": "bases",
            "label": "Bases",
            "level": "essential",
            "entries": [encoded(identity, "essential") for identity in bases]
            + [named("kafDotless-ar", "essential")],
        },
        {
            "id": "dots",
            "label": "Dots",
            "level": "essential",
            "entries": [named(name, "essential") for name in sorted(dot_names)],
        },
        {
            "id": "marks",
            "label": "Marks",
            "level": "essential",
            "entries": [encoded(uni_label(codepoint), "essential") for codepoint in MARK_CODEPOINTS],
        },
        {
            "id": "letters",
            "label": "Letters",
            "level": "essential",
            "entries": [
                encoded(identity, "essential") for identity in sorted(characters)
            ],
        },
        {
            "id": "ligatures",
            "label": "Ligatures",
            "level": "essential",
            "entries": [named("lam_alef-ar", "essential")],
        },
        {
            "id": "mark-ligatures",
            "label": "Mark ligatures",
            "level": "optional",
            "entries": [
                named(name, "optional") for name, _components in MARK_LIGATURES
            ],
        },
    ]


def main() -> None:
    data = build()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        f"Wrote {OUTPUT.relative_to(EDITOR)} "
        f"({len(data['characters'])} characters, {len(data['unencoded'])} unencoded)"
    )


if __name__ == "__main__":
    main()
