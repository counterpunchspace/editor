/**
 * Read-only below the UI: once the font is read-only (write access lost),
 * the engine refuses every local write itself, with a user-facing error,
 * while collaborators’ updates keep applying. Separate from the broken mark.
 *
 * And no station link is filled in on a local write: a whole drawing
 * without `master`, or a delta that writes a missing one, is refused; a
 * delta that does not touch `master` keeps merging.
 */

const Y = require('yjs');
const {
    PatchSyncEngine,
    ReadOnlyFontError,
    DrawingInvariantError
} = require('../js/patch-sync-engine');

const READ_ONLY_REASON = 'You no longer have write access to this font.';
const STAMP = { compileChangeSource: 'test-sync', compileEditType: null };

function fontJson() {
    return {
        upm: 1000,
        version: [1, 0],
        note: '',
        date: '2024-01-01',
        names: { familyName: 'TestFont' },
        features: { classes: {}, prefixes: {}, features: [] },
        axes: [
            {
                name: 'Weight',
                tag: 'wght',
                id: 'weight-axis',
                min: 100,
                max: 900,
                default: 400
            }
        ],
        masters: [
            {
                name: 'Regular',
                id: 'master-regular',
                location: { wght: 400 },
                guides: [],
                metrics: {},
                kerning: {}
            }
        ],
        instances: [],
        glyphs: [
            {
                name: 'A',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'layer-1',
                        width: 600,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-regular'
                        },
                        shapes: []
                    }
                ]
            }
        ]
    };
}

const WIDTH_PATH = ['glyphs', 'A', 'layers', 'layer-1', 'width'];

function setWidth(engine, from, to) {
    engine.beginTransaction('Change width', null, STAMP);
    engine.recordChange(WIDTH_PATH.slice(0, -1), 'width', from, to);
    return engine.endTransaction();
}

function engineWithFont(name) {
    const engine = new PatchSyncEngine(name);
    engine.initFromJson(fontJson());
    return engine;
}

describe('a read-only font refuses local writes in the engine', () => {
    test('a commit is refused with a user-facing error and nothing is written or sent', () => {
        const engine = engineWithFont('read-only-commit');
        const sent = [];
        engine.onLocalUpdate((update) => sent.push(update));
        engine.setReadOnly(READ_ONLY_REASON);
        expect(engine.isReadOnly()).toBe(true);

        let error;
        try {
            setWidth(engine, 600, 640);
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(ReadOnlyFontError);
        expect(error.message).toBe(
            'This font is read-only: You no longer have write access to this font. Your edit “Change width” was not made.'
        );
        expect(engine.getYValue(WIDTH_PATH)).toBe(600);
        expect(sent).toEqual([]);
        // Not the broken mark: no document is damaged.
        for (const documentId of engine.layoutDocumentIds()) {
            expect(engine.isDocumentIdBroken(documentId)).toBe(false);
        }
    });

    test('a refused commit ends its transaction: its operations do not ride along with the next one', () => {
        const engine = engineWithFont('read-only-transaction-reset');
        engine.setReadOnly(READ_ONLY_REASON);
        expect(() => setWidth(engine, 600, 640)).toThrow(ReadOnlyFontError);

        engine.setReadOnly(null);
        expect(engine.isReadOnly()).toBe(false);
        engine.beginTransaction('Change name', null, STAMP);
        engine.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'name',
            undefined,
            'Renamed'
        );
        engine.endTransaction();
        expect(engine.getYValue(WIDTH_PATH)).toBe(600);
        expect(
            engine.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'name'])
        ).toBe('Renamed');
    });

    test('a refused commit reads the model back from the documents', () => {
        const engine = engineWithFont('read-only-model-readback');
        engine.setReadOnly(READ_ONLY_REASON);
        // The model has already made the edit when it reaches the engine.
        const layer = engine
            .getFontJsonSnapshot()
            .glyphs.find((glyph) => glyph.name === 'A').layers[0];
        layer.width = 640;
        expect(() => setWidth(engine, 600, 640)).toThrow(ReadOnlyFontError);
        const after = engine
            .getFontJsonSnapshot()
            .glyphs.find((glyph) => glyph.name === 'A').layers[0];
        expect(after.width).toBe(600);
    });

    test('callbacks waiting for a refused commit are dropped, not run after the next one', () => {
        const engine = engineWithFont('read-only-after-commit');
        engine.setReadOnly(READ_ONLY_REASON);
        const ran = [];
        engine.beginTransaction('Change width', null, STAMP);
        engine.recordChange(WIDTH_PATH.slice(0, -1), 'width', 600, 640);
        engine.runAfterOutermostCommit(() => ran.push('refused'));
        expect(() => engine.endTransaction()).toThrow(ReadOnlyFontError);

        engine.setReadOnly(null);
        engine.beginTransaction('Change width', null, STAMP);
        engine.recordChange(WIDTH_PATH.slice(0, -1), 'width', 600, 650);
        engine.runAfterOutermostCommit(() => ran.push('committed'));
        engine.endTransaction();
        expect(ran).toEqual(['committed']);
        expect(engine.getYValue(WIDTH_PATH)).toBe(650);
    });

    test('undo and redo are refused before the history moves', () => {
        const engine = engineWithFont('read-only-undo');
        setWidth(engine, 600, 640);
        expect(engine.getYValue(WIDTH_PATH)).toBe(640);

        engine.setReadOnly(READ_ONLY_REASON);
        expect(() => engine.undo()).toThrow(
            /This font is read-only: .* Your undo was not made\./
        );
        expect(engine.getYValue(WIDTH_PATH)).toBe(640);

        engine.setReadOnly(null);
        expect(engine.undo()).not.toBeNull();
        expect(engine.getYValue(WIDTH_PATH)).toBe(600);
        engine.setReadOnly(READ_ONLY_REASON);
        expect(() => engine.redo()).toThrow(/Your redo was not made\./);
        expect(engine.getYValue(WIDTH_PATH)).toBe(600);
    });

    test('font worker packets are refused', () => {
        const engine = engineWithFont('read-only-worker');
        engine.setReadOnly(READ_ONLY_REASON);
        expect(() =>
            engine.applyLocalGeneratedYjsUpdate(
                new Uint8Array([1, 2, 3]),
                [
                    {
                        op: 'set',
                        path: WIDTH_PATH,
                        oldValue: 600,
                        newValue: 700
                    }
                ],
                'Worker edit'
            )
        ).toThrow(/Your edit “Worker edit” was not made\./);
        expect(engine.getYValue(WIDTH_PATH)).toBe(600);
    });

    test('live preview writes are refused', () => {
        const engine = engineWithFont('read-only-preview');
        engine.setReadOnly(READ_ONLY_REASON);
        expect(() =>
            engine.writeLivePreviewDrawings([
                { glyphName: 'A', layerId: 'layer-1' }
            ])
        ).toThrow(ReadOnlyFontError);
    });

    test('updates from collaborators still apply', () => {
        const sender = engineWithFont('read-only-sender');
        const receiver = new PatchSyncEngine('read-only-receiver');
        receiver.setFontJson(fontJson());
        receiver.applyDocumentSetState(sender.encodeDocumentSet());
        receiver.setReadOnly(READ_ONLY_REASON);

        let update = null;
        sender.onLocalUpdate((next) => {
            update = next;
        });
        setWidth(sender, 600, 655);
        receiver.applyRemoteUpdate(update, sender.getNewChangeLogEntries());
        expect(receiver.getYValue(WIDTH_PATH)).toBe(655);
    });

    test('an edit relayed from a linked window is refused, a collaborator’s still applies', () => {
        const linked = engineWithFont('read-only-linked');
        const main = new PatchSyncEngine('read-only-main');
        main.setFontJson(fontJson());
        main.applyDocumentSetState(linked.encodeDocumentSet());
        main.setReadOnly(READ_ONLY_REASON);
        const committed = [];
        main.onCommittedChange((entries) => committed.push(entries));

        const packets = [];
        linked.onLocalUpdate((update, message, entries, documentId) =>
            packets.push({ update, message, entries, documentId })
        );
        setWidth(linked, 600, 610);
        expect(packets.length).toBeGreaterThan(0);
        for (const packet of packets) {
            let error;
            try {
                main.applyRemoteUpdate(
                    packet.update,
                    packet.entries,
                    packet.message ? [packet.message] : undefined,
                    packet.documentId,
                    { fromLinkedWindow: true }
                );
            } catch (caught) {
                error = caught;
            }
            expect(error).toBeInstanceOf(ReadOnlyFontError);
            expect(error.message).toBe(
                'This font is read-only: You no longer have write access to this font. Your edit in another window was not made.'
            );
            // Refused, not broken: nothing in that document is damaged.
            expect(main.isDocumentIdBroken(packet.documentId)).toBe(false);
        }
        expect(main.getYValue(WIDTH_PATH)).toBe(600);
        expect(committed).toEqual([]);

        // The same packet from a collaborator applies.
        const [first] = packets;
        main.applyRemoteUpdate(
            first.update,
            first.entries,
            first.message ? [first.message] : undefined,
            first.documentId,
            { fromCollaborator: true }
        );
        expect(main.getYValue(WIDTH_PATH)).toBe(610);
    });

    test('a linked window’s edit applies again once the font is writable', () => {
        const linked = engineWithFont('writable-linked');
        const main = new PatchSyncEngine('writable-main');
        main.setFontJson(fontJson());
        main.applyDocumentSetState(linked.encodeDocumentSet());
        main.setReadOnly(READ_ONLY_REASON);
        main.setReadOnly(null);
        const packets = [];
        linked.onLocalUpdate((update, message, entries, documentId) =>
            packets.push({ update, message, entries, documentId })
        );
        setWidth(linked, 600, 620);
        for (const packet of packets) {
            main.applyRemoteUpdate(
                packet.update,
                packet.entries,
                packet.message ? [packet.message] : undefined,
                packet.documentId,
                { fromLinkedWindow: true }
            );
        }
        expect(main.getYValue(WIDTH_PATH)).toBe(620);
    });

    test('a read-only font needs a reason', () => {
        const engine = engineWithFont('read-only-reason');
        expect(() => engine.setReadOnly('')).toThrow(TypeError);
        expect(() => engine.setReadOnly('   ')).toThrow(TypeError);
        expect(engine.isReadOnly()).toBe(false);
    });
});

describe('listeners hear the read-only state change', () => {
    test('each change is told once, after it takes effect; repeating a state tells no one', () => {
        const engine = engineWithFont('read-only-listener');
        const heard = [];
        engine.onReadOnlyChanged((reason) =>
            heard.push({ reason, readOnly: engine.isReadOnly() })
        );
        engine.setReadOnly(READ_ONLY_REASON);
        engine.setReadOnly(READ_ONLY_REASON);
        engine.setReadOnly('Another reason.');
        engine.setReadOnly(null);
        engine.setReadOnly(null);
        expect(heard).toEqual([
            { reason: READ_ONLY_REASON, readOnly: true },
            { reason: 'Another reason.', readOnly: true },
            { reason: null, readOnly: false }
        ]);
    });

    test('a listener that changes the state again leaves no one on the stale state', () => {
        const engine = engineWithFont('read-only-listener-nested');
        const heard = [];
        engine.onReadOnlyChanged((reason) => {
            if (reason !== null) {
                engine.setReadOnly(null);
            }
        });
        engine.onReadOnlyChanged((reason) => heard.push(reason));
        engine.setReadOnly(READ_ONLY_REASON);
        expect(engine.isReadOnly()).toBe(false);
        expect(heard).toEqual([null]);
    });

    test('a refused reason changes nothing and tells no one', () => {
        const engine = engineWithFont('read-only-listener-refused');
        const heard = [];
        engine.onReadOnlyChanged((reason) => heard.push(reason));
        expect(() => engine.setReadOnly('  ')).toThrow(TypeError);
        expect(heard).toEqual([]);
    });

    test('unsubscribing stops the calls', () => {
        const engine = engineWithFont('read-only-listener-unsub');
        const heard = [];
        const unsubscribe = engine.onReadOnlyChanged((reason) =>
            heard.push(reason)
        );
        engine.setReadOnly(READ_ONLY_REASON);
        unsubscribe();
        engine.setReadOnly(null);
        expect(heard).toEqual([READ_ONLY_REASON]);
    });

    test('destroying a read-only font ends its read-only period', () => {
        const engine = engineWithFont('read-only-listener-destroy');
        const heard = [];
        engine.onReadOnlyChanged((reason) => heard.push(reason));
        engine.setReadOnly(READ_ONLY_REASON);
        engine.destroy();
        expect(heard).toEqual([READ_ONLY_REASON, null]);
        expect(engine.isReadOnly()).toBe(false);
    });

    test('destroying a writable font tells no one', () => {
        const engine = engineWithFont('read-only-listener-destroy-writable');
        const heard = [];
        engine.onReadOnlyChanged((reason) => heard.push(reason));
        engine.destroy();
        expect(heard).toEqual([]);
    });

    test('a throwing listener does not undo the change or stop the others', () => {
        const engine = engineWithFont('read-only-listener-throws');
        const heard = [];
        const failure = new Error('listener failed');
        engine.onReadOnlyChanged(() => {
            throw failure;
        });
        engine.onReadOnlyChanged((reason) => heard.push(reason));
        expect(() => engine.setReadOnly(READ_ONLY_REASON)).toThrow(failure);
        expect(engine.isReadOnly()).toBe(true);
        expect(heard).toEqual([READ_ONLY_REASON]);
        const consoleError = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        try {
            engine.destroy();
            expect(heard).toEqual([READ_ONLY_REASON, null]);
            expect(consoleError).toHaveBeenCalled();
        } finally {
            consoleError.mockRestore();
        }
    });
});

describe('no station link is filled in on a local write', () => {
    test('a whole drawing without master is refused, not given the stored one', () => {
        const engine = engineWithFont('station-whole');
        expect(() =>
            engine._normalizeDrawingSnapshot(
                'layer-1',
                { id: 'layer-1', width: 610, shapes: [] },
                {
                    id: 'layer-1',
                    width: 600,
                    master: {
                        type: 'DefaultForMaster',
                        master: 'master-regular'
                    },
                    shapes: []
                }
            )
        ).toThrow(DrawingInvariantError);
    });

    test('a whole drawing with an unreadable master is refused', () => {
        const engine = engineWithFont('station-unreadable');
        expect(() =>
            engine._normalizeDrawingSnapshot(
                'layer-1',
                { id: 'layer-1', width: 610, master: 42, shapes: [] },
                {
                    id: 'layer-1',
                    width: 600,
                    master: {
                        type: 'DefaultForMaster',
                        master: 'master-regular'
                    }
                }
            )
        ).toThrow(DrawingInvariantError);
    });

    test('a delta that writes a null master is refused and the link stays', () => {
        const engine = engineWithFont('station-delta-null');
        const doc = engine.getDocumentInstance(
            engine.documentIdForPath(['glyphs', 'A'])
        );
        expect(() =>
            doc.transact(() =>
                engine._applyDrawingDelta('A', 'layer-1', { master: null })
            )
        ).toThrow(/master/);
        expect(engine.readStoredDrawing('A', 'layer-1').master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });
    });

    test('a delta that does not touch master keeps merging', () => {
        const engine = engineWithFont('station-delta-merge');
        const doc = engine.getDocumentInstance(
            engine.documentIdForPath(['glyphs', 'A'])
        );
        doc.transact(() =>
            engine._applyDrawingDelta('A', 'layer-1', { width: 640 })
        );
        expect(engine.getYValue(WIDTH_PATH)).toBe(640);
        expect(engine.readStoredDrawing('A', 'layer-1').master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });
    });
});

describe('a drawing’s format_specific through the engine', () => {
    test('a delta removing format_specific empties the shared map', () => {
        const engine = engineWithFont('format-specific-delta');
        const documentId = engine.documentIdForPath(['glyphs', 'A']);
        const doc = engine.getDocumentInstance(documentId);
        const drawingMap = () => {
            const root = doc.share.has('glyph')
                ? doc.getMap('glyph')
                : doc.getMap('font').get('glyphs').get('A');
            return root.get('layers').get('layer-1');
        };
        const map = drawingMap().get('format_specific');
        expect(map).toBeInstanceOf(Y.Map);
        doc.transact(() =>
            engine._applyDrawingDelta('A', 'layer-1', {
                format_specific: { 'com.example': 1 }
            })
        );
        expect(drawingMap().get('format_specific')).toBe(map);
        expect(
            engine.readStoredDrawing('A', 'layer-1').format_specific
        ).toEqual({ 'com.example': 1 });
        doc.transact(() =>
            engine._applyDrawingDelta('A', 'layer-1', {
                format_specific: null
            })
        );
        expect(drawingMap().get('format_specific')).toBe(map);
        expect(map.size).toBe(0);
        expect(
            'format_specific' in engine.readStoredDrawing('A', 'layer-1')
        ).toBe(false);
    });
});
