const {
    bucketFor,
    catalogDocumentId,
    chooseRoomLayout,
    isLayoutDocumentId,
    kerningBucketFor,
    kerningDocumentId,
    kerningKey,
    layoutDocumentIds,
    layoutDocumentKind,
    layoutHash,
    codepointIndexFromCatalog,
    parseKerningKey,
    parseRoomLayout
} = require('../js/filesystem-plugins/cloud-room-layout');

describe('room layout 2', () => {
    test('document kinds match collab’s canonical shard ids', () => {
        expect(layoutDocumentKind('font-core')).toBe('core');
        expect(layoutDocumentKind('font-deps')).toBe('deps');
        expect(layoutDocumentKind('features')).toBe('features');
        expect(layoutDocumentKind('catalog:0')).toBe('catalog');
        expect(layoutDocumentKind('kerning:1023')).toBe('kerning');
        expect(layoutDocumentKind('glyph:abc')).toBe('glyph');
        for (const id of ['catalog:01', 'kerning:1024', 'catalog:', 'x']) {
            expect(layoutDocumentKind(id)).toBeNull();
        }
        expect(isLayoutDocumentId('features')).toBe(true);
        expect(isLayoutDocumentId('font-core')).toBe(false);
        expect(isLayoutDocumentId('glyph:abc')).toBe(false);
    });

    test('the bucket hash is FNV-1a over UTF-8 and stable', () => {
        // Reference values: FNV-1a 32 of "" and "a".
        expect(layoutHash('')).toBe(0x811c9dc5);
        expect(layoutHash('a')).toBe(0xe40c292c);
        expect(layoutHash('é')).toBe(layoutHash('é'));
        expect(bucketFor('anything', 1)).toBe(0);
        for (const key of ['A', '@MMK_L_A', 'グ', 'uni4E00']) {
            const bucket = bucketFor(key, 7);
            expect(bucket).toBeGreaterThanOrEqual(0);
            expect(bucket).toBeLessThan(7);
            expect(bucketFor(key, 7)).toBe(bucket);
        }
    });

    test('kerning buckets follow the first side, so a side’s pairs share a room', () => {
        expect(kerningBucketFor('A:V', 13)).toBe(kerningBucketFor('A:W', 13));
        expect(kerningBucketFor('@L:V', 13)).toBe(bucketFor('@L', 13));
        const key = kerningKey('master-1', 'r', '@a:b');
        expect(key).toBe('master-1|r|@a:b');
        expect(parseKerningKey(key)).toEqual({
            masterId: 'master-1',
            direction: 'r',
            pair: '@a:b'
        });
        expect(parseKerningKey('m|x|a:b')).toBeNull();
        expect(parseKerningKey('|l|a:b')).toBeNull();
    });

    test('a chosen layout leaves room to double, and parses back', () => {
        expect(chooseRoomLayout({ glyphs: 0, kerningPairs: 0 })).toEqual({
            version: 2,
            catalogBuckets: 1,
            kerningBuckets: 1
        });
        const layout = chooseRoomLayout({
            glyphs: 16954,
            kerningPairs: 250000
        });
        expect(layout).toEqual({
            version: 2,
            catalogBuckets: 9,
            kerningBuckets: 13
        });
        expect(parseRoomLayout(layout)).toEqual(layout);
        expect(parseRoomLayout({ ...layout, version: 1 })).toBeNull();
        expect(parseRoomLayout({ ...layout, catalogBuckets: 0 })).toBeNull();
        expect(parseRoomLayout(null)).toBeNull();
        expect(
            layoutDocumentIds({
                ...layout,
                catalogBuckets: 2,
                kerningBuckets: 1
            })
        ).toEqual([
            'features',
            catalogDocumentId(0),
            catalogDocumentId(1),
            kerningDocumentId(0)
        ]);
    });

    test('the codepoint index is derived from catalog entries in either shape', () => {
        expect(
            codepointIndexFromCatalog({
                a: { codepoints: [65] },
                b: { codepoints: { 66: true, 65: true } },
                gone: { codepoints: [67], deleted: true }
            })
        ).toEqual({ 65: ['a', 'b'], 66: ['b'] });
    });
});
