/**
 * Glyph residency against catch-ups and restored unsent edits.
 *
 * - A glyph with a catch-up running or queued is never unloaded, whoever
 *   asks (the cloud plugin’s plan or a linked window’s residency relay):
 *   the catch-up’s rows apply to the instance its cursor came from.
 * - An unsent edit restored from the write-ahead log applies only to a
 *   document whose state is loaded here. Before that it throws a waiting
 *   error, applies nothing, makes no document and marks nothing broken.
 */

const { PatchSyncEngine } = require('../js/patch-sync-engine');
const {
    DocumentStateNotLoadedError,
    getBrokenDocuments
} = require('../js/yjs-update-integrity');

function drawing(id, station, width = 500) {
    return {
        id,
        width,
        master: { type: 'DefaultForMaster', master: station },
        shapes: [],
        anchors: []
    };
}

function makeFont() {
    return {
        upm: 1000,
        version: [1, 0],
        names: { familyName: 'Residency' },
        axes: [],
        masters: [{ id: 'm1', name: { dflt: 'm1' }, location: {} }],
        glyphs: ['A', 'B', 'C'].map((name) => ({
            name,
            production_name: null,
            category: 'Base',
            codepoints: [],
            exported: true,
            layers: [drawing('m1', 'm1')]
        }))
    };
}

function setup(label) {
    const engine = new PatchSyncEngine(label);
    engine.initFromJson(makeFont());
    window.changeBridge = engine;
    return engine;
}

const listed = (documentId) =>
    getBrokenDocuments().some((entry) => entry.documentId === documentId);

afterEach(() => {
    delete window.changeBridge;
});

describe('unloading glyphs with a catch-up', () => {
    test('a glyph with a catch-up in flight stays until the catch-up ends', () => {
        const engine = setup('catch-up-in-flight');
        const [glyphA, glyphB, glyphC] = engine._fontJson.glyphs;
        const documentB = engine.documentIdForPath(['glyphs', 'B']);
        engine.noteGlyphCatchUpInFlight(documentB, true);
        expect(engine.hasGlyphCatchUp(documentB)).toBe(true);

        const unloaded = engine.unloadCleanGlyphDocuments([glyphA.id], {
            ignorePeers: true
        });
        expect(unloaded).toEqual([glyphC.id]);
        expect(engine.hasResidentGlyphDocument(documentB)).toBe(true);

        engine.noteGlyphCatchUpInFlight(documentB, false);
        expect(
            engine.unloadCleanGlyphDocuments([glyphA.id], {
                ignorePeers: true
            })
        ).toEqual([glyphB.id]);
        expect(engine.hasResidentGlyphDocument(documentB)).toBe(false);
        engine.destroy();
    });

    test('a glyph whose catch-up is queued to run again stays', () => {
        const engine = setup('catch-up-pending');
        const [glyphA] = engine._fontJson.glyphs;
        const documentB = engine.documentIdForPath(['glyphs', 'B']);
        const documentC = engine.documentIdForPath(['glyphs', 'C']);
        engine.noteGlyphCatchUpPending(documentC, true);
        engine.noteGlyphCatchUpInFlight(documentB, true);
        expect(
            engine.unloadCleanGlyphDocuments([glyphA.id], {
                ignorePeers: true
            })
        ).toEqual([]);
        expect(engine.hasResidentGlyphDocument(documentB)).toBe(true);
        expect(engine.hasResidentGlyphDocument(documentC)).toBe(true);

        engine.clearGlyphCatchUps();
        expect(engine.hasGlyphCatchUp(documentB)).toBe(false);
        expect(engine.hasGlyphCatchUp(documentC)).toBe(false);
        expect(
            engine
                .unloadCleanGlyphDocuments([glyphA.id], { ignorePeers: true })
                .sort()
        ).toEqual(
            [documentB, documentC].map((id) => id.slice('glyph:'.length)).sort()
        );
        engine.destroy();
    });
});

describe('restoring unsent edits', () => {
    function writerWithUnsentEdit() {
        const writer = setup('wal-writer');
        const shardsBefore = writer.encodeDocumentSet();
        const packets = [];
        writer.onLocalUpdate(
            (update, collaborationMessage, changeLogEntries, documentId) => {
                packets.push({
                    update,
                    collaborationMessage,
                    changeLogEntries,
                    documentId
                });
            }
        );
        const before = writer
            .getFontJsonSnapshot()
            .glyphs.find((glyph) => glyph.name === 'B').layers[0];
        writer.recordChange(['glyphs', 'B', 'layers'], 'm1', before, {
            ...JSON.parse(JSON.stringify(before)),
            width: 777
        });
        const documentB = writer.documentIdForPath(['glyphs', 'B']);
        const row = packets.find((packet) => packet.documentId === documentB);
        expect(row).toBeTruthy();
        return { writer, shardsBefore, row, documentB };
    }

    function restore(engine, row, bytes = row.update) {
        return engine.applyRemoteUpdate(
            bytes,
            row.changeLogEntries,
            row.collaborationMessage ? [row.collaborationMessage] : [],
            row.documentId,
            { captureInUndo: false, restoredUnsentEdit: true }
        );
    }

    test('a row for a glyph whose state is not loaded waits and breaks nothing, then applies once the state is in', () => {
        const { writer, shardsBefore, row, documentB } = writerWithUnsentEdit();
        const receiver = new PatchSyncEngine('wal-reopened');
        receiver.setFontJson(
            JSON.parse(JSON.stringify(writer.getFontJsonSnapshot()))
        );
        receiver.applySnapshotBytes(
            shardsBefore.filter((shard) => shard.documentId !== documentB)
        );
        expect(receiver.hasLoadedDocumentState(documentB)).toBe(false);

        expect(() => restore(receiver, row)).toThrow(
            DocumentStateNotLoadedError
        );
        expect(receiver.hasResidentGlyphDocument(documentB)).toBe(false);
        expect(receiver.isDocumentIdBroken(documentB)).toBe(false);
        expect(listed(documentB)).toBe(false);

        receiver.applySnapshotBytes(
            shardsBefore.filter((shard) => shard.documentId === documentB)
        );
        expect(receiver.hasLoadedDocumentState(documentB)).toBe(true);
        expect(restore(receiver, row)).toBe(true);
        const glyphB = receiver
            .materializeSnapshotFont()
            .glyphs.find((glyph) => glyph.name === 'B');
        expect(glyphB.layers[0].width).toBe(777);
        receiver.destroy();
        writer.destroy();
    });

    test('a complete glyph state restored as a row does not make the glyph ahead of its room state', () => {
        const { writer, row, documentB } = writerWithUnsentEdit();
        const wholeState = writer
            .encodeDocumentSet()
            .find((shard) => shard.documentId === documentB).bytes;
        const receiver = new PatchSyncEngine('wal-complete-row');
        receiver.setFontJson(
            JSON.parse(JSON.stringify(writer.getFontJsonSnapshot()))
        );
        expect(() => restore(receiver, row, wholeState)).toThrow(
            DocumentStateNotLoadedError
        );
        expect(receiver.hasResidentGlyphDocument(documentB)).toBe(false);
        expect(listed(documentB)).toBe(false);
        receiver.destroy();
        writer.destroy();
    });

    test('a document-loaded listener sees the state loaded and can restore the waiting row there', async () => {
        const { writer, shardsBefore, row, documentB } = writerWithUnsentEdit();
        const receiver = new PatchSyncEngine('wal-on-loaded');
        receiver.setFontJson(
            JSON.parse(JSON.stringify(writer.getFontJsonSnapshot()))
        );
        receiver.applySnapshotBytes(
            shardsBefore.filter((shard) => shard.documentId !== documentB)
        );
        expect(() => restore(receiver, row)).toThrow(
            DocumentStateNotLoadedError
        );
        const seen = [];
        receiver.onDocumentLoaded((documentId) => {
            if (documentId !== documentB) return;
            seen.push(receiver.hasLoadedDocumentState(documentId));
            seen.push(restore(receiver, row));
        });
        receiver.applySnapshotBytes(
            shardsBefore.filter((shard) => shard.documentId === documentB)
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(seen).toEqual([true, true]);
        expect(receiver.isDocumentIdBroken(documentB)).toBe(false);
        const glyphB = receiver
            .materializeSnapshotFont()
            .glyphs.find((glyph) => glyph.name === 'B');
        expect(glyphB.layers[0].width).toBe(777);
        receiver.destroy();
        writer.destroy();
    });

    test('a shard refused for a gap leaves the document not loaded', () => {
        const { writer, row, documentB } = writerWithUnsentEdit();
        const receiver = new PatchSyncEngine('wal-gap-shard');
        receiver.setFontJson(
            JSON.parse(JSON.stringify(writer.getFontJsonSnapshot()))
        );
        // The delta alone, offered as the glyph's whole state, misses the
        // updates it builds on: a real gap.
        expect(() =>
            receiver.applySnapshotBytes([
                { documentId: documentB, bytes: row.update }
            ])
        ).toThrow();
        expect(receiver.hasLoadedDocumentState(documentB)).toBe(false);
        receiver.destroy();
        writer.destroy();
    });

    test('an unloaded glyph no longer counts as loaded', () => {
        const engine = setup('wal-unloaded');
        const [glyphA] = engine._fontJson.glyphs;
        const documentB = engine.documentIdForPath(['glyphs', 'B']);
        expect(engine.hasLoadedDocumentState('font-core')).toBe(true);
        expect(engine.hasLoadedDocumentState(documentB)).toBe(true);
        engine.unloadCleanGlyphDocuments([glyphA.id], { ignorePeers: true });
        expect(engine.hasLoadedDocumentState(documentB)).toBe(false);
        engine.destroy();
        expect(engine.hasLoadedDocumentState('font-core')).toBe(false);
    });
});
