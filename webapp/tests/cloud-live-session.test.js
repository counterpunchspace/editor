jest.mock('../js/logger', () => ({
    Logger: class {
        log() {}
        warn() {}
        error() {}
    }
}));

const mockConnectDirect = jest.fn().mockResolvedValue();
const mockDisconnect = jest.fn();

jest.mock('../js/cloud-adapter', () => {
    const actual = jest.requireActual('../js/cloud-adapter');
    return {
        ...actual,
        CloudAdapter: jest.fn().mockImplementation((options = {}) => {
            const adapter = {
                documentId: options.documentId || 'font-core',
                pendingSyncCount: 0,
                status: 'disconnected',
                needsVisibleRebaseline: false,
                isTransportSynced: jest.fn(
                    () => adapter.status === 'connected'
                ),
                clearVisibleRebaselineNeeded: jest.fn(() => {
                    adapter.needsVisibleRebaseline = false;
                }),
                connectDirect: jest.fn(async (...args) => {
                    mockConnectDirect(...args, options);
                    adapter.status = 'connected';
                    options.onConnectionStatus?.('connected');
                }),
                disconnect: jest.fn(() => {
                    mockDisconnect();
                    adapter.status = 'disconnected';
                }),
                sendForwardedUpdate: jest.fn(),
                getConnectionHealth: jest.fn(() => null)
            };
            return adapter;
        })
    };
});

const {
    CloudLiveSession,
    liveGlyphDocumentIdsFromSubset
} = require('../js/cloud-live-session.ts');
const { CloudAdapter } = require('../js/cloud-adapter.ts');

describe('CloudLiveSession', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
        mockConnectDirect.mockClear();
        mockDisconnect.mockClear();
        CloudAdapter.mockClear();
        global.fetch = jest.fn(async () => ({
            ok: false,
            status: 404,
            headers: new Headers({
                'content-type': 'application/json'
            }),
            json: async () => ({})
        }));
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    test('liveGlyphDocumentIdsFromSubset maps names through the live bridge', () => {
        const bridge = {
            glyphDocumentIdForName: (name) =>
                name === 'A' ? 'glyph:aaa' : name === 'B' ? 'glyph:bbb' : null
        };
        expect(
            liveGlyphDocumentIdsFromSubset(bridge, ['A', 'B', 'A', 'Z'])
        ).toEqual(['glyph:aaa', 'glyph:bbb']);
        expect(liveGlyphDocumentIdsFromSubset(bridge, [])).toEqual([]);
        expect(
            liveGlyphDocumentIdsFromSubset(
                {
                    glyphDocumentIdForName: () => null,
                    listLiveGlyphDocumentIds: () => ['glyph:hydrated-a']
                },
                ['a']
            )
        ).toEqual(['glyph:hydrated-a']);
    });

    test('connects font-core plus subset glyph rooms only', async () => {
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip'
        });

        await session.syncLiveDocumentIds(['glyph:aaa', 'glyph:bbb']);

        const documentIds = CloudAdapter.mock.calls.map(
            ([options]) => options.documentId
        );
        expect(documentIds.sort()).toEqual(
            ['font-core', 'glyph:aaa', 'glyph:bbb'].sort()
        );
        expect(mockConnectDirect.mock.calls.length).toBe(3);
        expect(
            CloudAdapter.mock.calls.every(
                ([options]) => options.deferVisibleRebaseline === true
            )
        ).toBe(true);
        expect(
            mockConnectDirect.mock.calls
                .map((call) => call[3]?.bootstrapMode)
                .sort()
        ).toEqual(['skip', 'skip', 'skip']);

        await session.syncLiveDocumentIds(['glyph:aaa']);
        expect(session.liveDocumentIds().sort()).toEqual(
            ['font-core', 'glyph:aaa'].sort()
        );
        expect(mockDisconnect).toHaveBeenCalledTimes(1);

        session.sendForwardedUpdate(new Uint8Array([1]), null, 'glyph:aaa');
        const glyphAdapter = [...session._adapters.values()].find(
            (adapter) => adapter.documentId === 'glyph:aaa'
        );
        expect(glyphAdapter.sendForwardedUpdate).toHaveBeenCalledTimes(1);
    });

    test('does not open glyph rooms when the subset has no document ids', async () => {
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip'
        });
        await session.syncLiveDocumentIds([]);
        expect(session.liveDocumentIds()).toEqual(['font-core']);
        expect(mockConnectDirect).toHaveBeenCalledTimes(1);
    });

    test('catch-up fetches live glyph bytes without opening a sticky glyph room', async () => {
        const applyDocumentCatchUp = jest.fn().mockReturnValue(true);
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: { applyDocumentCatchUp },
            bootstrapMode: 'skip'
        });
        await session.syncLiveDocumentIds(['glyph:aaa']);
        const connectCount = mockConnectDirect.mock.calls.length;
        applyDocumentCatchUp.mockClear();
        global.fetch = jest.fn(async (url) => {
            expect(String(url)).toContain('/shards/glyph/bbb/live');
            return {
                ok: true,
                status: 200,
                headers: new Headers({
                    'content-type': 'application/json'
                }),
                json: async () => ({
                    update: Buffer.from([1, 2, 3]).toString('base64'),
                    collaborationMessageHistory: []
                })
            };
        });
        await session.catchUpDocuments(['glyph:aaa', 'glyph:bbb']);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(applyDocumentCatchUp).toHaveBeenCalledTimes(1);
        expect(applyDocumentCatchUp.mock.calls[0][0]).toBe('glyph:bbb');
        expect(mockConnectDirect).toHaveBeenCalledTimes(connectCount);
        expect(session.hasLiveDocument('glyph:aaa')).toBe(true);
        expect(session.hasLiveDocument('glyph:bbb')).toBe(false);
    });

    test('catch-up caps parallel live reads', async () => {
        const applyDocumentCatchUp = jest.fn().mockReturnValue(true);
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: { applyDocumentCatchUp },
            bootstrapMode: 'skip'
        });
        await session.syncLiveDocumentIds([]);
        applyDocumentCatchUp.mockClear();
        let inflight = 0;
        let maxInflight = 0;
        global.fetch = jest.fn(async () => {
            inflight += 1;
            maxInflight = Math.max(maxInflight, inflight);
            await new Promise((resolve) => {
                setTimeout(resolve, 40);
            });
            inflight -= 1;
            return {
                ok: true,
                status: 200,
                headers: new Headers({
                    'content-type': 'application/json'
                }),
                json: async () => ({
                    update: Buffer.from([1, 2, 3]).toString('base64')
                })
            };
        });
        await session.catchUpDocuments([
            'glyph:1',
            'glyph:2',
            'glyph:3',
            'glyph:4',
            'glyph:5'
        ]);
        expect(applyDocumentCatchUp).toHaveBeenCalledTimes(5);
        expect(maxInflight).toBeLessThanOrEqual(4);
        expect(maxInflight).toBe(4);
    }, 15000);

    test('reconnect barrier HTTP-catches live glyphs and deps before connected', async () => {
        const statuses = [];
        const applyDocumentCatchUp = jest.fn().mockReturnValue(true);
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: { applyDocumentCatchUp },
            onConnectionStatus: (status) => statuses.push(status),
            bootstrapMode: 'skip'
        });
        await session.syncLiveDocumentIds(['glyph:aaa']);
        const fetched = global.fetch.mock.calls.map(([url]) => String(url));
        expect(
            fetched.some((url) => url.includes('/shards/glyph/aaa/live'))
        ).toBe(true);
        expect(
            fetched.some((url) => url.includes('/shards/font-deps/live'))
        ).toBe(true);
        expect(statuses.at(-1)).toBe('connected');
    });

    test('includeLiveDocuments catch-up fetches glyphs that already have a socket', async () => {
        const applyDocumentCatchUp = jest.fn().mockReturnValue(true);
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: { applyDocumentCatchUp },
            bootstrapMode: 'skip'
        });
        await session.syncLiveDocumentIds(['glyph:aaa']);
        applyDocumentCatchUp.mockClear();
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            headers: new Headers({
                'content-type': 'application/json'
            }),
            json: async () => ({
                update: Buffer.from([9, 9]).toString('base64')
            })
        }));
        await session.catchUpDocuments(['glyph:aaa'], {
            includeLiveDocuments: true
        });
        expect(applyDocumentCatchUp).toHaveBeenCalledTimes(1);
        expect(applyDocumentCatchUp.mock.calls[0][0]).toBe('glyph:aaa');
    });
});
