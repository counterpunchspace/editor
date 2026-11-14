const fs = require('fs');
const path = require('path');
const { open_font_file } = require('../wasm-dist/babelfont_fontc_web');
const {
    jsonPartsToChunks,
    jsonPartsToData
} = require('../js/babelfont-model');
const {
    canonicalizeImportedFontJson
} = require('../js/font-import-canonicalization');

const EXAMPLES = path.join(__dirname, '..', 'examples');

function openExample(name) {
    const text = fs.readFileSync(path.join(EXAMPLES, name), 'utf-8');
    return canonicalizeImportedFontJson(open_font_file(name, text)).fontModel;
}

describe('Font.toJSONParts', () => {
    test.each([
        'Fustat.glyphs',
        'FeatureVariations.glyphs',
        'G3RTLKerning.glyphs',
        'NestedComponents.glyphs',
        'intermediate_layer_on_a.glyphs',
        'metricskeys.glyphs'
    ])('joins to exactly the toJSONString text of %s', (name) => {
        const font = openExample(name);
        for (const options of [
            { compileFacing: false },
            { compileFacing: true },
            { compileFacing: false, glyphBodies: new Set(['a', 'A']) }
        ]) {
            const whole = font.toJSONString(options);
            const parts = font.toJSONParts(options);
            expect(jsonPartsToChunks(parts).join('')).toBe(whole);
            expect(jsonPartsToData(parts)).toEqual(JSON.parse(whole));
        }
    });

    test('handles a font without glyphs', () => {
        const font = openExample('metricskeys.glyphs');
        font._data.glyphs = [];
        const parts = font.toJSONParts();
        expect(jsonPartsToChunks(parts).join('')).toBe(font.toJSONString());
    });
});
