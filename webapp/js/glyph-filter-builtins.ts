// Built-in glyph filter definitions and pure-JS classifiers.
// Mirrors plugins/glyphfilter/general/general_filter_plugin so the Glyph Overview
// sidebar works immediately without initializing Pyodide.

import type { GlyphFilterEventType } from './glyph-filter-events';

export interface BuiltinFilterDescriptor {
    path: string;
    keyword: string;
    display_name: string;
    eventTypes: GlyphFilterEventType[];
    hideWhenEmpty?: boolean;
    unicodeCategories?: ReadonlySet<string>;
    unicodeScripts?: ReadonlySet<string>;
    sortOrder?: number;
}

export interface BuiltinClassificationGroup {
    name: string;
    color: string;
}

const WRITING_SCRIPTS: ReadonlyArray<readonly [string, string]> = [
    ['Adlm', 'Adlam'],
    ['Ahom', 'Ahom'],
    ['Hluw', 'Anatolian_Hieroglyphs'],
    ['Arab', 'Arabic'],
    ['Armn', 'Armenian'],
    ['Avst', 'Avestan'],
    ['Bali', 'Balinese'],
    ['Bamu', 'Bamum'],
    ['Bass', 'Bassa_Vah'],
    ['Batk', 'Batak'],
    ['Beng', 'Bengali'],
    ['Berf', 'Beria_Erfe'],
    ['Bhks', 'Bhaiksuki'],
    ['Bopo', 'Bopomofo'],
    ['Brah', 'Brahmi'],
    ['Brai', 'Braille'],
    ['Bugi', 'Buginese'],
    ['Buhd', 'Buhid'],
    ['Cans', 'Canadian_Aboriginal'],
    ['Cari', 'Carian'],
    ['Aghb', 'Caucasian_Albanian'],
    ['Cakm', 'Chakma'],
    ['Cham', 'Cham'],
    ['Cher', 'Cherokee'],
    ['Chrs', 'Chorasmian'],
    ['Copt', 'Coptic'],
    ['Xsux', 'Cuneiform'],
    ['Cprt', 'Cypriot'],
    ['Cpmn', 'Cypro_Minoan'],
    ['Cyrl', 'Cyrillic'],
    ['Dsrt', 'Deseret'],
    ['Deva', 'Devanagari'],
    ['Diak', 'Dives_Akuru'],
    ['Dogr', 'Dogra'],
    ['Dupl', 'Duployan'],
    ['Egyp', 'Egyptian_Hieroglyphs'],
    ['Elba', 'Elbasan'],
    ['Elym', 'Elymaic'],
    ['Ethi', 'Ethiopic'],
    ['Gara', 'Garay'],
    ['Geor', 'Georgian'],
    ['Glag', 'Glagolitic'],
    ['Goth', 'Gothic'],
    ['Gran', 'Grantha'],
    ['Grek', 'Greek'],
    ['Gujr', 'Gujarati'],
    ['Gong', 'Gunjala_Gondi'],
    ['Guru', 'Gurmukhi'],
    ['Gukh', 'Gurung_Khema'],
    ['Hani', 'Han'],
    ['Hang', 'Hangul'],
    ['Rohg', 'Hanifi_Rohingya'],
    ['Hano', 'Hanunoo'],
    ['Hatr', 'Hatran'],
    ['Hebr', 'Hebrew'],
    ['Hira', 'Hiragana'],
    ['Armi', 'Imperial_Aramaic'],
    ['Phli', 'Inscriptional_Pahlavi'],
    ['Prti', 'Inscriptional_Parthian'],
    ['Java', 'Javanese'],
    ['Kthi', 'Kaithi'],
    ['Knda', 'Kannada'],
    ['Kana', 'Katakana'],
    ['Kawi', 'Kawi'],
    ['Kali', 'Kayah_Li'],
    ['Khar', 'Kharoshthi'],
    ['Kits', 'Khitan_Small_Script'],
    ['Khmr', 'Khmer'],
    ['Khoj', 'Khojki'],
    ['Sind', 'Khudawadi'],
    ['Krai', 'Kirat_Rai'],
    ['Laoo', 'Lao'],
    ['Latn', 'Latin'],
    ['Lepc', 'Lepcha'],
    ['Limb', 'Limbu'],
    ['Lina', 'Linear_A'],
    ['Linb', 'Linear_B'],
    ['Lisu', 'Lisu'],
    ['Lyci', 'Lycian'],
    ['Lydi', 'Lydian'],
    ['Mahj', 'Mahajani'],
    ['Maka', 'Makasar'],
    ['Mlym', 'Malayalam'],
    ['Mand', 'Mandaic'],
    ['Mani', 'Manichaean'],
    ['Marc', 'Marchen'],
    ['Gonm', 'Masaram_Gondi'],
    ['Medf', 'Medefaidrin'],
    ['Mtei', 'Meetei_Mayek'],
    ['Mend', 'Mende_Kikakui'],
    ['Merc', 'Meroitic_Cursive'],
    ['Mero', 'Meroitic_Hieroglyphs'],
    ['Plrd', 'Miao'],
    ['Modi', 'Modi'],
    ['Mong', 'Mongolian'],
    ['Mroo', 'Mro'],
    ['Mult', 'Multani'],
    ['Mymr', 'Myanmar'],
    ['Nbat', 'Nabataean'],
    ['Nagm', 'Nag_Mundari'],
    ['Nand', 'Nandinagari'],
    ['Talu', 'New_Tai_Lue'],
    ['Newa', 'Newa'],
    ['Nkoo', 'Nko'],
    ['Nshu', 'Nushu'],
    ['Hmnp', 'Nyiakeng_Puachue_Hmong'],
    ['Ogam', 'Ogham'],
    ['Olck', 'Ol_Chiki'],
    ['Onao', 'Ol_Onal'],
    ['Hung', 'Old_Hungarian'],
    ['Ital', 'Old_Italic'],
    ['Narb', 'Old_North_Arabian'],
    ['Perm', 'Old_Permic'],
    ['Xpeo', 'Old_Persian'],
    ['Sogo', 'Old_Sogdian'],
    ['Sarb', 'Old_South_Arabian'],
    ['Orkh', 'Old_Turkic'],
    ['Ougr', 'Old_Uyghur'],
    ['Orya', 'Oriya'],
    ['Osge', 'Osage'],
    ['Osma', 'Osmanya'],
    ['Hmng', 'Pahawh_Hmong'],
    ['Palm', 'Palmyrene'],
    ['Pauc', 'Pau_Cin_Hau'],
    ['Phag', 'Phags_Pa'],
    ['Phnx', 'Phoenician'],
    ['Phlp', 'Psalter_Pahlavi'],
    ['Rjng', 'Rejang'],
    ['Runr', 'Runic'],
    ['Samr', 'Samaritan'],
    ['Saur', 'Saurashtra'],
    ['Shrd', 'Sharada'],
    ['Shaw', 'Shavian'],
    ['Sidd', 'Siddham'],
    ['Sidt', 'Sidetic'],
    ['Sgnw', 'SignWriting'],
    ['Sinh', 'Sinhala'],
    ['Sogd', 'Sogdian'],
    ['Sora', 'Sora_Sompeng'],
    ['Soyo', 'Soyombo'],
    ['Sund', 'Sundanese'],
    ['Sunu', 'Sunuwar'],
    ['Sylo', 'Syloti_Nagri'],
    ['Syrc', 'Syriac'],
    ['Tglg', 'Tagalog'],
    ['Tagb', 'Tagbanwa'],
    ['Tale', 'Tai_Le'],
    ['Lana', 'Tai_Tham'],
    ['Tavt', 'Tai_Viet'],
    ['Tayo', 'Tai_Yo'],
    ['Takr', 'Takri'],
    ['Taml', 'Tamil'],
    ['Tnsa', 'Tangsa'],
    ['Tang', 'Tangut'],
    ['Telu', 'Telugu'],
    ['Thaa', 'Thaana'],
    ['Thai', 'Thai'],
    ['Tibt', 'Tibetan'],
    ['Tfng', 'Tifinagh'],
    ['Tirh', 'Tirhuta'],
    ['Todr', 'Todhri'],
    ['Tols', 'Tolong_Siki'],
    ['Toto', 'Toto'],
    ['Tutg', 'Tulu_Tigalari'],
    ['Ugar', 'Ugaritic'],
    ['Vaii', 'Vai'],
    ['Vith', 'Vithkuqi'],
    ['Wcho', 'Wancho'],
    ['Wara', 'Warang_Citi'],
    ['Yezi', 'Yezidi'],
    ['Yiii', 'Yi'],
    ['Zanb', 'Zanabazar_Square']
];

const UNICODE_BLOCKS: ReadonlyArray<readonly [number, number, string, string]> =
    [
        [0x0000, 0x007f, 'Basic Latin', '#3b82f6'],
        [0x0080, 0x00ff, 'Latin-1 Supplement', '#60a5fa'],
        [0x0100, 0x017f, 'Latin Extended-A', '#93c5fd'],
        [0x0180, 0x024f, 'Latin Extended-B', '#bfdbfe'],
        [0x0250, 0x02af, 'IPA Extensions', '#dbeafe'],
        [0x0370, 0x03ff, 'Greek and Coptic', '#8b5cf6'],
        [0x0400, 0x04ff, 'Cyrillic', '#a855f7'],
        [0x0590, 0x05ff, 'Hebrew', '#c084fc'],
        [0x0600, 0x06ff, 'Arabic', '#d8b4fe'],
        [0x0900, 0x097f, 'Devanagari', '#e9d5ff'],
        [0x0e00, 0x0e7f, 'Thai', '#f3e8ff'],
        [0x1e00, 0x1eff, 'Latin Extended Additional', '#ddd6fe'],
        [0x2000, 0x206f, 'General Punctuation', '#22c55e'],
        [0x2070, 0x209f, 'Superscripts and Subscripts', '#4ade80'],
        [0x20a0, 0x20cf, 'Currency Symbols', '#86efac'],
        [0x2100, 0x214f, 'Letterlike Symbols', '#bbf7d0'],
        [0x2190, 0x21ff, 'Arrows', '#dcfce7'],
        [0x2200, 0x22ff, 'Mathematical Operators', '#10b981'],
        [0x2300, 0x23ff, 'Miscellaneous Technical', '#059669'],
        [0x2460, 0x24ff, 'Enclosed Alphanumerics', '#047857'],
        [0x2500, 0x257f, 'Box Drawing', '#065f46'],
        [0x2580, 0x259f, 'Block Elements', '#064e3b'],
        [0x25a0, 0x25ff, 'Geometric Shapes', '#f59e0b'],
        [0x2600, 0x26ff, 'Miscellaneous Symbols', '#fb923c'],
        [0x2700, 0x27bf, 'Dingbats', '#fdba74'],
        [0x3040, 0x309f, 'Hiragana', '#ec4899'],
        [0x30a0, 0x30ff, 'Katakana', '#f472b6'],
        [0x4e00, 0x9fff, 'CJK Unified Ideographs', '#f9a8d4'],
        [0xac00, 0xd7af, 'Hangul Syllables', '#fbcfe8'],
        [0xe000, 0xf8ff, 'Private Use Area', '#6b7280'],
        [0x1f300, 0x1f5ff, 'Miscellaneous Symbols and Pictographs', '#fbbf24'],
        [0x1f600, 0x1f64f, 'Emoticons', '#fcd34d'],
        [0x1f680, 0x1f6ff, 'Transport and Map Symbols', '#fde68a'],
        [0x1f900, 0x1f9ff, 'Supplemental Symbols and Pictographs', '#fef3c7']
    ];

const CATEGORY_GROUPS: ReadonlyArray<
    readonly [string, string, readonly string[]]
> = [
    ['letters', 'Letters', ['Lu', 'Lt', 'Ll', 'Lo']],
    ['modifiers', 'Modifiers', ['Lm', 'Sk']],
    ['marks', 'Marks', ['Mn', 'Mc', 'Me']],
    ['figures', 'Figures', ['Nd', 'Nl', 'No']],
    ['punctuation', 'Punctuation', ['Pc', 'Pd', 'Ps', 'Pe', 'Pi', 'Pf', 'Po']],
    ['symbols', 'Symbols', ['Sm', 'Sc', 'So', 'Co']],
    ['spaces', 'Spaces & Controls', ['Zs', 'Zl', 'Zp', 'Cc', 'Cf', 'Cs', 'Cn']],
    ['none', 'No Category', ['']]
];

export const BUILTIN_JS_FILTER_KEYWORDS: ReadonlySet<string> = new Set([
    'com.context.allglyphs',
    'com.context.encoded',
    'com.context.unencoded',
    'com.context.incompatible_outlines',
    'com.context.auto_qa_issues'
]);

function formatHexCodepoint(value: number): string {
    return value.toString(16).toUpperCase().padStart(4, '0');
}

export function classifyEncodedGlyph(glyph: {
    codepoints?: readonly number[];
}): BuiltinClassificationGroup[] | null {
    const codepoints = glyph.codepoints;
    if (!Array.isArray(codepoints) || codepoints.length === 0) {
        return null;
    }

    const groups: BuiltinClassificationGroup[] = [];
    if (codepoints.length > 1) {
        groups.push({ name: 'Multiple Codepoints', color: '#ef4444' });
    }

    for (const codepoint of codepoints) {
        for (const [start, end, description, color] of UNICODE_BLOCKS) {
            if (codepoint >= start && codepoint <= end) {
                const name = `${description} (U+${formatHexCodepoint(start)}-U+${formatHexCodepoint(end)})`;
                if (!groups.some((group) => group.name === name)) {
                    groups.push({ name, color });
                }
                break;
            }
        }
    }

    return groups.length > 0 ? groups : [{ name: 'Encoded', color: 'blue' }];
}

export function createBuiltinFilterDescriptors(): BuiltinFilterDescriptor[] {
    const descriptors: BuiltinFilterDescriptor[] = [
        {
            path: 'basic',
            keyword: 'com.context.allglyphs',
            display_name: 'All Glyphs',
            eventTypes: []
        },
        {
            path: 'basic/glyph_categories',
            keyword: 'com.context.encoded',
            display_name: 'Encoded Characters',
            eventTypes: ['glyph.unicode.changed']
        },
        {
            path: 'basic/glyph_categories',
            keyword: 'com.context.unencoded',
            display_name: 'Unencoded Glyphs',
            eventTypes: ['glyph.unicode.changed']
        },
        {
            path: 'basic/debugging',
            keyword: 'com.context.incompatible_outlines',
            display_name: 'Incompatible Outlines',
            eventTypes: ['glyph.compatibility.changed']
        },
        {
            path: 'basic/debugging',
            keyword: 'com.context.auto_qa_issues',
            display_name: 'Auto QA Issues',
            eventTypes: ['glyph.qa.changed']
        }
    ];

    CATEGORY_GROUPS.forEach(([key, name, codes], order) => {
        descriptors.push({
            path: 'categories',
            keyword: `com.context.category.${key}`,
            display_name: name,
            eventTypes: ['glyph.unicode.changed'],
            hideWhenEmpty: true,
            unicodeCategories: new Set(codes),
            sortOrder: order
        });
    });

    let scriptOrder = 0;
    for (const [code, name] of WRITING_SCRIPTS) {
        descriptors.push({
            path: 'scripts',
            keyword: `com.context.script.${code}`,
            display_name: name.replaceAll('_', ' '),
            eventTypes: ['glyph.unicode.changed'],
            hideWhenEmpty: true,
            unicodeScripts: new Set([name, code]),
            sortOrder: scriptOrder
        });
        scriptOrder += 1;
    }

    descriptors.push({
        path: 'scripts',
        keyword: 'com.context.script.Zyyy',
        display_name: 'Common',
        eventTypes: ['glyph.unicode.changed'],
        hideWhenEmpty: true,
        unicodeScripts: new Set(['Common', 'Zyyy', 'Inherited', 'Zinh']),
        sortOrder: scriptOrder
    });
    descriptors.push({
        path: 'scripts',
        keyword: 'com.context.script.Zzzz',
        display_name: 'No Writing Script',
        eventTypes: ['glyph.unicode.changed'],
        hideWhenEmpty: true,
        unicodeScripts: new Set(['']),
        sortOrder: scriptOrder + 1
    });

    return descriptors;
}
