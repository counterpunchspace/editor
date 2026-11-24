/**
 * Broken documents and station facts across documents.
 *
 * - Whether a drawing’s station exists is a fact of font-core, which reaches
 *   this window in its own packets. Writes of glyph documents check a
 *   drawing’s shape only; undo replays font-core first.
 * - A refusal before anything is written leaves the document whole and
 *   writable; only a throw after a partial write marks it broken.
 * - A broken record is kept by document id for the font session: unloading
 *   keeps the document, a document marked while not held is refused when it
 *   loads, and a new engine (font reload) starts clean.
 */

const Y = require('yjs');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const { setYPath } = require('../js/change-bridge-ydoc');
const {
    BrokenDocumentError,
    getBrokenDocuments,
    isDocumentBroken
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

function station(id) {
    return { id, name: { dflt: id }, location: {} };
}

function makeFont() {
    return {
        upm: 1000,
        version: [1, 0],
        names: { familyName: 'Broken' },
        axes: [],
        masters: [station('m1'), station('m2')],
        glyphs: ['A', 'B'].map((name) => ({
            name,
            production_name: null,
            category: 'Base',
            codepoints: [],
            exported: true,
            layers: [drawing('m1', 'm1'), drawing('m2', 'm2')]
        }))
    };
}

const listed = (documentId) =>
    getBrokenDocuments().some((entry) => entry.documentId === documentId);

function setup(label, font = makeFont()) {
    const engine = new PatchSyncEngine(label);
    engine.initFromJson(font);
    window.changeBridge = engine;
    return engine;
}

afterEach(() => {
    delete window.changeBridge;
});

/** A worker-style “Remove station m2” commit, recorded like the real one. */
function removeStationCommit(engine) {
    const shards = engine.encodeDocumentSet();
    const json = engine.getFontJsonSnapshot();
    const operations = [
        {
            op: 'set',
            path: ['masters'],
            oldValue: JSON.parse(JSON.stringify(json.masters)),
            newValue: JSON.parse(
                JSON.stringify(json.masters.filter((s) => s.id !== 'm2'))
            )
        }
    ];
    const documentUpdates = [];
    const coreDoc = new Y.Doc({ gc: false });
    Y.applyUpdate(
        coreDoc,
        shards.find((shard) => shard.documentId === 'font-core').bytes
    );
    const coreBaseline = Y.encodeStateVector(coreDoc);
    coreDoc.transact(() => {
        setYPath(coreDoc.getMap('font'), ['masters'], operations[0].newValue);
    });
    documentUpdates.push({
        documentId: 'font-core',
        update: Y.encodeStateAsUpdate(coreDoc, coreBaseline)
    });
    for (const glyph of json.glyphs) {
        const documentId = engine.documentIdForPath(['glyphs', glyph.name]);
        const doc = new Y.Doc({ gc: false });
        Y.applyUpdate(
            doc,
            shards.find((shard) => shard.documentId === documentId).bytes
        );
        const baseline = Y.encodeStateVector(doc);
        doc.transact(() => {
            doc.getMap('glyph').get('layers').delete('m2');
        });
        documentUpdates.push({
            documentId,
            update: Y.encodeStateAsUpdate(doc, baseline)
        });
        operations.push({
            op: 'remove',
            path: ['glyphs', glyph.name, 'layers', 'm2'],
            oldValue: JSON.parse(
                JSON.stringify(glyph.layers.find((layer) => layer.id === 'm2'))
            ),
            newValue: undefined,
            workerReplayTargets: [{ glyphName: glyph.name, layerId: 'm2' }]
        });
    }
    return { operations, documentUpdates };
}

describe('station facts on glyph-document writes', () => {
    test('undoing “Remove station” restores the station and its drawings, and breaks nothing', () => {
        const engine = setup('undo-remove-station');
        const { operations, documentUpdates } = removeStationCommit(engine);
        engine.applyLocalGeneratedYjsUpdate(
            documentUpdates[0].update,
            operations,
            'Remove station',
            null,
            documentUpdates
        );
        const removed = engine.getFontJsonSnapshot();
        expect(removed.masters.map((s) => s.id)).toEqual(['m1']);
        expect(removed.glyphs[0].layers.map((l) => l.id)).toEqual(['m1']);

        expect(engine.undo()).not.toBeNull();

        const restored = engine.getFontJsonSnapshot();
        expect(restored.masters.map((s) => s.id)).toEqual(['m1', 'm2']);
        for (const glyph of restored.glyphs) {
            expect(glyph.layers.map((l) => l.id).sort()).toEqual(['m1', 'm2']);
            const documentId = engine.documentIdForPath(['glyphs', glyph.name]);
            expect(engine.isDocumentIdBroken(documentId)).toBe(false);
            expect(listed(documentId)).toBe(false);
        }
        expect(isDocumentBroken(engine.yDoc)).toBe(false);
        engine.destroy();
    });

    test('a drawing whose station font-core does not hold yet can be written', () => {
        // A peer added station m3; the glyph packet arrived before font-core’s.
        const font = makeFont();
        font.glyphs[0].layers.push(drawing('m3', 'm3'));
        const engine = setup('station-not-yet-in-core', font);
        const documentId = engine.documentIdForPath(['glyphs', 'A']);
        const json = engine.getFontJsonSnapshot();
        const before = json.glyphs[0].layers.find((l) => l.id === 'm3');
        const after = { ...JSON.parse(JSON.stringify(before)), width: 620 };
        engine.recordChange(['glyphs', 'A', 'layers'], 'm3', before, after);
        const stored = engine
            ._docForId(documentId)
            .getMap('glyph')
            .get('layers')
            .get('m3');
        expect(stored.get('width')).toBe(620);
        expect(engine.isDocumentIdBroken(documentId)).toBe(false);
        engine.destroy();
    });

    test('a refused write that wrote nothing throws and leaves the document writable', () => {
        const engine = setup('refusal-before-write');
        const documentId = engine.documentIdForPath(['glyphs', 'A']);
        const doc = engine._docForId(documentId);
        const vector = Y.encodeStateVector(doc);
        const json = engine.getFontJsonSnapshot();
        const before = json.glyphs[0].layers.find((l) => l.id === 'm1');
        const withoutWidth = JSON.parse(JSON.stringify(before));
        delete withoutWidth.width;
        expect(() =>
            engine.recordChange(
                ['glyphs', 'A', 'layers'],
                'm1',
                before,
                withoutWidth
            )
        ).toThrow();
        expect(Y.encodeStateVector(doc)).toEqual(vector);
        expect(isDocumentBroken(doc)).toBe(false);
        expect(engine.isDocumentIdBroken(documentId)).toBe(false);
        engine.destroy();
    });
});

describe('broken records by document id', () => {
    test('a broken glyph document is not unloaded', () => {
        const engine = setup('broken-stays-resident');
        const [glyphA, glyphB] = engine._fontJson.glyphs;
        const documentId = engine.documentIdForPath(['glyphs', 'A']);
        engine.markDocumentBroken(documentId, new Error('lost an update'));
        const unloaded = engine.unloadCleanGlyphDocuments([glyphB.id], {
            ignorePeers: true
        });
        expect(unloaded).not.toContain(glyphA.id);
        expect(engine._docForId(documentId)).not.toBeNull();
        expect(isDocumentBroken(engine._docForId(documentId))).toBe(true);
        engine.destroy();
    });

    test('a document marked while not held is refused when it loads, and is listed until the engine is destroyed', () => {
        const source = setup('broken-source');
        const shards = source.encodeDocumentSet();
        const documentId = source.documentIdForPath(['glyphs', 'B']);
        const shard = shards.find((s) => s.documentId === documentId);
        source.destroy();

        const engine = new PatchSyncEngine('broken-absent');
        engine.markDocumentBroken(documentId, new Error('lost an update'));
        expect(engine._docForId(documentId)).toBeNull();
        expect(engine.isDocumentIdBroken(documentId)).toBe(true);
        expect(listed(documentId)).toBe(true);
        expect(
            window.__collabBrokenDocuments().map((e) => e.documentId)
        ).toContain(documentId);
        expect(() => engine.applySnapshotBytes([shard])).toThrow(
            BrokenDocumentError
        );
        expect(engine._docForId(documentId)).toBeNull();

        engine.destroy();
        expect(listed(documentId)).toBe(false);
        const reloaded = new PatchSyncEngine('broken-reloaded');
        expect(reloaded.isDocumentIdBroken(documentId)).toBe(false);
        reloaded.applySnapshotBytes([shard]);
        expect(reloaded._docForId(documentId)).not.toBeNull();
        reloaded.destroy();
    });

    test('a broken document that is destroyed and loaded again stays broken', () => {
        const engine = setup('broken-reload-in-session');
        const shards = engine.encodeDocumentSet();
        const documentId = engine.documentIdForPath(['glyphs', 'B']);
        const glyphId = documentId.slice('glyph:'.length);
        engine.markDocumentBroken(documentId, new Error('lost an update'));
        // Destroyed by some other path (not the unload, which keeps it).
        engine._glyphDocs.get(glyphId).destroy();
        engine._glyphDocs.delete(glyphId);
        expect(listed(documentId)).toBe(true);
        expect(() =>
            engine.applySnapshotBytes([
                shards.find((s) => s.documentId === documentId)
            ])
        ).toThrow(BrokenDocumentError);
        engine.destroy();
    });
});
