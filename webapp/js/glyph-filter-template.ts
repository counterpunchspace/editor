/** Build the shared starter source for a simple glyph filter. */
export function createGlyphFilterTemplate(name: string = 'New Filter'): string {
    // The module docstring is the filter's description; it starts empty.
    return `"""
"""

# "${name}" Filter
#
# A filter handles one glyph at a time.
#
# classify_glyph(glyph) is the mandatory method called once
# per glyph. It should return one of the following:
# Return False to not show a glyph at all.
# Return True to show a glyph without a group.
# Return a groups mapping to show and categorize a glyph.
# 
# is_candidate(glyph) is an optional method that can
# be used to quickly filter out glyphs that cannot match.
# It is called before classify_glyph(glyph)
# and can be used to improve performance for large fonts
# or when the main classify_glyph() method is expensive to compute.

# Example:
# Re-run this filter only when Unicode assignments change.
# See the full list at
# https://github.com/counterpunchspace/editor/blob/main/developer-docs/GLYPH_FILTER_EVENTS.md
EVENT_TYPES = ["glyph.unicode.changed"]

# def is_candidate(glyph):
#     """Optional fast gate. Perform fast matching here,
#     such as filtering for parts of a glyph name."""
#     return True

def classify_glyph(glyph):
    """Return False, True, or a mapping with complete group definitions."""
    # Example: show glyphs without Unicode assignments.
    if not glyph.codepoints:
        return True

    # Example: show an encoded glyph in a colored group instead.
    # return {
    #     "groups": [
    #         {"name": "Encoded", "color": "blue"}
    #     ]
    # }

    return False
`;
}
