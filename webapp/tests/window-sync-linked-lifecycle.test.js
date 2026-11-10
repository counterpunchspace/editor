const {
    WindowSync,
    isLinkedPeerSnapshotSearch,
    linkedWindowSyncChannel,
    linkedWindowChangeLogSlice
} = require('../js/window-sync');

const MAIN_ROLE = {
    sessionId: 'test',
    isMainWindow: () => true,
    isLinkedWindow: () => false
};
const LINKED_ROLE = {
    sessionId: 'test',
    isMainWindow: () => false,
    isLinkedWindow: () => true
};

/** Minimal Web Locks: exclusive, FIFO, `ifAvailable`, abortable while queued. */
function createLockManager() {
    const held = new Set();
    const queues = new Map();
    const grant = (name) => {
        if (held.has(name)) return;
        const next = (queues.get(name) || []).shift();
        if (!next) return;
        held.add(name);
        Promise.resolve()
            .then(() => next.callback({ name }))
            .then(
                (value) => {
                    held.delete(name);
                    next.resolve(value);
                    grant(name);
                },
                (error) => {
                    held.delete(name);
                    next.reject(error);
                    grant(name);
                }
            );
    };
    return {
        isHeld: (name) => held.has(name),
        request(name, optionsOrCallback, maybeCallback) {
            const options =
                typeof optionsOrCallback === 'function'
                    ? {}
                    : optionsOrCallback;
            const callback =
                typeof optionsOrCallback === 'function'
                    ? optionsOrCallback
                    : maybeCallback;
            return new Promise((resolve, reject) => {
                const queue = queues.get(name) || [];
                queues.set(name, queue);
                if (options.ifAvailable && (held.has(name) || queue.length)) {
                    Promise.resolve(callback(null)).then(resolve, reject);
                    return;
                }
                const entry = { callback, resolve, reject };
                queue.push(entry);
                options.signal?.addEventListener('abort', () => {
                    const index = queue.indexOf(entry);
                    if (index < 0) return;
                    queue.splice(index, 1);
                    const error = new Error('aborted');
                    error.name = 'AbortError';
                    reject(error);
                });
                grant(name);
            });
        }
    };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function makeBridge(windowId) {
    return {
        windowId,
        onLocalUpdate: () => {},
        getChangeLog: () => [],
        getCollaborationLog: () => [],
        listLiveGlyphDocumentIds: () => [],
        encodeDocumentState: () => new Uint8Array([1])
    };
}

describe('linked window lifecycle', () => {
    const previousRole = window.windowRole;
    const previousFontCompilation = window.fontCompilation;
    const previousCloudPlugin = window.cloudPlugin;
    let syncs = [];

    function makeSync(role, windowId, channel = 'lifecycle-channel') {
        window.windowRole = role;
        const sync = new WindowSync(makeBridge(windowId), channel);
        syncs.push(sync);
        return sync;
    }

    beforeEach(() => {
        window.cloudPlugin = undefined;
    });

    afterEach(() => {
        for (const sync of syncs) {
            window.windowRole = LINKED_ROLE;
            sync.destroy();
        }
        syncs = [];
        delete navigator.locks;
        window.windowRole = previousRole;
        window.fontCompilation = previousFontCompilation;
        window.cloudPlugin = previousCloudPlugin;
        document.getElementById('linked-make-main-banner')?.remove();
        document.documentElement.dataset.linkedReadOnly = 'false';
    });

    test('a reloaded linked window still takes main’s document', () => {
        // The URL a linked tab reloads with, also one from before ?sync was kept.
        expect(
            isLinkedPeerSnapshotSearch(
                '?file=disk:///id/Font.glyphs&linked=1&windowSession=s'
            )
        ).toBe(true);
        expect(
            linkedWindowSyncChannel('?linked=1&syncChannel=counterpunch-font:x')
        ).toBe('counterpunch-font:x');
    });

    test('only main answers a full-state request', async () => {
        const main = makeSync(MAIN_ROLE, 'main');
        const linkedA = makeSync(LINKED_ROLE, 'linked-a');
        const sentByMain = [];
        const sentByA = [];
        main._send = (message) => sentByMain.push(message) > 0;
        linkedA._send = (message) => sentByA.push(message) > 0;
        const request = {
            type: 'full-state-request',
            windowId: 'linked-b',
            sessionId: 'test'
        };

        window.windowRole = LINKED_ROLE;
        linkedA._handleMessage(request);
        window.windowRole = MAIN_ROLE;
        main._handleMessage(request);
        await settle();

        expect(sentByA).toEqual([]);
        expect(sentByMain.map((message) => message.type)).toEqual([
            'full-state-begin',
            'full-state-end'
        ]);
    });

    test('a linked window sees main as gone only when main’s lock frees', async () => {
        const locks = createLockManager();
        navigator.locks = locks;
        const main = makeSync(MAIN_ROLE, 'main');
        const linked = makeSync(LINKED_ROLE, 'linked');
        await settle();

        expect(locks.isHeld('counterpunch-main:test:lifecycle-channel')).toBe(
            true
        );
        expect(linked.mainMissingLatched).toBe(false);
        // No liveness timers that a hidden main tab could miss.
        expect(main._mainPingTimer).toBeNull();
        expect(linked._mainPingTimer).toBeNull();

        // Main crashes: no closing message, only the lock goes.
        main._mainLockRelease();
        await settle();

        expect(linked.mainMissingLatched).toBe(true);
        expect(document.documentElement.dataset.linkedReadOnly).toBe('true');
        expect(document.getElementById('linked-make-main-banner')).toBeTruthy();
    });

    test('claiming main backs off while main still holds its lock', async () => {
        navigator.locks = createLockManager();
        const main = makeSync(MAIN_ROLE, 'main');
        const linked = makeSync(LINKED_ROLE, 'linked');
        const becomeMain = jest.fn();
        linked._becomeMainWindow = becomeMain;
        await settle();

        window.windowRole = LINKED_ROLE;
        linked.claimMainWindow();
        await settle();
        expect(becomeMain).not.toHaveBeenCalled();

        main._mainLockRelease();
        await settle();
        linked.claimMainWindow();
        await settle();
        expect(becomeMain).toHaveBeenCalledTimes(1);
    });

    test('another linked window closes when one becomes main', () => {
        const linked = makeSync(LINKED_ROLE, 'linked');
        const closing = jest.fn();
        linked.onMainWindowClosing(closing);
        linked._handleMessage({
            type: 'claim-main',
            windowId: 'linked-2',
            sessionId: 'test'
        });
        expect(closing).toHaveBeenCalledTimes(1);
    });

    test('main dropping the document blocks linked windows without a take-over offer', async () => {
        navigator.locks = createLockManager();
        const main = makeSync(MAIN_ROLE, 'main');
        const linked = makeSync(LINKED_ROLE, 'linked');
        await settle();

        window.windowRole = MAIN_ROLE;
        main.destroy();
        window.windowRole = LINKED_ROLE;
        await settle();

        expect(document.documentElement.dataset.linkedReadOnly).toBe('true');
        expect(linked.mainMissingLatched).toBe(true);
        const overlay = document.getElementById('linked-make-main-banner');
        expect(overlay?.dataset.detached).toBe('true');
        expect(overlay?.querySelector('[data-action="make-main"]')).toBeNull();
    });

    test('a linked window reports read-only once main is gone', async () => {
        navigator.locks = createLockManager();
        const main = makeSync(MAIN_ROLE, 'main');
        const linked = makeSync(LINKED_ROLE, 'linked');
        await settle();
        window.windowRole = LINKED_ROLE;
        expect(linked.linkedReadOnly).toBe(false);

        window.windowRole = MAIN_ROLE;
        main.destroy();
        window.windowRole = LINKED_ROLE;
        await settle();

        expect(linked.linkedReadOnly).toBe(true);
        window.windowRole = MAIN_ROLE;
        expect(linked.linkedReadOnly).toBe(false);
    });

    test('main’s failed cloud persist shows in linked windows', async () => {
        makeSync(MAIN_ROLE, 'main');
        makeSync(LINKED_ROLE, 'linked');
        const seen = [];
        const listener = (event) => seen.push(event.detail);

        window.windowRole = MAIN_ROLE;
        window.dispatchEvent(
            new CustomEvent('cloud-persist-failed', {
                detail: { documentId: 'glyph:a', reason: 'rejected' }
            })
        );
        window.addEventListener('cloud-persist-failed', listener);
        window.windowRole = LINKED_ROLE;
        await settle();
        window.removeEventListener('cloud-persist-failed', listener);

        // Both test windows share one `window`, so each relays the event once.
        expect(seen.length).toBeGreaterThan(0);
        expect(seen[0]).toEqual({ documentId: 'glyph:a', reason: 'rejected' });
    });

    test('destroy clears the bootstrap timeout and pending hydration requests', async () => {
        jest.useFakeTimers();
        try {
            let bootstrap = null;
            window.fontCompilation = {
                setWorkerCacheDocumentReady: () => {},
                trackWorkerDocumentSync: (promise) => {
                    bootstrap = promise;
                }
            };
            const linked = makeSync(LINKED_ROLE, 'linked');
            linked.requestFullState();
            const hydration = linked.requestHydration({ glyphNames: ['a'] });
            expect(jest.getTimerCount()).toBeGreaterThan(0);

            linked.destroy();

            expect(jest.getTimerCount()).toBe(0);
            await expect(hydration).rejects.toThrow('WindowSync destroyed');
            await expect(bootstrap).rejects.toThrow('WindowSync destroyed');
        } finally {
            jest.useRealTimers();
        }
    });

    test('bootstrap history never starts inside a history item', () => {
        const entry = (historyItemId) => ({ historyItemId });
        const log = [
            entry('h1'),
            entry('h2'),
            entry('h2'),
            entry('h2'),
            entry('h3')
        ];
        expect(
            linkedWindowChangeLogSlice(log, 2).map((e) => e.historyItemId)
        ).toEqual(['h2', 'h2', 'h2', 'h3']);
        expect(linkedWindowChangeLogSlice(log, 10)).toHaveLength(5);
    });
});
