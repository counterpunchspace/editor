/**
 * History bright rows and Cmd+Z must share one surface filter.
 * Editing View–owned font edits (kerning, etc.) stamp canvas affinity.
 */

const { PatchSyncEngine: ChangeBridge } = require('../../js/patch-sync-engine');
const {
    buildHistoryStackItems,
    createLogEntry,
    getUndoReachabilityForContext,
    resetLogCounter,
    resolveUndoSurfaceAffinity
} = require('../../js/change-log');
const {
    resetUndoRedoContextStickyState
} = require('../../js/undo-redo-context');

function makeFont() {
    return {
        upm: 1000,
        version: [1, 0],
        names: { familyName: 'TestFont' },
        axes: [],
        first_kern_groups: {},
        second_kern_groups: {},
        masters: [
            {
                name: 'Regular',
                id: 'master-regular',
                location: {},
                metrics: {},
                kerning: {},
                guides: [],
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
                    {
                        id: 'layer-1',
                        name: 'Regular',
                        width: 600,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-regular'
                        },
                        shapes: [],
                        anchors: [],
                        guides: []
                    }
                ]
            }
        ]
    };
}

describe('history visibility vs undo actionability', () => {
    let editorView;
    let fontInfoView;
    let overviewView;

    beforeEach(() => {
        resetLogCounter();
        resetUndoRedoContextStickyState();
        document.body.innerHTML = '';

        editorView = document.createElement('div');
        editorView.id = 'view-editor';
        document.body.appendChild(editorView);

        fontInfoView = document.createElement('div');
        fontInfoView.id = 'view-fontinfo';
        document.body.appendChild(fontInfoView);

        overviewView = document.createElement('div');
        overviewView.id = 'view-overview';
        document.body.appendChild(overviewView);

        window.fontInfoManager = {
            getHistoryScopeTarget: jest.fn(() => null)
        };
    });

    afterEach(() => {
        window.patchSyncEngine = undefined;
        window.changeBridge = undefined;
        window.glyphCanvas = undefined;
        window.fontInfoManager = undefined;
        resetUndoRedoContextStickyState();
        document.body.innerHTML = '';
    });

    function focusEditorTextMode() {
        editorView.classList.add('focused');
        fontInfoView.classList.remove('focused');
        overviewView.classList.remove('focused');
        window.glyphCanvas = {
            outlineEditor: {
                active: false,
                selectedLayerId: null,
                parseGlyphStack: jest.fn(() => []),
                currentGlyphName: 'A'
            },
            getCurrentGlyphName: jest.fn(() => 'A')
        };
    }

    function focusEditorEditMode() {
        editorView.classList.add('focused');
        fontInfoView.classList.remove('focused');
        overviewView.classList.remove('focused');
        window.glyphCanvas = {
            outlineEditor: {
                active: true,
                selectedLayerId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'A' }]),
                currentGlyphName: 'A'
            },
            getCurrentGlyphName: jest.fn(() => 'A')
        };
    }

    function focusFontInfo() {
        fontInfoView.classList.add('focused');
        editorView.classList.remove('focused');
        overviewView.classList.remove('focused');
        window.glyphCanvas = {
            outlineEditor: {
                active: false,
                selectedLayerId: null,
                parseGlyphStack: jest.fn(() => []),
                currentGlyphName: 'A'
            },
            getCurrentGlyphName: jest.fn(() => 'A')
        };
    }

    function assertReachabilityMatchesCanUndo(bridge, context) {
        const log = bridge.getChangeLog();
        const { reachableHistoryItemIds, nextUndoHistoryItemId } =
            getUndoReachabilityForContext(log, context);
        const canUndo = bridge.canUndo(
            context.glyphName ?? undefined,
            context.layerId ?? null,
            context.historyTargetKey ?? null,
            context.surface ?? null
        );

        if (!canUndo) {
            expect(nextUndoHistoryItemId).toBeNull();
            return null;
        }

        expect(nextUndoHistoryItemId).toBeTruthy();
        expect(reachableHistoryItemIds.has(nextUndoHistoryItemId)).toBe(true);
        return nextUndoHistoryItemId;
    }

    test('resolveUndoSurfaceAffinity pins kerning paths to canvas without context', () => {
        expect(
            resolveUndoSurfaceAffinity({
                paths: ['masters.master-regular.kerning.A.V']
            })
        ).toBe('canvas');
        expect(
            resolveUndoSurfaceAffinity({
                paths: ['first_kern_groups.@A'],
                contextSurface: 'font'
            })
        ).toBeNull();
        expect(
            resolveUndoSurfaceAffinity({
                paths: ['masters.master-regular.kerning.A.V'],
                editSource: 'python'
            })
        ).toBeNull();
    });

    test('text-mode kerning is reachable and undoable on the Editing View surface', () => {
        focusEditorTextMode();
        const bridge = new ChangeBridge('history-kerning-align');
        bridge.initFromJson(makeFont());
        window.patchSyncEngine = bridge;
        window.changeBridge = bridge;

        bridge.beginTransaction('Edit kerning pair', null, {
            compileChangeSource: 'test-sync',
            compileEditType: null
        });
        bridge.recordChange(
            ['masters', 'master-regular', 'kerning', 'A'],
            'V',
            undefined,
            -40
        );
        bridge.endTransaction();

        const context = {
            glyphName: 'A',
            layerId: null,
            surface: 'canvas'
        };
        const undoId = assertReachabilityMatchesCanUndo(bridge, context);
        expect(undoId).toBeTruthy();

        const canvasItems = buildHistoryStackItems(bridge.getChangeLog(), {
            ...context,
            includeUndone: true
        });
        expect(canvasItems).toHaveLength(1);
        expect(canvasItems[0].undoSurfaceAffinity).toBe('canvas');
        expect(canvasItems[0].undoScope).toBe('font');

        const fontItems = buildHistoryStackItems(bridge.getChangeLog(), {
            surface: 'font',
            includeUndone: true
        });
        expect(fontItems).toHaveLength(0);

        expect(bridge.undo(undefined, null, null, 'canvas')).toBeTruthy();
        expect(bridge.canUndo(undefined, null, null, 'canvas')).toBe(false);
    });

    test('overview surface does not fall through to font kerning undo', () => {
        focusEditorTextMode();
        const bridge = new ChangeBridge('history-no-font-fallback');
        bridge.initFromJson(makeFont());
        window.patchSyncEngine = bridge;
        window.changeBridge = bridge;

        bridge.beginTransaction('Edit kerning pair', null, {
            compileChangeSource: 'test-sync',
            compileEditType: null
        });
        bridge.recordChange(
            ['masters', 'master-regular', 'kerning', 'A'],
            'V',
            undefined,
            -40
        );
        bridge.endTransaction();

        // Kerning was stamped canvas from editor context; overview must not undo it.
        expect(bridge.canUndo(undefined, null, null, 'overview')).toBe(false);
        expect(bridge.undo(undefined, null, null, 'overview')).toBeNull();

        const { reachableHistoryItemIds } = getUndoReachabilityForContext(
            bridge.getChangeLog(),
            { surface: 'overview' }
        );
        expect(reachableHistoryItemIds.size).toBe(0);
    });

    test('canvas make-guide-global stays on Editing View via affinity', () => {
        focusEditorEditMode();
        const bridge = new ChangeBridge('history-guide-affinity');
        bridge.initFromJson(makeFont());
        window.patchSyncEngine = bridge;
        window.changeBridge = bridge;

        bridge.beginTransaction('Make guide global', null, {
            compileChangeSource: 'test-sync',
            compileEditType: null
        });
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'guides',
            [{ name: 'g1' }],
            []
        );
        bridge.recordChange(
            ['masters', 'master-regular'],
            'guides',
            [],
            [{ name: 'g1' }]
        );
        bridge.endTransaction();

        const context = {
            glyphName: 'A',
            layerId: 'layer-1',
            surface: 'canvas'
        };
        const undoId = assertReachabilityMatchesCanUndo(bridge, context);
        expect(undoId).toBeTruthy();

        const items = buildHistoryStackItems(bridge.getChangeLog(), {
            ...context,
            includeUndone: true
        });
        expect(items[0].undoSurfaceAffinity).toBe('canvas');

        focusFontInfo();
        expect(
            buildHistoryStackItems(bridge.getChangeLog(), {
                surface: 'font',
                includeUndone: true
            })
        ).toHaveLength(0);
        expect(bridge.canUndo(undefined, null, null, 'font')).toBe(false);
    });

    test('Font Info names stay on the font surface without canvas affinity', () => {
        focusFontInfo();
        const bridge = new ChangeBridge('history-font-names');
        bridge.initFromJson(makeFont());
        window.patchSyncEngine = bridge;
        window.changeBridge = bridge;

        bridge.beginTransaction('Set family name', null, {
            compileChangeSource: 'test-sync',
            compileEditType: null
        });
        bridge.recordChange(['names'], 'familyName', 'TestFont', 'Other');
        bridge.endTransaction();

        const items = buildHistoryStackItems(bridge.getChangeLog(), {
            surface: 'font',
            includeUndone: true
        });
        expect(items).toHaveLength(1);
        expect(items[0].undoSurfaceAffinity).toBeNull();
        assertReachabilityMatchesCanUndo(bridge, { surface: 'font' });

        expect(bridge.canUndo(undefined, null, null, 'canvas')).toBe(false);
    });

    test('createLogEntry round-trips undoSurfaceAffinity', () => {
        const entry = createLogEntry({
            timestamp: 1,
            windowId: 'main',
            windowRoleLabel: 'Main',
            transactionLabel: 'Edit kerning pair',
            transactionId: 1,
            op: 'set',
            path: 'masters.master-regular.kerning.A.V',
            oldValue: undefined,
            newValue: -10,
            undoScope: 'font',
            undoSurfaceAffinity: 'canvas'
        });
        expect(entry.undoSurfaceAffinity).toBe('canvas');
    });
});
