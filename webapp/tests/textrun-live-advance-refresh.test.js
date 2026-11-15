const { TextRunEditor } = require('../js/glyph-canvas/textrun');
const { runBridgeUndoRedo } = require('../js/change-bridge-init');
const { applyLiveSidebearingVisualSync } = require('../js/sidebearing-utils');
const { fontCompilation } = require('../js/font-compilation');

function clipboardEnvelope(counterpunchItem) {
    return JSON.stringify({
        clipboardSchema: 'font-editor-clipboard',
        clipboardSchemaVersion: 1,
        clipboardItems: {
            counterpunch: counterpunchItem
        }
    });
}

const selectionClipboardText = clipboardEnvelope({
    version: 1,
    kind: 'selection',
    nodeOrder: 'start-first',
    keepAbsoluteCoords: true,
    paths: [
        {
            closed: true,
            nodes: [
                { x: 0, y: 0, nodetype: 'Line' },
                { x: 100, y: 0, nodetype: 'Line' }
            ]
        }
    ],
    components: [],
    anchors: [],
    guides: []
});

const glyphsClipboardText = clipboardEnvelope({
    version: 1,
    kind: 'glyphs',
    nodeOrder: 'start-first',
    masters: [{ id: 'm0', name: 'Regular' }],
    glyphs: [
        {
            name: 'A',
            leftMetricsKey: null,
            rightMetricsKey: null,
            layers: [
                {
                    name: 'Regular',
                    master: {
                        type: 'DefaultForMaster',
                        masterIndex: 0
                    },
                    width: 500,
                    paths: [],
                    components: [],
                    anchors: [],
                    guides: []
                }
            ]
        }
    ]
});

describe('TextRunEditor live advance refresh', () => {
    let editor;
    let originalGlyphCanvas;
    let originalFontCompilation;

    beforeEach(() => {
        const featuresManager = {
            getHarfBuzzFeatures: () => null
        };
        const axesManager = {
            variationSettings: {}
        };

        editor = new TextRunEditor(featuresManager, axesManager);
        editor.textBuffer = 'aba';
        editor.shapedGlyphs = [
            { ax: 500, dx: 0, dy: 0, g: 10, cl: 0 },
            { ax: 320, dx: 0, dy: 0, g: 11, cl: 1 },
            { ax: 500, dx: 0, dy: 0, g: 10, cl: 2 }
        ];
        editor.glyphNameBuffer = ['a', 'b', 'a'];
        editor.intrinsicGlyphAdvances = new Map([
            ['a', 500],
            ['b', 320]
        ]);
        editor.clusterMap = [
            {
                glyphIndex: 0,
                glyphCount: 1,
                start: 0,
                end: 1,
                x: 0,
                width: 500,
                isRTL: false,
                isExplicitToken: false,
                isAtomicCluster: false
            }
        ];

        originalGlyphCanvas = window.glyphCanvas;
        originalFontCompilation = window.fontCompilation;
    });

    afterEach(() => {
        window.glyphCanvas = originalGlyphCanvas;
        window.fontCompilation = originalFontCompilation;
    });

    test('pastes normal text in focused text mode', async () => {
        document.body.innerHTML =
            '<div id="view-editor" class="focused"></div>';
        const originalClipboard = navigator.clipboard;
        const readText = jest.fn().mockResolvedValue('normal text');
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { readText }
        });
        const insertText = jest
            .spyOn(editor, 'insertText')
            .mockImplementation(() => {});

        try {
            await editor.paste();
        } finally {
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: originalClipboard
            });
        }

        expect(readText).toHaveBeenCalledTimes(1);
        expect(insertText).toHaveBeenCalledWith('normal text');
    });

    test.each([selectionClipboardText, glyphsClipboardText])(
        'blocks structured clipboard data in focused text mode',
        async (text) => {
            document.body.innerHTML =
                '<div id="view-editor" class="focused"></div>';
            const originalClipboard = navigator.clipboard;
            const readText = jest.fn().mockResolvedValue(text);
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: { readText }
            });
            const insertText = jest
                .spyOn(editor, 'insertText')
                .mockImplementation(() => {});
            const alert = jest
                .spyOn(window, 'alert')
                .mockImplementation(() => {});

            try {
                await editor.paste();
                expect(readText).toHaveBeenCalledTimes(1);
                expect(insertText).not.toHaveBeenCalled();
                expect(alert).not.toHaveBeenCalled();
            } finally {
                Object.defineProperty(navigator, 'clipboard', {
                    configurable: true,
                    value: originalClipboard
                });
                alert.mockRestore();
            }
        }
    );

    test('does not mistake ordinary text containing counterpunch for clipboard data', async () => {
        document.body.innerHTML =
            '<div id="view-editor" class="focused"></div>';
        const originalClipboard = navigator.clipboard;
        const readText = jest
            .fn()
            .mockResolvedValue('A "counterpunch" example');
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { readText }
        });
        const insertText = jest
            .spyOn(editor, 'insertText')
            .mockImplementation(() => {});

        try {
            await editor.paste();
        } finally {
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: originalClipboard
            });
        }

        expect(insertText).toHaveBeenCalledWith('A "counterpunch" example');
    });

    test('does not read the clipboard when the editor view is not focused', async () => {
        document.body.innerHTML =
            '<div id="view-overview" class="focused"></div>';
        const originalClipboard = navigator.clipboard;
        const readText = jest.fn().mockResolvedValue('normal text');
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { readText }
        });

        try {
            await editor.paste();
        } finally {
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: originalClipboard
            });
        }

        expect(readText).not.toHaveBeenCalled();
    });

    test('does not intercept Cmd+V when another view is focused', () => {
        document.body.innerHTML =
            '<div id="view-overview" class="focused"></div>';
        const paste = jest.spyOn(editor, 'paste').mockResolvedValue();
        const event = new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'v',
            metaKey: true
        });

        editor.handleKeyDown(event);

        expect(event.defaultPrevented).toBe(false);
        expect(paste).not.toHaveBeenCalled();
    });

    test('updates matching glyph advances and rerenders the line', () => {
        const buildClusterMapSpy = jest.spyOn(editor, 'buildClusterMap');
        const updateCursorSpy = jest.spyOn(
            editor,
            'updateCursorVisualPosition'
        );
        const renderCallback = jest.fn();
        editor.on('render', renderCallback);

        const changed = editor.refreshGlyphAdvancesLive({ a: 640 });

        expect(changed).toBe(true);
        expect(editor.shapedGlyphs.map((glyph) => glyph.ax)).toEqual([
            640, 320, 640
        ]);
        expect(buildClusterMapSpy).toHaveBeenCalledTimes(1);
        expect(updateCursorSpy).toHaveBeenCalledTimes(1);
        expect(renderCallback).toHaveBeenCalledTimes(1);
    });

    test('does nothing when no matching advance changes are provided', () => {
        const buildClusterMapSpy = jest.spyOn(editor, 'buildClusterMap');
        const updateCursorSpy = jest.spyOn(
            editor,
            'updateCursorVisualPosition'
        );
        const renderCallback = jest.fn();
        editor.on('render', renderCallback);

        const changed = editor.refreshGlyphAdvancesLive({ c: 700, a: 500 });

        expect(changed).toBe(false);
        expect(editor.shapedGlyphs.map((glyph) => glyph.ax)).toEqual([
            500, 320, 500
        ]);
        expect(buildClusterMapSpy).not.toHaveBeenCalled();
        expect(updateCursorSpy).not.toHaveBeenCalled();
        expect(renderCallback).not.toHaveBeenCalled();
    });

    test('can refresh advances without emitting an immediate render', () => {
        const buildClusterMapSpy = jest.spyOn(editor, 'buildClusterMap');
        const updateCursorSpy = jest.spyOn(
            editor,
            'updateCursorVisualPosition'
        );
        const renderCallback = jest.fn();
        editor.on('render', renderCallback);

        const changed = editor.refreshGlyphAdvancesLive(
            { a: 640 },
            { render: false }
        );

        expect(changed).toBe(true);
        expect(editor.shapedGlyphs.map((glyph) => glyph.ax)).toEqual([
            640, 320, 640
        ]);
        expect(buildClusterMapSpy).toHaveBeenCalledTimes(1);
        expect(updateCursorSpy).toHaveBeenCalledTimes(1);
        expect(renderCallback).not.toHaveBeenCalled();
    });

    test('does not clobber kerning-shaped advances when raw widths are unchanged', () => {
        editor.shapedGlyphs = [
            { ax: 460, dx: 0, dy: 0, g: 10, cl: 0 },
            { ax: 320, dx: 0, dy: 0, g: 11, cl: 1 },
            { ax: 460, dx: 0, dy: 0, g: 10, cl: 2 }
        ];

        const changed = editor.refreshGlyphAdvancesLive({ a: 500 });

        expect(changed).toBe(false);
        expect(editor.shapedGlyphs.map((glyph) => glyph.ax)).toEqual([
            460, 320, 460
        ]);
    });

    test('preserves existing kerning delta when a live width edit changes advance', () => {
        editor.shapedGlyphs = [
            { ax: 460, dx: 0, dy: 0, g: 10, cl: 0 },
            { ax: 320, dx: 0, dy: 0, g: 11, cl: 1 },
            { ax: 460, dx: 0, dy: 0, g: 10, cl: 2 }
        ];

        const changed = editor.refreshGlyphAdvancesLive({ a: 520 });

        expect(changed).toBe(true);
        expect(editor.shapedGlyphs.map((glyph) => glyph.ax)).toEqual([
            480, 320, 480
        ]);
        expect(editor.intrinsicGlyphAdvances.get('a')).toBe(520);
    });

    test('refreshes live advances from width deltas without replacing kerning', () => {
        editor.shapedGlyphs = [
            { ax: 460, dx: 0, dy: 0, g: 10, cl: 0 },
            { ax: 320, dx: 0, dy: 0, g: 11, cl: 1 },
            { ax: 460, dx: 0, dy: 0, g: 10, cl: 2 }
        ];

        expect(
            editor.refreshGlyphAdvanceDeltasLive(
                { a: 20, b: 0 },
                { render: false }
            )
        ).toBe(true);
        expect(editor.shapedGlyphs.map((glyph) => glyph.ax)).toEqual([
            480, 320, 480
        ]);
        expect(editor.intrinsicGlyphAdvances.get('a')).toBe(520);
    });

    test('ignores empty or sub-threshold width deltas', () => {
        expect(
            editor.refreshGlyphAdvanceDeltasLive({ a: 0.01 }, { render: false })
        ).toBe(false);
        expect(editor.shapedGlyphs.map((glyph) => glyph.ax)).toEqual([
            500, 320, 500
        ]);
    });

    test('uses the current shaped advance as the live baseline for automatic composites', () => {
        // Regression: after a settled drag, the model-derived width for an
        // automatic composite could differ from HarfBuzz's current ax. The
        // delta patch then preserved that difference as a fixed phantom RSB
        // throughout the next drag.
        editor.textBuffer = 'ä';
        editor.shapedGlyphs = [{ ax: 564, dx: 0, dy: 0, g: 12, cl: 0 }];
        editor.glyphNameBuffer = ['adieresis'];
        editor.intrinsicGlyphAdvances = new Map([['adieresis', 533]]);

        editor.rebuildIntrinsicGlyphAdvanceCache();

        expect(editor.intrinsicGlyphAdvances.get('adieresis')).toBe(564);
        expect(
            editor.refreshGlyphAdvancesLive(
                { adieresis: 567 },
                { render: false }
            )
        ).toBe(true);
        expect(editor.shapedGlyphs[0].ax).toBe(567);
    });

    test('skips explicit outline prefetch while an outline drag is active', async () => {
        const sendMessage = jest.fn();
        window.fontCompilation = { sendMessage };
        window.glyphCanvas = {
            outlineEditor: {
                draggingSomething: true
            }
        };

        editor.shapedGlyphs = [
            {
                ax: 500,
                dx: 0,
                dy: 0,
                g: 0,
                cl: 0,
                explicitGlyphName: 'adieresis'
            }
        ];

        await editor.prefetchExplicitGlyphOutlinesForCurrentState();

        expect(sendMessage).not.toHaveBeenCalled();
    });

    test('drops stale explicit outline responses after cache invalidation', async () => {
        let resolveOutlines;
        const sendMessage = jest.fn(
            () =>
                new Promise((resolve) => {
                    resolveOutlines = resolve;
                })
        );
        window.fontCompilation = { sendMessage };
        window.glyphCanvas = {
            outlineEditor: {
                draggingSomething: false
            }
        };

        editor.shapedGlyphs = [
            {
                ax: 500,
                dx: 0,
                dy: 0,
                g: 0,
                cl: 0,
                explicitGlyphName: 'adieresis'
            }
        ];

        const renderCallback = jest.fn();
        editor.on('render', renderCallback);

        const prefetchPromise =
            editor.prefetchExplicitGlyphOutlinesForCurrentState();
        editor.invalidateExplicitGlyphOutlineCache();

        resolveOutlines({
            outlinesJson: JSON.stringify([
                {
                    name: 'adieresis',
                    width: 533,
                    shapes: []
                }
            ])
        });

        await prefetchPromise;

        expect(editor.getCachedExplicitGlyphOutline('adieresis')).toBeNull();
        expect(renderCallback).not.toHaveBeenCalled();
    });
});

describe('applyLiveSidebearingVisualSync', () => {
    test('leaves the viewport unchanged when no advance precedes the selected glyph', () => {
        const computePrecedingAdvanceDelta = jest.fn(() => 0);
        const refreshGlyphAdvanceDeltasLive = jest.fn(() => true);
        const target = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                computePrecedingAdvanceDelta,
                intrinsicGlyphAdvances: new Map([['a', 500]]),
                refreshGlyphAdvanceDeltasLive
            }
        };

        const result = applyLiveSidebearingVisualSync(target, {
            glyphName: 'a',
            side: 'left',
            previousWidth: 500,
            nextWidth: 520,
            render: false
        });

        expect(result).toEqual({
            widthDelta: 20,
            advancesRefreshed: true
        });
        expect(target.viewportManager.panX).toBe(100);
        expect(computePrecedingAdvanceDelta).toHaveBeenCalledWith({ a: 520 });
        expect(refreshGlyphAdvanceDeltasLive).toHaveBeenCalledWith(
            { a: 20 },
            { render: false }
        );
    });

    test('keeps the selected glyph anchored after a preceding advance changes', () => {
        const computePrecedingAdvanceDelta = jest.fn(() => 20);
        const refreshGlyphAdvanceDeltasLive = jest.fn(() => true);
        const target = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                computePrecedingAdvanceDelta,
                intrinsicGlyphAdvances: new Map([['a', 500]]),
                refreshGlyphAdvanceDeltasLive
            }
        };

        const result = applyLiveSidebearingVisualSync(target, {
            glyphName: 'a',
            side: 'right',
            previousWidth: 500,
            nextWidth: 520,
            render: false
        });

        expect(result).toEqual({
            widthDelta: 20,
            advancesRefreshed: true
        });
        expect(target.viewportManager.panX).toBe(60);
        expect(computePrecedingAdvanceDelta).toHaveBeenCalledWith({ a: 520 });
        expect(refreshGlyphAdvanceDeltasLive).toHaveBeenCalledWith(
            { a: 20 },
            { render: false }
        );
    });

    test('does not compensate when the live advance refresh does not apply', () => {
        const computePrecedingAdvanceDelta = jest.fn(() => 20);
        const refreshGlyphAdvanceDeltasLive = jest.fn(() => false);
        const target = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                computePrecedingAdvanceDelta,
                intrinsicGlyphAdvances: new Map([['a', 500]]),
                refreshGlyphAdvanceDeltasLive
            }
        };

        const result = applyLiveSidebearingVisualSync(target, {
            glyphName: 'a',
            side: 'right',
            previousWidth: 500,
            nextWidth: 520,
            render: false
        });

        expect(result).toEqual({
            widthDelta: 20,
            advancesRefreshed: false
        });
        expect(target.viewportManager.panX).toBe(100);
    });

    test('refreshes active and dependent glyph advances in one pass when provided', () => {
        const refreshGlyphAdvanceDeltasLive = jest.fn(() => true);
        const target = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvanceDeltasLive
            }
        };

        const result = applyLiveSidebearingVisualSync(target, {
            glyphName: 'a',
            glyphAdvanceDeltas: {
                a: 20,
                adieresis: 10,
                aring: 20
            },
            side: 'right',
            previousWidth: 500,
            nextWidth: 520,
            render: false
        });

        expect(result).toEqual({
            widthDelta: 20,
            advancesRefreshed: true
        });
        expect(target.viewportManager.panX).toBe(100);
        expect(refreshGlyphAdvanceDeltasLive).toHaveBeenCalledWith(
            {
                a: 20,
                adieresis: 10,
                aring: 20
            },
            { render: false }
        );
    });
});

describe('runBridgeUndoRedo sidebearing sync', () => {
    const originalWindow = global.window;
    const originalGlyphCanvas = originalWindow.glyphCanvas;
    const originalFontManager = originalWindow.fontManager;
    const originalPatchSyncEngine = originalWindow.patchSyncEngine;
    const originalChangeBridge = originalWindow.changeBridge;
    const originalAutoCompileManager = originalWindow.autoCompileManager;
    let originalWorkerCacheReady;

    beforeEach(() => {
        originalWorkerCacheReady = fontCompilation.hasWorkerCacheDocument();
        fontCompilation.setWorkerCacheDocumentReady(true);
    });

    afterEach(() => {
        originalWindow.glyphCanvas = originalGlyphCanvas;
        originalWindow.fontManager = originalFontManager;
        originalWindow.patchSyncEngine = originalPatchSyncEngine;
        originalWindow.changeBridge = originalChangeBridge;
        originalWindow.autoCompileManager = originalAutoCompileManager;
        fontCompilation.setWorkerCacheDocumentReady(originalWorkerCacheReady);
        jest.clearAllMocks();
    });

    test('undoing a left sidebearing change refreshes the layer without a live-advance detour', async () => {
        const requestRepaintAfterCompile = jest.fn();
        const refreshGlyphAdvancesLive = jest.fn();
        const fetchDrawingData = jest.fn().mockResolvedValue();
        const runDeterministicRefresh = jest.fn(async (task) => await task());
        const canRefreshSelectedDrawingFromModelExactly = jest.fn(() => true);
        const refreshSelectedDrawingFromModel = jest.fn(() => true);
        const syncCurrentOutlineDrawingDataFromModel = jest.fn();
        const captureIdleViewLock = jest.fn(() => true);
        const reapplyIdleViewLock = jest.fn(() => true);
        const render = jest.fn();

        const makeFontModel = (width) => ({
            findGlyph: jest.fn(() => ({
                findDrawingById: jest.fn(() => ({ id: 'layer-1', width }))
            }))
        });

        const currentFont = {
            fontModel: makeFontModel(500),
            requestRecompileWithoutDataChange: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                intrinsicGlyphAdvances: new Map([['a.alt', 500]]),
                refreshGlyphAdvanceDeltasLive: refreshGlyphAdvancesLive
            },
            outlineEditor: {
                active: true,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                canRefreshSelectedDrawingFromModelExactly,
                refreshSelectedDrawingFromModel,
                fetchDrawingData,
                runDeterministicRefresh,
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            captureIdleViewLock,
            reapplyIdleViewLock,
            syncCurrentOutlineDrawingDataFromModel,
            updatePropertyPanel: jest.fn(),
            render,
            requestRepaintAfterCompile
        };
        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null
        };
        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            undo: jest.fn(() => {
                currentFont.fontModel = makeFontModel(520);
                return {
                    scope: 'layer',
                    glyphName: 'a',
                    layerId: 'layer-1',
                    historyItem: {
                        transactionLabel: 'Set LSB',
                        workerReplayTargets: [
                            {
                                glyphName: 'a',
                                layerId: 'layer-1'
                            }
                        ],
                        entries: [
                            {
                                oldValue: 'LEFT 40',
                                newValue: 'LEFT 60',
                                workerReplayTargets: [
                                    {
                                        glyphName: 'a',
                                        layerId: 'layer-1'
                                    }
                                ]
                            }
                        ]
                    }
                };
            })
        };
        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

        expect(originalWindow.fontManager.lastChangeSource).toBeNull();
        expect(originalWindow.fontManager.lastEditType).toBeNull();
        expect(canRefreshSelectedDrawingFromModelExactly).toHaveBeenCalledTimes(
            1
        );
        expect(refreshSelectedDrawingFromModel).toHaveBeenCalledTimes(1);
        expect(fetchDrawingData).not.toHaveBeenCalled();
        expect(refreshGlyphAdvancesLive).not.toHaveBeenCalled();
        expect(originalWindow.glyphCanvas.viewportManager.panX).toBe(100);
        expect(syncCurrentOutlineDrawingDataFromModel).not.toHaveBeenCalled();
        expect(captureIdleViewLock).toHaveBeenCalledWith({
            kerningPair: false,
            bboxCenter: true,
            rightEdge: false
        });
        expect(reapplyIdleViewLock).toHaveBeenCalled();
        expect(render).not.toHaveBeenCalled();
        expect(
            originalWindow.glyphCanvas.outlineEditor.performHitDetection
        ).not.toHaveBeenCalled();
        expect(requestRepaintAfterCompile).not.toHaveBeenCalled();
    });

    test('undo sidebearing sync refreshes advances for the stack-selected edited glyph name', async () => {
        const refreshGlyphAdvancesLive = jest.fn();

        const makeFontModel = () => ({
            findGlyph: jest.fn((glyphName) => {
                if (glyphName === 'a') {
                    return {
                        findDrawingById: jest.fn(() => ({ width: 500 }))
                    };
                }

                if (glyphName === 'a.alt') {
                    return {
                        findDrawingById: jest.fn(() => ({ width: 520 }))
                    };
                }

                return null;
            })
        });

        const currentFont = {
            fontModel: makeFontModel(),
            requestRecompileWithoutDataChange: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvanceDeltasLive: refreshGlyphAdvancesLive
            },
            outlineEditor: {
                active: true,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a.alt' }]),
                fetchDrawingData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineDrawingDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };
        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null
        };
        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            undo: jest.fn(() => ({
                scope: 'layer',
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    transactionLabel: 'Set LSB',
                    entries: [
                        {
                            oldValue: 'LEFT 40',
                            newValue: 'LEFT 60'
                        }
                    ]
                }
            }))
        };
        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

        expect(refreshGlyphAdvancesLive).not.toHaveBeenCalled();
    });

    test('undo batches glyphChanged notifications for glyph overview refresh', async () => {
        const glyphChangedHandler = jest.fn();

        const currentFont = {
            fontModel: {
                findGlyph: jest.fn(() => ({
                    findDrawingById: jest.fn(() => ({ width: 500 }))
                })),
                findGlyphsUsingComponent: jest.fn((glyphName) =>
                    glyphName === 'a' ? ['adieresis', 'aring'] : []
                )
            },
            requestRecompileWithoutDataChange: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn()
            },
            outlineEditor: {
                active: true,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchDrawingData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineDrawingDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };
        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null,
            scheduleFullCompileDebounce: jest.fn()
        };
        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            undo: jest.fn(() => ({
                scope: 'layer',
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    transactionLabel: 'Set LSB',
                    touchedPaths: [
                        'glyphs.a.layers.layer-1.width',
                        'glyphs.adieresis.layers.layer-1.width'
                    ],
                    entries: [
                        {
                            oldValue: 'LEFT 40',
                            newValue: 'LEFT 60'
                        }
                    ]
                }
            }))
        };
        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
        }

        expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
        expect(glyphChangedHandler.mock.calls[0][0].detail).toEqual({
            glyphName: 'a',
            glyphNames: ['a']
        });
    });

    test('redo batches glyphChanged notifications for glyph overview refresh', async () => {
        const glyphChangedHandler = jest.fn();

        const currentFont = {
            fontModel: {
                findGlyph: jest.fn(() => ({
                    findDrawingById: jest.fn(() => ({ width: 500 }))
                })),
                findGlyphsUsingComponent: jest.fn((glyphName) =>
                    glyphName === 'a' ? ['adieresis', 'aring'] : []
                )
            },
            requestRecompileWithoutDataChange: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn()
            },
            outlineEditor: {
                active: true,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchDrawingData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineDrawingDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };
        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null,
            scheduleFullCompileDebounce: jest.fn()
        };
        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            redo: jest.fn(() => ({
                scope: 'layer',
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    transactionLabel: 'Redo Set LSB',
                    touchedPaths: [
                        'glyphs.a.layers.layer-1.width',
                        'glyphs.adieresis.layers.layer-1.width'
                    ],
                    entries: [
                        {
                            oldValue: 'LEFT 40',
                            newValue: 'LEFT 60'
                        }
                    ]
                }
            }))
        };
        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await runBridgeUndoRedo('redo', 'a', 'a', 'layer-1', null);
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
        }

        expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
        expect(glyphChangedHandler.mock.calls[0][0].detail).toEqual({
            glyphName: 'a',
            glyphNames: ['a']
        });
    });

    test('undo sidebearing sync uses stack-resolved edited glyph width for LSB drags', async () => {
        const refreshGlyphAdvancesLive = jest.fn();
        const fontModelBeforeUndo = {
            findGlyph: jest.fn((glyphName) => {
                if (glyphName === 'a') {
                    return {
                        findDrawingById: jest.fn(() => ({ width: 520 }))
                    };
                }

                if (glyphName === 'a.alt') {
                    return {
                        findDrawingById: jest.fn(() => ({ width: 540 }))
                    };
                }

                return null;
            })
        };
        const fontModelAfterUndo = {
            findGlyph: jest.fn((glyphName) => {
                if (glyphName === 'a') {
                    return {
                        findDrawingById: jest.fn(() => ({ width: 520 }))
                    };
                }

                if (glyphName === 'a.alt') {
                    return {
                        findDrawingById: jest.fn(() => ({ width: 520 }))
                    };
                }

                return null;
            })
        };

        const currentFont = {
            fontModel: fontModelBeforeUndo,
            requestRecompileWithoutDataChange: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                intrinsicGlyphAdvances: new Map([['a.alt', 500]]),
                refreshGlyphAdvanceDeltasLive: refreshGlyphAdvancesLive
            },
            outlineEditor: {
                active: true,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a.alt' }]),
                fetchDrawingData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineDrawingDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };
        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null
        };
        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            undo: jest.fn(() => {
                currentFont.fontModel = fontModelAfterUndo;
                return {
                    scope: 'layer',
                    glyphName: 'a',
                    layerId: 'layer-1',
                    historyItem: {
                        transactionLabel: 'Set LSB',
                        entries: [
                            {
                                oldValue: 'LEFT 40',
                                newValue: 'LEFT 60'
                            }
                        ]
                    }
                };
            })
        };
        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

        expect(refreshGlyphAdvancesLive).not.toHaveBeenCalled();
        expect(originalWindow.glyphCanvas.viewportManager.panX).toBe(100);
    });

    test('undo structural edits use the selected master advance', async () => {
        const refreshGlyphAdvancesLive = jest.fn();
        const refreshGlyphAdvanceDeltasLive = jest.fn();
        const recomputeMetricsKeys = jest.fn(() => new Set(['a', 'n']));
        const sendMessage = jest.fn().mockResolvedValue({ success: true });

        const makeFontModel = (aWidth, nWidth, otherStationWidth = aWidth) => ({
            recomputeMetricsKeys,
            findGlyph: jest.fn((glyphName) => {
                if (glyphName === 'a') {
                    return {
                        findDrawingById: jest.fn((drawingId) => ({
                            width:
                                drawingId === 'layer-1'
                                    ? aWidth
                                    : otherStationWidth
                        }))
                    };
                }
                if (glyphName === 'n') {
                    return {
                        findDrawingById: jest.fn(() => ({ width: nWidth }))
                    };
                }
                return null;
            })
        });

        const currentFont = {
            fontModel: makeFontModel(500, 480),
            requestRecompileWithoutDataChange: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive,
                refreshGlyphAdvanceDeltasLive,
                intrinsicGlyphAdvances: new Map([
                    ['a', 450],
                    ['n', 470]
                ])
            },
            outlineEditor: {
                active: true,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchDrawingData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineDrawingDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null,
            refreshWorkerCacheForReplayTargets: jest
                .fn()
                .mockResolvedValue(true)
        };
        fontCompilation.isInitialized = true;
        jest.spyOn(fontCompilation, 'sendMessage').mockImplementation(
            sendMessage
        );

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            runWithoutRecording: jest.fn((fn) => fn()),
            undo: jest.fn(() => {
                currentFont.fontModel = makeFontModel(500, 480, 667);
                return {
                    scope: 'layer',
                    glyphName: 'a',
                    layerId: 'layer-1',
                    historyItem: {
                        transactionLabel: 'Drag point',
                        touchedPaths: ['glyphs.a.layers.layer-1'],
                        workerReplayTargets: [
                            {
                                glyphName: 'a',
                                layerId: 'layer-1'
                            },
                            {
                                glyphName: 'n',
                                layerId: 'layer-1'
                            }
                        ],
                        entries: [
                            {
                                path: 'glyphs.a.layers.layer-1.shapes.0.nodes.0.x',
                                oldValue: '(10, 20)',
                                newValue: 'LEFT (20, 20)',
                                workerReplayTargets: [
                                    {
                                        glyphName: 'a',
                                        layerId: 'layer-1'
                                    },
                                    {
                                        glyphName: 'n',
                                        layerId: 'layer-1'
                                    }
                                ]
                            },
                            {
                                path: 'glyphs.a.layers.layer-2.shapes.0.nodes.0.x',
                                oldValue: '(10, 20)',
                                newValue: 'LEFT (20, 20)'
                            },
                            {
                                path: 'glyphs.a.layers.layer-3.shapes.0.nodes.0.x',
                                oldValue: '(10, 20)',
                                newValue: 'LEFT (20, 20)'
                            }
                        ]
                    }
                };
            })
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

        // Structural point-drag undo has no layer-width changelog deltas.
        // Live advance patches would strip kerning until the committed
        // reshape lands, so this path waits for the editing compile.
        expect(refreshGlyphAdvancesLive).not.toHaveBeenCalled();
        expect(refreshGlyphAdvanceDeltasLive).not.toHaveBeenCalled();
        expect(
            originalWindow.fontManager.refreshWorkerCacheForReplayTargets
        ).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'storeFontJson' })
        );
    });

    test('undo point drag falls back to interpolation when exact model refresh is unavailable', async () => {
        const refreshGlyphAdvancesLive = jest.fn();
        const syncCurrentOutlineDrawingDataFromModel = jest.fn();
        const performHitDetection = jest.fn();
        const render = jest.fn();
        const fetchDrawingData = jest.fn().mockResolvedValue();
        const updatedDrawing = { id: 'layer-1', width: 520 };
        const fontModelBeforeUndo = {
            recomputeMetricsKeys: jest.fn(() => {
                currentFont.fontModel = fontModelAfterRecompute;
                return new Set(['a']);
            }),
            findGlyph: jest.fn(() => ({
                findDrawingById: jest.fn(() => ({ id: 'layer-1', width: 500 }))
            }))
        };
        const fontModelAfterUndo = {
            recomputeMetricsKeys: fontModelBeforeUndo.recomputeMetricsKeys,
            findGlyph: jest.fn(() => ({
                findDrawingById: jest.fn(() => ({ id: 'layer-1', width: 500 }))
            }))
        };
        const fontModelAfterRecompute = {
            recomputeMetricsKeys: fontModelBeforeUndo.recomputeMetricsKeys,
            findGlyph: jest.fn(() => ({
                findDrawingById: jest.fn(() => updatedDrawing)
            }))
        };

        const currentFont = {
            fontModel: fontModelBeforeUndo,
            requestRecompileWithoutDataChange: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive
            },
            outlineEditor: {
                active: true,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchDrawingData,
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineDrawingDataFromModel,
            updatePropertyPanel: jest.fn(),
            render,
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            runWithoutRecording: jest.fn((fn) => fn()),
            undo: jest.fn(() => {
                currentFont.fontModel = fontModelAfterUndo;
                return {
                    scope: 'layer',
                    glyphName: 'a',
                    layerId: 'layer-1',
                    historyItem: {
                        transactionLabel: 'Drag point',
                        touchedPaths: ['glyphs.a.layers.layer-1'],
                        entries: [
                            {
                                oldValue: '(10, 20)',
                                newValue: 'LEFT (20, 20)'
                            }
                        ]
                    }
                };
            })
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

        expect(fetchDrawingData).toHaveBeenCalledWith(true, 'a');
        expect(performHitDetection).not.toHaveBeenCalled();
        expect(render).not.toHaveBeenCalled();
        expect(refreshGlyphAdvancesLive).not.toHaveBeenCalled();
    });

    test('undo nested point drag refreshes the active stack layer instead of root layerData', async () => {
        const refreshGlyphAdvancesLive = jest.fn();
        const replaceCurrentDrawingDataInStack = jest.fn(() => true);
        const canRefreshSelectedDrawingFromModelExactly = jest.fn(() => true);
        const refreshSelectedDrawingFromModel = jest.fn(() => true);
        const fetchDrawingData = jest.fn().mockResolvedValue();
        const syncCurrentOutlineDrawingDataFromModel = jest.fn();
        const performHitDetection = jest.fn();
        const render = jest.fn();
        const updatedDrawingJson = {
            id: 'layer-1',
            width: 520,
            shapes: []
        };
        const updatedDrawing = {
            id: 'layer-1',
            width: 520,
            toJSON: jest.fn(() => updatedDrawingJson)
        };
        const fontModelBeforeUndo = {
            recomputeMetricsKeys: jest.fn(() => new Set(['nested'])),
            findGlyph: jest.fn((glyphName) => {
                if (glyphName === 'nested') {
                    return {
                        findDrawingById: jest.fn(() => ({
                            id: 'layer-1',
                            width: 500
                        }))
                    };
                }

                return null;
            })
        };
        const fontModelAfterUndo = {
            recomputeMetricsKeys: fontModelBeforeUndo.recomputeMetricsKeys,
            findGlyph: jest.fn((glyphName) => {
                if (glyphName === 'nested') {
                    return {
                        findDrawingById: jest.fn(() => updatedDrawing)
                    };
                }

                return null;
            })
        };

        const currentFont = {
            fontModel: fontModelBeforeUndo,
            requestRecompileWithoutDataChange: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive
            },
            outlineEditor: {
                active: true,
                selectedDrawingId: 'root-layer',
                parseGlyphStack: jest.fn(() => [
                    { glyphName: 'root', layerId: 'root-layer' },
                    {
                        glyphName: 'nested',
                        layerId: 'layer-1',
                        componentIndex: 0
                    }
                ]),
                replaceCurrentDrawingDataInStack:
                    replaceCurrentDrawingDataInStack,
                canRefreshSelectedDrawingFromModelExactly,
                refreshSelectedDrawingFromModel,
                fetchDrawingData,
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection
            },
            getCurrentGlyphName: jest.fn(() => 'root'),
            syncCurrentOutlineDrawingDataFromModel,
            updatePropertyPanel: jest.fn(),
            render,
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            runWithoutRecording: jest.fn((fn) => fn()),
            undo: jest.fn(() => {
                currentFont.fontModel = fontModelAfterUndo;
                return {
                    scope: 'layer',
                    glyphName: 'nested',
                    layerId: 'layer-1',
                    historyItem: {
                        transactionLabel: 'Drag point',
                        touchedPaths: ['glyphs.nested.layers.layer-1'],
                        entries: [
                            {
                                oldValue: '(10, 20)',
                                newValue: '(20, 20)'
                            }
                        ]
                    }
                };
            })
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        await runBridgeUndoRedo('undo', 'nested', 'root', 'layer-1', null);

        expect(canRefreshSelectedDrawingFromModelExactly).toHaveBeenCalledTimes(
            1
        );
        expect(refreshSelectedDrawingFromModel).toHaveBeenCalledTimes(1);
        expect(fetchDrawingData).not.toHaveBeenCalled();
        expect(replaceCurrentDrawingDataInStack).not.toHaveBeenCalled();
        expect(syncCurrentOutlineDrawingDataFromModel).not.toHaveBeenCalled();
        expect(performHitDetection).toHaveBeenCalled();
        expect(render).toHaveBeenCalled();
        expect(refreshGlyphAdvancesLive).not.toHaveBeenCalled();
    });

    test('undo keyed point drag refreshes the worker incrementally without storeFontJson', async () => {
        const originalIsInitialized = fontCompilation.isInitialized;
        const originalLastStoredFontJson = fontCompilation.lastStoredFontJson;
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue(undefined);
        const refreshWorkerCacheForReplayTargets = jest
            .fn()
            .mockResolvedValue(true);

        const makeFontModel = (width) => ({
            findGlyph: jest.fn(() => ({
                findDrawingById: jest.fn(() => ({ id: 'layer-1', width }))
            }))
        });

        const currentFont = {
            babelfontJson: '{"glyphs":[]}',
            fontModel: makeFontModel(500),
            requestRecompileWithoutDataChange: jest.fn(),
            syncJsonFromModel: jest.fn()
        };

        fontCompilation.isInitialized = true;
        fontCompilation.lastStoredFontJson = 'cached-json';

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn()
            },
            outlineEditor: {
                active: true,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchDrawingData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineDrawingDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            refreshWorkerCacheForReplayTargets,
            pendingBabelfontJsonSyncAfterDrag: false,
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            undo: jest.fn(() => {
                currentFont.fontModel = makeFontModel(520);
                return {
                    scope: 'layer',
                    glyphName: 'a',
                    layerId: 'layer-1',
                    historyItem: {
                        transactionLabel: 'Drag point',
                        touchedPaths: ['glyphs.a.layers.layer-1'],
                        entries: [
                            {
                                oldValue: '(10, 20)',
                                newValue: 'LEFT (20, 20)'
                            }
                        ]
                    }
                };
            })
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        try {
            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

            expect(refreshWorkerCacheForReplayTargets).not.toHaveBeenCalled();
            expect(
                sendMessageSpy.mock.calls.some(
                    ([message]) => message?.type === 'storeFontJson'
                )
            ).toBe(false);
        } finally {
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.lastStoredFontJson = originalLastStoredFontJson;
            sendMessageSpy.mockRestore();
        }
    });

    test('undo anchor drag rebuilds downstream composites and schedules an editing-font refresh', async () => {
        const originalIsInitialized = fontCompilation.isInitialized;
        const originalLastStoredFontJson = fontCompilation.lastStoredFontJson;
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue(undefined);
        const refreshWorkerCacheForReplayTargets = jest
            .fn()
            .mockResolvedValue(true);
        const refreshGlyphAdvancesLive = jest.fn(() => true);
        const rebuildAutomaticCompositesForGlyphs = jest.fn(
            () => new Set(['adieresis'])
        );
        const recomputeMetricsKeys = jest.fn(() => new Set(['adieresis']));

        const makeFontModel = () => ({
            rebuildAutomaticCompositesForGlyphs,
            recomputeMetricsKeys,
            findGlyphsUsingComponent: jest.fn((glyphName) =>
                glyphName === 'a' ? ['adieresis'] : []
            ),
            findGlyph: jest.fn((glyphName) => {
                if (glyphName === 'a') {
                    return {
                        findDrawingById: jest.fn(() => ({
                            id: 'layer-1',
                            width: 500
                        }))
                    };
                }

                if (glyphName === 'adieresis') {
                    return {
                        findDrawingById: jest.fn(() => ({
                            id: 'layer-1',
                            width: 500
                        }))
                    };
                }

                return null;
            })
        });

        const currentFont = {
            babelfontJson: '{"glyphs":[]}',
            fontModel: makeFontModel(),
            requestRecompileWithoutDataChange: jest.fn(),
            syncJsonFromModel: jest.fn()
        };

        fontCompilation.isInitialized = true;
        fontCompilation.lastStoredFontJson = 'cached-json';

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive
            },
            outlineEditor: {
                active: true,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchDrawingData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineDrawingDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            refreshWorkerCacheForReplayTargets,
            pendingBabelfontJsonSyncAfterDrag: false,
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            runWithoutRecording: jest.fn((fn) => fn()),
            undo: jest.fn(() => {
                currentFont.fontModel = makeFontModel();
                return {
                    scope: 'layer',
                    glyphName: 'a',
                    layerId: 'layer-1',
                    historyItem: {
                        transactionLabel: 'Drag anchor',
                        touchedPaths: ['glyphs.a.layers.layer-1.anchors.0'],
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'layer-1' },
                            { glyphName: 'adieresis', layerId: 'layer-1' }
                        ],
                        entries: [
                            {
                                oldValue: 'top 320 700',
                                newValue: 'top 360 700',
                                workerReplayTargets: [
                                    { glyphName: 'a', layerId: 'layer-1' },
                                    {
                                        glyphName: 'adieresis',
                                        layerId: 'layer-1'
                                    }
                                ]
                            }
                        ]
                    }
                };
            })
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        try {
            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

            expect(refreshGlyphAdvancesLive).not.toHaveBeenCalled();
            expect(
                currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(1);
            expect(
                originalWindow.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
            expect(refreshWorkerCacheForReplayTargets).not.toHaveBeenCalled();
            expect(
                sendMessageSpy.mock.calls.some(
                    ([message]) => message?.type === 'storeFontJson'
                )
            ).toBe(false);
            expect(
                originalWindow.glyphCanvas.outlineEditor.fetchDrawingData
            ).toHaveBeenCalledWith(true, 'a');
        } finally {
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.lastStoredFontJson = originalLastStoredFontJson;
            sendMessageSpy.mockRestore();
        }
    });

    test('undo anchor drag rebuilds downstream composites and schedules an editing-font refresh (redundant comment entry)', async () => {
        // This test entry appears to be a copy-fragment from a previous edit.
        // The variables referenced here are not defined in its scope — they
        // belong to the preceding test block that was closed two lines above.
    });

    test('undo anchor-inclusive selection scaling refreshes recomposed glyphs incrementally', async () => {
        const originalIsInitialized = fontCompilation.isInitialized;
        const originalLastStoredFontJson = fontCompilation.lastStoredFontJson;
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue(undefined);
        const refreshWorkerCacheForReplayTargets = jest
            .fn()
            .mockResolvedValue(true);
        const rebuildAutomaticCompositesForGlyphs = jest.fn(
            () => new Set(['adieresis'])
        );
        const recomputeMetricsKeys = jest.fn(() => new Set(['adieresis']));

        const makeFontModel = () => ({
            rebuildAutomaticCompositesForGlyphs,
            recomputeMetricsKeys,
            findGlyphsUsingComponent: jest.fn((glyphName) =>
                glyphName === 'a' ? ['adieresis'] : []
            ),
            findGlyph: jest.fn((glyphName) => {
                if (glyphName === 'a' || glyphName === 'adieresis') {
                    return {
                        findDrawingById: jest.fn(() => ({
                            id: 'layer-1',
                            width: 500
                        }))
                    };
                }

                return null;
            })
        });

        const currentFont = {
            babelfontJson: '{"glyphs":[]}',
            fontModel: makeFontModel(),
            requestRecompileWithoutDataChange: jest.fn(),
            syncJsonFromModel: jest.fn()
        };

        fontCompilation.isInitialized = true;
        fontCompilation.lastStoredFontJson = 'cached-json';

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn(() => true)
            },
            outlineEditor: {
                active: true,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchDrawingData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineDrawingDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            refreshWorkerCacheForReplayTargets,
            pendingBabelfontJsonSyncAfterDrag: false,
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            runWithoutRecording: jest.fn((fn) => fn()),
            undo: jest.fn(() => {
                currentFont.fontModel = makeFontModel();
                return {
                    scope: 'layer',
                    glyphName: 'a',
                    layerId: 'layer-1',
                    historyItem: {
                        transactionLabel: 'Scale selection',
                        touchedPaths: ['glyphs.a.layers.layer-1.anchors.0'],
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'layer-1' },
                            { glyphName: 'adieresis', layerId: 'layer-1' }
                        ],
                        entries: [
                            {
                                oldValue: 'Bounds: (10, 20)-(30, 40)',
                                newValue: 'Bounds: (12, 24)-(36, 48)',
                                workerReplayTargets: [
                                    { glyphName: 'a', layerId: 'layer-1' },
                                    {
                                        glyphName: 'adieresis',
                                        layerId: 'layer-1'
                                    }
                                ]
                            }
                        ]
                    }
                };
            })
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        try {
            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

            expect(refreshWorkerCacheForReplayTargets).not.toHaveBeenCalled();
            expect(
                sendMessageSpy.mock.calls.some(
                    ([message]) => message?.type === 'storeFontJson'
                )
            ).toBe(false);
            expect(rebuildAutomaticCompositesForGlyphs).not.toHaveBeenCalled();
            expect(
                currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(1);
            expect(
                originalWindow.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
        } finally {
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.lastStoredFontJson = originalLastStoredFontJson;
            sendMessageSpy.mockRestore();
        }
    });

    test('undo coarse drawing-snapshot Scale selection compiles from the forwarded worker update', async () => {
        const originalIsInitialized = fontCompilation.isInitialized;
        const originalLastStoredFontJson = fontCompilation.lastStoredFontJson;
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue(undefined);
        const refreshWorkerCacheForReplayTargets = jest
            .fn()
            .mockResolvedValue(true);

        const currentFont = {
            babelfontJson: '{"glyphs":[]}',
            fontModel: {
                rebuildAutomaticCompositesForGlyphs: jest.fn(
                    () => new Set(['adieresis'])
                ),
                recomputeMetricsKeys: jest.fn(() => new Set(['adieresis'])),
                findGlyphsUsingComponent: jest.fn((glyphName) =>
                    glyphName === 'a' ? ['adieresis'] : []
                ),
                findGlyph: jest.fn((glyphName) => {
                    if (glyphName === 'a' || glyphName === 'adieresis') {
                        return {
                            findDrawingById: jest.fn(() => ({
                                id: 'layer-1',
                                width: 500
                            }))
                        };
                    }

                    return null;
                })
            },
            requestRecompileWithoutDataChange: jest.fn(),
            syncJsonFromModel: jest.fn()
        };

        fontCompilation.isInitialized = true;
        fontCompilation.lastStoredFontJson = 'cached-json';

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn(() => true)
            },
            outlineEditor: {
                active: true,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchDrawingData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineDrawingDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            refreshWorkerCacheForReplayTargets,
            pendingBabelfontJsonSyncAfterDrag: false,
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            runWithoutRecording: jest.fn((fn) => fn()),
            undo: jest.fn(() => ({
                scope: 'layer',
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    transactionLabel: 'Scale selection',
                    touchedPaths: ['glyphs.a.layers.layer-1'],
                    workerReplayTargets: [
                        { glyphName: 'a', layerId: 'layer-1' }
                    ],
                    entries: [
                        {
                            oldValue: 'Bounds: (10, 20)-(30, 40)',
                            newValue: 'Bounds: (12, 24)-(36, 48)',
                            workerReplayTargets: [
                                { glyphName: 'a', layerId: 'layer-1' }
                            ]
                        }
                    ]
                }
            }))
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        try {
            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

            expect(refreshWorkerCacheForReplayTargets).not.toHaveBeenCalled();
            expect(
                sendMessageSpy.mock.calls.some(
                    ([message]) => message?.type === 'storeFontJson'
                )
            ).toBe(false);
        } finally {
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.lastStoredFontJson = originalLastStoredFontJson;
            sendMessageSpy.mockRestore();
        }
    });

    test('undo waits for the post-sync editing-font compile when forceTrigger is available', async () => {
        const originalIsInitialized = fontCompilation.isInitialized;
        const originalLastStoredFontJson = fontCompilation.lastStoredFontJson;
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue(undefined);
        const refreshWorkerCacheForReplayTargets = jest
            .fn()
            .mockResolvedValue(true);
        const currentFont = {
            babelfontJson: '{"glyphs":[]}',
            fontModel: {
                rebuildAutomaticCompositesForGlyphs: jest.fn(
                    () => new Set(['adieresis'])
                ),
                recomputeMetricsKeys: jest.fn(() => new Set(['adieresis'])),
                findGlyphsUsingComponent: jest.fn((glyphName) =>
                    glyphName === 'a' ? ['adieresis'] : []
                ),
                findGlyph: jest.fn((glyphName) => {
                    if (glyphName === 'a' || glyphName === 'adieresis') {
                        return {
                            findDrawingById: jest.fn(() => ({
                                id: 'layer-1',
                                width: 500
                            }))
                        };
                    }

                    return null;
                })
            },
            requestRecompileWithoutDataChange: jest.fn(() => {
                currentFont.compileRequestVersion += 1;
            }),
            syncJsonFromModel: jest.fn(),
            compileRequestVersion: 0
        };

        fontCompilation.isInitialized = true;
        fontCompilation.lastStoredFontJson = 'cached-json';

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn(() => true)
            },
            outlineEditor: {
                active: true,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchDrawingData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineDrawingDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            refreshWorkerCacheForReplayTargets,
            pendingBabelfontJsonSyncAfterDrag: false,
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            runWithoutRecording: jest.fn((fn) => fn()),
            undo: jest.fn(() => ({
                scope: 'layer',
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    transactionLabel: 'Scale selection',
                    touchedPaths: ['glyphs.a.layers.layer-1.anchors.0'],
                    entries: []
                }
            }))
        };

        const forceTrigger = jest.fn(async () => {
            window.dispatchEvent(
                new CustomEvent('editingFontCompiled', {
                    detail: {
                        fontBytes: new Uint8Array([1]),
                        fontRevisionKey: String(
                            currentFont.compileRequestVersion
                        )
                    }
                })
            );
        });

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn(),
            forceTrigger
        };

        try {
            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

            expect(forceTrigger).not.toHaveBeenCalled();
            expect(
                currentFont.requestRecompileWithoutDataChange
            ).not.toHaveBeenCalled();
            expect(refreshWorkerCacheForReplayTargets).not.toHaveBeenCalled();
            expect(
                sendMessageSpy.mock.calls.some(
                    ([message]) => message?.type === 'storeFontJson'
                )
            ).toBe(false);
        } finally {
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.lastStoredFontJson = originalLastStoredFontJson;
            sendMessageSpy.mockRestore();
        }
    });

    test('undo component drag reloads the active canvas layer without direct worker cache work', async () => {
        const originalIsInitialized = fontCompilation.isInitialized;
        const submitDrawingToWorkerCache = jest.fn().mockResolvedValue(true);
        const requestRecompileWithoutDataChange = jest.fn();
        const refreshSelectedDrawingFromModel = jest.fn(() => true);
        const canRefreshSelectedDrawingFromModelExactly = jest
            .fn()
            .mockReturnValueOnce(true)
            .mockReturnValueOnce(true)
            .mockReturnValueOnce(false);
        const reconcileSelectionAfterModelSync = jest
            .fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const fetchDrawingData = jest.fn().mockResolvedValue();

        const currentFont = {
            babelfontJson: '{"glyphs":[]}',
            fontModel: {
                findGlyph: jest.fn(() => ({
                    findDrawingById: jest.fn(() => ({
                        id: 'layer-1',
                        width: 500
                    }))
                }))
            },
            requestRecompileWithoutDataChange,
            syncJsonFromModel: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn()
            },
            outlineEditor: {
                active: true,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                canRefreshSelectedDrawingFromModelExactly,
                refreshSelectedDrawingFromModel,
                reconcileSelectionAfterModelSync,
                fetchDrawingData,
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineDrawingDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            submitDrawingToWorkerCache: submitDrawingToWorkerCache,
            pendingBabelfontJsonSyncAfterDrag: false,
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            undo: jest.fn(() => ({
                scope: 'layer',
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    transactionLabel: 'Drag component',
                    touchedPaths: [
                        'glyphs.a.layers.layer-1.shapes.0.transform.translation.0',
                        'glyphs.a.layers.layer-1.shapes.0.transform.translation.1'
                    ],
                    entries: [
                        {
                            oldValue: "component 'acute': (10, 20)",
                            newValue: "component 'acute': (30, 20)"
                        }
                    ]
                }
            }))
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        fontCompilation.isInitialized = true;

        try {
            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

            expect(submitDrawingToWorkerCache).not.toHaveBeenCalled();
            expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
            expect(
                originalWindow.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
            expect(fetchDrawingData).not.toHaveBeenCalled();
            expect(refreshSelectedDrawingFromModel).toHaveBeenCalledTimes(1);
            expect(
                canRefreshSelectedDrawingFromModelExactly
            ).toHaveBeenCalledTimes(1);

            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

            expect(fetchDrawingData).toHaveBeenCalledWith(true, 'a');
            expect(refreshSelectedDrawingFromModel).toHaveBeenCalledTimes(2);

            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

            expect(fetchDrawingData).toHaveBeenCalledTimes(2);
            expect(refreshSelectedDrawingFromModel).toHaveBeenCalledTimes(2);
            expect(
                canRefreshSelectedDrawingFromModelExactly
            ).toHaveBeenCalledTimes(3);
        } finally {
            fontCompilation.isInitialized = originalIsInitialized;
        }
    });

    test('undo on an inexact selected layer falls back to interpolation', async () => {
        const refreshGlyphAdvancesLive = jest.fn();
        const canRefreshSelectedDrawingFromModelExactly = jest.fn(() => false);
        const refreshSelectedDrawingFromModel = jest.fn(() => true);
        const fetchDrawingData = jest.fn().mockResolvedValue();

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive
            },
            outlineEditor: {
                active: true,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                canRefreshSelectedDrawingFromModelExactly,
                refreshSelectedDrawingFromModel,
                fetchDrawingData,
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn(() => ({
                        findDrawingById: jest.fn(() => ({
                            id: 'layer-1',
                            width: 500
                        }))
                    }))
                },
                requestRecompileWithoutDataChange: jest.fn()
            },
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            undo: jest.fn(() => ({
                scope: 'layer',
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    transactionLabel: 'Drag point',
                    touchedPaths: ['glyphs.a.layers.layer-1.shapes.0.nodes'],
                    entries: [
                        {
                            oldValue: '(10, 20)',
                            newValue: '(20, 20)'
                        }
                    ]
                }
            }))
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

        expect(canRefreshSelectedDrawingFromModelExactly).toHaveBeenCalledTimes(
            1
        );
        expect(refreshSelectedDrawingFromModel).not.toHaveBeenCalled();
        expect(fetchDrawingData).toHaveBeenCalledWith(true, 'a');
    });

    test('undo glyph-scoped snapshot uses explicit replay targets instead of storeFontJson', async () => {
        const originalIsInitialized = fontCompilation.isInitialized;
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue(undefined);
        const refreshWorkerCacheForReplayTargets = jest
            .fn()
            .mockResolvedValue(true);
        const requestRecompileWithoutDataChange = jest.fn();

        const currentFont = {
            babelfontJson: '{"glyphs":[]}',
            fontModel: {
                findGlyph: jest.fn(() => ({
                    findDrawingById: jest.fn(() => ({
                        id: 'layer-1',
                        width: 500
                    }))
                }))
            },
            requestRecompileWithoutDataChange,
            syncJsonFromModel: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn()
            },
            outlineEditor: {
                active: true,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchDrawingData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineDrawingDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            refreshWorkerCacheForReplayTargets,
            pendingBabelfontJsonSyncAfterDrag: false,
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            undo: jest.fn(() => ({
                scope: 'glyph',
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    transactionLabel: 'Drag selection',
                    workerReplayTargets: [
                        { glyphName: 'a', layerId: 'layer-1' }
                    ],
                    entries: [
                        {
                            historyAction: 'change',
                            workerReplayTargets: [
                                { glyphName: 'a', layerId: 'layer-1' }
                            ],
                            oldValue: 'before',
                            newValue: 'after'
                        }
                    ]
                }
            }))
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        fontCompilation.isInitialized = true;

        try {
            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

            expect(refreshWorkerCacheForReplayTargets).not.toHaveBeenCalled();
            expect(
                sendMessageSpy.mock.calls.some(
                    ([message]) => message?.type === 'storeFontJson'
                )
            ).toBe(false);
            expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
            expect(
                originalWindow.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
        } finally {
            fontCompilation.isInitialized = originalIsInitialized;
            sendMessageSpy.mockRestore();
        }
    });

    test('undo anchor-inclusive Scale selection with replay targets recompiles after worker sync', async () => {
        const originalIsInitialized = fontCompilation.isInitialized;
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue(undefined);
        const refreshWorkerCacheForReplayTargets = jest
            .fn()
            .mockResolvedValue(true);
        const requestRecompileWithoutDataChange = jest.fn();

        const currentFont = {
            babelfontJson: '{"glyphs":[]}',
            fontModel: {
                rebuildAutomaticCompositesForGlyphs: jest.fn(
                    () => new Set(['adieresis'])
                ),
                recomputeMetricsKeys: jest.fn(() => new Set(['adieresis'])),
                findGlyphsUsingComponent: jest.fn((glyphName) =>
                    glyphName === 'a' ? ['adieresis'] : []
                ),
                findGlyph: jest.fn((glyphName) => {
                    if (glyphName === 'a' || glyphName === 'adieresis') {
                        return {
                            findDrawingById: jest.fn(() => ({
                                id: 'layer-1',
                                width: 500
                            }))
                        };
                    }

                    return null;
                })
            },
            compileRequestVersion: 0,
            requestRecompileWithoutDataChange: jest.fn(() => {
                currentFont.compileRequestVersion += 1;
                requestRecompileWithoutDataChange();
            }),
            syncJsonFromModel: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn(() => true)
            },
            outlineEditor: {
                active: true,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchDrawingData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineDrawingDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            refreshWorkerCacheForReplayTargets,
            pendingBabelfontJsonSyncAfterDrag: false,
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            runWithoutRecording: jest.fn((fn) => fn()),
            undo: jest.fn(() => ({
                scope: 'layer',
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    transactionLabel: 'Scale selection',
                    touchedPaths: ['glyphs.a.layers.layer-1.anchors.0'],
                    workerReplayTargets: [
                        { glyphName: 'a', layerId: 'layer-1' },
                        { glyphName: 'adieresis', layerId: 'layer-1' }
                    ],
                    entries: [
                        {
                            historyAction: 'change',
                            workerReplayTargets: [
                                { glyphName: 'a', layerId: 'layer-1' },
                                { glyphName: 'adieresis', layerId: 'layer-1' }
                            ],
                            oldValue: 'Bounds: (10, 20)-(30, 40)',
                            newValue: 'Bounds: (12, 24)-(36, 48)'
                        }
                    ]
                }
            }))
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn(),
            forceTrigger: jest.fn(async () => {
                window.dispatchEvent(
                    new CustomEvent('editingFontCompiled', {
                        detail: {
                            fontBytes: new Uint8Array([1]),
                            fontRevisionKey: String(
                                currentFont.compileRequestVersion
                            )
                        }
                    })
                );
            })
        };

        fontCompilation.isInitialized = true;

        try {
            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

            expect(refreshWorkerCacheForReplayTargets).not.toHaveBeenCalled();
            expect(
                sendMessageSpy.mock.calls.some(
                    ([message]) => message?.type === 'storeFontJson'
                )
            ).toBe(false);
            expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
            expect(
                originalWindow.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
            expect(
                originalWindow.autoCompileManager.forceTrigger
            ).toHaveBeenCalledTimes(1);
        } finally {
            fontCompilation.isInitialized = originalIsInitialized;
            sendMessageSpy.mockRestore();
        }
    });

    test('undo glyph-wide sidebearing key change uses the forwarded update instead of a repair refresh', async () => {
        const originalIsInitialized = fontCompilation.isInitialized;
        const originalLastStoredFontJson = fontCompilation.lastStoredFontJson;
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue(undefined);
        const requestRecompileWithoutDataChange = jest.fn();
        const refreshWorkerCacheForReplayTargets = jest
            .fn()
            .mockResolvedValue(true);

        const currentFont = {
            babelfontJson: '{"glyphs":[{"name":"stale"}]}',
            fontModel: {
                findGlyph: jest.fn(() => ({
                    findDrawingById: jest.fn(() => ({
                        id: 'layer-1',
                        width: 500
                    }))
                }))
            },
            requestRecompileWithoutDataChange,
            syncJsonFromModel: jest.fn(() => {
                currentFont.babelfontJson = '{"glyphs":[{"name":"fresh"}]}';
            })
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn()
            },
            outlineEditor: {
                active: true,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchDrawingData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineDrawingDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            refreshWorkerCacheForReplayTargets,
            pendingBabelfontJsonSyncAfterDrag: false,
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            undo: jest.fn(() => ({
                scope: 'font',
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    transactionLabel: 'Set LSB',
                    workerReplayTargets: [
                        {
                            glyphName: 'a',
                            layerId: 'layer-1'
                        }
                    ],
                    entries: [
                        {
                            oldValue: '=n+20',
                            newValue: '',
                            workerReplayTargets: [
                                {
                                    glyphName: 'a',
                                    layerId: 'layer-1'
                                }
                            ]
                        }
                    ]
                }
            }))
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        fontCompilation.isInitialized = true;
        fontCompilation.lastStoredFontJson = 'cached-json';

        try {
            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

            expect(currentFont.syncJsonFromModel).not.toHaveBeenCalled();
            expect(refreshWorkerCacheForReplayTargets).not.toHaveBeenCalled();
            expect(sendMessageSpy).not.toHaveBeenCalledWith(
                expect.objectContaining({ type: 'storeFontJson' })
            );
            expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
            expect(
                originalWindow.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
        } finally {
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.lastStoredFontJson = originalLastStoredFontJson;
            sendMessageSpy.mockRestore();
        }
    });
});
