const { PatchSyncEngine } = require('../js/patch-sync-engine');
const { EnvelopeTooLargeError } = require('../js/cloud-envelope-budget');
const { getBrokenDocuments } = require('../js/yjs-update-integrity');
const {
    MAX_METADATA_BYTES
} = require('../js/generated/collab-protocol-limits');

function drawing(id, shapes = []) {
    return {
        id,
        master: { type: 'DefaultForMaster', master: 'M1' },
        width: 500,
        shapes,
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
        names: { familyName: 'Whole' },
        axes: [],
        masters: [{ id: 'M1', name: 'Regular', location: {} }],
        glyphs: [
            glyph('A', [drawing('L1'), drawing('L1-bg-free')]),
            glyph('B', [
                drawing('LB', [
                    { reference: 'A', transform: [1, 0, 0, 1, 0, 0] }
                ])
            ]),
            glyph('C', [
                drawing('LC', [
                    { reference: 'B', transform: [1, 0, 0, 1, 0, 0] }
                ])
            ]),
            glyph('D', [drawing('LD')])
        ]
    };
}

function sendWidthEdit(sender, font, width) {
    let captured = null;
    sender.onLocalUpdate((update, message) => {
        captured = { update, message };
    });
    font.glyphs[0].layers[0].width = width;
    sender.syncGlyphFromJson(
        'A',
        'Width drag',
        undefined,
        undefined,
        'L1',
        undefined,
        undefined,
        undefined,
        'test-sync',
        null
    );
    return captured;
}

function widen(message) {
    return {
        ...message,
        changes: [],
        metadata: {
            ...message.metadata,
            allGlyphsChanged: true,
            changedGlyphNames: [],
            changedLayerIds: [],
            workerReplayTargets: []
        }
    };
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

describe('an envelope widened to its whole document', () => {
    test('re-reads the glyph and replays every drawing of it and of the composites using it', () => {
        const { sender, receiver, senderFont, receiverFont } = pair('targets');
        const { update, message } = sendWidthEdit(sender, senderFont, 777);
        const committed = [];
        receiver.onCommittedChange((entries) => committed.push(...entries));

        receiver.applyRemoteUpdate(
            update,
            undefined,
            [widen(message)],
            sender.documentIdForPath(['glyphs', 'A']),
            { captureInUndo: false }
        );

        expect(receiverFont.glyphs[0].layers[0].width).toBe(777);
        const entry = committed.find((item) => item.path === 'glyphs.A:');
        expect(entry).toBeDefined();
        expect(entry.op).toBe('set');
        const targets = entry.workerReplayTargets
            .map((target) => `${target.glyphName}/${target.layerId}`)
            .sort();
        expect(targets).toEqual(['A/L1', 'A/L1-bg-free', 'B/LB', 'C/LC']);

        sender.destroy();
        receiver.destroy();
    });

    test('is refused without the id of the document it belongs to', () => {
        const { sender, receiver, senderFont } = pair('no-document');
        const { update, message } = sendWidthEdit(sender, senderFont, 778);
        expect(() =>
            receiver.applyRemoteUpdate(update, undefined, [widen(message)])
        ).toThrow(/without the document’s id/);
        sender.destroy();
        receiver.destroy();
    });
});

describe('document load notifications', () => {
    test('a glyph document created here is announced once filled, and linked-window deltas held for it drain', async () => {
        const drain = jest.fn();
        const previousWindowSync = window.windowSync;
        window.windowSync = { drainDeltasHeldUntilLoaded: drain };
        try {
            const engine = new PatchSyncEngine('loaded-notice');
            const loaded = [];
            const unsubscribe = engine.onDocumentLoaded((documentId) => {
                loaded.push({
                    documentId,
                    held: engine.getDocumentInstance(documentId) !== null
                });
            });
            engine.initFromJson(makeFont());
            // Announced after the operation that filled the documents.
            expect(loaded).toEqual([]);
            await Promise.resolve();
            expect(loaded).toEqual(
                expect.arrayContaining([
                    { documentId: 'glyph:id-A', held: true },
                    { documentId: 'glyph:id-D', held: true }
                ])
            );
            expect(drain).toHaveBeenCalledTimes(1);

            unsubscribe();
            engine.destroy();
        } finally {
            window.windowSync = previousWindowSync;
        }
    });
});

describe('held envelopes too large for the room', () => {
    test('mark the document broken and throw instead of dropping the packet', () => {
        const engine = new PatchSyncEngine('held-too-large');
        const font = makeFont();
        engine.initFromJson(font);
        const { message } = sendWidthEdit(engine, font, 790);
        const huge = { ...message, label: 'x'.repeat(MAX_METADATA_BYTES * 2) };
        const documentId = engine.documentIdForPath(['glyphs', 'A']);
        expect(() =>
            engine._mergeHeldEnvelopes(
                [huge, { ...huge, localSequence: huge.localSequence + 1 }],
                documentId,
                false
            )
        ).toThrow(EnvelopeTooLargeError);
        expect(
            getBrokenDocuments().some(
                (record) => record.documentId === documentId
            )
        ).toBe(true);
        engine.destroy();
    });
});
