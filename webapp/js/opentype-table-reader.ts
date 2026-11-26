// Lightweight zero-WASM OpenType binary table reader.
// Replaces main-thread calls into the 20 MB babelfont_fontc_web WASM module
// for simple post / maxp / fvar / GSUB / GPOS / name table queries.

const MAC_GLYPH_NAMES: readonly string[] = [
    '.notdef',
    '.null',
    'nonmarkingreturn',
    'space',
    'exclam',
    'quotedbl',
    'numbersign',
    'dollar',
    'percent',
    'ampersand',
    'quotesingle',
    'parenleft',
    'parenright',
    'asterisk',
    'plus',
    'comma',
    'hyphen',
    'period',
    'slash',
    'zero',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'colon',
    'semicolon',
    'less',
    'equal',
    'greater',
    'question',
    'at',
    'A',
    'B',
    'C',
    'D',
    'E',
    'F',
    'G',
    'H',
    'I',
    'J',
    'K',
    'L',
    'M',
    'N',
    'O',
    'P',
    'Q',
    'R',
    'S',
    'T',
    'U',
    'V',
    'W',
    'X',
    'Y',
    'Z',
    'bracketleft',
    'backslash',
    'bracketright',
    'asciicircum',
    'underscore',
    'grave',
    'a',
    'b',
    'c',
    'd',
    'e',
    'f',
    'g',
    'h',
    'i',
    'j',
    'k',
    'l',
    'm',
    'n',
    'o',
    'p',
    'q',
    'r',
    's',
    't',
    'u',
    'v',
    'w',
    'x',
    'y',
    'z',
    'braceleft',
    'bar',
    'braceright',
    'asciitilde',
    'Adieresis',
    'Aring',
    'Ccedilla',
    'Eacute',
    'Ntilde',
    'Odieresis',
    'Udieresis',
    'aacute',
    'agrave',
    'acircumflex',
    'adieresis',
    'atilde',
    'aring',
    'ccedilla',
    'eacute',
    'egrave',
    'ecircumflex',
    'edieresis',
    'iacute',
    'igrave',
    'icircumflex',
    'idieresis',
    'ntilde',
    'oacute',
    'ograve',
    'ocircumflex',
    'odieresis',
    'otilde',
    'uacute',
    'ugrave',
    'ucircumflex',
    'udieresis',
    'dagger',
    'degree',
    'cent',
    'sterling',
    'section',
    'bullet',
    'paragraph',
    'germandbls',
    'registered',
    'copyright',
    'trademark',
    'acute',
    'dieresis',
    'notequal',
    'AE',
    'Oslash',
    'infinity',
    'plusminus',
    'lessequal',
    'greaterequal',
    'yen',
    'mu',
    'partialdiff',
    'summation',
    'product',
    'pi',
    'integral',
    'ordfeminine',
    'ordmasculine',
    'Omega',
    'ae',
    'oslash',
    'questiondown',
    'exclamdown',
    'logicalnot',
    'radical',
    'florin',
    'approxequal',
    'Delta',
    'guillemotleft',
    'guillemotright',
    'ellipsis',
    'nonbreakingspace',
    'Agrave',
    'Atilde',
    'Otilde',
    'OE',
    'oe',
    'endash',
    'emdash',
    'quotedblleft',
    'quotedblright',
    'quoteleft',
    'quoteright',
    'divide',
    'lozenge',
    'ydieresis',
    'Ydieresis',
    'fraction',
    'currency',
    'guilsinglleft',
    'guilsinglright',
    'fi',
    'fl',
    'daggerdbl',
    'periodcentered',
    'quotesinglbase',
    'quotedblbase',
    'perthousand',
    'Acircumflex',
    'Ecircumflex',
    'Aacute',
    'Edieresis',
    'Egrave',
    'Iacute',
    'Icircumflex',
    'Idieresis',
    'Igrave',
    'Oacute',
    'Ocircumflex',
    'apple',
    'Ograve',
    'Uacute',
    'Ucircumflex',
    'Ugrave',
    'dotlessi',
    'circumflex',
    'tilde',
    'macron',
    'breve',
    'dotaccent',
    'ring',
    'cedilla',
    'hungarumlaut',
    'ogonek',
    'caron',
    'Lslash',
    'lslash',
    'Scaron',
    'scaron',
    'Zcaron',
    'zcaron',
    'brokenbar',
    'Eth',
    'eth',
    'Yacute',
    'yacute',
    'Thorn',
    'thorn',
    'minus',
    'multiply',
    'onesuperior',
    'twosuperior',
    'threesuperior',
    'onehalf',
    'onequarter',
    'threequarters',
    'franc',
    'Gbreve',
    'gbreve',
    'Idotaccent',
    'Scedilla',
    'scedilla',
    'Cacute',
    'cacute',
    'Ccaron',
    'ccaron',
    'dcroat'
];

interface TableRange {
    offset: number;
    length: number;
}

interface ParsedSfnt {
    byteOffset: number;
    byteLength: number;
    view: DataView;
    tables: Map<string, TableRange>;
    postNames?: Array<string | null> | null;
}

const sfntCache = new WeakMap<ArrayBufferLike, ParsedSfnt>();

function readTag(view: DataView, offset: number): string {
    return String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
    );
}

function parseSfnt(fontBytes: Uint8Array): ParsedSfnt {
    const cached = sfntCache.get(fontBytes.buffer);
    if (
        cached &&
        cached.byteOffset === fontBytes.byteOffset &&
        cached.byteLength === fontBytes.byteLength
    ) {
        return cached;
    }

    if (fontBytes.byteLength < 12) {
        throw new Error('Failed to parse font: buffer too short');
    }

    const view = new DataView(
        fontBytes.buffer,
        fontBytes.byteOffset,
        fontBytes.byteLength
    );

    let headerOffset = 0;
    const sfntTag = readTag(view, 0);
    if (sfntTag === 'ttcf') {
        if (fontBytes.byteLength < 16) {
            throw new Error('Failed to parse font: TTC header too short');
        }
        headerOffset = view.getUint32(12, false);
        if (headerOffset + 12 > fontBytes.byteLength) {
            throw new Error('Failed to parse font: invalid TTC face offset');
        }
    }

    const numTables = view.getUint16(headerOffset + 4, false);
    const recordsStart = headerOffset + 12;
    if (recordsStart + numTables * 16 > fontBytes.byteLength) {
        throw new Error('Failed to parse font: truncated table directory');
    }

    const tables = new Map<string, TableRange>();
    for (let i = 0; i < numTables; i++) {
        const rec = recordsStart + i * 16;
        const tag = readTag(view, rec);
        const offset = view.getUint32(rec + 8, false);
        const length = view.getUint32(rec + 12, false);
        if (offset + length <= fontBytes.byteLength) {
            tables.set(tag, { offset, length });
        }
    }

    const parsed: ParsedSfnt = {
        byteOffset: fontBytes.byteOffset,
        byteLength: fontBytes.byteLength,
        view,
        tables
    };
    sfntCache.set(fontBytes.buffer, parsed);
    return parsed;
}

function getPostNames(sfnt: ParsedSfnt): Array<string | null> | null {
    if (sfnt.postNames !== undefined) {
        return sfnt.postNames;
    }

    const post = sfnt.tables.get('post');
    if (!post || post.length < 32) {
        sfnt.postNames = null;
        return null;
    }

    const { view } = sfnt;
    const version = view.getUint32(post.offset, false);

    if (version === 0x00010000) {
        sfnt.postNames = [...MAC_GLYPH_NAMES];
        return sfnt.postNames;
    }

    if (version === 0x00020000) {
        if (post.length < 34) {
            sfnt.postNames = null;
            return null;
        }
        const numGlyphs = view.getUint16(post.offset + 32, false);
        const indexTableStart = post.offset + 34;
        const stringTableStart = indexTableStart + numGlyphs * 2;
        const postEnd = post.offset + post.length;
        if (stringTableStart > postEnd) {
            sfnt.postNames = null;
            return null;
        }

        const extraNames: string[] = [];
        let cursor = stringTableStart;
        while (cursor < postEnd) {
            const len = view.getUint8(cursor);
            cursor += 1;
            if (cursor + len > postEnd) {
                break;
            }
            let str = '';
            for (let j = 0; j < len; j++) {
                str += String.fromCharCode(view.getUint8(cursor + j));
            }
            extraNames.push(str);
            cursor += len;
        }

        const names: Array<string | null> = new Array(numGlyphs);
        for (let gid = 0; gid < numGlyphs; gid++) {
            const nameIdx = view.getUint16(indexTableStart + gid * 2, false);
            if (nameIdx < MAC_GLYPH_NAMES.length) {
                names[gid] = MAC_GLYPH_NAMES[nameIdx];
            } else {
                const extraIdx = nameIdx - MAC_GLYPH_NAMES.length;
                names[gid] =
                    extraIdx < extraNames.length ? extraNames[extraIdx] : null;
            }
        }
        sfnt.postNames = names;
        return names;
    }

    if (version === 0x00025000) {
        if (post.length < 34) {
            sfnt.postNames = null;
            return null;
        }
        const numGlyphs = view.getUint16(post.offset + 32, false);
        const offsetStart = post.offset + 34;
        if (offsetStart + numGlyphs > post.offset + post.length) {
            sfnt.postNames = null;
            return null;
        }
        const names: Array<string | null> = new Array(numGlyphs);
        for (let gid = 0; gid < numGlyphs; gid++) {
            const idx = gid + view.getInt8(offsetStart + gid);
            names[gid] =
                idx >= 0 && idx < MAC_GLYPH_NAMES.length
                    ? MAC_GLYPH_NAMES[idx]
                    : null;
        }
        sfnt.postNames = names;
        return names;
    }

    sfnt.postNames = null;
    return null;
}

function lookupEnglishName(
    sfnt: ParsedSfnt,
    targetNameId: number
): string | null {
    const nameTable = sfnt.tables.get('name');
    if (!nameTable || nameTable.length < 6) {
        return null;
    }
    const { view } = sfnt;
    const count = view.getUint16(nameTable.offset + 2, false);
    const storageOffset = view.getUint16(nameTable.offset + 4, false);
    const recordsStart = nameTable.offset + 6;
    const tableEnd = nameTable.offset + nameTable.length;
    if (recordsStart + count * 12 > tableEnd) {
        return null;
    }

    for (let i = 0; i < count; i++) {
        const rec = recordsStart + i * 12;
        const platformId = view.getUint16(rec, false);
        const encodingId = view.getUint16(rec + 2, false);
        const languageId = view.getUint16(rec + 4, false);
        const nameId = view.getUint16(rec + 6, false);
        if (
            nameId === targetNameId &&
            platformId === 3 &&
            encodingId === 1 &&
            languageId === 0x0409
        ) {
            const length = view.getUint16(rec + 8, false);
            const strOffset = view.getUint16(rec + 10, false);
            const start = nameTable.offset + storageOffset + strOffset;
            if (start + length > tableEnd) {
                return null;
            }
            const codeUnits: number[] = [];
            for (let off = 0; off + 1 < length; off += 2) {
                codeUnits.push(view.getUint16(start + off, false));
            }
            return String.fromCharCode(...codeUnits);
        }
    }
    return null;
}

function fallbackGlyphName(glyphId: number): string {
    return `glyph${String(glyphId).padStart(5, '0')}`;
}

export function get_glyph_name(fontBytes: Uint8Array, glyphId: number): string {
    const sfnt = parseSfnt(fontBytes);
    const postNames = getPostNames(sfnt);
    if (postNames && glyphId >= 0 && glyphId < postNames.length) {
        const name = postNames[glyphId];
        if (name !== null) {
            return name;
        }
    }
    return fallbackGlyphName(glyphId);
}

export function get_glyph_order(fontBytes: Uint8Array): string[] {
    const sfnt = parseSfnt(fontBytes);
    const maxp = sfnt.tables.get('maxp');
    if (!maxp || maxp.length < 6) {
        throw new Error('Failed to read maxp table');
    }
    const glyphCount = sfnt.view.getUint16(maxp.offset + 4, false);
    const postNames = getPostNames(sfnt);
    const order: string[] = new Array(glyphCount);
    for (let gid = 0; gid < glyphCount; gid++) {
        const name =
            postNames && gid < postNames.length ? postNames[gid] : null;
        order[gid] = name ?? fallbackGlyphName(gid);
    }
    return order;
}

export function get_font_axes(fontBytes: Uint8Array): string {
    const sfnt = parseSfnt(fontBytes);
    const fvar = sfnt.tables.get('fvar');
    if (!fvar || fvar.length < 16) {
        throw new Error('No fvar table found');
    }
    const { view } = sfnt;
    const axesArrayOffset = view.getUint16(fvar.offset + 4, false);
    const axisCount = view.getUint16(fvar.offset + 8, false);
    const axisSize = view.getUint16(fvar.offset + 10, false);
    const fvarEnd = fvar.offset + fvar.length;

    const axes: Array<{
        tag: string;
        name: string;
        min: number;
        max: number;
        default: number;
    }> = [];

    for (let i = 0; i < axisCount; i++) {
        const base = fvar.offset + axesArrayOffset + i * axisSize;
        if (base + 20 > fvarEnd) {
            break;
        }
        const tag = readTag(view, base);
        const min = view.getInt32(base + 4, false) / 65536;
        const defaultVal = view.getInt32(base + 8, false) / 65536;
        const max = view.getInt32(base + 12, false) / 65536;
        const axisNameId = view.getUint16(base + 18, false);
        const name = lookupEnglishName(sfnt, axisNameId) ?? tag;
        axes.push({ tag, name, min, max, default: defaultVal });
    }

    return JSON.stringify(axes);
}

function collectLayoutFeatureRecords(
    sfnt: ParsedSfnt,
    tableTag: 'GSUB' | 'GPOS'
): Array<{ tag: string; featureTableOffset: number; tableEnd: number }> {
    const table = sfnt.tables.get(tableTag);
    if (!table || table.length < 10) {
        return [];
    }
    const { view } = sfnt;
    const tableEnd = table.offset + table.length;
    const featureListOffset = view.getUint16(table.offset + 6, false);
    const featureListBase = table.offset + featureListOffset;
    if (featureListBase + 2 > tableEnd) {
        return [];
    }
    const featureCount = view.getUint16(featureListBase, false);
    const recordsStart = featureListBase + 2;
    if (recordsStart + featureCount * 6 > tableEnd) {
        return [];
    }
    const results: Array<{
        tag: string;
        featureTableOffset: number;
        tableEnd: number;
    }> = [];
    for (let i = 0; i < featureCount; i++) {
        const rec = recordsStart + i * 6;
        const tag = readTag(view, rec);
        const relOffset = view.getUint16(rec + 4, false);
        results.push({
            tag,
            featureTableOffset: featureListBase + relOffset,
            tableEnd
        });
    }
    return results;
}

export function get_font_features_with_tables(fontBytes: Uint8Array): string {
    const sfnt = parseSfnt(fontBytes);
    const features = new Map<string, Set<string>>();

    for (const tableTag of ['GSUB', 'GPOS'] as const) {
        for (const rec of collectLayoutFeatureRecords(sfnt, tableTag)) {
            let set = features.get(rec.tag);
            if (!set) {
                set = new Set();
                features.set(rec.tag, set);
            }
            set.add(tableTag);
        }
    }

    const out: Record<string, string[]> = {};
    for (const [tag, tables] of features) {
        out[tag] = Array.from(tables).sort();
    }
    return JSON.stringify(out);
}

export function get_stylistic_set_names(fontBytes: Uint8Array): string {
    const sfnt = parseSfnt(fontBytes);
    const { view } = sfnt;
    const featureNames: Record<string, string> = {};

    for (const tableTag of ['GSUB', 'GPOS'] as const) {
        for (const rec of collectLayoutFeatureRecords(sfnt, tableTag)) {
            if (
                !rec.tag.startsWith('ss') ||
                rec.tag.length !== 4 ||
                rec.tag in featureNames
            ) {
                continue;
            }
            if (rec.featureTableOffset + 4 > rec.tableEnd) {
                continue;
            }
            const paramsRelOffset = view.getUint16(
                rec.featureTableOffset,
                false
            );
            if (paramsRelOffset === 0) {
                continue;
            }
            const paramsOffset = rec.featureTableOffset + paramsRelOffset;
            if (paramsOffset + 4 > rec.tableEnd) {
                continue;
            }
            const uiNameId = view.getUint16(paramsOffset + 2, false);
            const nameStr = lookupEnglishName(sfnt, uiNameId);
            if (nameStr !== null) {
                featureNames[rec.tag] = nameStr;
            }
        }
    }

    return JSON.stringify(featureNames);
}
