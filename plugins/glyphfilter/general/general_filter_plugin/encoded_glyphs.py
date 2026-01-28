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
    
    def __init__(self):
        pass
    
    def visible(self):
        return True
    
    def get_colors(self):
        return {
            "multiple_codepoints": {
                "description": "Multiple Codepoints",
                "color": "#22c55e"
            }
        }
    
    def filter_glyphs(self, font):
        """Return glyphs that have a Unicode codepoint defined."""
        results = []
        
        glyphs = getattr(font, 'glyphs', None)
        if glyphs is None:
            return results
        
        for glyph in glyphs:
            glyph_name = getattr(glyph, 'name', None)
            if not glyph_name:
                continue
            
            # Check for unicode codepoints
            codepoints = getattr(glyph, 'codepoints', None)
            if codepoints and len(codepoints) > 0:
                if len(codepoints) > 1:
                    results.append({"glyph_name": glyph_name, "color": "multiple_codepoints"})
                else:
                    results.append({"glyph_name": glyph_name})
        
        return results
