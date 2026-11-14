/**
 * Room layout 2 in the patch sync engine: features, the glyph catalog and
 * master kerning live in their own documents, while the font JSON every
 * window works with stays the same.
 */

const Y = require('yjs');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const {
    chooseRoomLayout,
    kerningBucketFor,
    kerningDocumentId
} = require('../js/filesystem-plugins/cloud-room-layout');

function makeFont() {
    return {
        upm: 1000,
        version: [1, 0],
        names: { familyName: 'Layout' },
        axes: [],
        features: {
            classes: { upper: 'A V' },
            prefixes: {},
            features: [['kern', 'pos A V -80;']]
        },
        masters: [
            {
                id: 'm1',
                name: { dflt: 'Regular' },
                location: {},
                kerning: { 'A:V': -80, '@round:o': -10 },
                kerning_rtl: { 'alef:beh': 20 }
            },
            {
                id: 'm2',
                name: { dflt: 'Bold' },
                location: {},
                kerning: { 'A:V': -100 }
            }
        ],
        glyphs: ['A', 'V', 'o'].map((name, index) => ({
            name,
            production_name: null,
            category: 'Base',
            codepoints: [65 + index],
            exported: true,
            layers: [
                {
                    id: `L${index}`,
                    width: 500,
                    master: { type: 'DefaultForMaster', master: 'm1' },
                    shapes: [],
                    anchors: []
                }
            ]
        }))
    };
}

function snapshotOf(engine) {
    const json = JSON.parse(JSON.stringify(engine.getFontJsonSnapshot()));
    return {
        features: json.features,
        masters: json.masters.map((master) => ({
            id: master.id,
            name: master.name,
            kerning: master.kerning,
            kerning_rtl: master.kerning_rtl ?? {}
        }))
    };
}

function adopted(layout = { version: 2, catalogBuckets: 2, kerningBuckets: 3 }) {
    const engine = new PatchSyncEngine('layout-owner');
    engine.initFromJson(makeFont());
    const before = snapshotOf(engine);
    expect(engine.adoptRoomLayout(layout, { seedsWholeAsset: true })).toBe(true);
    return { engine, before, layout };
}

describe('room layout 2 in the engine', () => {
    test('adopting moves features and kerning out of core without changing the font', () => {
        const { engine, before } = adopted();
        expect(engine.roomLayout).toEqual({
            version: 2,
            catalogBuckets: 2,
            kerningBuckets: 3
        });
        expect(snapshotOf(engine)).toEqual(before);

        const shards = engine.encodeDocumentSet();
        const ids = shards.map((shard) => shard.documentId);
        expect(ids).toEqual(
            expect.arrayContaining([
                'font-core',
                'font-deps',
                'features',
                'catalog:0',
                'catalog:1',
                'kerning:0',
                'kerning:1',
                'kerning:2'
            ])
        );

        const core = new Y.Doc();
        Y.applyUpdate(core, shards.find((s) => s.documentId === 'font-core').bytes);
        const font = core.getMap('font');
        expect(font.has('features')).toBe(false);
        expect(font.has('glyphCatalog')).toBe(false);
        for (const master of font.get('masters').toArray()) {
            expect(master.has('kerning')).toBe(false);
            expect(master.has('kerning_rtl')).toBe(false);
        }
        expect(core.getMap('layout').toJSON()).toEqual({
            version: 2,
            catalogBuckets: 2,
            kerningBuckets: 3
        });

        const kerningKeys = shards
            .filter((s) => s.documentId.startsWith('kerning:'))
            .flatMap((s) => {
                const doc = new Y.Doc();
                Y.applyUpdate(doc, s.bytes);
                return [...doc.getMap('kerning').keys()].map((key) => [
                    s.documentId,
                    key
                ]);
            });
        expect(kerningKeys.map(([, key]) => key).sort()).toEqual([
            'm1|l|@round:o',
            'm1|l|A:V',
            'm1|r|alef:beh',
            'm2|l|A:V'
        ]);
        for (const [documentId, key] of kerningKeys) {
            const pair = key.split('|')[2];
            expect(documentId).toBe(kerningDocumentId(kerningBucketFor(pair, 3)));
        }
        expect(engine.adoptRoomLayout(chooseRoomLayout({ glyphs: 3, kerningPairs: 4 }))).toBe(false);
    });

    test('a kerning edit goes to its bucket and a peer sees the same font', () => {
        const { engine } = adopted();
        const peer = new PatchSyncEngine('layout-peer');
        peer.initFromJson({});
        peer.applyDocumentSetState(engine.encodeDocumentSet());
        expect(snapshotOf(peer)).toEqual(snapshotOf(engine));

        const packets = [];
        engine.onLocalUpdate((update, _message, entries, documentId) => {
            packets.push({ update, entries, documentId });
        });
        engine.recordChange(['masters', 0, 'kerning'], 'A:V', -80, -60);
        expect(packets.map((packet) => packet.documentId)).toEqual([
            kerningDocumentId(kerningBucketFor('A:V', 3))
        ]);
        expect(snapshotOf(engine).masters[0].kerning['A:V']).toBe(-60);

        for (const packet of packets) {
            peer.applyRemoteUpdate(
                packet.update,
                packet.entries,
                undefined,
                packet.documentId
            );
        }
        expect(snapshotOf(peer)).toEqual(snapshotOf(engine));
    });

    test('a feature edit goes to the features room', () => {
        const { engine } = adopted();
        const packets = [];
        engine.onLocalUpdate((_update, _message, _entries, documentId) => {
            packets.push(documentId);
        });
        engine.recordChange(['features', 'classes'], 'upper', 'A V', 'A V W');
        expect(packets).toEqual(['features']);
        expect(snapshotOf(engine).features.classes.upper).toBe('A V W');
    });

    test('replacing a whole kerning map writes only the difference', () => {
        const { engine } = adopted();
        const packets = [];
        engine.onLocalUpdate((_update, _message, _entries, documentId) => {
            packets.push(documentId);
        });
        engine.recordChange(['masters', 0], 'kerning', { 'A:V': -80, '@round:o': -10 }, {
            'A:V': -80
        });
        expect(snapshotOf(engine).masters[0].kerning).toEqual({ 'A:V': -80 });
        expect(new Set(packets)).toEqual(
            new Set([kerningDocumentId(kerningBucketFor('@round:o', 3))])
        );
    });
});
