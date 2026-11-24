/**
 * A room answer that says “not now” is retried with the same seq; only a
 * refusal the room repeats every time stops a document.
 */
const {
    CloudRefusalError,
    CloudRoomHttpError,
    isTerminalDocumentError,
    isTransientRoomHttpAnswer,
    publishCloudDocumentUpdate,
    shouldRetryHydrateTransport
} = require('../js/cloud-adapter-support.ts');
const { fetchCloudDocumentState } = require('../js/cloud-adapter-bootstrap.ts');
const { CloudAdapter } = require('../js/cloud-adapter.ts');
const { CloudLiveSession } = require('../js/cloud-live-session.ts');

const originalFetch = global.fetch;
afterEach(() => {
    global.fetch = originalFetch;
});

function answer(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => 'application/json' },
        json: async () => body,
        text: async () => (body ? JSON.stringify(body) : ''),
        arrayBuffer: async () => new ArrayBuffer(0)
    };
}

function publish() {
    return publishCloudDocumentUpdate({
        token: 't',
        roomUrl: 'wss://rooms.example.com/room/asset-1',
        websiteBaseUrl: 'https://editor.counterpunch.space',
        assetId: 'asset-1',
        documentId: 'glyph:a',
        update: new Uint8Array([1, 2, 3]),
        clientId: 'http:test-session',
        seq: 7,
        collaborationMessage: { transactionId: 'tx-1' }
    });
}

describe('room HTTP answers', () => {
    test.each([
        [409, 'tail_full', true],
        [503, 'spool_busy', undefined],
        [503, 'incomplete_limit', undefined],
        [503, 'asset_migrating', undefined],
        [503, 'commit_unacknowledged', undefined],
        [503, 'state_superseded', undefined],
        [503, 'state_unavailable', undefined]
    ])('%s %s is transient', (status, code, retryable) => {
        expect(isTransientRoomHttpAnswer({ status, code, retryable })).toBe(
            true
        );
    });

    test.each([
        [500, 'broken_journal', undefined],
        [409, 'clock_gap', undefined],
        [409, 'digest_mismatch', undefined],
        [409, 'tail_full', false],
        [400, null, undefined]
    ])('%s %s is terminal', (status, code, retryable) => {
        expect(isTransientRoomHttpAnswer({ status, code, retryable })).toBe(
            false
        );
    });

    test('a 409 tail_full publish carries its seq and retryable, and is not terminal', async () => {
        global.fetch = jest.fn(async () =>
            answer(409, { code: 'tail_full', retryable: true, seq: 7 })
        );
        const error = await publish().catch((caught) => caught);
        expect(error).toBeInstanceOf(CloudRoomHttpError);
        expect(error.status).toBe(409);
        expect(error.code).toBe('tail_full');
        expect(error.retryable).toBe(true);
        expect(error.seq).toBe(7);
        expect(isTerminalDocumentError(error)).toBe(false);
    });

    test('a 503 spool_busy publish is transient', async () => {
        global.fetch = jest.fn(async () =>
            answer(503, { code: 'spool_busy', seq: 7 })
        );
        const error = await publish().catch((caught) => caught);
        expect(error).toBeInstanceOf(CloudRoomHttpError);
        expect(isTransientRoomHttpAnswer(error)).toBe(true);
    });

    test('a code the room says it refuses every time is a refusal', async () => {
        global.fetch = jest.fn(async () =>
            answer(422, { code: 'invalid_update', retryable: false, seq: 7 })
        );
        const error = await publish().catch((caught) => caught);
        expect(error).toBeInstanceOf(CloudRefusalError);
        expect(error.code).toBe('invalid_update');
        expect(isTerminalDocumentError(error)).toBe(true);
    });

    test('digest_mismatch over HTTP is a refusal', async () => {
        global.fetch = jest.fn(async () =>
            answer(409, { code: 'digest_mismatch', seq: 7 })
        );
        const error = await publish().catch((caught) => caught);
        expect(error).toBeInstanceOf(CloudRefusalError);
    });
});

describe('state downloads', () => {
    test('retry 503 state_superseded and state_unavailable; broken_journal is final', () => {
        const superseded = new CloudRoomHttpError('x', {
            status: 503,
            code: 'state_superseded'
        });
        expect(shouldRetryHydrateTransport(superseded, false, 0)).toBe(true);
        expect(
            shouldRetryHydrateTransport(
                new CloudRoomHttpError('x', {
                    status: 503,
                    code: 'state_unavailable'
                }),
                false,
                2
            )
        ).toBe(true);
        expect(
            shouldRetryHydrateTransport(
                new Error(
                    'shard pack hydrate failed: 500 {"code":"broken_journal"}'
                ),
                false,
                0
            )
        ).toBe(false);
        expect(
            shouldRetryHydrateTransport(
                new CloudRefusalError('glyph:a', { code: 'broken_journal' }),
                false,
                0
            )
        ).toBe(false);
        // Never past the attempt limit.
        expect(shouldRetryHydrateTransport(superseded, false, 3)).toBe(false);
    });

    test('a room state download retries a superseded state and then loads', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        global.fetch = jest
            .fn()
            .mockResolvedValueOnce(answer(503, { code: 'state_superseded' }))
            .mockResolvedValueOnce({
                ...answer(200, null),
                arrayBuffer: async () => bytes.buffer
            });
        const loaded = await fetchCloudDocumentState({
            token: 't',
            roomUrl: 'wss://rooms.example.com/room/asset-1',
            websiteBaseUrl: 'https://editor.counterpunch.space',
            assetId: 'asset-1',
            documentId: 'kerning:0'
        });
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(Array.from(loaded)).toEqual([1, 2, 3, 4]);
    });

    test('a broken journal is not asked for again', async () => {
        global.fetch = jest.fn(async () =>
            answer(500, { code: 'broken_journal' })
        );
        const error = await fetchCloudDocumentState({
            token: 't',
            roomUrl: 'wss://rooms.example.com/room/asset-1',
            websiteBaseUrl: 'https://editor.counterpunch.space',
            assetId: 'asset-1',
            documentId: 'kerning:0'
        }).catch((caught) => caught);
        expect(error).toBeInstanceOf(CloudRefusalError);
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });
});

describe('socket refusals', () => {
    function socketAdapter() {
        const adapter = new CloudAdapter({
            assetId: 'asset-1',
            documentId: 'glyph:a'
        });
        const markDocumentBroken = jest.fn();
        adapter._bridge = { markDocumentBroken };
        adapter._ws = { readyState: 1, close: jest.fn(), send: jest.fn() };
        return { adapter, markDocumentBroken };
    }

    test('“Forbidden” naming refusedSeq is a held row, resent in order', () => {
        const { adapter, markDocumentBroken } = socketAdapter();
        const hold = jest
            .spyOn(adapter, '_holdOutboundTransient')
            .mockImplementation(() => {});
        adapter._handleMessage(
            JSON.stringify({
                type: 'error',
                code: 'Forbidden',
                message: 'Forbidden',
                seq: 5,
                refusedSeq: 4
            })
        );
        expect(hold).toHaveBeenCalledWith(4, 'Forbidden');
        expect(markDocumentBroken).not.toHaveBeenCalled();
        adapter.disconnect();
    });

    test('digest_mismatch stops the document; no reconnect resends it', () => {
        const { adapter, markDocumentBroken } = socketAdapter();
        const reconnect = jest.spyOn(adapter, '_scheduleReconnect');
        adapter._handleMessage(
            JSON.stringify({
                type: 'error',
                code: 'digest_mismatch',
                message: 'digest mismatch',
                seq: 5
            })
        );
        expect(markDocumentBroken).toHaveBeenCalledWith(
            'glyph:a',
            expect.objectContaining({
                name: 'CloudRefusalError',
                code: 'digest_mismatch'
            })
        );
        expect(adapter._outboundHalt).toBeTruthy();
        expect(reconnect).not.toHaveBeenCalled();
        adapter.disconnect();
    });
});

describe('HTTP outbox', () => {
    const envelope = (id) => ({
        source: 'test',
        messageId: id,
        transactionId: id,
        changes: [],
        metadata: {}
    });

    function httpSession(extra = {}) {
        const markDocumentBroken = jest.fn();
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: { markDocumentBroken },
            bootstrapMode: 'skip',
            ...extra
        });
        session._wal = {
            isLoaded: true,
            health: 'ready',
            pendingCount: 0,
            append: jest.fn(async () => {}),
            acknowledge: jest.fn(async () => {}),
            recordsFor: () => [],
            replayableRecords: () => []
        };
        session._walLoad = Promise.resolve();
        return { session, markDocumentBroken };
    }

    test('a 409 tail_full answer retries the head with the same seq and breaks nothing', async () => {
        const { session, markDocumentBroken } = httpSession();
        const seqs = [];
        global.fetch = jest.fn(async (_url, init) => {
            seqs.push(JSON.parse(init.body).seq);
            return answer(409, {
                code: 'tail_full',
                retryable: true,
                seq: JSON.parse(init.body).seq
            });
        });
        await session._enqueueDependentPublish(
            'glyph:a',
            new Uint8Array([1]),
            envelope('tx-1')
        );
        await Promise.all([...session._httpPublishInFlight]);
        const outbox = session._httpOutboxes.get('glyph:a');
        expect(outbox.halted).toBeNull();
        expect(outbox.retryTimer).not.toBeNull();
        expect(outbox.packets).toHaveLength(1);
        expect(markDocumentBroken).not.toHaveBeenCalled();
        expect(seqs).toHaveLength(1);
        session.disconnect();
    });

    test('signing out pauses the outbox; the row is kept, nothing is broken', async () => {
        const signedOut = new Error('signed out');
        signedOut.code = 'signed_out';
        const { session, markDocumentBroken } = httpSession({
            refreshCredentials: async () => {
                throw signedOut;
            }
        });
        // Treat the refresh failure as a sign-out, as the website reports it.
        session._fetchFreshCredentials = async () => {
            session._signedOut = true;
            throw signedOut;
        };
        global.fetch = jest.fn(async () => answer(401, null));
        await session._enqueueDependentPublish(
            'glyph:a',
            new Uint8Array([1]),
            envelope('tx-1')
        );
        await Promise.all([...session._httpPublishInFlight]);
        const outbox = session._httpOutboxes.get('glyph:a');
        expect(outbox.halted).toBeNull();
        expect(outbox.packets).toHaveLength(1);
        expect(markDocumentBroken).not.toHaveBeenCalled();
        // While signed out nothing more is sent.
        expect(global.fetch).toHaveBeenCalledTimes(1);
        session.disconnect();
    });
});
