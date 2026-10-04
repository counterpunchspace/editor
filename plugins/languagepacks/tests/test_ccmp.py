import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core"))

from counterpunch_ccmp.generator import CcmpFeatureGenerator

GENERATOR = CcmpFeatureGenerator()


def test_generate_round_trip_and_intent():
    result = GENERATOR.generate(
        {
            "lifecycle": [],
            "changes": [],
            "intents": {"ccmp": {"add": ["aDiaeresis-lat"], "remove": []}},
        },
        {
            "managed_code": "",
            "font_glyphs": ["aDiaeresis-lat", "a-lat", "diaeresisCombining"],
            "recipes": {"aDiaeresis-lat": ["a-lat", "diaeresisCombining"]},
        },
    )
    code = result["blocks"][0]["code"]
    assert code == "sub aDiaeresis-lat by a-lat diaeresisCombining;"
    assert GENERATOR.read_inputs(code) == ["aDiaeresis-lat"]


def test_generate_drops_missing_component():
    result = GENERATOR.generate(
        {"lifecycle": [{"kind": "deleted", "glyphName": "diaeresisCombining"}]},
        {
            "managed_code": "sub aDiaeresis-lat by a-lat diaeresisCombining;",
            "font_glyphs": ["aDiaeresis-lat", "a-lat"],
            "recipes": {"aDiaeresis-lat": ["a-lat", "diaeresisCombining"]},
        },
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
            {"managed_inputs": [], "managed_components": []},
        )
        is True
    )


def test_needs_rebuild_skips_unrelated_glyph():
    assert GENERATOR.needs_rebuild(
        {"changes": [{"metadata": {"glyphName": "b-lat"}}], "lifecycle": []},
        {"managed_inputs": ["aDiaeresis-lat"], "managed_components": ["a-lat"]},
    ) is False


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
        {
            "managed_code": "sub aDiaeresis-lat by a-lat diaeresisCombining;",
            "font_glyphs": ["adieresis", "a-lat", "diaeresisCombining"],
            "recipes": {"adieresis": ["a-lat", "diaeresisCombining"]},
        },
    )
    assert "sub adieresis by a-lat diaeresisCombining;" in result["blocks"][0]["code"]
