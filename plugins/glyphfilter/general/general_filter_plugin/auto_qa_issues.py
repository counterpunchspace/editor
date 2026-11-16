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
Auto QA Issues Filter - shows glyphs that Auto QA reports anything for.
"""

from base_glyph_filter_plugin import BaseGlyphFilterPlugin


class AutoQaIssuesFilter(BaseGlyphFilterPlugin):
    """Filter that returns glyphs with Auto QA issues."""

    path = "basic/debugging"
    keyword = "com.context.auto_qa_issues"
    display_name = "Auto QA Issues"
    event_types = {"glyph.qa.changed"}

    def __init__(self):
        pass

    def visible(self):
        return True

    def is_candidate(self, glyph):
        return glyph.hasQaIssues

    def classify_glyph(self, glyph):
        """Classify one glyph that Auto QA reports anything for."""
        return True
