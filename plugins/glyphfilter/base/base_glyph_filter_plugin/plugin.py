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
Base Glyph Filter Plugin Template
This is a minimal template showing the essential methods for a glyph filter plugin.
"""
# Import CurrentFont to get the current font object
# from fonteditor import CurrentFont

class BaseGlyphFilterPlugin:
    """
    Base template for glyph filter plugins.
    
    Glyph filter plugins define filters that return subsets of glyphs
    with optional group coding. They appear in the glyph overview sidebar.
    
    Required attributes:
    - path: The category path where this filter appears (must match a registered path)
    - keyword: Unique identifier using reverse domain name (e.g., 'com.example.myfilter')
    - display_name: Human-readable name shown in the sidebar
    
    Required methods:
    - get_groups(): Return group definitions for group keywords
    - filter_glyphs(font): Return list of glyphs matching the filter
    """
    
    # Plugin path - must match a registered path in FILTER_PATHS
    # e.g., 'basic', 'basic/glyph_categories'
    path = "basic"
    
    # Unique keyword using reverse domain name notation
    keyword = "com.context.base"
    
    # Display name shown in sidebar
    display_name = "Base Filter"
    
    def __init__(self):
        """
        Initialize the plugin.
        """
        pass
    
    def visible(self):
        """
        Whether this plugin should be visible in the filter list.
        Base plugin is hidden by default.
        
        Returns:
            Boolean - True to show in list, False to hide
        """
        return False
    
    def get_groups(self):
        """
        Return group definitions for group keywords.
        
        Each group has a keyword key, with a dict containing:
        - description: Human-readable description of what this group means
        - color: Hex color value for visual identification
        
        Example:
            {
                "error": {
                    "description": "Glyphs with errors",
                    "color": "#ff0000"
                },
                "warning": {
                    "description": "Glyphs with warnings", 
                    "color": "#ffaa00"
                }
            }
        
        Returns:
            Dict mapping group keywords to group definitions
        """
        return {}
    
    def filter_glyphs(self, font):
        """
        Filter glyphs from the font and return results.
        
        This is the main filter method. The font object is passed in as a parameter.
        Should return a list of dicts, each containing:
        - glyph_name: Name of the glyph
        - group (optional): Either a group keyword (from get_groups) or a hex color
        
        Args:
            font: The font object (babelfont model)
            
        Example:
            def filter_glyphs(self, font):
                results = []
                for glyph in font.glyphs:
                    if some_condition(glyph):
                        results.append({
                            "glyph_name": glyph.name,
                            "group": "error"
                        })
                return results
            
        Returns:
            List of filter result dicts
        """
        return []
