#!/usr/bin/env node
// compile_binary_font for Fustat, both targets:
//   full   — no text, every glyph shard
//   subset — text mapped to the glyphs that text uses
//
// The editor keeps outlines in per-glyph Yjs shards. Seeding only font-core
// leaves the compiler with feature classes and no glyphs, which traps.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import init, {
    compile_cached_font,
    compile_debug_cached_font_from_last_layout_closure,
    get_debug_cached_font_bytes,
    open_font_file,
    prime_debug_layout_closure_cache,
    rebuild_caches_from_ydoc_set,
    reset_ydoc_set,
    seed_ydoc_document
} from '../wasm-dist/babelfont_fontc_web.js';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const __dirname = dirname(fileURLToPath(import.meta.url));

const fullOptions = {
    skip_kerning: false,
    skip_features: false,
    skip_metrics: false,
    skip_outlines: false,
    dont_use_production_names: true,
    drop_incompatible_paths: true,
    produce_varc_table: true
};

function toY(value) {
    if (Array.isArray(value)) {
        const array = new Y.Array();
        array.push(value.map((item) => toY(item)));
        return array;
    }
    if (value && typeof value === 'object') {
        const map = new Y.Map();
        for (const [key, child] of Object.entries(value)) {
            map.set(key, toY(child));
        }
        return map;
    }
    return value;
}

function glyphShard(glyph) {
    const doc = new Y.Doc();
    const glyphMap = doc.getMap('glyph');
    for (const [key, value] of Object.entries(glyph)) {
        if (key === 'layers' && Array.isArray(value)) {
            const layers = new Y.Map();
            for (const layer of value) {
                const layerId = layer.id || 'layer';
                layers.set(layerId, toY({ ...layer, id: layerId }));
            }
            glyphMap.set('layers', layers);
            continue;
        }
        glyphMap.set(key, toY(value));
    }
    if (!glyphMap.has('name')) {
        glyphMap.set('name', glyph.name);
    }
    return Y.encodeStateAsUpdate(doc);
}

function coreSnapshot(font) {
    const doc = new Y.Doc();
    const fontMap = doc.getMap('font');
    const glyphOrder = new Y.Array();
    glyphOrder.push(font.glyphs.map((glyph) => glyph.name));
    fontMap.set('glyphOrder', glyphOrder);
    fontMap.set('glyphs', new Y.Map());
    for (const [key, value] of Object.entries(font)) {
        if (key === 'glyphs' || key === 'glyphOrder') {
            continue;
        }
        fontMap.set(key, toY(value));
    }
    return Y.encodeStateAsUpdate(doc);
}

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

function compileClosure(glyphNames) {
    prime_debug_layout_closure_cache(JSON.stringify(glyphNames));
    const fontHash =
        compile_debug_cached_font_from_last_layout_closure(fullOptions);
    return get_debug_cached_font_bytes(fontHash);
}

function seedShards(font, glyphs) {
    reset_ydoc_set();
    seed_ydoc_document('font-core', coreSnapshot({ ...font, glyphs }));
    for (const glyph of glyphs) {
        seed_ydoc_document(`glyph:${glyph.name}`, glyphShard(glyph));
    }
    rebuild_caches_from_ydoc_set();
}

await init(
    readFileSync(join(__dirname, '../wasm-dist/babelfont_fontc_web_bg.wasm'))
);

const source = readFileSync(
    join(__dirname, '../examples/Fustat.glyphs'),
    'utf8'
);
const font = JSON.parse(open_font_file('Fustat.glyphs', source));
assert.ok(font.glyphs.length > 1000, 'Fustat should load its full glyph set');

seedShards(font, font.glyphs);
const fullBytes = compile_cached_font(fullOptions);
const fullGlyphCount = numGlyphs(fullBytes);
assert.ok(
    fullGlyphCount > 1000,
    `full Fustat compile should contain the font, got ${fullGlyphCount} glyphs`
);
assert.notEqual(cmapGlyph(fullBytes, 0x41), 0, 'full font should encode A');
assert.notEqual(cmapGlyph(fullBytes, 0x42), 0, 'full font should encode B');

seedShards(font, font.glyphs);
const subsetA = compileClosure(['A']);
const subsetB = compileClosure(['B']);
assert.notEqual(
    cmapGlyph(subsetA, 0x41),
    0,
    'subset for A should encode U+0041'
);
assert.equal(
    cmapGlyph(subsetA, 0x42),
    0,
    'subset for A should not encode U+0042'
);
assert.notEqual(
    cmapGlyph(subsetB, 0x42),
    0,
    'subset for B should encode U+0042'
);
assert.equal(
    cmapGlyph(subsetB, 0x41),
    0,
    'subset for B should not encode U+0041'
);
assert.ok(
    numGlyphs(subsetA) < fullGlyphCount && numGlyphs(subsetB) < fullGlyphCount,
    'a text subset should contain fewer glyphs than the full font'
);
assert.notDeepEqual(
    Array.from(subsetA),
    Array.from(subsetB),
    'different subset text should not compile the same font'
);

reset_ydoc_set();
seed_ydoc_document('font-core', coreSnapshot(font));
rebuild_caches_from_ydoc_set();
assert.throws(
    () => compile_cached_font(fullOptions),
    /unreachable|No master at default location|Compilation failed/,
    'core-only Fustat seed must not compile as a full font'
);

console.log(
    `Fustat compile_binary_font ok fullGlyphs=${fullGlyphCount} subsetA=${numGlyphs(subsetA)} subsetB=${numGlyphs(subsetB)}`
);
