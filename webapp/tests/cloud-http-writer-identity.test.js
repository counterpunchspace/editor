/**
 * HTTP publishes: one writer name per live session, one increasing seq per
 * part of a split update, and resends from the row the room waits for with
 * the same seqs. Only clock_gap and prior_refused (and the other permanent
 * codes) stop a glyph's outbox.
 */
jest.mock('../js/logger', () => ({
    Logger: class {
        log() {}
        warn() {}
        error() {}
    }
}));

const { webcrypto } = require('crypto');
if (typeof globalThis.crypto?.randomUUID !== 'function') {
    Object.defineProperty(globalThis, 'crypto', {
        value: webcrypto,
        configurable: true
    });
}

const Y = require('yjs');
const { CloudLiveSession } = require('../js/cloud-live-session.ts');
const {
    publishCloudDocumentUpdate,
    HTTP_PART_RETRY_DELAYS_MS,
    CloudRoomHttpError,
    isTransientRoomHttpAnswer
} = require('../js/cloud-adapter-support.ts');
const {
    MAX_YJS_PACKET_BYTES
} = require('../js/generated/collab-protocol-limits.ts');
const { collaborationMessageKey } = require('../js/collaboration-message.ts');

const originalFetch = global.fetch;

afterEach(() => {
    global.fetch = originalFetch;
});

function envelope(id) {
    return {
        source: 'test',
        messageId: id,
        transactionId: id,
        changes: [],
        metadata: {}
    };
}

function answer(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body)
    };
}

function durableAck(body) {
    return answer(200, {
        ok: true,
        durable: true,
        seq: body.seq,
        clientTransactionId: body.clientTransactionId
    });
}

function makeSession(options = {}) {
    const session = new CloudLiveSession({
        assetId: 'asset-1',
        websiteBaseUrl: 'https://editor.example',
        token: 'token',
        roomUrl: 'wss://rooms.example/room/asset-1',
        bridge: { markDocumentBroken: options.markDocumentBroken ?? jest.fn() },
        bootstrapMode: 'skip'
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
    // Retries run at once in tests.
    session._scheduleTimer = (callback) => {
        const timer = setTimeout(callback, 0);
        return timer;
    };
    return session;
}

function twoUpdates() {
    const doc = new Y.Doc();
    const updates = [];
    doc.on('update', (update) => updates.push(update));
    doc.getMap('layer').set('width', 500);
    doc.getMap('layer').set('width', 520);
    return updates;
}

describe('one HTTP writer name per live session', () => {
    test('two sessions of the same font publish under different names', async () => {
        const first = makeSession();
        const second = makeSession();
        expect(first.httpClientId).toMatch(/^http:asset-1:[0-9a-f-]{36}$/);
        expect(second.httpClientId).toMatch(/^http:asset-1:[0-9a-f-]{36}$/);
        expect(first.httpClientId).not.toBe(second.httpClientId);

        const bodies = [];
        global.fetch = jest.fn(async (_url, init) => {
            const body = JSON.parse(init.body);
            bodies.push(body);
            return durableAck(body);
        });
        const [update] = twoUpdates();
        await first._enqueueDependentPublish('glyph:a', update, envelope('a'));
        await first.flushPendingHttpPublishes();
        await second._enqueueDependentPublish('glyph:a', update, envelope('b'));
        await second.flushPendingHttpPublishes();
        expect(bodies.map((body) => body.clientId)).toEqual([
            first.httpWriterIdFor('glyph:a'),
            second.httpWriterIdFor('glyph:a')
        ]);
        expect(first.httpWriterIdFor('glyph:a')).toBe(
            `${first.httpClientId}:1`
        );
        // Each session counts its own seqs from 1.
        expect(bodies.map((body) => body.seq)).toEqual([1, 1]);
        first.disconnect();
        second.disconnect();
    });

    test('a publish without a writer name throws and sends nothing', async () => {
        global.fetch = jest.fn();
        const base = {
            token: 't',
            roomUrl: 'wss://rooms.example/room/asset-1',
            websiteBaseUrl: 'https://editor.example',
            assetId: 'asset-1',
            documentId: 'glyph:a',
            update: new Uint8Array([1, 2, 3]),
            seq: 1,
            collaborationMessage: envelope('x')
        };
        await expect(publishCloudDocumentUpdate(base)).rejects.toThrow(
            TypeError
        );
        await expect(
            publishCloudDocumentUpdate({ ...base, clientId: '  ' })
        ).rejects.toThrow(TypeError);
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe('resending after a retryable HTTP answer', () => {
    test.each([
        [409, { code: 'tail_full', retryable: true }],
        [429, { code: 'rate_limit' }],
        [503, { code: 'commit_unacknowledged', retryable: true }],
        [503, { code: 'validator_unavailable' }],
        // A held row: it waits behind the head, which is sent again.
        [409, { code: 'tail_full', retryable: true, refusedSeq: 1 }],
        [400, { code: 'refused', retryable: true, refusedSeq: 1 }]
    ])(
        'a %s %j resends the head with the same seq, then the next row',
        async (status, refusal) => {
            const markDocumentBroken = jest.fn();
            const session = makeSession({ markDocumentBroken });
            const sent = [];
            let refused = false;
            global.fetch = jest.fn(async (_url, init) => {
                const body = JSON.parse(init.body);
                sent.push([body.clientTransactionId, body.seq]);
                if (!refused) {
                    refused = true;
                    return answer(status, { ...refusal, seq: body.seq });
                }
                return durableAck(body);
            });
            const [first, second] = twoUpdates();
            const a = envelope('tx-a');
            const b = envelope('tx-b');
            await Promise.all([
                session._enqueueDependentPublish('glyph:a', first, a),
                session._enqueueDependentPublish('glyph:a', second, b)
            ]);
            await session.flushPendingHttpPublishes();
            expect(sent).toEqual([
                [collaborationMessageKey(a), 1],
                [collaborationMessageKey(a), 1],
                [collaborationMessageKey(b), 2]
            ]);
            expect(markDocumentBroken).not.toHaveBeenCalled();
            session.disconnect();
        },
        15000
    );

    test.each(['clock_gap', 'prior_refused'])(
        'a 409 %s is final: the outbox stops at that row',
        async (code) => {
            const markDocumentBroken = jest.fn();
            const session = makeSession({ markDocumentBroken });
            global.fetch = jest.fn(async (_url, init) => {
                const body = JSON.parse(init.body);
                return answer(409, { code, seq: body.seq, refusedSeq: 1 });
            });
            const [first, second] = twoUpdates();
            await Promise.all([
                session._enqueueDependentPublish(
                    'glyph:a',
                    first,
                    envelope('tx-a')
                ),
                session._enqueueDependentPublish(
                    'glyph:a',
                    second,
                    envelope('tx-b')
                )
            ]);
            await session.flushPendingHttpPublishes().catch(() => undefined);
            expect(global.fetch).toHaveBeenCalledTimes(1);
            expect(markDocumentBroken).toHaveBeenCalledWith(
                'glyph:a',
                expect.objectContaining({ code })
            );
            session.disconnect();
        }
    );

    test('a held answer carries the seq it waits for, apart from its own', () => {
        const error = new CloudRoomHttpError('held', {
            status: 409,
            code: 'tail_full',
            retryable: true,
            seq: 5,
            refusedSeq: 4
        });
        expect(error.seq).toBe(5);
        expect(error.refusedSeq).toBe(4);
        expect(isTransientRoomHttpAnswer(error)).toBe(true);
    });
});

describe('a split HTTP update', () => {
    function largeUpdate() {
        const doc = new Y.Doc({ gc: false });
        doc.getText('features').insert(0, 'feature liga {} liga;');
        const before = Y.encodeStateVector(doc);
        let text = '';
        for (let i = 0; i < MAX_YJS_PACKET_BYTES + 100_000; i += 1) {
            text += String.fromCharCode(97 + ((i * 7919) % 26));
        }
        doc.getText('features').insert(5, text);
        return Y.encodeStateAsUpdate(doc, before);
    }

    let savedDelays;
    beforeEach(() => {
        savedDelays = [...HTTP_PART_RETRY_DELAYS_MS];
        HTTP_PART_RETRY_DELAYS_MS.fill(0);
    });
    afterEach(() => {
        HTTP_PART_RETRY_DELAYS_MS.splice(0, savedDelays.length, ...savedDelays);
    });

    test('needs one seq per part', async () => {
        global.fetch = jest.fn();
        await expect(
            publishCloudDocumentUpdate({
                token: 't',
                roomUrl: 'wss://rooms.example/room/asset-1',
                websiteBaseUrl: 'https://editor.example',
                assetId: 'asset-1',
                documentId: 'glyph:a',
                update: largeUpdate(),
                seq: 1,
                clientId: 'http:asset-1:s',
                collaborationMessage: envelope('big')
            })
        ).rejects.toThrow(/one seq per part/);
        await expect(
            publishCloudDocumentUpdate({
                token: 't',
                roomUrl: 'wss://rooms.example/room/asset-1',
                websiteBaseUrl: 'https://editor.example',
                assetId: 'asset-1',
                documentId: 'glyph:a',
                update: largeUpdate(),
                seq: 1,
                partSeqs: (count) => Array(count).fill(1),
                clientId: 'http:asset-1:s',
                collaborationMessage: envelope('big')
            })
        ).rejects.toThrow(/increasing/);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('a part held behind an earlier part resends from that part, same seqs', async () => {
        const sent = [];
        let held = false;
        global.fetch = jest.fn(async (_url, init) => {
            const body = JSON.parse(init.body);
            sent.push(body.seq);
            if (sent.length === 2 && !held) {
                // The room lost part 1 (seq 10) from its spool and holds
                // part 2 behind it.
                held = true;
                return answer(409, {
                    code: 'tail_full',
                    retryable: true,
                    seq: body.seq,
                    refusedSeq: 10
                });
            }
            return durableAck(body);
        });
        const published = await publishCloudDocumentUpdate({
            token: 't',
            roomUrl: 'wss://rooms.example/room/asset-1',
            websiteBaseUrl: 'https://editor.example',
            assetId: 'asset-1',
            documentId: 'glyph:a',
            update: largeUpdate(),
            seq: 10,
            partSeqs: (count) =>
                Array.from({ length: count }, (_, i) => 10 + i),
            clientId: 'http:asset-1:s',
            collaborationMessage: envelope('big'),
            clientTransactionId: 'tx-big'
        });
        expect(published).toBe(true);
        expect(sent.slice(0, 4)).toEqual([10, 11, 10, 11]);
        const partCount = sent.length - 2;
        expect(sent.slice(2)).toEqual(
            Array.from({ length: partCount }, (_, i) => 10 + i)
        );
    });

    test('the session gives each part its own seq, below every later packet', async () => {
        const session = makeSession();
        const sent = [];
        global.fetch = jest.fn(async (_url, init) => {
            const body = JSON.parse(init.body);
            sent.push([body.clientTransactionId, body.seq, body.clientId]);
            return durableAck(body);
        });
        const big = envelope('tx-big');
        const after = envelope('tx-after');
        await Promise.all([
            session._enqueueDependentPublish('glyph:a', largeUpdate(), big),
            session._enqueueDependentPublish('glyph:a', twoUpdates()[0], after)
        ]);
        await session.flushPendingHttpPublishes();
        const seqs = sent.map(([, seq]) => seq);
        expect(sent.length).toBeGreaterThan(2);
        expect(seqs).toEqual(seqs.map((_, i) => i + 1));
        expect(sent[sent.length - 1][0]).toBe(collaborationMessageKey(after));
        expect(new Set(sent.map(([, , clientId]) => clientId))).toEqual(
            new Set([session.httpWriterIdFor('glyph:a')])
        );
        session.disconnect();
    }, 15000);
});

describe('one HTTP writer per glyph within a session', () => {
    test('a permanent refusal of one glyph never stops another glyph', async () => {
        const markDocumentBroken = jest.fn();
        const session = makeSession({ markDocumentBroken });
        // The room's writer state: a permanently refused writer refuses its
        // later rows as prior_refused (font-room-do _refusePastWriterRefusal).
        const refusedWriters = new Map();
        const bodies = [];
        global.fetch = jest.fn(async (url, init) => {
            const body = JSON.parse(init.body);
            bodies.push([String(url), body.clientId, body.seq]);
            const refusedSeq = refusedWriters.get(body.clientId);
            if (refusedSeq !== undefined && body.seq > refusedSeq) {
                return answer(409, {
                    code: 'prior_refused',
                    seq: body.seq,
                    refusedSeq
                });
            }
            if (String(url).includes('/shards/glyph/a/')) {
                refusedWriters.set(body.clientId, body.seq);
                return answer(409, {
                    code: 'clock_gap',
                    seq: body.seq,
                    client: 1,
                    need: 2,
                    have: 1
                });
            }
            return durableAck(body);
        });
        const [first, second] = twoUpdates();
        await session._enqueueDependentPublish('glyph:a', first, envelope('a'));
        await session.flushPendingHttpPublishes().catch(() => {});
        await session._enqueueDependentPublish(
            'glyph:b',
            second,
            envelope('b')
        );
        await session.flushPendingHttpPublishes().catch(() => {});

        expect(session.httpWriterIdFor('glyph:a')).not.toBe(
            session.httpWriterIdFor('glyph:b')
        );
        const brokenIds = markDocumentBroken.mock.calls.map(([id]) => id);
        expect(brokenIds).toContain('glyph:a');
        expect(brokenIds).not.toContain('glyph:b');
        expect(
            bodies.filter(
                ([, clientId]) =>
                    clientId === session.httpWriterIdFor('glyph:b')
            )
        ).toHaveLength(1);
        session.disconnect();
    });
});
