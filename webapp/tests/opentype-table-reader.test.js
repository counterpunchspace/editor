const {
    get_glyph_name,
    get_glyph_order,
    get_font_axes,
    get_font_features_with_tables,
    get_stylistic_set_names
} = require('../js/opentype-table-reader');

function writeUint16(buf, offset, value) {
    buf[offset] = (value >> 8) & 0xff;
    buf[offset + 1] = value & 0xff;
}

function writeUint32(buf, offset, value) {
    buf[offset] = (value >>> 24) & 0xff;
    buf[offset + 1] = (value >>> 16) & 0xff;
    buf[offset + 2] = (value >>> 8) & 0xff;
    buf[offset + 3] = value & 0xff;
}

function writeInt32(buf, offset, value) {
    writeUint32(buf, offset, value >>> 0);
}

function writeAscii(buf, offset, str) {
    for (let i = 0; i < str.length; i++) {
        buf[offset + i] = str.charCodeAt(i);
    }
}

function buildSfnt(tables) {
    const entries = Object.entries(tables).sort(([a], [b]) =>
        a.localeCompare(b)
    );
    const headerSize = 12 + entries.length * 16;
    let totalSize = headerSize;
    const offsets = [];
    for (const [, data] of entries) {
        offsets.push(totalSize);
        totalSize += (data.length + 3) & ~3;
    }

    const out = new Uint8Array(totalSize);
    writeUint32(out, 0, 0x00010000);
    writeUint16(out, 4, entries.length);
    entries.forEach(([tag, data], index) => {
        const rec = 12 + index * 16;
        writeAscii(out, rec, tag);
        writeUint32(out, rec + 8, offsets[index]);
        writeUint32(out, rec + 12, data.length);
        out.set(data, offsets[index]);
    });
    return out;
}

function buildMaxp(numGlyphs) {
    const buf = new Uint8Array(6);
    writeUint32(buf, 0, 0x00005000);
    writeUint16(buf, 4, numGlyphs);
    return buf;
}

function buildPostV2(glyphIndexEntries, extraNames) {
    const extraBytes = extraNames.reduce((sum, n) => sum + 1 + n.length, 0);
    const buf = new Uint8Array(34 + glyphIndexEntries.length * 2 + extraBytes);
    writeUint32(buf, 0, 0x00020000);
    writeUint16(buf, 32, glyphIndexEntries.length);
    glyphIndexEntries.forEach((idx, i) => writeUint16(buf, 34 + i * 2, idx));
    let cursor = 34 + glyphIndexEntries.length * 2;
    for (const name of extraNames) {
        buf[cursor++] = name.length;
        writeAscii(buf, cursor, name);
        cursor += name.length;
    }
    return buf;
}

function buildNameTable(records) {
    const encoded = records.map(({ nameId, text }) => {
        const bytes = new Uint8Array(text.length * 2);
        for (let i = 0; i < text.length; i++) {
            writeUint16(bytes, i * 2, text.charCodeAt(i));
        }
        return { nameId, bytes };
    });
    const storageOffset = 6 + encoded.length * 12;
    const totalStrings = encoded.reduce((sum, r) => sum + r.bytes.length, 0);
    const buf = new Uint8Array(storageOffset + totalStrings);
    writeUint16(buf, 2, encoded.length);
    writeUint16(buf, 4, storageOffset);
    let strCursor = 0;
    encoded.forEach((rec, i) => {
        const off = 6 + i * 12;
        writeUint16(buf, off, 3); // Windows
        writeUint16(buf, off + 2, 1); // Unicode BMP
        writeUint16(buf, off + 4, 0x0409); // en-US
        writeUint16(buf, off + 6, rec.nameId);
        writeUint16(buf, off + 8, rec.bytes.length);
        writeUint16(buf, off + 10, strCursor);
        buf.set(rec.bytes, storageOffset + strCursor);
        strCursor += rec.bytes.length;
    });
    return buf;
}

function buildFvar(axes) {
    const axesArrayOffset = 16;
    const axisSize = 20;
    const buf = new Uint8Array(axesArrayOffset + axes.length * axisSize);
    writeUint16(buf, 0, 1);
    writeUint16(buf, 4, axesArrayOffset);
    writeUint16(buf, 6, 2);
    writeUint16(buf, 8, axes.length);
    writeUint16(buf, 10, axisSize);
    axes.forEach((axis, i) => {
        const base = axesArrayOffset + i * axisSize;
        writeAscii(buf, base, axis.tag);
        writeInt32(buf, base + 4, Math.round(axis.min * 65536));
        writeInt32(buf, base + 8, Math.round(axis.default * 65536));
        writeInt32(buf, base + 12, Math.round(axis.max * 65536));
        writeUint16(buf, base + 18, axis.nameId);
    });
    return buf;
}

function buildLayoutTable(features) {
    // Header: 10 bytes, FeatureList starts at offset 10
    const featureListOffset = 10;
    const recordsEnd = 2 + features.length * 6;
    let bodyLen = 0;
    const featureOffsets = [];
    for (const feat of features) {
        featureOffsets.push(recordsEnd + bodyLen);
        bodyLen += feat.uiNameId != null ? 8 : 4;
    }
    const buf = new Uint8Array(featureListOffset + recordsEnd + bodyLen);
    writeUint16(buf, 0, 1);
    writeUint16(buf, 6, featureListOffset);
    writeUint16(buf, featureListOffset, features.length);
    features.forEach((feat, i) => {
        const rec = featureListOffset + 2 + i * 6;
        writeAscii(buf, rec, feat.tag);
        writeUint16(buf, rec + 4, featureOffsets[i]);
        const featBase = featureListOffset + featureOffsets[i];
        if (feat.uiNameId != null) {
            // featureParamsOffset = 4 (right after the 4-byte FeatureTable header)
            writeUint16(buf, featBase, 4);
            writeUint16(buf, featBase + 4, 0); // StylisticSet version 0
            writeUint16(buf, featBase + 6, feat.uiNameId);
        }
    });
    return buf;
}

describe('opentype-table-reader', () => {
    const sampleFont = buildSfnt({
        maxp: buildMaxp(4),
        post: buildPostV2([0, 36, 258, 259], ['alef-ar', 'beh-ar.init']),
        name: buildNameTable([
            { nameId: 256, text: 'Weight' },
            { nameId: 257, text: 'Alternate Alef' },
            { nameId: 258, text: 'Swash' }
        ]),
        fvar: buildFvar([
            { tag: 'wght', min: 100, default: 400, max: 900, nameId: 256 },
            { tag: 'OPSZ', min: 8, default: 14, max: 72, nameId: 999 }
        ]),
        GSUB: buildLayoutTable([
            { tag: 'liga' },
            { tag: 'calt' },
            { tag: 'ss01', uiNameId: 257 }
        ]),
        GPOS: buildLayoutTable([
            { tag: 'kern' },
            { tag: 'calt' },
            { tag: 'ss02', uiNameId: 258 }
        ])
    });

    test('reads glyph names and glyph order from post v2 + maxp', () => {
        expect(get_glyph_name(sampleFont, 0)).toBe('.notdef');
        expect(get_glyph_name(sampleFont, 1)).toBe('A');
        expect(get_glyph_name(sampleFont, 2)).toBe('alef-ar');
        expect(get_glyph_name(sampleFont, 3)).toBe('beh-ar.init');
        expect(get_glyph_name(sampleFont, 99)).toBe('glyph00099');
        expect(get_glyph_order(sampleFont)).toEqual([
            '.notdef',
            'A',
            'alef-ar',
            'beh-ar.init'
        ]);
    });

    test('reads variation axes from fvar + name', () => {
        expect(JSON.parse(get_font_axes(sampleFont))).toEqual([
            { tag: 'wght', name: 'Weight', min: 100, max: 900, default: 400 },
            { tag: 'OPSZ', name: 'OPSZ', min: 8, max: 72, default: 14 }
        ]);
    });

    test('reads features with tables and stylistic set UI names from GSUB/GPOS', () => {
        expect(JSON.parse(get_font_features_with_tables(sampleFont))).toEqual({
            liga: ['GSUB'],
            calt: ['GPOS', 'GSUB'],
            ss01: ['GSUB'],
            kern: ['GPOS'],
            ss02: ['GPOS']
        });
        expect(JSON.parse(get_stylistic_set_names(sampleFont))).toEqual({
            ss01: 'Alternate Alef',
            ss02: 'Swash'
        });
    });
});
