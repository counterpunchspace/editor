const { webcrypto } = require('crypto');
const { TextDecoder, TextEncoder } = require('util');
Object.defineProperty(global, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true
});
global.TextDecoder = TextDecoder;
global.TextEncoder = TextEncoder;
if (typeof AbortSignal.timeout !== 'function') {
    AbortSignal.timeout = () => new AbortController().signal;
}

/**
 * A room state loaded at open or by a sparse hydrate names the log id it
 * holds every row through. Once the state is in the document, that log id
 * is the document's catch-up cursor, so a reconnect asks only for rows
 * after it instead of the whole log from zero.
 */
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const {
    rememberLoadedDocumentLogCursor,
    rememberLoadedDocumentLogCursors,
    loadedDocumentLogCursor,
    resetGlyphLogCursors
} = require('../js/cloud-adapter-support');
const {
    checkpointLogIdFromHeaders,
    fetchCloudDocumentStateWithLogId
} = require('../js/cloud-adapter-bootstrap');
const { CloudAdapter, catchUpCloudDocument } = require('../js/cloud-adapter');
const { CloudLiveSession } = require('../js/cloud-live-session');
const {
    glyphDocumentId
} = require('../js/filesystem-plugins/cloud-document-set');
const {
    encodePackBody,
    encodePackFrame,
    encodePackShardFrame,
    PACK_FRAME_TYPE
} = require('../js/generated/collab-protocol-pack');

/** A receipt frame; the payload is built here so jsdom keeps its bytes. */
function encodeReceiptFrame(receipt) {
    const json = JSON.stringify(receipt);
    return encodePackFrame({
        type: PACK_FRAME_TYPE.RECEIPT,
        shardId: receipt.shardId,
        payload: Uint8Array.from(json, (ch) => ch.charCodeAt(0))
    });
}

function makeFont() {
    return {
        upm: 1000,
        names: { familyName: 'Cursor' },
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

const DOCUMENT_ID = glyphDocumentId('id-b');

function makeWriterAndReceiver() {
    const writer = new PatchSyncEngine('writer');
    writer.initFromJson(makeFont());
    const receiver = new PatchSyncEngine('receiver');
    receiver.setFontJson(
        JSON.parse(JSON.stringify(writer.getFontJsonSnapshot()))
    );
    receiver.applyDocumentSetState(writer.encodeDocumentSet());
    window.changeBridge = writer;
    return { writer, receiver };
}

function arrayBufferOf(bytes) {
    return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
    );
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

/** `/live` answer with no rows after the cursor: only the terminal frame. */
function emptyTailResponse(logId) {
    const body = encodeCollabFrame(3, logId, new Uint8Array());
    return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        arrayBuffer: async () => arrayBufferOf(body)
    };
}

function packResponse(frames) {
    const body = encodePackBody(frames);
    let sent = false;
    return {
        ok: true,
        status: 200,
        headers: new Headers({
            'content-type': 'application/vnd.counterpunch.shard-pack'
        }),
        body: {
            getReader() {
                return {
                    read: async () => {
                        if (sent) {
                            return { done: true, value: undefined };
                        }
                        sent = true;
                        return { done: false, value: body };
                    },
                    releaseLock() {}
                };
            }
        }
    };
}

function catchUp(receiver) {
    return catchUpCloudDocument({
        bridge: receiver,
        token: 'token',
        roomUrl: 'wss://rooms.example/room/asset-1',
        websiteBaseUrl: 'https://editor.example',
        assetId: 'asset-1',
        documentId: DOCUMENT_ID,
        maxAttempts: 1,
        wait: async () => {}
    });
}

function makeHydrator() {
    return new CloudAdapter({
        assetId: 'asset-1',
        websiteBaseUrl: 'https://editor.example'
    });
}

describe('catch-up cursor from a loaded room state', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
        resetGlyphLogCursors();
        window.__collabTrace = { enabled: true, entries: [] };
    });

    afterEach(() => {
        global.fetch = originalFetch;
        delete window.__collabTrace;
    });

    test('a glyph hydrated per shard asks for rows after its state’s log id', async () => {
        const { writer, receiver } = makeWriterAndReceiver();
        const state = writer.encodeDocumentState(DOCUMENT_ID);
        const urls = [];
        global.fetch = jest.fn(async (input) => {
            const url = String(input);
            urls.push(url);
            if (url.includes('/live')) {
                return emptyTailResponse(
                    Number(new URL(url).searchParams.get('afterLogId'))
                );
            }
            return {
                ok: true,
                status: 200,
                headers: new Headers({ 'X-Checkpoint-Log-Id': '42' }),
                arrayBuffer: async () => arrayBufferOf(state)
            };
        });
        const hydrator = makeHydrator();
        const loaded = await hydrator.hydrateDocumentSet(
            'token',
            'wss://rooms.example/room/asset-1',
            [DOCUMENT_ID],
            { transport: 'per-shard' }
        );
        expect(hydrator.hydratedLogId(DOCUMENT_ID)).toBe(42);
        receiver.applyDocumentCatchUp(DOCUMENT_ID, loaded.get(DOCUMENT_ID));
        rememberLoadedDocumentLogCursor(
            receiver,
            DOCUMENT_ID,
            hydrator.hydratedLogId(DOCUMENT_ID),
            'sparse-hydrate'
        );
        hydrator.disconnect();

        urls.length = 0;
        expect(await catchUp(receiver)).toBe(true);
        expect(urls).toHaveLength(1);
        expect(new URL(urls[0]).searchParams.get('afterLogId')).toBe('42');
    });

    test('a pack receipt naming the shard’s log id sets the cursor', async () => {
        const { writer, receiver } = makeWriterAndReceiver();
        const state = writer.encodeDocumentState(DOCUMENT_ID);
        global.fetch = jest.fn(async () =>
            packResponse([
                encodePackShardFrame(DOCUMENT_ID, state),
                encodeReceiptFrame({
                    shardId: DOCUMENT_ID,
                    throughLogId: 17
                })
            ])
        );
        const hydrator = makeHydrator();
        const loaded = await hydrator.hydrateDocumentSet(
            'token',
            'wss://rooms.example/room/asset-1',
            [DOCUMENT_ID]
        );
        expect(loaded.get(DOCUMENT_ID)?.byteLength).toBe(state.byteLength);
        expect(hydrator.hydratedLogId(DOCUMENT_ID)).toBe(17);
        rememberLoadedDocumentLogCursor(
            receiver,
            DOCUMENT_ID,
            hydrator.hydratedLogId(DOCUMENT_ID),
            'open-hydrate'
        );
        expect(loadedDocumentLogCursor(receiver, DOCUMENT_ID)).toBe(17);
        hydrator.disconnect();
    });

    test('a pack without a log id leaves the cursor at 0 and traces the path', async () => {
        const { writer, receiver } = makeWriterAndReceiver();
        const state = writer.encodeDocumentState(DOCUMENT_ID);
        const urls = [];
        global.fetch = jest.fn(async (input) => {
            const url = String(input);
            urls.push(url);
            if (url.includes('/live')) {
                return emptyTailResponse(5);
            }
            return packResponse([encodePackShardFrame(DOCUMENT_ID, state)]);
        });
        const hydrator = makeHydrator();
        await hydrator.hydrateDocumentSet(
            'token',
            'wss://rooms.example/room/asset-1',
            [DOCUMENT_ID]
        );
        expect(hydrator.hydratedLogId(DOCUMENT_ID)).toBeNull();
        rememberLoadedDocumentLogCursors(
            receiver,
            [[DOCUMENT_ID, hydrator.hydratedLogId(DOCUMENT_ID)]],
            'open-hydrate'
        );
        hydrator.disconnect();
        expect(loadedDocumentLogCursor(receiver, DOCUMENT_ID)).toBe(0);
        const traced = window.__collabTrace.entries.filter(
            (entry) => entry.kind === 'log-cursor-unknown'
        );
        expect(traced).toHaveLength(1);
        expect(traced[0].detail).toMatchObject({
            path: 'open-hydrate',
            count: 1,
            documents: [DOCUMENT_ID]
        });
        urls.length = 0;
        await catchUp(receiver);
        expect(new URL(urls[0]).searchParams.get('afterLogId')).toBe('0');
    });

    test('a later load without a log id drops the earlier one', async () => {
        const { writer } = makeWriterAndReceiver();
        const state = writer.encodeDocumentState(DOCUMENT_ID);
        let header = '9';
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            headers: new Headers(
                header ? { 'X-Checkpoint-Log-Id': header } : {}
            ),
            arrayBuffer: async () => arrayBufferOf(state)
        }));
        const hydrator = makeHydrator();
        const load = () =>
            hydrator.hydrateDocumentSet(
                'token',
                'wss://rooms.example/room/asset-1',
                [DOCUMENT_ID],
                { transport: 'per-shard' }
            );
        await load();
        expect(hydrator.hydratedLogId(DOCUMENT_ID)).toBe(9);
        header = '';
        await load();
        expect(hydrator.hydratedLogId(DOCUMENT_ID)).toBeNull();
        hydrator.disconnect();
    });

    test('the cursor belongs to the document instance it was recorded on', () => {
        const { receiver } = makeWriterAndReceiver();
        rememberLoadedDocumentLogCursor(
            receiver,
            DOCUMENT_ID,
            30,
            'open-hydrate'
        );
        expect(loadedDocumentLogCursor(receiver, DOCUMENT_ID)).toBe(30);
        // A lower log id from a later load never moves it back.
        rememberLoadedDocumentLogCursor(
            receiver,
            DOCUMENT_ID,
            12,
            'open-hydrate'
        );
        expect(loadedDocumentLogCursor(receiver, DOCUMENT_ID)).toBe(30);
        const other = makeWriterAndReceiver().receiver;
        expect(loadedDocumentLogCursor(other, DOCUMENT_ID)).toBe(0);
    });

    test('the state fetch returns the log id its header names, or null', async () => {
        expect(
            checkpointLogIdFromHeaders(
                new Headers({ 'X-Checkpoint-Log-Id': '128' })
            )
        ).toBe(128);
        expect(checkpointLogIdFromHeaders(new Headers())).toBeNull();
        expect(
            checkpointLogIdFromHeaders(
                new Headers({ 'X-Checkpoint-Log-Id': 'abc' })
            )
        ).toBeNull();
        const state = new Uint8Array([1, 2, 3, 4]);
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            headers: new Headers({ 'X-Checkpoint-Log-Id': '7' }),
            arrayBuffer: async () => arrayBufferOf(state)
        }));
        const loaded = await fetchCloudDocumentStateWithLogId({
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            websiteBaseUrl: 'https://editor.example',
            assetId: 'asset-1',
            documentId: 'features'
        });
        expect(loaded?.logId).toBe(7);
        expect([...(loaded?.bytes ?? [])]).toEqual([1, 2, 3, 4]);
    });

    test('a joined layout room state the bridge refused moves no cursor', async () => {
        const instance = {};
        const bridge = {
            getDocumentInstance: () => instance,
            applyDocumentCatchUp: jest.fn(() => false)
        };
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            headers: new Headers({ 'X-Checkpoint-Log-Id': '25' }),
            arrayBuffer: async () => arrayBufferOf(new Uint8Array([1, 2, 3, 4]))
        }));
        const session = {
            _token: 'token',
            _roomUrl: 'wss://rooms.example/room/asset-1',
            _options: {
                bridge,
                websiteBaseUrl: 'https://editor.example',
                assetId: 'asset-1'
            },
            _adapters: new Map()
        };
        await CloudLiveSession.prototype._catchUpDocumentsOverHttp.call(
            session,
            ['features']
        );
        expect(bridge.applyDocumentCatchUp).toHaveBeenCalledTimes(1);
        expect(loadedDocumentLogCursor(bridge, 'features')).toBe(0);
        // The same state applied moves it to the state's log id.
        bridge.applyDocumentCatchUp.mockReturnValue(true);
        await CloudLiveSession.prototype._catchUpDocumentsOverHttp.call(
            session,
            ['features']
        );
        expect(loadedDocumentLogCursor(bridge, 'features')).toBe(25);
    });

    test('a socket bootstrap state the bridge refused moves no cursor', async () => {
        const instance = {};
        const adapter = new CloudAdapter({
            assetId: 'asset-1',
            documentId: DOCUMENT_ID
        });
        adapter._documentId = DOCUMENT_ID;
        const bridge = {
            getDocumentInstance: () => instance,
            applyDocumentCatchUp: jest.fn(() => false)
        };
        adapter._bridge = bridge;
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            headers: new Headers({ 'X-Checkpoint-Log-Id': '31' }),
            arrayBuffer: async () => arrayBufferOf(new Uint8Array([1, 2, 3]))
        }));
        const roomUrl = 'wss://rooms.example/room/asset-1/shards/glyph/id-b';
        await adapter._bootstrapFromR2('token', roomUrl);
        expect(bridge.applyDocumentCatchUp).toHaveBeenCalled();
        expect(loadedDocumentLogCursor(bridge, DOCUMENT_ID)).toBe(0);
        bridge.applyDocumentCatchUp.mockReturnValue(true);
        await adapter._bootstrapFromR2('token', roomUrl);
        expect(loadedDocumentLogCursor(bridge, DOCUMENT_ID)).toBe(31);
        adapter.disconnect();
    });
});
