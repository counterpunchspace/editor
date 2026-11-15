// The reconnect barrier waits for the layout rooms' sockets, then used to
// download every layout room's /state again. For these rooms /state is the
// checkpoint alone, which a synced socket already has; only rooms without a
// synced socket are loaded over HTTP now.

jest.mock('../js/cloud-adapter', () => {
    const actual = jest.requireActual('../js/cloud-adapter');
    return { ...actual, catchUpCloudDocument: jest.fn(async () => true) };
});

const { CloudLiveSession } = require('../js/cloud-live-session');

test('reconnect catch-up loads only layout rooms whose socket is not synced', async () => {
    const session = new CloudLiveSession({
        assetId: 'asset-1',
        websiteBaseUrl: 'https://editor.example',
        token: 'token',
        roomUrl: 'wss://rooms.example/room/asset-1',
        bridge: {
            layoutDocumentIds: () => ['features', 'kerning:0', 'kerning:1'],
            retiredLayoutDocumentIds: () => ['kerning:9'],
            listGlyphRevisionTokens: () => []
        },
        bootstrapMode: 'skip'
    });
    const adapter = (synced) => ({ isTransportSynced: () => synced });
    session._adapters.set('features', adapter(true));
    session._adapters.set('kerning:0', adapter(true));
    session._adapters.set('kerning:1', adapter(false));
    session._adapters.set('kerning:9', adapter(true));
    const loaded = [];
    session._catchUpDocumentsOverHttp = jest.fn(async (ids) => {
        loaded.push(...ids);
    });
    session.catchUpDocuments = jest.fn(async () => {});
    await session._catchUpLiveSubsetAndDeps();
    expect(loaded).toEqual(['kerning:1']);
});
