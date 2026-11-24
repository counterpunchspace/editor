/**
 * Babelfont JSON leaves out what is empty or optional: an empty `shapes`
 * list, a layer id. A real import (FustatMini.glyphs, whose space and
 * joiners have no outlines) goes through every load path as babelfont-rs
 * writes it: opening, handing the document set on, and reloading the
 * source from disk.
 */

const fs = require('fs');
const path = require('path');
const { open_font_file } = require('../wasm-dist/babelfont_fontc_web');
const {
    canonicalizeImportedFontData,
    canonicalizeImportedFontJson
} = require('../js/font-import-canonicalization');
const { PatchSyncEngine } = require('../js/patch-sync-engine');

const FUSTAT_MINI = path.join(__dirname, '..', 'examples', 'FustatMini.glyphs');

function importFustatMini() {
    return open_font_file(
        'FustatMini.glyphs',
        fs.readFileSync(FUSTAT_MINI, 'utf8')
    );
}

function drawingsWithoutShapes(font) {
    return font.glyphs.flatMap((glyph) =>
        (glyph.layers || [])
            .filter((drawing) => !('shapes' in drawing))
            .map((drawing) => `${glyph.name}/${drawing.id}`)
    );
}

describe('Babelfont’s encoding of empty and optional fields', () => {
    test('a real import has drawings without shapes, and canonicalization gives each its list', () => {
        const sourceJson = importFustatMini();
        expect(drawingsWithoutShapes(JSON.parse(sourceJson))).not.toEqual([]);

        const { fontData } = canonicalizeImportedFontJson(sourceJson);
        expect(drawingsWithoutShapes(fontData)).toEqual([]);
        const space = fontData.glyphs.find((glyph) => glyph.name === 'space');
        for (const drawing of space.layers) {
            expect(drawing.shapes).toEqual([]);
        }
    });

    test('the import opens, hands its documents on, and reloads from disk', () => {
        const { fontData } = canonicalizeImportedFontJson(importFustatMini());
        const engine = new PatchSyncEngine('babelfont-import-open');
        engine.initFromJson(fontData);

        const next = new PatchSyncEngine('babelfont-import-next');
        next.setFontJson(fontData);
        expect(() =>
            next.applyDocumentSetState(engine.encodeDocumentSet())
        ).not.toThrow();

        const reloaded = canonicalizeImportedFontJson(importFustatMini());
        expect(() =>
            engine.applyExternalSourceReload(
                reloaded.fontData,
                engine.encodeBridgeStateVector()
            )
        ).not.toThrow();
    });

    test('a drawing without an id gets one on import', () => {
        const source = JSON.parse(importFustatMini());
        const glyph = source.glyphs.find((entry) => entry.name === 'space');
        const free = { ...glyph.layers[0] };
        delete free.id;
        delete free.master;
        free.location = { wght: 400 };
        glyph.layers.push(free);

        const { fontData } = canonicalizeImportedFontData(source);
        const imported = fontData.glyphs.find(
            (entry) => entry.name === 'space'
        ).layers;
        const added = imported[imported.length - 1];
        expect(typeof added.id).toBe('string');
        expect(added.id.length).toBeGreaterThan(0);
        expect(new Set(imported.map((drawing) => drawing.id)).size).toBe(
            imported.length
        );

        const engine = new PatchSyncEngine('babelfont-import-no-id');
        expect(() => engine.initFromJson(fontData)).not.toThrow();
    });
});
