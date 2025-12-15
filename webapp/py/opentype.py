"""
OpenType feature information based on the OpenType specification.

This module contains data about OpenType features, specifically which features
are discretionary (subject to user control) and which of those are recommended
to be on by default according to the OpenType specification.

Data source: Microsoft OpenType Specification
https://learn.microsoft.com/en-us/typography/opentype/spec/
Last updated: December 2024 (based on spec last updated 05/31/2024 and 07/06/2024)
"""

from typing import Dict, Set

# Features that are discretionary (subject to user control) and recommended to be ON by default
DEFAULT_ON_FEATURES: Set[str] = {
    "calt",  # Contextual Alternates - "This feature should be active by default"
    "clig",  # Contextual Ligatures - "This feature should be active by default"
    "liga",  # Standard Ligatures - "This feature serves a critical function in some contexts and should be active by default"
    "kern",  # Kerning - "In most horizontal text layout, this feature should be active by default"
    "cpsp",  # Capital Spacing - "This feature should be on by default"
    "locl",  # Localized Forms - "This feature should always be applied" (technically required, but discretionary in implementation)
}

# Features that are discretionary (subject to user control) but OFF by default
DEFAULT_OFF_FEATURES: Set[str] = {
    "aalt",  # Access All Alternates
    "afrc",  # Alternative Fractions
    "case",  # Case-sensitive Forms
    "cpct",  # Centered CJK Punctuation
    "cswh",  # Contextual Swash
    "cv01",  # Character Variant 1
    "cv02",  # Character Variant 2
    "cv03",  # Character Variant 3
    "cv04",  # Character Variant 4
    "cv05",  # Character Variant 5
    "cv06",  # Character Variant 6
    "cv07",  # Character Variant 7
    "cv08",  # Character Variant 8
    "cv09",  # Character Variant 9
    "cv10",  # Character Variant 10
    "cv11",  # Character Variant 11
    "cv12",  # Character Variant 12
    "cv13",  # Character Variant 13
    "cv14",  # Character Variant 14
    "cv15",  # Character Variant 15
    "cv16",  # Character Variant 16
    "cv17",  # Character Variant 17
    "cv18",  # Character Variant 18
    "cv19",  # Character Variant 19
    "cv20",  # Character Variant 20
    "cv21",  # Character Variant 21
    "cv22",  # Character Variant 22
    "cv23",  # Character Variant 23
    "cv24",  # Character Variant 24
    "cv25",  # Character Variant 25
    "cv26",  # Character Variant 26
    "cv27",  # Character Variant 27
    "cv28",  # Character Variant 28
    "cv29",  # Character Variant 29
    "cv30",  # Character Variant 30
    "cv31",  # Character Variant 31
    "cv32",  # Character Variant 32
    "cv33",  # Character Variant 33
    "cv34",  # Character Variant 34
    "cv35",  # Character Variant 35
    "cv36",  # Character Variant 36
    "cv37",  # Character Variant 37
    "cv38",  # Character Variant 38
    "cv39",  # Character Variant 39
    "cv40",  # Character Variant 40
    "cv41",  # Character Variant 41
    "cv42",  # Character Variant 42
    "cv43",  # Character Variant 43
    "cv44",  # Character Variant 44
    "cv45",  # Character Variant 45
    "cv46",  # Character Variant 46
    "cv47",  # Character Variant 47
    "cv48",  # Character Variant 48
    "cv49",  # Character Variant 49
    "cv50",  # Character Variant 50
    "cv51",  # Character Variant 51
    "cv52",  # Character Variant 52
    "cv53",  # Character Variant 53
    "cv54",  # Character Variant 54
    "cv55",  # Character Variant 55
    "cv56",  # Character Variant 56
    "cv57",  # Character Variant 57
    "cv58",  # Character Variant 58
    "cv59",  # Character Variant 59
    "cv60",  # Character Variant 60
    "cv61",  # Character Variant 61
    "cv62",  # Character Variant 62
    "cv63",  # Character Variant 63
    "cv64",  # Character Variant 64
    "cv65",  # Character Variant 65
    "cv66",  # Character Variant 66
    "cv67",  # Character Variant 67
    "cv68",  # Character Variant 68
    "cv69",  # Character Variant 69
    "cv70",  # Character Variant 70
    "cv71",  # Character Variant 71
    "cv72",  # Character Variant 72
    "cv73",  # Character Variant 73
    "cv74",  # Character Variant 74
    "cv75",  # Character Variant 75
    "cv76",  # Character Variant 76
    "cv77",  # Character Variant 77
    "cv78",  # Character Variant 78
    "cv79",  # Character Variant 79
    "cv80",  # Character Variant 80
    "cv81",  # Character Variant 81
    "cv82",  # Character Variant 82
    "cv83",  # Character Variant 83
    "cv84",  # Character Variant 84
    "cv85",  # Character Variant 85
    "cv86",  # Character Variant 86
    "cv87",  # Character Variant 87
    "cv88",  # Character Variant 88
    "cv89",  # Character Variant 89
    "cv90",  # Character Variant 90
    "cv91",  # Character Variant 91
    "cv92",  # Character Variant 92
    "cv93",  # Character Variant 93
    "cv94",  # Character Variant 94
    "cv95",  # Character Variant 95
    "cv96",  # Character Variant 96
    "cv97",  # Character Variant 97
    "cv98",  # Character Variant 98
    "cv99",  # Character Variant 99
    "c2pc",  # Petite Capitals From Capitals
    "c2sc",  # Small Capitals From Capitals
    "dlig",  # Discretionary Ligatures
    "expt",  # Expert Forms
    "frac",  # Fractions
    "fwid",  # Full Widths
    "hist",  # Historical Forms
    "hkna",  # Horizontal Kana Alternates
    "hlig",  # Historical Ligatures
    "hojo",  # Hojo Kanji Forms
    "hwid",  # Half Widths
    "jp78",  # JIS78 Forms
    "jp83",  # JIS83 Forms
    "jp90",  # JIS90 Forms
    "jp04",  # JIS2004 Forms
    "lnum",  # Lining Figures (inactive by default)
    "mgrk",  # Mathematical Greek
    "nalt",  # Alternate Annotation Forms
    "nlck",  # NLC Kanji Forms
    "onum",  # Oldstyle Figures (inactive by default)
    "ordn",  # Ordinals
    "ornm",  # Ornaments
    "palt",  # Proportional Alternate Widths
    "pcap",  # Petite Capitals
    "pkna",  # Proportional Kana
    "pnum",  # Proportional Figures
    "pwid",  # Proportional Widths
    "qwid",  # Quarter Widths
    "rand",  # Randomize
    "salt",  # Stylistic Alternates
    "sinf",  # Scientific Inferiors
    "smcp",  # Small Capitals
    "ss01",  # Stylistic Set 1
    "ss02",  # Stylistic Set 2
    "ss03",  # Stylistic Set 3
    "ss04",  # Stylistic Set 4
    "ss05",  # Stylistic Set 5
    "ss06",  # Stylistic Set 6
    "ss07",  # Stylistic Set 7
    "ss08",  # Stylistic Set 8
    "ss09",  # Stylistic Set 9
    "ss10",  # Stylistic Set 10
    "ss11",  # Stylistic Set 11
    "ss12",  # Stylistic Set 12
    "ss13",  # Stylistic Set 13
    "ss14",  # Stylistic Set 14
    "ss15",  # Stylistic Set 15
    "ss16",  # Stylistic Set 16
    "ss17",  # Stylistic Set 17
    "ss18",  # Stylistic Set 18
    "ss19",  # Stylistic Set 19
    "ss20",  # Stylistic Set 20
    "subs",  # Subscript
    "sups",  # Superscript
    "swsh",  # Swash
    "titl",  # Titling
    "tnum",  # Tabular Figures
    "trad",  # Traditional Forms
    "twid",  # Third Widths
    "unic",  # Unicase
    "zero",  # Slashed Zero
}

# All discretionary features (on by default + off by default)
DISCRETIONARY_FEATURES: Set[str] = DEFAULT_ON_FEATURES | DEFAULT_OFF_FEATURES

# Features that are required (not subject to user control, always applied)
REQUIRED_FEATURES: Set[str] = {
    "abvf",  # Above-base Forms
    "abvm",  # Above-base Mark Positioning
    "abvs",  # Above-base Substitutions
    "akhn",  # Akhand
    "blwf",  # Below-base Forms
    "blwm",  # Below-base Mark Positioning
    "blws",  # Below-base Substitutions
    "ccmp",  # Glyph Composition/Decomposition - "This feature should always be applied"
    "cfar",  # Conjunct Form After Ro
    "cjct",  # Conjunct Forms
    "curs",  # Cursive Positioning
    "dist",  # Distances
    "dtls",  # Dotless Forms
    "fin2",  # Terminal Forms #2
    "fin3",  # Terminal Forms #3
    "fina",  # Terminal Forms
    "flac",  # Flattened Accent Forms
    "half",  # Half Forms
    "haln",  # Halant Forms
    "init",  # Initial Forms
    "isol",  # Isolated Forms
    "jalt",  # Justification Alternates
    "ljmo",  # Leading Jamo Forms
    "mark",  # Mark Positioning
    "med2",  # Medial Forms #2
    "medi",  # Medial Forms
    "mkmk",  # Mark to Mark Positioning
    "mset",  # Mark Positioning via Substitution (deprecated)
    "nukt",  # Nukta Forms
    "pref",  # Pre-base Forms
    "pres",  # Pre-base Substitutions
    "pstf",  # Post-base Forms
    "psts",  # Post-base Substitutions
    "rclt",  # Required Contextual Alternates
    "rlig",  # Required Ligatures
    "rphf",  # Reph Form
    "rkrf",  # Rakar Forms
    "rvrn",  # Required Variation Alternates
    "tjmo",  # Trailing Jamo Forms
    "vjmo",  # Vowel Jamo Forms
    "vatu",  # Vattu Variants
}

# Feature descriptions for documentation purposes
FEATURE_DESCRIPTIONS: Dict[str, str] = {
    # Discretionary features (on by default)
    "calt": "Contextual Alternates - Replaces default glyphs with alternate forms in specified contexts",
    "clig": "Contextual Ligatures - Replaces sequences with ligatures in specified contexts",
    "liga": "Standard Ligatures - Replaces sequences with ligatures preferred for normal conditions",
    "kern": "Kerning - Adjusts space between specific glyph pairs for optically consistent spacing",
    "cpsp": "Capital Spacing - Adjusts inter-glyph spacing for all-capital text",
    "locl": "Localized Forms - Substitutes glyphs with localized forms for specific languages",
    
    # Discretionary features (off by default)
    "aalt": "Access All Alternates - Makes all variations of selected characters accessible",
    "afrc": "Alternative Fractions - Replaces figures separated by slash with fraction forms",
    "case": "Case-sensitive Forms - Shifts punctuation marks for all-capital sequences",
    "cpct": "Centered CJK Punctuation - Centers specific punctuation marks",
    "cswh": "Contextual Swash - Replaces default glyphs with swash glyphs in specified contexts",
    "c2pc": "Petite Capitals From Capitals - Turns capital characters into petite capitals",
    "c2sc": "Small Capitals From Capitals - Turns capital characters into small capitals",
    "dlig": "Discretionary Ligatures - Replaces sequences with ligatures for special effect",
    "expt": "Expert Forms - Replaces standard forms with corresponding expert forms",
    "frac": "Fractions - Replaces figures separated by slash with diagonal fractions",
    "fwid": "Full Widths - Replaces glyphs with full-width variants",
    "hist": "Historical Forms - Replaces default forms with historical alternates",
    "hkna": "Horizontal Kana Alternates - Replaces kana with forms designed for horizontal writing",
    "hlig": "Historical Ligatures - Replaces default forms with historical ligature alternates",
    "hojo": "Hojo Kanji Forms - Accesses JIS X 0212-1990 glyphs",
    "hwid": "Half Widths - Replaces glyphs with half-em width variants",
    "jp78": "JIS78 Forms - Replaces default Japanese glyphs with JIS C 6226-1978 forms",
    "jp83": "JIS83 Forms - Replaces default Japanese glyphs with JIS X 0208-1983 forms",
    "jp90": "JIS90 Forms - Replaces Japanese glyphs with JIS X 0208-1990 forms",
    "jp04": "JIS2004 Forms - Accesses prototypical glyphs from JIS X 0213:2004",
    "lnum": "Lining Figures - Changes non-lining figures to lining figures",
    "mgrk": "Mathematical Greek - Replaces Greek glyphs with forms used in mathematical notation",
    "nalt": "Alternate Annotation Forms - Replaces glyphs with notational forms",
    "nlck": "NLC Kanji Forms - Accesses NLC-defined glyph shapes for JIS characters",
    "onum": "Oldstyle Figures - Changes figures from default/lining style to oldstyle form",
    "ordn": "Ordinals - Replaces alphabetic glyphs with corresponding ordinal forms",
    "ornm": "Ornaments - Provides access to ornament glyphs",
    "palt": "Proportional Alternate Widths - Re-spaces glyphs to fit proportional widths",
    "pcap": "Petite Capitals - Turns lowercase characters into petite capitals",
    "pkna": "Proportional Kana - Replaces fixed-width kana with proportional forms",
    "pnum": "Proportional Figures - Replaces tabular figures with proportional figures",
    "pwid": "Proportional Widths - Replaces glyphs with proportional-width variants",
    "qwid": "Quarter Widths - Replaces glyphs with quarter-width variants",
    "rand": "Randomize - Replaces glyphs with random alternates",
    "salt": "Stylistic Alternates - Replaces default glyphs with stylistic alternates",
    "sinf": "Scientific Inferiors - Replaces glyphs with scientific inferior forms",
    "smcp": "Small Capitals - Turns lowercase characters into small capitals",
    "subs": "Subscript - Replaces glyphs with subscript forms",
    "sups": "Superscript - Replaces glyphs with superscript forms",
    "swsh": "Swash - Replaces default glyphs with swash glyphs",
    "titl": "Titling - Replaces glyphs with forms designed for large sizes",
    "tnum": "Tabular Figures - Replaces proportional figures with tabular figures",
    "trad": "Traditional Forms - Replaces simplified forms with traditional forms",
    "twid": "Third Widths - Replaces glyphs with third-width variants",
    "unic": "Unicase - Replaces glyphs with unicase forms",
    "zero": "Slashed Zero - Replaces standard zero with slashed zero",
}

# Add descriptions for character variant features
for i in range(1, 100):
    cv_tag = f"cv{i:02d}"
    FEATURE_DESCRIPTIONS[cv_tag] = f"Character Variant {i} - Provides glyph variants for specific characters"

# Add descriptions for stylistic set features
for i in range(1, 21):
    ss_tag = f"ss{i:02d}"
    FEATURE_DESCRIPTIONS[ss_tag] = f"Stylistic Set {i} - Applies stylistic variant glyphs as a set"


def is_discretionary(feature_tag: str) -> bool:
    """
    Check if a feature is discretionary (subject to user control).
    
    Args:
        feature_tag: Four-character OpenType feature tag
        
    Returns:
        True if the feature is discretionary, False if required
    """
    return feature_tag in DISCRETIONARY_FEATURES


def is_default_on(feature_tag: str) -> bool:
    """
    Check if a discretionary feature is recommended to be on by default.
    
    Args:
        feature_tag: Four-character OpenType feature tag
        
    Returns:
        True if the feature should be on by default, False otherwise.
        For required features, returns False as they are always on.
    """
    return feature_tag in DEFAULT_ON_FEATURES


def get_feature_description(feature_tag: str) -> str:
    """
    Get the description of an OpenType feature.
    
    Args:
        feature_tag: Four-character OpenType feature tag
        
    Returns:
        Description string, or empty string if not found
    """
    return FEATURE_DESCRIPTIONS.get(feature_tag, "")
