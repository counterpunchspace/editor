// The glyph name index is rebuilt from the glyph documents a window holds.
// A deleted glyph's document can stay resident a while, still named; it
// must not take the name back from a glyph added again under that name.

const { PatchSyncEngine } = require('../js/patch-sync-engine');
const {
    applyCloudOwnedData
} = require('../js/filesystem-plugins/cloud-glyph-catalog');

function engineWith(names) {
    const fontJson = {
        upm: 1000,
        masters: [{ id: 'm1', name: { dflt: 'Regular' }, location: {} }],
        glyphs: names.map((name) => ({ name, category: 'Base', layers: [] }))
    };
    applyCloudOwnedData(fontJson);
    const engine = new PatchSyncEngine('name-index');
    engine.initFromJson(fontJson);
    const json = engine.getFontJsonSnapshot();
    const idOf = (name) => json.glyphs.find((glyph) => glyph.name === name).id;
    return { engine, json, idOf };
}

test('a deleted glyph’s resident document does not take its name back', () => {
    const { engine, json, idOf } = engineWith(['A', 'fuzz.renamed']);
    const deletedId = idOf('fuzz.renamed');
    json.glyphCatalog[deletedId].deleted = true;
    engine._rebuildGlyphNameIndexFromDocs();
    expect(engine._glyphIdByName.has('fuzz.renamed')).toBe(false);
    expect(engine._glyphIdByName.get('A')).toBe(idOf('A'));
});

test('a glyph added again under a deleted glyph’s name keeps the name', () => {
    const { engine, json, idOf } = engineWith(['fuzz.renamed', 'fuzz.again']);
    const oldId = idOf('fuzz.renamed');
    const newId = idOf('fuzz.again');
    // The new glyph took the name; the old one is deleted but resident.
    engine._glyphDocs.get(newId).getMap('glyph').set('name', 'fuzz.renamed');
    json.glyphCatalog[newId].name = 'fuzz.renamed';
    json.glyphCatalog[oldId].deleted = true;
    engine._rebuildGlyphNameIndexFromDocs();
    expect(engine._glyphIdByName.get('fuzz.renamed')).toBe(newId);
    // Even before the catalog marks the old one deleted, the catalog's
    // glyph for the name wins over a stale document.
    delete json.glyphCatalog[oldId].deleted;
    engine._rebuildGlyphNameIndexFromDocs();
    expect(engine._glyphIdByName.get('fuzz.renamed')).toBe(newId);
});

test('a catalog tombstone that arrives after the glyph was indexed frees its name', () => {
    const { engine, json, idOf } = engineWith(['A', 'fuzz.renamed']);
    const deletedId = idOf('fuzz.renamed');
    expect(engine._glyphIdByName.get('fuzz.renamed')).toBe(deletedId);
    json.glyphCatalog[deletedId].deleted = true;
    engine._dropDeletedGlyphNamesFromIndex();
    expect(engine._glyphIdByName.has('fuzz.renamed')).toBe(false);
    expect(engine._glyphIdByName.get('A')).toBe(idOf('A'));
});
