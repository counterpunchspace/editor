import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "latin"))

from counterpunch_latin.anchor_definitions import evaluate_expression, position_anchor
from counterpunch_latin.composition import LatinCompositionProvider

LOOKUP = {
    0xE4: {
        "script": "Latin",
        "general_category": "Ll",
        "decomposition": "0061 0308",
        "combining_class": "0",
    },
    0x61: {"script": "Latin", "general_category": "Ll", "decomposition": ""},
    0x308: {
        "script": "Inherited",
        "general_category": "Mn",
        "decomposition": "",
        "combining_class": "230",
    },
    0x1EAC: {
        "script": "Latin",
        "general_category": "Lu",
        "decomposition": "1EA0 0302",
    },
    0x1EA0: {
        "script": "Latin",
        "general_category": "Lu",
        "decomposition": "0041 0323",
    },
    0x41: {"script": "Latin", "general_category": "Lu", "decomposition": ""},
    0x323: {"script": "Inherited", "general_category": "Mn", "decomposition": ""},
    0x302: {"script": "Inherited", "general_category": "Mn", "decomposition": ""},
    0x13F: {
        "script": "Latin",
        "general_category": "Lu",
        "decomposition": "<compat> 004C 00B7",
    },
}


def lookup(codepoint):
    return LOOKUP.get(codepoint)


def test_recipe_flattens_canonical_decomposition():
    provider = LatinCompositionProvider()
    recipe = provider.recipe(0x1EAC, lookup)
    assert recipe["source"] == "unicode"
    assert [item["codepoint"] for item in recipe["components"]] == [0x41, 0x323, 0x302]
    assert [item["role"] for item in recipe["components"]] == ["base", "mark", "mark"]


def test_recipe_skips_compatibility_decomposition():
    assert LatinCompositionProvider().recipe(0x13F, lookup) is None


def test_override_replaces_unicode(tmp_path, monkeypatch):
    provider = LatinCompositionProvider()
    provider._overrides = {
        0xE4: [
            {"codepoint": 0x61, "role": "base"},
            {"codepoint": 0x308, "role": "mark"},
        ]
    }
    recipe = provider.recipe(0xE4, lookup)
    assert recipe["source"] == "override"
    assert recipe["components"][1]["codepoint"] == 0x308


def test_adieresis_anchor_names_come_from_components_not_composite():
    provider = LatinCompositionProvider()
    assert "top" in provider.anchors(0x61)
    assert provider.anchors(0xE4) == []
    assert "_top" in provider.anchors(0x308)


def test_expression_rejects_calls():
    try:
        evaluate_expression("__import__('os').system('x')", {})
    except (ValueError, SyntaxError):
        return
    raise AssertionError("call expressions must be rejected")


def test_empty_mark_uses_imaginary_band():
    point = position_anchor(
        "_top",
        "mark",
        {"xheight": 500, "capheight": 700, "ascender": 800, "descender": -200},
        300,
        None,
        "above",
    )
    assert point == (150, 500)
    outgoing = position_anchor(
        "top",
        "mark",
        {"xheight": 500, "capheight": 700, "ascender": 800, "descender": -200},
        300,
        None,
        "above",
    )
    assert outgoing[1] == 700


def test_ascender_uses_drawn_top():
    point = position_anchor(
        "top",
        "lower",
        {"xheight": 500, "capheight": 700, "ascender": 800, "descender": -200},
        400,
        (20, 0, 380, 780),
    )
    assert point[1] == 780
