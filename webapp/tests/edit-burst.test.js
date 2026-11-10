const { webcrypto } = require('crypto');
const { TextDecoder, TextEncoder } = require('util');
Object.defineProperty(global, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true
});
global.TextDecoder = TextDecoder;
global.TextEncoder = TextEncoder;

const Y = require('yjs');
const { EditBurstTracker, CloudSendHold } = require('../js/edit-burst');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const {
    applyCloudOwnedData
} = require('../js/filesystem-plugins/cloud-glyph-catalog');
const {
    glyphDocumentId
} = require('../js/filesystem-plugins/cloud-document-set');

function fakeClock() {
    let now = 0;
    const timers = new Map();
    let nextHandle = 1;
    return {
        clock: {
            now: () => now,
            setTimer: (callback, ms) => {
                const handle = nextHandle++;
                timers.set(handle, { callback, at: now + ms });
                return handle;
            },
            clearTimer: (handle) => timers.delete(handle)
        },
        advance(ms) {
            const target = now + ms;
            for (;;) {
                const due = [...timers.entries()]
                    .filter(([, timer]) => timer.at <= target)
                    .sort((left, right) => left[1].at - right[1].at)[0];
                if (!due) break;
                timers.delete(due[0]);
                now = due[1].at;
                due[1].callback();
            }
            now = target;
        }
    };
}

describe('EditBurstTracker', () => {
    function makeTracker(overrides = {}) {
        const time = fakeClock();
        const events = [];
        let historyCounter = 0;
        const tracker = new EditBurstTracker({
            idleMs: 1000,
            maxMs: 5000,
            clock: time.clock,
            createHistoryItemId: () => `history-${++historyCounter}`,
            dispatch: (detail) => events.push(detail),
            ...overrides
        });
        return { tracker, time, events };
    }

    it('keeps one burst and one history item while ticks keep coming', () => {
        const { tracker, time, events } = makeTracker();
        const first = tracker.tick('kerning:A:V');
        time.advance(400);
        const second = tracker.tick('kerning:A:V');
        time.advance(400);
        const third = tracker.tick('kerning:A:V');

        expect(second.id).toBe(first.id);
        expect(third.historyItemId).toBe(first.historyItemId);
        expect(third.ticks).toBe(3);
        expect(events.map((event) => event.phase)).toEqual([
            'tick',
            'tick',
            'tick'
        ]);
    });

    it('finalizes after the idle delay, then opens a new history item', async () => {
        const { tracker, time, events } = makeTracker();
        const first = tracker.tick('k');
        time.advance(1000);
        await Promise.resolve();
        await Promise.resolve();

        expect(events.map((event) => event.phase)).toEqual([
            'tick',
            'finalized'
        ]);
        const next = tracker.tick('k');
        expect(next.id).not.toBe(first.id);
        expect(next.historyItemId).not.toBe(first.historyItemId);
    });

    it('keeps the history item a relayed burst names', () => {
        const { tracker } = makeTracker();
        expect(
            tracker.tick('relayed', {
                shareHistory: false,
                historyItemId: 'history-of-sender'
            }).historyItemId
        ).toBe('history-of-sender');
    });

    it('does not share a history item when asked not to', () => {
        const { tracker } = makeTracker();
        expect(
            tracker.tick('undo', { shareHistory: false }).historyItemId
        ).toBe(null);
    });

    it('closes a burst that outlives the maximum length', () => {
        const { tracker, time } = makeTracker();
        const first = tracker.tick('k');
        for (let i = 0; i < 8; i += 1) {
            time.advance(900);
            tracker.tick('k');
        }
        const latest = tracker.get('k');
        expect(latest.id).not.toBe(first.id);
    });

    it('runs finalize handlers before announcing finalized', async () => {
        const { tracker, events } = makeTracker();
        const order = [];
        tracker.onFinalize(() => {
            order.push('handler');
            return Promise.resolve().then(() => order.push('handler-done'));
        });
        tracker.tick('k');
        await tracker.finalize('k');
        order.push(events[events.length - 1].phase);
        expect(order).toEqual(['handler', 'handler-done', 'finalized']);
    });
});

describe('CloudSendHold', () => {
    function makeHold() {
        const time = fakeClock();
        const flushed = [];
        const hold = new CloudSendHold({
            minGapMs: 200,
            trailingMs: 250,
            clock: time.clock,
            flush: (packets) => flushed.push(packets)
        });
        return { hold, time, flushed };
    }
    const packet = (name, burstKey = null) => ({
        kind: 'local',
        burstKey,
        documentId: 'font-core',
        update: new Uint8Array([name.charCodeAt(0)]),
        envelope: null,
        entries: []
    });

    it('lets an isolated edit through at once', () => {
        const { hold, flushed } = makeHold();
        expect(hold.submit(packet('a'), 1)).toBe('passthrough');
        expect(flushed).toHaveLength(0);
    });

    it('keeps the packets of one commit together', () => {
        const { hold } = makeHold();
        expect(hold.submit(packet('a'), 1)).toBe('passthrough');
        expect(hold.submit(packet('b'), 1)).toBe('passthrough');
    });

    it('merges commits that follow each other faster than the minimum gap', () => {
        const { hold, time, flushed } = makeHold();
        expect(hold.submit(packet('a'), 1)).toBe('passthrough');
        time.advance(50);
        expect(hold.submit(packet('b'), 2)).toBe('held');
        time.advance(50);
        expect(hold.submit(packet('c'), 3)).toBe('held');
        expect(flushed).toHaveLength(0);

        time.advance(250);
        expect(flushed).toHaveLength(1);
        expect(flushed[0].map((held) => held.update[0])).toEqual([98, 99]);
    });

    it('sends a commit after the gap has passed without holding it', () => {
        const { hold, time } = makeHold();
        hold.submit(packet('a'), 1);
        time.advance(300);
        expect(hold.submit(packet('b'), 2)).toBe('passthrough');
    });

    it('holds a burst until it is flushed', () => {
        const { hold, time, flushed } = makeHold();
        expect(hold.submit(packet('a', 'k'), 1)).toBe('held');
        time.advance(60_000);
        expect(hold.submit(packet('b', 'k'), 2)).toBe('held');
        expect(flushed).toHaveLength(0);

        hold.flushBurst('k');
        expect(flushed).toHaveLength(1);
        expect(flushed[0]).toHaveLength(2);
    });

    it('sends an unrelated edit behind the held burst, in order', () => {
        const { hold, flushed } = makeHold();
        hold.submit(packet('a', 'k'), 1);
        expect(hold.submit(packet('b'), 2)).toBe('held');
        expect(flushed).toHaveLength(1);
        expect(flushed[0].map((held) => held.update[0])).toEqual([97, 98]);
    });

    it('keeps rate limited packets with a burst that starts behind them', () => {
        const { hold, time, flushed } = makeHold();
        hold.submit(packet('a'), 1);
        time.advance(50);
        expect(hold.submit(packet('b'), 2)).toBe('held');
        expect(hold.submit(packet('c', 'k'), 3)).toBe('held');
        time.advance(500);
        // The trailing send waits for the burst, so it all goes out once.
        expect(flushed).toHaveLength(0);
        hold.flushBurst('k');
        expect(flushed).toHaveLength(1);
        expect(flushed[0].map((held) => held.update[0])).toEqual([98, 99]);
    });

    it('does not count an empty flush as a send', () => {
        const { hold, time } = makeHold();
        time.advance(1000);
        hold.flushAll();
        expect(hold.submit(packet('a'), 1)).toBe('passthrough');
    });

    it('ignores a flush for a burst it does not hold', () => {
        const { hold, flushed } = makeHold();
        hold.flushBurst('other');
        expect(flushed).toHaveLength(0);
    });
});

function makeFont() {
    return {
        upm: 1000,
        names: { familyName: 'Burst' },
        masters: [
            {
                name: 'Regular',
                id: 'master-regular',
                location: {},
                metrics: {},
                kerning: {}
            }
        ],
        glyphs: [
            {
                name: 'A',
                id: 'id-a',
                production_name: 'A',
                category: 'Base',
                codepoints: [65],
                exported: true,
                layers: [
                    {
                        id: 'layer-1',
                        name: 'Regular',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-regular'
                        },
                        shapes: [
                            {
                                type: 'path',
                                nodes: [
                                    {
                                        x: 10,
                                        y: 20,
                                        type: 'line',
                                        smooth: false
                                    }
                                ],
                                closed: false
                            }
                        ]
                    }
                ]
            }
        ]
    };
}

describe('PatchSyncEngine edit bursts', () => {
    let originalCloudPlugin;
    let originalFontManager;
    let bridge;
    let persisted;
    let cloudPackets;
    let localPackets;

    beforeEach(() => {
        originalCloudPlugin = window.cloudPlugin;
        originalFontManager = window.fontManager;
        persisted = [];
        cloudPackets = [];
        localPackets = [];
        window.fontManager = {
            currentFont: { isCloudBacked: () => true }
        };
        window.cloudPlugin = {
            persistOutgoingCloudUpdate: jest.fn(
                async (update, message, documentId) => {
                    persisted.push({ update, message, documentId });
                    return true;
                }
            ),
            relayPeerWindowUpdateToCloud: jest.fn()
        };
        const fontJson = makeFont();
        applyCloudOwnedData(fontJson);
        bridge = new PatchSyncEngine('burst-test');
        bridge.initFromJson(fontJson);
        bridge.onLocalUpdate(
            (update, message, _entries, documentId) => {
                cloudPackets.push({ update, message, documentId });
            },
            { cloud: true }
        );
        bridge.onLocalUpdate((update, message, _entries, documentId, meta) => {
            localPackets.push({ update, message, documentId, meta });
        });
    });

    afterEach(() => {
        bridge.destroy();
        window.cloudPlugin = originalCloudPlugin;
        window.fontManager = originalFontManager;
    });

    function nudge(value, previous) {
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes', 0],
            'x',
            previous,
            value
        );
    }

    async function settle() {
        await bridge.waitForPendingCloudCommits();
        await new Promise((resolve) => setTimeout(resolve, 10));
        await bridge.waitForPendingCloudCommits();
    }

    it('shows every tick to local listeners and sends the room one merged packet', async () => {
        // The first commit is an isolated edit and goes straight out.
        nudge(11, 10);
        await settle();
        const sentBeforeBurst = persisted.length;
        expect(sentBeforeBurst).toBeGreaterThan(0);
        await new Promise((resolve) => setTimeout(resolve, 250));

        const localBefore = localPackets.length;
        for (let value = 12; value <= 16; value += 1) {
            bridge.runInEditBurst('nudge', () => nudge(value, value - 1));
        }
        await settle();

        const glyphDoc = glyphDocumentId('id-a');
        const localGlyphTicks = localPackets
            .slice(localBefore)
            .filter((packet) => packet.documentId === glyphDoc);
        expect(localGlyphTicks).toHaveLength(5);
        expect(localGlyphTicks.every((p) => p.meta.burstKey === 'nudge')).toBe(
            true
        );
        // Nothing reached the room while the burst was open.
        expect(persisted).toHaveLength(sentBeforeBurst);
        expect(bridge.hasHeldCloudSends).toBe(true);

        await bridge.flushPendingCloudSends();
        await settle();

        const glyphRows = persisted
            .slice(sentBeforeBurst)
            .filter((row) => row.documentId === glyphDoc);
        expect(glyphRows).toHaveLength(1);
        // The room gets the burst as one change, from the value before the
        // first tick to the value after the last, under the first label.
        const burstChanges = glyphRows[0].message.changes;
        expect(burstChanges).toHaveLength(1);
        expect(burstChanges[0].replayOldValue).toBe(11);
        expect(burstChanges[0].replayNewValue).toBe(16);
        expect(glyphRows[0].message.summary).not.toMatch(/\d+ changes/);
        expect(bridge.hasHeldCloudSends).toBe(false);
        const cloudGlyph = cloudPackets.filter(
            (packet) => packet.documentId === glyphDoc
        );
        expect(cloudGlyph[cloudGlyph.length - 1].update).toBe(
            glyphRows[0].update
        );
    });

    it('merges a burst into the state the last tick left', async () => {
        const glyphDoc = glyphDocumentId('id-a');
        nudge(11, 10);
        await settle();
        const baseline = persisted.length;
        await new Promise((resolve) => setTimeout(resolve, 250));

        // A peer that has everything up to the first edit.
        const peer = new Y.Doc({ gc: false });
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(bridge._docForId(glyphDoc)));

        for (let value = 12; value <= 20; value += 1) {
            bridge.runInEditBurst('nudge', () => nudge(value, value - 1));
        }
        await bridge.flushPendingCloudSends();
        await settle();
        const merged = persisted
            .slice(baseline)
            .filter((row) => row.documentId === glyphDoc);
        expect(merged).toHaveLength(1);
        Y.applyUpdate(peer, merged[0].update);

        // The peer holds every operation the sender made, in one packet.
        const senderDoc = bridge._docForId(glyphDoc);
        expect(Array.from(Y.encodeStateVector(peer))).toEqual(
            Array.from(Y.encodeStateVector(senderDoc))
        );
        expect(Y.encodeStateAsUpdate(peer).length).toBe(
            Y.encodeStateAsUpdate(senderDoc).length
        );
    });

    it('gives the whole burst one history item', async () => {
        nudge(11, 10);
        await settle();
        for (let value = 12; value <= 15; value += 1) {
            bridge.runInEditBurst('nudge', () => nudge(value, value - 1));
        }
        await bridge.flushPendingCloudSends();
        const entries = bridge
            .getChangeLog()
            .filter((entry) => entry.path.includes('nodes'));
        const burstEntries = entries.slice(1);
        expect(new Set(burstEntries.map((e) => e.historyItemId)).size).toBe(1);
        expect(burstEntries[0].historyItemId).not.toBe(
            entries[0].historyItemId
        );
    });

    it('keeps the commit history of a burst opened without sharing it', async () => {
        nudge(11, 10);
        for (let value = 12; value <= 14; value += 1) {
            bridge.runInEditBurst('undo', () => nudge(value, value - 1), {
                shareHistory: false
            });
        }
        const entries = bridge
            .getChangeLog()
            .filter((entry) => entry.path.includes('nodes'));
        expect(new Set(entries.map((e) => e.historyItemId)).size).toBe(
            entries.length
        );
        await bridge.flushPendingCloudSends();
    });

    it('sends a commit that follows right after another one only once the gap has passed', async () => {
        nudge(11, 10);
        nudge(12, 11);
        nudge(13, 12);
        await settle();
        const glyphDoc = glyphDocumentId('id-a');
        // The first goes straight out; the others wait for the trailing send.
        expect(
            persisted.filter((row) => row.documentId === glyphDoc)
        ).toHaveLength(1);
        expect(bridge.hasHeldCloudSends).toBe(true);
        await bridge.flushPendingCloudSends();
        await settle();
        expect(
            persisted.filter((row) => row.documentId === glyphDoc)
        ).toHaveLength(2);
    });

    it('relays a linked window burst to the room merged', async () => {
        const plugin = window.cloudPlugin;
        const source = new Y.Doc();
        const update = (value) => {
            const before = Y.encodeStateVector(source);
            source.getMap('m').set('k', value);
            return Y.encodeStateAsUpdate(source, before);
        };
        const message = {
            transactionId: 'tx',
            changes: [],
            metadata: { historyItemId: 'history-linked' }
        };
        // Spend the isolated-edit allowance first.
        bridge.relayPeerPacketToCloud(update(0), message, 'font-core', null);
        expect(plugin.relayPeerWindowUpdateToCloud).toHaveBeenCalledTimes(1);

        await new Promise((resolve) => setTimeout(resolve, 250));
        bridge.relayPeerPacketToCloud(update(1), message, 'font-core', 'k');
        bridge.relayPeerPacketToCloud(update(2), message, 'font-core', 'k');
        expect(plugin.relayPeerWindowUpdateToCloud).toHaveBeenCalledTimes(1);

        await bridge.flushPendingCloudSends();
        expect(plugin.relayPeerWindowUpdateToCloud).toHaveBeenCalledTimes(2);
    });

    it('relays at once for a font that is not in the cloud', () => {
        window.fontManager.currentFont.isCloudBacked = () => false;
        const message = {
            transactionId: 'tx',
            changes: [],
            metadata: { historyItemId: 'history-linked' }
        };
        bridge.relayPeerPacketToCloud(
            new Uint8Array([1]),
            message,
            'font-core',
            'k'
        );
        expect(
            window.cloudPlugin.relayPeerWindowUpdateToCloud
        ).toHaveBeenCalledTimes(1);
        expect(bridge.hasHeldCloudSends).toBe(false);
    });

    it('leaves work a tick awaits out of the burst', async () => {
        nudge(11, 10);
        await bridge.runInEditBurst('nudge', async () => {
            nudge(12, 11);
            await Promise.resolve();
            // An edit made while the tick waits is not part of the burst.
            nudge(13, 12);
        });
        const entries = bridge
            .getChangeLog()
            .filter((entry) => entry.path.includes('nodes'));
        const burstItem = entries[1].historyItemId;
        expect(entries[2].historyItemId).not.toBe(burstItem);
        await bridge.flushPendingCloudSends();
    });

    it('starts a new history item for a tick after undo', async () => {
        bridge.runInEditBurst('nudge', () => nudge(11, 10));
        bridge.runInEditBurst('nudge', () => nudge(12, 11));
        const firstItem = bridge
            .getChangeLog()
            .filter((entry) => entry.path.includes('nodes'))[0].historyItemId;
        bridge.undo('A', 'layer-1');
        bridge.runInEditBurst('nudge', () => nudge(11, 10));
        const changes = bridge
            .getChangeLog()
            .filter(
                (entry) =>
                    entry.path.includes('nodes') &&
                    entry.historyAction === 'change'
            );
        expect(changes[changes.length - 1].historyItemId).not.toBe(firstItem);
        await bridge.flushPendingCloudSends();
    });

    it('still sends a burst whose bridge is replaced before the outbox write ends', async () => {
        nudge(11, 10);
        await settle();
        await new Promise((resolve) => setTimeout(resolve, 250));
        // Glyph row and core revision row each wait for their write.
        const pendingWrites = [];
        window.cloudPlugin.persistOutgoingCloudUpdate = jest.fn(
            () =>
                new Promise((resolve) => {
                    pendingWrites.push(() => resolve(true));
                })
        );
        const before = cloudPackets.length;
        bridge.runInEditBurst('nudge', () => nudge(12, 11));
        const flushed = bridge.flushPendingCloudSends();
        bridge.destroy();
        // Each write starts once the persist chain gets to it.
        for (let round = 0; round < 10; round += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            pendingWrites.splice(0).forEach((release) => release());
        }
        await flushed;
        expect(cloudPackets.length).toBeGreaterThan(before);
        // afterEach destroys it again; a fresh one keeps that harmless.
        bridge = new PatchSyncEngine('burst-test-after');
    });
});
