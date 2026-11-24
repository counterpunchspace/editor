const {
    handleCommittedChangeRefresh,
    handleRemoteChangeRefresh,
    refreshGlyphOverviewFromGlyphNames,
    syncRustCacheAndRefreshCanvas,
    buildCascadingRecompositionOperations,
    runBridgeUndoRedo,
    committedEntriesTouchAxes,
    getCommittedChangeRefreshPromise
} = require('../js/change-bridge-init');
const {
    fontCompilation,
    fullFontCompilation
} = require('../js/font-compilation');
const { sidebarErrorDisplay } = require('../js/sidebar-error-display');
const { PatchSyncEngine: ChangeBridge } = require('../js/patch-sync-engine');
const { fromYType } = require('../js/change-bridge-ydoc');

describe('handleRemoteChangeRefresh', () => {
    test('shared glyph overview refresh helper adds dependent composites and preserves immediate sender refresh detail', async () => {
        const glyphChangedHandler = jest.fn();

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(
                        () => new Set(['adieresis'])
                    )
                }
            }
        };
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await refreshGlyphOverviewFromGlyphNames(['a'], {
                layerId: 'master-regular',
                forceImmediateRefresh: true,
                fallbackToFullRender: false
            });
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
            delete window.fontManager;
        }

        expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
        expect(glyphChangedHandler.mock.calls[0][0].detail).toEqual({
            glyphName: 'a',
            glyphNames: ['a', 'adieresis'],
            layerId: 'master-regular',
            forceImmediateRefresh: true
        });
    });

    test.each([
        ['local component replacement', 'local', 'change'],
        ['remote component replacement', 'remote', 'change'],
        ['component replacement undo', 'local', 'undo']
    ])(
        'leaves component-source closure derivation to the worker for %s',
        async (_label, origin, historyAction) => {
            const order = [];
            const updateEditingSubsetSnapshot = jest.fn();
            const requestCompile = jest.fn(async () => {
                order.push('compile');
            });

            window.fontManager = {
                updateEditingSubsetSnapshot
            };

            try {
                await handleCommittedChangeRefresh(
                    [
                        {
                            historyAction,
                            transactionLabel: 'Replace component reference',
                            path: 'glyphs.A.layers.master-regular.shapes.0.reference',
                            oldValue: 'sourceA',
                            newValue: 'sourceB',
                            workerReplayTargets: []
                        }
                    ],
                    origin,
                    {
                        awaitWorkerSync: jest.fn(async () => {
                            order.push('sync');
                        }),
                        requestCompile
                    }
                );
            } finally {
                delete window.fontManager;
            }

            expect(updateEditingSubsetSnapshot).not.toHaveBeenCalled();
            expect(requestCompile).toHaveBeenCalledTimes(1);
            expect(order).toEqual(['sync', 'compile']);
        }
    );

    test('waits for local worker sync before requesting compile without a second replay-target refresh', async () => {
        const refreshOrder = [];
        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
            window.fontManager.lastChangeSource = 'keyboard-outline';
            window.fontManager.lastEditType = 'outline';
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
        });
        const queueCacheRefresh = jest.fn(async () => {
            refreshOrder.push('queue');
        });
        const glyphChangedHandler = jest.fn();

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(
                        () => new Set(['adieresis'])
                    )
                }
            },
            lastChangeSource: 'keyboard-anchor',
            lastEditType: 'anchor'
        };
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag anchor',
                        path: 'glyphs.a.layers.master-regular.anchors.0.x',
                        workerReplayTargets: [
                            {
                                glyphName: 'a',
                                layerId: 'master-regular'
                            }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile,
                    queueCacheRefresh
                }
            );
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
            delete window.fontManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(requestCompile).toHaveBeenCalledTimes(1);
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(refreshOrder).toEqual(['sync', 'compile']);
        expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
        expect(glyphChangedHandler.mock.calls[0][0].detail).toEqual({
            glyphName: 'a',
            glyphNames: ['a', 'adieresis']
        });
    });

    test('reconciles a materialized background selection after a local committed edit', async () => {
        const backgroundDrawingId = 'background-layer';
        const refreshOrder = [];
        const outlineEditor = {
            active: true,
            draggingSomething: false,
            selectedDrawingId: backgroundDrawingId,
            parseGlyphStack: jest.fn(() => [
                { glyphName: 'a', layerId: backgroundDrawingId }
            ]),
            reconcileSelectionAfterModelSync: jest.fn(async () => {
                refreshOrder.push('reconcile');
                expect(outlineEditor.selectedDrawingId).toBe(
                    backgroundDrawingId
                );
            }),
            runDeterministicRefresh: jest.fn(async (refresh) => {
                refreshOrder.push('refresh');
                await refresh();
            }),
            fetchDrawingData: jest.fn(async (skipRender, glyphName) => {
                refreshOrder.push('fetch');
                expect(skipRender).toBe(true);
                expect(glyphName).toBe('a');
                expect(outlineEditor.selectedDrawingId).toBe(
                    backgroundDrawingId
                );
            })
        };
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
        });
        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
        });

        window.glyphCanvas = {
            outlineEditor,
            requestRepaintAfterCompile: jest.fn()
        };
        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set()),
                    findGlyph: jest.fn((glyphName) =>
                        glyphName === 'a'
                            ? {
                                  findDrawingById: jest.fn((drawingId) =>
                                      drawingId === backgroundDrawingId
                                          ? {
                                                toJSON: () => ({
                                                    id: backgroundDrawingId,
                                                    is_background: true,
                                                    shapes: []
                                                })
                                            }
                                          : null
                                  )
                              }
                            : null
                    )
                }
            },
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline'
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Edit path',
                        path: `glyphs.a.layers.${backgroundDrawingId}.shapes.0.nodes.0.x`,
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: backgroundDrawingId }
                        ]
                    }
                ],
                'local',
                { awaitWorkerSync, requestCompile }
            );
        } finally {
            delete window.glyphCanvas;
            delete window.fontManager;
        }

        expect(
            outlineEditor.reconcileSelectionAfterModelSync
        ).toHaveBeenCalledWith({
            skipRender: true
        });
        expect(outlineEditor.fetchDrawingData).toHaveBeenCalledWith(true, 'a');
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
        expect(refreshOrder).toEqual([
            'sync',
            'reconcile',
            'refresh',
            'fetch',
            'compile'
        ]);
    });

    test('defers local background reconciliation while a drag is active', async () => {
        const backgroundDrawingId = 'background-layer';
        const outlineEditor = {
            active: true,
            draggingSomething: true,
            pendingRemoteRefreshAfterDrag: false,
            selectedDrawingId: backgroundDrawingId,
            parseGlyphStack: jest.fn(() => [
                { glyphName: 'a', layerId: backgroundDrawingId }
            ]),
            reconcileSelectionAfterModelSync: jest.fn(),
            fetchDrawingData: jest.fn()
        };
        const requestCompile = jest.fn(async () => {});

        window.glyphCanvas = {
            outlineEditor,
            requestRepaintAfterCompile: jest.fn()
        };
        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set()),
                    findGlyph: jest.fn((glyphName) =>
                        glyphName === 'a'
                            ? {
                                  findDrawingById: jest.fn((drawingId) =>
                                      drawingId === backgroundDrawingId
                                          ? {
                                                toJSON: () => ({
                                                    id: backgroundDrawingId,
                                                    is_background: true,
                                                    shapes: []
                                                })
                                            }
                                          : null
                                  )
                              }
                            : null
                    )
                }
            },
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline'
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Edit path',
                        path: `glyphs.a.layers.${backgroundDrawingId}.shapes.0.nodes.0.x`,
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: backgroundDrawingId }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync: jest.fn(async () => {}),
                    requestCompile
                }
            );
        } finally {
            delete window.glyphCanvas;
            delete window.fontManager;
        }

        expect(outlineEditor.pendingRemoteRefreshAfterDrag).toBe(true);
        expect(
            outlineEditor.reconcileSelectionAfterModelSync
        ).not.toHaveBeenCalled();
        expect(outlineEditor.fetchDrawingData).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
    });

    test.each(['undo', 'redo'])(
        'reconciles a materialized background selection after local %s',
        async (historyAction) => {
            const backgroundDrawingId = 'd82d1a85-7bc6-4ece-9b01-d9f9afda2f5a';
            const outlineEditor = {
                active: true,
                draggingSomething: false,
                selectedDrawingId: backgroundDrawingId,
                parseGlyphStack: jest.fn(() => [
                    { glyphName: 'a', layerId: backgroundDrawingId }
                ]),
                reconcileSelectionAfterModelSync: jest.fn(async () => {}),
                runDeterministicRefresh: jest.fn(async (refresh) => refresh()),
                fetchDrawingData: jest.fn(async () => {})
            };
            const requestCompile = jest.fn(async () => {});

            const glyphCanvas = {
                outlineEditor,
                requestRepaintAfterCompile: jest.fn()
            };
            window.glyphCanvas = glyphCanvas;
            window.fontManager = {
                currentFont: {
                    fontModel: {
                        collectComponentDependentGlyphs: jest.fn(
                            () => new Set()
                        ),
                        findGlyph: jest.fn((glyphName) =>
                            glyphName === 'a'
                                ? {
                                      findDrawingById: jest.fn((drawingId) =>
                                          drawingId === backgroundDrawingId
                                              ? {
                                                    is_background: true,
                                                    toJSON: () => ({
                                                        id: backgroundDrawingId,
                                                        is_background: true,
                                                        shapes: []
                                                    })
                                                }
                                              : null
                                      )
                                  }
                                : null
                        )
                    }
                },
                lastChangeSource: 'keyboard-outline',
                lastEditType: 'outline'
            };

            try {
                await handleCommittedChangeRefresh(
                    [
                        {
                            historyAction,
                            transactionLabel: 'Edit path',
                            path: `glyphs.a.layers.${backgroundDrawingId}.shapes.0.nodes.0.x`,
                            workerReplayTargets: [
                                { glyphName: 'a', layerId: backgroundDrawingId }
                            ]
                        }
                    ],
                    'local',
                    {
                        awaitWorkerSync: jest.fn(async () => {}),
                        requestCompile
                    }
                );
            } finally {
                delete window.glyphCanvas;
                delete window.fontManager;
            }

            expect(
                outlineEditor.reconcileSelectionAfterModelSync
            ).toHaveBeenCalledWith({
                skipRender: true
            });
            expect(outlineEditor.fetchDrawingData).toHaveBeenCalledWith(
                true,
                'a'
            );
            expect(
                glyphCanvas.requestRepaintAfterCompile
            ).toHaveBeenCalledTimes(1);
            expect(requestCompile).toHaveBeenCalledWith(
                'change-bridge-local',
                null
            );
        }
    );

    test('local undo compiles after the authoritative worker update settles', async () => {
        const refreshOrder = [];
        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
            window.fontManager.lastChangeSource = 'keyboard-anchor';
            window.fontManager.lastEditType = 'anchor';
        });
        const queueCacheRefresh = jest.fn(async () => {
            refreshOrder.push('queue');
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
        });

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(
                        () => new Set(['adieresis'])
                    )
                }
            },
            lastChangeSource: 'keyboard-anchor',
            lastEditType: 'anchor',
            workerCacheUpdatePromise: null,
            awaitWorkerCacheUpdate: jest.fn(async () => {
                refreshOrder.push('post-cache');
            })
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        historyAction: 'undo',
                        transactionLabel: 'Drag anchor',
                        path: 'glyphs.a.layers.master-regular.anchors.0.x',
                        workerReplayTargets: [
                            {
                                glyphName: 'a',
                                layerId: 'master-regular'
                            },
                            {
                                glyphName: 'adieresis',
                                layerId: 'master-regular'
                            }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile,
                    queueCacheRefresh
                }
            );
        } finally {
            delete window.fontManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
        expect(refreshOrder).toEqual(['sync', 'compile']);
    });

    test('structural contour-delete undo compiles after one worker sync without replay repair', async () => {
        const refreshOrder = [];
        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
        });
        const refreshWorkerCacheForReplayTargets = jest.fn();

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(
                        () => new Set(['adieresis'])
                    )
                }
            },
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline',
            refreshWorkerCacheForReplayTargets
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        historyAction: 'undo',
                        transactionLabel: 'Delete contour',
                        path: 'glyphs.a.layers.master-regular.shapes.1',
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'master-regular' },
                            {
                                glyphName: 'adieresis',
                                layerId: 'master-regular'
                            }
                        ]
                    }
                ],
                'local',
                { awaitWorkerSync, requestCompile }
            );
        } finally {
            delete window.fontManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(refreshWorkerCacheForReplayTargets).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
        expect(refreshOrder).toEqual(['sync', 'compile']);
    });

    test('retries local undo compile readiness from worker-sync state before compiling', async () => {
        const refreshOrder = [];
        const previousInitialized = fontCompilation.isInitialized;
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);

        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
            if (awaitWorkerSync.mock.calls.length === 2) {
                fontCompilation.setWorkerCacheDocumentReady(true);
            }
        });
        const queueCacheRefresh = jest.fn(async () => {
            refreshOrder.push('queue');
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
        });

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(
                        () => new Set(['adieresis'])
                    )
                }
            },
            lastChangeSource: 'keyboard-anchor',
            lastEditType: 'anchor',
            workerCacheUpdatePromise: null,
            awaitWorkerCacheUpdate: jest.fn(async () => {
                refreshOrder.push('cache');
            })
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        historyAction: 'undo',
                        transactionLabel: 'Drag anchor',
                        path: 'glyphs.a.layers.master-regular.anchors.0.x',
                        workerReplayTargets: [
                            {
                                glyphName: 'a',
                                layerId: 'master-regular'
                            },
                            {
                                glyphName: 'adieresis',
                                layerId: 'master-regular'
                            }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile,
                    queueCacheRefresh
                }
            );
        } finally {
            fontCompilation.isInitialized = previousInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            delete window.fontManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(2);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
        expect(refreshOrder).toEqual(['sync', 'sync', 'compile']);
    });

    test('skips local undo compile only when worker cache remains unready after readiness retry', async () => {
        const refreshOrder = [];
        const previousInitialized = fontCompilation.isInitialized;
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);

        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
        });
        const queueCacheRefresh = jest.fn(async () => {
            refreshOrder.push('queue');
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
        });

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(
                        () => new Set(['adieresis'])
                    )
                }
            },
            lastChangeSource: 'keyboard-anchor',
            lastEditType: 'anchor',
            workerCacheUpdatePromise: null,
            awaitWorkerCacheUpdate: jest.fn(async () => {
                refreshOrder.push('cache');
            })
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        historyAction: 'undo',
                        transactionLabel: 'Drag anchor',
                        path: 'glyphs.a.layers.master-regular.anchors.0.x',
                        workerReplayTargets: [
                            {
                                glyphName: 'a',
                                layerId: 'master-regular'
                            },
                            {
                                glyphName: 'adieresis',
                                layerId: 'master-regular'
                            }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile,
                    queueCacheRefresh
                }
            );
        } finally {
            fontCompilation.isInitialized = previousInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            delete window.fontManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(2);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).not.toHaveBeenCalled();
        expect(refreshOrder).toEqual(['sync', 'sync']);
    });

    test('skips local committed compile when worker cache remains unready after readiness retry', async () => {
        const refreshOrder = [];
        const previousInitialized = fontCompilation.isInitialized;
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);

        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
        });
        const queueCacheRefresh = jest.fn(async () => {
            refreshOrder.push('queue');
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
        });

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(
                        () => new Set(['adieresis'])
                    )
                }
            },
            lastChangeSource: 'keyboard-anchor',
            lastEditType: 'anchor',
            workerCacheUpdatePromise: null,
            awaitWorkerCacheUpdate: jest.fn(async () => {
                refreshOrder.push('cache');
            })
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag anchor',
                        path: 'glyphs.a.layers.master-regular.anchors.0.x',
                        workerReplayTargets: [
                            {
                                glyphName: 'a',
                                layerId: 'master-regular'
                            },
                            {
                                glyphName: 'adieresis',
                                layerId: 'master-regular'
                            }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile,
                    queueCacheRefresh
                }
            );
        } finally {
            fontCompilation.isInitialized = previousInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            delete window.fontManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(2);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).not.toHaveBeenCalled();
        expect(refreshOrder).toEqual(['sync', 'sync']);
    });

    test('local committed keyboard outline clears stale drift flag and compiles after worker sync', async () => {
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        const awaitWorkerSync = jest.fn(async () => {
            fontCompilation.setWorkerCacheDocumentReady(true);
        });
        const requestCompile = jest.fn(async () => {});
        const originalShowError = sidebarErrorDisplay.showError;
        const showErrorMock = jest.fn();
        const originalSendMessage = fontCompilation.sendMessage;
        const originalIsInitialized = fontCompilation.isInitialized;
        const sendMessageMock = jest.fn(async () => ({ success: true }));

        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);
        fontCompilation.sendMessage = sendMessageMock;
        sidebarErrorDisplay.showError = showErrorMock;

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            pendingBabelfontJsonSyncAfterDrag: false,
            pendingCommittedKeyboardDriftCheckAfterDrag: true,
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline'
        };
        const fontManagerState = window.fontManager;

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Arrow key',
                        path: 'glyphs.a.layers.layer-1.shapes.0.nodes.0.x',
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'layer-1' }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile
                }
            );
        } finally {
            delete window.fontManager;
            fontCompilation.sendMessage = originalSendMessage;
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            sidebarErrorDisplay.showError = originalShowError;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(2);
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
        expect(showErrorMock).not.toHaveBeenCalled();
        expect(
            fontManagerState.pendingCommittedKeyboardDriftCheckAfterDrag
        ).toBe(false);
    });

    test('local committed non-keyboard outline compiles without dump-layer inspection', async () => {
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        const awaitWorkerSync = jest.fn(async () => {
            fontCompilation.setWorkerCacheDocumentReady(true);
        });
        const requestCompile = jest.fn(async () => {});
        const originalShowError = sidebarErrorDisplay.showError;
        const showErrorMock = jest.fn();
        const originalSendMessage = fontCompilation.sendMessage;
        const originalIsInitialized = fontCompilation.isInitialized;
        const sendMessageMock = jest.fn(async () => ({ success: true }));

        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);
        fontCompilation.sendMessage = sendMessageMock;
        sidebarErrorDisplay.showError = showErrorMock;

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline'
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag point',
                        path: 'glyphs.a.layers.layer-1.shapes.0.nodes.0.x',
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'layer-1' }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile
                }
            );
        } finally {
            delete window.fontManager;
            fontCompilation.sendMessage = originalSendMessage;
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            sidebarErrorDisplay.showError = originalShowError;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(2);
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
        expect(showErrorMock).not.toHaveBeenCalled();
    });

    test('local committed outline with dependent replay targets compiles without dump-layer inspection', async () => {
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        const awaitWorkerSync = jest.fn(async () => {
            fontCompilation.setWorkerCacheDocumentReady(true);
        });
        const requestCompile = jest.fn(async () => {});
        const originalShowError = sidebarErrorDisplay.showError;
        const showErrorMock = jest.fn();
        const originalSendMessage = fontCompilation.sendMessage;
        const originalIsInitialized = fontCompilation.isInitialized;
        const expectedDrawing = {
            width: 533,
            id: 'layer-1',
            master: { type: 'DefaultForMaster', master: 'master-1' },
            shapes: [
                {
                    id: 'shape-1',
                    nodes: [
                        { x: 322, y: -8, nodetype: 'OffCurve', id: 'node-1' }
                    ],
                    closed: true
                }
            ],
            anchors: [{ name: 'top', x: 145, y: 594 }],
            guides: [],
            format_specific: {}
        };
        const rustDrawingDifferentKeyOrder = {
            master: { master: 'master-1', type: 'DefaultForMaster' },
            shapes: [
                {
                    nodes: [
                        { y: -8, id: 'node-1', x: 322, nodetype: 'OffCurve' }
                    ],
                    closed: true,
                    id: 'shape-1'
                }
            ],
            width: 533,
            guides: [],
            anchors: [{ y: 594, name: 'top', x: 145 }],
            format_specific: {},
            id: 'layer-1'
        };
        const dependentDrawing = {
            width: 533,
            id: 'layer-1',
            master: { type: 'DefaultForMaster', master: 'master-1' },
            shapes: [{ id: 'component-1', reference: 'a' }],
            format_specific: {}
        };
        const dependentDrawingDifferentKeyOrder = {
            shapes: [{ reference: 'a', id: 'component-1' }],
            width: 533,
            master: { master: 'master-1', type: 'DefaultForMaster' },
            format_specific: {},
            id: 'layer-1'
        };
        const sendMessageMock = jest.fn(async () => ({
            dumpJson: JSON.stringify({
                targets: [
                    {
                        glyphName: 'a',
                        layerId: 'layer-1',
                        canonicalDrawing: rustDrawingDifferentKeyOrder,
                        subsetDrawing: rustDrawingDifferentKeyOrder,
                        ydocDrawing: rustDrawingDifferentKeyOrder
                    },
                    {
                        glyphName: 'aacute',
                        layerId: 'layer-1',
                        canonicalDrawing: dependentDrawingDifferentKeyOrder,
                        subsetDrawing: null,
                        ydocDrawing: dependentDrawingDifferentKeyOrder
                    }
                ]
            })
        }));

        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);
        fontCompilation.sendMessage = sendMessageMock;
        sidebarErrorDisplay.showError = showErrorMock;

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set()),
                    findGlyph: jest.fn((glyphName) => ({
                        findDrawingById: jest.fn((drawingId) => {
                            if (drawingId !== 'layer-1') {
                                return null;
                            }
                            if (glyphName === 'a') {
                                return { toJSON: () => expectedDrawing };
                            }
                            if (glyphName === 'aacute') {
                                return { toJSON: () => dependentDrawing };
                            }
                            return null;
                        })
                    }))
                }
            },
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline',
            normalizeDrawingForRust: jest.fn((drawing) => drawing)
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag point',
                        path: 'glyphs.a.layers.layer-1.shapes.0.nodes.0.x',
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'layer-1' },
                            { glyphName: 'aacute', layerId: 'layer-1' }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile
                }
            );
        } finally {
            delete window.fontManager;
            fontCompilation.sendMessage = originalSendMessage;
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            sidebarErrorDisplay.showError = originalShowError;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(2);
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(showErrorMock).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
    });

    test('local committed outline ignores retired rust cache drift inspection for empty optional containers', async () => {
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        const awaitWorkerSync = jest.fn(async () => {
            fontCompilation.setWorkerCacheDocumentReady(true);
        });
        const requestCompile = jest.fn(async () => {});
        const originalShowError = sidebarErrorDisplay.showError;
        const showErrorMock = jest.fn();
        const originalSendMessage = fontCompilation.sendMessage;
        const originalIsInitialized = fontCompilation.isInitialized;
        const expectedDrawing = {
            width: 533,
            id: 'layer-1',
            master: { type: 'DefaultForMaster', master: 'master-1' },
            shapes: [
                {
                    id: 'shape-1',
                    nodes: [
                        { x: 322, y: -8, nodetype: 'OffCurve', id: 'node-1' }
                    ],
                    closed: true
                }
            ],
            anchors: [{ name: 'top', x: 145, y: 594 }]
        };
        const rustCanonicalDrawing = {
            ...expectedDrawing,
            guides: [],
            format_specific: {}
        };
        const sendMessageMock = jest.fn(async () => ({
            dumpJson: JSON.stringify({
                targets: [
                    {
                        glyphName: 'a',
                        layerId: 'layer-1',
                        canonicalDrawing: rustCanonicalDrawing,
                        subsetDrawing: rustCanonicalDrawing,
                        ydocDrawing: expectedDrawing
                    }
                ]
            })
        }));

        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);
        fontCompilation.sendMessage = sendMessageMock;
        sidebarErrorDisplay.showError = showErrorMock;

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set()),
                    findGlyph: jest.fn((glyphName) => ({
                        findDrawingById: jest.fn((drawingId) =>
                            glyphName === 'a' && drawingId === 'layer-1'
                                ? {
                                      toJSON: () => expectedDrawing
                                  }
                                : null
                        )
                    }))
                }
            },
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline',
            normalizeDrawingForRust: jest.fn((drawing) => drawing)
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag point',
                        path: 'glyphs.a.layers.layer-1.shapes.0.nodes.0.x',
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'layer-1' }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile
                }
            );
        } finally {
            delete window.fontManager;
            fontCompilation.sendMessage = originalSendMessage;
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            sidebarErrorDisplay.showError = originalShowError;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(2);
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(showErrorMock).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
    });

    test('local committed outline ignores retired rust cache drift inspection for nested empty format_specific trees', async () => {
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        const awaitWorkerSync = jest.fn(async () => {
            fontCompilation.setWorkerCacheDocumentReady(true);
        });
        const requestCompile = jest.fn(async () => {});
        const originalShowError = sidebarErrorDisplay.showError;
        const showErrorMock = jest.fn();
        const originalSendMessage = fontCompilation.sendMessage;
        const originalIsInitialized = fontCompilation.isInitialized;
        const expectedDrawing = {
            width: 533,
            id: 'layer-1',
            master: { type: 'DefaultForMaster', master: 'master-1' },
            shapes: [
                {
                    id: 'shape-1',
                    nodes: [
                        { x: 322, y: -8, nodetype: 'OffCurve', id: 'node-1' }
                    ],
                    closed: true
                }
            ],
            anchors: [{ name: 'top', x: 145, y: 594 }]
        };
        const rustCanonicalDrawing = {
            ...expectedDrawing,
            format_specific: {
                com: {
                    schriftgestalt: {
                        Glyphs: {
                            attr: {}
                        }
                    }
                }
            }
        };
        const sendMessageMock = jest.fn(async () => ({
            dumpJson: JSON.stringify({
                targets: [
                    {
                        glyphName: 'a',
                        layerId: 'layer-1',
                        canonicalDrawing: rustCanonicalDrawing,
                        subsetDrawing: rustCanonicalDrawing,
                        ydocDrawing: expectedDrawing
                    }
                ]
            })
        }));

        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);
        fontCompilation.sendMessage = sendMessageMock;
        sidebarErrorDisplay.showError = showErrorMock;

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set()),
                    findGlyph: jest.fn((glyphName) => ({
                        findDrawingById: jest.fn((drawingId) =>
                            glyphName === 'a' && drawingId === 'layer-1'
                                ? {
                                      toJSON: () => expectedDrawing
                                  }
                                : null
                        )
                    }))
                }
            },
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline',
            normalizeDrawingForRust: jest.fn((drawing) => drawing)
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag point',
                        path: 'glyphs.a.layers.layer-1.shapes.0.nodes.0.x',
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'layer-1' }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile
                }
            );
        } finally {
            delete window.fontManager;
            fontCompilation.sendMessage = originalSendMessage;
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            sidebarErrorDisplay.showError = originalShowError;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(2);
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(showErrorMock).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
    });

    test('local committed outline does not gate compile on retired semantic drift inspection', async () => {
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        const awaitWorkerSync = jest.fn(async () => {
            fontCompilation.setWorkerCacheDocumentReady(true);
        });
        const requestCompile = jest.fn(async () => {});
        const originalShowError = sidebarErrorDisplay.showError;
        const showErrorMock = jest.fn();
        const originalSendMessage = fontCompilation.sendMessage;
        const originalIsInitialized = fontCompilation.isInitialized;
        const expectedDrawing = {
            width: 533,
            id: 'layer-1',
            master: { type: 'DefaultForMaster', master: 'master-1' },
            shapes: [
                {
                    id: 'shape-1',
                    nodes: [
                        { x: 322, y: -8, nodetype: 'OffCurve', id: 'node-1' }
                    ],
                    closed: true
                }
            ],
            anchors: [{ name: 'top', x: 145, y: 594 }]
        };
        const rustCanonicalDrawing = {
            ...expectedDrawing,
            format_specific: { legacy: true }
        };
        const sendMessageMock = jest.fn(async () => ({
            dumpJson: JSON.stringify({
                targets: [
                    {
                        glyphName: 'a',
                        layerId: 'layer-1',
                        canonicalDrawing: rustCanonicalDrawing,
                        subsetDrawing: rustCanonicalDrawing,
                        ydocDrawing: expectedDrawing
                    }
                ]
            })
        }));

        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);
        fontCompilation.sendMessage = sendMessageMock;
        sidebarErrorDisplay.showError = showErrorMock;

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set()),
                    findGlyph: jest.fn((glyphName) => ({
                        findDrawingById: jest.fn((drawingId) =>
                            glyphName === 'a' && drawingId === 'layer-1'
                                ? {
                                      toJSON: () => expectedDrawing
                                  }
                                : null
                        )
                    }))
                }
            },
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline',
            normalizeDrawingForRust: jest.fn((drawing) => drawing)
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag point',
                        path: 'glyphs.a.layers.layer-1.shapes.0.nodes.0.x',
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'layer-1' }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile
                }
            );
        } finally {
            delete window.fontManager;
            fontCompilation.sendMessage = originalSendMessage;
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            sidebarErrorDisplay.showError = originalShowError;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(2);
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(showErrorMock).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
    });

    test('local committed anchor refresh compiles without dump-layer inspection when subset cache is absent', async () => {
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        const awaitWorkerSync = jest.fn(async () => {
            fontCompilation.setWorkerCacheDocumentReady(true);
        });
        const requestCompile = jest.fn(async () => {});
        const originalShowError = sidebarErrorDisplay.showError;
        const showErrorMock = jest.fn();
        const originalSendMessage = fontCompilation.sendMessage;
        const originalIsInitialized = fontCompilation.isInitialized;
        const sourceDrawing = {
            width: 533,
            id: '3114FB65-9464-41A5-B67E-A8F9F43C0EF1',
            master: {
                master: '3114FB65-9464-41A5-B67E-A8F9F43C0EF1',
                type: 'DefaultForMaster'
            },
            shapes: [
                {
                    id: 'source-component-1',
                    reference: 'a',
                    transform: {
                        order: 'RestOfTheWorld',
                        rotation: 0,
                        scale: [1, 1],
                        skew: [0, 0],
                        translation: [0, 0]
                    }
                }
            ],
            format_specific: {
                'com.schriftgestalt.Glyphs.attr': {}
            }
        };
        const dependentDrawing = {
            width: 533,
            id: '3114FB65-9464-41A5-B67E-A8F9F43C0EF1',
            master: {
                master: '3114FB65-9464-41A5-B67E-A8F9F43C0EF1',
                type: 'DefaultForMaster'
            },
            shapes: [
                {
                    id: 'dependent-component-1',
                    reference: 'a',
                    transform: {
                        order: 'RestOfTheWorld',
                        rotation: 0,
                        scale: [1, 1],
                        skew: [0, 0],
                        translation: [0, 0]
                    }
                },
                {
                    id: 'dependent-component-2',
                    reference: 'acutecomb',
                    transform: {
                        order: 'Glyphs',
                        rotation: 0,
                        scale: [1, 1],
                        skew: [0, 0],
                        translation: [136, 77]
                    }
                }
            ],
            format_specific: {
                'com.schriftgestalt.Glyphs.attr': {}
            }
        };
        const sendMessageMock = jest.fn(async () => ({
            dumpJson: JSON.stringify({
                targets: [
                    {
                        glyphName: 'a',
                        layerId: '3114FB65-9464-41A5-B67E-A8F9F43C0EF1',
                        canonicalDrawing: sourceDrawing,
                        subsetDrawing: null,
                        ydocDrawing: sourceDrawing
                    },
                    {
                        glyphName: 'aacute',
                        layerId: '3114FB65-9464-41A5-B67E-A8F9F43C0EF1',
                        canonicalDrawing: dependentDrawing,
                        subsetDrawing: null,
                        ydocDrawing: dependentDrawing
                    }
                ]
            })
        }));

        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);
        fontCompilation.sendMessage = sendMessageMock;
        sidebarErrorDisplay.showError = showErrorMock;

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set()),
                    findGlyph: jest.fn((glyphName) => ({
                        findDrawingById: jest.fn((drawingId) =>
                            glyphName === 'a' &&
                            drawingId === '3114FB65-9464-41A5-B67E-A8F9F43C0EF1'
                                ? { toJSON: () => sourceDrawing }
                                : glyphName === 'aacute' &&
                                    drawingId ===
                                        '3114FB65-9464-41A5-B67E-A8F9F43C0EF1'
                                  ? { toJSON: () => dependentDrawing }
                                  : null
                        )
                    }))
                }
            },
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline',
            normalizeDrawingForRust: jest.fn((drawing) => drawing)
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag anchor',
                        path: 'glyphs.a.layers.3114FB65-9464-41A5-B67E-A8F9F43C0EF1.anchors.0.x',
                        workerReplayTargets: [
                            {
                                glyphName: 'a',
                                layerId: '3114FB65-9464-41A5-B67E-A8F9F43C0EF1'
                            },
                            {
                                glyphName: 'aacute',
                                layerId: '3114FB65-9464-41A5-B67E-A8F9F43C0EF1'
                            }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile
                }
            );
        } finally {
            delete window.fontManager;
            fontCompilation.sendMessage = originalSendMessage;
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            sidebarErrorDisplay.showError = originalShowError;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(2);
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(showErrorMock).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
    });

    test('continues the post-commit keyboard compile when post-drag worker state is already fresh', async () => {
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        const awaitWorkerSync = jest.fn(async () => {
            fontCompilation.setWorkerCacheDocumentReady(true);
        });
        const requestCompile = jest.fn(async () => {});
        const originalShowError = sidebarErrorDisplay.showError;
        const showErrorMock = jest.fn();
        const originalSendMessage = fontCompilation.sendMessage;
        const originalIsInitialized = fontCompilation.isInitialized;
        const expectedDrawing = {
            width: 542,
            shapes: [],
            anchors: [{ name: 'top', x: 278, y: 500 }],
            guides: []
        };
        const sendMessageMock = jest.fn(async () => ({
            dumpJson: JSON.stringify({
                targets: [
                    {
                        glyphName: 'a',
                        layerId: 'layer-1',
                        canonicalDrawing: expectedDrawing,
                        subsetDrawing: expectedDrawing,
                        ydocDrawing: expectedDrawing
                    }
                ]
            })
        }));

        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);
        fontCompilation.sendMessage = sendMessageMock;
        sidebarErrorDisplay.showError = showErrorMock;

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set()),
                    findGlyph: jest.fn((glyphName) => ({
                        findDrawingById: jest.fn((drawingId) =>
                            glyphName === 'a' && drawingId === 'layer-1'
                                ? {
                                      toJSON: () => expectedDrawing
                                  }
                                : null
                        )
                    }))
                }
            },
            pendingBabelfontJsonSyncAfterDrag: false,
            pendingCommittedKeyboardDriftCheckAfterDrag: true,
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline',
            normalizeDrawingForRust: jest.fn((drawing) => drawing)
        };
        const fontManagerState = window.fontManager;

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Arrow key',
                        path: 'glyphs.a.layers.layer-1.shapes.0.nodes.0.x',
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'layer-1' }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile
                }
            );
        } finally {
            delete window.fontManager;
            fontCompilation.sendMessage = originalSendMessage;
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            sidebarErrorDisplay.showError = originalShowError;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(2);
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(showErrorMock).not.toHaveBeenCalled();
        expect(
            fontManagerState.pendingCommittedKeyboardDriftCheckAfterDrag
        ).toBe(false);
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
    });

    test('skips the post-commit keyboard drift check in fresh keyboard state', async () => {
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        const awaitWorkerSync = jest.fn(async () => {
            fontCompilation.setWorkerCacheDocumentReady(true);
        });
        const requestCompile = jest.fn(async () => {});
        const originalShowError = sidebarErrorDisplay.showError;
        const showErrorMock = jest.fn();
        const originalSendMessage = fontCompilation.sendMessage;
        const originalIsInitialized = fontCompilation.isInitialized;
        const sendMessageMock = jest.fn(async () => ({ success: true }));

        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);
        fontCompilation.sendMessage = sendMessageMock;
        sidebarErrorDisplay.showError = showErrorMock;

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            pendingBabelfontJsonSyncAfterDrag: false,
            pendingCommittedKeyboardDriftCheckAfterDrag: false,
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline',
            normalizeDrawingForRust: jest.fn((drawing) => drawing)
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Arrow key',
                        path: 'glyphs.a.layers.layer-1.shapes.0.nodes.0.x',
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'layer-1' }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile
                }
            );
        } finally {
            delete window.fontManager;
            fontCompilation.sendMessage = originalSendMessage;
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            sidebarErrorDisplay.showError = originalShowError;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(2);
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(showErrorMock).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
    });

    test('prefers inferred keyboard-anchor context over a stale trailing full-compile source', async () => {
        const awaitWorkerSync = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});
        const queueCacheRefresh = jest.fn(async () => {});

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            lastChangeSource: 'debounced-post-interaction-full-compile',
            lastEditType: null
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Move anchor',
                        path: 'glyphs.a.layers.master-regular.anchors.0.x',
                        workerReplayTargets: [
                            {
                                glyphName: 'a',
                                layerId: 'master-regular'
                            }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile,
                    queueCacheRefresh
                }
            );
        } finally {
            delete window.fontManager;
        }

        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
    });

    test('refreshes local replay targets for forwarded master reinterpolation glyph snapshots before compile', async () => {
        const refreshOrder = [];
        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
            window.fontManager.lastChangeSource = 'station-reinterpolate-batch';
            window.fontManager.lastEditType = 'outline';
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
        });
        const queueCacheRefresh = jest.fn(async () => {
            refreshOrder.push('queue');
        });

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            lastChangeSource: 'station-reinterpolate-batch',
            lastEditType: 'outline'
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Reinterpolate drawing batch sync',
                        path: 'glyphs.A',
                        workerReplayTargets: [
                            {
                                glyphName: 'A',
                                layerId: 'master-bold'
                            }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile,
                    queueCacheRefresh
                }
            );
        } finally {
            delete window.fontManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
        expect(refreshOrder).toEqual(['sync', 'compile']);
    });

    test('classifies local add-master batch packets as full editing compiles', async () => {
        const refreshOrder = [];
        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
        });
        const queueCacheRefresh = jest.fn(async () => {
            refreshOrder.push('queue');
        });

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            lastChangeSource: null,
            lastEditType: null
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Add master',
                        path: 'masters'
                    },
                    {
                        transactionLabel: 'Add master',
                        path: 'glyphs.A.layers.master-3',
                        workerReplayTargets: [
                            {
                                glyphName: 'A',
                                layerId: 'master-3'
                            }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile,
                    queueCacheRefresh
                }
            );
        } finally {
            delete window.fontManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
        expect(refreshOrder).toEqual(['sync', 'compile']);
    });

    test('classifies local remove-master packets as full editing compiles', async () => {
        const awaitWorkerSync = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});
        const queueCacheRefresh = jest.fn(async () => {});

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            lastChangeSource: null,
            lastEditType: null
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Remove master',
                        path: 'masters'
                    },
                    {
                        transactionLabel: 'Remove master',
                        path: 'glyphs.A.layers.master-3',
                        workerReplayTargets: [
                            {
                                glyphName: 'A',
                                layerId: 'master-3'
                            }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile,
                    queueCacheRefresh
                }
            );
        } finally {
            delete window.fontManager;
        }

        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
    });

    test('classifies mixed automatic-alignment and kern-group packets as full editing compiles', async () => {
        const awaitWorkerSync = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});
        const queueCacheRefresh = jest.fn(async () => {});

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            lastChangeSource: null,
            lastEditType: null
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Set component automatic alignment',
                        path: 'glyphs.manualComposite.layers.MC0.shapes.0.format_specific'
                    },
                    {
                        transactionLabel: 'Set component automatic alignment',
                        path: 'first_kern_groups'
                    },
                    {
                        transactionLabel: 'Set component automatic alignment',
                        path: 'second_kern_groups'
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile,
                    queueCacheRefresh
                }
            );
        } finally {
            delete window.fontManager;
        }

        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
    });

    test('rebuilds editor axis sliders after committed axis range edits', async () => {
        expect(committedEntriesTouchAxes([{ path: 'axes.0.max' }])).toBe(true);
        expect(committedEntriesTouchAxes([{ path: 'masters' }])).toBe(false);

        const awaitWorkerSync = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});
        const updateAxesUI = jest.fn(async () => {});

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            lastChangeSource: null,
            lastEditType: null
        };
        window.glyphCanvas = {
            axesManager: {
                updateAxesUI
            }
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Edit axis max',
                        path: 'axes.0.max'
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile
                }
            );
        } finally {
            delete window.fontManager;
            delete window.glyphCanvas;
        }

        expect(updateAxesUI).toHaveBeenCalledTimes(1);
        expect(requestCompile).toHaveBeenCalled();
    });

    test('skips bootstrap-style local compile wake-up before the first editing font exists', async () => {
        const awaitWorkerSync = jest.fn(async () => {});
        const requestRecompileWithoutDataChange = jest.fn();
        const checkAndSchedule = jest.fn();

        window.fontManager = {
            currentFont: {
                changeVersion: 0,
                requestRecompileWithoutDataChange,
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            editingFont: null,
            lastChangeSource: null,
            lastEditType: null
        };
        window.autoCompileManager = {
            checkAndSchedule
        };

        try {
            await handleCommittedChangeRefresh([], 'local', {
                awaitWorkerSync
            });
        } finally {
            delete window.fontManager;
            delete window.autoCompileManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(requestRecompileWithoutDataChange).not.toHaveBeenCalled();
        expect(checkAndSchedule).not.toHaveBeenCalled();
    });

    test('allows the same local committed compile wake-up after startup readiness exists', async () => {
        const awaitWorkerSync = jest.fn(async () => {});
        const requestRecompileWithoutDataChange = jest.fn();
        const checkAndSchedule = jest.fn();

        window.fontManager = {
            currentFont: {
                changeVersion: 0,
                requestRecompileWithoutDataChange,
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            editingFont: new Uint8Array([1, 2, 3]),
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
        window.autoCompileManager = {
            checkAndSchedule
        };

        try {
            await handleCommittedChangeRefresh([], 'local', {
                awaitWorkerSync
            });
        } finally {
            delete window.fontManager;
            delete window.autoCompileManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(checkAndSchedule).toHaveBeenCalledTimes(1);
    });

    test('waits for chained local worker cache updates before compile and overview refresh', async () => {
        let resolveFirstCacheUpdate;
        let resolveSecondCacheUpdate;
        const firstCacheUpdate = new Promise((resolve) => {
            resolveFirstCacheUpdate = resolve;
        });
        const secondCacheUpdate = new Promise((resolve) => {
            resolveSecondCacheUpdate = resolve;
        });
        const refreshOrder = [];
        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
        });
        const queueCacheRefresh = jest.fn(() => {
            refreshOrder.push('queue');
            return Promise.resolve();
        });
        const glyphChangedHandler = jest.fn();

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(
                        () => new Set(['adieresis'])
                    )
                }
            },
            lastChangeSource: 'keyboard-anchor',
            lastEditType: 'anchor',
            workerCacheUpdatePromise: firstCacheUpdate,
            awaitWorkerCacheUpdate: jest.fn(async () => {
                const pendingPromise =
                    window.fontManager.workerCacheUpdatePromise;
                refreshOrder.push(
                    pendingPromise === firstCacheUpdate ? 'cache-1' : 'cache-2'
                );
                await pendingPromise;
                if (
                    window.fontManager.workerCacheUpdatePromise ===
                    pendingPromise
                ) {
                    window.fontManager.workerCacheUpdatePromise = null;
                }
            })
        };
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            const refreshPromise = handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag anchor',
                        path: 'glyphs.a.layers.master-regular.anchors.0.x',
                        workerReplayTargets: [
                            {
                                glyphName: 'a',
                                layerId: 'master-regular'
                            },
                            {
                                glyphName: 'adieresis',
                                layerId: 'master-regular'
                            }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile,
                    queueCacheRefresh
                }
            );

            await Promise.resolve();
            expect(requestCompile).not.toHaveBeenCalled();
            expect(glyphChangedHandler).not.toHaveBeenCalled();

            window.fontManager.workerCacheUpdatePromise = secondCacheUpdate;
            resolveFirstCacheUpdate();
            await Promise.resolve();
            await Promise.resolve();

            expect(requestCompile).not.toHaveBeenCalled();
            expect(glyphChangedHandler).not.toHaveBeenCalled();

            resolveSecondCacheUpdate();
            await new Promise((resolve) => setTimeout(resolve, 0));

            // requestCompile is still deferred until the forwarded worker sync
            // and any chained worker-cache updates have completed.
            expect(requestCompile).toHaveBeenCalledTimes(1);
            // glyphChanged is also dispatched after compile request
            // (overview refresh from committed entries)
            expect(glyphChangedHandler).toHaveBeenCalledTimes(1);

            await refreshPromise;
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
            delete window.fontManager;
        }

        expect(requestCompile).toHaveBeenCalledTimes(1);
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
        expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
        expect(glyphChangedHandler.mock.calls[0][0].detail).toEqual({
            glyphName: 'a',
            glyphNames: ['a', 'adieresis']
        });
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(refreshOrder).toEqual([
            'sync',
            'cache-1',
            'sync',
            'cache-2',
            'sync',
            'compile'
        ]);
    });

    test('requests remote compile only after worker cache update resolve', async () => {
        const refreshOrder = [];
        let resolveCacheUpdate;
        let resolveWorkerSync;
        const workerSyncPromise = new Promise((resolve) => {
            resolveWorkerSync = () => {
                refreshOrder.push('sync-resolved');
                resolve();
            };
        });
        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
            await workerSyncPromise;
        });
        const cacheUpdatePromise = new Promise((resolve) => {
            resolveCacheUpdate = () => {
                refreshOrder.push('cache-resolved');
                resolve();
            };
        });
        const awaitWorkerCacheUpdate = jest.fn(async () => {
            refreshOrder.push('cache');
            await window.fontManager.workerCacheUpdatePromise;
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
        });
        const remoteEntries = [
            {
                transactionLabel: 'Drag anchor',
                path: 'glyphs.a.layers.master-regular.anchors.0.x',
                workerReplayTargets: [
                    {
                        glyphName: 'a',
                        layerId: 'master-regular'
                    }
                ]
            }
        ];

        try {
            window.fontManager = {
                workerCacheUpdatePromise: cacheUpdatePromise,
                awaitWorkerCacheUpdate
            };
            const refreshPromise = handleRemoteChangeRefresh(remoteEntries, {
                requestCompile,
                awaitWorkerSync
            });

            expect(requestCompile).not.toHaveBeenCalled();
            expect(refreshOrder).toEqual(['sync']);

            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
            expect(requestCompile).not.toHaveBeenCalled();
            expect(refreshOrder).toEqual(['sync']);

            resolveWorkerSync();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            expect(awaitWorkerCacheUpdate).toHaveBeenCalledTimes(1);
            expect(requestCompile).not.toHaveBeenCalled();
            expect(refreshOrder).toEqual(['sync', 'sync-resolved', 'cache']);

            resolveCacheUpdate();
            await refreshPromise;

            expect(requestCompile).toHaveBeenCalledTimes(1);
            expect(requestCompile).toHaveBeenNthCalledWith(
                1,
                'remote-change',
                null
            );
            expect(refreshOrder).toEqual([
                'sync',
                'sync-resolved',
                'cache',
                'cache-resolved',
                'sync',
                'compile'
            ]);
            expect(refreshOrder.indexOf('compile')).toBeGreaterThan(
                refreshOrder.indexOf('cache-resolved')
            );
        } finally {
            delete window.fontManager;
        }
    });

    test('refreshes the active receiver outline editor after worker sync without a second worker cache refresh', async () => {
        const refreshOrder = [];
        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
        });
        const queueCacheRefresh = jest.fn(async () => {
            refreshOrder.push('queue');
        });
        const requestRepaintAfterCompile = jest.fn(() => {
            refreshOrder.push('repaint');
        });
        const reconcileSelectionAfterModelSync = jest.fn(async () => {
            refreshOrder.push('reconcile');
        });
        const fetchDrawingData = jest.fn(async (skipRender, glyphName) => {
            refreshOrder.push(
                `fetch:${skipRender ? 'skip' : 'render'}:${glyphName}`
            );
        });

        window.glyphCanvas = {
            requestRepaintAfterCompile,
            outlineEditor: {
                active: true,
                draggingSomething: false,
                pendingRemoteRefreshAfterDrag: false,
                selectedDrawingId: 'master-regular',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                reconcileSelectionAfterModelSync,
                fetchDrawingData,
                runDeterministicRefresh: jest.fn(async (callback) => {
                    refreshOrder.push('deterministic');
                    await callback();
                })
            }
        };
        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            awaitWorkerCacheUpdate: jest.fn(async () => {
                refreshOrder.push('cache');
            })
        };

        try {
            await handleRemoteChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag anchor',
                        path: 'glyphs.a.layers.master-regular.anchors.0.x',
                        workerReplayTargets: [
                            {
                                glyphName: 'a',
                                layerId: 'master-regular'
                            }
                        ]
                    }
                ],
                {
                    awaitWorkerSync,
                    requestCompile,
                    queueCacheRefresh
                }
            );
        } finally {
            delete window.glyphCanvas;
            delete window.fontManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(reconcileSelectionAfterModelSync).toHaveBeenCalledWith({
            skipRender: true
        });
        expect(fetchDrawingData).toHaveBeenCalledWith(true, 'a');
        expect(requestRepaintAfterCompile).toHaveBeenCalledTimes(1);
        expect(requestCompile).toHaveBeenCalledWith('remote-change', null);
        expect(refreshOrder).toEqual([
            'sync',
            'reconcile',
            'deterministic',
            'fetch:skip:a',
            'repaint',
            'compile'
        ]);
    });

    test('skips bootstrap-style remote refresh when there are no committed entries', async () => {
        const queueCacheRefresh = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});

        await handleCommittedChangeRefresh([], 'remote', {
            requestCompile,
            queueCacheRefresh
        });

        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).not.toHaveBeenCalled();
    });

    test('classifies batched sidebearing arrow-key entries as remote outline edits', async () => {
        const queueCacheRefresh = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});
        const replayTargets = [
            {
                glyphName: 'l',
                layerId: 'master-regular'
            },
            {
                glyphName: 'n',
                layerId: 'master-regular'
            }
        ];

        await handleRemoteChangeRefresh(
            [
                {
                    transactionLabel: 'Arrow key',
                    path: 'glyphs.l.layers.master-regular',
                    visualAnchorSide: 'left',
                    workerReplayTargets: replayTargets
                }
            ],
            {
                requestCompile,
                queueCacheRefresh
            }
        );

        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenNthCalledWith(
            1,
            'remote-change',
            null
        );
        expect(requestCompile).toHaveBeenCalledTimes(1);
    });

    test('disables selected-layer fallback for remote changes without replay targets', async () => {
        const queueCacheRefresh = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});

        await handleRemoteChangeRefresh(
            [
                {
                    transactionLabel: 'Remote metadata sync',
                    path: 'features.classes.Uppercase.code',
                    workerReplayTargets: []
                }
            ],
            {
                requestCompile,
                queueCacheRefresh
            }
        );

        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith('feature-code', null);
    });

    test('classifies forwarded master reinterpolation packets as remote outline edits', async () => {
        const replayTargets = [{ glyphName: 'A', layerId: 'master-bold' }];
        const queueCacheRefresh = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});

        await handleRemoteChangeRefresh(
            [
                {
                    transactionLabel: 'Reinterpolate drawing batch sync',
                    path: 'glyphs.A',
                    workerReplayTargets: replayTargets
                }
            ],
            {
                requestCompile,
                queueCacheRefresh
            }
        );

        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith('remote-change', null);
    });

    test('classifies forwarded single-layer reinterpolation packets as remote outline edits', async () => {
        const replayTargets = [{ glyphName: 'A', layerId: 'brace-layer' }];
        const queueCacheRefresh = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});

        await handleRemoteChangeRefresh(
            [
                {
                    transactionLabel: 'Reinterpolate drawing sync',
                    path: 'glyphs.A.layers.brace-layer',
                    workerReplayTargets: replayTargets
                }
            ],
            {
                requestCompile,
                queueCacheRefresh
            }
        );

        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith('remote-change', null);
    });

    test('classifies forwarded add-master batch packets as full remote compiles', async () => {
        const replayTargets = [{ glyphName: 'A', layerId: 'master-3' }];
        const queueCacheRefresh = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});

        await handleRemoteChangeRefresh(
            [
                {
                    transactionLabel: 'Add master',
                    path: 'masters'
                },
                {
                    transactionLabel: 'Add master',
                    path: 'glyphs.A.layers.master-3',
                    workerReplayTargets: replayTargets
                }
            ],
            {
                requestCompile,
                queueCacheRefresh
            }
        );

        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith('remote-change', null);
    });

    test('classifies forwarded remove-master packets as full remote compiles', async () => {
        const queueCacheRefresh = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});

        await handleRemoteChangeRefresh(
            [
                {
                    transactionLabel: 'Remove master',
                    path: 'masters'
                },
                {
                    transactionLabel: 'Remove master',
                    path: 'glyphs.A.layers.master-3',
                    workerReplayTargets: [
                        { glyphName: 'A', layerId: 'master-3' }
                    ]
                }
            ],
            {
                requestCompile,
                queueCacheRefresh
            }
        );

        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith('remote-change', null);
    });

    test('local GUI commit with downstream replay targets refreshes dependents before compile', async () => {
        const awaitWorkerSync = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});
        const queueCacheRefresh = jest.fn(async () => {});
        const glyphChangedHandler = jest.fn();

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline'
        };
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Set sidebearing',
                        path: 'glyphs.A.layers.layer-1',
                        visualAnchorSide: 'right',
                        workerReplayTargets: [
                            { glyphName: 'A', layerId: 'layer-1' },
                            { glyphName: 'B', layerId: 'layer-2' }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile,
                    queueCacheRefresh
                }
            );
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
            delete window.fontManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
    });

    test('local sidebearing-key commit with downstream replay targets refreshes dependents before compile', async () => {
        const awaitWorkerSync = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});
        const queueCacheRefresh = jest.fn(async () => {});
        const glyphChangedHandler = jest.fn();
        const replayTargets = [
            { glyphName: 'A', layerId: 'layer-1' },
            { glyphName: 'B', layerId: 'layer-2' }
        ];

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            lastChangeSource: 'keyboard-sidebearing',
            lastEditType: 'outline'
        };
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Set sidebearing',
                        path: 'glyphs.A.format_specific.metric_right'
                    },
                    {
                        transactionLabel: 'Set sidebearing',
                        path: 'glyphs.A.layers.layer-1.width',
                        visualAnchorSide: 'right',
                        workerReplayTargets: replayTargets
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile,
                    queueCacheRefresh
                }
            );
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
            delete window.fontManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
    });

    test('local feature-code commit still relies on the forwarded worker update', async () => {
        const awaitWorkerSync = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});
        const queueCacheRefresh = jest.fn(async () => {});
        const glyphChangedHandler = jest.fn();

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            lastChangeSource: 'feature-code',
            lastEditType: null
        };
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Edit feature code',
                        path: 'features.features.0.1.code',
                        workerReplayTargets: []
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile,
                    queueCacheRefresh
                }
            );
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
            delete window.fontManager;
        }

        // Local committed packets rely on the forwarded worker update even
        // when the edit is not a layer-scoped GUI packet. Feature paths
        // compile as feature-code so the worker rebuilds its feature list.
        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith('feature-code', null);
    });

    test('classifies local feature-code commits as feature-code recompiles', async () => {
        const awaitWorkerSync = jest.fn(async () => {});
        const queueCacheRefresh = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            lastChangeSource: null,
            lastEditType: null
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Edit feature code',
                        path: 'features.features.0.1.code',
                        workerReplayTargets: []
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile,
                    queueCacheRefresh
                }
            );
        } finally {
            delete window.fontManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith('feature-code', null);
    });

    describe('idle view lock', () => {
        const originalGlyphCanvas = window.glyphCanvas;
        const originalFontManager = window.fontManager;

        afterEach(() => {
            window.glyphCanvas = originalGlyphCanvas;
            window.fontManager = originalFontManager;
        });

        function installReceiverHarness({
            activeGlyphName,
            activeDrawingId: activeDrawingId,
            currentDrawingWidth,
            initialPanX,
            initialScale,
            editMode = true,
            draggingSomething = false
        }) {
            const drawing = { width: currentDrawingWidth };
            const fontModel = {
                findGlyph: jest.fn(() => ({
                    findDrawingById: jest.fn((id) =>
                        id === activeDrawingId ? drawing : null
                    )
                }))
            };
            const refreshGlyphAdvanceDeltasLive = jest.fn(() => true);
            const captureIdleViewLock = jest.fn(() => !draggingSomething);
            const reapplyIdleViewLock = jest.fn(() => true);
            const clearIdleViewLock = jest.fn();
            const glyphCanvas = {
                viewportManager: { panX: initialPanX, scale: initialScale },
                textRunEditor: { refreshGlyphAdvanceDeltasLive, cursorX: 120 },
                outlineEditor: {
                    active: editMode,
                    draggingSomething,
                    selectedDrawingId: activeDrawingId,
                    parseGlyphStack: () => [{ glyphName: activeGlyphName }],
                    performHitDetection: jest.fn()
                },
                getCurrentGlyphName: () => activeGlyphName,
                captureIdleViewLock,
                reapplyIdleViewLock,
                hasPendingIdleViewLock: jest.fn(() => !draggingSomething),
                clearIdleViewLock,
                syncCurrentOutlineDrawingDataFromModel: jest.fn(),
                updatePropertyPanel: jest.fn(),
                render: jest.fn()
            };
            window.glyphCanvas = glyphCanvas;
            window.fontManager = {
                currentFont: { fontModel },
                workerCacheUpdatePromise: Promise.resolve()
            };
            return { glyphCanvas, fontModel };
        }

        test("remote colon-path sidebearing packet locks this window's edit-mode bbox", async () => {
            const { glyphCanvas } = installReceiverHarness({
                activeGlyphName: 'a',
                activeDrawingId: 'master-regular',
                currentDrawingWidth: 560,
                initialPanX: 200,
                initialScale: 2
            });

            await handleRemoteChangeRefresh(
                [
                    {
                        transactionLabel: 'Set sidebearing',
                        path: 'glyphs.a:layers.master-regular:',
                        visualAnchorSide: 'left',
                        oldValue: { width: 500 },
                        newValue: { width: 560 }
                    }
                ],
                {
                    requestCompile: jest.fn(async () => {}),
                    queueCacheRefresh: jest.fn(async () => {})
                }
            );

            expect(glyphCanvas.captureIdleViewLock).toHaveBeenCalledWith({
                kerningPair: false,
                bboxCenter: true,
                rightEdge: false
            });
            expect(glyphCanvas.reapplyIdleViewLock).toHaveBeenCalled();
            expect(glyphCanvas.render).not.toHaveBeenCalled();
        });

        test("remote outline packet on another glyph locks this window's active origin", async () => {
            const { glyphCanvas } = installReceiverHarness({
                activeGlyphName: 'a',
                activeDrawingId: 'master-regular',
                currentDrawingWidth: 560,
                initialPanX: 200,
                initialScale: 2
            });

            await handleRemoteChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag point',
                        path: 'glyphs.b:layers.master-regular:shapes.0.nodes.0.x',
                        oldValue: 10,
                        newValue: 20
                    }
                ],
                {
                    requestCompile: jest.fn(async () => {}),
                    queueCacheRefresh: jest.fn(async () => {})
                }
            );

            expect(glyphCanvas.captureIdleViewLock).toHaveBeenCalledWith({
                kerningPair: false,
                bboxCenter: false,
                rightEdge: false
            });
            expect(glyphCanvas.reapplyIdleViewLock).toHaveBeenCalled();
        });

        test("remote keyed LSB outline packet locks this window's advance right edge", async () => {
            const { glyphCanvas } = installReceiverHarness({
                activeGlyphName: 'm',
                activeDrawingId: 'master-regular',
                currentDrawingWidth: 560,
                initialPanX: 200,
                initialScale: 2
            });

            await handleRemoteChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag point',
                        path: 'glyphs.m:layers.master-regular:',
                        visualAnchorSide: 'left',
                        editSource: 'mouse-drag-outline',
                        compileChangeSource: 'mouse-drag-outline',
                        compileEditType: 'outline',
                        oldValue: { width: 500 },
                        newValue: { width: 560 }
                    }
                ],
                {
                    requestCompile: jest.fn(async () => {}),
                    queueCacheRefresh: jest.fn(async () => {})
                }
            );

            expect(glyphCanvas.captureIdleViewLock).toHaveBeenCalledWith({
                kerningPair: false,
                bboxCenter: false,
                rightEdge: true
            });
            expect(glyphCanvas.reapplyIdleViewLock).toHaveBeenCalled();
        });

        test('remote kerning-value packet in text mode requests the pair-glyph lock', async () => {
            const { glyphCanvas } = installReceiverHarness({
                activeGlyphName: 'a',
                activeDrawingId: 'master-regular',
                currentDrawingWidth: 500,
                initialPanX: 200,
                initialScale: 2,
                editMode: false
            });

            await handleRemoteChangeRefresh(
                [
                    {
                        transactionLabel: 'Edit kerning pair',
                        path: 'masters.0.kerning.A.V',
                        compileChangeSource: 'remote-kerning-value',
                        compileEditType: 'kerning-value',
                        oldValue: 0,
                        newValue: -40
                    }
                ],
                {
                    requestCompile: jest.fn(async () => {}),
                    queueCacheRefresh: jest.fn(async () => {})
                }
            );

            expect(glyphCanvas.captureIdleViewLock).toHaveBeenCalledWith({
                kerningPair: true,
                bboxCenter: false,
                rightEdge: false
            });
            expect(glyphCanvas.reapplyIdleViewLock).toHaveBeenCalled();
        });

        test("remote sidebearing packet on another glyph locks this window's edit-mode bbox", async () => {
            const { glyphCanvas } = installReceiverHarness({
                activeGlyphName: 'a',
                activeDrawingId: 'master-regular',
                currentDrawingWidth: 560,
                initialPanX: 200,
                initialScale: 2
            });

            await handleRemoteChangeRefresh(
                [
                    {
                        transactionLabel: 'Set sidebearing',
                        path: 'glyphs.b:layers.master-regular:',
                        visualAnchorSide: 'left',
                        oldValue: { width: 500 },
                        newValue: { width: 560 }
                    }
                ],
                {
                    requestCompile: jest.fn(async () => {}),
                    queueCacheRefresh: jest.fn(async () => {})
                }
            );

            expect(glyphCanvas.captureIdleViewLock).toHaveBeenCalledWith({
                kerningPair: false,
                bboxCenter: true,
                rightEdge: false
            });
            expect(glyphCanvas.reapplyIdleViewLock).toHaveBeenCalled();
        });

        test('local idle sidebearing commit uses the same viewer lock', async () => {
            const { glyphCanvas } = installReceiverHarness({
                activeGlyphName: 'a',
                activeDrawingId: 'master-regular',
                currentDrawingWidth: 560,
                initialPanX: 200,
                initialScale: 2
            });

            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Set sidebearing',
                        path: 'glyphs.a:layers.master-regular:',
                        visualAnchorSide: 'left',
                        oldValue: { width: 500 },
                        newValue: { width: 560 }
                    }
                ],
                'local',
                {
                    requestCompile: jest.fn(async () => {}),
                    awaitWorkerSync: jest.fn(async () => {})
                }
            );

            expect(glyphCanvas.captureIdleViewLock).toHaveBeenCalledWith({
                kerningPair: false,
                bboxCenter: true,
                rightEdge: false
            });
            expect(glyphCanvas.reapplyIdleViewLock).toHaveBeenCalled();
        });

        test('local component drag commit with keyed visualAnchorSide locks the right edge', async () => {
            const { glyphCanvas } = installReceiverHarness({
                activeGlyphName: 'adieresis',
                activeDrawingId: 'master-regular',
                currentDrawingWidth: 560,
                initialPanX: 200,
                initialScale: 2
            });

            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag component',
                        path: 'glyphs.adieresis:layers.master-regular:',
                        visualAnchorSide: 'left',
                        editSource: 'mouse-drag-outline',
                        compileChangeSource: 'mouse-drag-outline',
                        compileEditType: 'outline',
                        oldValue: { width: 500 },
                        newValue: { width: 560 }
                    }
                ],
                'local',
                {
                    requestCompile: jest.fn(async () => {}),
                    awaitWorkerSync: jest.fn(async () => {})
                }
            );

            expect(glyphCanvas.captureIdleViewLock).toHaveBeenCalledWith({
                kerningPair: false,
                bboxCenter: false,
                rightEdge: true
            });
            expect(glyphCanvas.reapplyIdleViewLock).toHaveBeenCalled();
        });

        test('a live drag on this window bypasses the idle viewer lock', async () => {
            const { glyphCanvas } = installReceiverHarness({
                activeGlyphName: 'a',
                activeDrawingId: 'master-regular',
                currentDrawingWidth: 560,
                initialPanX: 200,
                initialScale: 2,
                draggingSomething: true
            });

            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag point',
                        path: 'glyphs.a:layers.master-regular:shapes.0.nodes.0.x',
                        oldValue: 10,
                        newValue: 20
                    }
                ],
                'local',
                {
                    requestCompile: jest.fn(async () => {}),
                    awaitWorkerSync: jest.fn(async () => {})
                }
            );

            expect(glyphCanvas.captureIdleViewLock).toHaveBeenCalled();
            expect(glyphCanvas.reapplyIdleViewLock).not.toHaveBeenCalled();
        });
    });
});

describe('bridge Yjs worker callback', () => {
    const originalPatchSyncEngine = window.patchSyncEngine;
    const originalWindowSync = window.windowSync;
    const originalWindowRole = window.windowRole;
    const originalFontManager = window.fontManager;
    const originalAutoCompileManager = window.autoCompileManager;
    const originalSaveButton = window.saveButton;
    const originalGlyphCanvas = window.glyphCanvas;
    const originalInitialized = fontCompilation.isInitialized;

    function makeBridgeInitFont() {
        return {
            upm: 1000,
            version: [1, 0],
            note: '',
            date: '2024-01-01',
            names: { familyName: 'TestFont' },
            axes: [],
            masters: [
                { id: 'master-1', name: { dflt: 'Regular' }, location: {} }
            ],
            instances: [],
            glyphs: [
                {
                    name: 'A',
                    layers: [
                        {
                            id: 'layer-1',
                            width: 600,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            anchors: [],
                            shapes: []
                        }
                    ]
                }
            ],
            features: {
                classes: {},
                prefixes: {},
                features: []
            }
        };
    }

    function initializeBridgeHarness() {
        const bridgeReadyEvent = new CustomEvent('fontModelReady', {
            detail: {
                path: '/tmp/TestFont.glyphs',
                babelfontData: makeBridgeInitFont()
            }
        });

        window.dispatchEvent(bridgeReadyEvent);

        return window.patchSyncEngine;
    }

    afterEach(() => {
        window.patchSyncEngine?.destroy?.();
        window.windowSync?.destroy?.();
        window.patchSyncEngine = originalPatchSyncEngine;
        window.windowSync = originalWindowSync;
        window.windowRole = originalWindowRole;
        window.fontManager = originalFontManager;
        window.autoCompileManager = originalAutoCompileManager;
        window.saveButton = originalSaveButton;
        window.glyphCanvas = originalGlyphCanvas;
        fontCompilation.isInitialized = originalInitialized;
        jest.restoreAllMocks();
    });

    test('anchors the active layer for a synchronous Arrow key sidebearing undo packet', async () => {
        const drawing = { width: 600, isAutomaticAlignedDrawing: () => false };
        const anchor = { center: null };
        let canvasWidth = 600;

        fontCompilation.isInitialized = false;
        jest.spyOn(
            fontCompilation,
            'seedWorkerYDocFromState'
        ).mockResolvedValue();
        jest.spyOn(
            fontCompilation,
            'seedWorkerDocumentSet'
        ).mockResolvedValue();
        window.windowRole = {
            isLinkedWindow: () => false,
            getRoleLabel: () => 'main'
        };
        window.fontManager = {
            awaitWorkerCacheUpdate: jest.fn(async () => {}),
            currentFont: {
                requestRecompileWithoutDataChange: jest.fn(),
                fontModel: {
                    findGlyph: jest.fn(() => ({
                        findDrawingById: jest.fn(() => drawing)
                    })),
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            }
        };
        window.glyphCanvas = {
            viewportManager: { panX: 100, panY: 0, scale: 1 },
            getCurrentGlyphName: () => 'A',
            syncCurrentOutlineDrawingDataFromModel: jest.fn((modelDrawing) => {
                canvasWidth = modelDrawing.width;
            }),
            requestRepaintAfterCompile: jest.fn(),
            render: jest.fn(),
            captureIdleViewLock: jest.fn(() => {
                anchor.center =
                    window.glyphCanvas.viewportManager.panX + canvasWidth / 2;
                return true;
            }),
            reapplyIdleViewLock: jest.fn(() => {
                canvasWidth = drawing.width;
                window.glyphCanvas.viewportManager.panX =
                    anchor.center - canvasWidth / 2;
                return true;
            }),
            clearIdleViewLock: jest.fn(),
            outlineEditor: {
                active: true,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: () => [{ glyphName: 'A' }]
            }
        };

        const bridge = initializeBridgeHarness();
        bridge.undo = jest.fn(() => {
            drawing.width = 500;
            for (const callback of bridge._committedChangeListeners) {
                callback(
                    [
                        {
                            transactionLabel: 'Arrow key',
                            path: 'glyphs.A.layers.layer-1.width',
                            visualAnchorSide: 'left',
                            oldValue: 500,
                            newValue: 600
                        }
                    ],
                    { origin: 'local' }
                );
            }
            return { historyItem: { transactionLabel: 'Arrow key' } };
        });

        const centerBefore =
            window.glyphCanvas.viewportManager.panX + drawing.width / 2;
        await runBridgeUndoRedo('undo', 'A', 'A', 'layer-1');

        expect(
            window.glyphCanvas.viewportManager.panX + drawing.width / 2
        ).toBe(centerBefore);
        expect(window.glyphCanvas.captureIdleViewLock).toHaveBeenCalled();
        expect(window.glyphCanvas.reapplyIdleViewLock).toHaveBeenCalled();
        expect(window.glyphCanvas.render).not.toHaveBeenCalled();
    });

    test('dirty callback marks unsaved state without creating an ambient editing compile request', () => {
        const markDirty = jest.fn();
        const requestRecompileWithoutDataChange = jest.fn();
        const updateDirtyIndicator = jest.fn();
        const updateButtonState = jest.fn();

        fontCompilation.isInitialized = false;
        window.windowRole = {
            isLinkedWindow: () => false,
            getRoleLabel: () => 'main'
        };
        window.autoCompileManager = { checkAndSchedule: jest.fn() };
        window.saveButton = { updateButtonState };
        window.fontManager = {
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            clearEditingCompileContext: jest.fn(),
            pendingBabelfontJsonSyncAfterDrag: false,
            updateDirtyIndicator,
            currentFont: {
                changeVersion: 1,
                compileRequestVersion: 1,
                markDirty,
                requestRecompileWithoutDataChange,
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            }
        };

        const bridge = initializeBridgeHarness();
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            610
        );

        expect(markDirty).toHaveBeenCalledWith(undefined, {
            requestEditingCompile: false,
            keepPendingCompile: true
        });
        expect(requestRecompileWithoutDataChange).not.toHaveBeenCalled();
        expect(updateDirtyIndicator).toHaveBeenCalledTimes(1);
        expect(updateButtonState).toHaveBeenCalledTimes(1);
    });

    test('a bridge whose documents do not load is torn down and stops the open', () => {
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'seedWorkerDocumentSet')
            .mockResolvedValue();
        const showError = jest
            .spyOn(sidebarErrorDisplay, 'showError')
            .mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const loadFailure = new Error('the room’s documents do not load');
        jest.spyOn(ChangeBridge.prototype, 'initFromJson').mockImplementation(
            () => {
                throw loadFailure;
            }
        );
        window.windowRole = { isLinkedWindow: () => false };
        window.fontManager = {};
        window.__pendingSparseSession = true;
        window.__pendingSparseWorkingGlyphIds = ['A'];

        const detail = {
            path: '/tmp/TestFont.glyphs',
            babelfontData: makeBridgeInitFont()
        };
        window.dispatchEvent(new CustomEvent('fontModelReady', { detail }));

        expect(detail.bridgeError).toBe(loadFailure);
        // The failed open's inputs are not left for the next open.
        expect(window.__pendingSparseSession).toBeUndefined();
        expect(window.__pendingSparseWorkingGlyphIds).toBeUndefined();
        expect(window.patchSyncEngine).toBeUndefined();
        expect(window.windowSync).toBeUndefined();
        expect(workerSeedSpy).not.toHaveBeenCalled();
        expect(showError).toHaveBeenCalledWith(loadFailure, 'editing', {
            sticky: true
        });
    });

    test('a cloud room whose empty drawings have no shapes opens and seeds the worker', async () => {
        const Y = require('yjs');
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'seedWorkerDocumentSet')
            .mockResolvedValue();
        const showError = jest
            .spyOn(sidebarErrorDisplay, 'showError')
            .mockImplementation(() => {});
        fontCompilation.isInitialized = false;
        window.windowRole = { isLinkedWindow: () => false };
        window.fontManager = {};

        const font = makeBridgeInitFont();
        const writer = new ChangeBridge('legacy-room-writer');
        writer.initFromJson(font);
        const glyphId = writer._glyphIdByName.get('A');
        // The room was written before every drawing map was created with
        // its geometry and keyed maps: the empty drawing is its plain keys.
        const documents = writer.encodeDocumentSet().map((shard) => {
            if (shard.documentId !== `glyph:${glyphId}`) {
                return shard;
            }
            const doc = new Y.Doc({ gc: false });
            Y.applyUpdate(doc, shard.bytes);
            doc.transact(() => {
                const legacy = new Y.Map();
                legacy.set('width', 600);
                legacy.set('id', 'layer-1');
                const station = new Y.Map();
                station.set('type', 'DefaultForMaster');
                station.set('master', 'master-1');
                legacy.set('master', station);
                doc.getMap('glyph').get('layers').set('layer-1', legacy);
            });
            const bytes = Y.encodeStateAsUpdate(doc);
            doc.destroy();
            return { documentId: shard.documentId, bytes };
        });
        writer.destroy?.();
        window.__pendingCloudBridgeBootstrapDocuments = documents;

        const detail = {
            path: 'cloud://legacy-room',
            babelfontData: font
        };
        window.dispatchEvent(new CustomEvent('fontModelReady', { detail }));
        await Promise.resolve();

        expect(detail.bridgeError).toBeUndefined();
        expect(showError).not.toHaveBeenCalled();
        expect(window.windowSync).toBeDefined();
        expect(workerSeedSpy).toHaveBeenCalledTimes(1);
        const glyph = window.patchSyncEngine
            .getFontJsonSnapshot()
            .glyphs.find((entry) => entry.name === 'A');
        expect(glyph.layers[0].shapes).toEqual([]);
    });

    test('seeds the worker from the authoritative bridge Y.Doc', async () => {
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'seedWorkerDocumentSet')
            .mockResolvedValue();
        jest.spyOn(
            fontCompilation,
            'seedWorkerYDocFromState'
        ).mockResolvedValue();
        const trackWorkerDocumentSyncSpy = jest.spyOn(
            fontCompilation,
            'trackWorkerDocumentSync'
        );

        fontCompilation.isInitialized = false;
        window.windowRole = {
            isLinkedWindow: () => false
        };
        window.fontManager = {};

        const bridge = initializeBridgeHarness();
        await Promise.resolve();

        const [seedDocuments] = workerSeedSpy.mock.calls[0];
        expect(seedDocuments).toEqual(
            bridge.encodeDocumentSet().map((shard) => ({
                documentId: shard.documentId,
                bytes: shard.bytes
            }))
        );
        expect(trackWorkerDocumentSyncSpy).toHaveBeenCalledWith(
            expect.any(Promise)
        );
    });

    test('a remote revision stamp waits for the catch-up, and queued catch-ups compile once with their dependents', async () => {
        const requestRecompileWithoutDataChange = jest.fn(function () {
            this.compileRequestVersion += 1;
        });
        const glyphChanged = jest.fn();
        fontCompilation.isInitialized = false;
        jest.spyOn(
            fontCompilation,
            'seedWorkerDocumentSet'
        ).mockResolvedValue();
        jest.spyOn(
            fontCompilation,
            'seedWorkerYDocFromState'
        ).mockResolvedValue();
        window.windowRole = {
            isLinkedWindow: () => false,
            isMainWindow: () => true,
            getRoleLabel: () => 'main'
        };
        window.autoCompileManager = { checkAndSchedule: jest.fn() };
        window.fontManager = {
            clearEditingCompileContext: jest.fn(),
            currentFont: {
                changeVersion: 1,
                compileRequestVersion: 1,
                requestRecompileWithoutDataChange,
                markDirty: jest.fn(),
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(
                        (names) => new Set(names.has('A') ? ['Adieresis'] : [])
                    )
                }
            }
        };
        const bridge = initializeBridgeHarness();
        const emitRemote = (entries, documentId) => {
            for (const callback of bridge._committedChangeListeners) {
                callback(entries, {
                    origin: 'remote',
                    update: new Uint8Array(),
                    documentId
                });
            }
        };
        window.addEventListener('glyphChanged', glyphChanged);
        try {
            emitRemote(
                [{ op: 'set', path: 'glyphRevisions.id-a', newValue: 'r2' }],
                'font-core'
            );
            // The stamp enqueues nothing, so the shared queue may still hold
            // an earlier test’s refresh that failed on the absent worker.
            await getCommittedChangeRefreshPromise().catch(() => {});
            expect(requestRecompileWithoutDataChange).not.toHaveBeenCalled();
            expect(glyphChanged).not.toHaveBeenCalled();

            const catchUpEntry = (glyphName) => ({
                op: 'set',
                path: `glyphs.${glyphName}:layers.layer-1:shapes`,
                compileChangeSource: 'remote-catch-up',
                compileEditType: null,
                workerReplayTargets: [{ glyphName, layerId: 'layer-1' }]
            });
            emitRemote([catchUpEntry('A')], 'glyph:id-a');
            emitRemote([catchUpEntry('B')], 'glyph:id-b');
            await getCommittedChangeRefreshPromise();
        } finally {
            window.removeEventListener('glyphChanged', glyphChanged);
        }

        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledWith({
            compileContext: expect.objectContaining({
                changeSource: 'remote-catch-up',
                editType: null
            })
        });
        expect(glyphChanged).toHaveBeenCalledTimes(1);
        expect(glyphChanged.mock.calls[0][0].detail.glyphNames.sort()).toEqual([
            'A',
            'Adieresis',
            'B'
        ]);
    });

    test('forwards feature-code Yjs updates to Rust with empty glyph metadata', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });
        const hasWorkerCacheDocumentSpy = jest
            .spyOn(fullFontCompilation, 'hasSeededWorkerDocuments')
            .mockReturnValue(true);
        const fullWorkerUpdateSpy = jest
            .spyOn(fullFontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });

        fontCompilation.isInitialized = true;
        window.windowRole = {
            isLinkedWindow: () => false,
            getRoleLabel: () => 'main'
        };
        window.fontManager = {
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            forwardWorkerYjsUpdate
        };

        const bridge = initializeBridgeHarness();
        expect(typeof bridge._yjsWorkerCallback).toBe('function');

        workerSeedSpy.mockClear();
        fullWorkerUpdateSpy.mockClear();

        bridge._yjsWorkerCallback(new Uint8Array([9, 9]), [
            {
                path: 'features.features.0.1.code'
            }
        ]);
        // The full-compile mirror queues behind the worker's earlier
        // document syncs; let that chain settle.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            [],
            expect.objectContaining({
                invalidateLayoutClosure: true,
                nonGlyphChangeHints: ['feature-code']
            })
        );
        expect(hasWorkerCacheDocumentSpy).toHaveBeenCalled();
        expect(fullWorkerUpdateSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                changedGlyphs: [],
                nonGlyphChangeHints: ['feature-code'],
                invalidateLayoutClosure: true
            })
        );
    });

    test('forwards font-wide metadata Yjs updates to Rust before recompilation', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });

        fontCompilation.isInitialized = true;
        window.windowRole = {
            isLinkedWindow: () => false
        };
        window.fontManager = {
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            forwardWorkerYjsUpdate
        };

        const bridge = initializeBridgeHarness();
        workerSeedSpy.mockClear();

        bridge._yjsWorkerCallback(new Uint8Array([7, 7]), [
            {
                path: 'format_specific["com.example.vendor"].value'
            }
        ]);
        // The full-compile mirror queues behind the worker's earlier
        // document syncs; let that chain settle.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            [],
            expect.objectContaining({
                invalidateLayoutClosure: false,
                nonGlyphChangeHints: ['top-level:format_specific']
            })
        );
    });

    test('forwards remote font-wide metadata to Rust with its top-level hint', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });
        const senderFontJson = makeBridgeInitFont();
        const senderBridge = new ChangeBridge('remote-font-wide-metadata');
        let remoteUpdate = null;
        let remoteEntries = null;

        fontCompilation.isInitialized = true;
        window.windowRole = {
            isLinkedWindow: () => false,
            getRoleLabel: () => 'main'
        };
        window.fontManager = {
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            forwardWorkerYjsUpdate
        };

        senderBridge.initFromJson(senderFontJson);
        const receiverBridge = initializeBridgeHarness();
        receiverBridge.applyFullState(senderBridge.getFullState());
        workerSeedSpy.mockClear();
        senderBridge.onLocalUpdate((update, _message, entries) => {
            remoteUpdate = update;
            remoteEntries = entries;
        });

        senderBridge.applySyntheticChangeSet(
            'Set vendor metadata',
            [
                {
                    op: 'set',
                    path: ['format_specific', 'com.example.vendor'],
                    oldValue: null,
                    newValue: { enabled: true }
                }
            ],
            { compileChangeSource: 'test-sync', compileEditType: null }
        );

        receiverBridge.applyRemoteUpdate(remoteUpdate, remoteEntries);
        // The full-compile mirror queues behind the worker's earlier
        // document syncs; let that chain settle.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            remoteUpdate,
            [],
            expect.objectContaining({
                invalidateLayoutClosure: false,
                nonGlyphChangeHints: ['top-level:format_specific']
            })
        );

        senderBridge.destroy();
    });

    test('worker callback forwards Yjs updates without cache metadata', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });
        const hasWorkerCacheDocumentSpy = jest
            .spyOn(fullFontCompilation, 'hasSeededWorkerDocuments')
            .mockReturnValue(true);
        const fullWorkerUpdateSpy = jest
            .spyOn(fullFontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });

        fontCompilation.isInitialized = true;
        window.windowRole = {
            isLinkedWindow: () => false
        };
        window.fontManager = {
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            forwardWorkerYjsUpdate
        };

        const bridge = initializeBridgeHarness();
        workerSeedSpy.mockClear();
        fullWorkerUpdateSpy.mockClear();

        bridge._yjsWorkerCallback(new Uint8Array([4, 2]), []);
        // The full-compile mirror queues behind the worker's earlier
        // document syncs; let that chain settle.
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Nothing is held back: the worker's document history must stay
        // complete, so even a packet without cache hints is forwarded.
        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            new Uint8Array([4, 2]),
            [],
            expect.objectContaining({ nonGlyphChangeHints: [] })
        );
        expect(fullWorkerUpdateSpy).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'applyYjsUpdate' })
        );
    });

    test('marks a revision stamp cache-neutral so the worker applies it without a gap', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });
        const hasWorkerCacheDocumentSpy = jest
            .spyOn(fullFontCompilation, 'hasSeededWorkerDocuments')
            .mockReturnValue(true);
        const fullWorkerUpdateSpy = jest
            .spyOn(fullFontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });

        fontCompilation.isInitialized = true;
        window.windowRole = {
            isLinkedWindow: () => false
        };
        window.fontManager = {
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            forwardWorkerYjsUpdate
        };

        const bridge = initializeBridgeHarness();
        workerSeedSpy.mockClear();
        fullWorkerUpdateSpy.mockClear();

        bridge._yjsWorkerCallback(new Uint8Array([4, 2]), [
            { op: 'set', path: 'glyphRevisions.id-a', newValue: 'r2' }
        ]);
        // The full-compile mirror queues behind the worker's earlier
        // document syncs; let that chain settle.
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Nothing is held back: the worker's document history must stay
        // complete, so even a packet without cache hints is forwarded.
        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            new Uint8Array([4, 2]),
            [],
            expect.objectContaining({ nonGlyphChangeHints: ['cache-neutral'] })
        );
        expect(fullWorkerUpdateSpy).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'applyYjsUpdate' })
        );
    });

    test('forwards kerning-pair Yjs updates with non-glyph kerning hints', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });
        const hasWorkerCacheDocumentSpy = jest
            .spyOn(fullFontCompilation, 'hasSeededWorkerDocuments')
            .mockReturnValue(true);
        const fullWorkerUpdateSpy = jest
            .spyOn(fullFontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });

        fontCompilation.isInitialized = true;
        window.windowRole = {
            isLinkedWindow: () => false
        };
        window.fontManager = {
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            forwardWorkerYjsUpdate
        };

        const bridge = initializeBridgeHarness();
        workerSeedSpy.mockClear();
        fullWorkerUpdateSpy.mockClear();

        bridge._yjsWorkerCallback(new Uint8Array([4, 4]), [
            {
                path: 'masters.0.kerning.A.V',
                transactionLabel: 'Edit kerning pair'
            }
        ]);
        // The full-compile mirror queues behind the worker's earlier
        // document syncs; let that chain settle.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            [],
            expect.objectContaining({
                invalidateLayoutClosure: false,
                nonGlyphChangeHints: ['kerning-value']
            })
        );
        expect(hasWorkerCacheDocumentSpy).toHaveBeenCalled();
        expect(fullWorkerUpdateSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                changedGlyphs: [],
                nonGlyphChangeHints: ['kerning-value'],
                invalidateLayoutClosure: false
            })
        );

        forwardWorkerYjsUpdate.mockClear();
        bridge._yjsWorkerCallback(new Uint8Array([4, 7]), [
            {
                path: 'format_specific.com.schriftgestalt.Glyphs.kerningRTL.master-regular.@MMK_R_A.@MMK_L_V'
            }
        ]);
        // The full-compile mirror queues behind the worker's earlier
        // document syncs; let that chain settle.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            [],
            expect.objectContaining({
                invalidateLayoutClosure: false,
                nonGlyphChangeHints: ['kerning-value']
            })
        );
    });

    test('forwards canonical RTL kerning Yjs updates with non-glyph kerning hints', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });
        const hasWorkerCacheDocumentSpy = jest
            .spyOn(fullFontCompilation, 'hasSeededWorkerDocuments')
            .mockReturnValue(true);
        const fullWorkerUpdateSpy = jest
            .spyOn(fullFontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });

        fontCompilation.isInitialized = true;
        window.windowRole = {
            isLinkedWindow: () => false
        };
        window.fontManager = {
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            forwardWorkerYjsUpdate
        };

        const bridge = initializeBridgeHarness();
        workerSeedSpy.mockClear();
        fullWorkerUpdateSpy.mockClear();

        bridge._yjsWorkerCallback(new Uint8Array([4, 6]), [
            {
                path: 'format_specific',
                transactionLabel: 'Edit kerning pair'
            },
            {
                path: 'masters.0.kerning_rtl.@AFirst:@VSecond',
                transactionLabel: 'Edit kerning pair'
            }
        ]);
        // The full-compile mirror queues behind the worker's earlier
        // document syncs; let that chain settle.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            [],
            expect.objectContaining({
                invalidateLayoutClosure: false,
                nonGlyphChangeHints: [
                    'top-level:format_specific',
                    'kerning-value'
                ]
            })
        );
        expect(hasWorkerCacheDocumentSpy).toHaveBeenCalled();
        expect(fullWorkerUpdateSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                changedGlyphs: [],
                nonGlyphChangeHints: [
                    'top-level:format_specific',
                    'kerning-value'
                ],
                invalidateLayoutClosure: false
            })
        );
    });

    test('forwards kern-group Yjs updates with non-glyph kerning hints', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });

        fontCompilation.isInitialized = true;
        window.windowRole = {
            isLinkedWindow: () => false
        };
        window.fontManager = {
            buildWorkerYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            forwardWorkerYjsUpdate
        };

        const bridge = initializeBridgeHarness();
        workerSeedSpy.mockClear();

        bridge._yjsWorkerCallback(new Uint8Array([5, 5]), [
            {
                path: 'first_kern_groups.A.0',
                transactionLabel: 'Add kern group membership'
            }
        ]);
        // The full-compile mirror queues behind the worker's earlier
        // document syncs; let that chain settle.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            [],
            expect.objectContaining({
                invalidateLayoutClosure: false,
                nonGlyphChangeHints: ['kerning-groups']
            })
        );
    });

    test('forwards layer-scoped Yjs updates with derived layer targets', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });

        fontCompilation.isInitialized = true;
        window.windowRole = {
            isLinkedWindow: () => false
        };
        window.fontManager = {
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            forwardWorkerYjsUpdate
        };

        const bridge = initializeBridgeHarness();
        workerSeedSpy.mockClear();

        bridge._yjsWorkerCallback(new Uint8Array([7, 7]), [
            {
                path: 'glyphs.alef:layers.A.0:anchors.0.x',
                workerReplayTargets: [
                    { glyphName: 'beh', layerId: 'A.0' },
                    { glyphName: 'alef', layerId: 'A.0' }
                ]
            }
        ]);
        // The full-compile mirror queues behind the worker's earlier
        // document syncs; let that chain settle.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            ['alef'],
            expect.objectContaining({
                invalidateLayoutClosure: false,
                layerTargets: [{ glyphName: 'alef', layerId: 'A.0' }]
            })
        );
    });

    test('forwards glyph-removal Yjs updates without layer targets', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });

        fontCompilation.isInitialized = true;
        window.windowRole = {
            isLinkedWindow: () => false
        };
        window.fontManager = {
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            forwardWorkerYjsUpdate
        };

        const bridge = initializeBridgeHarness();
        workerSeedSpy.mockClear();

        bridge._yjsWorkerCallback(new Uint8Array([5, 5]), [
            {
                path: 'glyphs.alef'
            }
        ]);
        // The full-compile mirror queues behind the worker's earlier
        // document syncs; let that chain settle.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            ['alef'],
            expect.objectContaining({
                invalidateLayoutClosure: true
            })
        );
    });

    test('source-only outline edit forwards without invalidating layout closure', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });
        const hasWorkerCacheDocumentSpy = jest
            .spyOn(fullFontCompilation, 'hasSeededWorkerDocuments')
            .mockReturnValue(true);
        const fullWorkerUpdateSpy = jest
            .spyOn(fullFontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });

        fontCompilation.isInitialized = true;
        window.windowRole = {
            isLinkedWindow: () => false
        };
        window.fontManager = {
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            forwardWorkerYjsUpdate
        };

        const bridge = initializeBridgeHarness();
        workerSeedSpy.mockClear();
        fullWorkerUpdateSpy.mockClear();

        // Outline edit — layer-scoped node change
        bridge._yjsWorkerCallback(new Uint8Array([7, 7]), [
            {
                path: 'glyphs.A.layers.layer-1.shapes.0.nodes.0.x',
                compileChangeSource: 'mouse-drag-outline',
                compileEditType: 'outline',
                workerReplayTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            }
        ]);
        // The full-compile mirror queues behind the worker's earlier
        // document syncs; let that chain settle.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            ['A'],
            expect.objectContaining({
                invalidateLayoutClosure: false,
                layerTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            })
        );
        expect(hasWorkerCacheDocumentSpy).toHaveBeenCalled();
        expect(fullWorkerUpdateSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                changedGlyphs: ['A'],
                layerTargets: [{ glyphName: 'A', layerId: 'layer-1' }],
                invalidateLayoutClosure: false
            })
        );
    });

    test('outline edit keeps replay-only dependents out of worker layer patches', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });
        const hasWorkerCacheDocumentSpy = jest
            .spyOn(fullFontCompilation, 'hasSeededWorkerDocuments')
            .mockReturnValue(true);
        const fullWorkerUpdateSpy = jest
            .spyOn(fullFontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });

        fontCompilation.isInitialized = true;
        window.windowRole = {
            isLinkedWindow: () => false
        };
        window.fontManager = {
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            forwardWorkerYjsUpdate
        };

        const bridge = initializeBridgeHarness();
        workerSeedSpy.mockClear();
        fullWorkerUpdateSpy.mockClear();

        bridge._yjsWorkerCallback(new Uint8Array([7, 9]), [
            {
                path: 'glyphs.a.layers.layer-1.shapes.0.nodes',
                compileChangeSource: 'mouse-drag-outline',
                compileEditType: 'outline',
                workerReplayTargets: [
                    { glyphName: 'a', layerId: 'layer-1' },
                    { glyphName: 'adieresis', layerId: 'layer-1' }
                ]
            }
        ]);
        // The full-compile mirror queues behind the worker's earlier
        // document syncs; let that chain settle.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            ['a'],
            expect.objectContaining({
                invalidateLayoutClosure: false,
                layerTargets: [{ glyphName: 'a', layerId: 'layer-1' }]
            })
        );
        expect(hasWorkerCacheDocumentSpy).toHaveBeenCalled();
        expect(fullWorkerUpdateSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                changedGlyphs: ['a'],
                layerTargets: [{ glyphName: 'a', layerId: 'layer-1' }],
                invalidateLayoutClosure: false
            })
        );
    });

    test('anchor edit forwards with invalidateLayoutClosure false and non-empty changedGlyphs', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });

        fontCompilation.isInitialized = true;
        window.windowRole = {
            isLinkedWindow: () => false
        };
        window.fontManager = {
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            forwardWorkerYjsUpdate
        };

        const bridge = initializeBridgeHarness();
        workerSeedSpy.mockClear();

        // Anchor edit — layer-scoped anchor change
        bridge._yjsWorkerCallback(new Uint8Array([8, 8]), [
            {
                path: 'glyphs.A.layers.layer-1.anchors.0.x',
                workerReplayTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            }
        ]);
        // The full-compile mirror queues behind the worker's earlier
        // document syncs; let that chain settle.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            ['A'],
            expect.objectContaining({
                invalidateLayoutClosure: false,
                layerTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            })
        );
    });

    test('sidebearing edit forwards with invalidateLayoutClosure false and non-empty changedGlyphs', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });

        fontCompilation.isInitialized = true;
        window.windowRole = {
            isLinkedWindow: () => false
        };
        window.fontManager = {
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            forwardWorkerYjsUpdate
        };

        const bridge = initializeBridgeHarness();
        workerSeedSpy.mockClear();

        // Sidebearing edit — layer-scoped width change
        bridge._yjsWorkerCallback(new Uint8Array([6, 6]), [
            {
                path: 'glyphs.A.layers.layer-1.width',
                visualAnchorSide: 'right',
                workerReplayTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            }
        ]);
        // The full-compile mirror queues behind the worker's earlier
        // document syncs; let that chain settle.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            ['A'],
            expect.objectContaining({
                invalidateLayoutClosure: false,
                layerTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            })
        );
    });
});

describe('buildCascadingRecompositionOperations', () => {
    const originalFontManager = window.fontManager;
    const originalCurrentFontModel = window.currentFontModel;

    afterEach(() => {
        window.fontManager = originalFontManager;
        window.currentFontModel = originalCurrentFontModel;
    });

    function makeBridgeFont() {
        return {
            masters: [
                { id: 'master-1', name: { dflt: 'Regular' }, location: {} }
            ],
            glyphs: [
                {
                    name: 'A',
                    layers: [
                        {
                            id: 'layer-1',
                            width: 600,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            anchors: [{ name: 'top', x: 100, y: 700 }],
                            shapes: []
                        }
                    ]
                },
                {
                    name: 'B',
                    layers: [
                        {
                            id: 'layer-2',
                            width: 650,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            anchors: [],
                            shapes: []
                        }
                    ]
                }
            ]
        };
    }

    test('creates derived layer operations for width-triggered cascade changes', () => {
        const fontJson = makeBridgeFont();
        const bridge = new ChangeBridge('cascade-test');
        bridge.initFromJson(fontJson);

        fontJson.glyphs[0].layers[0].width = 700;

        const sourceDrawing = {
            id: 'layer-1',
            getMatchingDrawingOnGlyph: jest.fn((glyphName) =>
                glyphName === 'B' ? { id: 'layer-2' } : null
            )
        };
        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn((glyphName) => {
                        if (glyphName === 'A') {
                            return {
                                findDrawingById: jest.fn((drawingId) =>
                                    drawingId === 'layer-1'
                                        ? sourceDrawing
                                        : null
                                )
                            };
                        }

                        if (glyphName === 'B') {
                            return {
                                findDrawingById: jest.fn((drawingId) =>
                                    drawingId === 'layer-2'
                                        ? { id: 'layer-2' }
                                        : null
                                )
                            };
                        }

                        return null;
                    }),
                    rebuildAutomaticCompositesForGlyphs: jest.fn(() => {
                        fontJson.glyphs[1].layers[0].width = 710;
                        return new Set(['B']);
                    }),
                    recomputeMetricsKeys: jest.fn(() => new Set())
                }
            }
        };

        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
                oldValue: 600,
                newValue: 700
            }
        ]);

        expect(operations).toEqual([
            expect.objectContaining({
                op: 'set',
                path: ['glyphs', 'B', 'layers', 'layer-2'],
                oldValue: expect.objectContaining({ width: 650 }),
                newValue: expect.objectContaining({
                    id: 'layer-2',
                    width: 710
                }),
                applyMode: 'drawing-snapshot',
                workerReplayTargets: [
                    {
                        glyphName: 'B',
                        layerId: 'layer-2'
                    }
                ]
            })
        ]);
    });

    test('a point move re-derived by metrics keys keeps the layer’s stored point positions', () => {
        const fontJson = makeBridgeFont();
        fontJson.glyphs[0].layers[0].shapes = [
            {
                closed: true,
                nodes: [
                    { x: 100, y: 0, nodetype: 'Line' },
                    { x: 200, y: 0, nodetype: 'Line' },
                    { x: 200, y: 500, nodetype: 'Line' }
                ]
            }
        ];
        const bridge = new ChangeBridge('cascade-test');
        bridge.initFromJson(fontJson);
        const yDrawing = bridge
            .getYValue(['glyphs', 'A'])
            .get('layers')
            .get('layer-1');
        const nodeId = fromYType(yDrawing).shapes[0].nodes[0].id;
        expect(nodeId).toBeTruthy();

        // The model after the edit: the point moved and its metrics key
        // re-derived the width of the same layer.
        const modelNode = fontJson.glyphs[0].layers[0].shapes[0].nodes[0];
        modelNode.id = nodeId;
        modelNode.x = 123;
        fontJson.glyphs[0].layers[0].width = 623;
        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn(() => ({
                        findDrawingById: jest.fn(() => ({
                            id: 'layer-1',
                            getMatchingDrawingOnGlyph: jest.fn(() => null)
                        }))
                    })),
                    rebuildAutomaticCompositesForGlyphs: jest.fn(
                        () => new Set()
                    ),
                    recomputeMetricsKeys: jest.fn(() => new Set(['A']))
                }
            }
        };

        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'set',
                path: [
                    'glyphs',
                    'A',
                    'layers',
                    'layer-1',
                    'nodePositionsById',
                    nodeId
                ],
                oldValue: '100 0',
                newValue: '123 0'
            },
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
                oldValue: 600,
                newValue: 623
            }
        ]);

        for (const operation of operations) {
            expect(Object.keys(operation.newValue)).not.toEqual(
                expect.arrayContaining(['nodePositionsById'])
            );
            expect(operation.newValue.shapes).toBeUndefined();
        }
    });

    test('emits null tombstones when cascade recomposition removes layer fields', () => {
        const fontJson = makeBridgeFont();
        fontJson.glyphs[1].layers[0].format_specific = { legacy: true };
        const bridge = new ChangeBridge('cascade-test');
        bridge.initFromJson(fontJson);

        fontJson.glyphs[0].layers[0].width = 700;

        const sourceDrawing = {
            id: 'layer-1',
            getMatchingDrawingOnGlyph: jest.fn((glyphName) =>
                glyphName === 'B' ? { id: 'layer-2' } : null
            )
        };
        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn((glyphName) => {
                        if (glyphName === 'A') {
                            return {
                                findDrawingById: jest.fn((drawingId) =>
                                    drawingId === 'layer-1'
                                        ? sourceDrawing
                                        : null
                                )
                            };
                        }

                        if (glyphName === 'B') {
                            return {
                                findDrawingById: jest.fn((drawingId) =>
                                    drawingId === 'layer-2'
                                        ? { id: 'layer-2' }
                                        : null
                                )
                            };
                        }

                        return null;
                    }),
                    rebuildAutomaticCompositesForGlyphs: jest.fn(() => {
                        delete fontJson.glyphs[1].layers[0].format_specific;
                        return new Set(['B']);
                    }),
                    recomputeMetricsKeys: jest.fn(() => new Set())
                }
            }
        };

        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
                oldValue: 600,
                newValue: 700
            }
        ]);

        expect(operations[0].newValue).toEqual(
            expect.objectContaining({
                id: 'layer-2',
                format_specific: null
            })
        );
        expect(operations[0].oldValue).toEqual(
            expect.objectContaining({
                format_specific: { legacy: true }
            })
        );
    });

    test('captures additional source-layer recomposition beyond the direct edit', () => {
        const fontJson = makeBridgeFont();
        const bridge = new ChangeBridge('cascade-test');
        bridge.initFromJson(fontJson);

        fontJson.glyphs[0].layers[0].width = 700;

        const sourceDrawing = {
            id: 'layer-1',
            getMatchingDrawingOnGlyph: jest.fn(() => null)
        };
        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn((glyphName) => {
                        if (glyphName === 'A') {
                            return {
                                findDrawingById: jest.fn((drawingId) =>
                                    drawingId === 'layer-1'
                                        ? sourceDrawing
                                        : null
                                )
                            };
                        }

                        return null;
                    }),
                    rebuildAutomaticCompositesForGlyphs: jest.fn(
                        () => new Set()
                    ),
                    recomputeMetricsKeys: jest.fn(() => {
                        fontJson.glyphs[0].layers[0].anchors = [];
                        return new Set(['A']);
                    })
                }
            }
        };

        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
                oldValue: 600,
                newValue: 700
            }
        ]);

        expect(operations).toEqual([
            expect.objectContaining({
                path: ['glyphs', 'A', 'layers', 'layer-1'],
                oldValue: expect.objectContaining({
                    width: 700,
                    anchors: [
                        expect.objectContaining({ name: 'top', x: 100, y: 700 })
                    ]
                }),
                newValue: expect.objectContaining({
                    id: 'layer-1',
                    anchors: []
                })
            })
        ]);
    });

    test('uses array semantics for direct anchor removals when computing source-layer cascade deltas', () => {
        const fontJson = makeBridgeFont();
        fontJson.glyphs[0].layers[0].anchors.push({
            name: 'bottom',
            x: 100,
            y: 0
        });
        const bridge = new ChangeBridge('cascade-test');
        bridge.initFromJson(fontJson);

        fontJson.glyphs[0].layers[0].anchors = [];

        const sourceDrawing = {
            id: 'layer-1',
            getMatchingDrawingOnGlyph: jest.fn(() => null)
        };
        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn((glyphName) => {
                        if (glyphName === 'A') {
                            return {
                                findDrawingById: jest.fn((drawingId) =>
                                    drawingId === 'layer-1'
                                        ? sourceDrawing
                                        : null
                                )
                            };
                        }

                        return null;
                    }),
                    rebuildAutomaticCompositesForGlyphs: jest.fn(
                        () => new Set()
                    ),
                    recomputeMetricsKeys: jest.fn(() => new Set(['A']))
                }
            }
        };

        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'remove',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'anchors', 0],
                oldValue: { name: 'top', x: 100, y: 700 },
                newValue: undefined
            }
        ]);

        expect(operations).toEqual([
            expect.objectContaining({
                path: ['glyphs', 'A', 'layers', 'layer-1'],
                oldValue: expect.objectContaining({
                    anchors: [
                        expect.objectContaining({
                            name: 'bottom',
                            x: 100,
                            y: 0
                        })
                    ]
                }),
                newValue: expect.objectContaining({
                    id: 'layer-1',
                    anchors: []
                })
            })
        ]);
    });

    test('does not replace source anchors when a stable-id leaf edit already matches stored JSON', () => {
        const fontJson = makeBridgeFont();
        const bridge = new ChangeBridge('cascade-test');
        bridge.initFromJson(fontJson);

        const storedAnchor = fontJson.glyphs[0].layers[0].anchors[0];
        const anchorId = storedAnchor.id;
        expect(typeof anchorId).toBe('string');
        storedAnchor.y = 719;

        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn(() => null),
                    rebuildAutomaticCompositesForGlyphs: jest.fn(
                        () => new Set()
                    ),
                    recomputeMetricsKeys: jest.fn(() => new Set())
                }
            }
        };

        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'set',
                path: [
                    'glyphs',
                    'A',
                    'layers',
                    'layer-1',
                    'anchors',
                    anchorId,
                    'y'
                ],
                oldValue: 700,
                newValue: 719
            }
        ]);

        expect(
            operations.filter(
                (operation) =>
                    Array.isArray(operation.path) &&
                    operation.path[1] === 'A' &&
                    Object.prototype.hasOwnProperty.call(
                        operation.newValue || {},
                        'anchors'
                    )
            )
        ).toEqual([]);
        const sourceDrawingOp = operations.find(
            (operation) =>
                Array.isArray(operation.path) && operation.path[1] === 'A'
        );
        if (sourceDrawingOp) {
            expect(sourceDrawingOp.oldValue.anchors).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ name: 'top', y: 719 })
                ])
            );
        }
    });

    test('stable-id source-layer anchor removal still records an explicit empty-array clear', () => {
        const fontJson = makeBridgeFont();
        fontJson.glyphs[0].layers[0].anchors.push({
            name: 'bottom',
            x: 100,
            y: 0
        });
        const bridge = new ChangeBridge('cascade-test');
        bridge.initFromJson(fontJson);
        const topId = fontJson.glyphs[0].layers[0].anchors[0].id;
        expect(typeof topId).toBe('string');
        fontJson.glyphs[0].layers[0].anchors = [];

        const sourceDrawing = {
            id: 'layer-1',
            getMatchingDrawingOnGlyph: jest.fn(() => null)
        };
        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn((glyphName) => {
                        if (glyphName === 'A') {
                            return {
                                findDrawingById: jest.fn((drawingId) =>
                                    drawingId === 'layer-1'
                                        ? sourceDrawing
                                        : null
                                )
                            };
                        }
                        return null;
                    }),
                    rebuildAutomaticCompositesForGlyphs: jest.fn(
                        () => new Set()
                    ),
                    recomputeMetricsKeys: jest.fn(() => new Set(['A']))
                }
            }
        };

        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'remove',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'anchors', topId],
                oldValue: { id: topId, name: 'top', x: 100, y: 700 },
                newValue: undefined
            }
        ]);

        expect(operations).toEqual([
            expect.objectContaining({
                path: ['glyphs', 'A', 'layers', 'layer-1'],
                oldValue: expect.objectContaining({
                    anchors: [
                        expect.objectContaining({
                            name: 'bottom',
                            x: 100,
                            y: 0
                        })
                    ]
                }),
                newValue: expect.objectContaining({
                    id: 'layer-1',
                    anchors: []
                })
            })
        ]);
    });

    test('ignores node-only edits that do not touch width or anchors', () => {
        const fontJson = makeBridgeFont();
        const bridge = new ChangeBridge('cascade-test');
        bridge.initFromJson(fontJson);

        window.fontManager = {
            currentFont: {
                fontModel: {
                    rebuildAutomaticCompositesForGlyphs: jest.fn(),
                    recomputeMetricsKeys: jest.fn()
                }
            }
        };

        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'set',
                path: [
                    'glyphs',
                    'A',
                    'layers',
                    'layer-1',
                    'shapes',
                    0,
                    'nodes'
                ],
                oldValue: [{ x: 0, y: 0 }],
                newValue: [{ x: 10, y: 0 }]
            }
        ]);

        expect(operations).toEqual([]);
        expect(
            window.fontManager.currentFont.fontModel
                .rebuildAutomaticCompositesForGlyphs
        ).not.toHaveBeenCalled();
        expect(
            window.fontManager.currentFont.fontModel.recomputeMetricsKeys
        ).not.toHaveBeenCalled();
    });

    test('skips recomposition when GUI operations write a claimed downstream layer', () => {
        const fontJson = makeBridgeFont();
        const bridge = new ChangeBridge('cascade-test');
        bridge.initFromJson(fontJson);

        window.fontManager = {
            currentFont: {
                fontModel: {
                    rebuildAutomaticCompositesForGlyphs: jest.fn(),
                    recomputeMetricsKeys: jest.fn()
                }
            }
        };

        // Granular source and downstream writes with explicit replay targets
        // are complete producer output and should bypass recomposition.
        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'anchors', 0, 'x'],
                oldValue: 100,
                newValue: 125,
                workerReplayTargets: [
                    { glyphName: 'A', layerId: 'layer-1' },
                    { glyphName: 'B', layerId: 'layer-2' }
                ]
            },
            {
                op: 'set',
                path: [
                    'glyphs',
                    'B',
                    'layers',
                    'layer-2',
                    'shapes',
                    0,
                    'transform',
                    'translation',
                    0
                ],
                oldValue: 0,
                newValue: 25,
                workerReplayTargets: [
                    { glyphName: 'A', layerId: 'layer-1' },
                    { glyphName: 'B', layerId: 'layer-2' }
                ]
            }
        ]);

        expect(operations).toEqual([]);
        expect(
            window.fontManager.currentFont.fontModel
                .rebuildAutomaticCompositesForGlyphs
        ).not.toHaveBeenCalled();
        expect(
            window.fontManager.currentFont.fontModel.recomputeMetricsKeys
        ).not.toHaveBeenCalled();
    });

    test('falls back to recomposition when replay targets have only a source-layer write', () => {
        const fontJson = makeBridgeFont();
        const bridge = new ChangeBridge('cascade-test');
        bridge.initFromJson(fontJson);

        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn(() => null),
                    rebuildAutomaticCompositesForGlyphs: jest.fn(
                        () => new Set()
                    ),
                    recomputeMetricsKeys: jest.fn(() => new Set())
                }
            }
        };

        buildCascadingRecompositionOperations(bridge, [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1'],
                oldValue: { id: 'layer-1', width: 600 },
                newValue: { id: 'layer-1', width: 700 },
                applyPath: ['glyphs', 'A', 'layers', 'layer-1'],
                applyMode: 'drawing-snapshot',
                applyNewValue: { id: 'layer-1', width: 700 },
                workerReplayTargets: [
                    { glyphName: 'A', layerId: 'layer-1' },
                    { glyphName: 'B', layerId: 'layer-2' }
                ]
            }
        ]);

        expect(
            window.fontManager.currentFont.fontModel
                .rebuildAutomaticCompositesForGlyphs
        ).toHaveBeenCalled();
    });

    test('falls back to recomposition when width path lacks explicit replay targets', () => {
        const fontJson = makeBridgeFont();
        const bridge = new ChangeBridge('cascade-test');
        bridge.initFromJson(fontJson);

        fontJson.glyphs[0].layers[0].width = 700;

        const sourceDrawing = {
            id: 'layer-1',
            getMatchingDrawingOnGlyph: jest.fn((glyphName) =>
                glyphName === 'B' ? { id: 'layer-2' } : null
            )
        };
        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn((glyphName) => {
                        if (glyphName === 'A') {
                            return {
                                findDrawingById: jest.fn((drawingId) =>
                                    drawingId === 'layer-1'
                                        ? sourceDrawing
                                        : null
                                )
                            };
                        }

                        if (glyphName === 'B') {
                            return {
                                findDrawingById: jest.fn((drawingId) =>
                                    drawingId === 'layer-2'
                                        ? { id: 'layer-2' }
                                        : null
                                )
                            };
                        }

                        return null;
                    }),
                    rebuildAutomaticCompositesForGlyphs: jest.fn(() => {
                        fontJson.glyphs[1].layers[0].width = 710;
                        return new Set(['B']);
                    }),
                    recomputeMetricsKeys: jest.fn(() => new Set())
                }
            }
        };

        // A width path without explicit workerReplayTargets should still
        // trigger recomposition (fallback for non-GUI or incomplete packets).
        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
                oldValue: 600,
                newValue: 700
            }
        ]);

        expect(operations.length).toBeGreaterThan(0);
        expect(
            window.fontManager.currentFont.fontModel
                .rebuildAutomaticCompositesForGlyphs
        ).toHaveBeenCalled();
        expect(
            window.fontManager.currentFont.fontModel.recomputeMetricsKeys
        ).toHaveBeenCalled();
    });

    test('falls back to recomposition when anchor path lacks explicit replay targets', () => {
        const fontJson = makeBridgeFont();
        const bridge = new ChangeBridge('cascade-test');
        bridge.initFromJson(fontJson);

        fontJson.glyphs[0].layers[0].anchors = [];

        const sourceDrawing = {
            id: 'layer-1',
            getMatchingDrawingOnGlyph: jest.fn(() => null)
        };
        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn((glyphName) => {
                        if (glyphName === 'A') {
                            return {
                                findDrawingById: jest.fn((drawingId) =>
                                    drawingId === 'layer-1'
                                        ? sourceDrawing
                                        : null
                                )
                            };
                        }

                        return null;
                    }),
                    rebuildAutomaticCompositesForGlyphs: jest.fn(
                        () => new Set()
                    ),
                    recomputeMetricsKeys: jest.fn(() => new Set(['A']))
                }
            }
        };

        // An anchor removal path without explicit workerReplayTargets
        // should still trigger recomposition (rebuildAutomaticComposites
        // proves the fallback path was taken). Anchor-only edits must not
        // run metrics-key inheritance.
        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'remove',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'anchors', 0],
                oldValue: { name: 'top', x: 100, y: 700 },
                newValue: undefined
            }
        ]);

        expect(
            window.fontManager.currentFont.fontModel
                .rebuildAutomaticCompositesForGlyphs
        ).toHaveBeenCalled();
        expect(
            window.fontManager.currentFont.fontModel.recomputeMetricsKeys
        ).not.toHaveBeenCalled();
        // No cascade layer targets because getMatchingDrawingOnGlyph returns
        // null, so no layer operations are emitted.
        expect(operations).toEqual([]);
    });
});

describe('committed Yjs emission funnel', () => {
    test('uses one committed listener with the forward semantic entry for forward edits, undo, and redo', () => {
        const bridge = new ChangeBridge('committed-emission-funnel');
        bridge.initFromJson({
            masters: [
                { id: 'master-1', name: { dflt: 'Regular' }, location: {} }
            ],
            glyphs: [
                {
                    name: 'A',
                    layers: [
                        {
                            id: 'layer-1',
                            width: 600,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            anchors: [],
                            shapes: []
                        }
                    ]
                }
            ]
        });

        const committedPackets = [];
        bridge.onCommittedChange((entries, context) => {
            committedPackets.push({ entries, context });
        });

        bridge.applySyntheticChangeSet(
            'Set sidebearing',
            [
                {
                    op: 'set',
                    path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
                    oldValue: 600,
                    newValue: 620,
                    workerReplayTargets: [
                        { glyphName: 'A', layerId: 'layer-1' }
                    ]
                }
            ],
            { compileChangeSource: 'test-sync', compileEditType: null }
        );
        expect(committedPackets).toHaveLength(1);
        expect(committedPackets[0].entries).toHaveLength(1);
        expect(committedPackets[0].context).toEqual(
            expect.objectContaining({ origin: 'local' })
        );

        const forwardEntry = committedPackets[0].entries[0];
        expect(forwardEntry).toEqual(
            expect.objectContaining({
                path: 'glyphs.A:layers.layer-1:width',
                oldValue: 600,
                newValue: 620,
                workerReplayTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            })
        );

        expect(bridge.undo('A', 'layer-1')).not.toBeNull();
        expect(committedPackets).toHaveLength(2);
        expect(committedPackets[1].entries).toHaveLength(1);
        expect(committedPackets[1].context).toEqual(
            expect.objectContaining({ origin: 'local' })
        );
        expect(committedPackets[1].entries[0]).toEqual(
            expect.objectContaining({
                path: forwardEntry.path,
                oldValue: forwardEntry.oldValue,
                newValue: forwardEntry.newValue,
                workerReplayTargets: forwardEntry.workerReplayTargets,
                historyAction: 'undo'
            })
        );

        expect(bridge.redo('A', 'layer-1')).not.toBeNull();
        expect(committedPackets).toHaveLength(3);
        expect(committedPackets[2].entries).toHaveLength(1);
        expect(committedPackets[2].context).toEqual(
            expect.objectContaining({ origin: 'local' })
        );
        expect(committedPackets[2].entries[0]).toEqual(
            expect.objectContaining({
                path: forwardEntry.path,
                oldValue: forwardEntry.oldValue,
                newValue: forwardEntry.newValue,
                workerReplayTargets: forwardEntry.workerReplayTargets,
                historyAction: 'redo'
            })
        );

        bridge.destroy();
    });
});

describe('shouldInvalidateLayoutClosureForCommittedEntries', () => {
    // Import the function directly from the module
    const changeBridgeInit = require('../js/change-bridge-init');

    test('returns false for visual layer-scoped paths (outline, anchor, sidebearing)', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                { path: 'glyphs.A.layers.layer-1.shapes.0.nodes.0.x' }
            ]);
        expect(result).toBe(false);
    });

    test('returns true for component add, replace, and delete graph changes', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                {
                    path: 'glyphs.A.layers.layer-1.shapes.0.reference',
                    oldValue: 'sourceA',
                    newValue: 'sourceB'
                },
                {
                    path: 'glyphs.A.layers.layer-1.shapes.1',
                    oldValue: { reference: 'sourceC' },
                    newValue: undefined
                },
                {
                    path: 'glyphs.A.layers.layer-1.shapes.2',
                    oldValue: undefined,
                    newValue: { reference: 'sourceD' }
                }
            ]);
        expect(result).toBe(true);
    });

    test('returns false for a component transform that preserves references', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                {
                    path: 'glyphs.A.layers.layer-1.shapes.0.transform',
                    oldValue: [1, 0, 0, 1, 0, 0],
                    newValue: [1, 0, 0, 1, 20, 0]
                }
            ]);
        expect(result).toBe(false);
    });

    test('returns false for outline edits with dependent replay targets', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                {
                    path: 'glyphs.a.layers.layer-1.shapes.0.nodes',
                    compileChangeSource: 'mouse-drag-outline',
                    compileEditType: 'outline',
                    workerReplayTargets: [
                        { glyphName: 'a', layerId: 'layer-1' },
                        { glyphName: 'adieresis', layerId: 'layer-1' }
                    ]
                }
            ]);
        expect(result).toBe(false);
    });

    test('returns false for drawing-snapshot paths with colon separator', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                { path: 'glyphs.alef:layers.A.0:anchors.0.x' }
            ]);
        expect(result).toBe(false);
    });

    test('returns false for sidebearing layer path', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                { path: 'glyphs.A.layers.layer-1.width' }
            ]);
        expect(result).toBe(false);
    });

    test('returns true for feature-code paths', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                { path: 'features.features.0.1.code' }
            ]);
        expect(result).toBe(true);
    });

    test('returns true for top-level glyph paths (structural changes)', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                { path: 'glyphs.A' }
            ]);
        expect(result).toBe(true);
    });

    test('returns false for glyph-level metrics-key metadata paths', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                { path: 'glyphs.adieresis.format_specific.metric_left' },
                { path: 'glyphs.adieresis.format_specific.metric_right' },
                {
                    path: 'glyphs.n.format_specific.com.schriftgestalt.Glyphs.metricLeft'
                }
            ]);
        expect(result).toBe(false);
    });

    test('returns false for forwarded master reinterpolation glyph snapshots', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                {
                    path: 'glyphs.A',
                    transactionLabel: 'Reinterpolate drawing batch sync',
                    workerReplayTargets: [
                        { glyphName: 'A', layerId: 'master-bold' }
                    ]
                }
            ]);
        expect(result).toBe(false);
    });

    test('returns true for glyph-removal paths', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                { path: 'glyphs.alef' }
            ]);
        expect(result).toBe(true);
    });

    test('returns false for mixed visual layer paths', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                { path: 'glyphs.A.layers.layer-1.anchors.0.x' },
                { path: 'glyphs.B.layers.layer-2.width' }
            ]);
        expect(result).toBe(false);
    });

    test('returns true when any entry is a non-layer glyph path', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                { path: 'glyphs.A.layers.layer-1.anchors.0.x' },
                { path: 'glyphs.B' }
            ]);
        expect(result).toBe(true);
    });
});

describe('syncRustCacheAndRefreshCanvas', () => {
    const originalGlyphCanvas = window.glyphCanvas;
    const originalFontManager = window.fontManager;
    const originalFontCompilationInitialized = fontCompilation.isInitialized;

    afterEach(() => {
        window.glyphCanvas = originalGlyphCanvas;
        window.fontManager = originalFontManager;
        fontCompilation.isInitialized = originalFontCompilationInitialized;
    });

    test('keeps worker replay targets out of visible advance refreshes', async () => {
        const activeDrawing = {
            id: 'active-brace-layer',
            width: 510,
            getMatchingDrawingOnGlyph: jest.fn((glyphName) =>
                glyphName === 'n'
                    ? {
                          id: 'dependent-brace-layer',
                          width: 640
                      }
                    : undefined
            )
        };
        const activeGlyph = {
            findDrawingById: jest.fn((drawingId) =>
                drawingId === 'active-brace-layer' ? activeDrawing : undefined
            )
        };
        const dependentGlyph = {
            findDrawingById: jest.fn((drawingId) =>
                drawingId === 'dependent-brace-layer'
                    ? { id: 'dependent-brace-layer', width: 640 }
                    : undefined
            )
        };
        const fontModel = {
            findGlyph: jest.fn((glyphName) => {
                if (glyphName === 'l') {
                    return activeGlyph;
                }
                if (glyphName === 'n') {
                    return dependentGlyph;
                }
                return undefined;
            })
        };
        const refreshGlyphAdvancesLive = jest.fn();
        const fetchDrawingData = jest.fn(async () => {});
        const reconcileSelectionAfterModelSync = jest.fn(async () => {});

        fontCompilation.isInitialized = false;
        window.fontManager = {
            currentFont: {
                fontModel
            }
        };
        window.glyphCanvas = {
            textRunEditor: {
                refreshGlyphAdvancesLive,
                computePrecedingAdvanceDelta: jest.fn(() => 0)
            },
            requestRepaintAfterCompile: jest.fn(),
            outlineEditor: {
                active: true,
                selectedDrawingId: 'active-brace-layer',
                draggingSomething: false,
                parseGlyphStack: jest.fn(() => [{ glyphName: 'l' }]),
                reconcileSelectionAfterModelSync,
                fetchDrawingData
            }
        };

        await syncRustCacheAndRefreshCanvas(undefined, 'l', {
            skipDeferredCanvasRepaint: true,
            workerReplayTargets: [
                { glyphName: 'l', layerId: 'active-brace-layer' },
                { glyphName: 'n', layerId: 'dependent-brace-layer' }
            ]
        });

        expect(reconcileSelectionAfterModelSync).toHaveBeenCalledWith({
            skipRender: true
        });
        expect(fetchDrawingData).toHaveBeenCalledWith(true, 'l');
        expect(refreshGlyphAdvancesLive).not.toHaveBeenCalled();
    });

    test('waits for worker Yjs sync and pending cache updates without whole-layer encode', async () => {
        const awaitWorkerDocumentSync = jest
            .spyOn(fontCompilation, 'awaitWorkerDocumentSync')
            .mockResolvedValue();
        const refreshWorkerCacheForReplayTargets = jest
            .fn()
            .mockResolvedValue(true);
        const awaitWorkerCacheUpdate = jest.fn(async () => {});

        fontCompilation.isInitialized = true;
        window.fontManager = {
            currentFont: {
                babelfontJson: '{}',
                fontModel: {
                    findGlyph: jest.fn(() => undefined)
                }
            },
            refreshWorkerCacheForReplayTargets,
            submitDrawingToWorkerCache: jest.fn(),
            awaitWorkerCacheUpdate
        };
        window.glyphCanvas = {
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn(),
                computePrecedingAdvanceDelta: jest.fn(() => 0)
            },
            requestRepaintAfterCompile: jest.fn(),
            outlineEditor: {
                active: true,
                selectedDrawingId: 'master-regular',
                draggingSomething: false,
                parseGlyphStack: jest.fn(() => [{ glyphName: 'l' }]),
                reconcileSelectionAfterModelSync: jest.fn(async () => {}),
                fetchDrawingData: jest.fn(async () => {})
            }
        };

        try {
            await syncRustCacheAndRefreshCanvas(undefined, 'l', {
                skipDeferredCanvasRepaint: true,
                workerReplayTargets: [
                    { glyphName: 'l', layerId: 'master-regular' }
                ]
            });

            expect(refreshWorkerCacheForReplayTargets).not.toHaveBeenCalled();
            expect(
                window.fontManager.submitDrawingToWorkerCache
            ).not.toHaveBeenCalled();
            expect(awaitWorkerDocumentSync).toHaveBeenCalledTimes(1);
            expect(awaitWorkerCacheUpdate).toHaveBeenCalledTimes(1);
        } finally {
            awaitWorkerDocumentSync.mockRestore();
        }
    });

    test('skips selected-layer fallback when explicitly disabled', async () => {
        const awaitWorkerDocumentSync = jest
            .spyOn(fontCompilation, 'awaitWorkerDocumentSync')
            .mockResolvedValue();
        const awaitWorkerCacheUpdate = jest.fn(async () => {});

        fontCompilation.isInitialized = true;
        window.fontManager = {
            currentFont: {
                babelfontJson: '{}',
                fontModel: {
                    findGlyph: jest.fn(() => undefined)
                }
            },
            refreshWorkerCacheForReplayTargets: jest.fn(),
            submitDrawingToWorkerCache: jest.fn(),
            awaitWorkerCacheUpdate
        };
        window.glyphCanvas = {
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn(),
                computePrecedingAdvanceDelta: jest.fn(() => 0)
            },
            requestRepaintAfterCompile: jest.fn(),
            outlineEditor: {
                active: true,
                selectedDrawingId: 'master-regular',
                draggingSomething: false,
                parseGlyphStack: jest.fn(() => [{ glyphName: 'l' }]),
                reconcileSelectionAfterModelSync: jest.fn(async () => {}),
                fetchDrawingData: jest.fn(async () => {})
            }
        };

        try {
            await syncRustCacheAndRefreshCanvas(undefined, undefined, {
                skipDeferredCanvasRepaint: true,
                allowSelectedDrawingFallback: false
            });

            expect(
                window.fontManager.submitDrawingToWorkerCache
            ).not.toHaveBeenCalled();
            expect(awaitWorkerDocumentSync).toHaveBeenCalledTimes(1);
            expect(awaitWorkerCacheUpdate).toHaveBeenCalledTimes(1);
        } finally {
            awaitWorkerDocumentSync.mockRestore();
        }
    });

    test('no longer falls back to submitDrawingToWorkerCache for stack layers', async () => {
        const awaitWorkerDocumentSync = jest
            .spyOn(fontCompilation, 'awaitWorkerDocumentSync')
            .mockResolvedValue();
        const submitDrawingToWorkerCache = jest.fn().mockResolvedValue(true);
        const awaitWorkerCacheUpdate = jest.fn(async () => {});

        fontCompilation.isInitialized = true;
        window.fontManager = {
            currentFont: {
                babelfontJson: '{}',
                fontModel: {
                    findGlyph: jest.fn(() => undefined)
                }
            },
            refreshWorkerCacheForReplayTargets: jest.fn(),
            submitDrawingToWorkerCache: submitDrawingToWorkerCache,
            awaitWorkerCacheUpdate
        };
        window.glyphCanvas = {
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn(),
                computePrecedingAdvanceDelta: jest.fn(() => 0)
            },
            requestRepaintAfterCompile: jest.fn(),
            outlineEditor: {
                active: true,
                selectedDrawingId: 'foreground-layer',
                draggingSomething: false,
                parseGlyphStack: jest.fn(() => [
                    { glyphName: 'A', layerId: 'background-layer' }
                ]),
                reconcileSelectionAfterModelSync: jest.fn(async () => {}),
                fetchDrawingData: jest.fn(async () => {})
            }
        };

        try {
            await syncRustCacheAndRefreshCanvas(undefined, 'A', {
                skipDeferredCanvasRepaint: true
            });

            expect(submitDrawingToWorkerCache).not.toHaveBeenCalled();
            expect(awaitWorkerDocumentSync).toHaveBeenCalledTimes(1);
            expect(awaitWorkerCacheUpdate).toHaveBeenCalledTimes(1);
        } finally {
            awaitWorkerDocumentSync.mockRestore();
        }
    });
});

describe('committed undo/redo compile requests', () => {
    let changeBridgeInit;
    let originalWindow;

    beforeEach(() => {
        jest.resetModules();
        originalWindow = global.window;
        global.window = originalWindow;
        changeBridgeInit = require('../js/change-bridge-init');
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    test('undo/redo packets tag the compile source and preserve the edit type', async () => {
        const checkAndSchedule = jest.fn();
        const forceTrigger = jest.fn(async () => {
            window.dispatchEvent(
                new CustomEvent('editingFontCompiled', {
                    detail: { fontRevisionKey: '11' }
                })
            );
        });
        const requestRecompileWithoutDataChange = jest.fn(function () {
            this.compileRequestVersion += 1;
        });

        window.autoCompileManager = {
            checkAndSchedule,
            forceTrigger
        };
        window.fontManager = {
            lastChangeSource: null,
            lastEditType: null,
            setEditingCompileContext(changeSource, editType) {
                this.lastChangeSource = changeSource;
                this.lastEditType = editType;
            },
            clearEditingCompileContext() {
                this.lastChangeSource = null;
                this.lastEditType = null;
            },
            scheduleFullCompileDebounce: jest.fn(),
            currentFont: {
                compileRequestVersion: 10,
                requestRecompileWithoutDataChange
            }
        };

        await changeBridgeInit.handleCommittedChangeRefresh(
            [
                {
                    historyAction: 'undo',
                    transactionLabel: 'Move anchor',
                    compileChangeSource: 'keyboard-anchor',
                    compileEditType: 'anchor',
                    path: 'glyphs.a.layers.layer-1.anchors.0.x',
                    workerReplayTargets: [
                        { glyphName: 'a', layerId: 'layer-1' }
                    ]
                }
            ],
            'local',
            {
                awaitWorkerSync: jest.fn(async () => {}),
                queueCacheRefresh: jest.fn(async () => {})
            }
        );

        expect(window.fontManager.lastChangeSource).toBeNull();
        expect(window.fontManager.lastEditType).toBeNull();
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledWith({
            compileContext: expect.objectContaining({
                changeSource: 'keyboard-anchor',
                editType: 'anchor'
            })
        });
        expect(
            window.fontManager.scheduleFullCompileDebounce
        ).not.toHaveBeenCalled();
        expect(checkAndSchedule).toHaveBeenCalledTimes(1);
        expect(forceTrigger).toHaveBeenCalledTimes(1);
        expect(window.fontManager.currentFont.compileRequestVersion).toBe(11);
    });

    test('committed compile waits for this packet worker forward', async () => {
        let releaseForward;
        const workerForward = new Promise((resolve) => {
            releaseForward = resolve;
        });
        const requestRecompileWithoutDataChange = jest.fn(function () {
            this.compileRequestVersion += 1;
        });
        const activeFontCompilation =
            require('../js/font-compilation').fontCompilation;
        const wasInitialized = activeFontCompilation.isInitialized;
        const hasWorkerCacheDocument = jest
            .spyOn(activeFontCompilation, 'hasWorkerCacheDocument')
            .mockReturnValue(true);
        activeFontCompilation.isInitialized = true;
        window.autoCompileManager = { checkAndSchedule: jest.fn() };
        window.fontManager = {
            lastChangeSource: null,
            lastEditType: null,
            editingFont: new Uint8Array([1]),
            setEditingCompileContext() {},
            clearEditingCompileContext() {},
            currentFont: {
                changeVersion: 2,
                compileRequestVersion: 4,
                requestRecompileWithoutDataChange
            }
        };

        try {
            const pending = handleCommittedChangeRefresh(
                [
                    {
                        compileChangeSource: 'keyboard-kerning-value',
                        compileEditType: 'kerning-value',
                        path: 'masters.regular.kerning'
                    }
                ],
                'local',
                { awaitWorkerSync: () => workerForward }
            );
            await Promise.resolve();
            expect(requestRecompileWithoutDataChange).not.toHaveBeenCalled();
            releaseForward();
            await pending;
            expect(requestRecompileWithoutDataChange).toHaveBeenCalledWith({
                compileContext: expect.objectContaining({
                    changeSource: 'keyboard-kerning-value',
                    editType: 'kerning-value'
                })
            });
        } finally {
            hasWorkerCacheDocument.mockRestore();
            activeFontCompilation.isInitialized = wasInitialized;
        }
    });

    test.each([
        [
            'keyboard-outline',
            'outline',
            'glyphs.a.layers.layer-1.shapes.0.nodes.0.x'
        ],
        ['keyboard-anchor', 'anchor', 'glyphs.a.layers.layer-1.anchors.0.y'],
        ['keyboard-sidebearing', 'sidebearing', 'glyphs.a.layers.layer-1.width']
    ])(
        'committed %s compile waits for this packet worker forward',
        async (changeSource, editType, path) => {
            let releaseForward;
            const workerForward = new Promise((resolve) => {
                releaseForward = resolve;
            });
            const requestRecompileWithoutDataChange = jest.fn(function () {
                this.compileRequestVersion += 1;
            });
            const activeFontCompilation =
                require('../js/font-compilation').fontCompilation;
            const wasInitialized = activeFontCompilation.isInitialized;
            const hasWorkerCacheDocument = jest
                .spyOn(activeFontCompilation, 'hasWorkerCacheDocument')
                .mockReturnValue(true);
            activeFontCompilation.isInitialized = true;
            window.autoCompileManager = { checkAndSchedule: jest.fn() };
            window.fontManager = {
                lastChangeSource: null,
                lastEditType: null,
                editingFont: new Uint8Array([1]),
                setEditingCompileContext() {},
                clearEditingCompileContext() {},
                currentFont: {
                    changeVersion: 2,
                    compileRequestVersion: 4,
                    requestRecompileWithoutDataChange
                }
            };

            try {
                const pending = handleCommittedChangeRefresh(
                    [
                        {
                            compileChangeSource: changeSource,
                            compileEditType: editType,
                            path
                        }
                    ],
                    'local',
                    { awaitWorkerSync: () => workerForward }
                );
                await Promise.resolve();
                expect(
                    requestRecompileWithoutDataChange
                ).not.toHaveBeenCalled();
                releaseForward();
                await pending;
                expect(requestRecompileWithoutDataChange).toHaveBeenCalled();
            } finally {
                hasWorkerCacheDocument.mockRestore();
                activeFontCompilation.isInitialized = wasInitialized;
            }
        }
    );

    test('a kerning path without a kerning stamp compiles full', async () => {
        const requestRecompileWithoutDataChange = jest.fn(function () {
            this.compileRequestVersion += 1;
        });
        const activeFontCompilation =
            require('../js/font-compilation').fontCompilation;
        const wasInitialized = activeFontCompilation.isInitialized;
        const hasWorkerCacheDocument = jest
            .spyOn(activeFontCompilation, 'hasWorkerCacheDocument')
            .mockReturnValue(true);
        activeFontCompilation.isInitialized = true;
        window.autoCompileManager = { checkAndSchedule: jest.fn() };
        window.fontManager = {
            lastChangeSource: null,
            lastEditType: null,
            editingFont: new Uint8Array([1]),
            setEditingCompileContext() {},
            clearEditingCompileContext() {},
            currentFont: {
                changeVersion: 2,
                compileRequestVersion: 4,
                requestRecompileWithoutDataChange
            }
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        compileChangeSource: 'keyboard-outline',
                        compileEditType: null,
                        path: 'masters.regular.kerning'
                    }
                ],
                'local',
                { awaitWorkerSync: async () => {} }
            );
            expect(requestRecompileWithoutDataChange).toHaveBeenCalledWith({
                compileContext: expect.objectContaining({
                    editType: null
                })
            });
        } finally {
            hasWorkerCacheDocument.mockRestore();
            activeFontCompilation.isInitialized = wasInitialized;
        }
    });

    test('kerning plus glyph writes compile full', async () => {
        const requestRecompileWithoutDataChange = jest.fn(function () {
            this.compileRequestVersion += 1;
        });
        const activeFontCompilation =
            require('../js/font-compilation').fontCompilation;
        const wasInitialized = activeFontCompilation.isInitialized;
        const hasWorkerCacheDocument = jest
            .spyOn(activeFontCompilation, 'hasWorkerCacheDocument')
            .mockReturnValue(true);
        activeFontCompilation.isInitialized = true;
        window.autoCompileManager = { checkAndSchedule: jest.fn() };
        window.fontManager = {
            lastChangeSource: null,
            lastEditType: null,
            editingFont: new Uint8Array([1]),
            setEditingCompileContext() {},
            clearEditingCompileContext() {},
            currentFont: {
                changeVersion: 2,
                compileRequestVersion: 4,
                requestRecompileWithoutDataChange
            }
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        compileChangeSource: 'keyboard-kerning-value',
                        compileEditType: 'kerning-value',
                        path: 'masters.regular.kerning'
                    },
                    {
                        compileChangeSource: 'keyboard-kerning-value',
                        compileEditType: 'kerning-value',
                        path: 'glyphs.fi:layers.layer-1'
                    }
                ],
                'local',
                { awaitWorkerSync: async () => {} }
            );
            expect(requestRecompileWithoutDataChange).toHaveBeenCalledWith({
                compileContext: expect.objectContaining({
                    editType: null
                })
            });
        } finally {
            hasWorkerCacheDocument.mockRestore();
            activeFontCompilation.isInitialized = wasInitialized;
        }
    });

    test('undo compiles from the already-forwarded worker update without replay repair', async () => {
        const refreshWorkerCacheForReplayTargets = jest
            .fn()
            .mockResolvedValue(true);
        const awaitWorkerSync = jest.fn(async () => {});
        const requestRecompileWithoutDataChange = jest.fn(function () {
            this.compileRequestVersion += 1;
        });
        const activeFontCompilation =
            require('../js/font-compilation').fontCompilation;
        const wasInitialized = activeFontCompilation.isInitialized;
        const hasWorkerCacheDocument = jest
            .spyOn(activeFontCompilation, 'hasWorkerCacheDocument')
            .mockReturnValue(true);

        activeFontCompilation.isInitialized = true;
        window.autoCompileManager = {
            checkAndSchedule: jest.fn(),
            forceTrigger: jest.fn(async () => {
                window.dispatchEvent(
                    new CustomEvent('editingFontCompiled', {
                        detail: { fontRevisionKey: '2' }
                    })
                );
            })
        };
        window.fontManager = {
            refreshWorkerCacheForReplayTargets,
            awaitWorkerCacheUpdate: jest.fn(async () => {}),
            currentFont: {
                compileRequestVersion: 1,
                requestRecompileWithoutDataChange
            }
        };

        try {
            await changeBridgeInit.handleCommittedChangeRefresh(
                [
                    {
                        historyAction: 'undo',
                        transactionLabel: 'Drag point',
                        path: 'glyphs.A.layers.layer-1.shapes.0.nodes.0.x',
                        workerReplayTargets: [
                            { glyphName: 'Adieresis', layerId: 'layer-1' }
                        ]
                    }
                ],
                'local',
                { awaitWorkerSync }
            );

            expect(refreshWorkerCacheForReplayTargets).not.toHaveBeenCalled();
            expect(awaitWorkerSync).toHaveBeenCalledTimes(2);
            expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        } finally {
            hasWorkerCacheDocument.mockRestore();
            activeFontCompilation.isInitialized = wasInitialized;
        }
    });

    test.each(['undo', 'redo'])(
        '%s RTL kerning packets preserve kerning edit types',
        async (historyAction) => {
            const checkAndSchedule = jest.fn();
            const requestRecompileWithoutDataChange = jest.fn(function () {
                this.compileRequestVersion += 1;
            });

            window.autoCompileManager = {
                checkAndSchedule
            };
            window.fontManager = {
                lastChangeSource: null,
                lastEditType: null,
                setEditingCompileContext(changeSource, editType) {
                    this.lastChangeSource = changeSource;
                    this.lastEditType = editType;
                },
                clearEditingCompileContext() {
                    this.lastChangeSource = null;
                    this.lastEditType = null;
                },
                currentFont: {
                    compileRequestVersion: 2,
                    requestRecompileWithoutDataChange
                }
            };

            await changeBridgeInit.handleCommittedChangeRefresh(
                [
                    {
                        historyAction,
                        transactionLabel: 'Edit kerning pair',
                        compileChangeSource: 'keyboard-kerning-value',
                        compileEditType: 'kerning-value',
                        path: 'masters.master-1.kerning_rtl.@AFirst:@VSecond',
                        oldValue: -50,
                        newValue: -80
                    }
                ],
                'local',
                {
                    awaitWorkerSync: jest.fn(async () => {}),
                    queueCacheRefresh: jest.fn(async () => {})
                }
            );

            expect(window.fontManager.lastChangeSource).toBeNull();
            expect(window.fontManager.lastEditType).toBeNull();
            expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
            expect(requestRecompileWithoutDataChange).toHaveBeenCalledWith({
                compileContext: expect.objectContaining({
                    changeSource: 'keyboard-kerning-value',
                    editType: 'kerning-value'
                })
            });
            expect(checkAndSchedule).toHaveBeenCalledTimes(1);
        }
    );

    test('undo sidebearing packets preserve the stamped sidebearing compile context', async () => {
        const checkAndSchedule = jest.fn();
        const requestRecompileWithoutDataChange = jest.fn(function () {
            this.compileRequestVersion += 1;
        });
        const queueCacheRefresh = jest.fn(async () => {});

        window.autoCompileManager = {
            checkAndSchedule
        };
        window.fontManager = {
            lastChangeSource: null,
            lastEditType: null,
            setEditingCompileContext(changeSource, editType) {
                this.lastChangeSource = changeSource;
                this.lastEditType = editType;
            },
            clearEditingCompileContext() {
                this.lastChangeSource = null;
                this.lastEditType = null;
            },
            currentFont: {
                compileRequestVersion: 4,
                requestRecompileWithoutDataChange
            }
        };

        await changeBridgeInit.handleCommittedChangeRefresh(
            [
                {
                    historyAction: 'undo',
                    transactionLabel: 'Set sidebearing',
                    path: 'glyphs.a.layers.layer-1',
                    compileChangeSource: 'keyboard-sidebearing',
                    compileEditType: null,
                    visualAnchorSide: 'left',
                    workerReplayTargets: [
                        { glyphName: 'a', layerId: 'layer-1' }
                    ]
                }
            ],
            'local',
            {
                awaitWorkerSync: jest.fn(async () => {}),
                queueCacheRefresh
            }
        );

        expect(window.fontManager.lastChangeSource).toBeNull();
        expect(window.fontManager.lastEditType).toBeNull();
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledWith({
            compileContext: expect.objectContaining({
                changeSource: 'keyboard-sidebearing',
                editType: null
            })
        });
        expect(checkAndSchedule).toHaveBeenCalledTimes(1);
    });

    test('undo sidebearing fallback reuses stamped history metadata for full compile', async () => {
        originalWindow.fontManager = {
            lastChangeSource: null,
            lastEditType: null,
            setEditingCompileContext(changeSource, editType) {
                this.lastChangeSource = changeSource;
                this.lastEditType = editType;
            },
            clearEditingCompileContext() {
                this.lastChangeSource = null;
                this.lastEditType = null;
            },
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn(() => ({
                        findDrawingById: jest.fn(() => ({ width: 500 }))
                    }))
                },
                compileRequestVersion: 0,
                requestRecompileWithoutDataChange: jest.fn(function () {
                    this.compileRequestVersion += 1;
                })
            },
            awaitWorkerDocumentSync: jest.fn(async () => {}),
            workerCacheUpdatePromise: Promise.resolve(),
            awaitWorkerCacheUpdate: jest.fn(async () => {}),
            refreshWorkerCacheForReplayTargets: jest.fn(async () => true)
        };
        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn(),
            forceTrigger: jest.fn(async () => {
                originalWindow.dispatchEvent(
                    new CustomEvent('editingFontCompiled', {
                        detail: { fontRevisionKey: '1' }
                    })
                );
            })
        };
        originalWindow.glyphCanvas = {
            viewportManager: { panX: 100, scale: 2 },
            textRunEditor: { refreshGlyphAdvancesLive: jest.fn() },
            requestRepaintAfterCompile: jest.fn(),
            syncCurrentOutlineDrawingDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            outlineEditor: {
                active: true,
                currentGlyphName: 'a',
                selectedDrawingId: 'layer-1',
                parseGlyphStack: () => [{ glyphName: 'a' }],
                fetchDrawingData: jest.fn(),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: () => 'a'
        };
        originalWindow.patchSyncEngine = {
            undo: jest.fn(() => ({
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    entries: [
                        {
                            oldValue: 480,
                            newValue: 500,
                            compileChangeSource: 'keyboard-sidebearing',
                            compileEditType: null
                        }
                    ],
                    touchedPaths: ['glyphs.a.layers.layer-1.width'],
                    transactionLabel: 'Set sidebearing',
                    workerReplayTargets: [
                        { glyphName: 'a', layerId: 'layer-1' }
                    ]
                }
            })),
            redo: jest.fn()
        };

        await changeBridgeInit.runBridgeUndoRedo(
            'undo',
            'a',
            'a',
            'layer-1',
            null
        );

        expect(originalWindow.fontManager.lastChangeSource).toBeNull();
        expect(originalWindow.fontManager.lastEditType).toBeNull();
        expect(
            originalWindow.fontManager.currentFont
                .requestRecompileWithoutDataChange
        ).toHaveBeenCalledTimes(1);
        expect(
            originalWindow.fontManager.currentFont
                .requestRecompileWithoutDataChange
        ).toHaveBeenCalledWith({
            compileContext: expect.objectContaining({
                changeSource: 'keyboard-sidebearing',
                editType: null
            })
        });
    });

    test('undo outline replay reuses forward drawing-snapshot metadata instead of generic undo source', async () => {
        const refreshGlyphAdvancesLive = jest.fn();
        const fetchDrawingData = jest.fn();
        const syncCurrentOutlineDrawingDataFromModel = jest.fn();
        const render = jest.fn();
        const flushPendingKeyboardPreviewCommit = jest.fn(async () => {});

        const makeFontModel = () => ({
            findGlyph: jest.fn(() => ({
                findDrawingById: jest.fn(() => ({ width: 520 }))
            }))
        });

        originalWindow.fontManager = {
            lastChangeSource: null,
            lastEditType: null,
            setEditingCompileContext(changeSource, editType) {
                this.lastChangeSource = changeSource;
                this.lastEditType = editType;
            },
            clearEditingCompileContext() {
                this.lastChangeSource = null;
                this.lastEditType = null;
            },
            currentFont: {
                fontModel: makeFontModel(),
                compileRequestVersion: 0,
                requestRecompileWithoutDataChange: jest.fn(function () {
                    this.compileRequestVersion += 1;
                })
            },
            awaitWorkerDocumentSync: jest.fn(async () => {}),
            workerCacheUpdatePromise: Promise.resolve(),
            awaitWorkerCacheUpdate: jest.fn(async () => {}),
            refreshWorkerCacheForReplayTargets: jest.fn(async () => true)
        };
        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn(),
            forceTrigger: jest.fn(async () => {
                originalWindow.dispatchEvent(
                    new CustomEvent('editingFontCompiled', {
                        detail: { fontRevisionKey: '1' }
                    })
                );
            })
        };
        originalWindow.glyphCanvas = {
            viewportManager: { panX: 100, scale: 2 },
            textRunEditor: { refreshGlyphAdvancesLive },
            requestRepaintAfterCompile: jest.fn(),
            syncCurrentOutlineDrawingDataFromModel:
                syncCurrentOutlineDrawingDataFromModel,
            updatePropertyPanel: jest.fn(),
            render,
            outlineEditor: {
                active: true,
                currentGlyphName: 'a',
                selectedDrawingId: 'layer-1',
                parseGlyphStack: () => [{ glyphName: 'a' }],
                flushPendingKeyboardPreviewCommit,
                canRefreshSelectedDrawingFromModelExactly: jest.fn(() => true),
                refreshSelectedDrawingFromModel: jest.fn(() => true),
                fetchDrawingData: fetchDrawingData,
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: () => 'a'
        };
        originalWindow.patchSyncEngine = {
            undo: jest.fn(() => ({
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    entries: [
                        {
                            transactionLabel: 'Arrow key',
                            compileChangeSource: 'keyboard-outline',
                            compileEditType: 'outline',
                            path: 'glyphs.a:layers.layer-1:',
                            oldValue: 'node 0.17: (258, 472)',
                            newValue: '(258, 462)',
                            replayOldValue: {
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 10, y: 20, nodetype: 'Line' }
                                        ],
                                        closed: false
                                    }
                                ],
                                anchors: []
                            },
                            replayNewValue: {
                                id: 'layer-1',
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 10, y: 10, nodetype: 'Line' }
                                        ],
                                        closed: false
                                    }
                                ],
                                anchors: []
                            },
                            workerReplayTargets: [
                                { glyphName: 'a', layerId: 'layer-1' }
                            ]
                        }
                    ],
                    touchedPaths: ['glyphs.a:layers.layer-1:'],
                    transactionLabel: 'Arrow key',
                    workerReplayTargets: [
                        { glyphName: 'a', layerId: 'layer-1' }
                    ]
                }
            })),
            redo: jest.fn()
        };

        await changeBridgeInit.runBridgeUndoRedo(
            'undo',
            'a',
            'a',
            'layer-1',
            null
        );

        expect(originalWindow.fontManager.lastChangeSource).toBeNull();
        expect(originalWindow.fontManager.lastEditType).toBeNull();
        expect(
            originalWindow.fontManager.currentFont
                .requestRecompileWithoutDataChange
        ).toHaveBeenCalledWith({
            compileContext: expect.objectContaining({
                changeSource: 'keyboard-outline',
                editType: 'outline'
            })
        });
        expect(flushPendingKeyboardPreviewCommit).toHaveBeenCalledTimes(1);
        expect(fetchDrawingData).not.toHaveBeenCalled();
    });

    test('unstamped local sidebearing commits compile full and refresh layer data', async () => {
        const originalFontManager = window.fontManager;
        const originalGlyphCanvas = window.glyphCanvas;
        const fetchDrawingData = jest.fn();
        const refreshSelectedDrawingFromModel = jest.fn(() => true);
        const refreshGlyphAdvancesLive = jest.fn();
        const requestCompile = jest.fn(async () => {});

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set()),
                    findGlyph: jest.fn(() => ({
                        findDrawingById: jest.fn(() => ({
                            isAutomaticAlignedDrawing: jest.fn(() => false)
                        }))
                    }))
                }
            }
        };
        window.glyphCanvas = {
            requestRepaintAfterCompile: jest.fn(),
            textRunEditor: {
                intrinsicGlyphAdvances: new Map([['a', 739]]),
                refreshGlyphAdvancesLive
            },
            outlineEditor: {
                active: true,
                draggingSomething: false,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                reconcileSelectionAfterModelSync: jest.fn(async () => false),
                runDeterministicRefresh: jest.fn(async (refresh) => {
                    await refresh();
                }),
                canRefreshSelectedDrawingFromModelExactly: jest.fn(() => true),
                refreshSelectedDrawingFromModel,
                fetchDrawingData
            }
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Set LSB',
                        path: 'glyphs.a.layers.layer-1.width',
                        oldValue: 739,
                        newValue: 881,
                        editSource: 'mouse-drag-sidebearing',
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'layer-1' }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync: jest.fn(async () => {}),
                    requestCompile
                }
            );
        } finally {
            window.fontManager = originalFontManager;
            window.glyphCanvas = originalGlyphCanvas;
        }

        expect(refreshSelectedDrawingFromModel).not.toHaveBeenCalled();
        expect(fetchDrawingData).toHaveBeenCalledTimes(1);
        expect(refreshGlyphAdvancesLive).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
    });

    test('local committed outline falls back to fetching layer data when exact refresh is unavailable', async () => {
        const originalFontManager = window.fontManager;
        const originalGlyphCanvas = window.glyphCanvas;
        const fetchDrawingData = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set()),
                    findGlyph: jest.fn(() => ({
                        findDrawingById: jest.fn(() => ({
                            isAutomaticAlignedDrawing: jest.fn(() => false)
                        }))
                    }))
                }
            }
        };
        window.glyphCanvas = {
            requestRepaintAfterCompile: jest.fn(),
            outlineEditor: {
                active: true,
                draggingSomething: false,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                reconcileSelectionAfterModelSync: jest.fn(async () => false),
                runDeterministicRefresh: jest.fn(async (refresh) => {
                    await refresh();
                }),
                canRefreshSelectedDrawingFromModelExactly: jest.fn(() => false),
                refreshSelectedDrawingFromModel: jest.fn(),
                fetchDrawingData
            }
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Arrow key',
                        path: 'glyphs.a.layers.layer-1.shapes.0.nodes.0.x'
                    }
                ],
                'local',
                {
                    awaitWorkerSync: jest.fn(async () => {}),
                    requestCompile
                }
            );
        } finally {
            window.fontManager = originalFontManager;
            window.glyphCanvas = originalGlyphCanvas;
        }

        expect(fetchDrawingData).toHaveBeenCalledWith(true, 'a');
        expect(requestCompile).toHaveBeenCalledWith(
            'change-bridge-local',
            null
        );
    });

    test.each([
        ['local undo', 'undo'],
        ['local redo', 'redo']
    ])(
        'skips live advance refresh for full-reshape %s outline packets',
        async (_label, historyAction) => {
            const originalFontManager = window.fontManager;
            const originalGlyphCanvas = window.glyphCanvas;
            const refreshGlyphAdvancesLive = jest.fn();
            const refreshGlyphAdvanceDeltasLive = jest.fn();
            const computePrecedingAdvanceDelta = jest.fn(() => 30);
            const requestCompile = jest.fn(async () => {});

            window.fontManager = {
                currentFont: {
                    fontModel: {
                        findGlyph: jest.fn((glyphName) => ({
                            findDrawingById: jest.fn(() => ({
                                width: glyphName === 'adieresis' ? 640 : 500,
                                isAutomaticAlignedDrawing: jest.fn(() => false)
                            }))
                        }))
                    }
                }
            };
            window.glyphCanvas = {
                viewportManager: { panX: 100, scale: 2 },
                textRunEditor: {
                    intrinsicGlyphAdvances: new Map([
                        ['a', 470],
                        ['adieresis', 600]
                    ]),
                    computePrecedingAdvanceDelta,
                    refreshGlyphAdvanceDeltasLive,
                    refreshGlyphAdvancesLive
                },
                requestRepaintAfterCompile: jest.fn(),
                outlineEditor: {
                    active: true,
                    draggingSomething: false,
                    selectedDrawingId: 'layer-1',
                    parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                    reconcileSelectionAfterModelSync: jest.fn(
                        async () => false
                    ),
                    runDeterministicRefresh: jest.fn(async (refresh) => {
                        await refresh();
                    }),
                    fetchDrawingData: jest.fn()
                },
                getCurrentGlyphName: jest.fn(() => 'a')
            };

            try {
                await handleCommittedChangeRefresh(
                    [
                        {
                            historyAction,
                            transactionLabel: 'Drag point',
                            path: 'glyphs.a.layers.layer-1.shapes.0.nodes.0.x',
                            oldValue: 120,
                            newValue: 140,
                            workerReplayTargets: [
                                {
                                    glyphName: 'adieresis',
                                    layerId: 'layer-1'
                                }
                            ]
                        }
                    ],
                    'local',
                    {
                        awaitWorkerSync: jest.fn(async () => {}),
                        requestCompile
                    }
                );
            } finally {
                window.fontManager = originalFontManager;
                window.glyphCanvas = originalGlyphCanvas;
            }

            expect(refreshGlyphAdvancesLive).not.toHaveBeenCalled();
            expect(refreshGlyphAdvanceDeltasLive).not.toHaveBeenCalled();
            expect(computePrecedingAdvanceDelta).not.toHaveBeenCalled();
            expect(requestCompile).toHaveBeenCalledTimes(1);
        }
    );

    test.each([
        ['local undo', 'local', 'undo'],
        ['local redo', 'local', 'redo'],
        ['remote undo', 'remote', 'undo'],
        ['remote redo', 'remote', 'redo']
    ])(
        'does not treat a component translation as an advance width during %s',
        async (_label, origin, historyAction) => {
            const originalFontManager = window.fontManager;
            const originalGlyphCanvas = window.glyphCanvas;
            const refreshGlyphAdvanceDeltasLive = jest.fn();
            const computePrecedingAdvanceDelta = jest.fn();

            window.fontManager = {
                currentFont: {
                    fontModel: {
                        findGlyph: jest.fn(() => ({
                            findDrawingById: jest.fn(() => ({
                                width: 500,
                                isAutomaticAlignedDrawing: jest.fn(() => false)
                            }))
                        }))
                    }
                }
            };
            window.glyphCanvas = {
                viewportManager: { panX: 100, scale: 2 },
                textRunEditor: {
                    intrinsicGlyphAdvances: new Map([['a', 500]]),
                    computePrecedingAdvanceDelta,
                    refreshGlyphAdvanceDeltasLive
                },
                requestRepaintAfterCompile: jest.fn(),
                outlineEditor: {
                    active: true,
                    draggingSomething: false,
                    selectedDrawingId: 'layer-1',
                    parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                    reconcileSelectionAfterModelSync: jest.fn(
                        async () => false
                    ),
                    runDeterministicRefresh: jest.fn(async (refresh) => {
                        await refresh();
                    }),
                    fetchDrawingData: jest.fn()
                },
                getCurrentGlyphName: jest.fn(() => 'a')
            };

            try {
                await handleCommittedChangeRefresh(
                    [
                        {
                            historyAction,
                            transactionLabel: 'Drag component',
                            path: 'glyphs.a.layers.layer-1.shapes.0.transform.translation.0',
                            oldValue: 100,
                            newValue: 140
                        }
                    ],
                    origin,
                    {
                        awaitWorkerSync: jest.fn(async () => {}),
                        requestCompile: jest.fn(async () => {})
                    }
                );
            } finally {
                window.fontManager = originalFontManager;
                window.glyphCanvas = originalGlyphCanvas;
            }

            expect(refreshGlyphAdvanceDeltasLive).not.toHaveBeenCalled();
            expect(computePrecedingAdvanceDelta).not.toHaveBeenCalled();
        }
    );

    test('does not replay component advances already applied by the local drag preview', async () => {
        const originalFontManager = window.fontManager;
        const originalGlyphCanvas = window.glyphCanvas;
        const refreshGlyphAdvanceDeltasLive = jest.fn();
        const requestCompile = jest.fn(async () => {});

        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn(() => ({
                        findDrawingById: jest.fn(() => ({
                            width: 520,
                            isAutomaticAlignedDrawing: jest.fn(() => false)
                        }))
                    }))
                }
            }
        };
        window.glyphCanvas = {
            textRunEditor: {
                intrinsicGlyphAdvances: new Map([['a', 520]]),
                refreshGlyphAdvanceDeltasLive
            },
            requestRepaintAfterCompile: jest.fn(),
            outlineEditor: {
                active: true,
                draggingSomething: false,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                reconcileSelectionAfterModelSync: jest.fn(async () => false),
                runDeterministicRefresh: jest.fn(async (refresh) => {
                    await refresh();
                }),
                fetchDrawingData: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a')
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag component',
                        editSource: 'mouse-drag-outline',
                        compileChangeSource: 'mouse-drag-outline',
                        path: 'glyphs.a.layers.layer-1',
                        oldValue: { width: 500 },
                        newValue: { width: 520 }
                    }
                ],
                'local',
                {
                    awaitWorkerSync: jest.fn(async () => {}),
                    requestCompile
                }
            );
        } finally {
            window.fontManager = originalFontManager;
            window.glyphCanvas = originalGlyphCanvas;
        }

        expect(refreshGlyphAdvanceDeltasLive).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledTimes(1);
    });
});

const {
    takeCommittedUiRefresh,
    resetCommittedUiRefreshCoalescer
} = require('../js/change-bridge-init');

describe('takeCommittedUiRefresh', () => {
    beforeEach(() => {
        resetCommittedUiRefreshCoalescer();
    });

    test('holds a multi-document commit until every packet has arrived', () => {
        const shared = [{ path: 'glyphs.A:' }, { path: 'glyphs.B:' }];
        const first = takeCommittedUiRefresh(
            shared,
            'local',
            { id: 'ui-batch:1', index: 0, count: 2 },
            Promise.resolve(),
            { editedGlyphName: 'A' }
        );
        expect(first).toBeNull();

        const done = takeCommittedUiRefresh(
            shared,
            'local',
            { id: 'ui-batch:1', index: 1, count: 2 },
            Promise.resolve(),
            undefined
        );
        expect(done.entries).toEqual(shared);
        expect(done.workerForwards).toHaveLength(2);
        expect(done.undo).toEqual({ editedGlyphName: 'A' });
    });

    test('passes a single document through immediately', () => {
        const entries = [{ path: 'glyphs.A:' }];
        const done = takeCommittedUiRefresh(
            entries,
            'local',
            undefined,
            Promise.resolve(),
            undefined
        );
        expect(done.entries).toBe(entries);
        expect(done.workerForwards).toHaveLength(1);
    });
});
