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
General Glyph Filter Plugin
Provides basic glyph filters: All Glyphs, Encoded Characters, Unencoded Glyphs.
"""

from .all_glyphs import AllGlyphsFilter
from .encoded_glyphs import EncodedGlyphsFilter
from .unencoded_glyphs import UnencodedGlyphsFilter

__all__ = ['AllGlyphsFilter', 'EncodedGlyphsFilter', 'UnencodedGlyphsFilter']
