/**
 * Keyed pairs (`*ById` + `*Order`) under concurrent editing, with simulated
 * Yjs merges. Moving an entry deletes its id from the order and inserts it
 * again (an LCS diff), so a collaborator’s concurrent delete of that entry
 * leaves the new place behind without an entry, and two concurrent moves of
 * one entry list it twice. Both are normal results of concurrent editing:
 * readers skip the id (the delete wins) or read it once, and the next write
 * of the pair drops it. An entry the order does not list stays damage: no
 * interleaving of writers leaves one.
 */

const Y = require('yjs');
const {
    applyIndexedMapArray,
    deleteYPath,
    drawingToYMap,
    fromYType,
    getYPath
} = require('../js/change-bridge-ydoc');

function glyphDoc(clientID) {
    const doc = new Y.Doc({ gc: false });
    doc.clientID = clientID;
    doc.transact(() => {
        const font = doc.getMap('font');
        const glyphs = new Y.Map();
        font.set('glyphs', glyphs);
        const glyph = new Y.Map();
        glyphs.set('A', glyph);
        glyph.set('name', 'A');
        const drawings = new Y.Map();
        glyph.set('layers', drawings);
        glyph.set('layerOrder', Y.Array.from(['d1']));
        drawings.set(
            'd1',
            drawingToYMap({
                id: 'd1',
                width: 500,
                master: { type: 'DefaultForMaster', master: 'm1' },
                shapes: [],
                anchors: ['x', 'y', 'z'].map((id, index) => anchor(id, index))
            })
        );
    });
    return doc;
}

function anchor(id, x) {
    return { id, name: id, x, y: 0 };
}

function featureDoc(clientID) {
    const doc = new Y.Doc({ gc: false });
    doc.clientID = clientID;
    const features = new Y.Map();
    doc.getMap('root').set('features', features);
    doc.transact(() => {
        applyIndexedMapArray(features, 'features', [
            { id: 'X', tag: 'liga', code: 'sub f i by f_i;' },
            { id: 'Y', tag: 'kern', code: 'pos A V -50;' },
            { id: 'Z', tag: 'calt', code: 'sub a by a.alt;' }
        ]);
    });
    return doc;
}

function featuresOf(doc) {
    return doc.getMap('root').get('features');
}

function drawingOf(doc) {
    return doc.getMap('font').get('glyphs').get('A').get('layers').get('d1');
}

function fork(doc, clientID) {
    const copy = new Y.Doc({ gc: false });
    copy.clientID = clientID;
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    return copy;
}

function sync(...docs) {
    for (const from of docs) {
        for (const to of docs) {
            if (from !== to) {
                Y.applyUpdate(
                    to,
                    Y.encodeStateAsUpdate(from, Y.encodeStateVector(to))
                );
            }
        }
    }
}

function anchorIds(doc) {
    return fromYType(drawingOf(doc)).anchors.map((entry) => entry.id);
}

function writeAnchors(doc, ids) {
    doc.transact(() =>
        applyIndexedMapArray(
            drawingOf(doc),
            'anchors',
            ids.map((id, index) => anchor(id, index))
        )
    );
}

function traceEvents(kind) {
    return window.__collabTrace.entries.filter((entry) => entry.kind === kind);
}

beforeEach(() => {
    window.__collabTrace = { enabled: true, entries: [] };
});

afterEach(() => {
    delete window.__collabTrace;
});

describe('a concurrent delete and move of one entry', () => {
    test('features: the delete wins on every client, and the next write drops the id', () => {
        const a = featureDoc(1);
        const b = fork(a, 2);
        // A deletes X; B moves X after Z.
        a.transact(() =>
            applyIndexedMapArray(featuresOf(a), 'features', [
                { id: 'Y', tag: 'kern', code: 'pos A V -50;' },
                { id: 'Z', tag: 'calt', code: 'sub a by a.alt;' }
            ])
        );
        b.transact(() =>
            applyIndexedMapArray(featuresOf(b), 'features', [
                { id: 'Y', tag: 'kern', code: 'pos A V -50;' },
                { id: 'Z', tag: 'calt', code: 'sub a by a.alt;' },
                { id: 'X', tag: 'liga', code: 'sub f i by f_i;' }
            ])
        );
        sync(a, b);

        for (const doc of [a, b]) {
            // The merge leaves B’s new place of X without its entry.
            expect(featuresOf(doc).get('featureOrder').toArray()).toContain(
                'X'
            );
            expect(featuresOf(doc).get('featuresById').has('X')).toBe(false);
            expect(fromYType(featuresOf(doc)).features).toEqual([
                ['kern', 'pos A V -50;'],
                ['calt', 'sub a by a.alt;']
            ]);
            expect(
                getYPath(doc.getMap('root'), ['features', 'features'])
            ).toEqual([
                ['kern', 'pos A V -50;'],
                ['calt', 'sub a by a.alt;']
            ]);
        }
        const skipped = traceEvents('keyed-pair-order-skipped');
        expect(skipped.length).toBeGreaterThan(0);
        expect(skipped[0].detail).toEqual({
            order: 'featureOrder',
            deleted: ['X'],
            repeated: []
        });

        // Writing back what was read drops the stale id from the order.
        a.transact(() =>
            applyIndexedMapArray(
                featuresOf(a),
                'features',
                fromYType(featuresOf(a)).features
            )
        );
        expect(featuresOf(a).get('featureOrder').toArray()).toEqual(['Y', 'Z']);
        expect(traceEvents('keyed-pair-order-tidied')[0].detail).toEqual({
            order: 'featureOrder',
            deleted: ['X'],
            repeated: []
        });
        sync(a, b);
        expect(featuresOf(b).get('featureOrder').toArray()).toEqual(['Y', 'Z']);
    });

    test('anchors: the delete wins, and index paths mean what readers list', () => {
        const a = glyphDoc(1);
        const b = fork(a, 2);
        writeAnchors(a, ['y', 'z']);
        writeAnchors(b, ['y', 'z', 'x']);
        sync(a, b);
        expect(anchorIds(a)).toEqual(['y', 'z']);
        expect(anchorIds(b)).toEqual(['y', 'z']);
        expect(
            traceEvents('keyed-pair-order-skipped').map((e) => e.glyphs)
        ).toContainEqual(['A']);

        // Index 1 is z for readers; deleting it removes z, not the stale x.
        b.transact(() =>
            deleteYPath(b.getMap('font'), [
                'glyphs',
                'A',
                'layers',
                'd1',
                'anchors',
                1
            ])
        );
        expect(anchorIds(b)).toEqual(['y']);
        expect(drawingOf(b).get('anchorOrder').toArray()).toEqual(['y']);
        expect(
            getYPath(b.getMap('font'), [
                'glyphs',
                'A',
                'layers',
                'd1',
                'anchors',
                0,
                'name'
            ])
        ).toBe('y');
    });
});

describe('two concurrent moves of one entry', () => {
    test('the id is read once, written back without error, and the write dedupes it', () => {
        const a = glyphDoc(1);
        const b = fork(a, 2);
        writeAnchors(a, ['y', 'x', 'z']);
        writeAnchors(b, ['y', 'z', 'x']);
        sync(a, b);
        const order = drawingOf(a).get('anchorOrder').toArray();
        expect(order.filter((id) => id === 'x')).toHaveLength(2);
        expect(anchorIds(a)).toEqual(anchorIds(b));
        expect(new Set(anchorIds(a)).size).toBe(3);
        expect(
            traceEvents('keyed-pair-order-skipped')[0].detail.repeated
        ).toEqual(['x']);

        // A whole list read back is written without “appears twice”.
        const read = fromYType(drawingOf(a)).anchors;
        a.transact(() => applyIndexedMapArray(drawingOf(a), 'anchors', read));
        expect(drawingOf(a).get('anchorOrder').toArray()).toEqual(
            read.map((entry) => entry.id)
        );
        sync(a, b);
        expect(drawingOf(b).get('anchorOrder').toArray()).toEqual(
            read.map((entry) => entry.id)
        );
    });

    test('two clients deduping at once keep the entry listed', () => {
        const a = glyphDoc(1);
        const b = fork(a, 2);
        writeAnchors(a, ['y', 'x', 'z']);
        writeAnchors(b, ['y', 'z', 'x']);
        sync(a, b);
        const c = fork(a, 3);
        const d = fork(a, 4);
        // Both write the list they read, moving y to the end on one side.
        const read = anchorIds(c);
        writeAnchors(c, read);
        writeAnchors(d, [...read.filter((id) => id !== 'y'), 'y']);
        sync(c, d);
        expect(anchorIds(c)).toEqual(anchorIds(d));
        expect([...anchorIds(c)].sort()).toEqual(['x', 'y', 'z']);
    });
});

describe('no interleaving leaves an entry the order does not list', () => {
    test('a concurrent add and reorder keep the new entry listed', () => {
        const a = glyphDoc(1);
        const b = fork(a, 2);
        writeAnchors(a, ['x', 'y', 'z', 'n']);
        writeAnchors(b, ['z', 'y', 'x']);
        sync(a, b);
        expect(anchorIds(a)).toEqual(anchorIds(b));
        expect([...anchorIds(a)].sort()).toEqual(['n', 'x', 'y', 'z']);
    });

    test('re-adding an entry whose stale id the order lists, while another client drops that id, keeps it listed', () => {
        // Reach the stale state: A deletes x while B moves it.
        const a = glyphDoc(1);
        const b = fork(a, 2);
        writeAnchors(a, ['y', 'z']);
        writeAnchors(b, ['y', 'z', 'x']);
        sync(a, b);
        expect(drawingOf(a).get('anchorOrder').toArray()).toContain('x');
        // C still holds x in its model and writes it back; D writes what
        // it reads, which drops the stale x.
        const c = fork(a, 3);
        const d = fork(a, 4);
        writeAnchors(c, ['y', 'z', 'x']);
        writeAnchors(d, anchorIds(d));
        sync(c, d);
        for (const doc of [c, d]) {
            expect(() => fromYType(drawingOf(doc))).not.toThrow();
            expect(anchorIds(doc)).toEqual(['y', 'z', 'x']);
        }
    });

    test('editing an entry while a collaborator deletes it leaves no unlisted entry (the delete wins)', () => {
        const a = glyphDoc(1);
        const b = fork(a, 2);
        // A edits y in place; B deletes y.
        a.transact(() =>
            applyIndexedMapArray(drawingOf(a), 'anchors', [
                anchor('x', 0),
                { id: 'y', name: 'y', x: 99, y: 7 },
                anchor('z', 2)
            ])
        );
        writeAnchors(b, ['x', 'z']);
        sync(a, b);
        for (const doc of [a, b]) {
            expect(() => fromYType(drawingOf(doc))).not.toThrow();
            expect(anchorIds(doc)).toEqual(['x', 'z']);
        }
    });

    test('two clients re-adding a deleted entry at once read it once', () => {
        const a = glyphDoc(1);
        const b = fork(a, 2);
        writeAnchors(a, ['y', 'z']);
        writeAnchors(b, ['y', 'z', 'x']);
        sync(a, b);
        const c = fork(a, 3);
        const d = fork(a, 4);
        writeAnchors(c, ['y', 'z', 'x']);
        writeAnchors(d, ['x', 'y', 'z']);
        sync(c, d);
        expect(anchorIds(c)).toEqual(anchorIds(d));
        expect([...anchorIds(c)].sort()).toEqual(['x', 'y', 'z']);
        writeAnchors(c, anchorIds(c));
        sync(c, d);
        expect(drawingOf(d).get('anchorOrder').toArray().sort()).toEqual([
            'x',
            'y',
            'z'
        ]);
    });

    test('an entry the order does not list is still damage', () => {
        const a = glyphDoc(1);
        a.transact(() => drawingOf(a).get('anchorOrder').delete(0, 1));
        expect(() => fromYType(drawingOf(a))).toThrow(
            /anchorsById holds anchor id x, which anchorOrder does not list/
        );
        expect(() => writeAnchors(a, ['y', 'z'])).toThrow(/does not list/);
    });
});
