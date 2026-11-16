import re
import sys
from pathlib import Path

GLYPHFILTER = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(GLYPHFILTER / "base"))
sys.path.insert(0, str(GLYPHFILTER / "general"))

from general_filter_plugin.writing_scripts import (  # noqa: E402
    SCRIPT_FILTERS,
    WRITING_SCRIPTS,
)


class Glyph:
    def __init__(self, name, script, extensions=()):
        self.name = name
        self.glyphData = {"script": script, "script_extensions": list(extensions)}


ARABIC = SCRIPT_FILTERS["Arab"]()
COMMON = SCRIPT_FILTERS["Zyyy"]()


def test_arabic_includes_digits_modifiers_marks_and_shared_punctuation():
    assert ARABIC.classify_glyph(Glyph("alef-ar", "Arabic"))
    assert ARABIC.classify_glyph(Glyph("one-ar", "Arabic", ["Arab", "Thaa", "Yezi"]))
    assert ARABIC.classify_glyph(Glyph("smallWaw-ar", "Arabic"))
    assert ARABIC.classify_glyph(Glyph("fatha-ar", "Inherited", ["Arab", "Syrc"]))
    assert ARABIC.classify_glyph(Glyph("comma-ar", "Common", ["Arab", "Syrc"]))
    assert not ARABIC.classify_glyph(Glyph("zero", "Common"))


def test_common_holds_only_characters_without_script_extensions():
    assert COMMON.classify_glyph(Glyph("zero", "Common"))
    assert COMMON.classify_glyph(Glyph("zeroWidthJoiner", "Inherited"))
    assert not COMMON.classify_glyph(Glyph("comma-ar", "Common", ["Arab"]))
    assert not COMMON.classify_glyph(
        Glyph("acuteCombining", "Inherited", ["Grek", "Latn"])
    )


def test_glyphs_without_glyph_data_are_in_no_writing_script():
    unknown = Glyph("dotabove-ar", None)
    unknown.glyphData = None
    assert SCRIPT_FILTERS["Zzzz"]().classify_glyph(unknown)
    assert not ARABIC.classify_glyph(unknown)


def test_filters_are_sparse_ordered_and_named():
    filters = [cls() for cls in SCRIPT_FILTERS.values()]
    assert all(f.path == "scripts" and f.hide_when_empty for f in filters)
    orders = [f.sort_order for f in filters]
    assert sorted(orders) == list(range(len(filters)))
    assert ARABIC.display_name == "Arabic"
    assert SCRIPT_FILTERS["Cans"]().display_name == "Canadian Aboriginal"
    assert ARABIC.unicode_scripts == ("Arabic", "Arab")


def test_setup_registers_every_writing_script():
    setup = (GLYPHFILTER / "general" / "setup.py").read_text()
    assert "writing_scripts.json" in setup
    codes = [code for code, _name in WRITING_SCRIPTS]
    assert len(codes) == len(set(codes))
    assert all(re.fullmatch(r"[A-Z][a-z]{3}", code) for code in codes)
    assert set(SCRIPT_FILTERS) == set(codes) | {"Zyyy", "Zzzz"}
