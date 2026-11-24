// Undo and redo of a glyph add, delete or rename update the cloud catalog
// exactly as the edit itself did: the main window writes it, also when the
// undo was made in a linked window. A replay that empties a glyph's
// document must leave its catalog entry deleted, or a later hydrate fetches
// a nameless glyph.

const { Font } = require('../js/babelfont-model');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const {
    CloudPlugin,
    committedEntryAsApplied
} = require('../js/filesystem-plugins/plugins/cloud-plugin');
const {
    applyCloudOwnedData,
    catalogFromCoreJson
} = require('../js/filesystem-plugins/cloud-glyph-catalog');

function fontData() {
    return {
        upm: 1000,
        version: [1, 0],
        axes: [],
        cross_axis_mappings: [],
        instances: [],
        masters: [
            {
                name: { dflt: 'Regular' },
                id: 'm',
                location: {},
                guides: [],
                metrics: {},
                kerning: {}
            }
        ],
        glyphs: [
            {
                name: 'A',
                category: 'Base',
                exported: true,
                codepoints: [65],
                layers: [
                    {
                        id: 'l1',
                        master: { type: 'DefaultForMaster', master: 'm' },
                        width: 600,
                        shapes: [],
                        anchors: []
                    }
                ]
            }
        ],
        note: '',
        date: new Date('2020-01-01T00:00:00.000Z'),
        names: {},
        features: { classes: {}, prefixes: {}, features: [] }
    };
}

/** A main window whose cloud plugin projects the catalog from its commits. */
function mainWindow(name = 'main') {
    const engine = new PatchSyncEngine(name);
    engine.initFromJson(fontData());
    engine.syncCloudOwnedProjection(
        applyCloudOwnedData(engine.getFontJsonSnapshot())
    );
    const plugin = new CloudPlugin();
    plugin._currentFontJson = () => engine.getFontJsonSnapshot();
    plugin._refreshAssetLimitsAfterCatalogChange = async () => {};
    engine.onCommittedChange(plugin._syncCatalogFromCommittedChange);
    const catalogCommits = [];
    engine.onCommittedChange((entries, context) => {
        if (
            context.origin === 'local' &&
            entries.some(
                (entry) => entry.transactionLabel === 'Update cloud catalog'
            )
        ) {
            catalogCommits.push(entries);
        }
    });
    return { engine, plugin, catalogCommits };
}

function catalogEntry(engine, glyphId) {
    return catalogFromCoreJson(engine.getFontJsonSnapshot())?.glyphCatalog?.[
        glyphId
    ];
}

let previousBridge;
beforeEach(() => {
    previousBridge = window.patchSyncEngine;
});
afterEach(() => {
    window.patchSyncEngine = previousBridge;
});

describe('committedEntryAsApplied', () => {
    test('reads an undo entry as the change it made', () => {
        const undoneAdd = {
            historyAction: 'undo',
            op: 'add',
            path: 'glyphs.x:',
            oldValue: undefined,
            newValue: { id: 'id-x', name: 'x' }
        };
        expect(committedEntryAsApplied(undoneAdd)).toMatchObject({
            op: 'remove',
            oldValue: { id: 'id-x', name: 'x' },
            newValue: undefined
        });
        const undoneDelete = {
            historyAction: 'undo',
            op: 'remove',
            path: 'glyphs.x:',
            oldValue: { id: 'id-x', name: 'x' },
            newValue: undefined
        };
        expect(committedEntryAsApplied(undoneDelete)).toMatchObject({
            op: 'add',
            newValue: { id: 'id-x', name: 'x' }
        });
        const undoneRename = {
            historyAction: 'undo',
            op: 'set',
            path: 'glyphs.x:name',
            oldValue: 'x',
            newValue: 'y',
            glyphRenames: [{ oldName: 'x', newName: 'y' }]
        };
        expect(committedEntryAsApplied(undoneRename)).toMatchObject({
            op: 'set',
            oldValue: 'y',
            newValue: 'x',
            glyphRenames: [{ oldName: 'y', newName: 'x' }]
        });
    });

    test('replay payloads win over display values', () => {
        expect(
            committedEntryAsApplied({
                historyAction: 'undo',
                op: 'set',
                path: 'glyphs.x:',
                oldValue: 'label before',
                newValue: 'label after',
                replayOldValue: { name: 'x' },
                replayNewValue: { name: 'x', codepoints: [120] }
            })
        ).toMatchObject({
            oldValue: { name: 'x', codepoints: [120] },
            newValue: { name: 'x' }
        });
    });

    test('a change or a redo is read as it is', () => {
        const change = {
            historyAction: 'change',
            op: 'add',
            path: 'glyphs.x:'
        };
        const redo = { historyAction: 'redo', op: 'add', path: 'glyphs.x:' };
        expect(committedEntryAsApplied(change)).toBe(change);
        expect(committedEntryAsApplied(redo)).toBe(redo);
    });
});

describe('undo and redo update the cloud catalog', () => {
    test('undoing a glyph add deletes its catalog entry; redo brings it back', () => {
        const { engine, catalogCommits } = mainWindow();
        window.patchSyncEngine = engine;
        try {
            Font.fromData(engine.getFontJsonSnapshot()).addGlyph('x', 'Base');
            const glyphId = engine._glyphIdByName.get('x');
            expect(catalogEntry(engine, glyphId)).toMatchObject({
                name: 'x',
                deleted: false
            });
            catalogCommits.length = 0;

            engine.undo();
            expect(catalogCommits.length).toBeGreaterThan(0);
            const undone = catalogEntry(engine, glyphId);
            expect(undone).toMatchObject({ name: 'x', deleted: true });
            expect(engine.isDeletedGlyphDocument(`glyph:${glyphId}`)).toBe(
                true
            );
            catalogCommits.length = 0;

            engine.redo();
            expect(catalogCommits.length).toBeGreaterThan(0);
            const redone = catalogEntry(engine, glyphId);
            expect(redone).toMatchObject({ name: 'x', deleted: false });
            expect(redone.generation).toBe(undone.generation + 1);
            expect(engine.isDeletedGlyphDocument(`glyph:${glyphId}`)).toBe(
                false
            );
        } finally {
            engine.destroy();
        }
    });

    test('undoing a glyph delete brings its catalog entry back', () => {
        const { engine } = mainWindow();
        window.patchSyncEngine = engine;
        try {
            const glyphId = engine._glyphIdByName.get('A');
            Font.fromData(engine.getFontJsonSnapshot()).deleteGlyphs(['A']);
            expect(catalogEntry(engine, glyphId)).toMatchObject({
                deleted: true
            });
            engine.undo();
            expect(catalogEntry(engine, glyphId)).toMatchObject({
                name: 'A',
                deleted: false,
                codepoints: [65]
            });
            engine.redo();
            expect(catalogEntry(engine, glyphId)).toMatchObject({
                deleted: true
            });
        } finally {
            engine.destroy();
        }
    });

    test('an undo made in a linked window updates the catalog in the main window', () => {
        const { engine: main, catalogCommits } = mainWindow();
        const linked = new PatchSyncEngine('linked');
        linked.applyDocumentSetState(main.encodeDocumentSet());
        const packets = [];
        linked.onLocalUpdate((update, message, entries, documentId) =>
            packets.push({ update, message, entries, documentId })
        );
        const relay = () => {
            window.patchSyncEngine = main;
            for (const packet of packets.splice(0)) {
                main.applyRemoteUpdate(
                    packet.update,
                    packet.entries,
                    packet.message ? [packet.message] : undefined,
                    packet.documentId,
                    { fromLinkedWindow: true }
                );
            }
        };
        try {
            window.patchSyncEngine = linked;
            Font.fromData(linked.getFontJsonSnapshot()).addGlyph('x', 'Base');
            const glyphId = linked._glyphIdByName.get('x');
            relay();
            expect(catalogEntry(main, glyphId)).toMatchObject({
                name: 'x',
                deleted: false
            });
            catalogCommits.length = 0;

            window.patchSyncEngine = linked;
            linked.undo();
            relay();
            expect(catalogCommits.length).toBeGreaterThan(0);
            expect(catalogEntry(main, glyphId)).toMatchObject({
                name: 'x',
                deleted: true
            });
        } finally {
            linked.destroy();
            main.destroy();
        }
    });

    test('a glyph whose catalog entry an undo deleted is not made again by a catch-up', () => {
        const { engine: main } = mainWindow();
        window.patchSyncEngine = main;
        const peer = new PatchSyncEngine('peer');
        try {
            Font.fromData(main.getFontJsonSnapshot()).addGlyph('x', 'Base');
            const glyphId = main._glyphIdByName.get('x');
            const documentId = `glyph:${glyphId}`;
            // The glyph's complete state from before the undo: what a slow
            // fetch could still bring.
            const stateWithName = main.encodeDocumentState(documentId);
            main.undo();
            peer.applyDocumentSetState(
                main
                    .encodeDocumentSet()
                    .filter((shard) => shard.documentId !== documentId)
            );
            expect(peer.isDeletedGlyphDocument(documentId)).toBe(true);
            expect(peer.applyDocumentCatchUp(documentId, stateWithName)).toBe(
                false
            );
            expect(peer.hasResidentGlyphDocument(documentId)).toBe(false);
        } finally {
            peer.destroy();
            main.destroy();
        }
    });

    test('a collaborator’s undo is left to the collaborator’s main window', () => {
        const plugin = new CloudPlugin();
        plugin._currentFontJson = () => ({ glyphs: [] });
        const projected = [];
        plugin._enqueueCatalogProjection = (update) => projected.push(update);
        plugin._syncCatalogFromCommittedChange(
            [
                {
                    historyAction: 'undo',
                    op: 'add',
                    path: 'glyphs.x:',
                    newValue: { id: 'id-x', name: 'x' }
                }
            ],
            { origin: 'remote', update: new Uint8Array() }
        );
        expect(projected).toHaveLength(0);
    });
});
