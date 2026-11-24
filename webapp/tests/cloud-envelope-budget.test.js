const { PatchSyncEngine } = require('../js/patch-sync-engine');
const {
    fitCollaborationMessagesToBudget
} = require('../js/generated/collab-protocol-metadata-budget');
const {
    EnvelopeTooLargeError,
    fitEnvelopeForWire
} = require('../js/cloud-envelope-budget');
const {
    MAX_METADATA_BYTES
} = require('../js/generated/collab-protocol-limits');

function makeFont() {
    return {
        upm: 1000,
        version: [1, 0],
        names: { familyName: 'Budget' },
        axes: [],
        masters: [{ id: 'M1', name: 'Regular', location: {} }],
        glyphs: ['A', 'B'].map((name) => ({
            name,
            id: `id-${name}`,
            production_name: null,
            category: 'Base',
            codepoints: [],
            exported: true,
            layers: [
                {
                    id: 'L1',
                    master: { type: 'DefaultForMaster', master: 'M1' },
                    width: 500,
                    shapes: [],
                    anchors: []
                }
            ]
        }))
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

describe('fitted envelopes still converge receivers', () => {
    test.each([100000])(
        'a receiver applies an envelope fitted to a %i byte budget',
        (budget) => {
            const senderFont = makeFont();
            const receiverFont = JSON.parse(JSON.stringify(senderFont));
            const sender = new PatchSyncEngine('sender-budget');
            const receiver = new PatchSyncEngine('receiver-budget');
            sender.initFromJson(senderFont);
            receiver.setFontJson(receiverFont);
            receiver.applyDocumentSetState(sender.encodeDocumentSet());

            const { update, message } = sendWidthEdit(sender, senderFont, 741);
            const fit = fitCollaborationMessagesToBudget([message], budget);
            expect(fit.fits).toBe(true);
            // Cloud adapters always pass the document the packet belongs to.
            const documentId = sender.documentIdForPath(['glyphs', 'A']);

            receiver.applyRemoteUpdate(
                update,
                undefined,
                fit.messages,
                documentId,
                { captureInUndo: false }
            );
            expect(receiverFont.glyphs[0].layers[0].width).toBe(741);

            sender.destroy();
            receiver.destroy();
        }
    );

    test('a layer-scoped edit collapsed to its glyph without targets still converges', () => {
        // After SHARE_REPLAY_TARGETS and COLLAPSE_TO_GLYPHS a glyph keeps
        // only its `glyphs.X:` path, and the history scope of a layer edit
        // stays `layer`.
        const senderFont = makeFont();
        const receiverFont = JSON.parse(JSON.stringify(senderFont));
        const sender = new PatchSyncEngine('sender-budget-glyph-root');
        const receiver = new PatchSyncEngine('receiver-budget-glyph-root');
        sender.initFromJson(senderFont);
        receiver.setFontJson(receiverFont);
        receiver.applyDocumentSetState(sender.encodeDocumentSet());

        const { update, message } = sendWidthEdit(sender, senderFont, 733);
        const collapsed = {
            ...message,
            changes: [{ path: 'glyphs.A:', op: 'set' }],
            metadata: {
                ...message.metadata,
                undoScope: 'layer',
                workerReplayTargets: []
            }
        };
        receiver.applyRemoteUpdate(
            update,
            undefined,
            [collapsed],
            sender.documentIdForPath(['glyphs', 'A']),
            { captureInUndo: false }
        );
        expect(receiverFont.glyphs[0].layers[0].width).toBe(733);

        sender.destroy();
        receiver.destroy();
    });

    test('an envelope inside the budget is sent as it is', () => {
        const font = makeFont();
        const sender = new PatchSyncEngine('sender-budget-small');
        sender.initFromJson(font);
        const { message } = sendWidthEdit(sender, font, 612);
        expect(fitEnvelopeForWire(message)).toBe(message);
        sender.destroy();
    });

    test('an oversized envelope is fitted below the room cap before sending', () => {
        const font = makeFont();
        const sender = new PatchSyncEngine('sender-budget-large');
        sender.initFromJson(font);
        const { message } = sendWidthEdit(sender, font, 640);
        const changes = Array.from({ length: 4000 }, (_, n) => ({
            path: `glyphs.A:layers.L1:shapes.0.nodes.${n}.x`,
            op: 'set',
            replayOldValue: n,
            replayNewValue: n + 1
        }));
        const big = { ...message, changes };
        const fitted = fitEnvelopeForWire(big);
        expect(JSON.stringify([fitted]).length).toBeLessThan(
            MAX_METADATA_BYTES
        );
        expect(fitted.transactionId).toBe(big.transactionId);
        expect(fitted.changes.map((change) => change.path)).toEqual([
            'glyphs.A:layers.L1'
        ]);
        sender.destroy();
    });

    test('packets that share an envelope body are fitted once and keep their own sequence', () => {
        const font = makeFont();
        const sender = new PatchSyncEngine('sender-budget-shared');
        sender.initFromJson(font);
        const { message } = sendWidthEdit(sender, font, 650);
        const changes = Array.from({ length: 4000 }, (_, n) => ({
            path: `glyphs.A:layers.L1:shapes.0.nodes.${n}.x`,
            op: 'set',
            replayOldValue: n,
            replayNewValue: n + 1
        }));
        const first = { ...message, changes, localSequence: 1 };
        const second = { ...first, localSequence: 2 };

        const fittedFirst = fitEnvelopeForWire(first);
        const fittedSecond = fitEnvelopeForWire(second);

        expect(fittedFirst.localSequence).toBe(1);
        expect(fittedSecond.localSequence).toBe(2);
        expect(fittedSecond.changes).toBe(fittedFirst.changes);
        expect(fittedSecond.metadata).toBe(fittedFirst.metadata);

        // A different body is fitted on its own.
        const other = {
            ...first,
            changes: [...changes],
            label: 'Other'
        };
        expect(fitEnvelopeForWire(other).changes).not.toBe(fittedFirst.changes);
        sender.destroy();
    });

    test('an envelope no lossless step can fit is refused, never cut down', () => {
        const font = makeFont();
        const sender = new PatchSyncEngine('sender-budget-refused');
        sender.initFromJson(font);
        const { message } = sendWidthEdit(sender, font, 660);
        const huge = {
            ...message,
            label: 'x'.repeat(MAX_METADATA_BYTES * 2)
        };
        expect(() =>
            fitEnvelopeForWire(huge, { documentId: 'glyph:id-A' })
        ).toThrow(EnvelopeTooLargeError);
        // The cached verdict refuses every packet that shares the body.
        expect(() => fitEnvelopeForWire({ ...huge, localSequence: 2 })).toThrow(
            EnvelopeTooLargeError
        );
        sender.destroy();
    });

    test('an envelope past glyph roots widens to the whole document instead of truncating', () => {
        const font = makeFont();
        const sender = new PatchSyncEngine('sender-budget-widened');
        sender.initFromJson(font);
        const { message } = sendWidthEdit(sender, font, 670);
        const names = Array.from({ length: 6000 }, (_, n) => `glyph-${n}`);
        const big = {
            ...message,
            changes: names.map((name) => ({
                path: `glyphs.${name}:layers.L1:width`,
                op: 'set'
            })),
            metadata: {
                ...message.metadata,
                changedGlyphNames: names,
                workerReplayTargets: names.map((glyphName) => ({
                    glyphName,
                    layerId: 'L1'
                }))
            }
        };
        const fitted = fitEnvelopeForWire(big);
        expect(JSON.stringify([fitted]).length).toBeLessThan(
            MAX_METADATA_BYTES
        );
        expect(fitted.metadata.allGlyphsChanged).toBe(true);
        expect(fitted.metadata.changedGlyphNames).toEqual([]);
        expect(fitted.metadata.workerReplayTargets).toEqual([]);
        expect(fitted.changes).toEqual([]);
        expect(fitted.transactionId).toBe(big.transactionId);
        sender.destroy();
    });

    // Fails until receivers honour `metadata.allGlyphsChanged` (re-read every
    // glyph of the packet's document). Flip to `test` once they do.
    test('a receiver converges on an envelope widened to its whole document', () => {
        const senderFont = makeFont();
        const receiverFont = JSON.parse(JSON.stringify(senderFont));
        const sender = new PatchSyncEngine('sender-budget-widened-rx');
        const receiver = new PatchSyncEngine('receiver-budget-widened-rx');
        sender.initFromJson(senderFont);
        receiver.setFontJson(receiverFont);
        receiver.applyDocumentSetState(sender.encodeDocumentSet());

        const { update, message } = sendWidthEdit(sender, senderFont, 755);
        const widened = {
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
        receiver.applyRemoteUpdate(
            update,
            undefined,
            [widened],
            sender.documentIdForPath(['glyphs', 'A']),
            { captureInUndo: false }
        );
        expect(receiverFont.glyphs[0].layers[0].width).toBe(755);

        sender.destroy();
        receiver.destroy();
    });
});
