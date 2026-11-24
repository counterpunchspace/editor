/**
 * Unsent rows from the write-ahead log go back into a document only on top
 * of the room's state they build on (fuzz seed 937074107: after a reopen,
 * kerning:0 refused this window's own unsent edit, which needed its earlier,
 * already acknowledged edit that only the room's state brings).
 */
const Y = require('yjs');
const {
    applyUnsentRowsInOrder,
    classifyUnsentRow,
    unsentRowIsIntegrated
} = require('../js/cloud-adapter-wal-restore.ts');
const {
    applyUpdateWithIntegrity,
    ClockGapError
} = require('../js/yjs-update-integrity.ts');
const { CloudAdapter } = require('../js/cloud-adapter.ts');
const { CloudLiveSession } = require('../js/cloud-live-session.ts');

const DOC = 'kerning:0';

/**
 * A room copy where client 1 made two edits: the first acknowledged (in the
 * room's state), the second unsent (only in the WAL).
 */
function twoEditsOfOneClient() {
    const author = new Y.Doc();
    author.clientID = 1;
    author.getMap('kerning').set('A V', -40);
    const acknowledged = Y.encodeStateAsUpdate(author);
    const svAfterFirst = Y.encodeStateVector(author);
    author.getMap('kerning').set('T o', -60);
    const unsent = Y.encodeStateAsUpdate(author, svAfterFirst);
    return { acknowledged, unsent, full: Y.encodeStateAsUpdate(author) };
}

function envelope(id) {
    return {
        source: 'test',
        messageId: id,
        transactionId: id,
        changes: [],
        metadata: {}
    };
}

function fakeBridge(doc, documentId = DOC) {
    const markDocumentBroken = jest.fn();
    const apply = (update) => applyUpdateWithIntegrity(doc, update, documentId);
    return {
        markDocumentBroken,
        getDocumentInstance: (id) => (id === documentId ? doc : null),
        getCollaborationLog: () => [],
        hasResidentGlyphDocument: () => true,
        applyRemoteUpdate: jest.fn((update) => apply(update)),
        applyDocumentCatchUp: jest.fn((_id, update) => apply(update)),
        onLocalUpdate: jest.fn(),
        offLocalUpdate: jest.fn()
    };
}

function fakeWal(records) {
    return {
        health: 'ready',
        isLoaded: true,
        pendingCount: records.length,
        load: async () => {},
        recordsFor: (id) =>
            records.filter((record) => !id || record.documentId === id),
        replayableRecords: () => records,
        pendingCountFor: (id) =>
            records.filter((record) => record.documentId === id).length,
        transactionIdsFor: () => new Set(),
        hasPendingDependencies: () => false,
        onChange: () => () => {},
        acknowledge: async () => {},
        acknowledgeMany: async () => {}
    };
}

function walRow(documentId, id, update) {
    return {
        assetId: 'asset-1',
        documentId,
        clientTransactionId: id,
        updateBytes: update,
        collaborationMessage: envelope(id),
        state: 'applied',
        createdAt: 1,
        attempts: 0
    };
}

describe('classifying unsent rows', () => {
    test('a row that builds on a change the document lacks waits', () => {
        const { unsent } = twoEditsOfOneClient();
        const result = classifyUnsentRow(new Y.Doc(), unsent, DOC);
        expect(result.verdict).toBe('waiting');
        expect(result.gap).toBeInstanceOf(ClockGapError);
    });

    test('the same row fits once the room state is in, and is then held', () => {
        const { acknowledged, unsent } = twoEditsOfOneClient();
        const doc = new Y.Doc();
        Y.applyUpdate(doc, acknowledged);
        expect(classifyUnsentRow(doc, unsent, DOC).verdict).toBe('applicable');
        Y.applyUpdate(doc, unsent);
        expect(classifyUnsentRow(doc, unsent, DOC).verdict).toBe('integrated');
    });

    test('a document not loaded makes every row wait', () => {
        const { acknowledged } = twoEditsOfOneClient();
        expect(classifyUnsentRow(null, acknowledged, DOC).verdict).toBe(
            'waiting'
        );
    });

    test('a row of deletions alone is never counted as held', () => {
        const doc = new Y.Doc();
        doc.getMap('kerning').set('A V', -40);
        const before = Y.encodeStateVector(doc);
        const snapshot = Y.encodeStateAsUpdate(doc);
        doc.getMap('kerning').delete('A V');
        const deletion = Y.encodeStateAsUpdate(doc, before);
        const target = new Y.Doc();
        Y.applyUpdate(target, snapshot);
        expect(unsentRowIsIntegrated(target, deletion)).toBe(false);
        expect(classifyUnsentRow(target, deletion, DOC).verdict).toBe(
            'applicable'
        );
    });

    test('the walk stops at the first row that does not fit; later rows never overtake it', () => {
        const { acknowledged, unsent } = twoEditsOfOneClient();
        const doc = new Y.Doc();
        const applied = [];
        const result = applyUnsentRowsInOrder(
            [
                { id: 'later', update: unsent },
                { id: 'fits', update: acknowledged }
            ],
            {
                documentId: DOC,
                doc: () => doc,
                update: (row) => row.update,
                apply: (row) => {
                    applied.push(row.id);
                    Y.applyUpdate(doc, row.update);
                }
            }
        );
        expect(applied).toEqual([]);
        expect(result.waiting.map((row) => row.id)).toEqual(['later', 'fits']);
    });
});

describe('CloudAdapter restores unsent rows after the room state', () => {
    function adapterFor(doc, records) {
        const adapter = new CloudAdapter({
            assetId: 'asset-1',
            documentId: DOC,
            wal: fakeWal(records)
        });
        const bridge = fakeBridge(doc);
        adapter._bridge = bridge;
        return { adapter, bridge };
    }

    test('a reopened window’s unsent row waits for the room state instead of breaking the document', async () => {
        const { acknowledged, unsent } = twoEditsOfOneClient();
        const doc = new Y.Doc();
        const { adapter, bridge } = adapterFor(doc, [
            walRow(DOC, 'tx-2', unsent)
        ]);

        await adapter._restorePersistentOutboxIntoBridge();
        expect(bridge.markDocumentBroken).not.toHaveBeenCalled();
        expect(adapter.unsentRowsAwaitingRoomState).toBe(1);
        expect(doc.getMap('kerning').get('T o')).toBeUndefined();
        // It is queued to be sent all the same.
        expect(adapter._pendingOutboundPackets).toHaveLength(1);

        // The room state (with the acknowledged edit) arrives: the row
        // applies on top of it.
        adapter._applyServerStateToBridge(acknowledged);
        expect(adapter.unsentRowsAwaitingRoomState).toBe(0);
        expect(doc.getMap('kerning').toJSON()).toEqual({
            'A V': -40,
            'T o': -60
        });
        expect(bridge.markDocumentBroken).not.toHaveBeenCalled();
        adapter.disconnect();
    });

    test('a page of the room’s log that stops short leaves the row waiting, not broken', async () => {
        const { acknowledged, unsent } = twoEditsOfOneClient();
        const other = new Y.Doc();
        other.clientID = 2;
        other.getMap('kerning').set('L T', -20);
        const firstPage = Y.encodeStateAsUpdate(other);
        const doc = new Y.Doc();
        const { adapter, bridge } = adapterFor(doc, [
            walRow(DOC, 'tx-2', unsent)
        ]);
        await adapter._restorePersistentOutboxIntoBridge();

        adapter._applyServerStateToBridge(firstPage);
        expect(adapter.unsentRowsAwaitingRoomState).toBe(1);
        expect(bridge.markDocumentBroken).not.toHaveBeenCalled();

        adapter._applyServerStateToBridge(acknowledged);
        expect(adapter.unsentRowsAwaitingRoomState).toBe(0);
        expect(doc.getMap('kerning').get('T o')).toBe(-60);
        adapter.disconnect();
    });

    test('a row the room state already holds is skipped, not applied again', async () => {
        const { full, unsent } = twoEditsOfOneClient();
        const doc = new Y.Doc();
        const { adapter, bridge } = adapterFor(doc, [
            walRow(DOC, 'tx-2', unsent)
        ]);
        await adapter._restorePersistentOutboxIntoBridge();
        bridge.applyDocumentCatchUp.mockClear();
        adapter._applyServerStateToBridge(full);
        // Only the room state itself went in.
        expect(bridge.applyDocumentCatchUp).toHaveBeenCalledTimes(1);
        expect(adapter.unsentRowsAwaitingRoomState).toBe(0);
        adapter.disconnect();
    });

    test('a row that fits right away applies at restore', async () => {
        const { acknowledged, unsent } = twoEditsOfOneClient();
        const doc = new Y.Doc();
        Y.applyUpdate(doc, acknowledged);
        const { adapter, bridge } = adapterFor(doc, [
            walRow(DOC, 'tx-2', unsent)
        ]);
        await adapter._restorePersistentOutboxIntoBridge();
        expect(bridge.applyRemoteUpdate).toHaveBeenCalledTimes(1);
        expect(adapter.unsentRowsAwaitingRoomState).toBe(0);
        expect(doc.getMap('kerning').get('T o')).toBe(-60);
        adapter.disconnect();
    });

    test('a row that still does not fit on the complete room state is a real gap', async () => {
        const { unsent } = twoEditsOfOneClient();
        const doc = new Y.Doc();
        const { adapter, bridge } = adapterFor(doc, [
            walRow(DOC, 'tx-2', unsent)
        ]);
        await adapter._restorePersistentOutboxIntoBridge();
        // The room's complete state lacks the edit the row builds on.
        adapter.applyUnsentRowsAwaitingRoomState();
        expect(bridge.markDocumentBroken).toHaveBeenCalledWith(
            DOC,
            expect.any(ClockGapError)
        );
        adapter.disconnect();
    });
    test('a row waiting for the room state applies as soon as the document loads by any path', async () => {
        // A sparse hydrate (not this adapter's socket, not a catch-up) loads
        // the room's state: the waiting row applies right then.
        const { acknowledged, unsent } = twoEditsOfOneClient();
        const doc = new Y.Doc();
        const { adapter, bridge } = adapterFor(doc, [
            walRow(DOC, 'tx-2', unsent)
        ]);
        let loaded = null;
        bridge.onDocumentLoaded = jest.fn((listener) => {
            loaded = listener;
            return () => {
                loaded = null;
            };
        });
        adapter._registerOutboundHook();
        await adapter._restorePersistentOutboxIntoBridge();
        expect(adapter.unsentRowsAwaitingRoomState).toBe(1);

        Y.applyUpdate(doc, acknowledged);
        loaded(DOC);
        expect(adapter.unsentRowsAwaitingRoomState).toBe(0);
        expect(doc.getMap('kerning').get('T o')).toBe(-60);
        expect(bridge.markDocumentBroken).not.toHaveBeenCalled();
        adapter.disconnect();
        expect(loaded).toBeNull();
    });

    test('a load that lacks the state a waiting row builds on leaves it waiting, not broken', async () => {
        const { unsent } = twoEditsOfOneClient();
        const doc = new Y.Doc();
        const { adapter, bridge } = adapterFor(doc, [
            walRow(DOC, 'tx-2', unsent)
        ]);
        let loaded = null;
        bridge.onDocumentLoaded = (listener) => {
            loaded = listener;
            return () => {};
        };
        adapter._registerOutboundHook();
        await adapter._restorePersistentOutboxIntoBridge();
        loaded(DOC);
        expect(adapter.unsentRowsAwaitingRoomState).toBe(1);
        expect(bridge.markDocumentBroken).not.toHaveBeenCalled();
        adapter.disconnect();
    });

    test('while the session routes the document over HTTP the socket queues no local edit', () => {
        const doc = new Y.Doc();
        let routed = true;
        const adapter = new CloudAdapter({
            assetId: 'asset-1',
            documentId: DOC,
            wal: fakeWal([]),
            routesOutboundElsewhere: () => routed
        });
        const bridge = fakeBridge(doc);
        let local = null;
        bridge.onLocalUpdate = jest.fn((listener) => {
            local = listener;
        });
        adapter._bridge = bridge;
        adapter._registerOutboundHook();
        const edit = new Y.Doc();
        edit.getMap('kerning').set('A V', -10);
        local(Y.encodeStateAsUpdate(edit), envelope('tx-http'), [], DOC);
        expect(adapter._pendingOutboundPackets).toHaveLength(0);
        // The backlog is out: the next edit goes over the socket.
        routed = false;
        edit.getMap('kerning').set('T o', -20);
        local(Y.encodeStateAsUpdate(edit), envelope('tx-ws'), [], DOC);
        expect(adapter._pendingOutboundPackets).toHaveLength(1);
        expect(
            adapter._pendingOutboundPackets[0].clientTransactionId
        ).toContain('tx-ws');
        adapter.disconnect();
    });
});

describe('CloudLiveSession restores unsent HTTP rows after the glyph state', () => {
    const GLYPH = 'glyph:A';

    function sessionFor(doc, records) {
        const bridge = fakeBridge(doc, GLYPH);
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge,
            bootstrapMode: 'skip'
        });
        session._wal = fakeWal(records);
        session._walLoad = Promise.resolve();
        session._ensureWalLoaded = async () => {};
        session._pumpHttpPublishQueue = jest.fn();
        return { session, bridge };
    }

    test('a row that builds on the room state waits for the glyph’s catch-up, then applies', async () => {
        const { acknowledged, unsent } = twoEditsOfOneClient();
        const doc = new Y.Doc();
        const { session, bridge } = sessionFor(doc, [
            walRow(GLYPH, 'tx-2', unsent)
        ]);
        await session._replayPendingHttpWal({ includeLiveAdapters: true });
        expect(bridge.markDocumentBroken).not.toHaveBeenCalled();
        expect(session.walRowsAwaitingState().get(GLYPH)).toBe(1);
        // Sent all the same.
        expect(session._httpOutboxes.get(GLYPH).packets).toHaveLength(1);

        Y.applyUpdate(doc, acknowledged);
        session._applyWalRowsAwaitingState(GLYPH, {
            final: true,
            stage: 'catch-up'
        });
        expect(session.walRowsAwaitingState().size).toBe(0);
        expect(doc.getMap('kerning').get('T o')).toBe(-60);
        expect(bridge.markDocumentBroken).not.toHaveBeenCalled();
        session.disconnect();
    });

    test('after a complete catch-up a row that still does not fit is a real gap', async () => {
        const { unsent } = twoEditsOfOneClient();
        const doc = new Y.Doc();
        const { session } = sessionFor(doc, [walRow(GLYPH, 'tx-2', unsent)]);
        await session._replayPendingHttpWal({ includeLiveAdapters: true });
        expect(() =>
            session._applyWalRowsAwaitingState(GLYPH, {
                final: true,
                stage: 'catch-up'
            })
        ).toThrow(ClockGapError);
        session.disconnect();
    });

    test('a row replayed right after the barrier caught its glyph up is final: a gap is refused, the other glyphs replay on', async () => {
        const { unsent } = twoEditsOfOneClient();
        const other = new Y.Doc();
        other.clientID = 7;
        other.getMap('kerning').set('H H', 0);
        const doc = new Y.Doc();
        const { session, bridge } = sessionFor(doc, [
            walRow(GLYPH, 'tx-2', unsent),
            walRow('glyph:B', 'tx-3', Y.encodeStateAsUpdate(other))
        ]);
        const errorSpy = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        // The barrier just loaded glyph:A's complete room state.
        session._caughtUpForWalReplay = new Set([GLYPH]);
        await expect(
            session._replayPendingHttpWal({ includeLiveAdapters: true })
        ).resolves.toBeUndefined();
        // The gap went through the gate (the row was applied, refused).
        expect(bridge.applyRemoteUpdate).toHaveBeenCalledWith(
            unsent,
            undefined,
            expect.any(Array),
            GLYPH,
            { captureInUndo: false }
        );
        expect(errorSpy).toHaveBeenCalled();
        // Nothing dropped: both rows are still queued to send.
        expect(session._httpOutboxes.get(GLYPH).packets).toHaveLength(1);
        expect(session._httpOutboxes.get('glyph:B').packets).toHaveLength(1);
        errorSpy.mockRestore();
        session.disconnect();
    });

    test('outside a barrier catch-up the same row only waits', async () => {
        const { unsent } = twoEditsOfOneClient();
        const doc = new Y.Doc();
        const { session, bridge } = sessionFor(doc, [
            walRow(GLYPH, 'tx-2', unsent)
        ]);
        session._caughtUpForWalReplay = new Set(['glyph:Z']);
        await session._replayPendingHttpWal({ includeLiveAdapters: true });
        expect(bridge.applyRemoteUpdate).not.toHaveBeenCalled();
        expect(session.walRowsAwaitingState().get(GLYPH)).toBe(1);
        session.disconnect();
    });

    test('the ready barrier forgets the caught-up glyphs once its replay ran', async () => {
        const doc = new Y.Doc();
        const { session } = sessionFor(doc, []);
        let seenDuringReplay = null;
        session._waitForLiveTransportSynced = async () => {};
        session._catchUpLiveSubsetAndDeps = async () => {
            session._caughtUpForWalReplay.add(GLYPH);
        };
        session._replayPendingHttpWal = async () => {
            seenDuringReplay = new Set(session._caughtUpForWalReplay);
        };
        session.flushPendingHttpPublishes = async () => {};
        await session._completeSessionReadyBarrier();
        expect([...seenDuringReplay]).toEqual([GLYPH]);
        expect(session._caughtUpForWalReplay).toBeNull();
        session.disconnect();
    });
    function sessionWithLoadEvents(doc, records) {
        const bridge = fakeBridge(doc, GLYPH);
        let loaded = null;
        bridge.onDocumentLoaded = jest.fn((listener) => {
            loaded = listener;
            return () => {
                loaded = null;
            };
        });
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge,
            bootstrapMode: 'skip'
        });
        session._wal = fakeWal(records);
        session._walLoad = Promise.resolve();
        session._ensureWalLoaded = async () => {};
        session._pumpHttpPublishQueue = jest.fn();
        return { session, bridge, fireLoaded: (id) => loaded?.(id) };
    }

    test('a waiting row applies as soon as a sparse hydrate loads its glyph', async () => {
        const { acknowledged, unsent } = twoEditsOfOneClient();
        const doc = new Y.Doc();
        const { session, bridge, fireLoaded } = sessionWithLoadEvents(doc, [
            walRow(GLYPH, 'tx-2', unsent)
        ]);
        await session._replayPendingHttpWal({ includeLiveAdapters: true });
        expect(session.walRowsAwaitingState().get(GLYPH)).toBe(1);

        // The hydrate fills the glyph from the room, then the engine
        // announces the load.
        Y.applyUpdate(doc, acknowledged);
        fireLoaded(GLYPH);
        expect(session.walRowsAwaitingState().size).toBe(0);
        expect(doc.getMap('kerning').get('T o')).toBe(-60);
        expect(bridge.markDocumentBroken).not.toHaveBeenCalled();
        session.disconnect();
    });

    test('a load that predates the state a row builds on leaves it waiting, never broken', async () => {
        const { unsent } = twoEditsOfOneClient();
        const doc = new Y.Doc();
        const { session, bridge, fireLoaded } = sessionWithLoadEvents(doc, [
            walRow(GLYPH, 'tx-2', unsent)
        ]);
        await session._replayPendingHttpWal({ includeLiveAdapters: true });
        expect(() => fireLoaded(GLYPH)).not.toThrow();
        expect(session.walRowsAwaitingState().get(GLYPH)).toBe(1);
        expect(bridge.markDocumentBroken).not.toHaveBeenCalled();
        session.disconnect();
    });

    test('the session stops listening for loads when it disconnects', () => {
        const { session, bridge, fireLoaded } = sessionWithLoadEvents(
            new Y.Doc(),
            []
        );
        expect(bridge.onDocumentLoaded).toHaveBeenCalledTimes(1);
        session.disconnect();
        expect(() => fireLoaded(GLYPH)).not.toThrow();
    });
    test('while a glyph with a socket still has HTTP rows, its local and linked-window edits queue behind them in order', async () => {
        const doc = new Y.Doc();
        const { session, bridge } = sessionFor(doc, []);
        session._wal.append = jest.fn(async () => {});
        const adapter = {
            sendForwardedUpdate: jest.fn(),
            disconnect: jest.fn()
        };
        session._adapters.set(GLYPH, adapter);
        const backlog = new Y.Doc();
        backlog.getMap('kerning').set('A V', -40);
        session._queueHttpPacket(
            GLYPH,
            Y.encodeStateAsUpdate(backlog),
            envelope('tx-backlog'),
            walRow(GLYPH, 'tx-backlog', Y.encodeStateAsUpdate(backlog))
        );
        expect(session.routesOutboundOverHttp(GLYPH)).toBe(true);
        const local = bridge.onLocalUpdate.mock.calls[0][0];

        // The linked window's edit, then main's own edit that builds on it.
        session.sendForwardedUpdate(
            new Uint8Array([1]),
            envelope('tx-linked'),
            GLYPH
        );
        local(new Uint8Array([2]), envelope('tx-main'), [], GLYPH);
        await Promise.all([...session._httpEnqueueInFlight]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(adapter.sendForwardedUpdate).not.toHaveBeenCalled();
        expect(
            session._httpOutboxes
                .get(GLYPH)
                .packets.map((packet) => packet.clientTransactionId)
        ).toEqual([
            expect.stringContaining('tx-backlog'),
            expect.stringContaining('tx-linked'),
            expect.stringContaining('tx-main')
        ]);

        // The backlog is out: the socket takes over.
        session._httpOutboxes.delete(GLYPH);
        expect(session.routesOutboundOverHttp(GLYPH)).toBe(false);
        local(new Uint8Array([3]), envelope('tx-after'), [], GLYPH);
        expect(session._httpOutboxes.has(GLYPH)).toBe(false);
        session.sendForwardedUpdate(
            new Uint8Array([4]),
            envelope('tx-linked-2'),
            GLYPH
        );
        expect(adapter.sendForwardedUpdate).toHaveBeenCalledTimes(1);
        session.disconnect();
    });

    test('edits the socket still holds unacknowledged queue in the HTTP outbox before a newer edit routed there', async () => {
        const doc = new Y.Doc();
        const { session, bridge } = sessionFor(doc, []);
        session._wal.append = jest.fn(async () => {});
        // The replay built the backlog from written WAL rows; the socket
        // also holds tx-socket-older, whose row was still being written,
        // and tx-backlog, which the outbox already has.
        const adapter = {
            sendForwardedUpdate: jest.fn(),
            disconnect: jest.fn(),
            unacknowledgedOutboundPackets: jest.fn(() => [
                {
                    update: new Uint8Array([9]),
                    collaborationMessage: envelope('tx-backlog'),
                    clientTransactionId: 'tx-backlog'
                },
                {
                    update: new Uint8Array([8]),
                    collaborationMessage: envelope('tx-socket-older'),
                    clientTransactionId: 'tx-socket-older'
                }
            ])
        };
        session._adapters.set(GLYPH, adapter);
        const backlog = new Y.Doc();
        backlog.getMap('kerning').set('A V', -40);
        session._queueHttpPacket(
            GLYPH,
            Y.encodeStateAsUpdate(backlog),
            envelope('tx-backlog'),
            walRow(GLYPH, 'tx-backlog', Y.encodeStateAsUpdate(backlog))
        );
        const local = bridge.onLocalUpdate.mock.calls[0][0];

        local(new Uint8Array([2]), envelope('tx-main'), [], GLYPH);
        session.sendForwardedUpdate(
            new Uint8Array([1]),
            envelope('tx-linked'),
            GLYPH
        );
        await Promise.all([...session._httpEnqueueInFlight]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const ids = session._httpOutboxes
            .get(GLYPH)
            .packets.map((packet) => packet.clientTransactionId);
        expect(ids).toHaveLength(4);
        expect(ids[0]).toContain('tx-backlog');
        expect(ids[1]).toContain('tx-socket-older');
        expect(ids[2]).toContain('tx-main');
        expect(ids[3]).toContain('tx-linked');
        expect(adapter.sendForwardedUpdate).not.toHaveBeenCalled();
        session.disconnect();
    });
});
