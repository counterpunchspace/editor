const {
    createChangeLogEntriesFromCollaborationMessageEnvelope,
    createCollaborationMessageEnvelopeFromChangeLogEntries,
    createCollaborationMessageEnvelopesFromChangeLogEntries,
    createCollaborationMessageEnvelope,
    collaborationWireReplayValue,
    isCollaborationMessageEnvelope,
    createNamedChangePairFromEntry,
    createNamedChangePairFromJsonPatchPair,
    createSyntheticChangeOperationsFromNamedChangePairs
} = require('../js/collaboration-message.ts');
const { createLogEntry } = require('../js/change-log');

describe('collaboration-message scaffold', () => {
    test('createCollaborationMessageEnvelope normalizes optional top-level fields and clones arrays', () => {
        const metadata = {
            editType: 'outline',
            changedGlyphNames: ['A'],
            changedLayerIds: ['L0'],
            workerReplayTargets: [{ glyphName: 'A', layerId: 'L0' }],
            transactionDurationMs: 42.5,
            historyItemId: 'history-1',
            historyAction: 'change',
            undoScope: 'layer'
        };

        const envelope = createCollaborationMessageEnvelope({
            transactionId: 'tx-1',
            localSequence: 7,
            roomSequence: null,
            baseRevision: 'rev-1',
            changes: [
                {
                    op: 'set',
                    path: 'glyphs.A:name'
                }
            ],
            metadata,
            source: 'unit-test',
            label: 'Rename glyph',
            summary: 'Rename glyph',
            windowId: 'window-1',
            timestamp: 1234
        });

        expect(envelope.schemaVersion).toBe(1);
        expect(envelope.metadata).not.toBe(metadata);
        expect(envelope.metadata.changedGlyphNames).toEqual(['A']);
        expect(envelope.metadata.transactionDurationMs).toBe(42.5);
        expect(envelope.changes).toEqual([
            expect.objectContaining({
                op: 'set',
                path: 'glyphs.A:name'
            })
        ]);
        expect(envelope.metadata.workerReplayTargets).toEqual([
            { glyphName: 'A', layerId: 'L0' }
        ]);

        metadata.changedGlyphNames.push('B');

        expect(envelope.metadata.changedGlyphNames).toEqual(['A']);
    });

    test('isCollaborationMessageEnvelope accepts the scaffold shape and rejects malformed values', () => {
        const validEnvelope = createCollaborationMessageEnvelope({
            transactionId: 'tx-2',
            localSequence: 1,
            roomSequence: 3,
            baseRevision: null,
            changes: [],
            metadata: {
                editType: 'font',
                changedGlyphNames: [],
                changedLayerIds: [],
                workerReplayTargets: [],
                transactionDurationMs: null,
                historyItemId: 'history-1',
                historyAction: 'change',
                undoScope: 'font'
            },
            source: 'bootstrap',
            label: null,
            summary: 'Bootstrap',
            windowId: null,
            timestamp: Date.now()
        });

        expect(isCollaborationMessageEnvelope(validEnvelope)).toBe(true);
        expect(
            isCollaborationMessageEnvelope({
                schemaVersion: 1,
                transactionId: 'tx-bad'
            })
        ).toBe(false);
        expect(isCollaborationMessageEnvelope(null)).toBe(false);
        expect(isCollaborationMessageEnvelope([])).toBe(false);
    });

    test('round-tripping through a collaboration message preserves undo metadata and sender attribution', () => {
        const entries = [
            createLogEntry({
                timestamp: 123,
                windowId: 'sender-window',
                windowRoleLabel: 'linked-2',
                historyItemId: 'history-undo-1',
                promptGroupId: 'assistant-prompt-1',
                historyAction: 'undo',
                targetHistoryItemId: 'history-change-1',
                transactionLabel: 'Undo',
                transactionId: 44,
                transactionDurationMs: 18.25,
                op: 'set',
                undoScope: 'glyph',
                path: 'glyphs.A:name',
                oldValue: 'A.alt',
                newValue: 'A',
                historyTargetType: 'feature',
                historyTargetKey: 'liga',
                historyTargetLabel: 'liga',
                workerReplayTargets: [{ glyphName: 'A', layerId: 'layer-1' }],
                editSource: 'mouse-drag-sidebearing',
                compileChangeSource: 'keyboard-sidebearing',
                compileEditType: null
            })
        ];

        const envelope = createCollaborationMessageEnvelopeFromChangeLogEntries(
            entries,
            {
                localSequence: 1,
                source: 'unit-test',
                windowId: 'sender-window'
            }
        );
        const roundTripped =
            createChangeLogEntriesFromCollaborationMessageEnvelope(envelope, {
                windowRoleLabel: 'receiver-window'
            });

        expect(roundTripped).toHaveLength(1);
        expect(roundTripped[0]).toEqual(
            expect.objectContaining({
                windowId: 'sender-window',
                windowRoleLabel: 'linked-2',
                historyItemId: 'sender-window:history-undo-1',
                promptGroupId: 'assistant-prompt-1',
                historyAction: 'undo',
                targetHistoryItemId: 'sender-window:history-change-1',
                transactionLabel: 'Undo',
                transactionId: 44,
                transactionDurationMs: 18.25,
                undoScope: 'glyph',
                path: 'glyphs.A:name',
                editSource: 'mouse-drag-sidebearing',
                compileChangeSource: 'keyboard-sidebearing',
                compileEditType: null,
                historyTargetType: 'feature',
                historyTargetKey: 'liga',
                historyTargetLabel: 'liga'
            })
        );
    });

    test('keeps prompt grouping separate from native history identities', () => {
        const entries = [
            createLogEntry({
                timestamp: 123,
                windowId: 'sender-window',
                windowRoleLabel: 'main',
                historyItemId: 'python-call-1',
                promptGroupId: 'assistant-prompt-1',
                transactionLabel: 'Python script',
                transactionId: 1,
                op: 'set',
                undoScope: 'glyph',
                path: 'glyphs.A:name',
                oldValue: 'A',
                newValue: 'A.alt'
            }),
            createLogEntry({
                timestamp: 124,
                windowId: 'sender-window',
                windowRoleLabel: 'main',
                historyItemId: 'python-call-2',
                promptGroupId: 'assistant-prompt-1',
                transactionLabel: 'Python script',
                transactionId: 2,
                op: 'set',
                undoScope: 'glyph',
                path: 'glyphs.A:exported',
                oldValue: false,
                newValue: true
            })
        ];

        const envelopes =
            createCollaborationMessageEnvelopesFromChangeLogEntries(entries, {
                startingLocalSequence: 1,
                source: 'unit-test',
                windowId: 'sender-window'
            });

        expect(envelopes).toHaveLength(2);
        expect(
            envelopes.map((envelope) => envelope.metadata.historyItemId)
        ).toEqual(['python-call-1', 'python-call-2']);
        expect(
            envelopes.map((envelope) => envelope.metadata.promptGroupId)
        ).toEqual(['assistant-prompt-1', 'assistant-prompt-1']);
    });

    test('omits redundant per-change replay targets when packet metadata already matches', () => {
        const entries = [
            createLogEntry({
                timestamp: 123,
                windowId: 'sender-window',
                windowRoleLabel: 'main',
                historyItemId: 'history-1',
                transactionLabel: 'Drag anchor',
                transactionId: 55,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A:layers.layer-1:anchors.0.x',
                oldValue: 100,
                newValue: 120,
                workerReplayTargets: [
                    { glyphName: 'A', layerId: 'layer-1' },
                    { glyphName: 'adieresis', layerId: 'layer-1' }
                ]
            }),
            createLogEntry({
                timestamp: 123,
                windowId: 'sender-window',
                windowRoleLabel: 'main',
                historyItemId: 'history-1',
                transactionLabel: 'Drag anchor',
                transactionId: 55,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A:layers.layer-1:anchors.0.y',
                oldValue: 200,
                newValue: 240,
                workerReplayTargets: [
                    { glyphName: 'A', layerId: 'layer-1' },
                    { glyphName: 'adieresis', layerId: 'layer-1' }
                ]
            })
        ];

        const envelope = createCollaborationMessageEnvelopeFromChangeLogEntries(
            entries,
            {
                localSequence: 1,
                source: 'unit-test',
                windowId: 'sender-window'
            }
        );

        expect(envelope.metadata.workerReplayTargets).toEqual([
            { glyphName: 'A', layerId: 'layer-1' },
            { glyphName: 'adieresis', layerId: 'layer-1' }
        ]);
        expect(envelope.changes).toEqual([
            expect.objectContaining({
                path: 'glyphs.A:layers.layer-1:anchors.0.x',
                workerReplayTargets: undefined
            }),
            expect.objectContaining({
                path: 'glyphs.A:layers.layer-1:anchors.0.y',
                workerReplayTargets: undefined
            })
        ]);

        const roundTripped =
            createChangeLogEntriesFromCollaborationMessageEnvelope(envelope, {
                windowRoleLabel: 'receiver-window'
            });

        roundTripped.forEach((entry) => {
            expect(entry.workerReplayTargets).toEqual([
                { glyphName: 'A', layerId: 'layer-1' },
                { glyphName: 'adieresis', layerId: 'layer-1' }
            ]);
        });
    });

    test('createNamedChangePairFromJsonPatchPair maps dotted glyph names and layer ids', () => {
        const pair = createNamedChangePairFromJsonPatchPair(
            {
                op: 'replace',
                path: '/glyphs/1/layers/0/width',
                value: 720
            },
            {
                op: 'replace',
                path: '/glyphs/1/layers/0/width',
                value: 600
            },
            {
                forwardSnapshot: {
                    glyphs: [
                        { name: 'A', layers: [{ id: 'layer-1', width: 600 }] },
                        {
                            name: 'A.alt',
                            layers: [{ id: 'layer.regular.v1', width: 720 }]
                        }
                    ]
                },
                inverseSnapshot: {
                    glyphs: [
                        { name: 'A', layers: [{ id: 'layer-1', width: 600 }] },
                        {
                            name: 'A.alt',
                            layers: [{ id: 'layer.regular.v1', width: 600 }]
                        }
                    ]
                }
            }
        );

        expect(pair).toEqual(
            expect.objectContaining({
                forward: expect.objectContaining({
                    op: 'replace',
                    path: 'glyphs.A.alt:layers.layer.regular.v1:width',
                    value: 720
                }),
                inverse: expect.objectContaining({
                    op: 'replace',
                    path: 'glyphs.A.alt:layers.layer.regular.v1:width',
                    value: 600
                })
            })
        );
    });

    test('createNamedChangePairFromEntry prefers replay payloads for authoritative introspection values', () => {
        const pair = createNamedChangePairFromEntry(
            createLogEntry({
                timestamp: 123,
                windowId: 'sender-window',
                windowRoleLabel: 'main',
                historyItemId: 'history-layer-delta-1',
                transactionLabel: 'Drag point',
                transactionId: 77,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.o:layers.layer-1',
                oldValue: 'o',
                newValue: 'Drag point',
                replayOldValue: {
                    id: 'layer-1',
                    shapes: [{ nodes: '100 100 l 400 100 l' }]
                },
                replayNewValue: {
                    id: 'layer-1',
                    shapes: [{ nodes: '110 100 l 400 100 l' }]
                },
                workerReplayTargets: [{ glyphName: 'o', layerId: 'layer-1' }]
            })
        );

        expect(pair).toEqual(
            expect.objectContaining({
                forward: expect.objectContaining({
                    op: 'replace',
                    path: 'glyphs.o:layers.layer-1',
                    value: {
                        id: 'layer-1',
                        shapes: [{ nodes: '110 100 l 400 100 l' }]
                    }
                }),
                inverse: expect.objectContaining({
                    op: 'replace',
                    path: 'glyphs.o:layers.layer-1',
                    value: {
                        id: 'layer-1',
                        shapes: [{ nodes: '100 100 l 400 100 l' }]
                    }
                })
            })
        );
    });

    test('createSyntheticChangeOperationsFromNamedChangePairs reconstructs change operations', () => {
        const operations = createSyntheticChangeOperationsFromNamedChangePairs([
            {
                forward: {
                    op: 'replace',
                    path: 'glyphs.A:layers.layer-1:width',
                    value: 700
                },
                inverse: {
                    op: 'replace',
                    path: 'glyphs.A:layers.layer-1:width',
                    value: 600
                },
                workerReplayTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            }
        ]);

        expect(operations).toEqual([
            expect.objectContaining({
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
                oldValue: 600,
                newValue: 700,
                workerReplayTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            })
        ]);
    });

    test('splits change-log tails into one collaboration message per logical history item', () => {
        const entries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'sender-window',
                windowRoleLabel: 'main',
                historyItemId: 'history-1',
                transactionLabel: 'Resize',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A:layers.layer-1.width',
                oldValue: 600,
                newValue: 700,
                workerReplayTargets: []
            }),
            createLogEntry({
                timestamp: 2,
                windowId: 'sender-window',
                windowRoleLabel: 'main',
                historyItemId: 'history-2',
                historyAction: 'undo',
                targetHistoryItemId: 'history-1',
                transactionLabel: 'Undo',
                transactionId: 2,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A:layers.layer-1.width',
                oldValue: 700,
                newValue: 600,
                workerReplayTargets: []
            })
        ];

        const envelopes =
            createCollaborationMessageEnvelopesFromChangeLogEntries(entries, {
                startingLocalSequence: 10,
                source: 'unit-test',
                windowId: 'sender-window'
            });

        expect(envelopes).toHaveLength(2);
        expect(envelopes[0].metadata.historyItemId).toBe('history-1');
        expect(envelopes[1].metadata.historyAction).toBe('undo');
        expect(envelopes[1].metadata.targetHistoryItemId).toBe('history-1');
        expect(envelopes[0].localSequence).toBe(10);
        expect(envelopes[1].localSequence).toBe(11);
    });

    test('does not invent a layer origin for font-scoped packets with layer paths', () => {
        const entries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'main',
                windowRoleLabel: 'main',
                historyItemId: 'history-add-master',
                transactionLabel: 'Add master',
                transactionId: 1,
                op: 'set',
                undoScope: 'font',
                path: 'axes',
                oldValue: [],
                newValue: []
            }),
            createLogEntry({
                timestamp: 1,
                windowId: 'main',
                windowRoleLabel: 'main',
                historyItemId: 'history-add-master',
                transactionLabel: 'Add master',
                transactionId: 1,
                op: 'set',
                undoScope: 'font',
                path: 'masters',
                oldValue: [],
                newValue: []
            }),
            createLogEntry({
                timestamp: 1,
                windowId: 'main',
                windowRoleLabel: 'main',
                historyItemId: 'history-add-master',
                transactionLabel: 'Add master',
                transactionId: 1,
                op: 'set',
                undoScope: 'font',
                path: 'glyphs.u:layers.master-4:',
                oldValue: undefined,
                newValue: { id: 'master-4' }
            })
        ];

        const envelope = createCollaborationMessageEnvelopeFromChangeLogEntries(
            entries,
            {
                localSequence: 1,
                source: 'unit-test',
                windowId: 'main'
            }
        );

        expect(envelope.label).toBe('Add master');
        expect(envelope.summary).toBe('Add master');
        expect(envelope.metadata.undoScope).toBe('font');
        expect(envelope.metadata.originatingGlyphName).toBeNull();
        expect(envelope.metadata.originatingLayerId).toBeNull();
    });

    test('collaboration envelopes keep primitive replay values and omit Yjs snapshots', () => {
        expect(collaborationWireReplayValue(240)).toBe(240);
        expect(collaborationWireReplayValue('Delete layer sync')).toBe(
            'Delete layer sync'
        );
        expect(
            collaborationWireReplayValue({
                name: 'A',
                layers: [{ id: 'layer-1', shapes: [] }]
            })
        ).toBeUndefined();

        const envelope = createCollaborationMessageEnvelopeFromChangeLogEntries(
            [
                createLogEntry({
                    timestamp: 1,
                    windowId: 'main',
                    windowRoleLabel: 'main',
                    historyItemId: 'history-delete-layer',
                    transactionLabel: 'Delete layer sync',
                    transactionId: 9,
                    op: 'set',
                    undoScope: 'glyph',
                    path: 'glyphs.A:',
                    oldValue: 'A',
                    newValue: 'Delete layer sync',
                    replayOldValue: {
                        name: 'A',
                        layers: [
                            { id: 'keep', shapes: [{ nodes: '0 0 l 1 1 l' }] },
                            { id: 'drop', shapes: [{ nodes: '2 2 l 3 3 l' }] }
                        ]
                    },
                    replayNewValue: {
                        name: 'A',
                        layers: [
                            { id: 'keep', shapes: [{ nodes: '0 0 l 1 1 l' }] }
                        ]
                    },
                    workerReplayTargets: [{ glyphName: 'A', layerId: 'keep' }]
                })
            ],
            {
                localSequence: 1,
                source: 'unit-test',
                windowId: 'main'
            }
        );

        expect(envelope.changes[0].replayOldValue).toBeUndefined();
        expect(envelope.changes[0].replayNewValue).toBeUndefined();
        expect(envelope.changes[0].path).toBe('glyphs.A:');
        expect(JSON.stringify(envelope).length).toBeLessThan(65536);
    });
});
