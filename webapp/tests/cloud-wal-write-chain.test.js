// Every device outbox write of one document (this window's own rows, staged
// burst rows, their drops and linked-window relays) goes through one write
// chain, so the WAL keeps call order whatever each write awaits. The plugin
// routes rows synchronously so call order reaches that chain, and a relay
// reports when its row is durable.

const { CloudLiveSession } = require('../js/cloud-live-session');
const {
    CloudPlugin
} = require('../js/filesystem-plugins/plugins/cloud-plugin');
const {
    keptSessionRowCount,
    keptSessionRowsWritten
} = require('../js/filesystem-plugins/plugins/cloud-plugin-session-rows');

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

function deferred() {
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

/**
 * A session whose WAL appends wait for `gate(record)` when it returns a
 * promise, recording the order appends finish in.
 */
function session(gate = () => null) {
    const live = new CloudLiveSession({
        assetId: 'asset-1',
        websiteBaseUrl: 'https://editor.example',
        token: 'token',
        roomUrl: 'wss://rooms.example/room/asset-1',
        bridge: {},
        bootstrapMode: 'skip'
    });
    const written = [];
    const rows = new Map();
    live._wal = {
        isLoaded: true,
        recordsFor: () => [...rows.values()],
        append: jest.fn(async (record) => {
            await gate(record);
            rows.set(record.clientTransactionId, record);
            written.push(`${record.documentId}:${record.updateBytes[0]}`);
        }),
        acknowledgeMany: jest.fn(async (_asset, documentId, ids) => {
            for (const id of ids) {
                rows.delete(id);
                written.push(`${documentId}:drop`);
            }
        }),
        holdStaged: jest.fn(),
        releaseStaged: jest.fn()
    };
    live._walLoad = Promise.resolve();
    live._ensureWalLoaded = async () => {};
    const adapter = {
        noteOutboundWalReady: jest.fn(),
        sendForwardedUpdate: jest.fn()
    };
    live._adapters.set('glyph:a', adapter);
    live._adapters.set('font-core', {
        noteOutboundWalReady: jest.fn(),
        sendForwardedUpdate: jest.fn()
    });
    return { live, written, adapter };
}

describe('the session writes a document’s rows in call order', () => {
    test('a relay called after an own row whose write is slow is written after it', async () => {
        const slow = deferred();
        const { live, written, adapter } = session((record) =>
            record.updateBytes[0] === 1 ? slow.promise : null
        );
        const own = live.persistOutgoingUpdate(
            new Uint8Array([1]),
            envelope(1),
            'glyph:a'
        );
        const relay = live.relayForwardedUpdate(
            new Uint8Array([2]),
            envelope(2),
            'glyph:a'
        );
        // The relay takes its queue place at once.
        expect(adapter.sendForwardedUpdate).toHaveBeenCalledTimes(1);
        await Promise.resolve();
        await Promise.resolve();
        expect(written).toEqual([]);
        slow.resolve();
        await expect(own).resolves.toBe(true);
        await expect(relay).resolves.toBe(true);
        expect(written).toEqual(['glyph:a:1', 'glyph:a:2']);
    });

    test('a staged row, its drop and a later own row keep their order', async () => {
        const slow = deferred();
        const { live, written } = session((record) =>
            record.updateBytes[0] === 1 ? slow.promise : null
        );
        const staged = live.stageHeldUpdate(
            new Uint8Array([1]),
            envelope(1),
            'glyph:a'
        );
        const dropped = live.dropStagedUpdate('glyph:a', 'missing-id');
        const own = live.persistOutgoingUpdate(
            new Uint8Array([3]),
            envelope(3),
            'glyph:a'
        );
        slow.resolve();
        await Promise.all([staged, dropped, own]);
        expect(written).toEqual(['glyph:a:1', 'glyph:a:drop', 'glyph:a:3']);
    });

    test('rows of different documents do not wait for each other', async () => {
        const slow = deferred();
        const { live, written } = session((record) =>
            record.updateBytes[0] === 1 ? slow.promise : null
        );
        const glyph = live.persistOutgoingUpdate(
            new Uint8Array([1]),
            envelope(1),
            'glyph:a'
        );
        await live.persistOutgoingUpdate(
            new Uint8Array([2]),
            envelope(2),
            'font-core'
        );
        expect(written).toEqual(['font-core:2']);
        slow.resolve();
        await glyph;
        expect(written).toEqual(['font-core:2', 'glyph:a:1']);
    });

    test('a row with dependencies waits for every document’s earlier rows', async () => {
        const slow = deferred();
        const { live, written } = session((record) =>
            record.updateBytes[0] === 1 ? slow.promise : null
        );
        const glyph = live.persistOutgoingUpdate(
            new Uint8Array([1]),
            envelope(1),
            'glyph:a'
        );
        const core = live.persistOutgoingUpdate(
            new Uint8Array([2]),
            envelope(2),
            'font-core',
            ['t1']
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(written).toEqual([]);
        slow.resolve();
        await Promise.all([glyph, core]);
        expect(written).toEqual(['glyph:a:1', 'font-core:2']);
    });

    test('a failed write does not stop the rows behind it', async () => {
        const { live, written } = session((record) => {
            if (record.updateBytes[0] === 1) {
                throw new Error('disk');
            }
            return null;
        });
        const failed = live
            .persistOutgoingUpdate(new Uint8Array([1]), envelope(1), 'glyph:a')
            .catch((error) => error);
        const next = live.persistOutgoingUpdate(
            new Uint8Array([2]),
            envelope(2),
            'glyph:a'
        );
        expect(await failed).toBeInstanceOf(Error);
        await expect(next).resolves.toBe(true);
        expect(written).toEqual(['glyph:a:2']);
    });
});

describe('the plugin hands rows to the session in call order', () => {
    const previous = {
        windowRole: window.windowRole,
        patchSyncEngine: window.patchSyncEngine,
        fontManager: window.fontManager
    };
    beforeEach(() => {
        window.windowRole = { isMainWindow: () => true };
        window.patchSyncEngine = { markDocumentBroken: jest.fn() };
        window.fontManager = {
            currentFont: { isCloudBacked: () => true }
        };
    });
    afterEach(() => {
        Object.assign(window, previous);
    });

    function fakePlugin(fields = {}) {
        return Object.assign(Object.create(CloudPlugin.prototype), {
            _liveSession: null,
            _attachingSession: null,
            _activeAssetId: 'asset-1',
            _lastSessionAssetId: null,
            ...fields
        });
    }

    test('an own row and a relay called right after it reach the session in that order', async () => {
        const order = [];
        const liveSession = {
            persistOutgoingUpdate: jest.fn(async (_u, message) => {
                order.push(message.id);
                return true;
            }),
            relayForwardedUpdate: jest.fn(async (_u, message) => {
                order.push(message.id);
                return true;
            })
        };
        const plugin = fakePlugin({ _liveSession: liveSession });
        const own = CloudPlugin.prototype.persistOutgoingCloudUpdate.call(
            plugin,
            new Uint8Array([1]),
            { id: 'own' },
            'glyph:a'
        );
        const relay = CloudPlugin.prototype.relayPeerWindowUpdateToCloud.call(
            plugin,
            new Uint8Array([2]),
            { id: 'relay' },
            'glyph:a'
        );
        // Both were handed over synchronously, in call order.
        expect(order).toEqual(['own', 'relay']);
        await expect(own).resolves.toBe(true);
        await expect(relay).resolves.toBe(true);
    });

    test('a row made while kept rows are being written goes behind them', async () => {
        const order = [];
        const slow = deferred();
        const liveSession = {
            persistOutgoingUpdate: jest.fn(async (_u, message) => {
                if (message.id === 'kept') {
                    await slow.promise;
                }
                order.push(message.id);
                return true;
            }),
            relayForwardedUpdate: jest.fn(async (_u, message) => {
                order.push(message.id);
                return true;
            })
        };
        const plugin = fakePlugin();
        const kept = await CloudPlugin.prototype.persistOutgoingCloudUpdate
            .call(plugin, new Uint8Array([1]), { id: 'kept' }, 'glyph:a')
            .catch((error) => error);
        expect(kept.name).toBe('CloudSessionMissingError');

        plugin._liveSession = liveSession;
        plugin._writeKeptRows(liveSession, 'asset-1');
        await Promise.resolve();
        await Promise.resolve();
        // The flush took the kept row out and is writing it now.
        expect(keptSessionRowCount(plugin, 'asset-1')).toBe(1);
        const relay = CloudPlugin.prototype.relayPeerWindowUpdateToCloud.call(
            plugin,
            new Uint8Array([2]),
            { id: 'relay' },
            'glyph:a'
        );
        const own = CloudPlugin.prototype.persistOutgoingCloudUpdate.call(
            plugin,
            new Uint8Array([3]),
            { id: 'own' },
            'glyph:a'
        );
        expect(liveSession.relayForwardedUpdate).not.toHaveBeenCalled();
        slow.resolve();
        await expect(relay).resolves.toBe(true);
        await expect(own).resolves.toBe(true);
        await keptSessionRowsWritten(plugin);
        expect(order).toEqual(['kept', 'relay', 'own']);
        expect(keptSessionRowCount(plugin)).toBe(0);
    });
});

describe('relayPeerWindowUpdateToCloud reports durability', () => {
    const previous = {
        windowRole: window.windowRole,
        patchSyncEngine: window.patchSyncEngine,
        fontManager: window.fontManager
    };
    beforeEach(() => {
        window.windowRole = { isMainWindow: () => true };
        window.patchSyncEngine = { markDocumentBroken: jest.fn() };
        window.fontManager = {
            currentFont: { isCloudBacked: () => true }
        };
    });
    afterEach(() => {
        Object.assign(window, previous);
    });

    function relay(plugin) {
        return CloudPlugin.prototype.relayPeerWindowUpdateToCloud.call(
            plugin,
            new Uint8Array([1]),
            { id: 'x' },
            'glyph:a'
        );
    }

    function fakePlugin(fields = {}) {
        return Object.assign(Object.create(CloudPlugin.prototype), {
            _liveSession: null,
            _attachingSession: null,
            _activeAssetId: 'asset-1',
            _lastSessionAssetId: null,
            ...fields
        });
    }

    test('settles only once the session wrote the row', async () => {
        const write = deferred();
        const plugin = fakePlugin({
            _liveSession: { relayForwardedUpdate: () => write.promise }
        });
        let settled = null;
        relay(plugin).then((durable) => {
            settled = durable;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(null);
        write.resolve(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(settled).toBe(true);
    });

    test('a row kept only in memory settles false', async () => {
        const plugin = fakePlugin({
            _liveSession: { relayForwardedUpdate: async () => false }
        });
        await expect(relay(plugin)).resolves.toBe(false);
    });

    test('a refused relay settles false and never rejects', async () => {
        const plugin = fakePlugin({
            _liveSession: {
                relayForwardedUpdate: () => Promise.reject(new Error('no'))
            }
        });
        await expect(relay(plugin)).resolves.toBe(false);
        expect(window.patchSyncEngine.markDocumentBroken).toHaveBeenCalled();
    });

    test('a relay kept until the session is back settles when it is written', async () => {
        const plugin = fakePlugin();
        let settled = null;
        relay(plugin).then((durable) => {
            settled = durable;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(settled).toBe(null);
        const liveSession = { relayForwardedUpdate: async () => true };
        plugin._liveSession = liveSession;
        plugin._writeKeptRows(liveSession, 'asset-1');
        await keptSessionRowsWritten(plugin);
        await Promise.resolve();
        expect(settled).toBe(true);
    });

    test('a linked window or a font not in the cloud relays nothing', async () => {
        window.fontManager = {
            currentFont: { isCloudBacked: () => false }
        };
        await expect(relay(fakePlugin())).resolves.toBe(false);
        window.windowRole = { isMainWindow: () => false };
        await expect(relay(fakePlugin())).resolves.toBe(false);
    });
});

describe('a relay of a glyph without a socket is durable only once its HTTP row is', () => {
    const { CloudWalPersistError } = require('../js/cloud-durable-wal');

    function httpSession(gate) {
        const made = session(gate);
        // No socket for glyph:b: the relay queues in its HTTP outbox.
        made.live._wal.health = 'ready';
        made.live._pumpHttpPublishQueue = jest.fn();
        return made;
    }

    test('settles true only after the HTTP outbox row is written', async () => {
        const slow = deferred();
        const { live, written } = httpSession(() => slow.promise);
        let settled = null;
        live.relayForwardedUpdate(
            new Uint8Array([7]),
            envelope(7),
            'glyph:b'
        ).then((durable) => {
            settled = durable;
        });
        // Its queue place is taken at once.
        expect(live._httpOutboxes.get('glyph:b').packets).toHaveLength(1);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(settled).toBe(null);
        expect(written).toEqual([]);
        slow.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(written).toEqual(['glyph:b:7']);
        expect(settled).toBe(true);
    });

    test('settles false when the row is kept only in the WAL’s memory', async () => {
        const { live } = httpSession(() => {
            throw new CloudWalPersistError(new Error('quota'));
        });
        await expect(
            live.relayForwardedUpdate(
                new Uint8Array([8]),
                envelope(8),
                'glyph:b'
            )
        ).resolves.toBe(false);
        // Never dropped: it stays queued, sendable in its place.
        expect(live._httpOutboxes.get('glyph:b').packets[0].written).toBe(true);
    });

    test('an HTTP row keeps call order with an own row of the same glyph', async () => {
        const slow = deferred();
        const { live, written } = httpSession((record) =>
            record.updateBytes[0] === 1 ? slow.promise : null
        );
        const own = live.persistOutgoingUpdate(
            new Uint8Array([1]),
            envelope(1),
            'glyph:b'
        );
        const relay = live.relayForwardedUpdate(
            new Uint8Array([2]),
            envelope(2),
            'glyph:b'
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(written).toEqual([]);
        slow.resolve();
        await Promise.all([own, relay]);
        expect(written).toEqual(['glyph:b:1', 'glyph:b:2']);
    });
});

describe('a relay waiting only behind kept rows is not reported as failed', () => {
    const previous = {
        windowRole: window.windowRole,
        patchSyncEngine: window.patchSyncEngine,
        fontManager: window.fontManager
    };
    beforeEach(() => {
        window.windowRole = { isMainWindow: () => true };
        window.patchSyncEngine = { markDocumentBroken: jest.fn() };
        window.fontManager = {
            currentFont: { isCloudBacked: () => true }
        };
    });
    afterEach(() => {
        Object.assign(window, previous);
    });

    test('with a session there, no cloud-persist-failed and the relay settles true', async () => {
        const slow = deferred();
        const liveSession = {
            persistOutgoingUpdate: jest.fn(async () => {
                await slow.promise;
                return true;
            }),
            relayForwardedUpdate: jest.fn(async () => true)
        };
        const plugin = Object.assign(Object.create(CloudPlugin.prototype), {
            _liveSession: null,
            _attachingSession: null,
            _activeAssetId: 'asset-1',
            _lastSessionAssetId: null
        });
        await CloudPlugin.prototype.persistOutgoingCloudUpdate
            .call(plugin, new Uint8Array([1]), { id: 'kept' }, 'glyph:a')
            .catch(() => undefined);
        plugin._liveSession = liveSession;
        plugin._writeKeptRows(liveSession, 'asset-1');
        await Promise.resolve();
        const failures = [];
        const onFailed = (event) => failures.push(event.detail);
        window.addEventListener('cloud-persist-failed', onFailed);
        try {
            const relay =
                CloudPlugin.prototype.relayPeerWindowUpdateToCloud.call(
                    plugin,
                    new Uint8Array([2]),
                    { id: 'relay' },
                    'glyph:a'
                );
            slow.resolve();
            await expect(relay).resolves.toBe(true);
        } finally {
            window.removeEventListener('cloud-persist-failed', onFailed);
        }
        expect(failures).toEqual([]);
    });
});
