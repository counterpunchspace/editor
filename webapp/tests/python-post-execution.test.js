describe('Python post-execution synthetic commit alignment', () => {
    let originalReadyState;

    function loadModule() {
        jest.resetModules();
        originalReadyState = document.readyState;
        Object.defineProperty(document, 'readyState', {
            configurable: true,
            value: 'loading'
        });

        let moduleExports;
        let assistantExecutionContext;
        jest.isolateModules(() => {
            moduleExports = require('../js/python-post-execution');
            assistantExecutionContext = require('../js/assistant-execution-context.ts');
        });

        Object.defineProperty(document, 'readyState', {
            configurable: true,
            value: originalReadyState
        });

        return { ...moduleExports, assistantExecutionContext };
    }

    function loadModuleImmediately() {
        jest.resetModules();
        originalReadyState = document.readyState;
        Object.defineProperty(document, 'readyState', {
            configurable: true,
            value: 'complete'
        });

        try {
            jest.isolateModules(() => {
                require('../js/python-post-execution');
            });
        } finally {
            Object.defineProperty(document, 'readyState', {
                configurable: true,
                value: originalReadyState
            });
        }
    }

    function withoutGlyphIds(snapshot) {
        const clone = JSON.parse(JSON.stringify(snapshot));
        if (Array.isArray(clone.glyphs)) {
            for (const glyph of clone.glyphs) {
                if (glyph && typeof glyph === 'object') {
                    delete glyph.id;
                }
            }
        }
        return clone;
    }

    afterEach(() => {
        delete window.autoCompileManager;
        delete window.afterPythonExecution;
        delete window.fontManager;
        delete window.patchSyncEngine;
        delete window.pythonExecutionHistoryContext;
        delete window.__counterpunchPythonPostExecutionHookInstalled;
    });

    test('derives Python synthetic changes from the refreshed canonical serialized snapshot', () => {
        const { commitPythonExecutionSyntheticChanges } = loadModule();
        const currentFont = {
            babelfontData: {
                glyphs: [
                    {
                        name: 'a',
                        layers: [{ id: 'default', width: 600 }]
                    }
                ]
            },
            babelfontJson: JSON.stringify({
                glyphs: [
                    {
                        name: 'a',
                        layers: [{ id: 'default', width: 500 }]
                    }
                ]
            }),
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = JSON.stringify({
                    glyphs: [
                        {
                            name: 'a',
                            layers: [{ id: 'default', width: 610 }]
                        }
                    ]
                });
            })
        };
        const bridge = {
            setRecordingSuppressed: jest.fn(),
            applySyntheticChangeSet: jest.fn(),
            endTransaction: jest.fn()
        };

        commitPythonExecutionSyntheticChanges(
            currentFont,
            {
                transactionStarted: true,
                beforeFontDataJson: JSON.stringify({
                    glyphs: [
                        {
                            name: 'a',
                            layers: [{ id: 'default', width: 500 }]
                        }
                    ]
                }),
                label: 'Python script'
            },
            bridge
        );

        expect(currentFont.syncJsonFromModel).toHaveBeenCalledTimes(1);
        expect(bridge.setRecordingSuppressed).toHaveBeenCalledWith(false);
        expect(bridge.applySyntheticChangeSet).toHaveBeenCalledWith(
            'Python script',
            expect.arrayContaining([
                expect.objectContaining({
                    op: 'set',
                    path: ['glyphs', 'a', 'layers', 'default', 'width'],
                    oldValue: 500,
                    newValue: 610,
                    editSource: 'python'
                })
            ]),
            { ignoreRecordingSuppression: true }
        );
        expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
    });

    test('still canonicalizes the current font when no history context is available', () => {
        const { commitPythonExecutionSyntheticChanges } = loadModule();
        const currentFont = {
            babelfontData: {
                glyphs: []
            },
            syncJsonFromModel: jest.fn()
        };
        const bridge = {
            setRecordingSuppressed: jest.fn(),
            applySyntheticChangeSet: jest.fn(),
            endTransaction: jest.fn()
        };

        commitPythonExecutionSyntheticChanges(currentFont, null, bridge);

        expect(currentFont.syncJsonFromModel).toHaveBeenCalledTimes(1);
        expect(bridge.setRecordingSuppressed).not.toHaveBeenCalled();
        expect(bridge.applySyntheticChangeSet).not.toHaveBeenCalled();
        expect(bridge.endTransaction).not.toHaveBeenCalled();
    });

    test('emits one scoped Yjs packet for one canonical Python node change', () => {
        const { commitPythonExecutionSyntheticChanges } = loadModule();
        const { PatchSyncEngine } = require('../js/patch-sync-engine');
        const beforeSnapshot = {
            glyphs: [
                {
                    name: 'a',
                    layers: [
                        {
                            id: 'default',
                            width: 500,
                            shapes: [
                                {
                                    type: 'path',
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Move' },
                                        { x: 100, y: 0, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ]
                        }
                    ]
                }
            ]
        };
        const afterSnapshot = JSON.parse(JSON.stringify(beforeSnapshot));
        afterSnapshot.glyphs[0].layers[0].shapes[0].nodes = [
            { x: 0, y: 100, nodetype: 'Move' },
            { x: 100, y: 0, nodetype: 'Line' }
        ];
        const beforeFontDataJson = JSON.stringify(beforeSnapshot);
        const bridge = new PatchSyncEngine('python-one-node-packet');
        bridge.initFromJson(beforeSnapshot);
        const emittedUpdates = [];
        bridge.onLocalUpdate((update, _message, entries) => {
            emittedUpdates.push({ update, entries });
        });
        bridge.beginTransaction('Python script');
        const releaseRecordingSuppression = bridge.beginRecordingSuppression();

        commitPythonExecutionSyntheticChanges(
            {
                babelfontJson: JSON.stringify(afterSnapshot),
                syncJsonFromModel: jest.fn()
            },
            {
                transactionStarted: true,
                beforeFontDataJson,
                label: 'Python script',
                releaseRecordingSuppression
            },
            bridge
        );

        expect(emittedUpdates).toHaveLength(1);
        expect(emittedUpdates[0].entries).toEqual([
            expect.objectContaining({
                op: 'set',
                path: 'glyphs.a:layers.default:shapes',
                workerReplayTargets: [{ glyphName: 'a', layerId: 'default' }]
            })
        ]);
        expect(
            emittedUpdates[0].entries.some((entry) => entry.path === 'font')
        ).toBe(false);

        bridge.destroy();
    });

    test('closes the Python transaction when canonicalization fails', () => {
        const { commitPythonExecutionSyntheticChanges } = loadModule();
        const currentFont = {
            syncJsonFromModel: jest.fn(() => {
                throw new Error('invalid Python model state');
            })
        };
        const bridge = {
            setRecordingSuppressed: jest.fn(),
            applySyntheticChangeSet: jest.fn(),
            endTransaction: jest.fn()
        };

        expect(() =>
            commitPythonExecutionSyntheticChanges(
                currentFont,
                { beforeFontDataJson: null, transactionStarted: true },
                bridge
            )
        ).toThrow('invalid Python model state');
        expect(bridge.setRecordingSuppressed).toHaveBeenCalledWith(false);
        expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
    });

    test('replaces reordered OpenType features atomically', () => {
        const { commitPythonExecutionSyntheticChanges } = loadModule();
        const executionOrder = [];
        const onFontModelSync = () => executionOrder.push('fontModelSync');
        const zero = {
            code: 'sub zero by zero.zero;\n',
            automatic: true
        };
        const frac = {
            code: 'sub slash by fraction;\n',
            automatic: true
        };
        const currentFont = {
            babelfontJson: '',
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = JSON.stringify({
                    features: {
                        features: [
                            ['frac', frac],
                            ['zero', zero]
                        ]
                    }
                });
            })
        };
        const bridge = {
            setRecordingSuppressed: jest.fn(),
            applySyntheticChangeSet: jest.fn(),
            endTransaction: jest.fn(() => {
                executionOrder.push('commit');
                return {};
            })
        };

        window.addEventListener('fontModelSync', onFontModelSync);
        try {
            commitPythonExecutionSyntheticChanges(
                currentFont,
                {
                    transactionStarted: true,
                    beforeFontDataJson: JSON.stringify({
                        features: {
                            features: [
                                ['zero', zero],
                                ['frac', frac]
                            ]
                        }
                    }),
                    label: 'Reorder features'
                },
                bridge
            );
        } finally {
            window.removeEventListener('fontModelSync', onFontModelSync);
        }

        expect(bridge.applySyntheticChangeSet).toHaveBeenCalledWith(
            'Reorder features',
            [
                expect.objectContaining({
                    op: 'set',
                    path: ['features', 'features'],
                    oldValue: [
                        ['zero', zero],
                        ['frac', frac]
                    ],
                    newValue: [
                        ['frac', frac],
                        ['zero', zero]
                    ]
                })
            ],
            { ignoreRecordingSuppression: true }
        );
        expect(executionOrder).toEqual(['commit', 'fontModelSync']);
    });

    test('records reordered glyph collections through the schema order path', () => {
        const { commitPythonExecutionSyntheticChanges } = loadModule();
        const firstGlyph = { name: 'a', layers: [] };
        const secondGlyph = { name: 'b', layers: [] };
        const currentFont = {
            babelfontJson: '',
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = JSON.stringify({
                    glyphs: [secondGlyph, firstGlyph]
                });
            })
        };
        const bridge = {
            setRecordingSuppressed: jest.fn(),
            applySyntheticChangeSet: jest.fn(),
            endTransaction: jest.fn()
        };

        commitPythonExecutionSyntheticChanges(
            currentFont,
            {
                transactionStarted: true,
                beforeFontDataJson: JSON.stringify({
                    glyphs: [firstGlyph, secondGlyph]
                }),
                label: 'Reorder glyphs'
            },
            bridge
        );

        expect(bridge.applySyntheticChangeSet).toHaveBeenCalledWith(
            'Reorder glyphs',
            [
                expect.objectContaining({
                    op: 'set',
                    path: ['glyphOrder'],
                    oldValue: ['a', 'b'],
                    newValue: ['b', 'a']
                })
            ],
            { ignoreRecordingSuppression: true }
        );
    });

    test('closes an assistant Python transaction so its committed funnel can run', () => {
        const {
            commitPythonExecutionSyntheticChanges,
            assistantExecutionContext: { setActiveAssistantPythonExecution }
        } = loadModule();
        const currentFont = {
            babelfontJson: '',
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = JSON.stringify({
                    features: {
                        features: [['liga', { code: 'sub f i by fi;' }]]
                    }
                });
            })
        };
        const bridge = {
            setRecordingSuppressed: jest.fn(),
            applySyntheticChangeSet: jest.fn(),
            endTransaction: jest.fn()
        };

        setActiveAssistantPythonExecution({
            id: 'prompt-1',
            allowFontEdits: true,
            historySummary: 'Adjust OpenType features'
        });
        try {
            commitPythonExecutionSyntheticChanges(
                currentFont,
                {
                    transactionStarted: true,
                    beforeFontDataJson: JSON.stringify({
                        features: {
                            features: [['liga', { code: 'sub f f by ff;' }]]
                        }
                    }),
                    label: 'Python script'
                },
                bridge
            );
        } finally {
            setActiveAssistantPythonExecution(null);
        }

        expect(bridge.applySyntheticChangeSet).toHaveBeenCalledTimes(1);
        expect(bridge.applySyntheticChangeSet).toHaveBeenCalledWith(
            'Python script',
            expect.arrayContaining([
                expect.objectContaining({
                    editSource: 'assistant'
                })
            ]),
            { ignoreRecordingSuppression: true }
        );
        expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
    });

    test('commits the canonical Python diff after releasing scoped live recording suppression', () => {
        const { commitPythonExecutionSyntheticChanges } = loadModule();
        const { PatchSyncEngine } = require('../js/patch-sync-engine');
        const { yDocToJson } = require('../js/change-bridge-ydoc');
        const Y = require('yjs');
        const beforeSnapshot = { names: { familyName: 'Before' } };
        const afterSnapshot = { names: { familyName: 'After' } };
        const sender = new PatchSyncEngine('python-suppression-sender');
        const receiver = new PatchSyncEngine('python-suppression-receiver');
        const receiverFontJson = JSON.parse(JSON.stringify(beforeSnapshot));
        sender.initFromJson(beforeSnapshot);
        receiver._fontJson = receiverFontJson;
        receiver.applyDocumentSetState(sender.encodeDocumentSet());

        const emittedUpdates = [];
        sender.onLocalUpdate((update, _message, entries) => {
            emittedUpdates.push({ update, entries });
        });
        sender.beginTransaction('Python script', null, {
            historyItemId: 'prompt-python-suppression',
            promptGroupId: 'prompt-python-suppression',
            historySummary: 'Rename family'
        });
        const releaseRecordingSuppression = sender.beginRecordingSuppression();

        commitPythonExecutionSyntheticChanges(
            {
                babelfontJson: '',
                syncJsonFromModel: jest.fn(function () {
                    this.babelfontJson = JSON.stringify(afterSnapshot);
                })
            },
            {
                transactionStarted: true,
                beforeFontDataJson: JSON.stringify(beforeSnapshot),
                label: 'Python script',
                releaseRecordingSuppression
            },
            sender
        );

        expect(emittedUpdates).toHaveLength(1);
        expect(emittedUpdates[0].entries).toEqual([
            expect.objectContaining({
                path: 'names.familyName',
                promptGroupId: 'prompt-python-suppression'
            })
        ]);
        expect(sender.getFontJsonSnapshot()).toEqual(
            expect.objectContaining(afterSnapshot)
        );

        receiver.applyRemoteUpdate(
            emittedUpdates[0].update,
            emittedUpdates[0].entries
        );
        expect(receiverFontJson).toEqual(
            expect.objectContaining(afterSnapshot)
        );

        sender.destroy();
        receiver.destroy();
    });

    test('starts each assistant Python execution with the prompt history identity', () => {
        jest.resetModules();
        const {
            setActiveAssistantPythonExecution
        } = require('../js/assistant-execution-context.ts');
        require('../js/python-ui-sync.ts');
        const bridge = {
            beginTransaction: jest.fn(),
            setRecordingSuppressed: jest.fn()
        };
        window.patchSyncEngine = bridge;
        const canonicalSnapshot = {
            glyphs: [
                {
                    name: 'a',
                    layers: [
                        {
                            id: 'default',
                            shapes: [
                                {
                                    type: 'path',
                                    nodes: 'l 0 0',
                                    closed: false
                                }
                            ]
                        }
                    ]
                }
            ]
        };
        const syncJsonFromModel = jest.fn(function () {
            this.babelfontJson = JSON.stringify(canonicalSnapshot);
        });
        window.fontManager = {
            currentFont: {
                babelfontData: {
                    glyphs: [
                        {
                            name: 'a',
                            layers: [
                                {
                                    id: 'default',
                                    shapes: [
                                        {
                                            type: 'path',
                                            nodes: [[0, 0, 'l']]
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                },
                babelfontJson: null,
                syncJsonFromModel
            }
        };

        setActiveAssistantPythonExecution({
            id: 'prompt-1',
            allowFontEdits: true,
            historySummary: 'Reorder features'
        });
        try {
            window.beforePythonExecution(
                'features[0], features[1] = features[1], features[0]'
            );
        } finally {
            setActiveAssistantPythonExecution(null);
        }

        expect(bridge.beginTransaction).toHaveBeenCalledWith(
            'Reorder features',
            null,
            {
                historyItemId: 'prompt-1',
                promptGroupId: 'prompt-1',
                historySummary: 'Reorder features'
            }
        );
        expect(bridge.setRecordingSuppressed).toHaveBeenCalledWith(true);
        expect(syncJsonFromModel).toHaveBeenCalledTimes(1);
        expect(window.pythonExecutionHistoryContext.beforeFontDataJson).toBe(
            JSON.stringify(canonicalSnapshot)
        );
    });

    test('does not begin a Python bridge transaction when snapshot serialization fails', () => {
        jest.resetModules();
        require('../js/python-ui-sync.ts');
        const bridge = {
            beginTransaction: jest.fn(),
            beginRecordingSuppression: jest.fn(),
            setRecordingSuppressed: jest.fn()
        };
        window.patchSyncEngine = bridge;
        window.fontManager = {
            currentFont: {
                syncJsonFromModel: jest.fn(() => {
                    throw new Error('cannot serialize font');
                })
            }
        };

        expect(() =>
            window.beforePythonExecution('Layer().width += 1')
        ).toThrow('cannot serialize font');
        expect(bridge.beginTransaction).not.toHaveBeenCalled();
        expect(bridge.beginRecordingSuppression).not.toHaveBeenCalled();
        expect(bridge.setRecordingSuppressed).not.toHaveBeenCalled();
    });

    test('does not stack the post-execution commit hook after module reinitialization', async () => {
        window.autoCompileManager = {};
        const existingHook = jest.fn();
        window.afterPythonExecution = existingHook;

        loadModuleImmediately();
        const installedHook = window.afterPythonExecution;

        loadModuleImmediately();

        expect(window.afterPythonExecution).toBe(installedHook);
        await installedHook();
        expect(existingHook).toHaveBeenCalledTimes(1);
    });

    test('commits one prompt-owned feature reorder update with one undo step', () => {
        const {
            commitPythonExecutionSyntheticChanges,
            assistantExecutionContext: { setActiveAssistantPythonExecution }
        } = loadModule();
        const { PatchSyncEngine } = require('../js/patch-sync-engine');
        const { yDocToJson } = require('../js/change-bridge-ydoc');
        const { buildHistoryStackItems } = require('../js/change-log');
        const Y = require('yjs');
        const zero = { code: 'sub zero by zero.zero;', automatic: true };
        const frac = { code: 'sub slash by fraction;', automatic: true };
        const beforeSnapshot = {
            features: {
                features: [
                    ['zero', zero],
                    ['frac', frac]
                ]
            }
        };
        const afterSnapshot = {
            features: {
                features: [
                    ['frac', frac],
                    ['zero', zero]
                ]
            }
        };
        const finalSnapshot = {
            features: {
                features: [
                    [
                        'frac',
                        {
                            ...frac,
                            code: 'sub slash by fraction;\nsub one by one.numr;'
                        }
                    ],
                    ['zero', zero]
                ]
            }
        };
        const sender = new PatchSyncEngine('prompt-feature-reorder-sender');
        const receiver = new PatchSyncEngine('prompt-feature-reorder-receiver');
        const receiverFontJson = JSON.parse(JSON.stringify(beforeSnapshot));
        sender.initFromJson(JSON.parse(JSON.stringify(beforeSnapshot)));
        receiver._fontJson = receiverFontJson;
        receiver.applyDocumentSetState(sender.encodeDocumentSet());

        const emittedUpdates = [];
        sender.onLocalUpdate((update, _message, entries) => {
            emittedUpdates.push({ update, entries });
        });
        sender.beginTransaction('Reorder features', null, {
            historyItemId: 'prompt-feature-reorder',
            promptGroupId: 'prompt-feature-reorder',
            historySummary: 'Reorder features'
        });
        setActiveAssistantPythonExecution({
            id: 'prompt-feature-reorder',
            allowFontEdits: true,
            historySummary: 'Reorder features'
        });
        try {
            commitPythonExecutionSyntheticChanges(
                {
                    babelfontJson: '',
                    syncJsonFromModel: jest.fn(function () {
                        this.babelfontJson = JSON.stringify(afterSnapshot);
                    })
                },
                {
                    transactionStarted: true,
                    beforeFontDataJson: JSON.stringify(beforeSnapshot),
                    label: 'Reorder features'
                },
                sender
            );
        } finally {
            setActiveAssistantPythonExecution(null);
        }

        sender.beginTransaction('Update feature code', null, {
            historyItemId: 'prompt-feature-reorder',
            promptGroupId: 'prompt-feature-reorder',
            historySummary: 'Reorder features'
        });
        setActiveAssistantPythonExecution({
            id: 'prompt-feature-reorder',
            allowFontEdits: true,
            historySummary: 'Reorder features'
        });
        try {
            commitPythonExecutionSyntheticChanges(
                {
                    babelfontJson: '',
                    syncJsonFromModel: jest.fn(function () {
                        this.babelfontJson = JSON.stringify(finalSnapshot);
                    })
                },
                {
                    transactionStarted: true,
                    beforeFontDataJson: JSON.stringify(afterSnapshot),
                    label: 'Update feature code'
                },
                sender
            );
        } finally {
            setActiveAssistantPythonExecution(null);
        }

        expect(emittedUpdates).toHaveLength(2);
        expect(emittedUpdates[0].entries).toEqual([
            expect.objectContaining({
                path: 'features.features',
                replayOldValue: beforeSnapshot.features.features,
                replayNewValue: afterSnapshot.features.features,
                promptGroupId: 'prompt-feature-reorder'
            })
        ]);
        expect(buildHistoryStackItems(sender.getChangeLog())).toEqual([
            expect.objectContaining({
                id: 'prompt-feature-reorder',
                entries: expect.arrayContaining([
                    expect.objectContaining({ path: 'features.features' })
                ])
            })
        ]);
        expect(sender.getFontJsonSnapshot()).toEqual(finalSnapshot);

        expect(emittedUpdates).toHaveLength(2);
        expect(buildHistoryStackItems(sender.getChangeLog())).toEqual([
            expect.objectContaining({
                id: 'prompt-feature-reorder',
                historySummary: 'Reorder features'
            })
        ]);

        receiver.applyRemoteUpdate(
            emittedUpdates[0].update,
            emittedUpdates[0].entries
        );
        receiver.applyRemoteUpdate(
            emittedUpdates[1].update,
            emittedUpdates[1].entries
        );
        expect(receiverFontJson).toEqual(finalSnapshot);

        sender.undo();
        expect(emittedUpdates).toHaveLength(3);
        expect(sender.getFontJsonSnapshot()).toEqual(beforeSnapshot);
        receiver.applyRemoteUpdate(
            emittedUpdates[2].update,
            emittedUpdates[2].entries
        );
        expect(receiverFontJson).toEqual(beforeSnapshot);

        sender.redo();
        expect(emittedUpdates).toHaveLength(4);
        expect(sender.getFontJsonSnapshot()).toEqual(finalSnapshot);
        receiver.applyRemoteUpdate(
            emittedUpdates[3].update,
            emittedUpdates[3].entries
        );
        expect(receiverFontJson).toEqual(finalSnapshot);

        sender.destroy();
        receiver.destroy();
    });

    test('replays mixed font, glyph, and layer prompt edits as one logical undo item', () => {
        const { PatchSyncEngine } = require('../js/patch-sync-engine');
        const { yDocToJson } = require('../js/change-bridge-ydoc');
        const { buildHistoryStackItems } = require('../js/change-log');
        const Y = require('yjs');
        const beforeSnapshot = {
            names: { familyName: 'Before' },
            glyphs: {
                A: {
                    name: 'A',
                    note: 'before',
                    layers: {
                        master: { width: 500, shapes: [] }
                    }
                }
            }
        };
        const sender = new PatchSyncEngine('mixed-prompt-sender');
        const receiver = new PatchSyncEngine('mixed-prompt-receiver');
        sender.initFromJson(beforeSnapshot);
        const normalizedBeforeSnapshot = sender.getFontJsonSnapshot();
        const finalSnapshot = JSON.parse(
            JSON.stringify(normalizedBeforeSnapshot)
        );
        finalSnapshot.names.familyName = 'After';
        finalSnapshot.glyphs[0].note = 'after';
        finalSnapshot.glyphs[0].layers[0].width = 600;
        finalSnapshot.glyphs[0].layers[0].shapes = [
            { id: 'shape-1', type: 'path', nodes: [], closed: true }
        ];
        const receiverFinalSnapshot = JSON.parse(JSON.stringify(finalSnapshot));
        receiverFinalSnapshot.glyphs[0].layers[0].shapes[0].nodes = [];
        const receiverFontJson = JSON.parse(
            JSON.stringify(normalizedBeforeSnapshot)
        );
        receiver._fontJson = receiverFontJson;
        receiver.applyDocumentSetState(sender.encodeDocumentSet());

        const emittedUpdates = [];
        sender.onLocalUpdate((update, _message, entries, documentId) => {
            emittedUpdates.push({ update, entries, documentId });
        });
        sender.onGlyphRevisionSignal((update, entries) => {
            emittedUpdates.push({
                update,
                entries,
                documentId: 'font-core'
            });
        });
        const promptHistoryMetadata = {
            historyItemId: 'prompt-mixed-scope',
            promptGroupId: 'prompt-mixed-scope',
            historySummary: 'Adjust family and A'
        };
        const commit = (label, change) => {
            sender.beginTransaction(label, null, promptHistoryMetadata);
            change();
            sender.endTransaction();
        };

        commit('Rename family', () =>
            sender.recordChange(['names'], 'familyName', 'Before', 'After')
        );
        commit('Update glyph note', () =>
            sender.recordChange(['glyphs', 'A'], 'note', 'before', 'after')
        );
        commit('Adjust layer', () => {
            sender.recordChange(
                ['glyphs', 'A', 'layers', 'master'],
                'width',
                500,
                600
            );
            sender.recordChange(
                ['glyphs', 'A', 'layers', 'master'],
                'shapes',
                [],
                [{ id: 'shape-1', type: 'path', nodes: [] }]
            );
        });

        expect(buildHistoryStackItems(sender.getChangeLog())).toEqual([
            expect.objectContaining({
                id: 'prompt-mixed-scope',
                entries: expect.arrayContaining([
                    expect.objectContaining({ path: 'names.familyName' }),
                    expect.objectContaining({ path: 'glyphs.A:note' }),
                    expect.objectContaining({
                        path: 'glyphs.A:layers.master:width'
                    })
                ])
            })
        ]);
        expect(sender.getFontJsonSnapshot()).toEqual(finalSnapshot);

        for (const packet of emittedUpdates) {
            receiver.applyRemoteUpdate(
                packet.update,
                packet.entries,
                undefined,
                packet.documentId
            );
        }
        expect(receiverFontJson).toEqual(receiverFinalSnapshot);

        const undoFrom = emittedUpdates.length;
        sender.undo();
        for (const packet of emittedUpdates.slice(undoFrom)) {
            receiver.applyRemoteUpdate(
                packet.update,
                packet.entries,
                undefined,
                packet.documentId
            );
        }
        expect(sender.getFontJsonSnapshot()).toEqual(normalizedBeforeSnapshot);
        expect(receiverFontJson).toEqual(normalizedBeforeSnapshot);

        const redoFrom = emittedUpdates.length;
        sender.redo();
        for (const packet of emittedUpdates.slice(redoFrom)) {
            receiver.applyRemoteUpdate(
                packet.update,
                packet.entries,
                undefined,
                packet.documentId
            );
        }
        expect(sender.getFontJsonSnapshot()).toEqual(finalSnapshot);
        expect(receiverFontJson).toEqual(receiverFinalSnapshot);

        sender.destroy();
        receiver.destroy();
    });

    test('applies Python glyph and layer collection changes through keyed Yjs maps', () => {
        const { commitPythonExecutionSyntheticChanges } = loadModule();
        const { PatchSyncEngine } = require('../js/patch-sync-engine');
        const { yDocToJson } = require('../js/change-bridge-ydoc');
        const Y = require('yjs');
        const beforeSnapshot = {
            glyphs: [
                {
                    name: 'A',
                    layers: [
                        {
                            id: 'layer-a',
                            width: 500,
                            master: { type: 'DefaultForMaster', master: 'm1' },
                            shapes: [],
                            anchors: []
                        }
                    ]
                },
                {
                    name: 'B',
                    layers: [
                        {
                            id: 'layer-b',
                            width: 600,
                            master: { type: 'DefaultForMaster', master: 'm1' },
                            shapes: [],
                            anchors: []
                        }
                    ]
                },
                {
                    name: 'D',
                    layers: [
                        {
                            id: 'layer-d',
                            width: 800,
                            master: { type: 'DefaultForMaster', master: 'm1' },
                            shapes: [],
                            anchors: []
                        }
                    ]
                }
            ]
        };
        const afterSnapshot = {
            glyphs: [
                {
                    name: 'B',
                    layers: [
                        {
                            id: 'layer-b2',
                            width: 650,
                            master: { type: 'DefaultForMaster', master: 'm1' },
                            shapes: [],
                            anchors: []
                        },
                        {
                            id: 'layer-b',
                            width: 600,
                            master: { type: 'DefaultForMaster', master: 'm1' },
                            shapes: [],
                            anchors: []
                        }
                    ]
                },
                {
                    name: 'C',
                    layers: [
                        {
                            id: 'layer-c',
                            width: 700,
                            master: { type: 'DefaultForMaster', master: 'm1' },
                            shapes: [],
                            anchors: []
                        }
                    ]
                },
                {
                    name: 'D',
                    layers: [
                        {
                            id: 'layer-d',
                            width: 800,
                            master: { type: 'DefaultForMaster', master: 'm1' },
                            shapes: [],
                            anchors: []
                        }
                    ]
                }
            ]
        };
        const sender = new PatchSyncEngine('python-collection-sender');
        const receiver = new PatchSyncEngine('python-collection-receiver');
        const receiverFontJson = JSON.parse(JSON.stringify(beforeSnapshot));
        sender.initFromJson(JSON.parse(JSON.stringify(beforeSnapshot)));
        receiver._fontJson = receiverFontJson;
        receiver.applyDocumentSetState(sender.encodeDocumentSet());

        const packets = [];
        sender.onLocalUpdate(
            (nextUpdate, _message, nextEntries, documentId) => {
                packets.push({
                    update: nextUpdate,
                    entries: nextEntries,
                    documentId
                });
            }
        );
        const currentFont = {
            babelfontJson: '',
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = JSON.stringify(afterSnapshot);
            })
        };

        commitPythonExecutionSyntheticChanges(
            currentFont,
            {
                transactionStarted: true,
                beforeFontDataJson: JSON.stringify(beforeSnapshot),
                label: 'Python collection change'
            },
            sender
        );

        expect(sender.getYValue(['glyphs', 'C'])).toBeInstanceOf(Y.Map);
        expect(sender.getYValue(['glyphs', 'A'])).toBeUndefined();
        expect(withoutGlyphIds(sender.getFontJsonSnapshot())).toEqual(
            expect.objectContaining(afterSnapshot)
        );

        for (const packet of packets) {
            receiver.applyRemoteUpdate(
                packet.update,
                packet.entries,
                undefined,
                packet.documentId
            );
        }
        expect(withoutGlyphIds(receiverFontJson)).toEqual(
            expect.objectContaining(afterSnapshot)
        );

        sender.undo();
        expect(withoutGlyphIds(sender.getFontJsonSnapshot())).toEqual(
            withoutGlyphIds(beforeSnapshot)
        );

        sender.redo();
        expect(withoutGlyphIds(sender.getFontJsonSnapshot())).toEqual(
            expect.objectContaining(afterSnapshot)
        );

        sender.destroy();
        receiver.destroy();
    });
});
