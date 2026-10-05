import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "core"))
sys.path.insert(0, str(ROOT / "latin"))

from counterpunch_ccmp.generator import CcmpFeatureGenerator

GENERATOR = CcmpFeatureGenerator()


class Glyph:
    def __init__(self, name, codepoints=None, glyph_data=None):
        self.name = name
        self.codepoints = codepoints or []
        self.glyphData = glyph_data


class Font:
    def __init__(self, glyphs):
        self.glyphs = glyphs


ADIERESIS = {
    "script": "Latin",
    "general_category": "Ll",
    "decomposition": "0061 0308",
}
A = {"script": "Latin", "general_category": "Ll", "decomposition": ""}
DIAERESIS = {
    "script": "Inherited",
    "general_category": "Mn",
    "decomposition": "",
    "combining_class": "230",
}


def font(*glyphs):
    return Font(list(glyphs))


def composed():
    return font(
        Glyph("aDiaeresis-lat", [0xE4], ADIERESIS),
        Glyph("a-lat", [0x61], A),
        Glyph("diaeresisCombining", [0x308], DIAERESIS),
    )


def test_generate_round_trip_and_intent():
    result = GENERATOR.generate(
        {
            "lifecycle": [],
            "changes": [],
            "intents": {"ccmp": {"add": ["aDiaeresis-lat"], "remove": []}},
        },
        composed(),
        {"managed_blocks": {}},
    )
    code = result["blocks"][0]["code"]
    assert code == "sub aDiaeresis-lat by a-lat diaeresisCombining;"
    assert GENERATOR.read_inputs(code) == ["aDiaeresis-lat"]


def test_generate_drops_missing_component():
    result = GENERATOR.generate(
        {"lifecycle": [{"kind": "deleted", "glyphName": "diaeresisCombining"}]},
        font(
            Glyph("aDiaeresis-lat", [0xE4], ADIERESIS),
            Glyph("a-lat", [0x61], A),
        ),
        {"managed_blocks": {"ccmp": "sub aDiaeresis-lat by a-lat diaeresisCombining;"}},
    )
    assert result["blocks"][0]["code"] == ""
    assert result["diagnostics"]


def test_needs_rebuild_runs_for_intent_without_edits():
    assert (
        GENERATOR.needs_rebuild(
            {
                "changes": [],
                "lifecycle": [],
                "intents": {"ccmp": {"add": ["aDiaeresis-lat"], "remove": []}},
            },
            None,
            {"managed_blocks": {}},
        )
        is True
    )


def test_needs_rebuild_skips_unrelated_glyph():
    assert (
        GENERATOR.needs_rebuild(
            {"changes": [{"metadata": {"glyphName": "b-lat"}}], "lifecycle": []},
            None,
            {"managed_blocks": {"ccmp": "sub aDiaeresis-lat by a-lat diaeresisCombining;"}},
        )
        is False
    )


def test_existing_line_keeps_designer_components():
    result = GENERATOR.generate(
        {"lifecycle": [], "changes": [], "intents": {}},
        font(
            Glyph("aDiaeresis-lat", [0xE4], ADIERESIS),
            Glyph("a-lat", [0x61], A),
            Glyph("acutecomb.alt"),
            Glyph("diaeresisCombining", [0x308], DIAERESIS),
        ),
        {"managed_blocks": {"ccmp": "sub aDiaeresis-lat by a-lat acutecomb.alt;"}},
    )
    assert result["blocks"][0]["code"] == "sub aDiaeresis-lat by a-lat acutecomb.alt;"


def test_intent_components_override_recipe_for_new_rules():
    result = GENERATOR.generate(
        {
            "lifecycle": [],
            "changes": [],
            "intents": {
                "ccmp": {
                    "add": ["aDiaeresis-lat"],
                    "remove": [],
                    "components": {"aDiaeresis-lat": ["a-lat", "acutecomb.alt"]},
                }
            },
        },
        font(
            Glyph("aDiaeresis-lat", [0xE4], ADIERESIS),
            Glyph("a-lat", [0x61], A),
            Glyph("acutecomb.alt"),
            Glyph("diaeresisCombining", [0x308], DIAERESIS),
        ),
        {"managed_blocks": {}},
    )
    assert result["blocks"][0]["code"] == "sub aDiaeresis-lat by a-lat acutecomb.alt;"


def test_rename_follows_rule():
    result = GENERATOR.generate(
        {
            "lifecycle": [
                {
                    "kind": "renamed",
                    "glyphName": "adieresis",
                    "previousGlyphName": "aDiaeresis-lat",
                }
            ]
        },
        font(
            Glyph("adieresis", [0xE4], ADIERESIS),
            Glyph("a-lat", [0x61], A),
            Glyph("diaeresisCombining", [0x308], DIAERESIS),
        ),
        {"managed_blocks": {"ccmp": "sub aDiaeresis-lat by a-lat diaeresisCombining;"}},
    )
    assert "sub adieresis by a-lat diaeresisCombining;" in result["blocks"][0]["code"]
