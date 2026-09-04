/**
 * Tests for array-node change-log recording in model path operations.
 *
 * Verifies array-native node storage:
 * - _setStartNode records a path-level node array change
 * - _setStartNode produces zero per-node field entries for a pure rotation
 * - Node identity (.id) is preserved through reorder operations
 */

const {
    Font,
    ensureStableIds,
    withSuppressedModelRecording
} = require('../js/babelfont-model');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const { yDocToJson } = require('../js/change-bridge-ydoc');
const Y = require('yjs');

// ── Helpers ──────────────────────────────────────────────────────────

/** Minimal font with one glyph, one layer, one closed path, N nodes */
function makeTestFont(nodeCount = 5) {
    const nodes = [];
    for (let i = 0; i < nodeCount; i++) {
        nodes.push({
            x: 100 + i * 200,
            y: 200 + i * 100,
            nodetype: 'Line',
            smooth: false
        });
    }
    return {
        upm: 1000,
        version: [1, 0],
        date: '2024-01-01',
        names: { familyName: 'TestFont' },
        features: { classes: {}, prefixes: {}, features: [] },
        masters: [
            {
                id: 'master-1',
                name: 'Regular',
                location: {},
                guides: [],
                metrics: {},
                kerning: {},
                custom_ot_values: {},
                format_specific: {}
            }
        ],
        glyphs: [
            {
                name: 'A',
                category: 'Base',
                codepoints: [65],
                exported: true,
                layers: [
                    {
                        id: 'layer-1',
                        name: 'Regular',
                        width: 600,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-1'
                        },
                        shapes: [
                            {
                                nodes: nodes,
                                closed: true
                            }
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            }
        ],
        format_specific: {}
    };
}

/** Mock bridge that captures recordChange/recordAdd/recordRemove calls */
function makeMockBridge() {
    const calls = [];
    const mock = {
        recordChange(path, prop, oldVal, newVal) {
            calls.push({ op: 'set', path: [...path, prop], oldVal, newVal });
        },
        recordAdd(path, value) {
            calls.push({
                op: 'add',
                path,
                oldValue: undefined,
                newValue: value
            });
        },
        recordRemove(path, oldValue) {
            calls.push({ op: 'remove', path, oldValue, newValue: undefined });
        },
        beginTransaction() {},
        endTransaction() {
            return null;
        },
        get inTransaction() {
            return false;
        },
        _calls: calls
    };
    return mock;
}

function setupBridge(bridge) {
    global.window = global.window || {};
    global.window.patchSyncEngine = bridge;
}

function teardownBridge() {
    if (global.window) {
        delete global.window.patchSyncEngine;
    }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Path._setStartNode — granular id-based recording', () => {
    let originalBridge;

    beforeEach(() => {
        originalBridge = global.window?.patchSyncEngine;
    });

    afterEach(() => {
        if (originalBridge !== undefined) {
            global.window = global.window || {};
            global.window.patchSyncEngine = originalBridge;
        } else {
            teardownBridge();
        }
    });

    test('records nodes array change', () => {
        const fontJson = makeTestFont(5);
        ensureStableIds(fontJson);
        const font = new Font(fontJson);
        const glyph = font.glyphs[0];
        const layer = glyph.layers[0];
        const path = layer.paths[0];

        // Verify nodes have ids
        const nodeIds = path.data.nodes.map((n) => n.id);
        expect(nodeIds.length).toBe(5);
        expect(new Set(nodeIds).size).toBe(5); // all unique

        const bridge = makeMockBridge();
        setupBridge(bridge);

        const result = path._setStartNode(2);

        expect(result).toBe(true);

        // Should have recorded at least one entry
        expect(bridge._calls.length).toBeGreaterThanOrEqual(1);

        const nodesEntry = bridge._calls.find(
            (c) => c.path[c.path.length - 1] === 'nodes'
        );
        expect(nodesEntry).toBeDefined();
        expect(nodesEntry.op).toBe('set');
        expect(nodesEntry.oldVal).toEqual(expect.any(Array));
        expect(nodesEntry.newVal).toEqual(expect.any(Array));
        expect(nodesEntry.newVal).not.toEqual(nodesEntry.oldVal);
    });

    test('produces zero node-data entries for pure rotation', () => {
        const fontJson = makeTestFont(10);
        ensureStableIds(fontJson);
        const font = new Font(fontJson);
        const glyph = font.glyphs[0];
        const layer = glyph.layers[0];
        const path = layer.paths[0];

        const bridge = makeMockBridge();
        setupBridge(bridge);

        path._setStartNode(3);

        // For a pure rotation of a closed path with Line nodes,
        // normalization should be a no-op — only the path-level nodes entry.
        const nodeDataEntries = bridge._calls.filter((c) => {
            const last = c.path[c.path.length - 1];
            return (
                last === 'nodetype' ||
                last === 'smooth' ||
                last === 'x' ||
                last === 'y'
            );
        });
        expect(nodeDataEntries.length).toBe(0);
    });

    test('preserves node identity through rotation', () => {
        const fontJson = makeTestFont(5);
        ensureStableIds(fontJson);
        const font = new Font(fontJson);
        const glyph = font.glyphs[0];
        const layer = glyph.layers[0];
        const path = layer.paths[0];

        const beforeIds = path.data.nodes.map((n) => n.id);

        path._setStartNode(2);

        const afterIds = path.data.nodes.map((n) => n.id);

        // Same set of ids, different order
        expect(new Set(afterIds)).toEqual(new Set(beforeIds));
        expect(afterIds).not.toEqual(beforeIds);

        // The first id after should be the id that was at index 2 before
        expect(afterIds[0]).toBe(beforeIds[2]);
    });

    test('does not record when path is not closed', () => {
        const fontJson = makeTestFont(5);
        fontJson.glyphs[0].layers[0].shapes[0].closed = false;
        ensureStableIds(fontJson);
        const font = new Font(fontJson);
        const path = font.glyphs[0].layers[0].paths[0];

        const bridge = makeMockBridge();
        setupBridge(bridge);

        const result = path._setStartNode(2);

        expect(result).toBe(false);
        expect(bridge._calls.length).toBe(0);
    });

    test('does not record when nodeIndex is 0', () => {
        const fontJson = makeTestFont(5);
        ensureStableIds(fontJson);
        const font = new Font(fontJson);
        const path = font.glyphs[0].layers[0].paths[0];

        const bridge = makeMockBridge();
        setupBridge(bridge);

        const result = path._setStartNode(0);

        expect(result).toBe(false);
        expect(bridge._calls.length).toBe(0);
    });
});

describe('Path._reverseDirection — granular id-based recording', () => {
    let originalBridge;

    beforeEach(() => {
        originalBridge = global.window?.patchSyncEngine;
    });

    afterEach(() => {
        if (originalBridge !== undefined) {
            global.window = global.window || {};
            global.window.patchSyncEngine = originalBridge;
        } else {
            teardownBridge();
        }
    });

    test('records nodes array change', () => {
        const fontJson = makeTestFont(5);
        ensureStableIds(fontJson);
        const font = new Font(fontJson);
        const path = font.glyphs[0].layers[0].paths[0];

        const bridge = makeMockBridge();
        setupBridge(bridge);

        const result = path._reverseDirection();

        expect(result).toBe(true);

        const nodesEntry = bridge._calls.find(
            (c) => c.path[c.path.length - 1] === 'nodes'
        );
        expect(nodesEntry).toBeDefined();
        expect(nodesEntry.oldVal).toEqual(expect.any(Array));
        expect(nodesEntry.newVal).toEqual(expect.any(Array));
        expect(nodesEntry.newVal).not.toEqual(nodesEntry.oldVal);
    });

    test('produces zero node-data entries for closed path with Line nodes', () => {
        const fontJson = makeTestFont(10);
        ensureStableIds(fontJson);
        const font = new Font(fontJson);
        const path = font.glyphs[0].layers[0].paths[0];

        const bridge = makeMockBridge();
        setupBridge(bridge);

        path._reverseDirection();

        // For a closed path with all-Line nodes, the reverse is a pure
        // reorder — normalization should not change any nodetype/smooth.
        const nodeDataEntries = bridge._calls.filter((c) => {
            const last = c.path[c.path.length - 1];
            return (
                last === 'nodetype' ||
                last === 'smooth' ||
                last === 'x' ||
                last === 'y'
            );
        });
        expect(nodeDataEntries.length).toBe(0);
    });

    test('preserves node identity through reverse', () => {
        const fontJson = makeTestFont(5);
        ensureStableIds(fontJson);
        const font = new Font(fontJson);
        const path = font.glyphs[0].layers[0].paths[0];

        const beforeIds = path.data.nodes.map((n) => n.id);

        path._reverseDirection();

        const afterIds = path.data.nodes.map((n) => n.id);

        // Same set of ids
        expect(new Set(afterIds)).toEqual(new Set(beforeIds));
        // Different order
        expect(afterIds).not.toEqual(beforeIds);
    });
});

// ── Integration: model → bridge → Y.Doc byte budget ─────────────────

describe('Integration: set-start-point and reverse-direction byte budgets', () => {
    let originalBridge;

    beforeEach(() => {
        originalBridge = global.window?.patchSyncEngine;
    });

    afterEach(() => {
        if (originalBridge !== undefined) {
            global.window = global.window || {};
            global.window.patchSyncEngine = originalBridge;
        } else {
            teardownBridge();
        }
    });

    test('set start point on 20-node contour produces a bounded Yjs delta', () => {
        const fontJson = makeTestFont(20);
        ensureStableIds(fontJson);

        const bridge = new PatchSyncEngine('integration-set-start');
        bridge.initFromJson(fontJson);
        setupBridge(bridge);

        const font = new Font(fontJson);
        const path = font.glyphs[0].layers[0].paths[0];

        const glyphDoc = [...bridge._glyphDocs.values()][0];
        const beforeSV = Y.encodeStateVector(glyphDoc || bridge.yDoc);

        path._setStartNode(5);

        // Debug: check change-log
        const log = bridge.getChangeLog();
        expect(log.length).toBeGreaterThanOrEqual(1);
        const nodesEntry = log.find(
            (e) => e.path && e.path.split(/[.:]/).at(-1) === 'nodes'
        );
        expect(nodesEntry).toBeDefined();
        expect(nodesEntry.oldValue).toEqual(expect.any(Array));
        expect(nodesEntry.newValue).toEqual(expect.any(Array));
        expect(nodesEntry.newValue).not.toEqual(nodesEntry.oldValue);

        const update = Y.encodeStateAsUpdate(glyphDoc || bridge.yDoc, beforeSV);

        // Budget: 20-node rotation → one node-array replacement, not a whole-glyph snapshot.
        expect(update.length).toBeLessThan(3000);

        // Verify the Y.Doc state is correct — the first node is the former index 5.
        const layerMap = bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1']);
        expect(layerMap.get('shapes')).toBeUndefined();
        expect(
            bridge.getYValue([
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodes',
                0,
                'x'
            ])
        ).toBe(1100);
    });

    test('reverse direction on 20-node contour produces a bounded Yjs delta', () => {
        const fontJson = makeTestFont(20);
        ensureStableIds(fontJson);

        const bridge = new PatchSyncEngine('integration-reverse');
        bridge.initFromJson(fontJson);
        setupBridge(bridge);

        const font = new Font(fontJson);
        const path = font.glyphs[0].layers[0].paths[0];

        const beforeSV = Y.encodeStateVector(bridge.yDoc);

        path._reverseDirection();

        const update = Y.encodeStateAsUpdate(bridge.yDoc, beforeSV);

        // Budget: 20-node reverse → order-only diff, ~38 delete+insert ops.
        // Still orders of magnitude smaller than a whole-glyph snapshot.
        // (May be 0 if the reverse produces the same order for this test font.)
        expect(update.length).toBeLessThan(3000);
    });

    test('node coordinate drag produces a bounded Yjs delta', () => {
        const fontJson = makeTestFont(10);
        ensureStableIds(fontJson);

        const bridge = new PatchSyncEngine('integration-node-drag');
        bridge.initFromJson(fontJson);
        setupBridge(bridge);

        const font = new Font(fontJson);
        const path = font.glyphs[0].layers[0].paths[0];
        const nodes = path.nodes;
        const oldX = nodes[0].x;

        const beforeSV = Y.encodeStateVector(bridge.yDoc);

        nodes[0].x = oldX + 50;

        const update = Y.encodeStateAsUpdate(bridge.yDoc, beforeSV);

        // A single leaf Set should be very small
        expect(update.length).toBeLessThan(1500);
    });
});

describe('Assistant prompt transaction metadata', () => {
    test('preserves keyed glyph maps and collection order through undo and redo', () => {
        const fontJson = makeTestFont();
        const secondLayer = JSON.parse(
            JSON.stringify(fontJson.glyphs[0].layers[0])
        );
        secondLayer.id = 'layer-2';
        fontJson.glyphs[0].layers.push(secondLayer);

        const secondGlyph = JSON.parse(JSON.stringify(fontJson.glyphs[0]));
        secondGlyph.name = 'B';
        secondGlyph.layers.forEach((layer, index) => {
            layer.id = `layer-b${index + 1}`;
        });
        fontJson.glyphs.push(secondGlyph);

        const receiverFontJson = JSON.parse(JSON.stringify(fontJson));
        const bridge = new PatchSyncEngine('collection-order');
        const receiverBridge = new PatchSyncEngine('collection-order-receiver');
        bridge.initFromJson(fontJson);
        receiverBridge._fontJson = receiverFontJson;
        receiverBridge.applyDocumentSetState(bridge.encodeDocumentSet());
        const packets = [];
        bridge.onLocalUpdate((update, _message, entries, documentId) => {
            packets.push({ update, entries, documentId });
        });
        bridge.applySyntheticChangeSet('Reorder collections', [
            {
                op: 'set',
                path: ['glyphOrder'],
                oldValue: ['A', 'B'],
                newValue: ['B', 'A']
            },
            {
                op: 'set',
                path: ['glyphs', 'A', 'layerOrder'],
                oldValue: ['layer-1', 'layer-2'],
                newValue: ['layer-2', 'layer-1']
            }
        ]);

        expect(bridge.getYValue(['glyphs', 'A'])).toBeInstanceOf(Y.Map);
        expect(bridge.getFontJsonSnapshot().glyphs).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'A' }),
                expect.objectContaining({ name: 'B' })
            ])
        );
        expect(
            bridge.getFontJsonSnapshot().glyphs.map((glyph) => glyph.name)
        ).toEqual(['B', 'A']);
        expect(
            bridge
                .getFontJsonSnapshot()
                .glyphs.find((glyph) => glyph.name === 'A')
                .layers.map((layer) => layer.id)
        ).toEqual(['layer-2', 'layer-1']);

        expect(
            packets
                .flatMap((packet) => packet.entries)
                .map((entry) => entry.path)
        ).toEqual(
            expect.arrayContaining(['glyphOrder', 'glyphs.A:layerOrder'])
        );
        for (const packet of packets) {
            receiverBridge.applyRemoteUpdate(
                packet.update,
                packet.entries,
                undefined,
                packet.documentId
            );
        }
        expect(receiverFontJson.glyphs.map((glyph) => glyph.name)).toEqual([
            'B',
            'A'
        ]);
        expect(
            receiverFontJson.glyphs[1].layers.map((layer) => layer.id)
        ).toEqual(['layer-2', 'layer-1']);

        bridge.undo();
        expect(
            bridge.getFontJsonSnapshot().glyphs.map((glyph) => glyph.name)
        ).toEqual(['A', 'B']);
        expect(
            bridge
                .getFontJsonSnapshot()
                .glyphs[0].layers.map((layer) => layer.id)
        ).toEqual(['layer-1', 'layer-2']);

        bridge.redo();
        expect(
            bridge.getFontJsonSnapshot().glyphs.map((glyph) => glyph.name)
        ).toEqual(['B', 'A']);

        bridge.destroy();
        receiverBridge.destroy();
    });

    test('upgrades the default prompt summary before one buffered commit', () => {
        const fontJson = makeTestFont();
        const bridge = new PatchSyncEngine('assistant-prompt-metadata');
        bridge.initFromJson(fontJson);

        bridge.beginTransaction('Assistant changes', null, {
            promptGroupId: 'assistant-prompt-1',
            historySummary: 'Assistant changes'
        });
        bridge.applySyntheticChangeSet('Assistant changes', [
            {
                op: 'set',
                path: ['format_specific', 'source'],
                oldValue: undefined,
                newValue: 'assistant'
            }
        ]);

        expect(
            bridge.updateTransactionMetadata(
                'assistant-prompt-1',
                'Add source metadata (interrupted)',
                'Add source metadata (interrupted)'
            )
        ).toBe(true);
        bridge.endTransaction();

        const entry = bridge
            .getChangeLog()
            .find((item) => item.path === 'format_specific.source');
        expect(entry).toEqual(
            expect.objectContaining({
                promptGroupId: 'assistant-prompt-1',
                transactionLabel: 'Add source metadata (interrupted)',
                historySummary: 'Add source metadata (interrupted)'
            })
        );
    });

    test('commits direct and synthetic prompt edits as one labeled update', () => {
        const fontJson = makeTestFont();
        const bridge = new PatchSyncEngine('assistant-prompt-aggregation');
        bridge.initFromJson(fontJson);
        const localUpdates = jest.fn();
        bridge.onLocalUpdate(localUpdates);

        bridge.beginTransaction('Assistant changes', null, {
            promptGroupId: 'assistant-prompt-2',
            historySummary: 'Assistant changes'
        });
        bridge.recordChange(['names'], 'familyName', 'TestFont', 'PromptFont');
        bridge.applySyntheticChangeSet('Assistant changes', [
            {
                op: 'set',
                path: ['format_specific', 'source'],
                oldValue: undefined,
                newValue: 'python'
            }
        ]);
        expect(
            bridge.updateTransactionMetadata(
                'assistant-prompt-2',
                'Edit font data',
                'Edit font data'
            )
        ).toBe(true);
        bridge.endTransaction();

        const entries = bridge.getChangeLog();
        expect(localUpdates).toHaveBeenCalledTimes(1);
        expect(entries).toHaveLength(2);
        expect(new Set(entries.map((entry) => entry.transactionId)).size).toBe(
            1
        );
        expect(entries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    transactionLabel: 'Edit font data',
                    historySummary: 'Edit font data',
                    promptGroupId: 'assistant-prompt-2'
                })
            ])
        );
        expect(bridge.getFontJsonSnapshot()).toEqual(
            expect.objectContaining({
                names: expect.objectContaining({ familyName: 'PromptFont' }),
                format_specific: expect.objectContaining({ source: 'python' })
            })
        );

        bridge.destroy();
    });
});
