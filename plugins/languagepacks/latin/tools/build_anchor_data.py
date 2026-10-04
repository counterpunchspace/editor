#!/usr/bin/env python3
"""Build Latin anchor-name data from the gfsources corpus and Unicode recipes.

Run locally. The committed ``anchors.json`` is what the editor ships; CI does
not need ``gfsources``.
"""

from __future__ import annotations

import gzip
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from counterpunch_latin.anchor_definitions import DEFINED_ANCHOR_NAMES
from counterpunch_latin.composition import LatinCompositionProvider

CORPUS = ROOT / "gfsources" / "results" / "qa_corpus.json"
GLYPH_DATA = ROOT / "editor" / "webapp" / "data" / "glyph-data.json.gz"
OUTPUT = (
    Path(__file__).resolve().parents[1]
    / "counterpunch_latin"
    / "data"
    / "anchors.json"
)
COMBINING_CLASS_FAMILY = {"230": "top", "220": "bottom", "1": "center", "202": "bottom"}


def load_records() -> dict[int, dict]:
    records = json.loads(gzip.open(GLYPH_DATA, "rt", encoding="utf-8").read())
    return {record["codepoint"]: record for record in records}


def eligible(record: dict | None) -> bool:
    if record is None:
        return False
    if record.get("script") == "Latin":
        return True
    category = record.get("general_category") or record.get("category") or ""
    return category.startswith("M") and "Combining Diacritical" in (
        record.get("block") or ""
    )


def corpus_names(corpus: dict, codepoint: int) -> list[str]:
    row = corpus.get(f"uni{codepoint:04X}")
    if not row:
        return []
    samples = row.get("n_mark_system") or 0
    if samples < 20:
        return []
    return [
        name
        for name, count in row.get("anchors", {}).items()
        if name in DEFINED_ANCHOR_NAMES and count / samples >= 0.5
    ]


def mark_family(corpus: dict, record: dict) -> str | None:
    names = corpus_names(corpus, record["codepoint"])
    incoming = [name[1:] for name in names if name.startswith("_")]
    if incoming:
        return incoming[0]
    return COMBINING_CLASS_FAMILY.get(str(record.get("combining_class") or ""))


def main() -> None:
    records = load_records()
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))["identities"]
    provider = LatinCompositionProvider.__new__(LatinCompositionProvider)
    provider._overrides = {}
    provider._anchors = {}

    chosen: dict[str, set[str]] = defaultdict(set)
    for codepoint, record in records.items():
        if not eligible(record):
            continue
        for name in corpus_names(corpus, codepoint):
            chosen[f"uni{codepoint:04X}"].add(name)

    for codepoint, record in records.items():
        if record.get("script") != "Latin":
            continue
        recipe = provider.recipe(codepoint, records.get)
        if recipe is None:
            continue
        families: list[str] = []
        for component in recipe["components"][1:]:
            mark = records.get(component["codepoint"])
            family = mark_family(corpus, mark) if mark else None
            if not family or family not in {name.lstrip("_") for name in DEFINED_ANCHOR_NAMES}:
                continue
            if family not in families:
                base = recipe["components"][0]["codepoint"]
                chosen[f"uni{base:04X}"].add(family)
            else:
                previous = families.index(family)
                # The mark before this one in the same family needs an outgoing anchor.
                earlier = [
                    item
                    for item in recipe["components"][1:]
                    if mark_family(corpus, records.get(item["codepoint"]) or {}) == family
                ]
                if len(earlier) >= 2:
                    target = earlier[-2]["codepoint"]
                    chosen[f"uni{target:04X}"].add(family)
            families.append(family)

    payload = {
        identity: sorted(names) for identity, names in sorted(chosen.items()) if names
    }
    OUTPUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(payload)} identities to {OUTPUT}")


if __name__ == "__main__":
    main()
