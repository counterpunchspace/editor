import gzip
import json
import sys
from pathlib import Path

import pytest

ARABIC = Path(__file__).resolve().parents[1] / "arabic"
sys.path.insert(0, str(ARABIC))
sys.path.insert(0, str(ARABIC / "tools"))

from build_arabic_data import UnmappedMark, build, parse_substitutions
from counterpunch_arabic.charset import ArabicCharacterSetProvider
from counterpunch_arabic.composition import ArabicCompositionProvider
from counterpunch_arabic.font_source import ArabicFontSource
from counterpunch_arabic.generator import ArabicFormsGenerator

class Component:
    def __init__(self, reference):
        self.reference = reference


class Layer:
    def __init__(self, components):
        self.is_background = False
        self.components = [Component(name) for name in components]


class Glyph:
    def __init__(self, name, codepoints=None, components=None):
        self.name = name
        self.codepoints = list(codepoints or [])
        self.layers = [] if components is None else [Layer(components)]


class Font:
    def __init__(self, glyphs, features=None):
        self.glyphs = glyphs
        self.features = type("Features", (), {"features": features or [], "prefixes": {}})()


def _ccmp(code):
    return [
        [
            "ccmp",
            {
                "code": code,
                "automatic": True,
                "format_specific": {
                    "com.counterpunch.generator": {
                        "generator": "space.counterpunch.ccmp",
                        "block": "decomposition",
                    }
                },
            },
        ]
    ]


def generate(batch, names, codepoints=None, components=None, managed=None, ccmp="", languages="", features=None):
    codepoints = codepoints or {}
    components = components or {}
    glyphs = [
        Glyph(
            name,
            [codepoints[name]] if name in codepoints else [],
            components.get(name),
        )
        for name in names
    ]
    entries = list(features or [])
    if ccmp:
        entries = _ccmp(ccmp) + entries
    return GENERATOR.generate(
        batch,
        Font(glyphs, entries),
        {"managed_blocks": managed or {}, "languagesystem_text": languages},
    )


DATA = json.loads(
    (ARABIC / "counterpunch_arabic" / "data" / "arabic.json").read_text(encoding="utf-8")
)
SOURCE = ArabicFontSource()
GENERATOR = ArabicFormsGenerator()
EDITOR = Path(__file__).resolve().parents[3]


def _tokens():
    for record in SOURCE.characters.values():
        for sequence in record["positions"].values():
            yield from sequence
        yield from record.get("decompose") or []


def test_data_identities_and_pack_names():
    for token in _tokens():
        if token.startswith("uni"):
            codepoint = int(token.split(".")[0][3:], 16)
            assert not 0xFB50 <= codepoint <= 0xFEFF
            assert token.split(".")[-1] in {token, "init", "medi", "fina"} or "." not in token
        else:
            root = token.rsplit(".", 1)[0] if token.rsplit(".", 1)[-1] in {"init", "medi", "fina"} else token
            assert root in SOURCE.unencoded
    dot_names = {entry["glyph_name"] for entry in DATA["leaves"][1]["entries"]}
    assert dot_names
    assert all("codepoint" not in entry for entry in DATA["leaves"][1]["entries"])
    assert "kafDotless-ar" in SOURCE.unencoded
    assert SOURCE.characters["uni062A"]["decompose"] == [
        "uni066E",
        "twoDotsHorizontalAbove-ar",
    ]
    assert "decompose" not in SOURCE.characters["uni06CC"]
    assert SOURCE.characters["uni0643"]["positions"]["init"] == ["uni06A9.init"]
    assert "qafDotless-ar.init" not in SOURCE.glyphs
    assert "qafDotless-ar.medi" not in SOURCE.glyphs
    assert "noonGhunna-ar.init" not in SOURCE.glyphs
    assert "noonGhunna-ar.medi" not in SOURCE.glyphs
    assert "alefMaksura-ar.init" not in SOURCE.glyphs
    assert "alefMaksura-ar.medi" not in SOURCE.glyphs
    assert SOURCE.characters["uni0642"]["positions"]["init"] == [
        "uni06A1.init",
        "twoDotsHorizontalAbove-ar",
    ]
    assert SOURCE.characters["uni066F"]["positions"]["init"] == ["uni06A1.init"]
    assert SOURCE.characters["uni06BA"]["positions"]["init"] == ["uni066E.init"]
    assert SOURCE.characters["uni06BA"]["positions"]["fina"] == ["uni06BA.fina"]
    assert SOURCE.characters["uni0649"]["positions"]["init"] == ["uni066E.init"]
    assert SOURCE.characters["uni0649"]["positions"]["medi"] == ["uni066E.medi"]
    assert SOURCE.characters["uni062C"]["positions"]["isol"] == [
        "uni062D",
        "dotCenter-ar",
    ]
    assert SOURCE.characters["uni062C"]["positions"]["init"] == [
        "uni062D.init",
        "dotBelow-ar",
    ]
    assert SOURCE.characters["uni062C"]["positions"]["medi"] == [
        "uni062D.medi",
        "dotBelow-ar",
    ]
    assert SOURCE.characters["uni062C"]["positions"]["fina"] == [
        "uni062D.fina",
        "dotCenter-ar",
    ]
    assert SOURCE.components("jeem-ar.init") == ["hah-ar.init", "dotBelow-ar"]
    assert SOURCE.components("jeem-ar.medi") == ["hah-ar.medi", "dotBelow-ar"]
    assert "init" in SOURCE.characters["uni0649"]["positions"]
    ghunna_fina = SOURCE.drawing("noonGhunna-ar.fina")
    assert ghunna_fina and ghunna_fina["paths"]


def test_sample_font_recipes_match_fustat_positions():
    """Every Arabic letter's recipe is the Fustat shaping of that letter.

    Positional mark differences (a dot in init/medi that isol/fina omit) and
    shape reuse live in that data. The sample font is only a carrier.
    """
    data = build(center_marks=False)
    for identity, record in data["characters"].items():
        actual = SOURCE.characters.get(identity)
        assert actual is not None, identity
        assert actual["positions"] == record["positions"], identity
        assert actual.get("decompose") == record.get("decompose"), identity


def test_pack_font_draws_bases_and_leaves_chain_letters_empty():
    teh = SOURCE.glyphs["teh-ar"]
    assert teh["codepoints"] == [0x062A]
    assert SOURCE.components("teh-ar") == []
    assert SOURCE.drawing("teh-ar") is None
    base = SOURCE.drawing("behDotless-ar")
    assert base["paths"]
    assert {anchor["name"] for anchor in base["anchors"]} >= {"top", "bottom"}
    assert SOURCE.drawing("behDotless-ar.init")["paths"]
    dots = SOURCE.drawing("twoDotsHorizontalAbove-ar")
    assert dots["paths"]
    yeh_init = SOURCE.components("yehFarsi-ar.init")
    assert "behDotless-ar.init" in yeh_init
    assert SOURCE.ccmp["teh-ar"][0] == "behDotless-ar"


def test_pack_names_do_not_collide_with_glyph_data():
    records = json.loads(
        gzip.open(EDITOR / "webapp" / "data" / "glyph-data.json.gz", "rt", encoding="utf-8").read()
    )
    glyph_names = {record["glyph_name"].lower() for record in records}
    for name in SOURCE.unencoded:
        assert name.lower() not in glyph_names
        for suffix in ("init", "medi", "fina"):
            assert f"{name}.{suffix}".lower() not in glyph_names


def test_alt_rule_is_rejected():
    with pytest.raises(UnmappedMark):
        parse_substitutions("sub dad-ar by dad-ar dotbelow-ar.alt;")


def test_generator_substitutes_font_names_and_skips_missing():
    points = { "teh-ar": 0x062A, "behDotless-ar": 0x066E }
    result = generate(
        {
            "lifecycle": [],
            "changes": [],
            "intents": {"arabic": {"add": {"teh-ar": {}}, "remove": []}},
        },
        ["teh-ar", "behDotless-ar", "behDotless-ar.init", "twoDotsHorizontalAbove-ar"],
        points,
    )
    init = next(block["code"] for block in result["blocks"] if block["tag"] == "init")
    assert "sub teh-ar by behDotless-ar.init twoDotsHorizontalAbove-ar;" in init
    assert "sub behDotless-ar by behDotless-ar.init;" in init
    skipped = generate(
        {"lifecycle": [], "changes": [], "intents": {}},
        ["teh-ar"],
        {"teh-ar": 0x062A},
    )
    init = next(block["code"] for block in skipped["blocks"] if block["tag"] == "init")
    assert "teh-ar" not in init


def test_ccmp_letter_is_skipped():
    result = generate(
        {"lifecycle": [], "changes": [], "intents": {}},
        ["teh-ar", "behDotless-ar", "behDotless-ar.init"],
        {"teh-ar": 0x062A, "behDotless-ar": 0x066E},
        ccmp="sub teh-ar by behDotless-ar twoDotsHorizontalAbove-ar;",
    )
    code = "\n".join(block["code"] for block in result["blocks"])
    assert "teh-ar" not in code
    assert "sub behDotless-ar by behDotless-ar.init;" in code


def test_existing_line_wins_over_intent_and_recipe():
    result = generate(
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
        [
            "yehFarsi-ar",
            "kept-ar",
            "custom-ar",
            "twoDotsHorizontalBelow-ar",
            "behDotless-ar.init",
        ],
        {"yehFarsi-ar": 0x06CC, "behDotless-ar.init": 0x066E},
        managed={"init": "sub yehFarsi-ar by kept-ar;"},
    )
    init = next(block["code"] for block in result["blocks"] if block["tag"] == "init")
    assert "sub yehFarsi-ar by kept-ar;" in init
    assert "custom-ar" not in init


def test_intent_remove_drops_positional_lines():
    result = generate(
        {
            "lifecycle": [],
            "changes": [],
            "intents": {"arabic": {"add": {}, "remove": ["yehFarsi-ar"]}},
        },
        ["yehFarsi-ar", "behDotless-ar.init", "twoDotsHorizontalBelow-ar"],
        {"yehFarsi-ar": 0x06CC},
        managed={"init": "sub yehFarsi-ar by behDotless-ar.init twoDotsHorizontalBelow-ar;"},
    )
    init = next(block["code"] for block in result["blocks"] if block["tag"] == "init")
    assert "twoDotsHorizontalBelow-ar" not in init


def test_mark_variant_and_rename():
    result = generate(
        {
            "lifecycle": [{"kind": "renamed", "previousGlyphName": "dotCenter-ar", "glyphName": "dot.center"}],
            "changes": [],
            "intents": {},
        },
        ["dot.center", "dotBelow-ar"],
        managed={"init": "sub dotCenter-ar by dotBelow-ar;"},
    )
    init = next(block["code"] for block in result["blocks"] if block["tag"] == "init")
    assert "sub dot.center by dotBelow-ar;" in init


def test_lam_alef_from_pack_names_or_encoded_forms():
    names = ["lam-ar.init", "lam-ar.medi", "alef-ar.fina", "lam_alef-ar", "lam_alef-ar.fina"]
    points = {"lam-ar.init": 0x0644, "lam-ar.medi": 0x0644, "alef-ar.fina": 0x0627}
    code = generate({"lifecycle": [], "changes": [], "intents": {}}, names, points)
    rlig = next(block["code"] for block in code["blocks"] if block["tag"] == "rlig")
    assert "sub lam-ar.init alef-ar.fina by lam_alef-ar;" in rlig
    assert "sub lam-ar.medi alef-ar.fina by lam_alef-ar.fina;" in rlig

    code = generate(
        {"lifecycle": [], "changes": [], "intents": {}},
        ["lam-ar.init", "lam-ar.medi", "alef-ar.fina", "lamAlefIsol-ar", "lamAlefFina-ar"],
        {**points, "lamAlefIsol-ar": 0xFEFB, "lamAlefFina-ar": 0xFEFC},
    )
    rlig = next(block["code"] for block in code["blocks"] if block["tag"] == "rlig")
    assert "by lamAlefIsol-ar;" in rlig
    assert "by lamAlefFina-ar;" in rlig

    code = generate(
        {"lifecycle": [], "changes": [], "intents": {}},
        ["lam-ar.init", "lam-ar.medi", "alef-ar.fina"],
        points,
    )
    rlig = next(block["code"] for block in code["blocks"] if block["tag"] == "rlig")
    assert "lam_alef" not in rlig


def test_designer_lam_alef_lookup_is_not_duplicated():
    names = ["lam-ar.init", "lam-ar.medi", "alef-ar.fina", "lam_alef-ar", "lam_alef-ar.fina"]
    points = {"lam-ar.init": 0x0644, "lam-ar.medi": 0x0644, "alef-ar.fina": 0x0627}
    code = generate(
        {"lifecycle": [], "changes": [], "intents": {}},
        names,
        points,
        features=[
            [
                "rlig",
                {
                    "code": "lookup lam_alef {\n  lookupflag IgnoreMarks;\n  sub lam-ar.init alef-ar.fina by lam_alef-ar;\n} lam_alef;",
                    "automatic": False,
                },
            ]
        ],
    )
    rlig = next(block["code"] for block in code["blocks"] if block["tag"] == "rlig")
    assert "lookup lam_alef {" not in rlig


def test_lam_alef_decompose_uses_composite_components():
    names = [
        "lam-ar.init",
        "lam-ar.medi",
        "alefHamza-ar.fina",
        "alef-ar.fina",
        "hamzaabove-ar",
        "lam_alef-ar",
        "lam_alef-ar.fina",
    ]
    points = {
        "lam-ar.init": 0x0644,
        "lam-ar.medi": 0x0644,
        "alef-ar.fina": 0x0627,
        "alefHamza-ar.fina": 0x0623,
    }
    code = generate(
        {"lifecycle": [], "changes": [], "intents": {}},
        names,
        points,
        components={"alefHamza-ar.fina": ["alef-ar.fina", "hamzaabove-ar"]},
    )
    rlig = next(block["code"] for block in code["blocks"] if block["tag"] == "rlig")
    assert "lookup lam_alef_decompose" in rlig
    assert "alefHamza-ar.fina' by alef-ar.fina hamzaabove-ar;" in rlig
    code = generate({"lifecycle": [], "changes": [], "intents": {}}, names, points)
    rlig = next(block["code"] for block in code["blocks"] if block["tag"] == "rlig")
    assert "lam_alef_decompose" not in rlig


def test_arabic_does_not_write_languagesystems():
    batch = {"lifecycle": [], "changes": [], "intents": {}}
    added = generate(batch, [], languages="languagesystem latn dflt;")
    assert all(block["tag"] != "languagesystems" for block in added["blocks"])


def test_vowel_ligature_orders_and_encoded_tanween_is_not_one():
    result = generate(
        {"lifecycle": [], "changes": [], "intents": {}},
        ["shadda-ar", "fatha-ar", "shaddaFatha-ar", "fathatan-ar"],
        {"shadda-ar": 0x0651, "fatha-ar": 0x064E, "fathatan-ar": 0x064B},
        components={"shaddaFatha-ar": ["shadda-ar", "fatha-ar"]},
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
