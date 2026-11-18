// A held burst's outbox row is written without sending anything, and the
// burst's earlier row is replaced.

const { CloudLiveSession } = require('../js/cloud-live-session');

function session() {
    const live = new CloudLiveSession({
        assetId: 'asset-1',
        websiteBaseUrl: 'https://editor.example',
        token: 'token',
        roomUrl: 'wss://rooms.example/room/asset-1',
        bridge: {},
        bootstrapMode: 'skip'
    });
    const rows = new Map();
    live._wal = {
        isLoaded: true,
        recordsFor: () => [...rows.values()],
        append: jest.fn(async (record) => {
            rows.set(record.clientTransactionId, record);
        }),
        acknowledgeMany: jest.fn(async (_asset, _doc, ids) => {
            for (const id of ids) rows.delete(id);
        }),
        holdStaged: jest.fn(),
        releaseStaged: jest.fn()
    };
    live._walLoad = Promise.resolve();
    live._ensureWalLoaded = async () => {};
    const adapter = { noteOutboundWalReady: jest.fn() };
    live._adapters.set('glyph:a', adapter);
    return { live, rows, adapter };
}

function envelope(sequence) {
    return {
        windowId: 'w',
        transactionId: `t${sequence}`,
        timestamp: sequence,
        localSequence: sequence,
        changes: [],
        metadata: { historyAction: 'change' }
    };
}

test('a staged row is written without a send, and replaces the earlier one', async () => {
    const { live, rows, adapter } = session();
    expect(
        await live.stageHeldUpdate(new Uint8Array([1]), envelope(1), 'glyph:a')
    ).toBe(true);
    expect(rows.size).toBe(1);
    const [firstId] = rows.keys();
    await live.stageHeldUpdate(
        new Uint8Array([2]),
        envelope(2),
        'glyph:a',
        firstId
    );
    expect(rows.size).toBe(1);
    expect(rows.has(firstId)).toBe(false);
    expect(adapter.noteOutboundWalReady).not.toHaveBeenCalled();
    // The hold owns staged rows: resends leave them out until it sends.
    expect(live._wal.holdStaged).toHaveBeenCalledTimes(2);
    expect(live._wal.releaseStaged).not.toHaveBeenCalled();

    // An ordinary row still tells the socket it may send.
    await live.persistOutgoingUpdate(
        new Uint8Array([3]),
        envelope(3),
        'glyph:a'
    );
    expect(adapter.noteOutboundWalReady).toHaveBeenCalledTimes(1);
    expect(live._wal.releaseStaged).toHaveBeenCalledTimes(1);

    const [stagedId] = rows.keys();
    await live.dropStagedUpdate('glyph:a', stagedId);
    expect(rows.has(stagedId)).toBe(false);
});
