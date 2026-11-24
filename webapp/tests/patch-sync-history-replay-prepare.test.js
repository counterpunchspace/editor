/**
 * Undo and redo are prepared, then committed.
 *
 * - Every document a replay writes is resolved and checked before the
 *   history moves. A document this window does not hold refuses the replay:
 *   nothing is written and the history stays where it was.
 * - A write that still throws part way takes the history entry back out,
 *   undoes what the replay already wrote, and sends everything both wrote.
 * - Documents of deleted or renamed glyphs stay resident while history
 *   names them, so their undo has a document to write into.
 */

const { Font } = require('../js/babelfont-model');
const { PatchSyncEngine } = require('../js/patch-sync-engine');

function drawing(id) {
    return {
        id,
        width: 500,
        master: { type: 'DefaultForMaster', master: 'm1' },
        shapes: [],
        anchors: []
    };
}

function makeFont() {
    return {
        upm: 1000,
        version: [1, 0],
        names: { familyName: 'Prepare' },
        axes: [],
        masters: [{ id: 'm1', name: { dflt: 'm1' }, location: {} }],
        glyphs: ['A', 'B'].map((name) => ({
            name,
            id: `id-${name.toLowerCase()}`,
            production_name: null,
            category: 'Base',
            codepoints: [],
            exported: true,
            layers: [drawing('m1')]
        }))
    };
}

let engine;
let previousBridge;
let events;
const onBlocked = (event) => events.push(['blocked', event.detail]);
const onFailed = (event) => events.push(['failed', event.detail]);

beforeEach(() => {
    previousBridge = window.patchSyncEngine;
    engine = new PatchSyncEngine('history-prepare');
    engine.initFromJson(makeFont());
    window.patchSyncEngine = engine;
    events = [];
    window.addEventListener('history-replay-blocked', onBlocked);
    window.addEventListener('history-replay-failed', onFailed);
});

afterEach(() => {
    window.removeEventListener('history-replay-blocked', onBlocked);
    window.removeEventListener('history-replay-failed', onFailed);
    engine.destroy();
    window.patchSyncEngine = previousBridge;
});

const familyName = () => engine.getYValue(['names', 'familyName']);
const widthOfA = () =>
    engine.getYValue(['glyphs', 'A', 'layers', 'm1', 'width']);

/** One history item that writes font-core and glyph A. */
function editCoreAndGlyph() {
    engine.beginTransaction('Edit both', null, {
        compileChangeSource: 'test-sync',
        compileEditType: null
    });
    engine.recordChange(['names'], 'familyName', 'Prepare', 'Changed');
    engine.recordChange(['glyphs', 'A', 'layers', 'm1'], 'width', 500, 600);
    engine.endTransaction();
}

describe('residency of glyphs history names', () => {
    test('a deleted glyph’s document stays while its delete can be undone', () => {
        const glyphId = engine._glyphIdByName.get('A');
        Font.fromData(engine.getFontJsonSnapshot()).deleteGlyphs(['A']);
        // Its name is forgotten for its id once the delete is flushed.
        expect(engine._glyphNameById.has(glyphId)).toBe(false);

        const unloaded = engine.unloadCleanGlyphDocuments([], {
            ignorePeers: true
        });
        expect(unloaded).not.toContain(glyphId);
        expect(engine.hasResidentGlyphDocument(`glyph:${glyphId}`)).toBe(true);

        expect(engine.undo()).not.toBeNull();
        expect(engine._glyphIdByName.get('A')).toBe(glyphId);
        expect(
            engine.getFontJsonSnapshot().glyphs.map((glyph) => glyph.name)
        ).toContain('A');
    });

    test('a renamed glyph’s document stays while its rename can be undone', () => {
        const glyphId = engine._glyphIdByName.get('A');
        Font.fromData(engine.getFontJsonSnapshot()).renameGlyphs(
            new Map([['A', 'A.alt']])
        );
        expect(engine._glyphIdByName.get('A.alt')).toBe(glyphId);

        const unloaded = engine.unloadCleanGlyphDocuments([], {
            ignorePeers: true
        });
        expect(unloaded).not.toContain(glyphId);

        expect(engine.undo()).not.toBeNull();
        expect(engine._glyphIdByName.get('A')).toBe(glyphId);
        expect(
            engine._docForId(`glyph:${glyphId}`).getMap('glyph').get('name')
        ).toBe('A');
    });
});

describe('undo refused before anything is written', () => {
    test('a document the item writes is not held: no write, history unmoved', () => {
        editCoreAndGlyph();
        expect(familyName()).toBe('Changed');
        const glyphId = engine._glyphIdByName.get('A');
        // The glyph's document went away (it can only be loaded again).
        engine._glyphDocs.get(glyphId).destroy();
        engine._glyphDocs.delete(glyphId);
        const logLength = engine.getChangeLog().length;

        expect(engine.undo()).toBeNull();
        // Font-core was not written either, and the history did not move.
        expect(familyName()).toBe('Changed');
        expect(engine.getChangeLog()).toHaveLength(logLength);
        expect(engine.hasUnsentLocalUpdates()).toBe(false);
        expect(events).toEqual([
            [
                'blocked',
                expect.objectContaining({
                    reason: 'document-not-loaded',
                    historyAction: 'undo',
                    documentIds: [`glyph:${glyphId}`]
                })
            ]
        ]);
    });

    test('a value a drawing may not hold is refused before font-core is written', () => {
        editCoreAndGlyph();
        const item = engine
            .getChangeLog()
            .filter((entry) => entry.path.includes('width'));
        // A broken history entry: undoing it would delete the width.
        item[0].oldValue = undefined;
        item[0].replayOldValue = undefined;
        const logLength = engine.getChangeLog().length;
        expect(() => engine.undo()).toThrow(/would lose width/);
        expect(familyName()).toBe('Changed');
        expect(engine.getChangeLog()).toHaveLength(logLength);
    });
});

describe('undo that fails part way', () => {
    test('takes the history entry back, restores font-core and sends what it wrote', () => {
        editCoreAndGlyph();
        const sent = [];
        engine.onLocalUpdate((update, message, entries, documentId) =>
            sent.push({ documentId, entries })
        );
        const logLength = engine.getChangeLog().length;
        const replayEntry = engine._applyHistoryReplayEntry.bind(engine);
        jest.spyOn(engine, '_applyHistoryReplayEntry').mockImplementation(
            (entry, direction, renames) => {
                if (direction === 'undo' && entry.path.includes('width')) {
                    throw new Error('glyph write failed');
                }
                return replayEntry(entry, direction, renames);
            }
        );

        expect(() => engine.undo()).toThrow('glyph write failed');
        // Font-core was undone first, then put back.
        expect(familyName()).toBe('Changed');
        expect(widthOfA()).toBe(600);
        // The history did not move: the item can still be undone.
        expect(engine.getChangeLog()).toHaveLength(logLength);
        // Nothing waits for an unrelated commit to carry it.
        expect(engine.hasUnsentLocalUpdates()).toBe(false);
        expect(sent.map((packet) => packet.documentId)).toContain('font-core');
        expect(events).toEqual([
            [
                'failed',
                expect.objectContaining({
                    historyAction: 'undo',
                    reason: 'glyph write failed',
                    documentIdsNotRolledBack: []
                })
            ]
        ]);

        engine._applyHistoryReplayEntry.mockRestore();
        expect(engine.undo()).not.toBeNull();
        expect(familyName()).toBe('Prepare');
        expect(widthOfA()).toBe(500);
    });

    test('linked windows still get the next entry after the taken-back one', () => {
        editCoreAndGlyph();
        engine.getNewChangeLogEntries();
        const replayEntry = engine._applyHistoryReplayEntry.bind(engine);
        jest.spyOn(engine, '_applyHistoryReplayEntry').mockImplementation(
            (entry, direction, renames) => {
                if (direction === 'undo' && entry.path.includes('width')) {
                    // WindowSync took the undo entry with font-core's update.
                    const broadcast = engine.getNewChangeLogEntries();
                    expect(broadcast.map((e) => e.historyAction)).toEqual([
                        'undo'
                    ]);
                    throw new Error('glyph write failed');
                }
                return replayEntry(entry, direction, renames);
            }
        );
        expect(() => engine.undo()).toThrow('glyph write failed');
        engine._applyHistoryReplayEntry.mockRestore();

        engine.recordChange(['names'], 'familyName', 'Changed', 'Next');
        const next = engine.getNewChangeLogEntries();
        expect(next.map((entry) => entry.newValue)).toContain('Next');
    });
});
