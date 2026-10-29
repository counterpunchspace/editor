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
const { cmapGlyph, numGlyphs } = require('./helpers/truetype-tables.js');
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
