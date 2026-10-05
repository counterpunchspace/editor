import gzip
import json
import sys
from pathlib import Path

import pytest

ARABIC = Path(__file__).resolve().parents[1] / "arabic"
sys.path.insert(0, str(ARABIC))
sys.path.insert(0, str(ARABIC / "tools"))

from build_arabic_data import UnmappedMark, parse_substitutions
from counterpunch_arabic.charset import ArabicCharacterSetProvider
from counterpunch_arabic.composition import ArabicCompositionProvider
from counterpunch_arabic.generator import ArabicFormsGenerator

DATA = json.loads(
    (ARABIC / "counterpunch_arabic" / "data" / "arabic.json").read_text(encoding="utf-8")
)
GENERATOR = ArabicFormsGenerator()
EDITOR = Path(__file__).resolve().parents[3]


def _tokens():
    for record in DATA["characters"].values():
        for sequence in record["positions"].values():
            yield from sequence
        yield from record.get("decompose") or []


def test_data_identities_and_pack_names():
    for token in _tokens():
        if token.startswith("uni"):
            codepoint = int(token.split(".")[0][3:], 16)
            assert not 0xFBB2 <= codepoint <= 0xFBC2
            assert token.split(".")[-1] in {token, "init", "medi", "fina"} or "." not in token
        else:
            root = token.rsplit(".", 1)[0] if token.rsplit(".", 1)[-1] in {"init", "medi", "fina"} else token
            assert root in DATA["unencoded"]
    dot_names = {entry["glyph_name"] for entry in DATA["leaves"][1]["entries"]}
    assert dot_names
    assert all("codepoint" not in entry for entry in DATA["leaves"][1]["entries"])
    assert "kafDotless-ar" in DATA["unencoded"]
    assert DATA["characters"]["uni062A"]["decompose"] == [
        "uni066E",
        "twoDotsHorizontalAbove-ar",
    ]
    assert "decompose" not in DATA["characters"]["uni06CC"]
    assert DATA["characters"]["uni0643"]["positions"]["init"] == ["uni06A9.init"]


def test_pack_names_do_not_collide_with_glyph_data():
    records = json.loads(
        gzip.open(EDITOR / "webapp" / "data" / "glyph-data.json.gz", "rt", encoding="utf-8").read()
    )
    glyph_names = {record["glyph_name"].lower() for record in records}
    for name in DATA["unencoded"]:
        assert name.lower() not in glyph_names
        for suffix in ("init", "medi", "fina"):
            assert f"{name}.{suffix}".lower() not in glyph_names


def test_alt_rule_is_rejected():
    with pytest.raises(UnmappedMark):
        parse_substitutions("sub dad-ar by dad-ar dotbelow-ar.alt;")


def test_generator_substitutes_font_names_and_skips_missing():
    result = GENERATOR.generate(
        {
            "lifecycle": [],
            "changes": [],
            "intents": {"arabic": {"add": {"teh-ar": {}}, "remove": []}},
        },
        {
            "font_glyphs": ["teh-ar", "behDotless-ar", "behDotless-ar.init", "twoDotsHorizontalAbove-ar"],
            "identity_names": {
                "uni062A": "teh-ar",
                "uni066E": "behDotless-ar",
                "uni066E.init": "behDotless-ar.init",
            },
            "managed_blocks": {},
            "ccmp_inputs": [],
        },
    )
    init = next(block["code"] for block in result["blocks"] if block["tag"] == "init")
    assert "sub teh-ar by behDotless-ar.init twoDotsHorizontalAbove-ar;" in init
    assert "sub behDotless-ar by behDotless-ar.init;" in init
    skipped = GENERATOR.generate(
        {"lifecycle": [], "changes": [], "intents": {}},
        {
            "font_glyphs": ["teh-ar"],
            "identity_names": {"uni062A": "teh-ar"},
            "managed_blocks": {},
            "ccmp_inputs": [],
        },
    )
    init = next(block["code"] for block in skipped["blocks"] if block["tag"] == "init")
    assert "teh-ar" not in init


def test_ccmp_letter_is_skipped():
    result = GENERATOR.generate(
        {"lifecycle": [], "changes": [], "intents": {}},
        {
            "font_glyphs": ["teh-ar", "behDotless-ar", "behDotless-ar.init"],
            "identity_names": {
                "uni062A": "teh-ar",
                "uni066E": "behDotless-ar",
                "uni066E.init": "behDotless-ar.init",
            },
            "managed_blocks": {},
            "ccmp_inputs": ["teh-ar"],
        },
    )
    code = "\n".join(block["code"] for block in result["blocks"])
    assert "teh-ar" not in code
    assert "sub behDotless-ar by behDotless-ar.init;" in code


def test_existing_line_wins_over_intent_and_recipe():
    result = GENERATOR.generate(
        {
            "lifecycle": [],
            "changes": [],
            "intents": {
                "arabic": {
                    "add": {"yehFarsi-ar": {"init": ["custom-ar", "twoDotsHorizontalBelow-ar"]}},
                    "remove": [],
                }
            },
        },
        {
            "font_glyphs": [
                "yehFarsi-ar",
                "kept-ar",
                "custom-ar",
                "twoDotsHorizontalBelow-ar",
                "behDotless-ar.init",
            ],
            "identity_names": {"uni06CC": "yehFarsi-ar", "uni066E.init": "behDotless-ar.init"},
            "managed_blocks": {"init": "sub yehFarsi-ar by kept-ar;"},
            "ccmp_inputs": [],
        },
    )
    init = next(block["code"] for block in result["blocks"] if block["tag"] == "init")
    assert "sub yehFarsi-ar by kept-ar;" in init
    assert "custom-ar" not in init


def test_intent_remove_drops_positional_lines():
    result = GENERATOR.generate(
        {
            "lifecycle": [],
            "changes": [],
            "intents": {"arabic": {"add": {}, "remove": ["yehFarsi-ar"]}},
        },
        {
            "font_glyphs": ["yehFarsi-ar", "behDotless-ar.init", "twoDotsHorizontalBelow-ar"],
            "identity_names": {
                "uni06CC": "yehFarsi-ar",
                "uni066E.init": "behDotless-ar.init",
            },
            "managed_blocks": {
                "init": "sub yehFarsi-ar by behDotless-ar.init twoDotsHorizontalBelow-ar;"
            },
            "ccmp_inputs": [],
        },
    )
    init = next(block["code"] for block in result["blocks"] if block["tag"] == "init")
    assert "twoDotsHorizontalBelow-ar" not in init


def test_mark_variant_and_rename():
    result = GENERATOR.generate(
        {
            "lifecycle": [{"kind": "renamed", "previousGlyphName": "dotCenter-ar", "glyphName": "dot.center"}],
            "changes": [],
            "intents": {},
        },
        {
            "font_glyphs": ["dot.center", "dotBelow-ar"],
            "identity_names": {},
            "managed_blocks": {"init": "sub dotCenter-ar by dotBelow-ar;"},
            "ccmp_inputs": [],
        },
    )
    init = next(block["code"] for block in result["blocks"] if block["tag"] == "init")
    assert "sub dot.center by dotBelow-ar;" in init


def test_lam_alef_from_pack_names_or_encoded_forms():
    context = {
        "font_glyphs": ["lam-ar.init", "lam-ar.medi", "alef-ar.fina", "lam_alef-ar", "lam_alef-ar.fina"],
        "identity_names": {
            "uni0644.init": "lam-ar.init",
            "uni0644.medi": "lam-ar.medi",
            "uni0627.fina": "alef-ar.fina",
        },
        "managed_blocks": {},
        "ccmp_inputs": [],
        "vowel_ligatures": [],
        "alef_composites": [],
    }
    code = GENERATOR.generate({"lifecycle": [], "changes": [], "intents": {}}, context)
    rlig = next(block["code"] for block in code["blocks"] if block["tag"] == "rlig")
    assert "sub lam-ar.init alef-ar.fina by lam_alef-ar;" in rlig
    assert "sub lam-ar.medi alef-ar.fina by lam_alef-ar.fina;" in rlig

    encoded = dict(context)
    encoded["font_glyphs"] = ["lam-ar.init", "lam-ar.medi", "alef-ar.fina", "lamAlefIsol-ar", "lamAlefFina-ar"]
    encoded["identity_names"] = {
        **context["identity_names"],
        "uniFEFB": "lamAlefIsol-ar",
        "uniFEFC": "lamAlefFina-ar",
    }
    code = GENERATOR.generate({"lifecycle": [], "changes": [], "intents": {}}, encoded)
    rlig = next(block["code"] for block in code["blocks"] if block["tag"] == "rlig")
    assert "by lamAlefIsol-ar;" in rlig
    assert "by lamAlefFina-ar;" in rlig

    missing = dict(context)
    missing["font_glyphs"] = ["lam-ar.init", "lam-ar.medi", "alef-ar.fina"]
    code = GENERATOR.generate({"lifecycle": [], "changes": [], "intents": {}}, missing)
    rlig = next(block["code"] for block in code["blocks"] if block["tag"] == "rlig")
    assert "lam_alef" not in rlig


def test_lam_alef_decompose_uses_composite_components():
    present = {
        "font_glyphs": ["lam-ar.init", "lam-ar.medi", "alefHamza-ar.fina", "alef-ar.fina", "hamzaabove-ar", "lam_alef-ar", "lam_alef-ar.fina"],
        "identity_names": {
            "uni0644.init": "lam-ar.init",
            "uni0644.medi": "lam-ar.medi",
            "uni0627.fina": "alef-ar.fina",
            "uni0623.fina": "alefHamza-ar.fina",
        },
        "managed_blocks": {},
        "ccmp_inputs": [],
        "alef_composites": [
            {"identity": "uni0623.fina", "components": ["alef-ar.fina", "hamzaabove-ar"]}
        ],
        "vowel_ligatures": [],
    }
    code = GENERATOR.generate({"lifecycle": [], "changes": [], "intents": {}}, present)
    rlig = next(block["code"] for block in code["blocks"] if block["tag"] == "rlig")
    assert "lookup lam_alef_decompose" in rlig
    assert "alefHamza-ar.fina' by alef-ar.fina hamzaabove-ar;" in rlig
    absent = dict(present)
    absent["alef_composites"] = []
    code = GENERATOR.generate({"lifecycle": [], "changes": [], "intents": {}}, absent)
    rlig = next(block["code"] for block in code["blocks"] if block["tag"] == "rlig")
    assert "lam_alef_decompose" not in rlig


def test_languagesystem_only_when_arab_is_missing():
    base = {
        "font_glyphs": [],
        "identity_names": {},
        "managed_blocks": {},
        "ccmp_inputs": [],
    }
    none = GENERATOR.generate(
        {"lifecycle": [], "changes": [], "intents": {}},
        {**base, "languagesystem_text": ""},
    )
    assert all(block["tag"] != "languagesystems" for block in none["blocks"])
    added = GENERATOR.generate(
        {"lifecycle": [], "changes": [], "intents": {}},
        {**base, "languagesystem_text": "languagesystem latn dflt;"},
    )
    prefix = next(block for block in added["blocks"] if block["tag"] == "languagesystems")
    assert prefix["code"] == "languagesystem arab dflt;"
    assert prefix["placement"] == "prefix"
    present = GENERATOR.generate(
        {"lifecycle": [], "changes": [], "intents": {}},
        {**base, "languagesystem_text": "languagesystem arab dflt;"},
    )
    assert all(block["tag"] != "languagesystems" for block in present["blocks"])


def test_vowel_ligature_orders_and_encoded_tanween_is_not_one():
    result = GENERATOR.generate(
        {"lifecycle": [], "changes": [], "intents": {}},
        {
            "font_glyphs": ["shadda-ar", "fatha-ar", "shaddaFatha-ar", "fathatan-ar"],
            "identity_names": {"uni0651": "shadda-ar", "uni064E": "fatha-ar", "uni064B": "fathatan-ar"},
            "managed_blocks": {},
            "ccmp_inputs": [],
            "vowel_ligatures": [
                {"glyph": "shaddaFatha-ar", "components": ["uni0651", "uni064E"]}
            ],
        },
    )
    rlig = next(block["code"] for block in result["blocks"] if block["tag"] == "rlig")
    assert "sub shadda-ar fatha-ar by shaddaFatha-ar;" in rlig
    assert "sub fatha-ar shadda-ar by shaddaFatha-ar;" in rlig
    assert "fathatan-ar" not in rlig


def test_character_set_and_recipe_round_trip():
    provider = ArabicCharacterSetProvider()
    assert provider.metadata()["name"] == "Arabic Language Pack"
    letters = provider.characters(["letters"], ["essential"])
    assert any(entry.get("codepoint") == 0x062A for entry in letters)
    dots = provider.characters(["dots"], ["essential"])
    assert any(entry.get("glyph_name") == "twoDotsHorizontalAbove-ar" for entry in dots)
    assert all("codepoint" not in entry for entry in dots)
    composition = ArabicCompositionProvider()

    def lookup(codepoint):
        return {"script": "Arabic"}

    recipe = composition.recipe(0x062A, lookup)
    assert recipe["positions"]["isol"] == ["uni066E", "twoDotsHorizontalAbove-ar"]
    assert composition.recipe(0x0041, lambda codepoint: {"script": "Latin"}) is None
    named = composition.recipe_for_name("shaddaFatha-ar")
    assert named["components"] == ["uni0651", "uni064E"]
