// An undo or redo that failed part way had its entry taken back in the
// window that made it. Its entry may already be in the other windows, so
// they are told to take it back too, after the packets sent before it.

const { WindowSync } = require('../js/window-sync');

const ROLE = {
    sessionId: 'test',
    isMainWindow: () => true,
    isLinkedWindow: () => false
};

function makeBridge(windowId, extra = {}) {
    return {
        windowId,
        onLocalUpdate: () => {},
        getChangeLog: () => [],
        getCollaborationLog: () => [],
        listLiveGlyphDocumentIds: () => [],
        ...extra
    };
}

function takeBackMessage(takeBack, windowId = 'other') {
    return {
        type: 'history-entry-taken-back',
        takeBack,
        windowId,
        sessionId: 'test'
    };
}

const TAKE_BACK = {
    historyAction: 'undo',
    targetHistoryItemId: 'item-1',
    entryHistoryItemId: 'entry-1',
    windowId: 'other'
};

describe('history entries taken back across windows', () => {
    const previousRole = window.windowRole;
    let syncs = [];

    function makeSync(bridge) {
        const sync = new WindowSync(bridge, `take-back-${syncs.length}`);
        syncs.push(sync);
        return sync;
    }

    beforeEach(() => {
        window.windowRole = ROLE;
        window.__collabTrace = { enabled: true, entries: [] };
    });
    afterEach(() => {
        for (const sync of syncs) sync.destroy();
        syncs = [];
        window.windowRole = previousRole;
        delete window.__collabTrace;
    });

    const traced = (kind) =>
        window.__collabTrace.entries.filter((entry) => entry.kind === kind);

    test('a failed replay is announced after the packets queued before it', () => {
        const sync = makeSync(makeBridge('main'));
        const sent = [];
        sync._send = (msg) => {
            sent.push(msg.type);
            return true;
        };
        sync._queueOutboundBroadcast(new Uint8Array([1]), null, 'glyph:a');
        window.dispatchEvent(
            new CustomEvent('history-replay-failed', {
                detail: {
                    historyAction: 'undo',
                    historyItemId: 'item-1',
                    reason: 'boom',
                    documentIdsNotRolledBack: [],
                    takenBackHistoryItemId: 'entry-1'
                }
            })
        );
        expect(sent).toEqual(['yjs-update', 'history-entry-taken-back']);
        expect(traced('history-take-back-sent')[0].detail).toMatchObject({
            historyAction: 'undo',
            targetHistoryItemId: 'item-1',
            entryHistoryItemId: 'entry-1',
            windowId: 'main',
            sent: true
        });
    });

    test('an event without its history item is not sent, and says so', () => {
        const sync = makeSync(makeBridge('main'));
        sync._send = jest.fn(() => true);
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        window.dispatchEvent(
            new CustomEvent('history-replay-failed', { detail: {} })
        );
        expect(sync._send).not.toHaveBeenCalled();
        expect(traced('history-take-back-unsent')).toHaveLength(1);
        error.mockRestore();
    });

    test('a receiving window takes the entry back through the engine', () => {
        const takeBackHistoryEntry = jest.fn(() => true);
        const sync = makeSync(makeBridge('linked', { takeBackHistoryEntry }));
        sync._handleMessage(takeBackMessage(TAKE_BACK));
        expect(takeBackHistoryEntry).toHaveBeenCalledWith(TAKE_BACK);
        expect(traced('history-entry-taken-back')).toHaveLength(1);
    });

    test('the take-back waits for inbound packets that arrived before it', () => {
        const order = [];
        const takeBackHistoryEntry = jest.fn(() => {
            order.push('take-back');
            return true;
        });
        const sync = makeSync(makeBridge('linked', { takeBackHistoryEntry }));
        sync._applyInboundYjsMessages = () => order.push('packets');
        sync._queueYjsUpdate({
            type: 'yjs-update',
            updates: [{ update: new Uint8Array([1]), documentId: 'glyph:a' }],
            windowId: 'other',
            sessionId: 'test'
        });
        sync._handleMessage(takeBackMessage(TAKE_BACK));
        expect(takeBackHistoryEntry).not.toHaveBeenCalled();
        sync._flushPendingYjsUpdates();
        expect(order).toEqual(['packets', 'take-back']);
    });

    test('an entry this window never got is noted, not invented', () => {
        const takeBackHistoryEntry = jest.fn(() => false);
        const sync = makeSync(makeBridge('linked', { takeBackHistoryEntry }));
        sync._handleMessage(takeBackMessage(TAKE_BACK));
        expect(traced('history-take-back-unmatched')).toHaveLength(1);
        expect(sync._pendingHistoryTakeBacks).toEqual([]);
    });

    test('an engine without the hook leaves a trace and an error', () => {
        const sync = makeSync(makeBridge('linked'));
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        sync._handleMessage(takeBackMessage(TAKE_BACK));
        expect(traced('history-take-back-unsupported')).toHaveLength(1);
        expect(error).toHaveBeenCalled();
        error.mockRestore();
    });

    test('its own announcement and malformed ones are ignored', () => {
        const takeBackHistoryEntry = jest.fn(() => true);
        const sync = makeSync(makeBridge('linked', { takeBackHistoryEntry }));
        sync._handleMessage(takeBackMessage(TAKE_BACK, 'linked'));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        sync._handleMessage(
            takeBackMessage({ ...TAKE_BACK, historyAction: 'change' })
        );
        warn.mockRestore();
        expect(takeBackHistoryEntry).not.toHaveBeenCalled();
    });
    test('a take-back that arrived during a bootstrap runs once it ends, with no packets left', async () => {
        const takeBackHistoryEntry = jest.fn(() => true);
        const sync = makeSync(makeBridge('linked', { takeBackHistoryEntry }));
        sync._fullStateBootstrapResolve = () => {};
        sync._fullStateBootstrapReject = () => {};
        sync._handleMessage(takeBackMessage(TAKE_BACK));
        expect(takeBackHistoryEntry).not.toHaveBeenCalled();
        sync._resolveFullStateBootstrap(null);
        await Promise.resolve();
        expect(takeBackHistoryEntry).toHaveBeenCalledWith(TAKE_BACK);
        expect(sync._pendingHistoryTakeBacks).toEqual([]);
    });
});
