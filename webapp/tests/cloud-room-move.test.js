/**
 * A rebase moves the catalog or kerning to new rooms. Edits that reach the
 * old rooms after the copy (while it is stored, or from a window that has
 * not switched yet) are carried over to the new rooms, and never overwrite
 * a newer edit made in the new rooms.
 */

const Y = require('yjs');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const {
    rebasedRoomLayout
} = require('../js/filesystem-plugins/cloud-room-layout');

function makeFont() {
    return {
        upm: 1000,
        version: [1, 0],
        names: { familyName: 'Move' },
        axes: [],
        features: { classes: {}, prefixes: {}, features: [] },
        masters: [
            {
                id: 'm1',
                name: { dflt: 'Regular' },
                location: {},
                kerning: Object.fromEntries(
                    Array.from({ length: 50 }, (_, i) => [`g${i}:V`, -i])
                )
            }
        ],
        glyphs: ['A', 'V'].map((name, index) => ({
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

const kerning = (engine) => ({
    ...engine.getFontJsonSnapshot().masters[0].kerning
});

/** Packets an engine sends, delivered on demand. */
function outbox(engine) {
    const packets = [];
    engine.onLocalUpdate((update, message, entries, documentId) =>
        packets.push({ update, message, entries, documentId })
    );
    return {
        packets,
        deliverTo(target, filter = () => true) {
            const sent = packets.splice(0).filter(filter);
            for (const packet of sent) {
                target.applyRemoteUpdate(
                    packet.update,
                    packet.entries?.length ? packet.entries : undefined,
                    packet.message ? [packet.message] : undefined,
                    packet.documentId
                );
            }
            return sent;
        },
        drop() {
            packets.length = 0;
        }
    };
}

/** An owner and a peer on one kerning room, the owner mid-rebase. */
function moving() {
    const owner = new PatchSyncEngine('move-owner');
    owner.initFromJson(makeFont());
    owner.adoptRoomLayout(
        { version: 2, catalogBuckets: 1, kerningBuckets: 1 },
        { seedsWholeAsset: true }
    );
    const peer = new PatchSyncEngine('move-peer');
    peer.initFromJson({});
    peer.applyDocumentSetState(owner.encodeDocumentSet());
    const ownerOut = outbox(owner);
    const peerOut = outbox(peer);
    const next = rebasedRoomLayout(owner.roomLayout, {
        ...owner.roomLayoutFill(),
        largestKerningBucket: 1e9
    });
    expect(owner.rebaseRoomLayout(next)).toBe(true);
    expect(owner.retiredLayoutDocumentIds()).toEqual(['kerning:0']);
    return { owner, peer, ownerOut, peerOut, next };
}

/** The peer hears the move and loads the new rooms. */
function peerSwitches({ owner, peer, ownerOut }) {
    ownerOut.deliverTo(peer);
    for (const shard of owner.encodeDocumentSet()) {
        if (shard.documentId.startsWith('kerning:')) {
            peer.applyDocumentCatchUp(shard.documentId, shard.bytes);
        }
    }
    expect(peer.retiredLayoutDocumentIds()).toEqual(['kerning:0']);
}

describe('rebase hand-over', () => {
    test('an edit that reaches an old room while the copy is stored is carried over', async () => {
        const ctx = moving();
        const { owner, peer, ownerOut, peerOut } = ctx;
        // The peer has not switched: its edit goes to the old room.
        peer.recordChange(['masters', 0, 'kerning'], 'g1:V', -1, -999);
        expect(peerOut.deliverTo(owner).map((p) => p.documentId)).toEqual([
            'kerning:0'
        ]);
        expect(kerning(owner)['g1:V']).toBe(-1);

        expect(owner.publishAdoptedRoomLayout()).toBe(true);
        expect(owner.forwardRetiredLayoutEdits()).toBe(1);
        expect(kerning(owner)['g1:V']).toBe(-999);
        // Sent to the pair's new room.
        expect(
            ownerOut.packets
                .map((p) => p.documentId)
                .filter((id) => id.startsWith('kerning:'))
        ).toEqual([owner.documentIdForPath(['masters', 0, 'kerning', 'g1:V'])]);

        peerSwitches(ctx);
        // The peer finds the same edit already carried over.
        expect(peer.forwardRetiredLayoutEdits()).toBe(0);
        expect(kerning(peer)).toEqual(kerning(owner));
    });

    test('an edit the owner never got is carried over by the window that made it', () => {
        const ctx = moving();
        const { owner, peer, ownerOut, peerOut } = ctx;
        peer.recordChange(['masters', 0, 'kerning'], 'g2:V', -2, -777);
        peerOut.drop();
        expect(owner.publishAdoptedRoomLayout()).toBe(true);
        expect(owner.forwardRetiredLayoutEdits()).toBe(0);

        peerSwitches(ctx);
        expect(kerning(peer)['g2:V']).toBe(-2);
        expect(peer.forwardRetiredLayoutEdits()).toBe(1);
        expect(kerning(peer)['g2:V']).toBe(-777);
        const sent = peerOut.deliverTo(owner);
        expect(sent.map((p) => p.documentId)).toEqual([
            owner.documentIdForPath(['masters', 0, 'kerning', 'g2:V'])
        ]);
        expect(kerning(owner)).toEqual(kerning(peer));
        void ownerOut;
    });

    test('edits arriving after the switch are carried over as they arrive', async () => {
        const ctx = moving();
        const { owner, peer, ownerOut, peerOut } = ctx;
        expect(owner.publishAdoptedRoomLayout()).toBe(true);
        owner.forwardRetiredLayoutEdits();
        ownerOut.drop();
        // A late peer keeps editing the old room twice, then deletes a pair.
        peer.recordChange(['masters', 0, 'kerning'], 'g3:V', -3, -10);
        peerOut.deliverTo(owner);
        await Promise.resolve();
        expect(kerning(owner)['g3:V']).toBe(-10);
        peer.recordChange(['masters', 0, 'kerning'], 'g3:V', -10, -20);
        peerOut.deliverTo(owner);
        await Promise.resolve();
        expect(kerning(owner)['g3:V']).toBe(-20);
        peer.recordChange(['masters', 0, 'kerning'], 'g4:V', -4, undefined);
        peerOut.deliverTo(owner);
        await Promise.resolve();
        expect('g4:V' in kerning(owner)).toBe(false);
    });

    test('an old room’s edit never overwrites a newer edit in the new room', async () => {
        const ctx = moving();
        const { owner, peer, ownerOut, peerOut } = ctx;
        expect(owner.publishAdoptedRoomLayout()).toBe(true);
        owner.forwardRetiredLayoutEdits();
        // Someone already on the new rooms edits the pair.
        owner.recordChange(['masters', 0, 'kerning'], 'g5:V', -5, -55);
        // A late window edits the same pair in the old room.
        peer.recordChange(['masters', 0, 'kerning'], 'g5:V', -5, -66);
        peerOut.deliverTo(owner);
        await Promise.resolve();
        expect(kerning(owner)['g5:V']).toBe(-55);

        peerSwitches(ctx);
        expect(peer.forwardRetiredLayoutEdits()).toBe(0);
        expect(kerning(peer)['g5:V']).toBe(-55);
        void ownerOut;
    });

    test('the owner carries over late edits on a later open, then forgets the move', () => {
        const ctx = moving();
        const { owner, peer, ownerOut, peerOut } = ctx;
        expect(owner.publishAdoptedRoomLayout()).toBe(true);
        owner.forwardRetiredLayoutEdits();
        ownerOut.drop();
        // The late edit reaches the old room's storage, but this owner
        // window has closed.
        peer.recordChange(['masters', 0, 'kerning'], 'g6:V', -6, -606);
        const [oldRoomEdit] = peerOut.packets.splice(0);
        const oldRoomState = owner.encodeDocumentState('kerning:0');

        const reopened = new PatchSyncEngine('move-owner-2');
        reopened.initFromJson({});
        reopened.applyDocumentSetState(owner.encodeDocumentSet());
        expect(kerning(reopened)['g6:V']).toBe(-6);
        expect(reopened.layoutMovedFromRoomIds()).toEqual(['kerning:0']);
        expect(reopened.retireMovedLayoutRooms()).toEqual(['kerning:0']);
        // The room's storage is compacted: overwritten values are gone.
        const stored = new Y.Doc({ gc: true });
        Y.applyUpdate(stored, oldRoomState);
        Y.applyUpdate(stored, oldRoomEdit.update);
        reopened.applyDocumentCatchUp(
            'kerning:0',
            Y.encodeStateAsUpdate(stored)
        );
        expect(reopened.forwardRetiredLayoutEdits()).toBe(1);
        expect(kerning(reopened)['g6:V']).toBe(-606);

        // A day later the move is forgotten and the old room let go.
        expect(reopened.pruneLayoutMoves(Date.now() + 1)).toBe(true);
        expect(reopened.publishAdoptedRoomLayout()).toBe(true);
        expect(reopened.layoutMovedFromRoomIds()).toEqual([]);
        expect(reopened.retiredLayoutDocumentIds()).toEqual([]);
        // Updates for the forgotten room are not read.
        expect(
            reopened.applyDocumentCatchUp('kerning:0', oldRoomEdit.update)
        ).toBe(false);
        expect(reopened.layoutDocumentIds()).not.toContain('kerning:0');
        void peer;
    });

    test('glyph list edits in an old catalog room are carried over, nested ones too', () => {
        const owner = new PatchSyncEngine('catalog-owner');
        owner.initFromJson(makeFont());
        owner.adoptRoomLayout(
            { version: 2, catalogBuckets: 1, kerningBuckets: 1 },
            { seedsWholeAsset: true }
        );
        const seeded = owner._docForId('catalog:0');
        seeded.transact(() => {
            for (const [glyphId, name] of [
                ['glyph-a', 'A'],
                ['glyph-v', 'V']
            ]) {
                const value = new Y.Map();
                value.set('name', name);
                seeded.getMap('catalog').set(glyphId, value);
            }
        }, 'font-edit');
        const peer = new PatchSyncEngine('catalog-peer');
        peer.initFromJson({});
        peer.applyDocumentSetState(owner.encodeDocumentSet());
        const peerOut = outbox(peer);
        const next = rebasedRoomLayout(owner.roomLayout, {
            ...owner.roomLayoutFill(),
            largestCatalogBucket: 1e9
        });
        expect(next).toMatchObject({ catalogBuckets: 2, catalogBase: 1 });
        expect(owner.rebaseRoomLayout(next)).toBe(true);
        expect(owner.retiredLayoutDocumentIds()).toEqual(['catalog:0']);

        // The late peer adds an entry, edits inside one and deletes one,
        // all in the old catalog room.
        const oldCatalog = peer._docForId('catalog:0');
        const map = oldCatalog.getMap('catalog');
        const [first, second] = ['glyph-a', 'glyph-v'];
        expect(map.get(first)).toBeTruthy();
        oldCatalog.transact(() => {
            const added = new Y.Map();
            added.set('name', 'B');
            map.set('glyph-late', added);
            map.get(first).set('name', 'A.renamed');
            map.delete(second);
        }, 'font-edit');
        const sent = peerOut.packets.splice(0);
        expect(sent.map((p) => p.documentId)).toEqual(['catalog:0']);
        for (const packet of sent) {
            owner.applyDocumentCatchUp('catalog:0', packet.update);
        }

        expect(owner.publishAdoptedRoomLayout()).toBe(true);
        expect(owner.forwardRetiredLayoutEdits()).toBe(3);
        const entry = (glyphId) => {
            const room = owner.documentIdForPath(['glyphCatalog', glyphId]);
            const value = owner._docForId(room).getMap('catalog').get(glyphId);
            return value?.toJSON?.() ?? value;
        };
        expect(entry('glyph-late')).toEqual({ name: 'B' });
        expect(entry(first).name).toBe('A.renamed');
        expect(entry(second)).toBeUndefined();
    });

    test('old rooms never reach the font or the compile worker', () => {
        const ctx = moving();
        const { owner, peer, peerOut } = ctx;
        const workerDocs = [];
        owner.setWorkerDocumentReplaceCallback?.((documentId) =>
            workerDocs.push(documentId)
        );
        owner._workerDocumentReplaceCallback = (documentId) =>
            workerDocs.push(documentId);
        owner._yjsWorkerCallback = (_update, _entries, documentId) =>
            workerDocs.push(documentId);
        peer.recordChange(['masters', 0, 'kerning'], 'g7:V', -7, -70);
        peerOut.deliverTo(owner);
        expect(workerDocs).not.toContain('kerning:0');
        expect(kerning(owner)['g7:V']).toBe(-7);
    });
});
