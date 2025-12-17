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
    'aalt', // Access All Alternates
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

// Features that are required (not subject to user control, always applied)
export const REQUIRED_FEATURES = new Set([
    'abvf', // Above-base Forms
    'abvm', // Above-base Mark Positioning
    'abvs', // Above-base Substitutions
    'akhn', // Akhand
    'blwf', // Below-base Forms
    'blwm', // Below-base Mark Positioning
    'blws', // Below-base Substitutions
    'ccmp', // Glyph Composition/Decomposition - "This feature should always be applied"
    'cfar', // Conjunct Form After Ro
    'cjct', // Conjunct Forms
    'curs', // Cursive Positioning
    'dist', // Distances
    'dtls', // Dotless Forms
    'fin2', // Terminal Forms #2
    'fin3', // Terminal Forms #3
    'fina', // Terminal Forms
    'flac', // Flattened Accent Forms
    'half', // Half Forms
    'haln', // Halant Forms
    'init', // Initial Forms
    'isol', // Isolated Forms
    'jalt', // Justification Alternates
    'ljmo', // Leading Jamo Forms
    'mark', // Mark Positioning
    'med2', // Medial Forms #2
    'medi', // Medial Forms
    'mkmk', // Mark to Mark Positioning
    'mset', // Mark Positioning via Substitution (deprecated)
    'nukt', // Nukta Forms
    'pref', // Pre-base Forms
    'pres', // Pre-base Substitutions
    'pstf', // Post-base Forms
    'psts', // Post-base Substitutions
    'rclt', // Required Contextual Alternates
    'rlig', // Required Ligatures
    'rphf', // Reph Form
    'rkrf', // Rakar Forms
    'rvrn', // Required Variation Alternates
    'tjmo', // Trailing Jamo Forms
    'vjmo', // Vowel Jamo Forms
    'vatu' // Vattu Variants
]);

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
    zero: 'Slashed Zero - Replaces standard zero with slashed zero'
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
