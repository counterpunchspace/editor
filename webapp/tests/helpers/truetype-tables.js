// Minimal TrueType readers for asserting on compiled test fonts.

function fontBytes(bytes) {
    return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
    );
}

function tableOffset(view, tag) {
    const numTables = view.getUint16(4);
    for (let index = 0; index < numTables; index += 1) {
        const record = 12 + index * 16;
        const name = String.fromCharCode(
            view.getUint8(record),
            view.getUint8(record + 1),
            view.getUint8(record + 2),
            view.getUint8(record + 3)
        );
        if (name === tag) {
            return view.getUint32(record + 8);
        }
    }
    throw new Error(`missing ${tag} table`);
}

function numGlyphs(bytes) {
    const view = new DataView(fontBytes(bytes));
    return view.getUint16(tableOffset(view, 'maxp') + 4);
}

function cmapFormat4(view, offset, codepoint) {
    if (codepoint > 0xffff) {
        return 0;
    }
    const segCount = view.getUint16(offset + 6) / 2;
    const endCountPos = offset + 14;
    const startCountPos = endCountPos + segCount * 2 + 2;
    const idDeltaPos = startCountPos + segCount * 2;
    const idRangeOffsetPos = idDeltaPos + segCount * 2;
    for (let index = 0; index < segCount; index += 1) {
        const end = view.getUint16(endCountPos + index * 2);
        if (codepoint > end) {
            continue;
        }
        const start = view.getUint16(startCountPos + index * 2);
        if (codepoint < start) {
            return 0;
        }
        const rangeOffset = view.getUint16(idRangeOffsetPos + index * 2);
        const idDelta = view.getInt16(idDeltaPos + index * 2);
        if (rangeOffset === 0) {
            return (codepoint + idDelta) & 0xffff;
        }
        const glyphIndexPos =
            idRangeOffsetPos +
            index * 2 +
            rangeOffset +
            (codepoint - start) * 2;
        const glyphId = view.getUint16(glyphIndexPos);
        return glyphId === 0 ? 0 : (glyphId + idDelta) & 0xffff;
    }
    return 0;
}

function cmapFormat12(view, offset, codepoint) {
    const groupCount = view.getUint32(offset + 12);
    let low = 0;
    let high = groupCount - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        const record = offset + 16 + mid * 12;
        const start = view.getUint32(record);
        const end = view.getUint32(record + 4);
        if (codepoint < start) {
            high = mid - 1;
        } else if (codepoint > end) {
            low = mid + 1;
        } else {
            return view.getUint32(record + 8) + (codepoint - start);
        }
    }
    return 0;
}

function cmapGlyph(bytes, codepoint) {
    const view = new DataView(fontBytes(bytes));
    const cmap = tableOffset(view, 'cmap');
    const tableCount = view.getUint16(cmap + 2);
    let chosen = null;
    for (let index = 0; index < tableCount; index += 1) {
        const record = cmap + 4 + index * 8;
        const platform = view.getUint16(record);
        const encoding = view.getUint16(record + 2);
        const offset = cmap + view.getUint32(record + 4);
        const format = view.getUint16(offset);
        const score =
            platform === 3 && encoding === 10
                ? 3
                : platform === 3 && encoding === 1
                  ? 2
                  : platform === 0
                    ? 1
                    : 0;
        if (score > 0 && (!chosen || score > chosen.score)) {
            chosen = { offset, format, score };
        }
    }
    if (!chosen) {
        return 0;
    }
    if (chosen.format === 12) {
        return cmapFormat12(view, chosen.offset, codepoint);
    }
    if (chosen.format === 4) {
        return cmapFormat4(view, chosen.offset, codepoint);
    }
    return 0;
}

module.exports = { cmapGlyph, numGlyphs };
