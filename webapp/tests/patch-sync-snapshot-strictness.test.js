/**
 * Glyph snapshots written by PatchSyncEngine fill nothing in: a glyph that
 * ends up without a category is refused, and a drawing snapshot with
 * `anchors: null` empties the anchors without deleting their keyed maps
 * (a map created again later would race a collaborator’s).
 */

const { PatchSyncEngine } = require('../js/patch-sync-engine');
const { fromYType } = require('../js/change-bridge-ydoc');

function drawing(id, extra = {}) {
    return {
        id,
        width: 500,
        master: { type: 'DefaultForMaster', master: 'm1' },
        shapes: [],
        anchors: [],
        ...extra
    };
}

function makeFont() {
    return {
        upm: 1000,
        version: [1, 0],
        names: { familyName: 'Strict' },
        axes: [],
        masters: [{ id: 'm1', name: { dflt: 'm1' }, location: {} }],
        glyphs: [
            {
                name: 'A',
                production_name: null,
                category: 'Base',
                codepoints: [],
                exported: true,
                layers: [
                    drawing('m1', {
                        anchors: [{ id: 'top', name: 'top', x: 1, y: 2 }]
                    })
                ]
            }
        ]
    };
}

function setup(label) {
    const engine = new PatchSyncEngine(label);
    engine.initFromJson(makeFont());
    window.changeBridge = engine;
    return engine;
}

afterEach(() => {
    delete window.changeBridge;
});

describe('glyph snapshot strictness', () => {
    test('a new glyph without a category is refused, never given one', () => {
        const engine = setup('snapshot-no-category');
        const errors = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        expect(() =>
            engine.recordAdd(['glyphs', 'Z'], { name: 'Z', layers: [] })
        ).toThrow(/it has no category/);
        errors.mockRestore();
        const glyph = engine
            .getFontJsonSnapshot()
            .glyphs.find((entry) => entry.name === 'Z');
        expect(glyph?.category).toBeUndefined();
    });

    test('a new glyph with a category is written', () => {
        const engine = setup('snapshot-category');
        engine.recordAdd(['glyphs', 'Z'], {
            name: 'Z',
            category: 'Mark',
            layers: []
        });
        const glyph = engine
            .getFontJsonSnapshot()
            .glyphs.find((entry) => entry.name === 'Z');
        expect(glyph.category).toBe('Mark');
    });

    test('a snapshot with anchors: null empties the anchors and keeps their maps', () => {
        const engine = setup('snapshot-null-anchors');
        const drawingPath = ['glyphs', 'A', 'layers', 'm1'];
        const before = engine.getYValue([...drawingPath, 'anchorsById']);
        const glyph = engine
            .getFontJsonSnapshot()
            .glyphs.find((entry) => entry.name === 'A');
        const next = JSON.parse(JSON.stringify(glyph));
        next.layers[0].anchors = null;
        engine.recordChange(['glyphs'], 'A', glyph, next);
        expect(engine.getYValue([...drawingPath, 'anchorsById'])).toBe(before);
        expect(fromYType(engine.getYValue(drawingPath)).anchors).toEqual([]);
    });
    test('a drawing delta with anchors: null empties the anchors and keeps their maps', () => {
        const engine = setup('delta-null-anchors');
        const drawingPath = ['glyphs', 'A', 'layers', 'm1'];
        const byIdBefore = engine.getYValue([...drawingPath, 'anchorsById']);
        const orderBefore = engine.getYValue([...drawingPath, 'anchorOrder']);
        expect(byIdBefore).toBeDefined();
        engine._applyDrawingDelta('A', 'm1', { anchors: null });
        expect(engine.getYValue([...drawingPath, 'anchorsById'])).toBe(
            byIdBefore
        );
        expect(engine.getYValue([...drawingPath, 'anchorOrder'])).toBe(
            orderBefore
        );
        expect(fromYType(engine.getYValue(drawingPath)).anchors).toEqual([]);
    });
});
