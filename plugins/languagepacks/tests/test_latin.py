import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "latin"))

from counterpunch_latin.anchor_definitions import evaluate_expression, position_anchor
from counterpunch_latin.composition import LatinCompositionProvider
from counterpunch_latin.generator import LatinSmallCapsGenerator

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


class Glyph:
    def __init__(self, name, codepoints=None, script="Latin", category="Ll", lowercase=""):
        self.name = name
        self.codepoints = codepoints or []
        self.glyphData = {
            "script": script,
            "general_category": category,
            "lowercase": lowercase,
        }


class Font:
    def __init__(self, glyphs, prefixes=None):
        self.glyphs = glyphs
        self.features = type("Features", (), {"features": [], "prefixes": prefixes or {}})()


SMALLCAPS = LatinSmallCapsGenerator()


def _blocks(result):
    return {block["tag"]: block for block in result["blocks"]}


def test_smcp_substitutes_lowercase_when_small_cap_exists():
    result = SMALLCAPS.generate(
        {"lifecycle": [{"kind": "created", "glyphName": "a.sc"}], "changes": [], "intents": {}},
        Font(
            [
                Glyph("a-lat", [0x61], category="Ll"),
                Glyph("a-lat.sc", category="So"),
                Glyph("b-lat", [0x62], category="Ll"),
            ]
        ),
        {"managed_blocks": {}, "languagesystem_text": ""},
    )
    blocks = _blocks(result)
    assert blocks["smcp"]["code"] == "sub a-lat by a-lat.sc;"
    assert blocks["c2sc"]["code"] == ""


def test_c2sc_follows_unicode_lowercase_to_its_small_cap():
    result = SMALLCAPS.generate(
        {"lifecycle": [], "changes": [{"type": "glyph.unicode.changed"}], "intents": {}},
        Font(
            [
                Glyph("A-lat", [0x41], category="Lu", lowercase="0061"),
                Glyph("a-lat", [0x61], category="Ll"),
                Glyph("a-lat.sc"),
            ]
        ),
        {"managed_blocks": {}, "languagesystem_text": ""},
    )
    assert _blocks(result)["c2sc"]["code"] == "sub A-lat by a-lat.sc;"


def test_small_caps_skip_missing_multicode_and_non_latin():
    result = SMALLCAPS.generate(
        {"lifecycle": [], "changes": [], "intents": {}},
        Font(
            [
                Glyph("A-lat", [0x41], category="Lu", lowercase="0061"),
                Glyph("I.dot", [0x130], category="Lu", lowercase="0069 0307"),
                Glyph("a-cy", [0x430], script="Cyrillic", category="Ll"),
                Glyph("a-cy.sc"),
                Glyph("b-lat", [0x62], category="Ll"),
            ]
        ),
        {"managed_blocks": {}, "languagesystem_text": "languagesystem DFLT dflt;\nlanguagesystem latn dflt;"},
    )
    blocks = _blocks(result)
    assert blocks["smcp"]["code"] == ""
    assert blocks["c2sc"]["code"] == ""
    assert "languagesystems" not in blocks


def test_small_caps_clear_a_stale_line():
    result = SMALLCAPS.generate(
        {"lifecycle": [{"kind": "deleted", "glyphName": "a-lat.sc"}], "changes": [], "intents": {}},
        Font([Glyph("a-lat", [0x61], category="Ll")]),
        {"managed_blocks": {"smcp": "sub a-lat by a-lat.sc;"}, "languagesystem_text": ""},
    )
    assert _blocks(result)["smcp"]["code"] == ""
