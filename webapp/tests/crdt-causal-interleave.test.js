const Y = require('yjs');

function snapshotDrawing(doc) {
    const drawing = doc.getMap('layer');
    return {
        width: drawing.get('width'),
        deleted: drawing.get('deleted') === true,
        reversed: drawing.get('reversed') === true
    };
}

function exchange(fromDoc, toDoc) {
    const update = Y.encodeStateAsUpdate(fromDoc, Y.encodeStateVector(toDoc));
    if (update.byteLength) {
        Y.applyUpdate(toDoc, update);
    }
}

describe('independent Y.Doc causal interleaving', () => {
    test('delete, width, and reverse converge regardless of delivery order', () => {
        const seed = new Y.Doc();
        seed.getMap('layer').set('width', 500);
        seed.getMap('layer').set('deleted', false);
        seed.getMap('layer').set('reversed', false);
        const seedUpdate = Y.encodeStateAsUpdate(seed);

        const applySeed = () => {
            const doc = new Y.Doc();
            Y.applyUpdate(doc, seedUpdate);
            return doc;
        };

        const a = applySeed();
        const b = applySeed();
        a.getMap('layer').set('deleted', true);
        b.getMap('layer').set('width', 640);
        b.getMap('layer').set('reversed', true);

        const aThenB = applySeed();
        exchange(a, aThenB);
        exchange(b, aThenB);

        const bThenA = applySeed();
        exchange(b, bThenA);
        exchange(a, bThenA);

        expect(snapshotDrawing(aThenB)).toEqual(snapshotDrawing(bThenA));
        expect(snapshotDrawing(aThenB)).toEqual({
            width: 640,
            deleted: true,
            reversed: true
        });
    });
});
