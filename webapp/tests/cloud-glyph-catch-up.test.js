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
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const { Font } = require('../js/babelfont-model');
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
    bridge.onGlyphRevisionSignal((update, entries) => {
        packets.push({
            update,
            collaborationMessage: null,
            changeLogEntries: entries,
            documentId: FONT_CORE_DOCUMENT_ID
        });
    });
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

function revisionFor(bridge, glyphId) {
    return bridge
        .listGlyphRevisionTokens()
        .find((entry) => entry.glyphId === glyphId)?.revision;
}

describe('glyph catch-up for edits outside the receiver subset', () => {
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

    test('local outline edits publish a font-core revision signal', () => {
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
        expect(corePackets.length).toBeGreaterThan(0);
        expect(
            glyphIdsFromRevisionEntries(corePackets[0].changeLogEntries)
        ).toEqual(['id-b']);
        expect(glyphWidth(bridge, 'A')).toBe(500);
    });

    test('receiver without the glyph room still converges via core signal plus catch-up', () => {
        const writer = createEngine('writer');
        const receiver = hydrateReceiverFromWriter(writer.bridge);
        const packets = capturePackets(writer.bridge);

        window.changeBridge = writer.bridge;
        writer.font.findGlyph('B').layers[0].width = 777;

        const corePackets = packets.filter(
            (packet) => packet.documentId === FONT_CORE_DOCUMENT_ID
        );
        const glyphPackets = packets.filter(
            (packet) => packet.documentId === glyphDocumentId('id-b')
        );
        expect(corePackets.length).toBeGreaterThan(0);
        expect(glyphPackets.length).toBeGreaterThan(0);

        for (const packet of corePackets) {
            receiver.applyRemoteUpdate(
                packet.update,
                packet.changeLogEntries,
                packet.collaborationMessage
                    ? [packet.collaborationMessage]
                    : undefined,
                packet.documentId
            );
        }

        expect(glyphWidth(receiver, 'B')).toBe(400);
        expect(
            glyphIdsFromRevisionEntries(
                corePackets.flatMap((packet) => packet.changeLogEntries)
            )
        ).toEqual(['id-b']);

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

    test('glyph packets include the catch-up stamp before the core revision signal', () => {
        const { bridge, font } = createEngine('writer');
        const receiver = hydrateReceiverFromWriter(bridge);
        const packets = capturePackets(bridge);
        font.findGlyph('B').layers[0].width = 777;

        const glyphIndex = packets.findIndex(
            (packet) => packet.documentId === glyphDocumentId('id-b')
        );
        const coreIndex = packets.findIndex(
            (packet) =>
                packet.documentId === FONT_CORE_DOCUMENT_ID &&
                glyphIdsFromRevisionEntries(packet.changeLogEntries).includes(
                    'id-b'
                )
        );
        expect(glyphIndex).toBeGreaterThanOrEqual(0);
        expect(coreIndex).toBeGreaterThan(glyphIndex);
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

    test('a multi-glyph edit publishes one collab envelope with every dirty id', () => {
        const { bridge, font } = createEngine('writer');
        const packets = capturePackets(bridge);
        bridge.beginTransaction('edit');
        font.findGlyph('A').layers[0].width = 111;
        font.findGlyph('B').layers[0].width = 222;
        bridge.endTransaction();

        const corePackets = packets.filter(
            (packet) =>
                packet.documentId === FONT_CORE_DOCUMENT_ID &&
                glyphIdsFromRevisionEntries(packet.changeLogEntries).length
        );
        expect(corePackets).toHaveLength(1);
        expect(
            glyphIdsFromRevisionEntries(corePackets[0].changeLogEntries).sort()
        ).toEqual(['id-a', 'id-b']);
        const envelopes =
            createCollaborationMessageEnvelopesFromChangeLogEntries(
                corePackets[0].changeLogEntries,
                {
                    startingLocalSequence: 1,
                    source: 'test',
                    windowId: bridge.windowId
                }
            );
        expect(envelopes).toHaveLength(1);
        expect(
            glyphIdsFromRevisionEntries(
                envelopes[0].changes.map((change) => ({ path: change.path }))
            ).sort()
        ).toEqual(['id-a', 'id-b']);
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

    test('core hydrate scans dirty revisions so a later opener still catches up', async () => {
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
});
