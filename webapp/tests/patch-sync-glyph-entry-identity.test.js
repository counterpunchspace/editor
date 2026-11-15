// A window's font data holds one entry per glyph. A glyph's room can still
// name the glyph by a name font-core has already renamed (a catch-up older
// than the rename); patching from it must not add a second entry, or the
// window shows the glyph under both names.

const { PatchSyncEngine } = require('../js/patch-sync-engine');

function engineWithGlyph() {
    const engine = new PatchSyncEngine('identity');
    engine.initFromJson({
        upm: 1000,
        masters: [{ id: 'm1', name: { dflt: 'Regular' }, location: {} }],
        glyphs: [
            { name: 'A', category: 'Base', layers: [] },
            { name: 'fuzz.new', category: 'Base', layers: [] }
        ]
    });
    const json = engine.getFontJsonSnapshot();
    const id = json.glyphs.find((glyph) => glyph.name === 'fuzz.new').id;
    expect(typeof id).toBe('string');
    return { engine, json, id };
}

const names = (json) => json.glyphs.map((glyph) => glyph.name);

test('a patch under the room’s older name updates the renamed entry instead of adding one', () => {
    const { engine, json, id } = engineWithGlyph();
    // Font-core renamed it; the glyph's room still says fuzz.new.
    json.glyphs.find((glyph) => glyph.id === id).name = 'fuzz.renamed';
    engine._patchGlyphFromYDoc('fuzz.new');
    expect(json.glyphs.filter((glyph) => glyph.id === id)).toHaveLength(1);
    expect(names(json)).toHaveLength(2);
});

test('a second entry for the same glyph is dropped when the glyph is patched', () => {
    const { engine, json, id } = engineWithGlyph();
    json.glyphs.push({ name: 'fuzz.stale', id, category: 'Base', layers: [] });
    engine._patchGlyphFromYDoc('fuzz.new');
    expect(names(json)).toEqual(['A', 'fuzz.new']);
});
