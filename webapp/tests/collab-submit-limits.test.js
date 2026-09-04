jest.mock('../js/logger', () => ({
    Logger: class {
        log() {}
        warn() {}
        error() {}
    }
}));

const { PatchSyncEngine } = require('../js/patch-sync-engine');
const {
    CloudPlugin
} = require('../js/filesystem-plugins/plugins/cloud-plugin');
const {
    MAX_SHARD_BYTES,
    MAX_YJS_PACKET_BYTES,
    evaluateCollabSubmit,
    evaluateShardSizes,
    measureShardBytesForSubmit
} = require('../js/filesystem-plugins/cloud-shard-limits');
const {
    FONT_CORE_DOCUMENT_ID
} = require('../js/filesystem-plugins/cloud-document-set');
const Y = require('yjs');

function makeFont(note = '') {
    return {
        upm: 1000,
        version: [1, 0],
        date: '2024-01-01',
        names: { familyName: 'LimitTest' },
        note,
        features: { classes: {}, prefixes: {}, features: [] },
        masters: [
            {
                id: 'master-1',
                name: 'Regular',
                location: {},
                metrics: {},
                kerning: {}
            }
        ],
        glyphs: []
    };
}

function createCloudSubmitPlugin() {
    const submissions = [];
    const rejections = [];
    return {
        getId: () => 'cloud',
        submissions,
        rejections,
        canSubmitCollabUpdate(requests) {
            submissions.push(requests);
            return evaluateCollabSubmit(requests);
        },
        notifyCollabSubmitRejected(decision) {
            rejections.push(decision);
        }
    };
}

function installPlugin(plugin) {
    const previousManager = window.fontManager;
    const previousBridge = window.patchSyncEngine;
    window.fontManager = {
        currentFont: { sourcePlugin: plugin }
    };
    return () => {
        window.fontManager = previousManager;
        window.patchSyncEngine = previousBridge;
    };
}

describe('collab submit size helpers', () => {
    test('hard caps are 5MiB for both shard and packet', () => {
        expect(MAX_SHARD_BYTES).toBe(5 * 1024 * 1024);
        expect(MAX_YJS_PACKET_BYTES).toBe(MAX_SHARD_BYTES);
    });

    test('rejects a packet at the cap even when the shard estimate is smaller', () => {
        const decision = evaluateCollabSubmit([
            {
                documentId: FONT_CORE_DOCUMENT_ID,
                packetBytes: MAX_YJS_PACKET_BYTES,
                shardBytes: 100
            }
        ]);
        expect(decision.allowed).toBe(false);
        expect(decision.kind).toBe('packet');
    });

    test('rejects a shard at the cap when the packet itself is small', () => {
        const decision = evaluateCollabSubmit([
            {
                documentId: FONT_CORE_DOCUMENT_ID,
                packetBytes: 40,
                shardBytes: MAX_SHARD_BYTES
            }
        ]);
        expect(decision.allowed).toBe(false);
        expect(decision.kind).toBe('shard');
    });

    test('skips a full encode when cached size plus packet stays under the cap', () => {
        const encodeFullShard = jest.fn(() => MAX_SHARD_BYTES);
        const measured = measureShardBytesForSubmit({
            lastEncodedBytes: 1000,
            packetBytes: 50,
            encodeFullShard
        });
        expect(encodeFullShard).not.toHaveBeenCalled();
        expect(measured.encodedFull).toBe(false);
        expect(measured.shardBytes).toBe(1050);
    });

    test('encodes the shard when the cheap estimate would reject', () => {
        const encodeFullShard = jest.fn(() => 4096);
        const measured = measureShardBytesForSubmit({
            lastEncodedBytes: MAX_SHARD_BYTES - 10,
            packetBytes: 50,
            encodeFullShard
        });
        expect(encodeFullShard).toHaveBeenCalledTimes(1);
        expect(measured.encodedFull).toBe(true);
        expect(measured.shardBytes).toBe(4096);
    });
});

describe('commit-time hard rejection', () => {
    jest.setTimeout(60000);

    test('asks the cloud plugin and emits a small commit', () => {
        const plugin = createCloudSubmitPlugin();
        const restore = installPlugin(plugin);
        const bridge = new PatchSyncEngine('submit-small');
        const emitted = [];
        bridge.initFromJson(makeFont());
        window.patchSyncEngine = bridge;
        bridge.onLocalUpdate((update, _message, _entries, documentId) => {
            emitted.push({ byteLength: update.byteLength, documentId });
        });
        try {
            bridge.recordChange([], 'note', '', 'hello');
            expect(plugin.submissions).toHaveLength(1);
            expect(plugin.submissions[0][0].packetBytes).toBeGreaterThan(0);
            expect(plugin.submissions[0][0].packetBytes).toBeLessThan(1024);
            expect(plugin.rejections).toHaveLength(0);
            expect(emitted.length).toBeGreaterThan(0);
            expect(bridge.getFontJsonSnapshot().note).toBe('hello');
        } finally {
            restore();
            bridge.destroy();
        }
    });

    test('rolls back an oversize Yjs packet without emitting', () => {
        const plugin = createCloudSubmitPlugin();
        const restore = installPlugin(plugin);
        const bridge = new PatchSyncEngine('submit-packet');
        const emitted = [];
        bridge.initFromJson(makeFont());
        window.patchSyncEngine = bridge;
        bridge.onLocalUpdate((update) => {
            emitted.push(update.byteLength);
        });
        const fat = 'p'.repeat(MAX_YJS_PACKET_BYTES);
        try {
            bridge.recordChange([], 'note', '', fat);
            expect(plugin.submissions.length).toBeGreaterThan(0);
            const asked = plugin.submissions[plugin.submissions.length - 1][0];
            expect(asked.packetBytes).toBeGreaterThanOrEqual(
                MAX_YJS_PACKET_BYTES
            );
            expect(plugin.rejections).toHaveLength(1);
            expect(plugin.rejections[0].kind).toBe('packet');
            expect(emitted).toEqual([]);
            expect(bridge.getFontJsonSnapshot().note).toBe('');
            expect(bridge.getChangeLog()).toEqual([]);
            expect(bridge.fontMap.get('note') || '').not.toBe(fat);
        } finally {
            restore();
            bridge.destroy();
        }
    });

    test('rolls back a small packet when the shard is already at the cap', () => {
        const plugin = createCloudSubmitPlugin();
        const restore = installPlugin(plugin);
        const bridge = new PatchSyncEngine('submit-shard');
        const emitted = [];
        const fatNote = 's'.repeat(MAX_SHARD_BYTES);
        bridge.initFromJson(makeFont(fatNote));
        window.patchSyncEngine = bridge;
        bridge.onLocalUpdate((update) => {
            emitted.push(update.byteLength);
        });
        try {
            const encoded = Y.encodeStateAsUpdate(bridge.yDoc);
            expect(encoded.byteLength).toBeGreaterThanOrEqual(MAX_SHARD_BYTES);
            bridge.recordChange(
                ['names'],
                'familyName',
                'LimitTest',
                'LimitTest2'
            );
            expect(plugin.submissions.length).toBeGreaterThan(0);
            const asked = plugin.submissions[plugin.submissions.length - 1][0];
            expect(asked.packetBytes).toBeLessThan(MAX_YJS_PACKET_BYTES);
            expect(asked.shardBytes).toBeGreaterThanOrEqual(MAX_SHARD_BYTES);
            expect(plugin.rejections[0].kind).toBe('shard');
            expect(emitted).toEqual([]);
            expect(bridge.getFontJsonSnapshot().names.familyName).toBe(
                'LimitTest'
            );
        } finally {
            restore();
            bridge.destroy();
        }
    });

    test('local backends still emit without asking a cloud plugin', () => {
        const restore = installPlugin({ getId: () => 'memory' });
        const bridge = new PatchSyncEngine('submit-local');
        const emitted = [];
        bridge.initFromJson(makeFont());
        window.patchSyncEngine = bridge;
        bridge.onLocalUpdate((update) => {
            emitted.push(update.byteLength);
        });
        try {
            bridge.recordChange([], 'note', '', 'local-ok');
            expect(emitted.length).toBeGreaterThan(0);
            expect(bridge.getFontJsonSnapshot().note).toBe('local-ok');
        } finally {
            restore();
            bridge.destroy();
        }
    });
});

describe('seed-time shard rejection', () => {
    test('evaluateShardSizes blocks a 5MB encoded shard', () => {
        const gate = evaluateShardSizes([
            {
                documentId: FONT_CORE_DOCUMENT_ID,
                byteLength: MAX_SHARD_BYTES
            }
        ]);
        expect(gate.canSave).toBe(false);
    });

    test('CloudPlugin prepareToSave notifies and throws before seed', async () => {
        const alerts = [];
        const originalAlert = global.alert;
        global.alert = (message) => {
            alerts.push(message);
        };
        const previousBridge = window.patchSyncEngine;
        const plugin = new CloudPlugin();
        window.patchSyncEngine = {
            encodeDocumentSet: () => [
                {
                    documentId: FONT_CORE_DOCUMENT_ID,
                    bytes: new Uint8Array(MAX_SHARD_BYTES)
                }
            ]
        };
        try {
            await expect(plugin.prepareToSave()).rejects.toThrow(
                /shard exceeds/
            );
            expect(alerts.length).toBeGreaterThan(0);
            expect(alerts[0]).toMatch(/5 MB cloud shard limit/);
        } finally {
            global.alert = originalAlert;
            window.patchSyncEngine = previousBridge;
        }
    });
});
