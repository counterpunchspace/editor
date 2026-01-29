# Copyright (C) 2025 Yanone
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
Encoded Glyphs Filter - shows glyphs that have a defined Unicode codepoint.
"""


class EncodedGlyphsFilter:
    """Filter that returns glyphs with at least one Unicode codepoint."""

    path = "basic/glyph_categories"
    keyword = "com.context.encoded"
    display_name = "Encoded Characters"

    # Unicode block ranges
    UNICODE_BLOCKS = [
        (0x0000, 0x007F, "basic_latin", "Basic Latin", "#3b82f6"),
        (0x0080, 0x00FF, "latin_1", "Latin-1 Supplement", "#60a5fa"),
        (0x0100, 0x017F, "latin_ext_a", "Latin Extended-A", "#93c5fd"),
        (0x0180, 0x024F, "latin_ext_b", "Latin Extended-B", "#bfdbfe"),
        (0x0250, 0x02AF, "ipa", "IPA Extensions", "#dbeafe"),
        (0x0370, 0x03FF, "greek", "Greek and Coptic", "#8b5cf6"),
        (0x0400, 0x04FF, "cyrillic", "Cyrillic", "#a855f7"),
        (0x0590, 0x05FF, "hebrew", "Hebrew", "#c084fc"),
        (0x0600, 0x06FF, "arabic", "Arabic", "#d8b4fe"),
        (0x0900, 0x097F, "devanagari", "Devanagari", "#e9d5ff"),
        (0x0E00, 0x0E7F, "thai", "Thai", "#f3e8ff"),
        (
            0x1E00,
            0x1EFF,
            "latin_ext_additional",
            "Latin Extended Additional",
            "#ddd6fe",
        ),
        (0x2000, 0x206F, "general_punctuation", "General Punctuation", "#22c55e"),
        (0x2070, 0x209F, "super_sub", "Superscripts and Subscripts", "#4ade80"),
        (0x20A0, 0x20CF, "currency", "Currency Symbols", "#86efac"),
        (0x2100, 0x214F, "letterlike", "Letterlike Symbols", "#bbf7d0"),
        (0x2190, 0x21FF, "arrows", "Arrows", "#dcfce7"),
        (0x2200, 0x22FF, "math_operators", "Mathematical Operators", "#10b981"),
        (0x2300, 0x23FF, "misc_technical", "Miscellaneous Technical", "#059669"),
        (0x2460, 0x24FF, "enclosed_alphanum", "Enclosed Alphanumerics", "#047857"),
        (0x2500, 0x257F, "box_drawing", "Box Drawing", "#065f46"),
        (0x2580, 0x259F, "block_elements", "Block Elements", "#064e3b"),
        (0x25A0, 0x25FF, "geometric_shapes", "Geometric Shapes", "#f59e0b"),
        (0x2600, 0x26FF, "misc_symbols", "Miscellaneous Symbols", "#fb923c"),
        (0x2700, 0x27BF, "dingbats", "Dingbats", "#fdba74"),
        (0x3040, 0x309F, "hiragana", "Hiragana", "#ec4899"),
        (0x30A0, 0x30FF, "katakana", "Katakana", "#f472b6"),
        (0x4E00, 0x9FFF, "cjk_unified", "CJK Unified Ideographs", "#f9a8d4"),
        (0xAC00, 0xD7AF, "hangul", "Hangul Syllables", "#fbcfe8"),
        (0xE000, 0xF8FF, "private_use", "Private Use Area", "#6b7280"),
        (
            0x1F300,
            0x1F5FF,
            "emoji_misc",
            "Miscellaneous Symbols and Pictographs",
            "#fbbf24",
        ),
        (0x1F600, 0x1F64F, "emoji_emoticons", "Emoticons", "#fcd34d"),
        (0x1F680, 0x1F6FF, "emoji_transport", "Transport and Map Symbols", "#fde68a"),
        (
            0x1F900,
            0x1F9FF,
            "emoji_supplemental",
            "Supplemental Symbols and Pictographs",
            "#fef3c7",
        ),
    ]

    def __init__(self):
        pass

    def visible(self):
        return True

    def get_groups(self):
        groups = {
            "multiple_codepoints": {
                "description": "Multiple Codepoints",
                "color": "#ef4444",
            }
        }

        # Add Unicode block groups
        for start, end, key, description, color in self.UNICODE_BLOCKS:
            groups[key] = {
                "description": f"{description} (U+{start:04X}–U+{end:04X})",
                "color": color,
            }

        return groups

    def filter_glyphs(self, font):
        """Return glyphs that have a Unicode codepoint defined."""
        results = []

        glyphs = getattr(font, "glyphs", None)
        if glyphs is None:
            return results

        for glyph in glyphs:
            glyph_name = getattr(glyph, "name", None)
            if not glyph_name:
                continue

            # Check for unicode codepoints
            codepoints = getattr(glyph, "codepoints", None)
            if codepoints and len(codepoints) > 0:
                # Build list of groups this glyph belongs to
                groups = []

                # Check for multiple codepoints
                if len(codepoints) > 1:
                    groups.append("multiple_codepoints")

                # Determine which Unicode blocks the codepoints belong to
                for cp in codepoints:
                    for start, end, key, description, color in self.UNICODE_BLOCKS:
                        if start <= cp <= end:
                            if key not in groups:
                                groups.append(key)
                            break

                results.append({"glyph_name": glyph_name, "groups": groups})

        return results
