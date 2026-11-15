// A font opened from the pack holds each room's checkpoint as stored. Its
// sockets tell the room the checkpoint's sha256, so a compacted room replays
// only the tail instead of asking for a rebaseline (a reconnect and the
// checkpoint again).

const Y = require('yjs');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const { CloudAdapter } = require('../js/cloud-adapter');

function featuresRoomShard() {
    const doc = new Y.Doc();
    doc.getMap('font').set('features', { classes: {}, features: [] });
    return Y.encodeStateAsUpdate(doc);
}

test('the engine knows which checkpoint a loaded document came from, only while it holds it', () => {
    const engine = new PatchSyncEngine('claim');
    engine.initFromJson({});
    const sha = 'c'.repeat(64);
    engine.applyDocumentSetState([
        {
            documentId: 'font-deps',
            bytes: featuresRoomShard(),
            checkpointSha256: sha
        }
    ]);
    expect(engine.documentCheckpointSha256('font-deps')).toBe(sha);
    // A document made again (a new font) claims nothing.
    engine.initFromJson({});
    expect(engine.documentCheckpointSha256('font-deps')).toBeNull();
    // A value that is not a sha256 is not a claim.
    engine.applyDocumentSetState([
        {
            documentId: 'font-deps',
            bytes: featuresRoomShard(),
            checkpointSha256: 'nope'
        }
    ]);
    expect(engine.documentCheckpointSha256('font-deps')).toBeNull();
});

test('a fresh socket tells the room which checkpoint its document holds', () => {
    const sha = 'd'.repeat(64);
    const adapter = new CloudAdapter({
        assetId: 'asset-1',
        documentId: 'kerning:0'
    });
    const ws = { readyState: 1, send: jest.fn() };
    adapter._ws = ws;
    adapter._bridge = {
        documentCheckpointSha256: (documentId) =>
            documentId === 'kerning:0' ? sha : null
    };
    adapter._sendInitialSyncRequest(ws);
    const request = JSON.parse(ws.send.mock.calls[0][0]);
    expect(request).toMatchObject({
        type: 'sync-request',
        appliedLogId: 0,
        checkpointSha256: sha
    });
});
