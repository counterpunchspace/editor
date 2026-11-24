/**
 * Outgoing packets are the merge of a document's own queued updates: every
 * local transaction is sent exactly once, never re-encoded against a
 * remembered state vector, so a packet carries only its own deletions.
 */
const Y = require('yjs');
const {
    PatchSyncEngine,
    DrawingInvariantError
} = require('../js/patch-sync-engine');
const {
    BrokenDocumentError,
    ClockGapError,
    isDocumentBroken
} = require('../js/yjs-update-integrity');
const { createLogEntry } = require('../js/change-log');

function remoteEntry(path, oldValue, newValue) {
    return createLogEntry({
        timestamp: Date.now(),
        windowId: 'remote-window',
        windowRoleLabel: 'Remote',
        historyItemId: 'remote-1',
        historyAction: 'change',
        transactionLabel: 'Remote edit',
        transactionId: null,
        op: 'set',
        path,
        oldValue,
        newValue,
        replayOldValue: oldValue,
        replayNewValue: newValue,
        compileChangeSource: null,
        compileEditType: null
    });
}

function makeFont() {
    return {
        upm: 1000,
        version: [1, 0],
        note: '',
        names: { familyName: 'Outbox' },
        axes: [],
        instances: [],
        masters: [
            {
                id: 'master-regular',
                name: { dflt: 'Regular' },
                location: {},
                guides: [],
                metrics: {},
                kerning: {}
            }
        ],
        glyphs: [
            {
                name: 'A',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'layer-1',
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-regular'
                        },
                        width: 600,
                        shapes: [],
                        anchors: []
                    }
                ]
            }
        ]
    };
}

function setup(windowId) {
    const bridge = new PatchSyncEngine(windowId);
    bridge.initFromJson(makeFont());
    window.patchSyncEngine = bridge;
    const packets = [];
    bridge.onLocalUpdate((update, envelope, entries, documentId) => {
        packets.push({ update, envelope, entries, documentId });
    });
    const peers = new Map();
    for (const shard of bridge.encodeDocumentSet()) {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, shard.bytes);
        peers.set(shard.documentId, doc);
    }
    return { bridge, packets, peers };
}

function deliver(packets, peers) {
    for (const packet of packets) {
        const peer = peers.get(packet.documentId);
        Y.applyUpdate(peer, packet.update);
        expect(peer.store.pendingStructs).toBeNull();
        expect(peer.store.pendingDs).toBeNull();
    }
}

function ownClock(doc, clientID) {
    return Y.getState(doc.store, clientID);
}

describe('per-document outbox', () => {
    afterEach(() => {
        delete window.patchSyncEngine;
    });

    test('every local transaction is sent exactly once, in order', () => {
        const { bridge, packets, peers } = setup('outbox-once');
        const glyphDocumentId = bridge.glyphDocumentIdForName('A');
        bridge.recordChange([], 'note', '', 'one');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            610
        );
        bridge.recordChange([], 'note', 'one', 'two');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            610,
            620
        );

        expect(packets.length).toBeGreaterThanOrEqual(4);
        for (const packet of packets) {
            // Every packet is described: it reaches the device outbox.
            expect(packet.envelope).toBeTruthy();
            expect(packet.entries.length).toBeGreaterThan(0);
        }
        deliver(packets, peers);
        for (const [documentId, peer] of peers) {
            const doc =
                documentId === 'font-core'
                    ? bridge.yDoc
                    : documentId === 'font-deps'
                      ? bridge.depsDoc
                      : null;
            if (doc) {
                expect(ownClock(peer, doc.clientID)).toBe(
                    ownClock(doc, doc.clientID)
                );
            }
        }
        const peerGlyph = peers.get(glyphDocumentId);
        expect(
            peerGlyph.getMap('glyph').get('layers').get('layer-1').get('width')
        ).toBe(620);
        expect(peers.get('font-core').getMap('font').get('note')).toBe('two');
        expect(bridge.hasUnsentLocalUpdates('font-core')).toBe(false);
        expect(bridge.hasUnsentLocalUpdates(glyphDocumentId)).toBe(false);
        bridge.destroy();
    });

    test('a packet carries only its own deletions, never the width an earlier packet replaced', () => {
        const { bridge, packets } = setup('outbox-own-deletions');
        const glyphDocumentId = bridge.glyphDocumentIdForName('A');
        const drawing = bridge
            ._glyphMapForName('A')
            .get('layers')
            .get('layer-1');
        const originalWidthItem = drawing._map.get('width').id;
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            610
        );
        const afterWidth = packets.length;
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'format_specific',
            undefined,
            { note: 'b' }
        );
        const later = packets
            .slice(afterWidth)
            .filter((packet) => packet.documentId === glyphDocumentId);
        expect(later.length).toBeGreaterThan(0);
        for (const packet of later) {
            const { ds } = Y.decodeUpdate(packet.update);
            const deleted = ds.clients.get(originalWidthItem.client) ?? [];
            // The second packet must not delete the old width again: a
            // receiver that missed the first would lose the width.
            expect(
                deleted.some(
                    (range) =>
                        range.clock <= originalWidthItem.clock &&
                        originalWidthItem.clock < range.clock + range.len
                )
            ).toBe(false);
        }
        bridge.destroy();
    });

    test('worker edits go out as what they changed here, not as the worker bytes', () => {
        const { bridge, packets, peers } = setup('outbox-worker');
        const glyphDocumentId = bridge.glyphDocumentIdForName('A');
        const glyphDoc = bridge._docForId(glyphDocumentId);
        // The worker edits a clone; its bytes are the clone's whole state.
        const clone = new Y.Doc();
        Y.applyUpdate(clone, Y.encodeStateAsUpdate(glyphDoc));
        clone.getMap('glyph').get('layers').get('layer-1').set('width', 640);
        const workerBytes = Y.encodeStateAsUpdate(clone);
        bridge.applyLocalGeneratedYjsUpdate(
            new Uint8Array(),
            [
                {
                    op: 'set',
                    path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
                    oldValue: 600,
                    newValue: 640
                }
            ],
            'Worker edit',
            null,
            [{ documentId: glyphDocumentId, update: workerBytes }]
        );
        const glyphPackets = packets.filter(
            (packet) => packet.documentId === glyphDocumentId
        );
        expect(glyphPackets.length).toBeGreaterThan(0);
        for (const packet of glyphPackets) {
            expect(packet.update).not.toEqual(workerBytes);
            const { structs } = Y.decodeUpdate(packet.update);
            // Nothing this window already had travels again.
            for (const struct of structs) {
                expect([clone.clientID, glyphDoc.clientID]).toContain(
                    struct.id.client
                );
                if (struct.id.client === glyphDoc.clientID) {
                    // Only the revision stamp is this window's own.
                    expect(struct.id.clock).toBeGreaterThanOrEqual(
                        ownClock(peers.get(glyphDocumentId), glyphDoc.clientID)
                    );
                }
            }
        }
        deliver(packets, peers);
        expect(
            peers
                .get(glyphDocumentId)
                .getMap('glyph')
                .get('layers')
                .get('layer-1')
                .get('width')
        ).toBe(640);
        bridge.destroy();
    });

    test('undo sends every room it changed, its revision stamp included', () => {
        const { bridge, packets, peers } = setup('outbox-undo');
        const glyphDocumentId = bridge.glyphDocumentIdForName('A');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            610
        );
        expect(bridge.undo()).not.toBeNull();
        for (const packet of packets) {
            expect(packet.envelope).toBeTruthy();
            expect(packet.entries.length).toBeGreaterThan(0);
        }
        deliver(packets, peers);
        const glyphDoc = bridge._docForId(glyphDocumentId);
        expect(ownClock(peers.get(glyphDocumentId), glyphDoc.clientID)).toBe(
            ownClock(glyphDoc, glyphDoc.clientID)
        );
        expect(bridge.hasUnsentLocalUpdates(glyphDocumentId)).toBe(false);
        bridge.destroy();
    });

    test('a local write inside a remote apply is sent, not skipped', () => {
        const { bridge, packets, peers } = setup('outbox-during-remote');
        const remote = new Y.Doc();
        Y.applyUpdate(remote, bridge.encodeDocumentState('font-core'));
        const remoteUpdates = [];
        remote.on('update', (update) => remoteUpdates.push(update));
        remote.getMap('font').set('note', 'remote');
        const unobserve = (() => {
            const observer = () => {
                bridge.yDoc.getMap('localSideEffect').set('seen', true);
            };
            bridge.fontMap.observe(observer);
            return () => bridge.fontMap.unobserve(observer);
        })();
        try {
            bridge.applyRemoteUpdate(
                remoteUpdates[0],
                [remoteEntry('note', '', 'remote')],
                undefined,
                'font-core'
            );
        } finally {
            unobserve();
        }
        Y.applyUpdate(peers.get('font-core'), remoteUpdates[0]);
        deliver(packets, peers);
        expect(
            peers.get('font-core').getMap('localSideEffect').get('seen')
        ).toBe(true);
        expect(bridge.hasUnsentLocalUpdates('font-core')).toBe(false);
        bridge.destroy();
    });

    test('a write into a broken document throws and writes nothing', () => {
        const { bridge, packets } = setup('outbox-broken');
        bridge.markDocumentBroken('font-core', new Error('lost an update'));
        expect(isDocumentBroken(bridge.yDoc)).toBe(true);
        const vector = Y.encodeStateVector(bridge.yDoc);
        expect(() => bridge.recordChange([], 'note', '', 'nope')).toThrow(
            BrokenDocumentError
        );
        expect(Y.encodeStateVector(bridge.yDoc)).toEqual(vector);
        expect(packets).toEqual([]);
        bridge.destroy();
    });

    test('a glyph delta for a glyph that is not loaded is refused before a document exists', () => {
        const { bridge: sender } = setup('outbox-sender');
        const receiver = new PatchSyncEngine('outbox-receiver');
        const glyphDocumentId = sender.glyphDocumentIdForName('A');
        const glyphDoc = sender._docForId(glyphDocumentId);
        const before = Y.encodeStateVector(glyphDoc);
        sender.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            610
        );
        const delta = Y.encodeStateAsUpdate(glyphDoc, before);
        expect(() =>
            receiver.applyRemoteUpdate(
                delta,
                [remoteEntry('glyphs.A:layers.layer-1:width', 600, 610)],
                undefined,
                glyphDocumentId
            )
        ).toThrow();
        expect(receiver.hasResidentGlyphDocument(glyphDocumentId)).toBe(false);
        sender.destroy();
        receiver.destroy();
    });

    test('a first edit to a glyph root map is no complete state and makes no glyph', () => {
        const receiver = new PatchSyncEngine('outbox-root-delta');
        // A client's first transaction starts at clock 0 and names only a
        // root map, so it integrates into an empty document; it is still a
        // delta, without the glyph's name.
        const peer = new Y.Doc();
        peer.getMap('glyph').set('category', 'Base');
        const delta = Y.encodeStateAsUpdate(peer);
        expect(() =>
            receiver.applyRemoteUpdate(
                delta,
                [remoteEntry('glyphs.A:category', 'Mark', 'Base')],
                undefined,
                'glyph:missing-glyph'
            )
        ).toThrow(ClockGapError);
        expect(receiver.hasResidentGlyphDocument('glyph:missing-glyph')).toBe(
            false
        );
        receiver.destroy();
    });

    test('a document this window does not hold never takes bytes meant for it', () => {
        const { bridge } = setup('outbox-unknown-doc');
        const vector = Y.encodeStateVector(bridge.yDoc);
        const peer = new Y.Doc();
        peer.getMap('font').set('note', 'elsewhere');
        expect(() =>
            bridge.applyYDocUpdateSilent(
                Y.encodeStateAsUpdate(peer),
                'glyph:not-here'
            )
        ).toThrow(/not loaded/);
        expect(() =>
            bridge.encodeStateDiff(new Uint8Array(), 'glyph:not-here')
        ).toThrow(/not loaded/);
        expect(Y.encodeStateVector(bridge.yDoc)).toEqual(vector);
        bridge.destroy();
    });

    test('a packet that cannot be made stays queued and goes out with the next one', () => {
        const { bridge, packets, peers } = setup('outbox-requeue');
        const realEmit = bridge._describeAndDeliverLocalUpdate.bind(bridge);
        bridge._describeAndDeliverLocalUpdate = () => {
            throw new Error('no envelope');
        };
        expect(() => bridge.recordChange([], 'note', '', 'first')).toThrow(
            'no envelope'
        );
        expect(bridge.hasUnsentLocalUpdates('font-core')).toBe(true);
        bridge._describeAndDeliverLocalUpdate = realEmit;
        bridge.recordChange([], 'note', 'first', 'second');
        expect(bridge.hasUnsentLocalUpdates('font-core')).toBe(false);
        deliver(packets, peers);
        expect(Y.encodeStateVector(peers.get('font-core'))).toEqual(
            Y.encodeStateVector(bridge.yDoc)
        );
        expect(peers.get('font-core').getMap('font').get('note')).toBe(
            'second'
        );
        bridge.destroy();
    });

    test('undo that would delete a drawing identity key throws', () => {
        const { bridge } = setup('outbox-identity-undo');
        expect(() =>
            bridge._applyHistoryReplayEntry(
                {
                    path: 'glyphs.A:layers.layer-1:width',
                    op: 'set',
                    replayOldValue: undefined,
                    replayNewValue: 610,
                    oldValue: undefined,
                    newValue: 610,
                    glyphRenames: []
                },
                'undo'
            )
        ).toThrow(DrawingInvariantError);
        bridge.destroy();
    });
});

describe('cloud delivery order', () => {
    afterEach(() => {
        delete window.patchSyncEngine;
        delete window.cloudPlugin;
        delete window.fontManager;
    });

    function cloudBacked(persistOutgoingCloudUpdate) {
        window.cloudPlugin = { persistOutgoingCloudUpdate };
        window.fontManager = { currentFont: { isCloudBacked: () => true } };
    }

    test('local packets reach listeners at commit, in order, before their outbox rows are written', () => {
        const persisted = [];
        cloudBacked((update) => {
            persisted.push(update);
            return new Promise(() => {});
        });
        const { bridge, packets } = setup('cloud-order');
        bridge.recordChange([], 'note', '', 'one');
        bridge.recordChange([], 'note', 'one', 'two');
        // Delivered synchronously, although no outbox row is written yet.
        expect(packets.map((packet) => packet.documentId)).toEqual([
            'font-core',
            'font-core'
        ]);
        expect(bridge.hasCloudPersistInFlight).toBe(true);
    });

    test('an outbox write that fails for a reason other than storage stops the document', async () => {
        cloudBacked(() => Promise.reject(new Error('session gone')));
        const errors = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        try {
            const { bridge } = setup('cloud-persist-fails');
            bridge.recordChange([], 'note', '', 'one');
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(isDocumentBroken(bridge.yDoc)).toBe(true);
        } finally {
            errors.mockRestore();
        }
    });
});
