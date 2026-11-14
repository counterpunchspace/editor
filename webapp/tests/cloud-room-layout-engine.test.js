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

    test('a peer hears that the layout changed when an upgraded core arrives', () => {
        const owner = new PatchSyncEngine('layout-owner-2');
        owner.initFromJson(makeFont());
        const peer = new PatchSyncEngine('layout-peer-2');
        peer.initFromJson({});
        peer.applyDocumentSetState(owner.encodeDocumentSet());
        const heard = [];
        peer.onRoomLayoutChange((layout) => heard.push(layout));
        owner.adoptRoomLayout({ version: 2, catalogBuckets: 1, kerningBuckets: 2 });
        const packets = [];
        owner.onLocalUpdate((update, message, _entries, documentId) =>
            packets.push({ update, message, documentId })
        );
        expect(owner.publishAdoptedRoomLayout()).toBe(true);
        for (const packet of packets) {
            peer.applyRemoteUpdate(packet.update, undefined, [packet.message], packet.documentId);
        }
        expect(heard).toEqual([{ version: 2, catalogBuckets: 1, kerningBuckets: 2 }]);
        // The rooms catch up after the core change; kerning comes back.
        expect(snapshotOf(peer).masters[0].kerning).toEqual({});
        for (const shard of owner.encodeDocumentSet()) {
            if (shard.documentId.startsWith('kerning:') || shard.documentId === 'features') {
                peer.applyDocumentCatchUp(shard.documentId, shard.bytes);
            }
        }
        expect(snapshotOf(peer)).toEqual(snapshotOf(owner));
    });

    test('a whole master write keeps existing kerning and brings a new master’s', () => {
        const { engine } = adopted();
        const before = snapshotOf(engine).masters;
        const masters = JSON.parse(JSON.stringify(engine.getFontJsonSnapshot().masters));
        // A stale copy without kerning must not wipe the rooms.
        masters[0].kerning = {};
        masters[0].name = { dflt: 'Light' };
        masters.push({ id: 'm3', name: { dflt: 'Black' }, location: {}, kerning: { 'A:V': -120 } });
        engine.recordChange([], 'masters', undefined, masters);
        const after = snapshotOf(engine).masters;
        expect(after[0].name).toEqual({ dflt: 'Light' });
        expect(after[0].kerning).toEqual(before[0].kerning);
        expect(after[2]).toMatchObject({ id: 'm3', kerning: { 'A:V': -120 } });
        // Removing a master removes its pairs.
        engine.recordChange([], 'masters', undefined, masters.filter((m) => m.id !== 'm2'));
        const shards = engine.encodeDocumentSet().filter((s) => s.documentId.startsWith('kerning:'));
        const keys = shards.flatMap((s) => {
            const doc = new Y.Doc();
            Y.applyUpdate(doc, s.bytes);
            return [...doc.getMap('kerning').keys()];
        });
        expect(keys.some((key) => key.startsWith('m2|'))).toBe(false);
    });

    test('a rebase moves full buckets to fresh rooms and a peer follows', () => {
        const { rebasedRoomLayout } = require('../js/filesystem-plugins/cloud-room-layout');
        const owner = new PatchSyncEngine('rebase-owner');
        const font = makeFont();
        font.masters[0].kerning = Object.fromEntries(
            Array.from({ length: 50 }, (_, i) => [`g${i}:V`, -i])
        );
        owner.initFromJson(font);
        owner.adoptRoomLayout({ version: 2, catalogBuckets: 1, kerningBuckets: 1 }, { seedsWholeAsset: true });
        const peer = new PatchSyncEngine('rebase-peer');
        peer.initFromJson({});
        peer.applyDocumentSetState(owner.encodeDocumentSet());
        const before = snapshotOf(owner);

        const fill = owner.roomLayoutFill();
        expect(fill.largestKerningBucket).toBe(52);
        // With a tiny budget the kerning bucket counts as full.
        const next = rebasedRoomLayout(owner.roomLayout, {
            ...fill,
            largestKerningBucket: 1e9
        });
        expect(next).toMatchObject({ kerningBuckets: 2, kerningBase: 1, catalogBuckets: 1 });
        expect(owner.rebaseRoomLayout(next)).toBe(true);
        expect(owner.layoutDocumentIds()).toEqual(['features', 'catalog:0', 'kerning:1', 'kerning:2']);
        expect(snapshotOf(owner)).toEqual(before);

        const packets = [];
        owner.onLocalUpdate((update, message, _entries, documentId) =>
            packets.push({ update, message, documentId })
        );
        expect(owner.publishAdoptedRoomLayout()).toBe(true);
        const heard = [];
        peer.onRoomLayoutChange((layout) => heard.push(layout));
        for (const packet of packets) {
            peer.applyRemoteUpdate(packet.update, undefined, [packet.message], packet.documentId);
        }
        expect(heard).toEqual([next]);
        for (const shard of owner.encodeDocumentSet()) {
            if (shard.documentId.startsWith('kerning:')) {
                peer.applyDocumentCatchUp(shard.documentId, shard.bytes);
            }
        }
        expect(snapshotOf(peer)).toEqual(before);
        expect([...peer._layoutDocs.keys()].sort()).toEqual(['catalog:0', 'features', 'kerning:1', 'kerning:2']);
    });
});
