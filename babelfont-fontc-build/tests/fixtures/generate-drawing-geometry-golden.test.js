/**
 * Regenerates `drawing-geometry-golden.expected.json`: the Y.Doc JSON the
 * webapp's own writers make from `drawing-geometry-golden.input.json`. The
 * Rust test `drawing_geometry_matches_the_js_golden_fixture` writes the same
 * drawings with the worker and must produce the same JSON.
 *
 * Run from editor/webapp:
 *   npx jest --rootDir . --roots ../babelfont-fontc-build/tests/fixtures \
 *     generate-drawing-geometry-golden
 */
const fs = require('fs');
const path = require('path');
// yjs is the webapp's, the same instance change-bridge-ydoc uses.
const Y = require('../../../webapp/node_modules/yjs');
const {
    applyDrawingDelta,
    drawingToYMap
} = require('../../../webapp/js/change-bridge-ydoc');

const inputPath = path.join(__dirname, 'drawing-geometry-golden.input.json');
const expectedPath = path.join(
    __dirname,
    'drawing-geometry-golden.expected.json'
);

test('writes the JS golden Y.Doc JSON for the worker test', () => {
    const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const doc = new Y.Doc();
    const glyph = doc.getMap('glyph');
    let created;
    let rewritten;
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
    created = glyph.get('layers').get(input.drawingId).toJSON();
    doc.transact(() => {
        applyDrawingDelta(
            glyph,
            input.glyphName,
            input.drawingId,
            clone(input.rewritten)
        );
    });
    rewritten = glyph.get('layers').get(input.drawingId).toJSON();
    fs.writeFileSync(
        expectedPath,
        `${JSON.stringify({ created, rewritten }, null, 4)}\n`
    );
});
