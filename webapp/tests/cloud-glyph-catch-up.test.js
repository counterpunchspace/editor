const { webcrypto } = require('crypto');
const { TextDecoder, TextEncoder } = require('util');
Object.defineProperty(global, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true
});
global.TextDecoder = TextDecoder;
global.TextEncoder = TextEncoder;

/**
 * Glyphs edited outside a receiver's live WebSocket subset still arrive:
 * both peers share a seeded Yjs history, the writer publishes a core-room
 * revision signal, and the receiver applies a one-shot live glyph catch-up.
 */
const {
    GLYPH_REVISION_COMMIT_HOLD_MS,
    PatchSyncEngine
} = require('../js/patch-sync-engine');
const { Font } = require('../js/babelfont-model');
const { resetGlyphLogCursors } = require('../js/cloud-adapter-support');
const {
    catchUpCloudDocument,
    refreshEditorAfterGlyphDocumentCatchUp
} = require('../js/cloud-adapter');
const {
    createCollaborationMessageEnvelopesFromChangeLogEntries
} = require('../js/collaboration-message');
const {
    FONT_CORE_DOCUMENT_ID,
    glyphDocumentId,
    glyphIdsFromCatalogEntries,
    glyphIdsFromRevisionEntries
} = require('../js/filesystem-plugins/cloud-document-set');

function makeTwoGlyphFont() {
    return {
        upm: 1000,
        names: { familyName: 'CatchUp' },
        masters: [
            {
                name: 'Regular',
                id: 'master-regular',
                location: {},
                metrics: {},
                kerning: {}
            }
        ],
        glyphs: [
            {
                name: 'A',
                id: 'id-a',
                production_name: 'A',
                category: 'Base',
                codepoints: [65],
                exported: true,
                layers: [
                    {
                        id: 'layer-1',
                        name: 'Regular',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-regular'
                        },
                        shapes: []
                    }
                ]
            },
            {
                name: 'B',
                id: 'id-b',
                production_name: 'B',
                category: 'Base',
                codepoints: [66],
                exported: true,
                layers: [
                    {
                        id: 'layer-1',
                        name: 'Regular',
                        width: 400,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-regular'
                        },
                        shapes: []
                    }
                ]
            }
        ]
    };
}

function createEngine(windowId, fontJson = makeTwoGlyphFont()) {
    const bridge = new PatchSyncEngine(windowId);
    bridge.initFromJson(JSON.parse(JSON.stringify(fontJson)));
    const font = Font.fromData(JSON.parse(JSON.stringify(fontJson)));
    window.changeBridge = bridge;
    return { bridge, font };
}

function hydrateReceiverFromWriter(writer) {
    const receiver = new PatchSyncEngine('receiver');
    receiver.setFontJson(
        JSON.parse(JSON.stringify(writer.getFontJsonSnapshot()))
    );
    receiver.applyDocumentSetState(writer.encodeDocumentSet());
    return receiver;
}

function capturePackets(bridge) {
    const packets = [];
    bridge.onLocalUpdate(
        (update, collaborationMessage, changeLogEntries, documentId) => {
            packets.push({
                update,
                collaborationMessage,
                changeLogEntries,
                documentId
            });
        }
    );
    return packets;
}

function glyphWidth(bridge, name) {
    return bridge
        .getFontJsonSnapshot()
        .glyphs.find((glyph) => glyph.name === name).layers[0].width;
}

function toBase64(bytes) {
    return Buffer.from(bytes).toString('base64');
}

function jsonLiveResponse(bytes) {
    return {
        ok: true,
        status: 200,
        headers: new Headers({
            'content-type': 'application/json'
        }),
        json: async () => ({
            update: toBase64(bytes)
        })
    };
}

function encodeCollabFrame(type, logId, payload) {
    const body = payload || new Uint8Array();
    const out = new Uint8Array(16 + body.byteLength);
    const view = new DataView(out.buffer);
    view.setUint32(0, type, false);
    view.setUint32(4, Math.floor(logId / 0x100000000), false);
    view.setUint32(8, logId >>> 0, false);
    view.setUint32(12, body.byteLength, false);
    out.set(body, 16);
    return out;
}

function encodeTailChunkFrame(logId, blob) {
    const payload = new Uint8Array(12 + blob.length);
    const view = new DataView(payload.buffer);
    view.setUint32(0, 0, false);
    view.setUint32(4, 1, false);
    view.setUint32(8, 0, false);
    payload.set(blob, 12);
    return encodeCollabFrame(2, logId, payload);
}

function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function framedLiveResponse(bytes, { omitTerminal = false } = {}) {
    const checkpoint = encodeCollabFrame(
        1,
        0,
        new Uint8Array(
            Buffer.from(
                JSON.stringify({
                    hasMore: false,
                    throughLogId: 1,
                    lastLogId: 1,
                    collaborationMessageHistory: []
                })
            )
        )
    );
    const tail = encodeTailChunkFrame(1, bytes);
    const parts = omitTerminal
        ? [checkpoint, tail]
        : [checkpoint, tail, encodeCollabFrame(3, 1, new Uint8Array())];
    const body = concatBytes(parts);
    return {
        ok: true,
        status: 200,
        headers: new Headers({
            'content-type': 'application/octet-stream'
        }),
        arrayBuffer: async () => body.buffer
    };
}

function framedLiveResponseWithTails(tails) {
    const checkpoint = encodeCollabFrame(
        1,
        0,
        new Uint8Array(
            Buffer.from(
                JSON.stringify({
                    hasMore: false,
                    throughLogId: tails.length,
                    lastLogId: tails.length,
                    collaborationMessageHistory: []
                })
            )
        )
    );
    const body = concatBytes([
        checkpoint,
        ...tails.map((bytes, index) => encodeTailChunkFrame(index + 1, bytes)),
        encodeCollabFrame(3, tails.length, new Uint8Array())
    ]);
    return {
        ok: true,
        status: 200,
        headers: new Headers({
            'content-type': 'application/octet-stream'
        }),
        arrayBuffer: async () => body.buffer
    };
}

function revisionFor(bridge, glyphId) {
    return bridge
        .listGlyphRevisionTokens()
        .find((entry) => entry.glyphId === glyphId)?.revision;
}

describe('glyph catch-up for edits outside the receiver subset', () => {
    beforeEach(() => {
        resetGlyphLogCursors();
    });

    afterEach(() => {
        delete window.changeBridge;
    });

    test('glyphIdsFromRevisionEntries reads core dirty signals', () => {
        expect(
            glyphIdsFromRevisionEntries([
                { path: 'glyphRevisions.id-b' },
                { path: 'glyphs.A:layers.layer-1:width' }
            ])
        ).toEqual(['id-b']);
    });

    test('glyphIdsFromCatalogEntries reads a new catalog glyph', () => {
        expect(
            glyphIdsFromCatalogEntries([
                { path: 'glyphCatalog.id-new.name' },
                { path: '.glyphCatalog.id-new.codepoints' },
                { path: 'glyphOrder.0' },
                {
                    path: 'glyphCatalog',
                    oldValue: { 'id-a': { name: 'A' } },
                    newValue: {
                        'id-a': { name: 'A' },
                        'id-added': { name: 'added' }
                    }
                }
            ]).sort()
        ).toEqual(['id-added', 'id-new']);
    });

    test('local outline edits carry the glyph revision and write nothing to font-core', () => {
        const { bridge, font } = createEngine('writer');
        const packets = capturePackets(bridge);
        font.findGlyph('B').layers[0].width = 777;

        const corePackets = packets.filter(
            (packet) => packet.documentId === FONT_CORE_DOCUMENT_ID
        );
        const glyphPackets = packets.filter(
            (packet) => packet.documentId === glyphDocumentId('id-b')
        );
        expect(glyphPackets.length).toBeGreaterThan(0);
        expect(corePackets).toEqual([]);
        expect(glyphPackets.at(-1).collaborationMessage.glyphRevision).toBe(
            revisionFor(bridge, 'id-b')
        );
        expect(glyphWidth(bridge, 'A')).toBe(500);
    });

    test('receiver without the glyph room converges via the revision feed plus catch-up', () => {
        const writer = createEngine('writer');
        const receiver = hydrateReceiverFromWriter(writer.bridge);
        const packets = capturePackets(writer.bridge);

        window.changeBridge = writer.bridge;
        writer.font.findGlyph('B').layers[0].width = 777;

        const glyphPackets = packets.filter(
            (packet) => packet.documentId === glyphDocumentId('id-b')
        );
        expect(glyphPackets.length).toBeGreaterThan(0);

        // font-core's feed names the glyph; the glyph itself comes by catch-up.
        const feedEvents = [];
        receiver.onGlyphRevisionFeed((glyphIds, options) =>
            feedEvents.push({ glyphIds, ...options })
        );
        expect(
            receiver.applyGlyphRevisionFeed([
                {
                    glyphId: 'id-b',
                    revision:
                        glyphPackets.at(-1).collaborationMessage.glyphRevision
                }
            ])
        ).toEqual(['id-b']);
        expect(feedEvents).toEqual([{ glyphIds: ['id-b'], initial: false }]);
        expect(glyphWidth(receiver, 'B')).toBe(400);

        const liveTail = writer.bridge.encodeDocumentState(
            glyphDocumentId('id-b')
        );
        const glyphPacket = glyphPackets[glyphPackets.length - 1];
        expect(
            receiver.applyDocumentCatchUp(
                glyphDocumentId('id-b'),
                liveTail,
                glyphPacket.collaborationMessage
                    ? [glyphPacket.collaborationMessage]
                    : undefined,
                glyphPacket.changeLogEntries
            )
        ).toBe(true);
        expect(glyphWidth(receiver, 'B')).toBe(777);
        expect(glyphWidth(receiver, 'A')).toBe(500);
        expect(
            receiver.glyphHasCatchUpRevision(
                glyphDocumentId('id-b'),
                revisionFor(writer.bridge, 'id-b')
            )
        ).toBe(true);
    });

    test('glyph catch-up reseeds the worker from encoded document state, not a sync delta', () => {
        const writer = createEngine('writer');
        const receiver = hydrateReceiverFromWriter(writer.bridge);
        const packets = capturePackets(writer.bridge);
        window.changeBridge = writer.bridge;
        writer.font.findGlyph('B').layers[0].width = 777;
        const glyphPacket = packets.filter(
            (packet) => packet.documentId === glyphDocumentId('id-b')
        )[0];
        expect(glyphPacket?.update?.length).toBeGreaterThan(0);

        const workerCalls = [];
        const replaceCalls = [];
        receiver.setYjsWorkerCallback((_update, entries, documentId) => {
            workerCalls.push({ documentId, paths: entries.map((e) => e.path) });
        });
        receiver.setWorkerDocumentReplaceCallback((documentId, state) => {
            replaceCalls.push({
                documentId,
                byteLength: state.length
            });
        });

        expect(
            receiver.applyDocumentCatchUp(
                glyphDocumentId('id-b'),
                glyphPacket.update
            )
        ).toBe(true);
        const encoded = receiver.encodeDocumentState(glyphDocumentId('id-b'));
        expect(
            workerCalls.filter(
                (call) => call.documentId === glyphDocumentId('id-b')
            )
        ).toEqual([]);
        expect(replaceCalls).toEqual([
            {
                documentId: glyphDocumentId('id-b'),
                byteLength: encoded.length
            }
        ]);
        expect(replaceCalls[0].byteLength).toBeGreaterThan(
            glyphPacket.update.length
        );
        expect(glyphWidth(receiver, 'B')).toBe(777);
    });

    test('the feed echo of an older own revision changes nothing', () => {
        const { bridge, font } = createEngine('writer');
        const packets = capturePackets(bridge);
        font.findGlyph('B').layers[0].width = 600;
        const first = revisionFor(bridge, 'id-b');
        font.findGlyph('B').layers[0].width = 700;
        const second = revisionFor(bridge, 'id-b');
        expect(second).not.toBe(first);
        expect(packets.length).toBeGreaterThan(0);

        const events = [];
        bridge.onGlyphRevisionFeed((glyphIds) => events.push(glyphIds));
        // The room reports the first write after the second was made.
        expect(
            bridge.applyGlyphRevisionFeed([
                { glyphId: 'id-b', revision: first }
            ])
        ).toEqual([]);
        expect(revisionFor(bridge, 'id-b')).toBe(second);
        expect(events).toEqual([]);
        // A relayed linked-window edit becomes the glyph's revision, and its
        // echo from the feed is this session's own.
        bridge.relayPeerPacketToCloud(
            new Uint8Array(),
            { glyphRevision: 'linked:1' },
            'glyph:id-b'
        );
        expect(revisionFor(bridge, 'id-b')).toBe('linked:1');
        expect(
            bridge.applyGlyphRevisionFeed([
                { glyphId: 'id-b', revision: first }
            ])
        ).toEqual([]);
        expect(revisionFor(bridge, 'id-b')).toBe('linked:1');
    });

    test('glyph packets include the catch-up stamp', () => {
        const { bridge, font } = createEngine('writer');
        const receiver = hydrateReceiverFromWriter(bridge);
        const packets = capturePackets(bridge);
        font.findGlyph('B').layers[0].width = 777;

        const glyphIndex = packets.findIndex(
            (packet) => packet.documentId === glyphDocumentId('id-b')
        );
        expect(glyphIndex).toBeGreaterThanOrEqual(0);
        expect(
            bridge.glyphHasCatchUpRevision(
                glyphDocumentId('id-b'),
                revisionFor(bridge, 'id-b')
            )
        ).toBe(true);

        const glyphPacket = packets[glyphIndex];
        expect(
            receiver.applyRemoteUpdate(
                glyphPacket.update,
                glyphPacket.changeLogEntries,
                glyphPacket.collaborationMessage
                    ? [glyphPacket.collaborationMessage]
                    : undefined,
                glyphPacket.documentId
            )
        ).toBe(true);
        expect(glyphWidth(receiver, 'B')).toBe(777);
        expect(
            receiver.glyphHasCatchUpRevision(
                glyphDocumentId('id-b'),
                revisionFor(bridge, 'id-b')
            )
        ).toBe(true);
    });

    test('a multi-glyph edit gives each glyph packet its own revision', () => {
        const { bridge, font } = createEngine('writer');
        const packets = capturePackets(bridge);
        bridge.beginTransaction('edit', null, {
            compileChangeSource: 'test-sync',
            compileEditType: null
        });
        font.findGlyph('A').layers[0].width = 111;
        font.findGlyph('B').layers[0].width = 222;
        bridge.endTransaction();

        for (const glyphId of ['id-a', 'id-b']) {
            const glyphPackets = packets.filter(
                (packet) => packet.documentId === glyphDocumentId(glyphId)
            );
            expect(glyphPackets.length).toBeGreaterThan(0);
            expect(glyphPackets.at(-1).collaborationMessage.glyphRevision).toBe(
                revisionFor(bridge, glyphId)
            );
        }
        expect(revisionFor(bridge, 'id-a')).not.toBe(
            revisionFor(bridge, 'id-b')
        );
        expect(
            packets.filter(
                (packet) => packet.documentId === FONT_CORE_DOCUMENT_ID
            )
        ).toEqual([]);
    });

    test('a multi-glyph edit’s revisions reach a receiver together', () => {
        const { bridge, font } = createEngine('writer');
        bridge.beginTransaction('edit', null, {
            compileChangeSource: 'test-sync',
            compileEditType: null
        });
        font.findGlyph('A').layers[0].width = 111;
        font.findGlyph('B').layers[0].width = 222;
        bridge.endTransaction();
        const revisionA = revisionFor(bridge, 'id-a');
        const revisionB = revisionFor(bridge, 'id-b');

        const { bridge: receiver } = createEngine('receiver');
        const events = [];
        receiver.onGlyphRevisionFeed((glyphIds) => events.push(glyphIds));
        // Each glyph room reports its own write; B’s can come first.
        expect(
            receiver.applyGlyphRevisionFeed([
                { glyphId: 'id-b', revision: revisionB }
            ])
        ).toEqual([]);
        expect(revisionFor(receiver, 'id-b')).toBeUndefined();
        expect(events).toEqual([]);
        expect(
            receiver.applyGlyphRevisionFeed([
                { glyphId: 'id-a', revision: revisionA }
            ])
        ).toEqual(['id-b', 'id-a']);
        expect(revisionFor(receiver, 'id-a')).toBe(revisionA);
        expect(revisionFor(receiver, 'id-b')).toBe(revisionB);
        expect(events).toEqual([['id-b', 'id-a']]);
    });

    test('a held revision whose commit never completes is released after the hold', () => {
        jest.useFakeTimers();
        try {
            const { bridge: receiver } = createEngine('receiver');
            const events = [];
            receiver.onGlyphRevisionFeed((glyphIds) => events.push(glyphIds));
            receiver.applyGlyphRevisionFeed([
                { glyphId: 'id-b', revision: 'writer:8/7-8' }
            ]);
            expect(events).toEqual([]);
            jest.advanceTimersByTime(GLYPH_REVISION_COMMIT_HOLD_MS);
            expect(revisionFor(receiver, 'id-b')).toBe('writer:8/7-8');
            expect(events).toEqual([['id-b']]);
        } finally {
            jest.useRealTimers();
        }
    });

    test('two commits whose revisions arrive interleaved both apply in order', () => {
        const { bridge: receiver } = createEngine('receiver');
        // Two edits of A and B in a row; the second commit’s A arrives
        // before the first commit is complete.
        receiver.applyGlyphRevisionFeed([
            { glyphId: 'id-a', revision: 'writer:1/1-2' }
        ]);
        receiver.applyGlyphRevisionFeed([
            { glyphId: 'id-a', revision: 'writer:3/3-4' }
        ]);
        receiver.applyGlyphRevisionFeed([
            { glyphId: 'id-b', revision: 'writer:2/1-2' }
        ]);
        expect(revisionFor(receiver, 'id-a')).toBe('writer:1/1-2');
        expect(revisionFor(receiver, 'id-b')).toBe('writer:2/1-2');
        receiver.applyGlyphRevisionFeed([
            { glyphId: 'id-b', revision: 'writer:4/3-4' }
        ]);
        expect(revisionFor(receiver, 'id-a')).toBe('writer:3/3-4');
        expect(revisionFor(receiver, 'id-b')).toBe('writer:4/3-4');
    });

    test('a newer revision is not replaced by an older held one', () => {
        jest.useFakeTimers();
        try {
            const { bridge: receiver } = createEngine('receiver');
            receiver.applyGlyphRevisionFeed([
                { glyphId: 'id-b', revision: 'writer:8/7-8' }
            ]);
            receiver.applyGlyphRevisionFeed([
                { glyphId: 'id-b', revision: 'other:3' }
            ]);
            expect(revisionFor(receiver, 'id-b')).toBe('other:3');
            jest.advanceTimersByTime(GLYPH_REVISION_COMMIT_HOLD_MS);
            expect(revisionFor(receiver, 'id-b')).toBe('other:3');
        } finally {
            jest.useRealTimers();
        }
    });

    test('catch-up applies a live checkpoint and does not replay mutation history', () => {
        const writer = createEngine('writer');
        const receiver = hydrateReceiverFromWriter(writer.bridge);
        window.changeBridge = writer.bridge;
        writer.font.findGlyph('B').layers[0].width = 777;
        const liveTail = writer.bridge.encodeDocumentState(
            glyphDocumentId('id-b')
        );
        const before = receiver.getChangeLog().length;
        const fakeHistory = Array.from({ length: 40 }, (_, index) => ({
            localSequence: index + 1,
            changes: [{ path: `history.${index}`, op: 'set' }]
        }));

        expect(
            receiver.applyDocumentCatchUp(
                glyphDocumentId('id-b'),
                liveTail,
                fakeHistory,
                fakeHistory.map((item) => ({
                    path: item.changes[0].path
                })),
                revisionFor(writer.bridge, 'id-b')
            )
        ).toBe(true);
        expect(receiver.getChangeLog().length).toBe(before);
        expect(glyphWidth(receiver, 'B')).toBe(777);
    });

    test('catch-up of a resident glyph reaches committed listeners as a collaborator edit', () => {
        const writer = createEngine('writer');
        const receiver = hydrateReceiverFromWriter(writer.bridge);
        const committed = [];
        receiver.onCommittedChange((entries, context) =>
            committed.push({ entries, context })
        );
        window.changeBridge = writer.bridge;
        writer.font.findGlyph('B').layers[0].width = 777;
        const liveTail = writer.bridge.encodeDocumentState(
            glyphDocumentId('id-b')
        );

        expect(
            receiver.applyDocumentCatchUp(glyphDocumentId('id-b'), liveTail)
        ).toBe(true);
        expect(committed).toHaveLength(1);
        expect(committed[0].context).toMatchObject({
            origin: 'remote',
            documentId: glyphDocumentId('id-b')
        });
        expect(committed[0].entries).toEqual([
            expect.objectContaining({
                op: 'set',
                path: 'glyphs.B:layers.layer-1:width',
                oldValue: 400,
                newValue: 777,
                compileChangeSource: 'remote-catch-up',
                compileEditType: null,
                workerReplayTargets: [{ glyphName: 'B', layerId: 'layer-1' }]
            })
        ]);

        // The same checkpoint again changes nothing here.
        receiver.applyDocumentCatchUp(glyphDocumentId('id-b'), liveTail);
        expect(committed).toHaveLength(1);
    });

    test('first hydration of a glyph through catch-up is nobody’s edit', () => {
        const writer = createEngine('writer');
        const receiver = new PatchSyncEngine('receiver');
        receiver.setFontJson(
            JSON.parse(JSON.stringify(writer.bridge.getFontJsonSnapshot()))
        );
        receiver.applyDocumentSetState(
            writer.bridge
                .encodeDocumentSet()
                .filter((shard) => shard.documentId !== glyphDocumentId('id-b'))
        );
        expect(receiver.hasResidentGlyphDocument(glyphDocumentId('id-b'))).toBe(
            false
        );
        const committed = jest.fn();
        receiver.onCommittedChange(committed);

        receiver.applyDocumentCatchUp(
            glyphDocumentId('id-b'),
            writer.bridge.encodeDocumentState(glyphDocumentId('id-b'))
        );

        expect(committed).not.toHaveBeenCalled();
    });

    test('core catch-up describes the core keys it changed', () => {
        const writer = createEngine('writer');
        const receiver = hydrateReceiverFromWriter(writer.bridge);
        const committed = [];
        receiver.onCommittedChange((entries, context) =>
            committed.push({ entries, context })
        );
        window.changeBridge = writer.bridge;
        writer.font.masters[0].name = 'Bold';

        receiver.applyDocumentCatchUp(
            FONT_CORE_DOCUMENT_ID,
            writer.bridge.encodeDocumentState(FONT_CORE_DOCUMENT_ID)
        );

        expect(committed).toHaveLength(1);
        expect(committed[0].context).toMatchObject({
            origin: 'remote',
            documentId: FONT_CORE_DOCUMENT_ID
        });
        const paths = committed[0].entries.map((entry) => entry.path);
        expect(paths.some((path) => path.startsWith('masters'))).toBe(true);
        expect(paths.some((path) => path.startsWith('glyphRevisions'))).toBe(
            false
        );
        expect(
            committed[0].entries.every(
                (entry) => entry.compileChangeSource === 'remote-catch-up'
            )
        ).toBe(true);
    });

    test('catch-up retries until the live glyph stamp matches the core revision', async () => {
        const writer = createEngine('writer');
        const receiver = hydrateReceiverFromWriter(writer.bridge);
        const staleTail = writer.bridge.encodeDocumentState(
            glyphDocumentId('id-b')
        );
        window.changeBridge = writer.bridge;
        writer.font.findGlyph('B').layers[0].width = 777;
        const liveTail = writer.bridge.encodeDocumentState(
            glyphDocumentId('id-b')
        );
        const expectedRevision = revisionFor(writer.bridge, 'id-b');
        const originalFetch = global.fetch;
        let attempts = 0;
        global.fetch = jest.fn(async () => {
            attempts += 1;
            return jsonLiveResponse(attempts === 1 ? staleTail : liveTail);
        });

        await catchUpCloudDocument({
            bridge: receiver,
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            websiteBaseUrl: 'https://editor.example',
            assetId: 'asset-1',
            documentId: glyphDocumentId('id-b'),
            expectedRevision,
            maxAttempts: 4,
            wait: async () => {}
        });

        expect(attempts).toBe(2);
        expect(glyphWidth(receiver, 'B')).toBe(777);
        expect(
            receiver.glyphHasCatchUpRevision(
                glyphDocumentId('id-b'),
                expectedRevision
            )
        ).toBe(true);
        global.fetch = originalFetch;
    });

    test('catch-up resumes from the checkpoint when log zero is compacted away', async () => {
        const writer = createEngine('writer');
        const receiver = hydrateReceiverFromWriter(writer.bridge);
        window.changeBridge = writer.bridge;
        writer.font.findGlyph('B').layers[0].width = 777;
        const liveTail = writer.bridge.encodeDocumentState(
            glyphDocumentId('id-b')
        );
        const expectedRevision = revisionFor(writer.bridge, 'id-b');
        const originalFetch = global.fetch;
        const urls = [];
        global.fetch = jest.fn(async (input) => {
            const url = String(input);
            urls.push(url);
            if (url.includes('/state')) {
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({
                        'content-type': 'application/octet-stream'
                    }),
                    arrayBuffer: async () => liveTail.slice().buffer
                };
            }
            return {
                ok: false,
                status: 409,
                headers: new Headers({
                    'content-type': 'application/json'
                }),
                json: async () => ({
                    error: 'Cursor is below the retained checkpoint',
                    code: 'rebaseline_required',
                    lastCheckpointLogId: 4
                })
            };
        });

        await catchUpCloudDocument({
            bridge: receiver,
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            websiteBaseUrl: 'https://editor.example',
            assetId: 'asset-1',
            documentId: glyphDocumentId('id-b'),
            expectedRevision,
            maxAttempts: 4,
            wait: async () => {}
        });

        expect(urls.some((url) => url.includes('afterLogId=0'))).toBe(true);
        expect(urls.some((url) => url.includes('/state'))).toBe(true);
        expect(glyphWidth(receiver, 'B')).toBe(777);
        global.fetch = originalFetch;
    });

    test('a later opener learns edited glyphs from the feed snapshot and catches up', async () => {
        const writer = createEngine('writer');
        const seedJson = JSON.parse(
            JSON.stringify(writer.bridge.getFontJsonSnapshot())
        );
        const seedShards = writer.bridge.encodeDocumentSet();
        window.changeBridge = writer.bridge;
        writer.font.findGlyph('B').layers[0].width = 777;

        const receiver = new PatchSyncEngine('late-opener');
        receiver.setFontJson(seedJson);
        receiver.applyDocumentSetState(seedShards);
        let hydrated = 0;
        receiver.onCoreHydrated(() => {
            hydrated += 1;
        });
        receiver.applyFullState(writer.bridge.encodeBridgeState());
        receiver.applyGlyphRevisionFeed(
            writer.bridge.listGlyphRevisionTokens(),
            { initial: true }
        );

        expect(hydrated).toBe(1);
        expect(glyphWidth(receiver, 'B')).toBe(400);
        const tokens = receiver.listGlyphRevisionTokens();
        expect(tokens.map((entry) => entry.glyphId)).toEqual(['id-b']);

        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () =>
            jsonLiveResponse(
                writer.bridge.encodeDocumentState(glyphDocumentId('id-b'))
            )
        );
        await catchUpCloudDocument({
            bridge: receiver,
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            websiteBaseUrl: 'https://editor.example',
            assetId: 'asset-1',
            documentId: glyphDocumentId('id-b'),
            expectedRevision: tokens[0].revision,
            maxAttempts: 3,
            wait: async () => {}
        });
        expect(glyphWidth(receiver, 'B')).toBe(777);
        global.fetch = originalFetch;
    });

    test('undo catch-up retries until the undone outline is durable on the glyph room', async () => {
        const writer = createEngine('writer');
        window.changeBridge = writer.bridge;
        writer.font.findGlyph('B').layers[0].width = 777;
        const receiver = hydrateReceiverFromWriter(writer.bridge);
        const staleTail = writer.bridge.encodeDocumentState(
            glyphDocumentId('id-b')
        );
        expect(glyphWidth(receiver, 'B')).toBe(777);

        writer.bridge.undo('B', 'layer-1');
        const liveTail = writer.bridge.encodeDocumentState(
            glyphDocumentId('id-b')
        );
        const expectedRevision = revisionFor(writer.bridge, 'id-b');
        expect(glyphWidth(writer.bridge, 'B')).toBe(400);

        const originalFetch = global.fetch;
        let attempts = 0;
        global.fetch = jest.fn(async () => {
            attempts += 1;
            return jsonLiveResponse(attempts === 1 ? staleTail : liveTail);
        });
        await catchUpCloudDocument({
            bridge: receiver,
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            websiteBaseUrl: 'https://editor.example',
            assetId: 'asset-1',
            documentId: glyphDocumentId('id-b'),
            expectedRevision,
            maxAttempts: 4,
            wait: async () => {}
        });
        expect(attempts).toBe(2);
        expect(glyphWidth(receiver, 'B')).toBe(400);
        global.fetch = originalFetch;
    });

    test('catching up the edited glyph refreshes the outline editor', async () => {
        const writer = createEngine('writer');
        const receiver = hydrateReceiverFromWriter(writer.bridge);
        window.changeBridge = writer.bridge;
        writer.font.findGlyph('B').layers[0].width = 777;
        const refresh = jest.fn().mockResolvedValue();
        const previousRefresh = window.syncRustCacheAndRefreshCanvas;
        const previousCanvas = window.glyphCanvas;
        window.syncRustCacheAndRefreshCanvas = refresh;
        window.glyphCanvas = {
            getCurrentGlyphName: () => 'B',
            outlineEditor: {
                active: true,
                selectedLayerId: 'layer-1',
                parseGlyphStack: () => [{ glyphName: 'B' }]
            }
        };

        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () =>
            jsonLiveResponse(
                writer.bridge.encodeDocumentState(glyphDocumentId('id-b'))
            )
        );
        try {
            await catchUpCloudDocument({
                bridge: receiver,
                token: 'token',
                roomUrl: 'wss://rooms.example/room/asset-1',
                websiteBaseUrl: 'https://editor.example',
                assetId: 'asset-1',
                documentId: glyphDocumentId('id-b'),
                expectedRevision: revisionFor(writer.bridge, 'id-b'),
                maxAttempts: 2,
                wait: async () => {}
            });
            expect(refresh).toHaveBeenCalledWith('B', 'B', {
                allowSelectedLayerFallback: true
            });
            refresh.mockClear();
            refreshEditorAfterGlyphDocumentCatchUp(glyphDocumentId('id-a'));
            expect(refresh).not.toHaveBeenCalled();
        } finally {
            global.fetch = originalFetch;
            window.syncRustCacheAndRefreshCanvas = previousRefresh;
            window.glyphCanvas = previousCanvas;
        }
    });

    test('catch-up retries framed live streams that omit the terminal frame', async () => {
        const writer = createEngine('writer');
        const receiver = hydrateReceiverFromWriter(writer.bridge);
        window.changeBridge = writer.bridge;
        writer.font.findGlyph('B').layers[0].width = 777;
        const liveTail = writer.bridge.encodeDocumentState(
            glyphDocumentId('id-b')
        );
        const expectedRevision = revisionFor(writer.bridge, 'id-b');
        const originalFetch = global.fetch;
        let attempts = 0;
        global.fetch = jest.fn(async () => {
            attempts += 1;
            return framedLiveResponse(liveTail, {
                omitTerminal: attempts === 1
            });
        });
        await catchUpCloudDocument({
            bridge: receiver,
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            websiteBaseUrl: 'https://editor.example',
            assetId: 'asset-1',
            documentId: glyphDocumentId('id-b'),
            expectedRevision,
            maxAttempts: 4,
            wait: async () => {}
        });
        expect(attempts).toBe(2);
        expect(glyphWidth(receiver, 'B')).toBe(777);
        global.fetch = originalFetch;
    });

    test('framed catch-up applies every tail before checking the core revision', async () => {
        const writer = createEngine('writer');
        const receiver = hydrateReceiverFromWriter(writer.bridge);
        const staleTail = writer.bridge.encodeDocumentState(
            glyphDocumentId('id-b')
        );
        window.changeBridge = writer.bridge;
        writer.font.findGlyph('B').layers[0].width = 777;
        const liveTail = writer.bridge.encodeDocumentState(
            glyphDocumentId('id-b')
        );
        const expectedRevision = revisionFor(writer.bridge, 'id-b');
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () =>
            framedLiveResponseWithTails([staleTail, liveTail])
        );
        await catchUpCloudDocument({
            bridge: receiver,
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            websiteBaseUrl: 'https://editor.example',
            assetId: 'asset-1',
            documentId: glyphDocumentId('id-b'),
            expectedRevision,
            maxAttempts: 1,
            wait: async () => {}
        });
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(glyphWidth(receiver, 'B')).toBe(777);
        global.fetch = originalFetch;
    });

    test('relays the glyph document as main holds it to linked windows', async () => {
        const previousRole = window.windowRole;
        const previousSync = window.windowSync;
        const relay = jest.fn();
        const bridge = {
            applyDocumentCatchUp: jest.fn(() => true),
            encodeDocumentState: jest.fn(() => new Uint8Array([9, 9]))
        };
        window.windowRole = { isMainWindow: () => true };
        window.windowSync = { broadcastCloudRelayUpdate: relay };
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () =>
            framedLiveResponseWithTails([
                new Uint8Array([1, 2, 3]),
                new Uint8Array([4, 5, 6])
            ])
        );
        try {
            await expect(
                catchUpCloudDocument({
                    bridge,
                    token: 'token',
                    roomUrl: 'wss://rooms.example/room/asset-1',
                    websiteBaseUrl: 'https://editor.example',
                    assetId: 'asset-1',
                    documentId: glyphDocumentId('id-b')
                })
            ).resolves.toBe(true);
            expect(bridge.applyDocumentCatchUp).toHaveBeenCalledTimes(2);
            // One full state, not the tail: a linked window that lacks what
            // the tail builds on would never apply it.
            expect(bridge.encodeDocumentState).toHaveBeenCalledWith(
                glyphDocumentId('id-b')
            );
            expect(relay.mock.calls.map(([bytes]) => [...bytes])).toEqual([
                [9, 9]
            ]);
        } finally {
            global.fetch = originalFetch;
            window.windowRole = previousRole;
            window.windowSync = previousSync;
        }
    });

    test('relays what main applied even before the expected revision arrives', async () => {
        const previousRole = window.windowRole;
        const previousSync = window.windowSync;
        const relay = jest.fn();
        const bridge = {
            applyDocumentCatchUp: jest.fn(() => true),
            glyphHasCatchUpRevision: jest.fn(() => false),
            encodeDocumentState: jest.fn(() => new Uint8Array([7]))
        };
        window.windowRole = { isMainWindow: () => true };
        window.windowSync = { broadcastCloudRelayUpdate: relay };
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () =>
            framedLiveResponseWithTails([new Uint8Array([1, 2, 3])])
        );
        try {
            await expect(
                catchUpCloudDocument({
                    bridge,
                    token: 'token',
                    roomUrl: 'wss://rooms.example/room/asset-1',
                    websiteBaseUrl: 'https://editor.example',
                    assetId: 'asset-1',
                    documentId: glyphDocumentId('id-b'),
                    expectedRevision: 'rev-2',
                    maxAttempts: 1,
                    wait: async () => {}
                })
            ).rejects.toThrow('revision mismatch');
            expect(relay.mock.calls.map(([bytes]) => [...bytes])).toEqual([
                [7]
            ]);
        } finally {
            global.fetch = originalFetch;
            window.windowRole = previousRole;
            window.windowSync = previousSync;
        }
    });

    test('a first catch-up reads the journal from log id 0', async () => {
        const writer = createEngine('writer');
        const receiver = hydrateReceiverFromWriter(writer.bridge);
        window.changeBridge = writer.bridge;
        writer.font.findGlyph('B').layers[0].width = 777;
        const liveTail = writer.bridge.encodeDocumentState(
            glyphDocumentId('id-b')
        );
        const expectedRevision = revisionFor(writer.bridge, 'id-b');
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async (input) => {
            expect(String(input)).toContain('afterLogId=0');
            expect(String(input)).toContain('/live');
            return framedLiveResponse(liveTail);
        });
        try {
            await catchUpCloudDocument({
                bridge: receiver,
                token: 'token',
                roomUrl: 'wss://rooms.example/room/asset-1',
                websiteBaseUrl: 'https://editor.example',
                assetId: 'asset-1',
                documentId: glyphDocumentId('id-b'),
                expectedRevision,
                maxAttempts: 2,
                wait: async () => {}
            });
            expect(glyphWidth(receiver, 'B')).toBe(777);
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('a later catch-up asks only for log entries after the ones it holds', async () => {
        const writer = createEngine('writer');
        const receiver = hydrateReceiverFromWriter(writer.bridge);
        window.changeBridge = writer.bridge;
        const urls = [];
        const originalFetch = global.fetch;
        const catchUp = () =>
            catchUpCloudDocument({
                bridge: receiver,
                token: 'token',
                roomUrl: 'wss://rooms.example/room/asset-1',
                websiteBaseUrl: 'https://editor.example',
                assetId: 'asset-1',
                documentId: glyphDocumentId('id-b'),
                expectedRevision: revisionFor(writer.bridge, 'id-b'),
                maxAttempts: 2,
                wait: async () => {}
            });
        try {
            writer.font.findGlyph('B').layers[0].width = 701;
            let state = writer.bridge.encodeDocumentState(
                glyphDocumentId('id-b')
            );
            global.fetch = jest.fn(async (input) => {
                urls.push(String(input));
                return framedLiveResponse(state);
            });
            await catchUp();
            writer.font.findGlyph('B').layers[0].width = 702;
            state = writer.bridge.encodeDocumentState(glyphDocumentId('id-b'));
            await catchUp();
            expect(glyphWidth(receiver, 'B')).toBe(702);
            expect(
                urls.map((url) => new URL(url).searchParams.get('afterLogId'))
            ).toEqual(['0', '1']);
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('a state download sets where the next catch-up starts', async () => {
        const writer = createEngine('writer');
        const receiver = hydrateReceiverFromWriter(writer.bridge);
        window.changeBridge = writer.bridge;
        writer.font.findGlyph('B').layers[0].width = 733;
        const state = writer.bridge.encodeDocumentState(
            glyphDocumentId('id-b')
        );
        const urls = [];
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async (input) => {
            const url = String(input);
            urls.push(url);
            if (url.includes('/live')) {
                return {
                    ok: false,
                    status: 409,
                    headers: new Headers({
                        'content-type': 'application/json'
                    }),
                    json: async () => ({
                        code: 'rebaseline_required',
                        lastCheckpointLogId: 40
                    })
                };
            }
            return {
                ok: true,
                status: 200,
                headers: new Headers({ 'X-Checkpoint-Log-Id': '57' }),
                arrayBuffer: async () =>
                    state.buffer.slice(
                        state.byteOffset,
                        state.byteOffset + state.byteLength
                    )
            };
        });
        const catchUp = () =>
            catchUpCloudDocument({
                bridge: receiver,
                token: 'token',
                roomUrl: 'wss://rooms.example/room/asset-1',
                websiteBaseUrl: 'https://editor.example',
                assetId: 'asset-1',
                documentId: glyphDocumentId('id-b'),
                maxAttempts: 1,
                wait: async () => {}
            });
        try {
            await catchUp();
            expect(glyphWidth(receiver, 'B')).toBe(733);
            urls.length = 0;
            await catchUp();
            expect(new URL(urls[0]).searchParams.get('afterLogId')).toBe('57');
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('a catch-up behind the checkpoint takes the state in one request', async () => {
        const writer = createEngine('writer');
        const receiver = hydrateReceiverFromWriter(writer.bridge);
        window.changeBridge = writer.bridge;
        writer.font.findGlyph('B').layers[0].width = 744;
        const state = writer.bridge.encodeDocumentState(
            glyphDocumentId('id-b')
        );
        const urls = [];
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async (input) => {
            urls.push(String(input));
            return {
                ok: true,
                status: 200,
                headers: new Headers({
                    'content-type': 'application/octet-stream',
                    'X-Catch-Up': 'state',
                    'X-Checkpoint-Log-Id': '9'
                }),
                arrayBuffer: async () =>
                    state.buffer.slice(
                        state.byteOffset,
                        state.byteOffset + state.byteLength
                    )
            };
        });
        try {
            await catchUpCloudDocument({
                bridge: receiver,
                token: 'token',
                roomUrl: 'wss://rooms.example/room/asset-1',
                websiteBaseUrl: 'https://editor.example',
                assetId: 'asset-1',
                documentId: glyphDocumentId('id-b'),
                expectedRevision: revisionFor(writer.bridge, 'id-b'),
                maxAttempts: 2,
                wait: async () => {}
            });
            expect(glyphWidth(receiver, 'B')).toBe(744);
            expect(urls).toHaveLength(1);
            expect(new URL(urls[0]).searchParams.get('rebaseline')).toBe(
                'state'
            );
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('live catalog glyph ids come from font-core and skip tombstones', () => {
        const { bridge } = createEngine('catalog-reader');
        expect(bridge.listLiveCatalogGlyphIds()).toEqual([]);
        const entry = (glyphId, name, codepoint) => ({
            glyphId,
            name,
            codepoints: { [codepoint]: true },
            latestGlyphRevision: '0',
            exported: true,
            deleted: false,
            generation: 0
        });
        bridge.syncCloudOwnedProjection({
            glyphCatalog: {
                'id-a': entry('id-a', 'A', 65),
                'id-b': entry('id-b', 'B', 66)
            },
            codepointIndex: { 65: 'id-a', 66: 'id-b' }
        });
        expect(bridge.listLiveCatalogGlyphIds().sort()).toEqual([
            'id-a',
            'id-b'
        ]);

        const catalog = bridge.fontMap.get('glyphCatalog');
        const tombstoned = catalog.get('id-b');
        bridge.yDoc.transact(() => {
            if (typeof tombstoned?.set === 'function') {
                tombstoned.set('deleted', true);
            } else {
                catalog.set('id-b', { ...tombstoned, deleted: true });
            }
        });
        expect(bridge.listLiveCatalogGlyphIds()).toEqual(['id-a']);
    });
});
