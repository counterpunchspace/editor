"""Languagesystem and aalt generators."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core"))

from counterpunch_features.generator import (
    AccessAllAlternatesGenerator,
    LanguageSystemGenerator,
)

LANGUAGES = LanguageSystemGenerator()
AALT = AccessAllAlternatesGenerator()
BATCH = {"lifecycle": [], "changes": [], "intents": {}}


class Glyph:
    def __init__(self, name, script):
        self.name = name
        self.glyphData = {"script": script}


class Font:
    def __init__(self, glyphs, features):
        self.glyphs = glyphs
        self.features = type("Features", (), {"features": features, "prefixes": {}})()


def _code(result, tag):
    return next(block["code"] for block in result["blocks"] if block["tag"] == tag)


def test_languagesystems_follow_glyph_scripts_in_feature_code():
    font = Font(
        [Glyph("a-lat", "Latin"), Glyph("a-lat.sc", "Latin"), Glyph("teh-ar", "Arabic")],
        [
            ["smcp", {"code": "sub a-lat by a-lat.sc;"}],
            ["fina", {"code": "sub teh-ar by teh-ar.fina;"}],
        ],
    )
    code = _code(LANGUAGES.generate(BATCH, font, {"languagesystem_text": ""}), "languagesystems")
    assert code.splitlines() == [
        "languagesystem DFLT dflt;",
        "languagesystem arab dflt;",
        "languagesystem latn dflt;",
    ]


def test_languagesystems_keep_explicit_script_language_and_skip_declared():
    font = Font(
        [],
        [["locl", {"code": "script latn;\nlanguage TRK;\nsub i by i.trk;"}]],
    )
    code = _code(
        LANGUAGES.generate(
            BATCH,
            font,
            {"languagesystem_text": "languagesystem DFLT dflt;\nlanguagesystem latn dflt;"},
        ),
        "languagesystems",
    )
    assert code == "languagesystem latn TRK;"


def test_languagesystems_clear_when_nothing_is_used():
    font = Font([], [])
    code = _code(LANGUAGES.generate(BATCH, font, {"languagesystem_text": ""}), "languagesystems")
    assert code == ""
    assert LANGUAGES.generate(BATCH, font, {})["blocks"][0]["placement"] == "prefix"


def test_aalt_references_every_other_feature_once():
    font = Font(
        [],
        [
            ["smcp", {"code": "sub a by a.sc;"}],
            ["c2sc", {"code": "sub A by a.sc;"}],
            ["smcp", {"code": "sub b by b.sc;"}],
            ["aalt", {"code": "feature kern;"}],
        ],
    )
    block = AALT.generate(BATCH, font, {})["blocks"][0]
    assert block["code"] == "feature smcp;\nfeature c2sc;"
    assert block["placement"] == "first"
    assert block["tag"] == "aalt"


def test_aalt_clears_when_it_is_the_only_feature():
    font = Font([], [["aalt", {"code": "feature kern;"}]])
    assert _code(AALT.generate(BATCH, font, {}), "aalt") == ""
