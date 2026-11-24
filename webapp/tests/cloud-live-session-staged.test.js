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

describe('an envelope too large for the room', () => {
    const { EnvelopeTooLargeError } = require('../js/cloud-envelope-budget');
    const {
        MAX_METADATA_BYTES
    } = require('../js/generated/collab-protocol-limits');
    // No lossless step shortens a label, so this never fits.
    const oversized = (sequence) => ({
        ...envelope(sequence),
        label: 'x'.repeat(MAX_METADATA_BYTES + 16)
    });

    test('still gets its outbox row, marks the document broken and throws', async () => {
        const { live, rows } = session();
        const markDocumentBroken = jest.fn();
        live._options.bridge = { markDocumentBroken };
        const message = oversized(1);
        await expect(
            live.persistOutgoingUpdate(new Uint8Array([1]), message, 'glyph:a')
        ).rejects.toBeInstanceOf(EnvelopeTooLargeError);
        // Never dropped: the row keeps the envelope as it came.
        expect(rows.size).toBe(1);
        expect([...rows.values()][0].collaborationMessage).toBe(message);
        expect(markDocumentBroken).toHaveBeenCalledWith(
            'glyph:a',
            expect.any(EnvelopeTooLargeError)
        );
    });

    test('is refused before an HTTP publish, and the head stays queued', async () => {
        const { live } = session();
        const fetchSpy = jest.fn();
        const previousFetch = global.fetch;
        global.fetch = fetchSpy;
        try {
            const head = {
                clientTransactionId: 'tx-1',
                update: new Uint8Array([1]),
                collaborationMessage: oversized(1),
                seq: 1,
                walRecord: null,
                written: true
            };
            const outbox = { packets: [head], attempts: 0 };
            await expect(
                live._publishHttpHead('glyph:a', outbox)
            ).rejects.toBeInstanceOf(EnvelopeTooLargeError);
            expect(outbox.packets).toEqual([head]);
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            global.fetch = previousFetch;
        }
    });
});
