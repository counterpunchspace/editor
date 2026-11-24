/**
 * Edits never go missing between the editor's model and the documents.
 *
 * - A drawing-snapshot sync that wrote nothing sends no packet: compile and
 *   caches hear of its replay targets locally, never as a font-core packet.
 * - A drawing edit to a glyph whose document is not loaded throws instead
 *   of being skipped.
 * - A font-core packet is never described as a glyph drawing edit, and a
 *   packet with no entries of its own is described as its whole document.
 * - Whenever the engine replaces model glyph data with the documents'
 *   state, listeners hear of it first (so an editor can commit an edit it
 *   still holds) and after, and the collab trace records it.
 * - A refused undo is announced to engine listeners, not only to `window`.
 */

const { PatchSyncEngine } = require('../js/patch-sync-engine');

function drawing(id, width = 500) {
    return {
        id,
        master: { type: 'DefaultForMaster', master: 'M1' },
        width,
        shapes: [],
        anchors: []
    };
}

function makeFont() {
    const glyph = (name, layers) => ({
        name,
        id: `id-${name}`,
        production_name: null,
        category: 'Base',
        codepoints: [],
        exported: true,
        layers
    });
    return {
        upm: 1000,
        version: [1, 0],
        names: { familyName: 'Guards' },
        axes: [],
        masters: [{ id: 'M1', name: 'Regular', location: {} }],
        glyphs: [glyph('A', [drawing('LA')]), glyph('D', [drawing('LD')])]
    };
}

function syncWidth(engine, font, glyphIndex, width) {
    const glyph = font.glyphs[glyphIndex];
    glyph.layers[0].width = width;
    engine.syncDrawingSnapshotsFromJson(
        [
            {
                glyphName: glyph.name,
                layerId: glyph.layers[0].id,
                drawingJson: JSON.parse(JSON.stringify(glyph.layers[0]))
            }
        ],
        'Arrow key',
        undefined,
        undefined,
        null,
        [{ glyphName: glyph.name, layerId: glyph.layers[0].id }],
        'keyboard',
        'keyboard',
        'outline'
    );
}

function pair(label) {
    const senderFont = makeFont();
    const receiverFont = JSON.parse(JSON.stringify(senderFont));
    const sender = new PatchSyncEngine(`sender-${label}`);
    const receiver = new PatchSyncEngine(`receiver-${label}`);
    sender.initFromJson(senderFont);
    receiver.setFontJson(receiverFont);
    receiver.applyDocumentSetState(sender.encodeDocumentSet());
    return { sender, receiver, senderFont, receiverFont };
}

function capturePackets(engine) {
    const packets = [];
    engine.onLocalUpdate((update, message, entries, documentId) => {
        packets.push({ update, message, entries, documentId });
    });
    return packets;
}

let previousTrace;
beforeEach(() => {
    previousTrace = window.__collabTrace;
    window.__collabTrace = { enabled: true, entries: [], sequence: 0 };
});
afterEach(() => {
    window.__collabTrace = previousTrace;
});

const traced = (kind) =>
    window.__collabTrace.entries.filter((entry) => entry.kind === kind);

describe('a drawing-snapshot sync that wrote nothing', () => {
    test('sends no packet, leaves the font-core outbox alone and notifies only this window', () => {
        const engine = new PatchSyncEngine('noop-sync');
        const font = makeFont();
        engine.initFromJson(font);
        const packets = capturePackets(engine);
        const committed = [];
        engine.onCommittedChange((entries, context) =>
            committed.push({ entries, context })
        );
        // Font-core writes still waiting for their packet.
        engine._outbox.set('font-core', [new Uint8Array([1, 2, 3])]);

        // The drawing already matches its document.
        syncWidth(engine, font, 0, 500);

        expect(packets).toEqual([]);
        expect(engine._outbox.get('font-core')).toEqual([
            new Uint8Array([1, 2, 3])
        ]);
        expect(committed).toHaveLength(1);
        expect(committed[0].context).toEqual(
            expect.objectContaining({
                origin: 'local',
                localOnly: true,
                documentId: engine.documentIdForPath(['glyphs', 'A'])
            })
        );
        expect(committed[0].context.documentId).not.toBe('font-core');
        expect(traced('model-glyph-rebuilt')).toEqual([]);
        engine._outbox.delete('font-core');
        engine.destroy();
    });

    test('an edit that writes sends exactly one packet, on its glyph’s document', () => {
        const engine = new PatchSyncEngine('real-sync');
        const font = makeFont();
        engine.initFromJson(font);
        const packets = capturePackets(engine);
        const rebuilt = [];
        engine.onGlyphModelRebuilt((event) => rebuilt.push(event));

        syncWidth(engine, font, 0, 640);

        expect(packets.map((packet) => packet.documentId)).toEqual([
            engine.documentIdForPath(['glyphs', 'A'])
        ]);
        expect(engine.getYValue(['glyphs', 'A', 'layers', 'LA', 'width'])).toBe(
            640
        );
        // Reading back its own write is not a rebuild.
        expect(rebuilt).toEqual([]);
        engine.destroy();
    });
});

describe('a drawing edit to a glyph whose document is not loaded', () => {
    test('throws before anything is recorded or sent', () => {
        const engine = new PatchSyncEngine('missing-glyph-doc');
        const font = makeFont();
        engine.initFromJson(font);
        const glyphId = engine._glyphIdByName.get('A');
        engine._glyphDocs.get(glyphId).destroy();
        engine._glyphDocs.delete(glyphId);
        const packets = capturePackets(engine);
        const committed = [];
        engine.onCommittedChange((entries) => committed.push(entries));
        const logLength = engine.getChangeLog().length;

        expect(() => syncWidth(engine, font, 0, 650)).toThrow(
            /glyph’s document is not loaded/
        );
        expect(packets).toEqual([]);
        expect(committed).toEqual([]);
        expect(engine.getChangeLog()).toHaveLength(logLength);
        engine.destroy();
    });
});

describe('packet descriptions', () => {
    test('a font-core packet described as a glyph drawing edit is refused and its update stays queued', () => {
        const engine = new PatchSyncEngine('font-core-guard');
        engine.initFromJson(makeFont());
        const packets = capturePackets(engine);
        const update = new Uint8Array([7, 7, 7]);
        const entry = engine._wholeDocumentEntry('font-core', 'Arrow key');
        expect(() =>
            engine._emitLocalUpdate(
                update,
                [{ ...entry, path: 'glyphs.A:layers.LA', undoScope: 'layer' }],
                'font-core'
            )
        ).toThrow(/font-core packet described as the glyph drawing edit/);
        expect(packets).toEqual([]);
        expect(engine._outbox.get('font-core')).toEqual([update]);
        engine._outbox.delete('font-core');
        engine.destroy();
    });

    test('a packet whose document has no entries of its own is described whole, not by another document’s paths', () => {
        const engine = new PatchSyncEngine('split-entries');
        engine.initFromJson(makeFont());
        const glyphA = engine.documentIdForPath(['glyphs', 'A']);
        const base = engine._wholeDocumentEntry(glyphA, 'Edit');
        const entries = [
            { ...base, path: 'glyphs.A:layers.LA.width', undoScope: 'layer' },
            // Glyph D sent no packet: it did not change.
            { ...base, path: 'glyphs.D:layers.LD.width', undoScope: 'layer' }
        ];
        const split = engine._splitCommitEntriesByPacket(entries, [
            'font-core',
            glyphA
        ]);
        expect(split.get(glyphA).map((entry) => entry.path)).toEqual([
            'glyphs.A:layers.LA.width'
        ]);
        expect(split.get('font-core').map((entry) => entry.path)).toEqual([
            'font'
        ]);
        engine.destroy();
    });
});

describe('model glyph rebuilds', () => {
    test('a remote update tells listeners before and after it replaces the glyph, and is traced', () => {
        const { sender, receiver, senderFont, receiverFont } = pair('remote');
        const senderPackets = capturePackets(sender);
        syncWidth(sender, senderFont, 0, 710);
        const packet = senderPackets[0];
        const order = [];
        receiver.onBeforeGlyphModelRebuild((event) => {
            order.push([
                'before',
                event.cause,
                event.glyphs,
                receiverFont.glyphs[0].layers[0].width
            ]);
        });
        receiver.onGlyphModelRebuilt((event) => {
            order.push([
                'after',
                event.cause,
                event.glyphs,
                receiverFont.glyphs[0].layers[0].width
            ]);
        });
        // The pair's setup (a snapshot load) is traced too.
        expect(traced('model-glyph-rebuilt')).toEqual([
            expect.objectContaining({
                detail: { glyphs: 'all', cause: 'snapshot' }
            })
        ]);
        window.__collabTrace.entries = [];

        receiver.applyRemoteUpdate(
            packet.update,
            undefined,
            [packet.message],
            packet.documentId,
            { captureInUndo: false }
        );

        expect(order).toEqual([
            ['before', 'remote-update', ['A'], 500],
            ['after', 'remote-update', ['A'], 710]
        ]);
        expect(traced('model-glyph-rebuilt')).toEqual([
            expect.objectContaining({
                glyphs: ['A'],
                detail: { glyphs: ['A'], cause: 'remote-update' }
            })
        ]);
        sender.destroy();
        receiver.destroy();
    });

    test('an edit committed in the before-rebuild listener is sent before the remote state replaces the model', () => {
        const { sender, receiver, senderFont, receiverFont } = pair('flush');
        const senderPackets = capturePackets(sender);
        syncWidth(sender, senderFont, 0, 720);
        const packet = senderPackets[0];
        const receiverPackets = capturePackets(receiver);
        let flushed = false;
        receiver.onBeforeGlyphModelRebuild(() => {
            if (flushed) {
                return;
            }
            flushed = true;
            // The editor's pending keyboard edit on glyph D.
            syncWidth(receiver, receiverFont, 1, 333);
        });

        receiver.applyRemoteUpdate(
            packet.update,
            undefined,
            [packet.message],
            packet.documentId,
            { captureInUndo: false }
        );

        expect(receiverPackets.map((item) => item.documentId)).toEqual([
            receiver.documentIdForPath(['glyphs', 'D'])
        ]);
        expect(
            receiver.getYValue(['glyphs', 'D', 'layers', 'LD', 'width'])
        ).toBe(333);
        expect(receiverFont.glyphs[0].layers[0].width).toBe(720);
        sender.destroy();
        receiver.destroy();
    });

    test('a listener that throws stops the rebuild before the documents change', () => {
        const { sender, receiver, senderFont, receiverFont } = pair('throw');
        const senderPackets = capturePackets(sender);
        syncWidth(sender, senderFont, 0, 730);
        const packet = senderPackets[0];
        receiver.onBeforeGlyphModelRebuild(() => {
            throw new Error('could not commit the pending edit');
        });

        expect(() =>
            receiver.applyRemoteUpdate(
                packet.update,
                undefined,
                [packet.message],
                packet.documentId,
                { captureInUndo: false }
            )
        ).toThrow(/could not commit the pending edit/);
        expect(
            receiver.getYValue(['glyphs', 'A', 'layers', 'LA', 'width'])
        ).toBe(500);
        expect(receiverFont.glyphs[0].layers[0].width).toBe(500);
        sender.destroy();
        receiver.destroy();
    });

    test('a catch-up that brings a collaborator’s edit is reported as one', () => {
        const { sender, receiver, senderFont } = pair('catch-up');
        const documentId = sender.documentIdForPath(['glyphs', 'A']);
        const vector = receiver.encodeDocumentStateVector(documentId);
        syncWidth(sender, senderFont, 0, 740);
        const delta = sender.encodeDocumentState(documentId, vector);
        const rebuilt = [];
        receiver.onGlyphModelRebuilt((event) => rebuilt.push(event));

        receiver.applyDocumentCatchUp(documentId, delta);

        expect(rebuilt).toEqual([{ glyphs: ['A'], cause: 'catch-up' }]);
        sender.destroy();
        receiver.destroy();
    });
});

describe('a pending edit when its glyph is re-read (fuzz O2: socket close 4000, then a lost arrow nudge)', () => {
    // The editor holds the drawing object it is nudging and commits it
    // later (a debounced keyboard preview). Re-reading the glyph from its
    // document in between replaces that object.
    function commitDrawing(engine, glyphName, drawingObject) {
        engine.syncDrawingSnapshotsFromJson(
            [
                {
                    glyphName,
                    layerId: drawingObject.id,
                    drawingJson: JSON.parse(JSON.stringify(drawingObject))
                }
            ],
            'Arrow key',
            undefined,
            undefined,
            null,
            [{ glyphName, layerId: drawingObject.id }],
            'keyboard',
            'keyboard',
            'outline'
        );
    }
    // Font-deps is derived data the checkpoint may refresh; every other
    // packet is an edit's.
    const editPackets = (packets) =>
        packets.filter((packet) => packet.documentId !== 'font-deps');
    const modelDrawing = (font, glyphName) =>
        font.glyphs.find((glyph) => glyph.name === glyphName).layers[0];

    test('the editor commits its pending nudge before the re-read: one packet on the glyph’s document, none on font-core', () => {
        const { sender, receiver, receiverFont } = pair('pending-nudge');
        const documentId = receiver.documentIdForPath(['glyphs', 'A']);
        const state = sender.encodeDocumentState(documentId);
        const packets = capturePackets(receiver);
        const captured = modelDrawing(receiverFont, 'A');
        captured.width = 910; // the nudge, not yet committed
        let pending = true;
        const events = [];
        receiver.onBeforeGlyphModelRebuild((event) => {
            events.push(['before', event.cause, event.glyphs]);
            if (
                pending &&
                (event.glyphs === null || event.glyphs.includes('A'))
            ) {
                pending = false;
                commitDrawing(receiver, 'A', captured);
            }
        });
        receiver.onGlyphModelRebuilt((event) =>
            events.push(['after', event.cause, event.glyphs])
        );

        receiver.applyDocumentCheckpoint(documentId, state);

        expect(pending).toBe(false);
        expect(editPackets(packets).map((packet) => packet.documentId)).toEqual(
            [documentId]
        );
        expect(
            editPackets(packets)[0].entries.map((entry) => entry.path)
        ).toEqual(
            expect.arrayContaining([
                expect.stringMatching(/^glyphs\.A:layers\.LA/)
            ])
        );
        expect(
            receiver.getYValue(['glyphs', 'A', 'layers', 'LA', 'width'])
        ).toBe(910);
        // The model the editor reads now holds the nudge too.
        expect(modelDrawing(receiverFont, 'A').width).toBe(910);
        expect(events[0]).toEqual(['before', 'checkpoint', ['A']]);
        expect(events[events.length - 1]).toEqual([
            'after',
            'checkpoint',
            ['A']
        ]);
        sender.destroy();
        receiver.destroy();
    });

    test('without a flush the re-read is reported, and the stale commit sends nothing anywhere', () => {
        const { sender, receiver, receiverFont } = pair('stale-nudge');
        const documentId = receiver.documentIdForPath(['glyphs', 'A']);
        const state = sender.encodeDocumentState(documentId);
        const packets = capturePackets(receiver);
        const committed = [];
        receiver.onCommittedChange((entries, context) =>
            committed.push(context)
        );
        const rebuilt = [];
        receiver.onGlyphModelRebuilt((event) => rebuilt.push(event));
        const captured = modelDrawing(receiverFont, 'A');
        captured.width = 920;
        window.__collabTrace.entries = [];

        receiver.applyDocumentCheckpoint(documentId, state);
        // Font-core writes still waiting for their packet.
        receiver._outbox.set('font-core', [new Uint8Array([4, 4])]);
        committed.length = 0;
        // The re-read put the document’s drawing back: the nudge is gone
        // from the model (the font model wraps a fresh object over it).
        expect(modelDrawing(receiverFont, 'A').width).toBe(500);
        const packetsBeforeCommit = editPackets(packets).length;
        // The editor serializes what the model holds now: unmoved.
        commitDrawing(receiver, 'A', modelDrawing(receiverFont, 'A'));

        expect(rebuilt).toEqual([{ glyphs: ['A'], cause: 'checkpoint' }]);
        expect(traced('model-glyph-rebuilt')).toEqual([
            expect.objectContaining({
                detail: { glyphs: ['A'], cause: 'checkpoint' }
            })
        ]);
        // No packet at all: neither an empty font-core one labelled with
        // the glyph’s paths, nor one that drains font-core’s outbox.
        expect(packetsBeforeCommit).toBe(0);
        expect(editPackets(packets)).toEqual([]);
        expect(receiver._outbox.get('font-core')).toEqual([
            new Uint8Array([4, 4])
        ]);
        expect(committed).toEqual([
            expect.objectContaining({ documentId, localOnly: true })
        ]);
        receiver._outbox.delete('font-core');
        sender.destroy();
        receiver.destroy();
    });

    test('a remote rename re-reads every glyph, so the before-listener is told any glyph may change', () => {
        const engine = new PatchSyncEngine('rename-hint');
        engine.initFromJson(makeFont());
        const base = engine._wholeDocumentEntry('font-core', 'Rename');
        expect(
            engine._glyphNamesForRebuildHint(
                engine.documentIdForPath(['glyphs', 'A']),
                [
                    {
                        ...base,
                        path: 'glyphs.A:name',
                        glyphRenames: [{ oldName: 'A', newName: 'B' }]
                    }
                ]
            )
        ).toBeNull();
        expect(
            engine._glyphNamesForRebuildHint('font-core', [
                { ...base, path: 'glyphOrder' }
            ])
        ).toBeNull();
        expect(
            engine._glyphNamesForRebuildHint(undefined, [
                { ...base, path: 'glyphs.D:layers.LD.width' }
            ])
        ).toEqual(['D']);
        engine.destroy();
    });

    test('a listener error after a failed rebuild does not hide the rebuild’s own error', () => {
        const engine = new PatchSyncEngine('rebuild-error');
        engine.initFromJson(makeFont());
        engine.onGlyphModelRebuilt(() => {
            throw new Error('listener failed');
        });
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect(() =>
                engine._withGlyphModelRebuild('read-back', null, () => {
                    engine._noteGlyphModelRebuilt(['A']);
                    throw new Error('rebuild failed');
                })
            ).toThrow('rebuild failed');
            expect(spy).toHaveBeenCalled();
            // A successful rebuild still surfaces the listener's error.
            expect(() =>
                engine._withGlyphModelRebuild('read-back', null, () =>
                    engine._noteGlyphModelRebuilt(['A'])
                )
            ).toThrow('listener failed');
        } finally {
            spy.mockRestore();
            engine.destroy();
        }
    });
});

describe('history replay problems', () => {
    test('a refused undo reaches engine listeners as well as window', () => {
        const engine = new PatchSyncEngine('history-problem');
        const font = makeFont();
        engine.initFromJson(font);
        const previousBridge = window.patchSyncEngine;
        window.patchSyncEngine = engine;
        const onWindow = jest.fn();
        window.addEventListener('history-replay-blocked', onWindow);
        const problems = [];
        engine.onHistoryReplayProblem((problem) => problems.push(problem));
        try {
            engine.beginTransaction('Widen', null, {
                compileChangeSource: 'test-sync',
                compileEditType: null
            });
            engine.recordChange(
                ['glyphs', 'A', 'layers', 'LA'],
                'width',
                500,
                600
            );
            engine.endTransaction();
            const glyphId = engine._glyphIdByName.get('A');
            engine._glyphDocs.get(glyphId).destroy();
            engine._glyphDocs.delete(glyphId);

            expect(engine.undo()).toBeNull();

            expect(problems).toEqual([
                expect.objectContaining({
                    kind: 'blocked',
                    reason: 'document-not-loaded',
                    historyAction: 'undo',
                    documentIds: [`glyph:${glyphId}`]
                })
            ]);
            expect(onWindow).toHaveBeenCalledTimes(1);
            expect(onWindow.mock.calls[0][0].detail).toEqual(
                expect.objectContaining({ reason: 'document-not-loaded' })
            );
            expect(onWindow.mock.calls[0][0].detail.kind).toBeUndefined();
        } finally {
            window.removeEventListener('history-replay-blocked', onWindow);
            window.patchSyncEngine = previousBridge;
            engine.destroy();
        }
    });
});
