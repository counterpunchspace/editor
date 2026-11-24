/**
 * Round F engine follow-ups, so no edit goes missing:
 *
 * - A held relay run's staged row is dropped only once the relayed row is
 *   durable on this device; a relay that is not durable keeps it.
 * - A failed undo names the entry it took back, and a linked window takes
 *   the same relayed entry back (`takeBackHistoryEntry`).
 * - A live socket closed with 4000 before it synced re-reads its glyph on
 *   reconnect; the editor hears of it first and writes its pending edit.
 * - The deferred after-sync model rebuild at the end of an async catch-up
 *   (a reconnect) lets the editor write an edit made while it ran.
 */

const { webcrypto } = require('crypto');
const { TextDecoder, TextEncoder } = require('util');
Object.defineProperty(global, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true
});
global.TextDecoder = TextDecoder;
global.TextEncoder = TextEncoder;

const { PatchSyncEngine } = require('../js/patch-sync-engine');
const { createLogEntry } = require('../js/change-log');
const { CloudAdapter } = require('../js/cloud-adapter.ts');

function drawing(id, width = 500) {
    return {
        id,
        master: { type: 'DefaultForMaster', master: 'M1' },
        width,
        shapes: [],
        anchors: []
    };
}

function makeFont() {
    const glyph = (name, layers) => ({
        name,
        id: `id-${name}`,
        production_name: null,
        category: 'Base',
        codepoints: [],
        exported: true,
        layers
    });
    return {
        upm: 1000,
        version: [1, 0],
        names: { familyName: 'Reconnect' },
        axes: [],
        masters: [{ id: 'M1', name: 'Regular', location: {} }],
        glyphs: [glyph('A', [drawing('LA')]), glyph('D', [drawing('LD')])]
    };
}

function commitDrawing(engine, glyphName, drawingObject) {
    engine.syncDrawingSnapshotsFromJson(
        [
            {
                glyphName,
                layerId: drawingObject.id,
                drawingJson: JSON.parse(JSON.stringify(drawingObject))
            }
        ],
        'Arrow key',
        undefined,
        undefined,
        null,
        [{ glyphName, layerId: drawingObject.id }],
        'keyboard',
        'keyboard',
        'outline'
    );
}

function pair(label) {
    const senderFont = makeFont();
    const receiverFont = JSON.parse(JSON.stringify(senderFont));
    const sender = new PatchSyncEngine(`sender-${label}`);
    const receiver = new PatchSyncEngine(`receiver-${label}`);
    sender.initFromJson(senderFont);
    receiver.setFontJson(receiverFont);
    receiver.applyDocumentSetState(sender.encodeDocumentSet());
    return { sender, receiver, receiverFont };
}

function capturePackets(engine) {
    const packets = [];
    engine.onLocalUpdate((update, message, entries, documentId) => {
        packets.push({ update, message, entries, documentId });
    });
    return packets;
}

const editPackets = (packets) =>
    packets.filter((packet) => packet.documentId !== 'font-deps');
const modelDrawing = (font, glyphName) =>
    font.glyphs.find((glyph) => glyph.name === glyphName).layers[0];

/** The editor's pending nudge, written when a re-read of its glyph is due. */
function pendingNudge(engine, font, glyphName, width) {
    const captured = modelDrawing(font, glyphName);
    captured.width = width;
    const state = { pending: true, events: [] };
    engine.onBeforeGlyphModelRebuild((event) => {
        state.events.push(['before', event.cause, event.glyphs]);
        if (
            state.pending &&
            (event.glyphs === null || event.glyphs.includes(glyphName))
        ) {
            state.pending = false;
            commitDrawing(engine, glyphName, captured);
        }
    });
    engine.onGlyphModelRebuilt((event) =>
        state.events.push(['after', event.cause, event.glyphs])
    );
    return state;
}

let previousTrace;
let previousCloudPlugin;
beforeEach(() => {
    previousTrace = window.__collabTrace;
    previousCloudPlugin = window.cloudPlugin;
    window.__collabTrace = { enabled: true, entries: [], sequence: 0 };
});
afterEach(() => {
    window.__collabTrace = previousTrace;
    window.cloudPlugin = previousCloudPlugin;
});

const traced = (kind) =>
    window.__collabTrace.entries.filter((entry) => entry.kind === kind);

describe('a held relay run’s staged row', () => {
    function flushRelayRun(durable) {
        const engine = new PatchSyncEngine(`relay-${String(durable)}`);
        engine.initFromJson(makeFont());
        const dropStagedCloudUpdate = jest.fn();
        let settle;
        const relayed = new Promise((resolve, reject) => {
            settle = { resolve, reject };
        });
        window.cloudPlugin = {
            relayPeerWindowUpdateToCloud: jest.fn(() => relayed),
            dropStagedCloudUpdate
        };
        const packet = {
            kind: 'relay',
            burstKey: 'burst-1',
            documentId: 'glyph:id-A',
            update: new Uint8Array([0, 0]),
            envelope: null,
            entries: []
        };
        const groupKey = engine._heldRunKey(new Map(), packet);
        engine._stagedHeld.set(groupKey, {
            documentId: packet.documentId,
            update: packet.update,
            envelope: null,
            stagedId: 'staged-1',
            written: Promise.resolve()
        });
        engine._flushHeldCloudPackets([packet]);
        return { engine, dropStagedCloudUpdate, settle };
    }
    const settleAll = () => new Promise((resolve) => setTimeout(resolve, 0));

    test('is dropped once the relayed row is durable', async () => {
        const { engine, dropStagedCloudUpdate, settle } = flushRelayRun(true);
        await settleAll();
        expect(
            window.cloudPlugin.relayPeerWindowUpdateToCloud
        ).toHaveBeenCalled();
        // Not before the relay settles.
        expect(dropStagedCloudUpdate).not.toHaveBeenCalled();
        settle.resolve(true);
        await settleAll();
        expect(dropStagedCloudUpdate).toHaveBeenCalledWith(
            'glyph:id-A',
            'staged-1'
        );
        expect(traced('relay-staged-kept')).toEqual([]);
        engine.destroy();
    });

    test('stays when the relayed row is not durable', async () => {
        const { engine, dropStagedCloudUpdate, settle } = flushRelayRun(false);
        await settleAll();
        settle.resolve(false);
        await settleAll();
        expect(dropStagedCloudUpdate).not.toHaveBeenCalled();
        expect(traced('relay-staged-kept')).toEqual([
            expect.objectContaining({
                detail: { document: 'glyph:id-A', reason: 'not-durable' }
            })
        ]);
        engine.destroy();
    });

    test('stays when the relay rejects', async () => {
        const { engine, dropStagedCloudUpdate, settle } = flushRelayRun('x');
        await settleAll();
        settle.reject(new Error('gone'));
        await settleAll();
        expect(dropStagedCloudUpdate).not.toHaveBeenCalled();
        expect(traced('relay-staged-kept')[0].detail).toEqual(
            expect.objectContaining({ reason: 'relay-rejected', error: 'gone' })
        );
        engine.destroy();
    });
});

describe('taking back a failed undo', () => {
    // A relayed entry is logged with the author's ids namespaced by its
    // window (`createChangeLogEntriesFromCollaborationMessageEnvelope`);
    // the take-back names them as the author holds them.
    function controlEntry(fields) {
        return createLogEntry({
            timestamp: 1,
            windowRoleLabel: 'Linked',
            transactionLabel: 'Undo',
            transactionId: null,
            op: 'set',
            path: 'glyphs.A.layers.LA',
            oldValue: undefined,
            newValue: fields.historyAction,
            ...fields
        });
    }

    test('removes the entry with its own history item id and steps the cursors back', () => {
        const engine = new PatchSyncEngine('take-back-id');
        engine.initFromJson(makeFont());
        const before = controlEntry({
            windowId: 'w-1',
            historyAction: 'change',
            historyItemId: 'c-1'
        });
        const undoEntry = controlEntry({
            windowId: 'w-2',
            historyAction: 'undo',
            targetHistoryItemId: 'w-2:c-1',
            historyItemId: 'w-2:u-1'
        });
        const after = controlEntry({
            windowId: 'w-1',
            historyAction: 'change',
            historyItemId: 'c-2'
        });
        engine._changeLog = [];
        engine._appendChangeLogEntries([before, undoEntry, after]);
        engine._lastLocalUpdateLogIndex = 3;
        engine._lastBroadcastLogIndex = 2;
        const notified = jest.fn();
        engine.onChangeLogUpdate(notified);
        notified.mockClear(); // it hears the current log on subscribing

        expect(
            engine.takeBackHistoryEntry({
                historyAction: 'undo',
                targetHistoryItemId: 'c-1',
                entryHistoryItemId: 'u-1',
                windowId: 'w-2'
            })
        ).toBe(true);

        expect(engine._changeLog.map((entry) => entry.historyItemId)).toEqual([
            'c-1',
            'c-2'
        ]);
        expect(engine._lastLocalUpdateLogIndex).toBe(2);
        expect(engine._lastBroadcastLogIndex).toBe(1);
        expect(notified).toHaveBeenCalledTimes(1);
        expect(notified.mock.calls[0][0]).toHaveLength(2);
        engine.destroy();
    });

    test('with an id, only that entry matches; nothing is inferred', () => {
        const engine = new PatchSyncEngine('take-back-strict');
        engine.initFromJson(makeFont());
        engine._changeLog = [];
        engine._appendChangeLogEntries([
            controlEntry({
                windowId: 'w-2',
                historyAction: 'undo',
                targetHistoryItemId: 'w-2:c-1',
                historyItemId: 'w-2:u-other'
            })
        ]);
        expect(
            engine.takeBackHistoryEntry({
                historyAction: 'undo',
                targetHistoryItemId: 'c-1',
                entryHistoryItemId: 'u-1',
                windowId: 'w-2'
            })
        ).toBe(false);
        // Another window's entry, or another action, is never taken.
        expect(
            engine.takeBackHistoryEntry({
                historyAction: 'redo',
                targetHistoryItemId: 'c-1',
                entryHistoryItemId: null,
                windowId: 'w-2'
            })
        ).toBe(false);
        expect(
            engine.takeBackHistoryEntry({
                historyAction: 'undo',
                targetHistoryItemId: 'c-1',
                entryHistoryItemId: null,
                windowId: 'w-3'
            })
        ).toBe(false);
        expect(engine._changeLog).toHaveLength(1);
        engine.destroy();
    });

    test('without an id, the newest entry of that action, target and window', () => {
        const engine = new PatchSyncEngine('take-back-newest');
        engine.initFromJson(makeFont());
        engine._changeLog = [];
        engine._appendChangeLogEntries([
            controlEntry({
                windowId: 'w-2',
                historyAction: 'undo',
                targetHistoryItemId: 'w-2:c-1',
                historyItemId: 'w-2:u-old'
            }),
            controlEntry({
                windowId: 'w-2',
                historyAction: 'undo',
                targetHistoryItemId: 'w-2:c-1',
                historyItemId: 'w-2:u-new'
            })
        ]);
        expect(
            engine.takeBackHistoryEntry({
                historyAction: 'undo',
                targetHistoryItemId: 'c-1',
                entryHistoryItemId: null,
                windowId: 'w-2'
            })
        ).toBe(true);
        expect(engine._changeLog.map((entry) => entry.historyItemId)).toEqual([
            'w-2:u-old'
        ]);
        engine.destroy();
    });

    test('a linked window takes back the relayed undo it logged under the author’s namespaced ids', () => {
        const { sender, receiver } = pair('take-back-linked');
        const packets = capturePackets(sender);
        const previousBridge = window.patchSyncEngine;
        window.patchSyncEngine = sender;
        try {
            sender.beginTransaction('Widen', null, {
                compileChangeSource: 'test-sync',
                compileEditType: null
            });
            sender.recordChange(
                ['glyphs', 'A', 'layers', 'LA'],
                'width',
                500,
                600
            );
            sender.endTransaction();
            sender.undo();
        } finally {
            window.patchSyncEngine = previousBridge;
        }
        const undoEntry = [...sender._changeLog]
            .reverse()
            .find((entry) => entry.historyAction === 'undo');
        expect(undoEntry).toBeTruthy();
        for (const packet of packets) {
            receiver.applyRemoteUpdate(
                packet.update,
                undefined,
                packet.message ? [packet.message] : undefined,
                packet.documentId
            );
        }
        const loggedUndo = () =>
            receiver._changeLog.filter(
                (entry) => entry.historyAction === 'undo'
            );
        expect(loggedUndo().length).toBeGreaterThan(0);
        // The replay's packets carry the replayed item's id, under the
        // author's prefix, not the author's control entry id.
        expect(loggedUndo()[0].historyItemId).toBe(
            `${sender.windowId}:${undoEntry.targetHistoryItemId}`
        );
        const logLength = receiver._changeLog.length;
        const undoCount = loggedUndo().length;

        expect(
            receiver.takeBackHistoryEntry({
                historyAction: 'undo',
                targetHistoryItemId: undoEntry.targetHistoryItemId,
                entryHistoryItemId: undoEntry.historyItemId,
                windowId: sender.windowId
            })
        ).toBe(true);

        expect(loggedUndo()).toHaveLength(0);
        expect(receiver._changeLog).toHaveLength(logLength - undoCount);
        sender.destroy();
        receiver.destroy();
    });

    test('an id the receiving window created matches without its prefix', () => {
        const engine = new PatchSyncEngine('main-w');
        engine.initFromJson(makeFont());
        engine._changeLog = [];
        engine._appendChangeLogEntries([
            controlEntry({
                windowId: 'w-2',
                historyAction: 'undo',
                // main's own item, relayed back unprefixed
                targetHistoryItemId: 'c-own',
                historyItemId: 'w-2:u-1'
            })
        ]);
        expect(
            engine.takeBackHistoryEntry({
                historyAction: 'undo',
                targetHistoryItemId: 'main-w:c-own',
                entryHistoryItemId: 'u-1',
                windowId: 'w-2'
            })
        ).toBe(true);
        expect(engine._changeLog).toHaveLength(0);
        engine.destroy();
    });

    test('a failed undo names the entry it took back in history-replay-failed', () => {
        const engine = new PatchSyncEngine('take-back-detail');
        engine.initFromJson(makeFont());
        const previousBridge = window.patchSyncEngine;
        window.patchSyncEngine = engine;
        const onFailed = jest.fn();
        window.addEventListener('history-replay-failed', onFailed);
        const errorSpy = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        try {
            engine.beginTransaction('Widen', null, {
                compileChangeSource: 'test-sync',
                compileEditType: null
            });
            engine.recordChange(
                ['glyphs', 'A', 'layers', 'LA'],
                'width',
                500,
                600
            );
            engine.endTransaction();
            const lengthBefore = engine._changeLog.length;
            jest.spyOn(engine, '_applyHistoryItem').mockImplementation(() => {
                throw new Error('replay broke');
            });

            expect(() => engine.undo()).toThrow('replay broke');

            expect(onFailed).toHaveBeenCalledTimes(1);
            const detail = onFailed.mock.calls[0][0].detail;
            expect(detail.historyAction).toBe('undo');
            expect(typeof detail.takenBackHistoryItemId).toBe('string');
            expect(detail.takenBackHistoryItemId).not.toBe(
                detail.historyItemId
            );
            // The entry is out of this window's log.
            expect(engine._changeLog).toHaveLength(lengthBefore);
            expect(
                engine._changeLog.some(
                    (entry) =>
                        entry.historyItemId === detail.takenBackHistoryItemId
                )
            ).toBe(false);
        } finally {
            errorSpy.mockRestore();
            window.removeEventListener('history-replay-failed', onFailed);
            window.patchSyncEngine = previousBridge;
            engine.destroy();
        }
    });
});

describe('a live socket closed with 4000 before it synced (fuzz O2)', () => {
    function closeBeforeSync(adapter) {
        const ws = { readyState: 1, send: jest.fn(), close: jest.fn() };
        adapter._ws = ws;
        adapter._handleMessage(
            JSON.stringify({
                type: 'rebaseline-required',
                currentCheckpointLogId: 7
            })
        );
        expect(ws.close).toHaveBeenCalledWith(4000, 'rebaseline-required');
    }

    test('the reconnect catch-up of the glyph lets the editor write its pending nudge first', () => {
        const { sender, receiver, receiverFont } = pair('reconnect-glyph');
        const documentId = receiver.documentIdForPath(['glyphs', 'A']);
        const adapter = new CloudAdapter({ assetId: 'asset-1', documentId });
        adapter._bridge = receiver;
        closeBeforeSync(adapter);
        const packets = capturePackets(receiver);
        const nudge = pendingNudge(receiver, receiverFont, 'A', 930);

        // The reconnect's room state for the glyph.
        expect(
            adapter._applyServerStateToBridge(
                sender.encodeDocumentState(documentId)
            )
        ).toBe(true);

        expect(nudge.pending).toBe(false);
        expect(nudge.events[0]).toEqual(['before', 'catch-up', ['A']]);
        expect(editPackets(packets).map((packet) => packet.documentId)).toEqual(
            [documentId]
        );
        expect(
            receiver.getYValue(['glyphs', 'A', 'layers', 'LA', 'width'])
        ).toBe(930);
        expect(modelDrawing(receiverFont, 'A').width).toBe(930);
        sender.destroy();
        receiver.destroy();
    });

    test('a font-core rebaseline on reconnect runs the before-listeners for every glyph', () => {
        const { sender, receiver, receiverFont } = pair('reconnect-core');
        const adapter = new CloudAdapter({
            assetId: 'asset-1',
            documentId: 'font-core'
        });
        adapter._bridge = receiver;
        closeBeforeSync(adapter);
        const nudge = pendingNudge(receiver, receiverFont, 'D', 640);

        adapter._applyServerStateToBridge(
            sender.encodeDocumentState('font-core')
        );

        expect(nudge.pending).toBe(false);
        expect(nudge.events[0]).toEqual(['before', 'rebaseline', null]);
        expect(
            receiver.getYValue(['glyphs', 'D', 'layers', 'LD', 'width'])
        ).toBe(640);
        sender.destroy();
        receiver.destroy();
    });
});

describe('the deferred after-sync rebuild at the end of an async catch-up', () => {
    test('lets the editor write an edit made while the catch-up ran, then rebuilds and reports every glyph', () => {
        const { sender, receiver, receiverFont } = pair('deferred');
        const documentId = receiver.documentIdForPath(['glyphs', 'A']);
        const order = [];
        receiver.onAfterSync(() => order.push('after-sync'));
        const packets = capturePackets(receiver);

        receiver.beginDeferredAfterSync();
        receiver.applyDocumentCheckpoint(
            documentId,
            sender.encodeDocumentState(documentId)
        );
        // Deferred: the model was not rebuilt yet.
        expect(order).toEqual([]);
        // The user nudges while the catch-up still awaits other glyphs.
        const nudge = pendingNudge(receiver, receiverFont, 'A', 955);
        receiver.onBeforeGlyphModelRebuild(() => order.push('before'));
        window.__collabTrace.entries = [];

        receiver.endDeferredAfterSync();

        expect(nudge.pending).toBe(false);
        expect(order).toEqual(['before', 'after-sync']);
        expect(nudge.events).toEqual([
            ['before', 'deferred-after-sync', null],
            ['after', 'deferred-after-sync', null]
        ]);
        expect(editPackets(packets).map((packet) => packet.documentId)).toEqual(
            [documentId]
        );
        expect(
            receiver.getYValue(['glyphs', 'A', 'layers', 'LA', 'width'])
        ).toBe(955);
        expect(traced('model-glyph-rebuilt')).toEqual([
            expect.objectContaining({
                detail: { glyphs: 'all', cause: 'deferred-after-sync' }
            })
        ]);
        sender.destroy();
        receiver.destroy();
    });

    test('a before-listener that cannot write keeps the rebuild due instead of rebuilding over the edit', () => {
        const engine = new PatchSyncEngine('deferred-refused');
        engine.initFromJson(makeFont());
        const afterSync = jest.fn();
        engine.onAfterSync(afterSync);
        let refuse = true;
        engine.onBeforeGlyphModelRebuild(() => {
            if (refuse) throw new Error('cannot write');
        });
        const errorSpy = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        try {
            engine.beginDeferredAfterSync();
            engine._emitAfterSync();
            engine.endDeferredAfterSync();
            expect(afterSync).not.toHaveBeenCalled();
            expect(traced('model-rebuild-deferred-kept')).toHaveLength(1);

            refuse = false;
            engine.beginDeferredAfterSync();
            engine.endDeferredAfterSync();
            expect(afterSync).toHaveBeenCalledTimes(1);
        } finally {
            errorSpy.mockRestore();
            engine.destroy();
        }
    });
});
