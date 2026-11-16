# Copyright (C) 2026 Yanone
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""
Category Filters - glyph categories built from Unicode general categories.

The 30 Unicode general categories are combined into the groups type
designers work with, such as Letters, Marks or Figures. A glyph's
category comes from `glyph.glyphData`, which dotted glyphs such as `a.sc`
take from their base glyph. Glyphs that glyph data doesn't know (many
Arabic dot marks and ligatures, `.notdef`) are in No Category. Filters with
no glyphs in the open font are left out of the sidebar.

The editor matches `unicode_categories` in JavaScript, which is much faster
than calling `classify_glyph` for every glyph; `classify_glyph` gives the
same answer for hosts that call it.
"""

from base_glyph_filter_plugin import BaseGlyphFilterPlugin

# (key, display name, Unicode general categories), in sidebar order.
# "" stands for glyphs without a category in glyph data.
CATEGORY_GROUPS = [
    ("letters", "Letters", ("Lu", "Lt", "Ll", "Lo")),
    ("modifiers", "Modifiers", ("Lm", "Sk")),
    ("marks", "Marks", ("Mn", "Mc", "Me")),
    ("figures", "Figures", ("Nd", "Nl", "No")),
    ("punctuation", "Punctuation", ("Pc", "Pd", "Ps", "Pe", "Pi", "Pf", "Po")),
    ("symbols", "Symbols", ("Sm", "Sc", "So", "Co")),
    (
        "spaces",
        "Spaces & Controls",
        ("Zs", "Zl", "Zp", "Cc", "Cf", "Cs", "Cn"),
    ),
    ("none", "No Category", ("",)),
]


def general_category(glyph):
    """Return the glyph's Unicode general category code, or ""."""
    data = getattr(glyph, "glyphData", None)
    if data is None:
        return ""
    try:
        value = data["general_category"]
    except Exception:
        value = getattr(data, "general_category", None)
    return str(value) if value else ""


class CategoryFilter(BaseGlyphFilterPlugin):
    """Glyphs whose Unicode general category is in `unicode_categories`."""

    path = "categories"
    unicode_categories = ()
    hide_when_empty = True
    event_types = {"glyph.unicode.changed"}

    def visible(self):
        return True

    def classify_glyph(self, glyph):
        return general_category(glyph) in self.unicode_categories


def _make_filter(order, key, name, codes):
    return type(
        f"{key.capitalize()}CategoryFilter",
        (CategoryFilter,),
        {
            "__doc__": f"Glyphs in Unicode general categories {', '.join(codes)}.",
            "unicode_categories": codes,
            "sort_order": order,
            "keyword": f"com.context.category.{key}",
            "display_name": name,
        },
    )


CATEGORY_FILTERS = {
    key: _make_filter(order, key, name, codes)
    for order, (key, name, codes) in enumerate(CATEGORY_GROUPS)
}
globals().update({cls.__name__: cls for cls in CATEGORY_FILTERS.values()})
