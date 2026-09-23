/**
 * Canvas history items must be undoable from every layer of the originating
 * glyph that the item actually wrote, not only from the first recorded layer.
 */

const { PatchSyncEngine: ChangeBridge } = require('../../js/patch-sync-engine');
const { getYPath } = require('../../js/change-bridge-ydoc');
const {
    buildHistoryStackItems,
    createLogEntry,
    formatHistoryOriginLabel,
    resetLogCounter,
    resolveCommitOriginatingLayer
} = require('../../js/change-log');
const {
    resetUndoRedoContextStickyState
} = require('../../js/undo-redo-context');

function makeLayer(id, name, width) {
    return {
        id,
        name,
        width,
        master: {
            type: 'DefaultForMaster',
            master: 'master-regular'
        },
        smart_component_location: {},
        color: null,
        layer_index: 0,
        is_background: false,
        background_layer_id: null,
        location: {},
        format_specific: {},
        shapes: [],
        anchors: [],
        guides: []
    };
}

function makeFont() {
    return {
        upm: 1000,
        version: [1, 0],
        names: { familyName: 'TestFont' },
        axes: [],
        masters: [
            {
                name: 'Regular',
                id: 'master-regular',
                location: {},
                metrics: {},
                kerning: {},
                format_specific: {}
            }
        ],
        instances: [],
        glyphs: [
            {
                name: 'A',
                production_name: 'A',
                category: 'Base',
                codepoints: [65],
                exported: true,
                layers: [
                    makeLayer('layer-1', 'Regular', 600),
                    makeLayer('layer-1b', 'Regular Alt', 620),
                    makeLayer('layer-1c', 'Unwritten', 640)
                ]
            },
            {
                name: 'B',
                production_name: 'B',
                category: 'Base',
                codepoints: [66],
                exported: true,
                layers: [makeLayer('layer-2', 'Regular', 650)]
            }
        ]
    };
}

describe('history layer availability', () => {
    afterEach(() => {
        window.changeBridge = undefined;
        window.fontManager = undefined;
    });

    test('multi-layer same-glyph edits are undoable from every written layer', () => {
        const fontJson = makeFont();
        const bridge = new ChangeBridge('history-layer-availability');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        bridge.beginTransaction('Set component automatic alignment', null, {
            compileChangeSource: 'test-sync',
            compileEditType: null
        });
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            700
        );
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1b'],
            'width',
            620,
            730
        );
        bridge.endTransaction();

        const log = bridge.getChangeLog();
        const originLayerItems = buildHistoryStackItems(log, {
            glyphName: 'A',
            layerId: 'layer-1'
        });
        const otherWrittenLayerItems = buildHistoryStackItems(log, {
            glyphName: 'A',
            layerId: 'layer-1b'
        });
        const unwrittenLayerItems = buildHistoryStackItems(log, {
            glyphName: 'A',
            layerId: 'layer-1c'
        });

        expect(originLayerItems).toHaveLength(1);
        expect(otherWrittenLayerItems).toHaveLength(1);
        expect(otherWrittenLayerItems[0].id).toBe(originLayerItems[0].id);
        expect(unwrittenLayerItems).toHaveLength(0);
        expect(
            formatHistoryOriginLabel({
                undoScope: originLayerItems[0].undoScope,
                originatingGlyphName: originLayerItems[0].originatingGlyphName,
                originatingLayerId: originLayerItems[0].originatingLayerId,
                changePaths: originLayerItems[0].touchedPaths
            })
        ).toBe('Layer · A');

        expect(bridge.undo('A', 'layer-1b')).not.toBeNull();
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1b', 'width'])
        ).toBe(620);
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1c', 'width'])
        ).toBe(640);

        expect(bridge.redo('A', 'layer-1b')).not.toBeNull();
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1b', 'width'])
        ).toBe(730);

        bridge.destroy();
    });

    test('dependent glyph layers stay off the originating glyph canvas stack', () => {
        resetLogCounter();
        const historyItemId = 'history-cascade';
        const entries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyItemId,
                historyAction: 'change',
                transactionLabel: 'Set sidebearing with dependents',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A:layers.layer-1:width',
                oldValue: 600,
                newValue: 620
            }),
            createLogEntry({
                timestamp: 1,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyItemId,
                historyAction: 'change',
                transactionLabel: 'Set sidebearing with dependents',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.B:layers.layer-2:width',
                oldValue: 650,
                newValue: 680
            })
        ];

        expect(
            buildHistoryStackItems(entries, {
                glyphName: 'A',
                layerId: 'layer-1'
            })
        ).toHaveLength(1);
        expect(
            buildHistoryStackItems(entries, {
                glyphName: 'B',
                layerId: 'layer-2'
            })
        ).toHaveLength(0);
    });

    test('canvas affinity does not put cascade packets on dependent glyph stacks', () => {
        resetLogCounter();
        const historyItemId = 'history-cascade-affinity';
        const entries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyItemId,
                historyAction: 'change',
                transactionLabel: 'Move anchor with dependents',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                undoSurfaceAffinity: 'canvas',
                originatingGlyphName: 'A',
                originatingLayerId: 'layer-1',
                path: 'glyphs.A:layers.layer-1',
                oldValue: { id: 'layer-1' },
                newValue: { id: 'layer-1', anchors: [{ name: 'top' }] },
                workerReplayTargets: [
                    { glyphName: 'A', layerId: 'layer-1' },
                    { glyphName: 'B', layerId: 'layer-2' }
                ]
            }),
            createLogEntry({
                timestamp: 1,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyItemId,
                historyAction: 'change',
                transactionLabel: 'Move anchor with dependents',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                undoSurfaceAffinity: 'canvas',
                originatingGlyphName: 'A',
                originatingLayerId: 'layer-1',
                path: 'glyphs.B:layers.layer-2',
                oldValue: { id: 'layer-2' },
                newValue: { id: 'layer-2', width: 680 },
                workerReplayTargets: [
                    { glyphName: 'A', layerId: 'layer-1' },
                    { glyphName: 'B', layerId: 'layer-2' }
                ]
            })
        ];

        expect(
            buildHistoryStackItems(entries, {
                glyphName: 'A',
                layerId: 'layer-1',
                surface: 'canvas'
            })
        ).toHaveLength(1);
        expect(
            buildHistoryStackItems(entries, {
                glyphName: 'B',
                layerId: 'layer-2',
                surface: 'canvas'
            })
        ).toHaveLength(0);
    });

    test('canvas affinity without an originating layer stays on every canvas context', () => {
        resetLogCounter();
        const entries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyItemId: 'history-kerning',
                historyAction: 'change',
                transactionLabel: 'Edit kerning pair',
                transactionId: 1,
                op: 'set',
                undoScope: 'font',
                undoSurfaceAffinity: 'canvas',
                path: 'masters.master-regular.kerning.A.V',
                oldValue: undefined,
                newValue: -40
            })
        ];

        expect(
            buildHistoryStackItems(entries, {
                glyphName: 'A',
                layerId: 'layer-1',
                surface: 'canvas'
            })
        ).toHaveLength(1);
        expect(
            buildHistoryStackItems(entries, {
                glyphName: 'B',
                layerId: 'layer-2',
                surface: 'canvas'
            })
        ).toHaveLength(1);
    });

    test('resolveCommitOriginatingLayer prefers canvas context over dependent writes', () => {
        expect(
            resolveCommitOriginatingLayer({
                contextSurface: 'canvas',
                contextGlyphName: 'A',
                contextLayerId: 'layer-1',
                operations: [
                    {
                        originatingGlyphName: 'B',
                        originatingLayerId: 'layer-2',
                        path: ['glyphs', 'B', 'layers', 'layer-2']
                    }
                ]
            })
        ).toEqual({ glyphName: 'A', layerId: 'layer-1' });

        expect(
            resolveCommitOriginatingLayer({
                contextSurface: 'canvas',
                contextGlyphName: 'A',
                contextLayerId: null,
                operations: [
                    {
                        path: ['masters', 'master-regular', 'kerning', 'A']
                    }
                ]
            })
        ).toEqual({ glyphName: null, layerId: null });
    });

    test('live canvas cascade commit is undoable only from the originating layer', () => {
        resetUndoRedoContextStickyState();
        const editorView = document.createElement('div');
        editorView.id = 'view-editor';
        editorView.classList.add('focused');
        document.body.appendChild(editorView);

        window.glyphCanvas = {
            outlineEditor: {
                active: true,
                selectedLayerId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'A' }]),
                currentGlyphName: 'A'
            },
            getCurrentGlyphName: jest.fn(() => 'A')
        };

        const fontJson = makeFont();
        const bridge = new ChangeBridge('history-cascade-live');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        bridge.beginTransaction('Move anchor with dependents', null, {
            compileChangeSource: 'test-sync',
            compileEditType: null
        });
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            620
        );
        bridge.recordChange(
            ['glyphs', 'B', 'layers', 'layer-2'],
            'width',
            650,
            680
        );
        bridge.endTransaction();

        expect(bridge.canUndo('A', 'layer-1', null, 'canvas')).toBe(true);
        expect(bridge.canUndo('B', 'layer-2', null, 'canvas')).toBe(false);
        expect(bridge.undo('B', 'layer-2', null, 'canvas')).toBeNull();
        expect(
            bridge.getYValue(['glyphs', 'B', 'layers', 'layer-2', 'width'])
        ).toBe(680);

        expect(bridge.undo('A', 'layer-1', null, 'canvas')).not.toBeNull();
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);
        expect(
            bridge.getYValue(['glyphs', 'B', 'layers', 'layer-2', 'width'])
        ).toBe(650);

        bridge.destroy();
        window.glyphCanvas = undefined;
        resetUndoRedoContextStickyState();
        editorView.remove();
    });

    test('undo resettles derived layers and leaves a later-manual composite in place', () => {
        const fontJson = makeFont();
        const bridge = new ChangeBridge('history-resettle-manual');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        let compositeIsAutomatic = true;
        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: (name) => ({
                        findLayerById: (id) => {
                            const layerId = name === 'B' ? 'layer-2' : id;
                            if (name === 'B' && id !== 'layer-2') {
                                return null;
                            }
                            return {
                                id: layerId,
                                getMatchingLayerOnGlyph: (otherGlyph) => ({
                                    id: otherGlyph === 'B' ? 'layer-2' : layerId
                                }),
                                isAutomaticAlignedLayer: () =>
                                    name === 'B' && compositeIsAutomatic
                            };
                        }
                    }),
                    collectComponentDependentGlyphs: () => new Set(['B']),
                    rebuildAutomaticCompositesForGlyphs: () => {
                        if (!compositeIsAutomatic) {
                            return new Set();
                        }
                        fontJson.glyphs[1].layers[0].width = 400;
                        return new Set(['B']);
                    },
                    recomputeMetricsKeys: () => new Set(),
                    collectMetricsKeyDependentGlyphs: () => new Set()
                }
            }
        };

        bridge.beginTransaction('Move anchor with dependents', null, {
            compileChangeSource: 'test-sync',
            compileEditType: null
        });
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'anchors',
            [],
            [{ name: 'top', x: 10, y: 700 }]
        );
        bridge.recordChange(
            ['glyphs', 'B', 'layers', 'layer-2'],
            'width',
            650,
            777
        );
        bridge.endTransaction();

        compositeIsAutomatic = false;
        bridge.beginTransaction('Turn composite manual', null, {
            compileChangeSource: 'test-sync',
            compileEditType: null
        });
        bridge.recordChange(
            ['glyphs', 'B', 'layers', 'layer-2'],
            'width',
            777,
            999
        );
        bridge.endTransaction();

        expect(
            bridge.getYValue(['glyphs', 'B', 'layers', 'layer-2', 'width'])
        ).toBe(999);

        expect(bridge.undo('A', 'layer-1')).not.toBeNull();
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'anchors'])
        ).toEqual([]);
        expect(
            bridge.getYValue(['glyphs', 'B', 'layers', 'layer-2', 'width'])
        ).toBe(999);

        bridge.destroy();
        window.fontManager = undefined;
    });

    test('undo resettles automatic composites from the restored origin', () => {
        const fontJson = makeFont();
        const bridge = new ChangeBridge('history-resettle-auto');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: (name) => ({
                        findLayerById: (id) => {
                            if (name === 'B' && id !== 'layer-2') {
                                return null;
                            }
                            return {
                                id: name === 'B' ? 'layer-2' : id,
                                getMatchingLayerOnGlyph: (otherGlyph) => ({
                                    id: otherGlyph === 'B' ? 'layer-2' : id
                                }),
                                isAutomaticAlignedLayer: () => name === 'B'
                            };
                        }
                    }),
                    collectComponentDependentGlyphs: () => new Set(['B']),
                    rebuildAutomaticCompositesForGlyphs: () => {
                        fontJson.glyphs[1].layers[0].width = 400;
                        return new Set(['B']);
                    },
                    recomputeMetricsKeys: () => new Set(),
                    collectMetricsKeyDependentGlyphs: () => new Set()
                }
            }
        };

        bridge.beginTransaction('Move anchor with dependents', null, {
            compileChangeSource: 'test-sync',
            compileEditType: null
        });
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'anchors',
            [],
            [{ name: 'top', x: 10, y: 700 }]
        );
        bridge.recordChange(
            ['glyphs', 'B', 'layers', 'layer-2'],
            'width',
            650,
            777
        );
        bridge.endTransaction();

        expect(bridge.undo('A', 'layer-1')).not.toBeNull();
        expect(
            bridge.getYValue(['glyphs', 'B', 'layers', 'layer-2', 'width'])
        ).toBe(400);

        bridge.destroy();
        window.fontManager = undefined;
    });
});
