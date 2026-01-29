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
        Should return (or yield) a list of dicts, each containing:
        - glyph_name: Name of the glyph
        - group (optional): A single group keyword (from get_groups)
        - groups (optional): A list of group keywords (for multi-group support)
        
        A glyph can belong to multiple groups in two ways:
        1. Using the 'groups' key with a list of keywords
        2. Yielding the same glyph multiple times with different 'group' values
           (results are automatically merged by glyph_name)
        
        When filtering by groups in the UI, glyphs will appear if they match ANY of the selected groups.
        
        Args:
            font: The font object (babelfont model)
            
        Example (single group):
            def filter_glyphs(self, font):
                results = []
                for glyph in font.glyphs:
                    if some_condition(glyph):
                        results.append({
                            "glyph_name": glyph.name,
                            "group": "error"
                        })
                return results
        
        Example (multiple groups using 'groups' list):
            def filter_glyphs(self, font):
                results = []
                for glyph in font.glyphs:
                    groups = []
                    if has_error(glyph):
                        groups.append("error")
                    if has_warning(glyph):
                        groups.append("warning")
                    results.append({
                        "glyph_name": glyph.name,
                        "groups": groups  # Can be empty, one, or multiple groups
                    })
                return results
        
        Example (multiple groups via yield - same glyph emitted multiple times):
            def filter_glyphs(self, font):
                for glyph in font.glyphs:
                    if has_error(glyph):
                        yield {"glyph_name": glyph.name, "group": "error"}
                    if has_warning(glyph):
                        yield {"glyph_name": glyph.name, "group": "warning"}
                    # If glyph has both, it will appear once with both groups merged
            
        Returns:
            List of filter result dicts (or generator yielding them)
        """
        return []
