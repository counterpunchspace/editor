// The room answers a client close by echoing its code with the reason
// “closed”, so every close this client asks for records its own reason in
// the permanent `socket-close-requested` trace event, before the close.

const { webcrypto } = require('crypto');
const { TextDecoder, TextEncoder } = require('util');
Object.defineProperty(global, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true
});
global.TextDecoder = TextDecoder;
global.TextEncoder = TextEncoder;

const { CloudAdapter } = require('../js/cloud-adapter.ts');

function fakeSocket() {
    return { readyState: 1, send: jest.fn(), close: jest.fn() };
}

function requested() {
    return window.__collabTrace.entries.filter(
        (entry) => entry.kind === 'socket-close-requested'
    );
}

describe('socket-close-requested', () => {
    beforeEach(() => {
        window.__collabTrace = { enabled: true, entries: [] };
    });
    afterEach(() => {
        delete window.__collabTrace;
    });

    test('a rebaseline close records its reason, before the close, on a socket that had not synced', () => {
        const adapter = new CloudAdapter({
            assetId: 'asset-1',
            documentId: 'glyph:q'
        });
        const ws = fakeSocket();
        ws.close.mockImplementation(() => {
            // The trace is written before the socket is asked to close.
            expect(requested()).toHaveLength(1);
        });
        adapter._ws = ws;
        adapter._handleMessage(
            JSON.stringify({
                type: 'rebaseline-required',
                currentCheckpointLogId: 7
            })
        );
        expect(ws.close).toHaveBeenCalledWith(4000, 'rebaseline-required');
        expect(requested()[0].detail).toEqual({
            document: 'glyph:q',
            reason: 'rebaseline-required',
            code: 4000,
            synced: false,
            current: true,
            appliedLogId: null
        });
    });

    test('a liveness close detaches the socket first and still says it had synced', () => {
        const adapter = new CloudAdapter({
            assetId: 'asset-1',
            documentId: 'glyph:q'
        });
        const ws = fakeSocket();
        adapter._ws = ws;
        adapter._syncedSockets.add(ws);
        adapter._appliedLogId = 12;
        adapter._lastInboundMessageAt = 1;
        adapter._scheduleReconnect = jest.fn();
        adapter._checkLiveness();
        expect(ws.close).toHaveBeenCalledWith(4000, 'liveness-timeout');
        expect(requested()[0].detail).toMatchObject({
            document: 'glyph:q',
            reason: 'liveness-timeout',
            code: 4000,
            synced: true,
            current: false,
            appliedLogId: 12
        });
    });

    test('a document held until loaded asks for its full load with its own reason', () => {
        const adapter = new CloudAdapter({
            assetId: 'asset-1',
            documentId: 'glyph:q'
        });
        const ws = fakeSocket();
        adapter._ws = ws;
        adapter._holdUntilLoaded([{ update: new Uint8Array([1]) }]);
        expect(ws.close).toHaveBeenCalledWith(4000, 'document-not-loaded');
        expect(requested().map((entry) => entry.detail.reason)).toEqual([
            'document-not-loaded'
        ]);
    });

    test('disconnect records its close too', () => {
        const adapter = new CloudAdapter({
            assetId: 'asset-1',
            documentId: 'glyph:q'
        });
        const ws = fakeSocket();
        adapter._ws = ws;
        adapter.disconnect();
        expect(ws.close).toHaveBeenCalledWith(1000, 'disconnect');
        expect(requested()[0].detail).toMatchObject({
            reason: 'disconnect',
            code: 1000
        });
    });

    test('no socket, no trace', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-1' });
        adapter._requestSocketClose(null, 4000, 'server-busy');
        expect(requested()).toHaveLength(0);
    });
    test('a connect that supersedes an open socket closes the older one with its reason', async () => {
        const created = [];
        const previous = global.WebSocket;
        global.WebSocket = jest.fn(function () {
            const socket = fakeSocket();
            created.push(socket);
            return socket;
        });
        try {
            const adapter = new CloudAdapter({
                assetId: 'asset-1',
                documentId: 'glyph:q'
            });
            const older = fakeSocket();
            adapter._ws = older;
            await adapter._openWebSocket('token', 'wss://rooms.example/room');
            expect(adapter._ws).toBe(created[0]);
            expect(older.close).toHaveBeenCalledWith(4000, 'superseded-socket');
            expect(requested()[0].detail).toMatchObject({
                document: 'glyph:q',
                reason: 'superseded-socket',
                code: 4000,
                current: false
            });
        } finally {
            global.WebSocket = previous;
        }
    });
});
