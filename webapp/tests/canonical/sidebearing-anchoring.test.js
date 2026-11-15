const {
    handleCommittedChangeRefresh,
    runBridgeUndoRedo
} = require('../../js/change-bridge-init');
const { Drawing } = require('../../js/babelfont-model');
const fontManager = require('../../js/font-manager').default;

function snapshotDrawingCenterScreen(target) {
    const bbox = Drawing.calculateBoundingBox(
        target.outlineEditor.drawingData,
        true
    );
    if (!bbox) {
        return null;
    }

    const glyphPosition = target.textRunEditor._getGlyphPosition(
        target.textRunEditor.selectedGlyphIndex
    );
    const localCenterX = bbox.minX + bbox.width / 2;
    const localCenterY = bbox.minY + bbox.height / 2;

    return target.viewportManager.fontToScreenCoordinates(
        glyphPosition.xPosition + glyphPosition.xOffset + localCenterX,
        glyphPosition.yOffset + localCenterY
    );
}

function snapshotGlyphOriginScreen(target, { rtl = false } = {}) {
    const glyphPosition = target.textRunEditor._getGlyphPosition(
        target.textRunEditor.selectedGlyphIndex
    );
    const shapedGlyph =
        target.textRunEditor.shapedGlyphs?.[
            target.textRunEditor.selectedGlyphIndex
        ];
    const advance =
        typeof shapedGlyph?.ax === 'number'
            ? shapedGlyph.ax
            : target.outlineEditor.drawingData.width;
    const localX = rtl ? advance : 0;

    return target.viewportManager.fontToScreenCoordinates(
        glyphPosition.xPosition + glyphPosition.xOffset + localX,
        glyphPosition.yOffset
    );
}

function snapshotGlyphRightEdgeScreen(target, { rtl = false } = {}) {
    const glyphPosition = target.textRunEditor._getGlyphPosition(
        target.textRunEditor.selectedGlyphIndex
    );
    const shapedGlyph =
        target.textRunEditor.shapedGlyphs?.[
            target.textRunEditor.selectedGlyphIndex
        ];
    const advance =
        typeof shapedGlyph?.ax === 'number'
            ? shapedGlyph.ax
            : target.outlineEditor.drawingData.width;
    const localX = rtl ? 0 : advance;

    return target.viewportManager.fontToScreenCoordinates(
        glyphPosition.xPosition + glyphPosition.xOffset + localX,
        glyphPosition.yOffset
    );
}

function expectDrawingCenterAnchored(target, beforeCenter) {
    const afterCenter = snapshotDrawingCenterScreen(target);

    expect(afterCenter.x).toBeCloseTo(beforeCenter.x, 5);
    expect(afterCenter.y).toBeCloseTo(beforeCenter.y, 5);
}

function expectGlyphOriginAnchored(target, beforeOrigin, options) {
    const afterOrigin = snapshotGlyphOriginScreen(target, options);

    expect(afterOrigin.x).toBeCloseTo(beforeOrigin.x, 5);
    expect(afterOrigin.y).toBeCloseTo(beforeOrigin.y, 5);
}

function expectGlyphRightEdgeAnchored(target, beforeRight, options) {
    const afterRight = snapshotGlyphRightEdgeScreen(target, options);

    expect(afterRight.x).toBeCloseTo(beforeRight.x, 5);
    expect(afterRight.y).toBeCloseTo(beforeRight.y, 5);
}

function shiftDrawingNodes(target, dx) {
    for (const shape of target.outlineEditor.drawingData.shapes) {
        for (const node of shape.nodes) {
            node.x += dx;
        }
    }
}

function snapshotViewport(target) {
    return {
        panX: target.viewportManager.panX,
        panY: target.viewportManager.panY,
        scale: target.viewportManager.scale
    };
}

function expectViewportUnchanged(target, beforeViewport) {
    expect(snapshotViewport(target)).toEqual(beforeViewport);
}

function setupUnkeyedCanvas(canvas) {
    canvas.outlineEditor.active = true;
    canvas.outlineEditor.currentGlyphName = 'a';
    canvas.outlineEditor.selectedDrawingId = 'layer-1';
    canvas.outlineEditor.glyphStack = 'a@layer-1';
    canvas.outlineEditor.parseGlyphStack = jest.fn(() => [{ glyphName: 'a' }]);
    canvas.getCurrentGlyphName = jest.fn(() => 'a');
    canvas.viewportManager.scale = 2;
    canvas.viewportManager.panX = 100;
    canvas.viewportManager.panY = 50;
    canvas.outlineEditor.drawingData = {
        id: 'layer-1',
        width: 500,
        shapes: [
            {
                nodes: [
                    { x: 100, y: 0, nodetype: 'Line', smooth: false },
                    { x: 400, y: 0, nodetype: 'Line', smooth: false },
                    { x: 400, y: 700, nodetype: 'Line', smooth: false },
                    { x: 100, y: 700, nodetype: 'Line', smooth: false }
                ],
                closed: true
            }
        ],
        anchors: [],
        guides: []
    };
    canvas.outlineEditor.saveDrawingData = jest.fn();
    canvas.outlineEditor._syncCurrentGlyphToYDoc = jest.fn();
    canvas.outlineEditor.performHitDetection = jest.fn();
    canvas.updatePropertyPanel = jest.fn();
    canvas.render = jest.fn();
    canvas.textRunEditor.selectedGlyphIndex = 0;
    canvas.textRunEditor._getGlyphPosition = jest.fn(() => ({
        xPosition: 0,
        xOffset: 0,
        yOffset: 0
    }));
    canvas.textRunEditor.refreshGlyphAdvanceDeltasLive = jest.fn(() => true);
}

describe('Sidebearing center anchoring matrix', () => {
    let canvas;
    let currentFontSpy;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(null);
        window.changeBridge = null;
        setupUnkeyedCanvas(canvas);
    });

    afterEach(() => {
        currentFontSpy.mockRestore();
        canvas.destroy();
    });

    test.each([
        {
            label: 'mouse LSB handle drag anchors the layer center',
            side: 'left',
            deltaX: 20
        },
        {
            label: 'mouse RSB handle drag anchors the layer center',
            side: 'right',
            deltaX: 20
        }
    ])('$label', ({ side, deltaX }) => {
        const beforeCenter = snapshotDrawingCenterScreen(canvas);

        canvas.outlineEditor.isDraggingSidebearing = true;
        canvas.outlineEditor.selectedSidebearingHandle = {
            side,
            editable: true
        };
        canvas.outlineEditor._updateDraggedSidebearing(deltaX);

        expectDrawingCenterAnchored(canvas, beforeCenter);
        expect(canvas.outlineEditor.getLiveSidebearingOverlayWidth()).toEqual(
            canvas.outlineEditor.drawingData.width
        );
    });

    test('mouse sidebearing drag retains its center anchor for recomposed advance replay', () => {
        const beforeCenter = snapshotDrawingCenterScreen(canvas);

        canvas.outlineEditor.isDraggingSidebearing = true;
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'left',
            editable: true
        };
        canvas.outlineEditor._updateDraggedSidebearing(20);

        canvas.viewportManager.panX -= 250;
        expect(
            canvas.outlineEditor.reapplyPendingSidebearingBboxCenterAnchor()
        ).toBe(true);

        expectDrawingCenterAnchored(canvas, beforeCenter);
    });

    test('mouse sidebearing drag clears a preview anchor from an earlier interaction', () => {
        expect(
            canvas.outlineEditor.capturePendingSidebearingBboxCenterAnchor()
        ).toBe(true);

        canvas.outlineEditor.hoveredSidebearingHandle = {
            side: 'left',
            editable: true
        };
        canvas.outlineEditor.onSingleClick({
            clientX: 0,
            clientY: 0,
            shiftKey: false
        });

        expect(
            canvas.outlineEditor.reapplyPendingSidebearingBboxCenterAnchor()
        ).toBe(false);
    });

    test.each([
        {
            label: 'keyboard LSB handle nudge anchors the layer center',
            side: 'left'
        },
        {
            label: 'keyboard RSB handle nudge anchors the layer center',
            side: 'right'
        }
    ])('$label', async ({ side }) => {
        const beforeCenter = snapshotDrawingCenterScreen(canvas);
        const beforeWidth = canvas.outlineEditor.drawingData.width;

        canvas.outlineEditor.selectedSidebearingHandle = {
            side,
            editable: true
        };
        canvas.outlineEditor.onKeyDown({
            key: 'ArrowRight',
            shiftKey: false,
            metaKey: false,
            ctrlKey: false,
            preventDefault: jest.fn()
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(canvas.outlineEditor.drawingData.width).not.toBe(beforeWidth);
        expectDrawingCenterAnchored(canvas, beforeCenter);
        expect(canvas.outlineEditor.getLiveSidebearingOverlayWidth()).toEqual(
            canvas.outlineEditor.drawingData.width
        );
    });

    test('keyboard LSB nudge keeps center after live preview blob swap', async () => {
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        const pendingFrames = [];
        global.requestAnimationFrame = jest.fn((callback) => {
            pendingFrames.push(callback);
            return pendingFrames.length;
        });

        try {
            canvas.outlineEditor.selectedSidebearingHandle = {
                side: 'left',
                editable: true
            };
            const beforeWidth = canvas.outlineEditor.drawingData.width;
            canvas.outlineEditor.onKeyDown({
                key: 'ArrowRight',
                shiftKey: false,
                metaKey: false,
                ctrlKey: false,
                preventDefault: jest.fn()
            });
            await Promise.resolve();
            await Promise.resolve();
            expect(canvas.outlineEditor.drawingData.width).not.toBe(
                beforeWidth
            );
            const beforeCenter = snapshotDrawingCenterScreen(canvas);

            // Simulate mid-burst preview blob apply: re-anchor then owned paint.
            canvas.outlineEditor.reapplyLastLiveSidebearingAdvances();
            canvas.outlineEditor.reapplyPendingSidebearingBboxCenterAnchor();
            canvas.outlineEditor.scheduleSidebearingOwnedRepaint();
            pendingFrames.splice(0).forEach((callback) => callback());

            expectDrawingCenterAnchored(canvas, beforeCenter);
        } finally {
            global.requestAnimationFrame = originalRequestAnimationFrame;
        }
    });

    test('live sidebearing blob-swap reapply preserves kerning in shaped ax', () => {
        canvas.textRunEditor.glyphNameBuffer = ['T', 'A', 'T', 'A'];
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 513, dx: 0, dy: 0, g: 1 },
            { ax: 597, dx: 0, dy: 0, g: 2 }, // kerned T-A
            { ax: 513, dx: 0, dy: 0, g: 1 },
            { ax: 667, dx: 0, dy: 0, g: 2 } // unkerned trailing A
        ];
        canvas.textRunEditor.intrinsicGlyphAdvances = new Map([
            ['T', 513],
            ['A', 597]
        ]);
        canvas.textRunEditor.buildClusterMap = jest.fn();
        canvas.textRunEditor.updateCursorVisualPosition = jest.fn();

        // Session baselines: model widths before the LSB edit.
        canvas.outlineEditor._liveSidebearingSessionStartShapedAx = [
            513, 597, 513, 667
        ];
        canvas.outlineEditor._liveSidebearingSessionStartWidths = {
            T: 513,
            A: 667
        };
        // After LSB drag, A width grew by 40.
        canvas.outlineEditor._lastLiveSidebearingAdvances = {
            T: 513,
            A: 707
        };

        // Corrupt ax as the old intrinsic→width reapply would have done.
        canvas.textRunEditor.shapedGlyphs[1].ax = 707;
        canvas.textRunEditor.shapedGlyphs[3].ax = 707;
        canvas.textRunEditor.intrinsicGlyphAdvances.set('A', 667);

        expect(canvas.outlineEditor.reapplyLastLiveSidebearingAdvances()).toBe(
            true
        );

        expect(canvas.textRunEditor.shapedGlyphs.map((g) => g.ax)).toEqual([
            513,
            637, // 597 + 40
            513,
            707 // 667 + 40
        ]);
        expect(canvas.textRunEditor.intrinsicGlyphAdvances.get('A')).toBe(637);
    });

    test.each([
        {
            label: 'property panel LSB numeric edit anchors the layer center',
            side: 'left',
            value: '80'
        },
        {
            label: 'property panel RSB numeric edit anchors the layer center',
            side: 'right',
            value: '120'
        }
    ])('$label', async ({ side, value }) => {
        const beforeCenter = snapshotDrawingCenterScreen(canvas);

        await canvas.commitPropertyPanelValue(side, value);

        expectDrawingCenterAnchored(canvas, beforeCenter);
    });
});

describe('Sidebearing undo viewport stability', () => {
    const originalWindow = global.window;
    const originalGlyphCanvas = originalWindow.glyphCanvas;
    const originalFontManager = originalWindow.fontManager;
    const originalPatchSyncEngine = originalWindow.patchSyncEngine;
    const originalChangeBridge = originalWindow.changeBridge;
    const originalAutoCompileManager = originalWindow.autoCompileManager;

    afterEach(() => {
        originalWindow.glyphCanvas = originalGlyphCanvas;
        originalWindow.fontManager = originalFontManager;
        originalWindow.patchSyncEngine = originalPatchSyncEngine;
        originalWindow.changeBridge = originalChangeBridge;
        originalWindow.autoCompileManager = originalAutoCompileManager;
        jest.clearAllMocks();
    });

    function installUndoHarness(historyItem, previousWidth, nextWidth) {
        const refreshGlyphAdvanceDeltasLive = jest.fn(() => true);
        const glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvanceDeltasLive
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

        const currentFont = {
            fontModel: {
                findGlyph: jest.fn(() => ({
                    findDrawingById: jest.fn(() => ({ width: previousWidth }))
                }))
            },
            requestRecompileWithoutDataChange: jest.fn()
        };

        originalWindow.glyphCanvas = glyphCanvas;
        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null,
            setEditingCompileContext(changeSource, editType) {
                this.lastChangeSource = changeSource;
                this.lastEditType = editType;
            },
            clearEditingCompileContext() {
                this.lastChangeSource = null;
                this.lastEditType = null;
            }
        };
        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            undo: jest.fn(() => {
                currentFont.fontModel = {
                    findGlyph: jest.fn(() => ({
                        findDrawingById: jest.fn(() => ({ width: nextWidth }))
                    }))
                };

                return {
                    scope: 'layer',
                    glyphName: 'a',
                    layerId: 'layer-1',
                    historyItem
                };
            })
        };
        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        return { glyphCanvas, refreshGlyphAdvanceDeltasLive };
    }

    test.each([
        {
            label: 'undo Set LSB leaves the viewport unchanged',
            historyItem: {
                transactionLabel: 'Set LSB',
                entries: [{ oldValue: 'LEFT 100', newValue: 'LEFT 80' }]
            },
            side: 'left'
        },
        {
            label: 'undo Set RSB leaves the viewport unchanged',
            historyItem: {
                transactionLabel: 'Set RSB',
                entries: [{ oldValue: 'RIGHT 100', newValue: 'RIGHT 120' }]
            },
            side: 'right'
        }
    ])('$label', async ({ historyItem, side }) => {
        const previousWidth = 500;
        const nextWidth = 520;
        const { glyphCanvas, refreshGlyphAdvanceDeltasLive } =
            installUndoHarness(historyItem, previousWidth, nextWidth);
        const beforeViewport = snapshotViewport(glyphCanvas);

        await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

        expectViewportUnchanged(glyphCanvas, beforeViewport);
        expect(refreshGlyphAdvanceDeltasLive).not.toHaveBeenCalled();
    });

    test.each(['undo', 'redo'])(
        '%s keeps the active bbox center anchored without side metadata',
        async (action) => {
            const previousDrawingData = {
                width: 500,
                shapes: [
                    {
                        nodes: [
                            { x: 100, y: 0, nodetype: 'Line' },
                            { x: 400, y: 0, nodetype: 'Line' },
                            { x: 400, y: 700, nodetype: 'Line' },
                            { x: 100, y: 700, nodetype: 'Line' }
                        ],
                        closed: true
                    }
                ]
            };
            const nextDrawingData = {
                ...previousDrawingData,
                width: 520,
                shapes: [
                    {
                        ...previousDrawingData.shapes[0],
                        nodes: previousDrawingData.shapes[0].nodes.map(
                            (node) => ({
                                ...node,
                                x: node.x + 20
                            })
                        )
                    }
                ]
            };
            let modelDrawing = previousDrawingData;
            let capturedAnchor = null;
            const glyphCanvas = {
                viewportManager: {
                    panX: 100,
                    panY: 50,
                    scale: 2,
                    fontToScreenCoordinates(x, y) {
                        return {
                            x: x * this.scale + this.panX,
                            y: y * this.scale + this.panY
                        };
                    }
                },
                textRunEditor: {
                    selectedGlyphIndex: 0,
                    _getGlyphPosition: jest.fn(() => ({
                        xPosition: 0,
                        xOffset: 0,
                        yOffset: 0
                    })),
                    refreshGlyphAdvanceDeltasLive: jest.fn(() => true)
                },
                captureIdleViewLock: jest.fn(() => {
                    capturedAnchor = snapshotDrawingCenterScreen(glyphCanvas);
                    return true;
                }),
                reapplyIdleViewLock: jest.fn(() => {
                    const currentCenter =
                        snapshotDrawingCenterScreen(glyphCanvas);
                    glyphCanvas.viewportManager.panX +=
                        capturedAnchor.x - currentCenter.x;
                    glyphCanvas.viewportManager.panY +=
                        capturedAnchor.y - currentCenter.y;
                    return true;
                }),
                outlineEditor: {
                    active: true,
                    selectedDrawingId: 'layer-1',
                    drawingData: previousDrawingData,
                    parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                    fetchDrawingData: jest.fn().mockResolvedValue(),
                    runDeterministicRefresh: jest.fn(
                        async (task) => await task()
                    ),
                    performHitDetection: jest.fn()
                },
                getCurrentGlyphName: jest.fn(() => 'a'),
                syncCurrentOutlineDrawingDataFromModel: jest.fn((drawing) => {
                    glyphCanvas.outlineEditor.drawingData = drawing;
                }),
                updatePropertyPanel: jest.fn(),
                render: jest.fn(),
                requestRepaintAfterCompile: jest.fn()
            };
            const historyItem = {
                transactionLabel: 'Set sidebearing',
                entries: [
                    {
                        oldValue: previousDrawingData,
                        newValue: nextDrawingData,
                        path: 'glyphs.a.layers.layer-1'
                    }
                ]
            };
            const beforeCenter = snapshotDrawingCenterScreen(glyphCanvas);

            originalWindow.glyphCanvas = glyphCanvas;
            originalWindow.fontManager = {
                currentFont: {
                    fontModel: {
                        findGlyph: jest.fn(() => ({
                            findDrawingById: jest.fn(() => modelDrawing)
                        }))
                    },
                    requestRecompileWithoutDataChange: jest.fn()
                },
                awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
                lastChangeSource: null,
                lastEditType: null,
                setEditingCompileContext(changeSource, editType) {
                    this.lastChangeSource = changeSource;
                    this.lastEditType = editType;
                },
                clearEditingCompileContext() {
                    this.lastChangeSource = null;
                    this.lastEditType = null;
                }
            };
            originalWindow.patchSyncEngine = originalWindow.changeBridge = {
                undo: jest.fn(() => {
                    modelDrawing = nextDrawingData;
                    return {
                        scope: 'layer',
                        glyphName: 'a',
                        layerId: 'layer-1',
                        historyItem
                    };
                }),
                redo: jest.fn(() => {
                    modelDrawing = nextDrawingData;
                    return {
                        scope: 'layer',
                        glyphName: 'a',
                        layerId: 'layer-1',
                        historyItem
                    };
                })
            };
            originalWindow.autoCompileManager = {
                checkAndSchedule: jest.fn()
            };

            await runBridgeUndoRedo(action, 'a', 'a', 'layer-1', null);

            expectDrawingCenterAnchored(glyphCanvas, beforeCenter);
            expect(glyphCanvas.captureIdleViewLock).toHaveBeenCalledTimes(1);
            expect(glyphCanvas.reapplyIdleViewLock).toHaveBeenCalledTimes(1);
        }
    );

    test('a non-sidebearing undo still captures the idle viewer lock', async () => {
        const { glyphCanvas } = installUndoHarness(
            {
                transactionLabel: 'Drag point',
                entries: [{ oldValue: '(10, 20)', newValue: '(20, 20)' }]
            },
            500,
            520
        );
        glyphCanvas.captureIdleViewLock = jest.fn(() => true);
        glyphCanvas.reapplyIdleViewLock = jest.fn(() => true);

        await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

        expect(glyphCanvas.captureIdleViewLock).toHaveBeenCalledTimes(1);
        expect(glyphCanvas.reapplyIdleViewLock).toHaveBeenCalledTimes(1);
    });

    test.each([
        {
            label: 'undo drag metadata with visualAnchorSide left keeps the idle lock request',
            side: 'left'
        },
        {
            label: 'undo drag metadata with visualAnchorSide right leaves the viewport unchanged',
            side: 'right'
        }
    ])('$label', async ({ side }) => {
        const previousWidth = 500;
        const nextWidth = 520;
        const historyItem = {
            transactionLabel: 'Drag point',
            entries: [
                {
                    oldValue: '(10, 20)',
                    newValue: '(20, 20)',
                    visualAnchorSide: side
                }
            ]
        };
        const { glyphCanvas } = installUndoHarness(
            historyItem,
            previousWidth,
            nextWidth
        );
        const beforeViewport = snapshotViewport(glyphCanvas);

        await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

        expectViewportUnchanged(glyphCanvas, beforeViewport);
    });

    function installFontScopedUndoHarness(
        historyItem,
        previousWidth,
        nextWidth
    ) {
        const refreshGlyphAdvanceDeltasLive = jest.fn(() => true);
        const glyphCanvas = {
            viewportManager: { panX: 100, scale: 2 },
            textRunEditor: { refreshGlyphAdvanceDeltasLive },
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

        let currentWidth = previousWidth;
        const currentFont = {
            fontModel: {
                findGlyph: jest.fn(() => ({
                    findDrawingById: jest.fn(() => ({ width: currentWidth }))
                }))
            },
            requestRecompileWithoutDataChange: jest.fn()
        };

        originalWindow.glyphCanvas = glyphCanvas;
        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null,
            setEditingCompileContext(changeSource, editType) {
                this.lastChangeSource = changeSource;
                this.lastEditType = editType;
            },
            clearEditingCompileContext() {
                this.lastChangeSource = null;
                this.lastEditType = null;
            }
        };
        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            undo: jest.fn(() => {
                currentWidth = nextWidth;
                // Font-scoped: appliedChange has no glyphName/layerId.
                return {
                    scope: 'font',
                    glyphName: null,
                    layerId: null,
                    historyItem
                };
            }),
            redo: jest.fn(() => {
                currentWidth = nextWidth;
                return {
                    scope: 'font',
                    glyphName: null,
                    layerId: null,
                    historyItem
                };
            })
        };
        originalWindow.autoCompileManager = { checkAndSchedule: jest.fn() };

        return { glyphCanvas, refreshGlyphAdvanceDeltasLive };
    }

    test.each([
        {
            label: 'font-scoped undo of "Set sidebearing" left leaves the viewport unchanged',
            side: 'left'
        },
        {
            label: 'font-scoped undo of "Set sidebearing" right leaves the viewport unchanged',
            side: 'right'
        }
    ])('$label', async ({ side }) => {
        const previousWidth = 670;
        const nextWidth = 620; // undo shrinks width back
        const historyItem = {
            transactionLabel: 'Set sidebearing',
            entries: Array.from({ length: 5 }, (_, i) => ({
                historyAction: 'change',
                oldValue: { width: previousWidth },
                newValue: { width: nextWidth },
                visualAnchorSide: side,
                path: `glyphs.glyph${i}.layers.layer-1`
            }))
        };
        const { glyphCanvas } = installFontScopedUndoHarness(
            historyItem,
            previousWidth,
            nextWidth
        );
        const beforeViewport = snapshotViewport(glyphCanvas);

        await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

        expectViewportUnchanged(glyphCanvas, beforeViewport);
    });

    test.each([
        {
            label: 'font-scoped redo of "Set sidebearing" left leaves the viewport unchanged',
            side: 'left'
        },
        {
            label: 'font-scoped redo of "Set sidebearing" right leaves the viewport unchanged',
            side: 'right'
        }
    ])('$label', async ({ side }) => {
        const previousWidth = 620;
        const nextWidth = 670; // redo grows width back
        const historyItem = {
            transactionLabel: 'Set sidebearing',
            entries: [
                {
                    historyAction: 'change',
                    oldValue: { width: previousWidth },
                    newValue: { width: nextWidth },
                    visualAnchorSide: side,
                    path: 'glyphs.a.layers.layer-1'
                }
            ]
        };
        const { glyphCanvas } = installFontScopedUndoHarness(
            historyItem,
            previousWidth,
            nextWidth
        );
        const beforeViewport = snapshotViewport(glyphCanvas);

        await runBridgeUndoRedo('redo', 'a', 'a', 'layer-1', null);

        expectViewportUnchanged(glyphCanvas, beforeViewport);
    });
});

describe('Idle live sidebearing overlay cleanup', () => {
    let canvas;
    let currentFontSpy;
    const originalGlyphCanvas = window.glyphCanvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(null);
        window.changeBridge = null;
        setupUnkeyedCanvas(canvas);
        window.glyphCanvas = canvas;
    });

    afterEach(() => {
        currentFontSpy.mockRestore();
        window.glyphCanvas = originalGlyphCanvas;
        canvas.destroy();
    });

    test('undo after property-panel LSB uses restored layer width, not leftover overlay', () => {
        const originalWidth = canvas.outlineEditor.drawingData.width;

        expect(canvas.outlineEditor.setSidebearingValue('left', 150)).toBe(
            true
        );
        const committedWidth = canvas.outlineEditor.drawingData.width;
        expect(committedWidth).toBe(originalWidth + 50);

        // Forward commit left the live overlay at the new advance. Undo
        // restored drawingData.width but used to leave that overlay in place,
        // so metric bars kept the post-edit advance.
        canvas.outlineEditor.activeSidebearingDragLayout = {
            width: committedWidth
        };
        canvas.outlineEditor._lastLiveSidebearingAdvances = {
            a: committedWidth
        };
        canvas.outlineEditor.drawingData.width = originalWidth;

        expect(
            canvas.outlineEditor.getLiveSidebearingOverlayWidth()
        ).toBeNull();
        expect(canvas.renderer['getLiveSelectedDrawingWidth']()).toBe(
            originalWidth
        );

        canvas.outlineEditor.clearIdleLiveSidebearingPreview();

        expect(canvas.outlineEditor.activeSidebearingDragLayout).toBeNull();
        expect(canvas.outlineEditor._lastLiveSidebearingAdvances).toEqual({});
        expect(canvas.renderer['getLiveSelectedDrawingWidth']()).toBe(
            originalWidth
        );
    });

    test('a live sidebearing session keeps its overlay through the commit funnel', async () => {
        canvas.outlineEditor.isDraggingSidebearing = true;
        canvas.outlineEditor.activeSidebearingDragLayout = { width: 592 };
        canvas.outlineEditor._lastLiveSidebearingAdvances = { a: 592 };

        await handleCommittedChangeRefresh(
            [
                {
                    historyAction: 'change',
                    transactionLabel: 'Set sidebearing',
                    path: 'glyphs.a.layers.layer-1',
                    compileChangeSource: 'mouse-drag-sidebearing'
                }
            ],
            'local',
            {
                awaitWorkerSync: jest.fn(async () => {}),
                requestCompile: jest.fn(async () => {})
            }
        );

        expect(canvas.outlineEditor.activeSidebearingDragLayout).toEqual({
            width: 592
        });
        expect(canvas.outlineEditor.getLiveSidebearingOverlayWidth()).toBe(592);
        expect(canvas.outlineEditor._lastLiveSidebearingAdvances).toEqual({
            a: 592
        });
    });
});

describe('Idle committed viewer lock', () => {
    let canvas;
    let currentFontSpy;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(null);
        window.changeBridge = null;
        setupUnkeyedCanvas(canvas);
    });

    afterEach(() => {
        currentFontSpy.mockRestore();
        canvas.destroy();
    });

    test('edit mode keeps the active glyph origin on screen after a remote layout shift', () => {
        const beforeOrigin = snapshotGlyphOriginScreen(canvas);
        expect(canvas.captureIdleViewLock({ kerningPair: false })).toBe(true);

        canvas.textRunEditor._getGlyphPosition = jest.fn(() => ({
            xPosition: 80,
            xOffset: 0,
            yOffset: 0
        }));

        expect(canvas.reapplyIdleViewLock()).toBe(true);
        expectGlyphOriginAnchored(canvas, beforeOrigin);
        canvas.clearIdleViewLock();
        expect(canvas.hasPendingIdleViewLock()).toBe(false);
    });

    test('edit mode origin lock does not keep bbox center after a geometry change', () => {
        const beforeOrigin = snapshotGlyphOriginScreen(canvas);
        const beforeCenter = snapshotDrawingCenterScreen(canvas);
        expect(canvas.captureIdleViewLock({ kerningPair: false })).toBe(true);

        shiftDrawingNodes(canvas, 80);

        expect(canvas.reapplyIdleViewLock()).toBe(true);
        expectGlyphOriginAnchored(canvas, beforeOrigin);
        const afterCenter = snapshotDrawingCenterScreen(canvas);
        expect(afterCenter.x).not.toBeCloseTo(beforeCenter.x, 5);
        canvas.clearIdleViewLock();
    });

    test('edit mode LSB-keyed lock keeps the advance right edge after a width change', () => {
        const beforeRight = snapshotGlyphRightEdgeScreen(canvas);
        expect(
            canvas.captureIdleViewLock({
                kerningPair: false,
                rightEdge: true
            })
        ).toBe(true);

        canvas.outlineEditor.drawingData.width = 580;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 580, cl: 0 }];

        expect(canvas.reapplyIdleViewLock()).toBe(true);
        expectGlyphRightEdgeAnchored(canvas, beforeRight);
        canvas.clearIdleViewLock();
    });

    test('edit mode sidebearing exception keeps bbox center after a geometry change', () => {
        const beforeCenter = snapshotDrawingCenterScreen(canvas);
        expect(
            canvas.captureIdleViewLock({
                kerningPair: false,
                bboxCenter: true
            })
        ).toBe(true);

        shiftDrawingNodes(canvas, 80);

        expect(canvas.reapplyIdleViewLock()).toBe(true);
        expectDrawingCenterAnchored(canvas, beforeCenter);
        canvas.clearIdleViewLock();
    });

    test('edit mode RTL origin lock keeps the advance edge on screen', () => {
        canvas.textRunEditor.isPositionRTL = jest.fn(() => true);
        canvas.textRunEditor.shapedGlyphs = [{ ax: 500, cl: 0 }];
        const beforeOrigin = snapshotGlyphOriginScreen(canvas, { rtl: true });
        expect(canvas.captureIdleViewLock({ kerningPair: false })).toBe(true);

        canvas.textRunEditor.shapedGlyphs = [{ ax: 580, cl: 0 }];
        canvas.outlineEditor.drawingData.width = 580;

        expect(canvas.reapplyIdleViewLock()).toBe(true);
        expectGlyphOriginAnchored(canvas, beforeOrigin, { rtl: true });
        canvas.clearIdleViewLock();
    });

    test('text mode keeps the caret on screen after a remote advance shift', () => {
        canvas.outlineEditor.active = false;
        canvas.textRunEditor.cursorX = 100;
        expect(canvas.captureIdleViewLock({ kerningPair: false })).toBe(true);
        const lockedScreenX = canvas.viewportManager.fontToScreenCoordinates(
            100,
            0
        ).x;

        canvas.textRunEditor.cursorX = 175;
        expect(canvas.reapplyIdleViewLock()).toBe(true);
        expect(
            canvas.viewportManager.fontToScreenCoordinates(175, 0).x
        ).toBeCloseTo(lockedScreenX, 5);
    });
});
