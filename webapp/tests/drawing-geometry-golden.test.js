/**
 * The webapp's drawing writers must keep producing the Y.Doc JSON in
 * `babelfont-fontc-build/tests/fixtures/drawing-geometry-golden.expected.json`.
 * The Rust test `drawing_geometry_matches_the_js_golden_fixture` checks the
 * font worker against the same file, so a change on either side fails on
 * that side. To change the format on purpose, regenerate the file with
 * `generate-drawing-geometry-golden.test.js` in that folder and update the
 * worker to match.
 */
const fs = require('fs');
const path = require('path');
const Y = require('yjs');
const {
    applyDrawingDelta,
    drawingToYMap,
    normalizeValueForYDocWrite
} = require('../js/change-bridge-ydoc');

const fixtures = path.join(
    __dirname,
    '..',
    '..',
    'babelfont-fontc-build',
    'tests',
    'fixtures'
);
const readFixture = (name) =>
    JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

function writeGolden(input) {
    const doc = new Y.Doc();
    const glyph = doc.getMap('glyph');
    doc.transact(() => {
        glyph.set('name', input.glyphName);
        glyph.set('layers', new Y.Map());
        glyph.set('layerOrder', new Y.Array());
    });
    doc.transact(() => {
        glyph
            .get('layers')
            .set(input.drawingId, drawingToYMap(clone(input.created)));
        glyph.get('layerOrder').push([input.drawingId]);
    });
    const created = glyph.get('layers').get(input.drawingId).toJSON();
    doc.transact(() => {
        applyDrawingDelta(
            glyph,
            input.glyphName,
            input.drawingId,
            clone(input.rewritten)
        );
    });
    const rewritten = glyph.get('layers').get(input.drawingId).toJSON();
    return { created, rewritten };
}

describe('drawing geometry golden fixture', () => {
    const input = readFixture('drawing-geometry-golden.input.json');
    const expected = readFixture('drawing-geometry-golden.expected.json');

    test('drawingToYMap writes the golden created drawing', () => {
        expect(writeGolden(input).created).toEqual(expected.created);
    });

    test('applyDrawingDelta writes the golden rewritten drawing', () => {
        expect(writeGolden(input).rewritten).toEqual(expected.rewritten);
    });

    test('the stored topology string matches byte for byte', () => {
        const { created, rewritten } = writeGolden(input);
        expect(created.geometryTopology).toBe(
            expected.created.geometryTopology
        );
        expect(rewritten.geometryTopology).toBe(
            expected.rewritten.geometryTopology
        );
    });

    test.each(['created', 'rewritten'])(
        'a %s path without a closed flag is refused',
        (step) => {
            const broken = clone(input);
            delete broken[step].shapes[0].closed;
            expect(() => writeGolden(broken)).toThrow(/closed flag/);
        }
    );
});

describe('normalizeValueForYDocWrite', () => {
    const nodes = [{ id: 'n1', x: 0, y: 0, nodetype: 'Line' }];

    test.each([
        ['missing', {}],
        ['null', { closed: null }],
        ['a string', { closed: 'false' }]
    ])('refuses a path whose closed flag is %s', (_label, extra) => {
        expect(() => normalizeValueForYDocWrite({ nodes, ...extra })).toThrow(
            /Y\.Doc paths must have a boolean closed flag/
        );
    });

    test('keeps an open path open and returns it unchanged', () => {
        const path = { nodes, closed: false };
        expect(normalizeValueForYDocWrite(path)).toBe(path);
    });

    test('drops runtime keys from a path without touching its flag', () => {
        const normalized = normalizeValueForYDocWrite({
            nodes,
            closed: true,
            _interpolationRequestId: 3
        });
        expect(normalized).toEqual({ nodes, closed: true });
    });
});
