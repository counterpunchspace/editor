/**
 * OpenType feature information based on the OpenType specification.
 *
 * This module contains data about OpenType features, specifically which features
 * are discretionary (subject to user control) and which of those are recommended
 * to be on by default according to the OpenType specification.
 *
 * Data source: Microsoft OpenType Specification
 * https://learn.microsoft.com/en-us/typography/opentype/spec/
 * Last updated: December 2024 (based on spec last updated 05/31/2024 and 07/06/2024)
 */

import { Logger } from './logger';

const console = new Logger('OpentypeFeatures');

// Features that are discretionary (subject to user control) and recommended to be ON by default
export const DEFAULT_ON_FEATURES = new Set([
    'calt', // Contextual Alternates - "This feature should be active by default"
    'clig', // Contextual Ligatures - "This feature should be active by default"
    'liga', // Standard Ligatures - "This feature serves a critical function in some contexts and should be active by default"
    'kern', // Kerning - "In most horizontal text layout, this feature should be active by default"
    'cpsp', // Capital Spacing - "This feature should be on by default"
    'locl' // Localized Forms - "This feature should always be applied" (technically required, but discretionary in implementation)
]);

// Features that are discretionary (subject to user control) but OFF by default
export const DEFAULT_OFF_FEATURES = new Set([
    // 'aalt', // Access All Alternates
    'afrc', // Alternative Fractions
    'case', // Case-sensitive Forms
    'cpct', // Centered CJK Punctuation
    'cswh', // Contextual Swash
    'cv01',
    'cv02',
    'cv03',
    'cv04',
    'cv05',
    'cv06',
    'cv07',
    'cv08',
    'cv09',
    'cv10',
    'cv11',
    'cv12',
    'cv13',
    'cv14',
    'cv15',
    'cv16',
    'cv17',
    'cv18',
    'cv19',
    'cv20',
    'cv21',
    'cv22',
    'cv23',
    'cv24',
    'cv25',
    'cv26',
    'cv27',
    'cv28',
    'cv29',
    'cv30',
    'cv31',
    'cv32',
    'cv33',
    'cv34',
    'cv35',
    'cv36',
    'cv37',
    'cv38',
    'cv39',
    'cv40',
    'cv41',
    'cv42',
    'cv43',
    'cv44',
    'cv45',
    'cv46',
    'cv47',
    'cv48',
    'cv49',
    'cv50',
    'cv51',
    'cv52',
    'cv53',
    'cv54',
    'cv55',
    'cv56',
    'cv57',
    'cv58',
    'cv59',
    'cv60',
    'cv61',
    'cv62',
    'cv63',
    'cv64',
    'cv65',
    'cv66',
    'cv67',
    'cv68',
    'cv69',
    'cv70',
    'cv71',
    'cv72',
    'cv73',
    'cv74',
    'cv75',
    'cv76',
    'cv77',
    'cv78',
    'cv79',
    'cv80',
    'cv81',
    'cv82',
    'cv83',
    'cv84',
    'cv85',
    'cv86',
    'cv87',
    'cv88',
    'cv89',
    'cv90',
    'cv91',
    'cv92',
    'cv93',
    'cv94',
    'cv95',
    'cv96',
    'cv97',
    'cv98',
    'cv99',
    'c2pc', // Petite Capitals From Capitals
    'c2sc', // Small Capitals From Capitals
    'dlig', // Discretionary Ligatures
    'expt', // Expert Forms
    'frac', // Fractions
    'fwid', // Full Widths
    'hist', // Historical Forms
    'hkna', // Horizontal Kana Alternates
    'hlig', // Historical Ligatures
    'hojo', // Hojo Kanji Forms
    'hwid', // Half Widths
    'jp78', // JIS78 Forms
    'jp83', // JIS83 Forms
    'jp90', // JIS90 Forms
    'jp04', // JIS2004 Forms
    'lnum', // Lining Figures (inactive by default)
    'mgrk', // Mathematical Greek
    'nalt', // Alternate Annotation Forms
    'nlck', // NLC Kanji Forms
    'onum', // Oldstyle Figures (inactive by default)
    'ordn', // Ordinals
    'ornm', // Ornaments
    'palt', // Proportional Alternate Widths
    'pcap', // Petite Capitals
    'pkna', // Proportional Kana
    'pnum', // Proportional Figures
    'pwid', // Proportional Widths
    'qwid', // Quarter Widths
    'rand', // Randomize
    'salt', // Stylistic Alternates
    'sinf', // Scientific Inferiors
    'smcp', // Small Capitals
    'ss01', // Stylistic Set 1
    'ss02', // Stylistic Set 2
    'ss03', // Stylistic Set 3
    'ss04', // Stylistic Set 4
    'ss05', // Stylistic Set 5
    'ss06', // Stylistic Set 6
    'ss07', // Stylistic Set 7
    'ss08', // Stylistic Set 8
    'ss09', // Stylistic Set 9
    'ss10', // Stylistic Set 10
    'ss11', // Stylistic Set 11
    'ss12', // Stylistic Set 12
    'ss13', // Stylistic Set 13
    'ss14', // Stylistic Set 14
    'ss15', // Stylistic Set 15
    'ss16', // Stylistic Set 16
    'ss17', // Stylistic Set 17
    'ss18', // Stylistic Set 18
    'ss19', // Stylistic Set 19
    'ss20', // Stylistic Set 20
    'subs', // Subscript
    'sups', // Superscript
    'swsh', // Swash
    'titl', // Titling
    'tnum', // Tabular Figures
    'trad', // Traditional Forms
    'twid', // Third Widths
    'unic', // Unicase
    'zero' // Slashed Zero
]);

// All discretionary features (on by default + off by default)
export const DISCRETIONARY_FEATURES = new Set([
    ...DEFAULT_ON_FEATURES,
    ...DEFAULT_OFF_FEATURES
]);

/**
 * OpenType feature execution order per writing script.
 *
 * Based on HarfBuzz shaping engine implementation (https://github.com/harfbuzz/harfbuzz).
 * Features are applied in the order listed below. Stages marked with "PAUSE" indicate
 * GSUB processing pauses for reordering operations.
 *
 * User features (discretionary features controlled by users) are applied at specific
 * points in the pipeline, indicated by "USER_FEATURES" markers.
 *
 * Note: This represents the standard HarfBuzz implementation. Actual behavior may vary
 * based on shaper implementation and font design.
 *
 * Last updated: December 2024 (HarfBuzz main branch)
 */
export const FEATURE_EXECUTION_ORDER: Record<string, string[]> = {
    /**
     * Default shaper - used for Latin, Cyrillic, Greek, and other scripts without
     * script-specific shaping requirements.
     */
    default: [
        // Required variation alternates
        'rvrn', // Required Variation Alternates
        '--- GSUB PAUSE ---',

        // Directional features (applied based on text direction)
        'ltra',
        'ltrm', // LTR direction (horizontal)
        'rtla',
        'rtlm', // RTL direction (horizontal)

        // Automatic features
        'frac',
        'numr',
        'dnom', // Fractions (if enabled)
        'rand', // Randomize

        // Common features - applied to all scripts
        'abvm', // Above-base Mark Positioning
        'blwm', // Below-base Mark Positioning
        'ccmp', // Glyph Composition/Decomposition
        'locl', // Localized Forms
        'mark', // Mark Positioning
        'mkmk', // Mark to Mark Positioning
        'rlig', // Required Ligatures

        // Default horizontal features
        'calt', // Contextual Alternates
        'clig', // Contextual Ligatures
        'curs', // Cursive Positioning
        'dist', // Distances
        'kern', // Kerning
        'liga', // Standard Ligatures
        'rclt', // Required Contextual Alternates

        // Vertical text features (if vertical direction)
        'vert', // Vertical Alternates

        // USER FEATURES APPLIED HERE
        '--- USER FEATURES ---',

        // GPOS positioning features applied after substitutions
        '--- GPOS STAGE ---'
    ],

    /**
     * Arabic shaper - used for Arabic, N'Ko, Syriac, and Mongolian scripts.
     */
    arabic: [
        'rvrn', // Required Variation Alternates
        '--- GSUB PAUSE ---',
        'ccmp', // Glyph Composition/Decomposition
        'locl', // Localized Forms
        '--- GSUB PAUSE ---',

        'stch', // Stretching (Arabic kashida)
        '--- GSUB PAUSE ---',

        // Joining features (applied with pauses between each)
        'isol', // Isolated Forms
        '--- GSUB PAUSE ---',
        'fina', // Terminal Forms
        '--- GSUB PAUSE ---',
        'fin2', // Terminal Forms #2
        '--- GSUB PAUSE ---',
        'fin3', // Terminal Forms #3
        '--- GSUB PAUSE ---',
        'medi', // Medial Forms
        '--- GSUB PAUSE ---',
        'med2', // Medial Forms #2
        '--- GSUB PAUSE ---',
        'init', // Initial Forms
        '--- GSUB PAUSE ---',

        'rlig', // Required Ligatures
        'rclt', // Required Contextual Alternates
        '--- GSUB PAUSE ---',

        'calt', // Contextual Alternates

        // USER FEATURES (liga, clig) APPLIED HERE
        '--- USER FEATURES ---',

        'mset', // Mark Positioning via Substitution

        // GPOS features
        '--- GPOS STAGE ---',
        'curs', // Cursive Positioning
        'kern', // Kerning
        'mark', // Mark Positioning
        'mkmk' // Mark to Mark Positioning
    ],

    /**
     * Indic shapers - used for Devanagari, Bengali, Gujarati, Gurmukhi, Kannada,
     * Malayalam, Oriya, Tamil, Telugu.
     */
    indic: [
        'rvrn', // Required Variation Alternates
        '--- GSUB PAUSE (setup syllables) ---',

        'locl', // Localized Forms
        'ccmp', // Glyph Composition/Decomposition
        '--- GSUB PAUSE (initial reordering) ---',

        // Basic features (applied with pauses between each)
        'nukt', // Nukta Forms
        '--- GSUB PAUSE ---',
        'akhn', // Akhand
        '--- GSUB PAUSE ---',
        'rphf', // Reph Form
        '--- GSUB PAUSE ---',
        'rkrf', // Rakar Forms
        '--- GSUB PAUSE ---',
        'pref', // Pre-base Forms
        '--- GSUB PAUSE ---',
        'blwf', // Below-base Forms
        '--- GSUB PAUSE ---',
        'abvf', // Above-base Forms
        '--- GSUB PAUSE ---',
        'half', // Half Forms
        '--- GSUB PAUSE ---',
        'pstf', // Post-base Forms
        '--- GSUB PAUSE ---',
        'vatu', // Vattu Variants
        '--- GSUB PAUSE ---',
        'cjct', // Conjunct Forms

        '--- GSUB PAUSE (final reordering) ---',

        // Other features (applied after reordering)
        'init', // Initial Forms
        'pres', // Pre-base Substitutions
        'abvs', // Above-base Substitutions
        'blws', // Below-base Substitutions
        'psts', // Post-base Substitutions
        'haln', // Halant Forms

        // Note: 'liga' is disabled by default in Indic scripts

        // USER FEATURES APPLIED HERE (except liga)
        '--- USER FEATURES ---',

        // GPOS features
        '--- GPOS STAGE ---',
        'abvm', // Above-base Mark Positioning
        'blwm', // Below-base Mark Positioning
        'dist', // Distances
        'mark', // Mark Positioning
        'mkmk' // Mark to Mark Positioning
    ],

    /**
     * Myanmar (Burmese) shaper.
     */
    myanmar: [
        'rvrn', // Required Variation Alternates
        '--- GSUB PAUSE (setup syllables) ---',

        'locl', // Localized Forms
        'ccmp', // Glyph Composition/Decomposition

        '--- GSUB PAUSE (reorder) ---',

        // Basic features (applied with pauses between each)
        'rphf', // Reph Form
        '--- GSUB PAUSE ---',
        'pref', // Pre-base Forms
        '--- GSUB PAUSE ---',
        'blwf', // Below-base Forms
        '--- GSUB PAUSE ---',
        'pstf', // Post-base Forms

        '--- GSUB PAUSE (clear syllables) ---',

        // Other features
        'pres', // Pre-base Substitutions
        'abvs', // Above-base Substitutions
        'blws', // Below-base Substitutions
        'psts', // Post-base Substitutions
        'haln', // Halant Forms

        // USER FEATURES APPLIED HERE
        '--- USER FEATURES ---',

        // GPOS features
        '--- GPOS STAGE ---',
        'mark', // Mark Positioning
        'mkmk' // Mark to Mark Positioning
    ],

    /**
     * Khmer (Cambodian) shaper.
     */
    khmer: [
        'rvrn', // Required Variation Alternates
        '--- GSUB PAUSE (setup syllables) ---',
        '--- GSUB PAUSE (reorder) ---',

        'locl', // Localized Forms
        'ccmp', // Glyph Composition/Decomposition

        // Basic features (no pauses between in Khmer)
        'pref', // Pre-base Forms
        'blwf', // Below-base Forms
        'abvf', // Above-base Forms
        'pstf', // Post-base Forms
        'cfar', // Conjunct Form After Ro

        // Other features
        'pres', // Pre-base Substitutions
        'abvs', // Above-base Substitutions
        'blws', // Below-base Substitutions
        'psts', // Post-base Substitutions

        // Note: 'clig' is enabled by default, 'liga' is disabled
        'clig', // Contextual Ligatures

        // USER FEATURES APPLIED HERE (except liga which is disabled)
        '--- USER FEATURES ---',

        // GPOS features
        '--- GPOS STAGE ---',
        'mark', // Mark Positioning
        'mkmk' // Mark to Mark Positioning
    ],

    /**
     * USE (Universal Shaping Engine) - used for many scripts including
     * Balinese, Javanese, Lao, Thai (new behavior), and others.
     */
    use: [
        'rvrn', // Required Variation Alternates
        '--- GSUB PAUSE (setup syllables) ---',

        // Default glyph pre-processing group
        'locl', // Localized Forms
        'ccmp', // Glyph Composition/Decomposition
        'nukt', // Nukta Forms
        'akhn', // Akhand

        // Reordering group
        '--- GSUB PAUSE (clear substitution flags) ---',
        'rphf', // Reph Form
        '--- GSUB PAUSE (record rphf) ---',
        '--- GSUB PAUSE (clear substitution flags) ---',
        'pref', // Pre-base Forms
        '--- GSUB PAUSE (record pref) ---',

        // Orthographic unit shaping group
        'rkrf', // Rakar Forms
        'abvf', // Above-base Forms
        'blwf', // Below-base Forms
        'half', // Half Forms
        'pstf', // Post-base Forms
        'vatu', // Vattu Variants
        'cjct', // Conjunct Forms

        '--- GSUB PAUSE (reorder) ---',
        '--- GSUB PAUSE (clear syllables) ---',

        // Topographical features
        'isol', // Isolated Forms
        'init', // Initial Forms
        'medi', // Medial Forms
        'fina', // Terminal Forms

        '--- GSUB PAUSE ---',

        // Standard typographic presentation
        'abvs', // Above-base Substitutions
        'blws', // Below-base Substitutions
        'psts', // Post-base Substitutions
        'haln', // Halant Forms
        'calt', // Contextual Alternates
        'clig', // Contextual Ligatures
        'liga', // Standard Ligatures

        // USER FEATURES APPLIED HERE
        '--- USER FEATURES ---',

        // GPOS features
        '--- GPOS STAGE ---',
        'abvm', // Above-base Mark Positioning
        'blwm', // Below-base Mark Positioning
        'mark', // Mark Positioning
        'mkmk' // Mark to Mark Positioning
    ],

    /**
     * Hangul (Korean) shaper.
     */
    hangul: [
        'rvrn', // Required Variation Alternates
        '--- GSUB PAUSE ---',

        'ljmo', // Leading Jamo Forms
        'vjmo', // Vowel Jamo Forms
        'tjmo', // Trailing Jamo Forms

        // USER FEATURES APPLIED HERE
        '--- USER FEATURES ---',

        // Common features
        'ccmp', // Glyph Composition/Decomposition
        'locl', // Localized Forms

        // GPOS features
        '--- GPOS STAGE ---'
    ],

    /**
     * Hebrew shaper - similar to default shaper with mark positioning.
     */
    hebrew: [
        'rvrn', // Required Variation Alternates
        '--- GSUB PAUSE ---',

        // Common features
        'ccmp', // Glyph Composition/Decomposition
        'locl', // Localized Forms

        // Discretionary features
        'calt', // Contextual Alternates
        'clig', // Contextual Ligatures
        'liga', // Standard Ligatures
        'rclt', // Required Contextual Alternates
        'rlig', // Required Ligatures

        // USER FEATURES APPLIED HERE
        '--- USER FEATURES ---',

        // GPOS features
        '--- GPOS STAGE ---',
        'kern', // Kerning
        'mark', // Mark Positioning
        'mkmk' // Mark to Mark Positioning
    ],

    /**
     * Thai shaper (old behavior) - similar to USE for new behavior.
     */
    thai: [
        'rvrn', // Required Variation Alternates
        '--- GSUB PAUSE ---',

        'ccmp', // Glyph Composition/Decomposition
        'locl', // Localized Forms

        // USER FEATURES APPLIED HERE
        '--- USER FEATURES ---',

        // GPOS features
        '--- GPOS STAGE ---',
        'kern', // Kerning
        'mark', // Mark Positioning
        'mkmk' // Mark to Mark Positioning
    ]
};

/**
 * Mapping of OpenType script tags to shaper names.
 *
 * This maps four-character OpenType script tags to the corresponding
 * HarfBuzz shaper implementation that determines feature execution order.
 *
 * Based on HarfBuzz shaper categorization (hb-ot-shaper.hh and script-specific shapers).
 */
export const SCRIPT_TO_SHAPER: Record<string, string> = {
    // Default shaper - Latin, Cyrillic, Greek and most other scripts
    'DFLT': 'default',
    'latn': 'default',
    'cyrl': 'default',
    'grek': 'default',
    'armn': 'default', // Armenian
    'geor': 'default', // Georgian
    'geok': 'default', // Georgian Khutsuri
    'ethi': 'default', // Ethiopic
    'cher': 'default', // Cherokee
    'cans': 'default', // Canadian Aboriginal
    'ogam': 'default', // Ogham
    'runr': 'default', // Runic
    'yi  ': 'default', // Yi

    // Arabic shaper - Arabic and related scripts
    'arab': 'arabic', // Arabic
    'nko ': 'arabic', // N'Ko
    'syrc': 'arabic', // Syriac
    'mong': 'arabic', // Mongolian
    'phag': 'arabic', // Phags-pa
    'mand': 'arabic', // Mandaic
    'phlp': 'arabic', // Psalter Pahlavi
    'avst': 'arabic', // Avestan

    // Indic shapers - Brahmic scripts
    'deva': 'indic', // Devanagari
    'beng': 'indic', // Bengali
    'guru': 'indic', // Gurmukhi
    'gujr': 'indic', // Gujarati
    'orya': 'indic', // Oriya
    'taml': 'indic', // Tamil
    'telu': 'indic', // Telugu
    'knda': 'indic', // Kannada
    'mlym': 'indic', // Malayalam
    'sinh': 'indic', // Sinhala

    // Myanmar shaper
    'mymr': 'myanmar', // Myanmar (Burmese)

    // Khmer shaper
    'khmr': 'khmer', // Khmer (Cambodian)

    // Hangul shaper
    'hang': 'hangul', // Hangul (Korean)

    // Hebrew shaper
    'hebr': 'hebrew', // Hebrew

    // Thai shaper (old behavior)
    'thai': 'thai', // Thai

    // USE (Universal Shaping Engine) - many scripts
    'bali': 'use', // Balinese
    'batk': 'use', // Batak
    'bugi': 'use', // Buginese
    'buhd': 'use', // Buhid
    'cham': 'use', // Cham
    'dupl': 'use', // Duployan
    'egyp': 'use', // Egyptian Hieroglyphs
    'gran': 'use', // Grantha
    'hano': 'use', // Hanunoo
    'java': 'use', // Javanese
    'kali': 'use', // Kayah Li
    'khar': 'use', // Kharoshthi
    'khoj': 'use', // Khojki
    'sind': 'use', // Khudawadi
    'lana': 'use', // Tai Tham (Lanna)
    'lao ': 'use', // Lao
    'lepc': 'use', // Lepcha
    'limb': 'use', // Limbu
    'mahj': 'use', // Mahajani
    'mani': 'use', // Manichaean
    'marc': 'use', // Marchen
    'mtei': 'use', // Meetei Mayek
    'modi': 'use', // Modi
    'mult': 'use', // Multani
    'newa': 'use', // Newa
    'pauc': 'use', // Pau Cin Hau
    'rjng': 'use', // Rejang
    'saur': 'use', // Saurashtra
    'shrd': 'use', // Sharada
    'sidd': 'use', // Siddham
    'sund': 'use', // Sundanese
    'sylo': 'use', // Syloti Nagri
    'tagb': 'use', // Tagbanwa
    'takr': 'use', // Takri
    'tale': 'use', // Tai Le
    'talu': 'use', // New Tai Lue
    'tavt': 'use', // Tai Viet
    'tfng': 'use', // Tifinagh
    'tirh': 'use', // Tirhuta
    'brah': 'use', // Brahmi
    'cakm': 'use' // Chakma
};

/**
 * Get the feature execution order for a given script.
 *
 * @param script - Script tag (e.g., 'latn', 'arab', 'deva') or shaper name
 * @returns Array of features in execution order, or default order if script not found
 */
export function getFeatureExecutionOrder(script: string): string[] {
    const shaper =
        SCRIPT_TO_SHAPER[script.toLowerCase()] || script.toLowerCase();
    return (
        FEATURE_EXECUTION_ORDER[shaper] || FEATURE_EXECUTION_ORDER['default']
    );
}

// Feature descriptions for documentation purposes
export const FEATURE_DESCRIPTIONS: Record<string, string> = {
    // Discretionary features (on by default)
    calt: 'Contextual Alternates - Replaces default glyphs with alternate forms in specified contexts',
    clig: 'Contextual Ligatures - Replaces sequences with ligatures in specified contexts',
    liga: 'Standard Ligatures - Replaces sequences with ligatures preferred for normal conditions',
    kern: 'Kerning - Adjusts space between specific glyph pairs for optically consistent spacing',
    cpsp: 'Capital Spacing - Adjusts inter-glyph spacing for all-capital text',
    locl: 'Localized Forms - Substitutes glyphs with localized forms for specific languages',

    // Discretionary features (off by default)
    aalt: 'Access All Alternates - Makes all variations of selected characters accessible',
    afrc: 'Alternative Fractions - Replaces figures separated by slash with fraction forms',
    case: 'Case-sensitive Forms - Shifts punctuation marks for all-capital sequences',
    cpct: 'Centered CJK Punctuation - Centers specific punctuation marks',
    cswh: 'Contextual Swash - Replaces default glyphs with swash glyphs in specified contexts',
    c2pc: 'Petite Capitals From Capitals - Turns capital characters into petite capitals',
    c2sc: 'Small Capitals From Capitals - Turns capital characters into small capitals',
    dlig: 'Discretionary Ligatures - Replaces sequences with ligatures for special effect',
    expt: 'Expert Forms - Replaces standard forms with corresponding expert forms',
    frac: 'Fractions - Replaces figures separated by slash with diagonal fractions',
    fwid: 'Full Widths - Replaces glyphs with full-width variants',
    hist: 'Historical Forms - Replaces default forms with historical alternates',
    hkna: 'Horizontal Kana Alternates - Replaces kana with forms designed for horizontal writing',
    hlig: 'Historical Ligatures - Replaces default forms with historical ligature alternates',
    hojo: 'Hojo Kanji Forms - Accesses JIS X 0212-1990 glyphs',
    hwid: 'Half Widths - Replaces glyphs with half-em width variants',
    jp78: 'JIS78 Forms - Replaces default Japanese glyphs with JIS C 6226-1978 forms',
    jp83: 'JIS83 Forms - Replaces default Japanese glyphs with JIS X 0208-1983 forms',
    jp90: 'JIS90 Forms - Replaces Japanese glyphs with JIS X 0208-1990 forms',
    jp04: 'JIS2004 Forms - Accesses prototypical glyphs from JIS X 0213:2004',
    lnum: 'Lining Figures - Changes non-lining figures to lining figures',
    mgrk: 'Mathematical Greek - Replaces Greek glyphs with forms used in mathematical notation',
    nalt: 'Alternate Annotation Forms - Replaces glyphs with notational forms',
    nlck: 'NLC Kanji Forms - Accesses NLC-defined glyph shapes for JIS characters',
    onum: 'Oldstyle Figures - Changes figures from default/lining style to oldstyle form',
    ordn: 'Ordinals - Replaces alphabetic glyphs with corresponding ordinal forms',
    ornm: 'Ornaments - Provides access to ornament glyphs',
    palt: 'Proportional Alternate Widths - Re-spaces glyphs to fit proportional widths',
    pcap: 'Petite Capitals - Turns lowercase characters into petite capitals',
    pkna: 'Proportional Kana - Replaces fixed-width kana with proportional forms',
    pnum: 'Proportional Figures - Replaces tabular figures with proportional figures',
    pwid: 'Proportional Widths - Replaces glyphs with proportional-width variants',
    qwid: 'Quarter Widths - Replaces glyphs with quarter-width variants',
    rand: 'Randomize - Replaces glyphs with random alternates',
    salt: 'Stylistic Alternates - Replaces default glyphs with stylistic alternates',
    sinf: 'Scientific Inferiors - Replaces glyphs with scientific inferior forms',
    smcp: 'Small Capitals - Turns lowercase characters into small capitals',
    subs: 'Subscript - Replaces glyphs with subscript forms',
    sups: 'Superscript - Replaces glyphs with superscript forms',
    swsh: 'Swash - Replaces default glyphs with swash glyphs',
    titl: 'Titling - Replaces glyphs with forms designed for large sizes',
    tnum: 'Tabular Figures - Replaces proportional figures with tabular figures',
    trad: 'Traditional Forms - Replaces simplified forms with traditional forms',
    twid: 'Third Widths - Replaces glyphs with third-width variants',
    unic: 'Unicase - Replaces glyphs with unicase forms',
    zero: 'Slashed Zero - Replaces standard zero with slashed zero',

    // Required features (always applied, not discretionary)
    abvf: 'Above-base Forms - Positions marks above base characters',
    abvm: 'Above-base Mark Positioning - Positions marks above base glyphs',
    abvs: 'Above-base Substitutions - Substitutes ligatures for above-base mark combinations',
    akhn: 'Akhand - Joins consonant combinations into ligatures in Indic scripts',
    blwf: 'Below-base Forms - Positions marks below base characters',
    blwm: 'Below-base Mark Positioning - Positions marks below base glyphs',
    blws: 'Below-base Substitutions - Substitutes ligatures for below-base mark combinations',
    cfar: 'Conjunct Form After Ro - Special conjunct forms after reph in Khmer',
    cjct: 'Conjunct Forms - Forms conjuncts in Indic scripts',
    curs: 'Cursive Positioning - Fine-tunes cursive attachment positions',
    dist: 'Distances - Controls distances between glyphs',
    dtls: 'Dotless Forms - Substitutes dotted glyphs with dotless forms',
    fin2: 'Terminal Forms #2 - Final form variants for specific scripts',
    fin3: 'Terminal Forms #3 - Final form variants for specific scripts',
    fina: 'Terminal Forms - Substitutes final forms in Arabic and similar scripts',
    flac: 'Flattened Accent Forms - Uses flattened accents for stacking',
    half: 'Half Forms - Forms half-forms in Indic conjuncts',
    haln: 'Halant Forms - Final forms after halant in Indic scripts',
    init: 'Initial Forms - Substitutes initial forms in Arabic and similar scripts',
    isol: 'Isolated Forms - Substitutes isolated forms in Arabic and similar scripts',
    jalt: 'Justification Alternates - Uses wider glyphs for justification',
    ljmo: 'Leading Jamo Forms - Leading jamo forms for Hangul syllables',
    med2: 'Medial Forms #2 - Medial form variants for specific scripts',
    medi: 'Medial Forms - Substitutes medial forms in Arabic and similar scripts',
    mset: 'Mark Positioning via Substitution - Positions marks via substitution',
    nukt: 'Nukta Forms - Forms nukta combinations in Indic scripts',
    pref: 'Pre-base Forms - Pre-base forms for reordering in Indic scripts',
    pres: 'Pre-base Substitutions - Substitutions before base glyph in Indic scripts',
    pstf: 'Post-base Forms - Post-base forms for reordering in Indic scripts',
    psts: 'Post-base Substitutions - Substitutions after base glyph in Indic scripts',
    rphf: 'Reph Form - Forms reph in Indic scripts',
    rkrf: 'Rakar Forms - Forms rakar in Devanagari and similar scripts',
    tjmo: 'Trailing Jamo Forms - Trailing jamo forms for Hangul syllables',
    vatu: 'Vattu Variants - Vattu variants in Devanagari and similar scripts',
    vjmo: 'Vowel Jamo Forms - Vowel jamo forms for Hangul syllables',

    // Direction and vertical text features
    ltra: 'Left-to-Right Alternates - Uses alternates for left-to-right text',
    ltrm: 'Left-to-Right Mirrored Forms - Uses mirrored forms for LTR text',
    rtla: 'Right-to-Left Alternates - Uses alternates for right-to-left text',
    rtlm: 'Right-to-Left Mirrored Forms - Uses mirrored forms for RTL text',
    vert: 'Vertical Alternates - Substitutes glyphs for vertical text',
    vrt2: 'Vertical Alternates and Rotation - Rotates and substitutes for vertical text',

    // Fraction features
    numr: 'Numerators - Replaces glyphs with numerator forms for fractions',
    dnom: 'Denominators - Replaces glyphs with denominator forms for fractions',

    // Arabic stretching
    stch: 'Stretching - Arabic kashida justification (tatweel)',

    // Additional required features from execution order
    ccmp: 'Glyph Composition / Decomposition - Composes or decomposes base and mark glyphs',
    mark: 'Mark Positioning - Positions marks (diacritics) relative to base glyphs',
    mkmk: 'Mark to Mark Positioning - Positions marks relative to other marks',
    rclt: 'Required Contextual Alternates - Required contextual alternates that must be applied',
    rlig: 'Required Ligatures - Required ligatures that must be applied for correct rendering',
    rvrn: 'Required Variation Alternates - Selects alternate glyphs for variable fonts'
};

// Add descriptions for character variant features
for (let i = 1; i <= 99; i++) {
    const cvTag = `cv${i.toString().padStart(2, '0')}`;
    FEATURE_DESCRIPTIONS[cvTag] =
        `Character Variant ${i} - Provides glyph variants for specific characters`;
}

// Add descriptions for stylistic set features
for (let i = 1; i <= 20; i++) {
    const ssTag = `ss${i.toString().padStart(2, '0')}`;
    FEATURE_DESCRIPTIONS[ssTag] =
        `Stylistic Set ${i} - Applies stylistic variant glyphs as a set`;
}

/**
 * Check if a feature is discretionary (subject to user control).
 *
 * @param featureTag - Four-character OpenType feature tag
 * @returns True if the feature is discretionary, False if required
 */
export function isDiscretionary(featureTag: string): boolean {
    return DISCRETIONARY_FEATURES.has(featureTag);
}

/**
 * Check if a discretionary feature is recommended to be on by default.
 *
 * @param featureTag - Four-character OpenType feature tag
 * @returns True if the feature should be on by default, False otherwise.
 *          For required features, returns False as they are always on.
 */
export function isDefaultOn(featureTag: string): boolean {
    return DEFAULT_ON_FEATURES.has(featureTag);
}

/**
 * Get the description of an OpenType feature.
 *
 * @param featureTag - Four-character OpenType feature tag
 * @returns Description string, or empty string if not found
 */
export function getFeatureDescription(featureTag: string): string {
    return FEATURE_DESCRIPTIONS[featureTag] || '';
}

export interface OpentypeFeatureInfo {
    default_on: string[];
    default_off: string[];
    descriptions: Record<string, string>;
}

/**
 * Get information about OpenType features, including which are discretionary
 * and which should be on by default.
 *
 * @returns Dictionary with feature information including:
 *          - 'default_on': Array of features that should be on by default
 *          - 'default_off': Array of features that should be off by default
 *          - 'descriptions': Object mapping feature tags to descriptions
 *
 * @example
 * const info = getOpentypeFeatureInfo();
 * console.log(info.default_on);
 * // ['calt', 'clig', 'liga', 'kern', 'cpsp', 'locl']
 */
export function getOpentypeFeatureInfo(): OpentypeFeatureInfo {
    return {
        default_on: Array.from(DEFAULT_ON_FEATURES),
        default_off: Array.from(DEFAULT_OFF_FEATURES),
        descriptions: FEATURE_DESCRIPTIONS
    };
}

const numberedTags = (prefix: string, count: number): string[] =>
    Array.from(
        { length: count },
        (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`
    );

/** Every tag in the OpenType feature tag registry, including `ss01`–`ss20` and `cv01`–`cv99`. */
export const REGISTERED_FEATURE_TAGS: ReadonlySet<string> = new Set([
    ...'aalt abvf abvm abvs afrc akhn blwf blwm blws c2pc c2sc calt case ccmp cfar chws cjct clig cpct cpsp cswh curs dist dlig dnom dtls expt falt fin2 fin3 fina flac frac fwid half haln halt hist hkna hlig hngl hojo hwid init isol ital jalt jp04 jp78 jp83 jp90 kern lfbd liga ljmo lnum locl ltra ltrm mark med2 medi mgrk mkmk mset nalt nlck nukt numr onum opbd ordn ornm palt pcap pkna pnum pref pres pstf psts pwid qwid rand rclt rkrf rlig rphf rtbd rtla rtlm ruby rvrn salt sinf size smcp smpl ssty stch subs sups swsh titl tjmo tnam tnum trad twid unic valt vatu vchw vert vhal vjmo vkna vkrn vpal vrt2 vrtr zero'.split(
        ' '
    ),
    ...numberedTags('ss', 20),
    ...numberedTags('cv', 99)
]);

/** Registered tags the specification marks as deprecated. */
export const DEPRECATED_FEATURES: ReadonlySet<string> = new Set(['hngl']);

const FEATURE_TAG_PATTERN = /^[A-Za-z0-9_.-]+$/;

export type FeatureTagCheck = {
    level: 'error' | 'warning' | 'ok';
    message: string;
    /** A registered tag one edit away, offered for a likely typo. */
    suggestion?: string;
};

/** Short feature name, such as “Standard Ligatures”, or an empty string. */
export function getFeatureName(featureTag: string): string {
    return getFeatureDescription(featureTag).split(' - ')[0] || '';
}

function isOneEditApart(a: string, b: string): boolean {
    if (a === b || Math.abs(a.length - b.length) > 1) {
        return false;
    }
    if (a.length === b.length) {
        const diffs: number[] = [];
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) diffs.push(i);
        }
        if (diffs.length === 1) return true;
        const [i, j] = diffs;
        return (
            diffs.length === 2 && j === i + 1 && a[i] === b[j] && a[j] === b[i]
        );
    }
    const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
    for (let i = 0; i < longer.length; i++) {
        if (longer.slice(0, i) + longer.slice(i + 1) === shorter) return true;
    }
    return false;
}

/**
 * Check a feature tag typed by the user. A tag that the font already uses is
 * fine: a font may have several features with the same tag.
 */
export function validateFeatureTag(tag: string): FeatureTagCheck {
    if (tag.length === 0) {
        return { level: 'error', message: 'Enter a feature tag.' };
    }
    if (tag.length > 4) {
        return {
            level: 'error',
            message: 'Feature tags have at most 4 characters.'
        };
    }
    if (!FEATURE_TAG_PATTERN.test(tag)) {
        return {
            level: 'error',
            message:
                'Feature tags can contain only letters, digits, “_”, “.” and “-”.'
        };
    }
    if (DEPRECATED_FEATURES.has(tag)) {
        return {
            level: 'warning',
            message: `“${tag}” is deprecated in the OpenType specification.`
        };
    }
    if (REGISTERED_FEATURE_TAGS.has(tag)) {
        return {
            level: 'ok',
            message: getFeatureName(tag) || 'Registered feature'
        };
    }
    // The registry reserves lowercase tags. A tag with an uppercase letter is
    // a custom (private) feature.
    if (/[A-Z]/.test(tag)) {
        return { level: 'ok', message: 'Custom feature' };
    }
    const close = [...REGISTERED_FEATURE_TAGS].filter((registered) =>
        isOneEditApart(tag, registered)
    );
    return {
        level: 'warning',
        message: `“${tag}” isn’t a registered feature.`,
        ...(close.length === 1 ? { suggestion: close[0] } : {})
    };
}

export type FeatureCodeLike = { code?: string | null };

export type FontFeaturesLike = {
    prefixes?: Record<string, FeatureCodeLike | null | undefined> | null;
    features?: Array<[string, FeatureCodeLike | null | undefined]> | null;
};

export type CategorizedShaperFeature<T = unknown> = {
    tag: string;
    codeData: T;
    index: number;
    isDiscretionary: boolean;
    isUserFeature: boolean;
};

export type CategorizedShaperFeatures<T = unknown> = {
    usedByShaper: Array<CategorizedShaperFeature<T>>;
    discretionary: Array<CategorizedShaperFeature<T>>;
    postUserFeatures: Array<CategorizedShaperFeature<T>>;
    notUsedByShaper: Array<CategorizedShaperFeature<T>>;
};

export function parseFeatureClassGlyphMembers(classCode: string): Set<string> {
    const glyphs = new Set<string>();
    if (!classCode) {
        return glyphs;
    }

    const codeWithoutComments = classCode.replace(/#.*/g, '');
    const tokens = codeWithoutComments
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean);

    tokens.forEach((token) => glyphs.add(token));
    return glyphs;
}

export function resolveFeatureClassGlyphs(
    className: string,
    classGlyphMembers: Map<string, Set<string>>,
    visited: Set<string> = new Set()
): Set<string> {
    const allGlyphs = new Set<string>();
    if (visited.has(className)) {
        return allGlyphs;
    }
    visited.add(className);

    const cleanName = className.startsWith('@')
        ? className.slice(1)
        : className;
    const members = classGlyphMembers.get(cleanName);
    if (!members) {
        return allGlyphs;
    }

    members.forEach((member) => {
        if (member.startsWith('@')) {
            const nestedGlyphs = resolveFeatureClassGlyphs(
                member,
                classGlyphMembers,
                visited
            );
            nestedGlyphs.forEach((glyph) => allGlyphs.add(glyph));
        } else {
            allGlyphs.add(member);
        }
    });

    return allGlyphs;
}

export function extractFontLanguageSystems(
    features: FontFeaturesLike | null | undefined
): string[] {
    if (!features) {
        return ['DFLT'];
    }

    const scripts = new Set<string>(['DFLT']);
    const allCode: string[] = [];

    if (features.prefixes) {
        Object.values(features.prefixes).forEach((prefix) => {
            if (prefix?.code) {
                allCode.push(prefix.code);
            }
        });
    }

    if (features.features) {
        features.features.forEach(([, codeData]) => {
            if (codeData?.code) {
                allCode.push(codeData.code);
            }
        });
    }

    const languageSystemRegex = /languagesystem\s+(\w+)\s+\w+/gi;
    allCode.forEach((code) => {
        let match: RegExpExecArray | null;
        while ((match = languageSystemRegex.exec(code)) !== null) {
            scripts.add(match[1]);
        }
    });

    return Array.from(scripts).sort();
}

export function groupScriptsByShaper(
    scripts: readonly string[]
): Map<string, string[]> {
    const shaperMap = new Map<string, string[]>();
    scripts.forEach((script) => {
        const shaper = SCRIPT_TO_SHAPER[script] || 'default';
        if (!shaperMap.has(shaper)) {
            shaperMap.set(shaper, []);
        }
        shaperMap.get(shaper)!.push(script);
    });

    return new Map(
        Array.from(shaperMap.entries()).sort(([left], [right]) =>
            left.localeCompare(right)
        )
    );
}

export function categorizeFeaturesForShaper<T>(
    features: Array<[string, T]>,
    executionOrder: readonly string[]
): CategorizedShaperFeatures<T> {
    const userFeaturesIndex = executionOrder.indexOf('--- USER FEATURES ---');
    const preUserFeatures = (
        userFeaturesIndex >= 0
            ? executionOrder.slice(0, userFeaturesIndex)
            : executionOrder
    ).filter((feature) => !feature.startsWith('---'));
    const postUserFeaturesList =
        userFeaturesIndex >= 0
            ? executionOrder
                  .slice(userFeaturesIndex + 1)
                  .filter((feature) => !feature.startsWith('---'))
            : [];

    const preUserFeaturesSet = new Set(preUserFeatures);
    const postUserFeaturesSet = new Set(postUserFeaturesList);

    const usedByShaper: Array<CategorizedShaperFeature<T>> = [];
    const discretionary: Array<CategorizedShaperFeature<T>> = [];
    const postUserFeatures: Array<CategorizedShaperFeature<T>> = [];
    const notUsedByShaper: Array<CategorizedShaperFeature<T>> = [];

    features.forEach(([tag, codeData], index) => {
        const isDisc = isDiscretionary(tag);
        const entry: CategorizedShaperFeature<T> = {
            tag,
            codeData,
            index,
            isDiscretionary: isDisc,
            isUserFeature: isDisc
        };

        if (isDisc) {
            discretionary.push(entry);
        } else if (preUserFeaturesSet.has(tag)) {
            usedByShaper.push(entry);
        } else if (postUserFeaturesSet.has(tag)) {
            postUserFeatures.push(entry);
        } else {
            notUsedByShaper.push(entry);
        }
    });

    usedByShaper.sort(
        (left, right) =>
            preUserFeatures.indexOf(left.tag) -
            preUserFeatures.indexOf(right.tag)
    );
    discretionary.sort((left, right) => left.index - right.index);
    postUserFeatures.sort(
        (left, right) =>
            postUserFeaturesList.indexOf(left.tag) -
            postUserFeaturesList.indexOf(right.tag)
    );
    notUsedByShaper.sort((left, right) => left.tag.localeCompare(right.tag));

    return {
        usedByShaper,
        discretionary,
        postUserFeatures,
        notUsedByShaper
    };
}
