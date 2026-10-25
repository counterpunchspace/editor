/**
 * Info popup showing a glyph's Unicode metadata (`Glyph.glyphData`) in
 * readable form. Used by the glyph overview property panel.
 */

import tippy, { type Instance as TippyInstance } from 'tippy.js';
import { getTheme } from './tippy-utils';
import { glyphDataIndex, type GlyphDataSearchResult } from './glyph-data';

const GENERAL_CATEGORIES: Record<string, string> = {
    Lu: 'Letter, uppercase',
    Ll: 'Letter, lowercase',
    Lt: 'Letter, titlecase',
    Lm: 'Letter, modifier',
    Lo: 'Letter, other',
    Mn: 'Mark, nonspacing',
    Mc: 'Mark, spacing combining',
    Me: 'Mark, enclosing',
    Nd: 'Number, decimal digit',
    Nl: 'Number, letter',
    No: 'Number, other',
    Pc: 'Punctuation, connector',
    Pd: 'Punctuation, dash',
    Ps: 'Punctuation, open',
    Pe: 'Punctuation, close',
    Pi: 'Punctuation, initial quote',
    Pf: 'Punctuation, final quote',
    Po: 'Punctuation, other',
    Sm: 'Symbol, math',
    Sc: 'Symbol, currency',
    Sk: 'Symbol, modifier',
    So: 'Symbol, other',
    Zs: 'Separator, space',
    Zl: 'Separator, line',
    Zp: 'Separator, paragraph',
    Cc: 'Other, control',
    Cf: 'Other, format',
    Cs: 'Other, surrogate',
    Co: 'Other, private use',
    Cn: 'Other, not assigned'
};

const BIDI_CLASSES: Record<string, string> = {
    L: 'Left-to-right',
    R: 'Right-to-left',
    AL: 'Arabic letter',
    EN: 'European number',
    ES: 'European separator',
    ET: 'European terminator',
    AN: 'Arabic number',
    CS: 'Common separator',
    NSM: 'Nonspacing mark',
    BN: 'Boundary neutral',
    B: 'Paragraph separator',
    S: 'Segment separator',
    WS: 'Whitespace',
    ON: 'Other neutral',
    LRE: 'Left-to-right embedding',
    LRO: 'Left-to-right override',
    RLE: 'Right-to-left embedding',
    RLO: 'Right-to-left override',
    PDF: 'Pop directional format',
    LRI: 'Left-to-right isolate',
    RLI: 'Right-to-left isolate',
    FSI: 'First strong isolate',
    PDI: 'Pop directional isolate'
};

const JOINING_TYPES: Record<string, string> = {
    U: 'Non-joining',
    D: 'Dual-joining',
    R: 'Right-joining',
    L: 'Left-joining',
    C: 'Join-causing',
    T: 'Transparent'
};

const COMBINING_CLASSES: Record<string, string> = {
    '0': 'Not reordered',
    '1': 'Overlay',
    '7': 'Nukta',
    '8': 'Kana voicing',
    '9': 'Virama',
    '200': 'Attached below left',
    '202': 'Attached below',
    '214': 'Attached above',
    '216': 'Attached above right',
    '218': 'Below left',
    '220': 'Below',
    '222': 'Below right',
    '224': 'Left',
    '226': 'Right',
    '228': 'Above left',
    '230': 'Above',
    '232': 'Above right',
    '233': 'Double below',
    '234': 'Double above',
    '240': 'Iota subscript'
};

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatCodepoint(codepoint: number): string {
    return `U+${codepoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

function describeCode(code: string, names: Record<string, string>): string {
    const label = names[code];
    return label ? `${label} (${code})` : code;
}

/** `0041 0308` → `U+0041 A, U+0308 ◌̈` with names when known. */
function describeCodepointSequence(value: string): string {
    const tag = value.match(/^<([^>]+)>\s*/);
    const body = tag ? value.slice(tag[0].length) : value;
    const parts = body
        .split(/\s+/)
        .filter(Boolean)
        .map((hex) => {
            const codepoint = Number.parseInt(hex, 16);
            if (!Number.isFinite(codepoint)) {
                return hex;
            }
            const record = glyphDataIndex.getGlyphDataForUnicode([codepoint]);
            const label = record
                ? `${record.character} ${record.glyph_name}`
                : String.fromCodePoint(codepoint);
            return `${formatCodepoint(codepoint)} ${label}`;
        });
    const joined = parts.join(' + ');
    return tag ? `${joined} (${tag[1]})` : joined;
}

function describeCombiningClass(value: string): string {
    const combiningClass = Number(value);
    if (combiningClass >= 10 && combiningClass <= 199) {
        return `Fixed position (${value})`;
    }
    return describeCode(value, COMBINING_CLASSES);
}

function list(value: string | string[] | undefined): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    return Array.isArray(value) ? value.join(', ') : value;
}

function rowsFor(
    record: GlyphDataSearchResult,
    glyphName: string
): Array<[string, string | undefined]> {
    const aliases = (record.name_aliases || [])
        .map((alias) =>
            alias.length > 1 ? `${alias[0]} (${alias[1]})` : alias[0]
        )
        .join(', ');
    return [
        [
            'Current name',
            glyphName !== record.glyph_name ? glyphName : undefined
        ],
        ['Counterpunch name', record.glyph_name],
        ['Unicode name', record.name],
        ['Codepoint', formatCodepoint(record.codepoint)],
        [
            'General category',
            record.general_category
                ? describeCode(record.general_category, GENERAL_CATEGORIES)
                : undefined
        ],
        ['Script', record.script],
        ['Script extensions', list(record.script_extensions)],
        ['Block', record.block],
        ['Introduced in', record.age ? `Unicode ${record.age}` : undefined],
        [
            'Text direction',
            record.bidi_class
                ? describeCode(record.bidi_class, BIDI_CLASSES)
                : undefined
        ],
        ['Mirrored', record.mirrored === 'Y' ? 'Yes' : undefined],
        [
            'Joining type',
            record.joining_type
                ? describeCode(record.joining_type, JOINING_TYPES)
                : undefined
        ],
        ['Joining group', record.joining_group],
        [
            'Combining class',
            record.combining_class && record.combining_class !== '0'
                ? describeCombiningClass(record.combining_class)
                : undefined
        ],
        [
            'Decomposes to',
            record.decomposition
                ? describeCodepointSequence(record.decomposition)
                : undefined
        ],
        [
            'Uppercase',
            record.uppercase
                ? describeCodepointSequence(record.uppercase)
                : undefined
        ],
        [
            'Lowercase',
            record.lowercase
                ? describeCodepointSequence(record.lowercase)
                : undefined
        ],
        [
            'Titlecase',
            record.titlecase && record.titlecase !== record.uppercase
                ? describeCodepointSequence(record.titlecase)
                : undefined
        ],
        ['Numeric value', record.numeric],
        ['Unicode 1.0 name', record.unicode_1_name],
        ['Aliases', aliases || undefined],
        ['ISO comment', record.iso_comment]
    ];
}

/** Glyph Data for the overview selection, as an HTML panel. */
export function buildGlyphDataPopupHtml(glyphName: string): string {
    const glyph = window.currentFontModel?.findGlyph(glyphName);
    const record = glyph?.glyphData;
    if (!record) {
        const message = glyphDataIndex.isReady()
            ? 'No Unicode data is known for this glyph. It needs a single codepoint, or a name from the Counterpunch glyph data.'
            : 'Glyph data is still loading.';
        return `<div class="glyph-data-popup">
            <div class="glyph-data-popup-empty">${escapeHtml(message)}</div>
        </div>`;
    }
    const baseName = glyphName.split('.', 1)[0];
    const inherited =
        baseName !== glyphName && record.glyph_name === baseName
            ? `<p class="glyph-data-popup-note">From the base glyph ${escapeHtml(baseName)}.</p>`
            : '';
    const rows = rowsFor(record, glyphName)
        .filter((row): row is [string, string] => Boolean(row[1]))
        .map(
            ([label, value]) =>
                `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`
        )
        .join('');
    return `<div class="glyph-data-popup">
        <div class="glyph-data-popup-header">
            <span class="glyph-data-popup-character">${escapeHtml(record.character)}</span>
            <span class="glyph-data-popup-title">${escapeHtml(record.name)}</span>
        </div>
        ${inherited}
        <table class="glyph-data-popup-table"><tbody>${rows}</tbody></table>
    </div>`;
}

/** Click-to-open Glyph Data popup on `button` for the glyph `getGlyphName` returns. */
export function attachGlyphDataPopup(
    button: HTMLElement,
    getGlyphName: () => string | null
): TippyInstance {
    return tippy(button, {
        content: '',
        allowHTML: true,
        interactive: true,
        trigger: 'click',
        appendTo: () => document.body,
        maxWidth: 420,
        placement: 'bottom',
        theme: getTheme(),
        zIndex: 10003,
        onCreate(instance) {
            instance.popper.classList.add('glyph-data-popup-tippy');
        },
        onShow(instance) {
            const glyphName = getGlyphName();
            if (!glyphName) {
                return false;
            }
            instance.setContent(buildGlyphDataPopupHtml(glyphName));
            if (!glyphDataIndex.isReady()) {
                void glyphDataIndex.ensureReady().then(() => {
                    if (instance.state.isVisible) {
                        instance.setContent(buildGlyphDataPopupHtml(glyphName));
                    }
                });
            }
            return undefined;
        }
    });
}
