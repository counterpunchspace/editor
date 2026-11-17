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
    
    Glyph filter plugins classify one glyph at a time. The host owns full
    scans, incremental cache updates, glyph lifetime handling, and groups.
    
    Required attributes:
    - path: The category path where this filter appears (must match a registered path)
    - keyword: Unique identifier using reverse domain name (e.g., 'com.example.myfilter')
    - display_name: Human-readable name shown in the sidebar
    
    Required methods:
    - classify_glyph(glyph): Return a classification mapping or None

    Required attributes:
    - event_types: Glyph-content events that can change a classification

    Optional methods:
    - is_candidate(glyph): Cheap early rejection predicate

    Optional attributes:
    - hide_when_empty: Leave the filter out of the sidebar while it
      matches no glyphs in the open font
    - unicode_categories: Unicode general category codes such as
      ("Lu", "Lt"), with "" for glyphs without one. The editor then
      matches glyph.glyphData's general_category itself, without calling
      classify_glyph, which must still give the same answer
    - unicode_scripts: Unicode Script names and ISO 15924 codes such as
      ("Arabic", "Arab"), with "" for glyphs without one. The editor then
      matches the glyph's Script_Extensions, or its Script, itself
    - sort_order: Number that orders filters within their sidebar folder;
      filters without one follow, sorted by name
    - group_order: Group names the legend shows first, in this order;
      other groups follow, sorted by name
    """
    
    # Plugin path - must match a registered path in FILTER_PATHS
    # e.g., 'basic', 'basic/glyph_categories'
    path = "basic"
    
    # Unique keyword using reverse domain name notation
    keyword = "com.context.base"
    
    # Display name shown in sidebar
    display_name = "Base Filter"

    event_types = set()

    # Leave the filter out of the sidebar while it matches no glyphs
    hide_when_empty = False
    
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
    
    def classify_glyph(self, glyph):
        """Return True, False, or {'groups': [{'name': str, 'color': str}]}."""
        return False
