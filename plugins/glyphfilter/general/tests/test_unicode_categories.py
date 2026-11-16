import re
import sys
from pathlib import Path

GLYPHFILTER = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(GLYPHFILTER / "base"))
sys.path.insert(0, str(GLYPHFILTER / "general"))

from general_filter_plugin.unicode_categories import (  # noqa: E402
    CATEGORY_FILTERS,
    CATEGORY_GROUPS,
)

ALL_GENERAL_CATEGORIES = (
    "Lu Ll Lt Lm Lo Mn Mc Me Nd Nl No Pc Pd Ps Pe Pi Pf Po "
    "Sm Sc Sk So Zs Zl Zp Cc Cf Cs Co Cn"
).split()


class Glyph:
    def __init__(self, name, general_category):
        self.name = name
        self.glyphData = {"general_category": general_category}


def test_every_general_category_is_in_exactly_one_group():
    codes = [code for _key, _name, group in CATEGORY_GROUPS for code in group]
    assert sorted(codes) == sorted(ALL_GENERAL_CATEGORIES + [""])


def test_filters_match_their_categories():
    uppercase = CATEGORY_FILTERS["uppercase"]()
    assert uppercase.classify_glyph(Glyph("A", "Lu"))
    assert uppercase.classify_glyph(Glyph("Dz", "Lt"))
    assert not uppercase.classify_glyph(Glyph("a.sc", "Ll"))
    assert CATEGORY_FILTERS["modifiers"]().classify_glyph(Glyph("circumflex", "Sk"))
    assert CATEGORY_FILTERS["marks"]().classify_glyph(Glyph("acutecomb", "Mn"))


def test_no_category_matches_glyphs_without_glyph_data():
    no_category = CATEGORY_FILTERS["none"]()
    unknown = Glyph("dotabove-ar", None)
    unknown.glyphData = None
    assert no_category.classify_glyph(unknown)
    assert no_category.classify_glyph(Glyph("lam_alef-ar", ""))
    assert not no_category.classify_glyph(Glyph("a", "Ll"))


def test_filters_are_flat_ordered_and_hide_when_empty():
    filters = [CATEGORY_FILTERS[key]() for key, _name, _codes in CATEGORY_GROUPS]
    assert all(f.path == "categories" for f in filters)
    assert all(f.hide_when_empty is True for f in filters)
    assert [f.sort_order for f in filters] == list(range(len(filters)))
    marks = CATEGORY_FILTERS["marks"]()
    assert marks.display_name == "Marks"
    assert marks.keyword == "com.context.category.marks"
    assert marks.unicode_categories == ("Mn", "Mc", "Me")


def test_setup_registers_every_group():
    setup = (GLYPHFILTER / "general" / "setup.py").read_text()
    keys = re.search(r'CATEGORY_KEYS = \((.*?)\)\.split', setup, re.S)
    registered = "".join(re.findall(r'"([^"]*)"', keys.group(1))).split()
    assert registered == [key for key, _name, _codes in CATEGORY_GROUPS]
