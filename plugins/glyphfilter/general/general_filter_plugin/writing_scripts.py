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
Writing Script Filters - one filter per Unicode writing script.

A glyph belongs to the writing scripts in its Unicode Script_Extensions,
or to its Script when it has none, both from `glyph.glyphData`. So Arabic
shows Arabic letters and digits, and also the marks, the comma and the
tatweel that Arabic shares with other writing scripts. Characters that all
writing scripts share (space, 0-9) are in Common. Glyphs that glyph data
doesn't know take the writing script of their name suffix (`lam_alef-ar`
is Arabic) when the editor can tell it; the rest are in No Writing Script.
Filters with no glyphs in the open font are left out of the sidebar.

The editor matches `unicode_scripts` in JavaScript and adds the name suffix
fallback; `classify_glyph` gives the Unicode part of the answer for hosts
that call it.
"""

import json
from pathlib import Path

from base_glyph_filter_plugin import BaseGlyphFilterPlugin

# [ISO 15924 code, Unicode Script name] for every writing script in the
# editor's glyph data, sorted by name.
WRITING_SCRIPTS = json.loads(
    (Path(__file__).parent / "writing_scripts.json").read_text(encoding="utf-8")
)


def glyph_scripts(glyph):
    """Script_Extensions codes of the glyph, or its Script name, or ()."""
    data = getattr(glyph, "glyphData", None)
    if data is None:
        return ()

    def field(key):
        try:
            return data[key]
        except Exception:
            return getattr(data, key, None)

    extensions = field("script_extensions")
    if isinstance(extensions, str):
        extensions = extensions.split()
    if extensions:
        return tuple(str(code) for code in extensions)
    script = field("script")
    return (str(script),) if script else ()


class WritingScriptFilter(BaseGlyphFilterPlugin):
    """Glyphs whose writing scripts include one in `unicode_scripts`."""

    path = "scripts"
    unicode_scripts = ()
    hide_when_empty = True
    event_types = {"glyph.unicode.changed"}

    def visible(self):
        return True

    def classify_glyph(self, glyph):
        scripts = glyph_scripts(glyph) or ("",)
        return any(script in self.unicode_scripts for script in scripts)


def _make_filter(order, code, name, scripts, display_name):
    return type(
        f"{code}ScriptFilter",
        (WritingScriptFilter,),
        {
            "__doc__": f"Glyphs in the {display_name} writing script.",
            "unicode_scripts": scripts,
            "sort_order": order,
            "keyword": f"com.context.script.{code}",
            "display_name": display_name,
        },
    )


SCRIPT_FILTERS = {
    code: _make_filter(order, code, name, (name, code), name.replace("_", " "))
    for order, (code, name) in enumerate(WRITING_SCRIPTS)
}
SCRIPT_FILTERS["Zyyy"] = _make_filter(
    len(WRITING_SCRIPTS),
    "Zyyy",
    "Common",
    ("Common", "Zyyy", "Inherited", "Zinh"),
    "Common",
)
SCRIPT_FILTERS["Zzzz"] = _make_filter(
    len(WRITING_SCRIPTS) + 1, "Zzzz", "", ("",), "No Writing Script"
)
globals().update({cls.__name__: cls for cls in SCRIPT_FILTERS.values()})
