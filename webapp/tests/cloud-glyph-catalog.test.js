const {
    applyCloudOwnedData,
    buildFontDepsIndex,
    buildLeanGlyphCatalog,
    CLOUD_PLUGIN_OWNED_KEY,
    ensureImmutableGlyphId,
    stripOwnedFontData
} = require('../js/filesystem-plugins/cloud-glyph-catalog');
const {
    classifyShardByteLength,
    evaluateShardSizes,
    MAX_SHARD_BYTES,
    WARNING_SHARD_BYTES
} = require('../js/filesystem-plugins/cloud-shard-limits');
const {
    CloudDocumentSet,
    FONT_CORE_DOCUMENT_ID,
    routePathToDocumentId
} = require('../js/filesystem-plugins/cloud-document-set');

describe('cloud glyph catalog', () => {
    const font = {
        upm: 1000,
        glyphs: [
            {
                name: 'A',
                codepoints: [65],
                exported: true,
                layers: [
                    {
                        shapes: [{ reference: 'B' }]
                    }
                ]
            },
            {
                name: 'B',
                codepoints: [66],
                exported: true,
                layers: []
            }
        ]
    };

    it('assigns immutable ids and builds catalog plus cmap', () => {
        const { entries, codepointIndex } = buildLeanGlyphCatalog(font);
        expect(entries).toHaveLength(2);
        expect(entries[0].glyphId).toBeTruthy();
        expect(entries[0].name).toBe('A');
        expect(codepointIndex['65']).toEqual([entries[0].glyphId]);
        expect(ensureImmutableGlyphId(font.glyphs[0])).toBe(entries[0].glyphId);
    });

    it('records component dependencies by glyph id', () => {
        const { entries } = buildLeanGlyphCatalog(font);
        const deps = buildFontDepsIndex(font);
        expect(deps[entries[0].glyphId]).toContain(entries[1].glyphId);
    });

    it('strips plugin-owned catalog data', () => {
        applyCloudOwnedData(font);
        expect(font.format_specific[CLOUD_PLUGIN_OWNED_KEY]).toBeTruthy();
        const stripped = stripOwnedFontData(font);
        expect(
            stripped.format_specific?.[CLOUD_PLUGIN_OWNED_KEY]
        ).toBeUndefined();
        expect(font.format_specific[CLOUD_PLUGIN_OWNED_KEY]).toBeTruthy();
    });

    it('keeps live glyph ids and strips them only on export copies', () => {
        applyCloudOwnedData(font);
        expect(typeof font.glyphs[0].id).toBe('string');
        const stripped = stripOwnedFontData(font);
        expect(stripped.glyphs[0].id).toBeUndefined();
        expect(font.glyphs[0].id).toBeTruthy();
    });
});

describe('shard size gate', () => {
    it('warns at 75% and blocks at 10MB', () => {
        expect(classifyShardByteLength(WARNING_SHARD_BYTES)).toBe('warning');
        expect(classifyShardByteLength(MAX_SHARD_BYTES)).toBe('blocked');
        const gate = evaluateShardSizes([
            { documentId: FONT_CORE_DOCUMENT_ID, byteLength: MAX_SHARD_BYTES }
        ]);
        expect(gate.canSave).toBe(false);
        expect(gate.blocking).toHaveLength(1);
    });
});

describe('cloud document set', () => {
    it('encodes independent shards and routes glyph paths', () => {
        const set = new CloudDocumentSet();
        set.initFromFontJson({
            upm: 1000,
            glyphs: [{ name: 'A', codepoints: [65], layers: [] }]
        });
        const encoded = set.encodeAll();
        expect(
            encoded.some((shard) => shard.documentId === FONT_CORE_DOCUMENT_ID)
        ).toBe(true);
        expect(
            encoded.some((shard) => shard.documentId.startsWith('glyph:'))
        ).toBe(true);
        expect(routePathToDocumentId(['upm'])).toBe(FONT_CORE_DOCUMENT_ID);
        const assembled = set.assembleFontJson();
        expect(assembled.glyphs[0].name).toBe('A');
        expect(assembled.glyphs[0].id).toBeTruthy();
        set.destroy();
    });
});
