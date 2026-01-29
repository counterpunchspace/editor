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
    
    def get_groups(self):
        return {
            "multiple_codepoints": {
                "description": "Multiple Codepoints",
                "color": "#22c55e"
            },
            "bmp": {
                "description": "Basic Multilingual Plane (BMP)",
                "color": "#3b82f6"
            },
            "supplementary": {
                "description": "Supplementary Planes",
                "color": "#a855f7"
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
                # Build list of groups this glyph belongs to
                groups = []
                
                # Check for multiple codepoints
                if len(codepoints) > 1:
                    groups.append("multiple_codepoints")
                
                # Check Unicode plane (BMP vs Supplementary)
                # A glyph can be in both if it has codepoints in both planes
                has_bmp = False
                has_supplementary = False
                for cp in codepoints:
                    if cp <= 0xFFFF:
                        has_bmp = True
                    else:
                        has_supplementary = True
                
                if has_bmp:
                    groups.append("bmp")
                if has_supplementary:
                    groups.append("supplementary")
                
                results.append({"glyph_name": glyph_name, "groups": groups})
        
        return results
