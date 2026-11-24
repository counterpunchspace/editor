/**
 * Main is read-only and refuses its linked window's edit: the document is
 * not broken or stopped and nothing reports a persist failure. The edit
 * still goes to the cloud relay (which keeps it in main's write-ahead log
 * unsent), the reason is shown once, and once main accepts edits again the
 * refused edits go into main's document, in order, before that document's
 * next linked packet, so it integrates.
 */
const Y = require('yjs');
const { WindowSync } = require('../js/window-sync');
const { ReadOnlyFontError } = require('../js/patch-sync-engine.ts');
const { assertUpdateIntegrates } = require('../js/yjs-update-integrity.ts');

/** The notices the user sees (font-windows/dialogs.ts showNotice). */
function shownNotices() {
    return [...document.querySelectorAll('.font-window-notice')].map(
        (node) => node.textContent
    );
}
const {
    resetReadOnlyRefusalNoticesForTests
} = require('../js/glyph-canvas/edit-refusal-notice.ts');

const MAIN_ROLE = {
    sessionId: 'test',
    isMainWindow: () => true,
    isLinkedWindow: () => false
};

function linkedEdits(count) {
    // The linked window's own copy of glyph:A and the packets it sends.
    const linked = new Y.Doc();
    const base = Y.encodeStateAsUpdate(linked);
    const packets = [];
    linked.on('update', (update) => packets.push(update));
    for (let i = 0; i < count; i += 1) {
        linked.getMap('layer').set('width', 500 + i);
    }
    return { base, packets };
}

function mainBridge({ notifyReadOnly = false } = {}) {
    const doc = new Y.Doc();
    let readOnlyReason = null;
    const readOnlyListeners = new Set();
    const relayed = [];
    const applied = [];
    const bridge = {
        windowId: 'main',
        onLocalUpdate: () => {},
        getChangeLog: () => [],
        getCollaborationLog: () => [],
        listLiveGlyphDocumentIds: () => [],
        encodeDocumentState: () => Y.encodeStateAsUpdate(doc),
        getDocumentInstance: (documentId) =>
            documentId === 'glyph:A' ? doc : null,
        isReadOnly: () => readOnlyReason !== null,
        applyRemoteUpdate: jest.fn(
            (update, _entries, _messages, documentId, options) => {
                if (options?.fromLinkedWindow && readOnlyReason !== null) {
                    throw new ReadOnlyFontError(
                        readOnlyReason,
                        'edit in another window'
                    );
                }
                // The engine's gate: a packet that builds on one this
                // document lacks is a real gap.
                assertUpdateIntegrates(doc, update, documentId);
                Y.applyUpdate(doc, update);
                applied.push(update);
            }
        ),
        relayPeerPacketToCloud: jest.fn((update) => relayed.push(update)),
        markDocumentBroken: jest.fn()
    };
    if (notifyReadOnly) {
        // The engine's onReadOnlyChanged.
        bridge.onReadOnlyChanged = (listener) => {
            readOnlyListeners.add(listener);
            return () => readOnlyListeners.delete(listener);
        };
    }
    return {
        bridge,
        doc,
        relayed,
        applied,
        readOnlyListeners,
        setReadOnly: (reason) => {
            readOnlyReason = reason;
            for (const listener of [...readOnlyListeners]) listener(reason);
        }
    };
}

describe('a linked-window edit refused while main is read-only', () => {
    const previousRole = window.windowRole;
    const previousFontManager = window.fontManager;
    let persistFailures;
    const onPersistFailed = (event) => persistFailures.push(event.detail);

    beforeEach(() => {
        window.windowRole = MAIN_ROLE;
        window.fontManager = { currentFont: { isCloudBacked: () => true } };
        persistFailures = [];
        window.addEventListener('cloud-persist-failed', onPersistFailed);
        resetReadOnlyRefusalNoticesForTests();
        document
            .querySelectorAll('.font-window-notice')
            .forEach((node) => node.remove());
    });

    afterEach(() => {
        window.removeEventListener('cloud-persist-failed', onPersistFailed);
        window.windowRole = previousRole;
        window.fontManager = previousFontManager;
    });

    function deliver(sync, updates) {
        sync._applyInboundYjsMessages(
            [
                {
                    type: 'yjs-update',
                    updates: updates.map((update) => ({
                        update,
                        documentId: 'glyph:A',
                        collaborationMessage: {
                            source: 'test',
                            messageId: `m${update.byteLength}`,
                            transactionId: 't',
                            changes: [],
                            metadata: {}
                        }
                    }))
                }
            ],
            { updateBytes: 0, collaborationMessageCount: 0 }
        );
    }

    test('is kept and relayed, not broken, and shown once', () => {
        const main = mainBridge();
        const { base, packets } = linkedEdits(2);
        Y.applyUpdate(main.doc, base);
        main.setReadOnly('You can only view this font.');
        const sync = new WindowSync(main.bridge, 'ro-channel-1');

        deliver(sync, packets);

        expect(main.bridge.markDocumentBroken).not.toHaveBeenCalled();
        expect(persistFailures).toEqual([]);
        expect(sync._stoppedDocuments.has('glyph:A')).toBe(false);
        // Each one went to the relay, which keeps it in the write-ahead log.
        expect(main.relayed).toEqual(packets);
        expect(main.applied).toEqual([]);
        expect(sync.refusedWhileReadOnlyCount('glyph:A')).toBe(2);
        const notices = shownNotices();
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain('You can only view this font.');
        sync.destroy?.();
    });

    test('goes into main, in order, before the next linked packet once main is writable', () => {
        const main = mainBridge();
        const { base, packets } = linkedEdits(3);
        Y.applyUpdate(main.doc, base);
        main.setReadOnly('You can only view this font.');
        const sync = new WindowSync(main.bridge, 'ro-channel-2');

        deliver(sync, packets.slice(0, 2));
        main.setReadOnly(null);
        // Without the replay this packet would be a clock gap in main.
        deliver(sync, packets.slice(2));

        expect(main.bridge.markDocumentBroken).not.toHaveBeenCalled();
        expect(main.applied).toEqual(packets);
        expect(main.doc.getMap('layer').get('width')).toBe(502);
        // The kept ones are not relayed again; the new one is.
        expect(main.relayed).toEqual(packets);
        expect(sync.refusedWhileReadOnlyCount('glyph:A')).toBe(0);
        sync.destroy?.();
    });

    test('goes into main as soon as main is writable, without another linked packet', async () => {
        const main = mainBridge({ notifyReadOnly: true });
        const { base, packets } = linkedEdits(2);
        Y.applyUpdate(main.doc, base);
        main.setReadOnly('You can only view this font.');
        const sync = new WindowSync(main.bridge, 'ro-channel-6');

        deliver(sync, packets);
        expect(main.applied).toEqual([]);
        main.setReadOnly(null);
        await Promise.resolve();

        expect(main.bridge.markDocumentBroken).not.toHaveBeenCalled();
        expect(main.applied).toEqual(packets);
        expect(main.doc.getMap('layer').get('width')).toBe(501);
        // Not relayed again: their rows are in the write-ahead log already.
        expect(main.relayed).toEqual(packets);
        expect(sync.refusedWhileReadOnlyCount('glyph:A')).toBe(0);
        sync.destroy();
        expect(main.readOnlyListeners.size).toBe(0);
    });

    test('kept packets that turn out to be a real gap stop the document when main is writable', async () => {
        const main = mainBridge({ notifyReadOnly: true });
        const { packets } = linkedEdits(2);
        // Main lacks the linked window's first edit entirely.
        main.setReadOnly('You can only view this font.');
        const sync = new WindowSync(main.bridge, 'ro-channel-7');

        deliver(sync, packets.slice(1));
        main.setReadOnly(null);
        await Promise.resolve();

        expect(main.bridge.markDocumentBroken).toHaveBeenCalledTimes(1);
        expect(sync._stoppedDocuments.has('glyph:A')).toBe(true);
        expect(sync.refusedWhileReadOnlyCount('glyph:A')).toBe(0);
        sync.destroy();
    });

    test('skips kept packets main already holds from its write-ahead log', () => {
        const main = mainBridge();
        const { base, packets } = linkedEdits(2);
        Y.applyUpdate(main.doc, base);
        main.setReadOnly('You can only view this font.');
        const sync = new WindowSync(main.bridge, 'ro-channel-3');

        deliver(sync, packets.slice(0, 1));
        main.setReadOnly(null);
        // The new cloud session restored the kept row into main.
        Y.applyUpdate(main.doc, packets[0]);
        deliver(sync, packets.slice(1));

        expect(main.bridge.markDocumentBroken).not.toHaveBeenCalled();
        expect(main.applied).toEqual([packets[1]]);
        expect(main.doc.getMap('layer').get('width')).toBe(501);
        sync.destroy?.();
    });

    test('a refused edit the relay cannot keep still stops the document loudly', () => {
        const main = mainBridge();
        const { base, packets } = linkedEdits(1);
        Y.applyUpdate(main.doc, base);
        main.setReadOnly('You can only view this font.');
        main.bridge.relayPeerPacketToCloud = jest.fn(() => {
            throw new Error('no relay');
        });
        const sync = new WindowSync(main.bridge, 'ro-channel-4');

        deliver(sync, packets);

        expect(main.bridge.markDocumentBroken).toHaveBeenCalledWith(
            'glyph:A',
            expect.objectContaining({ message: 'no relay' })
        );
        expect(persistFailures).toHaveLength(1);
        sync.destroy?.();
    });

    test('any other apply error still stops the document', () => {
        const main = mainBridge();
        const { packets } = linkedEdits(2);
        // Main lacks the first packet: the second is a real gap.
        const sync = new WindowSync(main.bridge, 'ro-channel-5');

        deliver(sync, packets.slice(1));

        expect(main.bridge.markDocumentBroken).toHaveBeenCalledTimes(1);
        expect(persistFailures).toHaveLength(1);
        expect(sync._stoppedDocuments.has('glyph:A')).toBe(true);
        sync.destroy?.();
    });
});
