/**
 * A whole anchor, guide or feature written to an entry that exists changes
 * the fields inside its map; the map is never replaced. A replaced map
 * survives a collaborator’s concurrent delete of the entry, which leaves an
 * entry the order doesn’t list, and every reader then marks the document
 * broken. Features read back without a tag or code throw.
 */

const Y = require('yjs');
const {
    applyIndexedMapArray,
    deleteYPath,
    drawingToYMap,
    fromYType,
    setYPath
} = require('../js/change-bridge-ydoc');

function anchoredDoc(clientID) {
    const doc = new Y.Doc({ gc: false });
    if (clientID !== undefined) {
        doc.clientID = clientID;
    }
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
                anchors: [
                    { id: 'a1', name: 'top', x: 1, y: 2 },
                    { id: 'a2', name: 'bottom', x: 3, y: 4 }
                ],
                guides: [{ id: 'g1', pos: { x: 1, y: 2, angle: 0 } }]
            })
        );
    });
    return doc;
}

const DRAWING = ['glyphs', 'A', 'layers', 'd1'];

function drawingOf(doc) {
    return doc.getMap('font').get('glyphs').get('A').get('layers').get('d1');
}

function write(doc, path, value) {
    doc.transact(() =>
        setYPath(doc.getMap('font'), [...DRAWING, ...path], value)
    );
}

function sync(a, b) {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe('a whole entry written to an existing anchor or guide', () => {
    test.each([
        ['by index', ['anchors', 0]],
        ['by id', ['anchors', 'a1']],
        ['through anchorsById', ['anchorsById', 'a1']]
    ])('%s changes the fields in the same map', (_label, path) => {
        const doc = anchoredDoc();
        const before = drawingOf(doc).get('anchorsById').get('a1');
        write(doc, path, { id: 'a1', name: 'top', x: 50, y: 2 });
        const after = drawingOf(doc).get('anchorsById').get('a1');
        expect(after).toBe(before);
        expect(after.toJSON()).toEqual({ id: 'a1', name: 'top', x: 50, y: 2 });
        expect(fromYType(drawingOf(doc)).anchors).toEqual([
            { id: 'a1', name: 'top', x: 50, y: 2 },
            { id: 'a2', name: 'bottom', x: 3, y: 4 }
        ]);
    });

    test('a guide written by index keeps its map', () => {
        const doc = anchoredDoc();
        const before = drawingOf(doc).get('guidesById').get('g1');
        write(doc, ['guides', 0], { id: 'g1', pos: { x: 9, y: 2, angle: 0 } });
        expect(drawingOf(doc).get('guidesById').get('g1')).toBe(before);
        expect(before.toJSON()).toEqual({
            id: 'g1',
            pos: { x: 9, y: 2, angle: 0 }
        });
    });

    test.each([
        [
            'an anchor',
            ['anchors', 0],
            ['anchors', 0],
            { id: 'a1', name: 'top', x: 50, y: 2 }
        ],
        [
            'a guide',
            ['guides', 0],
            ['guides', 0],
            { id: 'g1', pos: { x: 9, y: 2, angle: 0 } }
        ]
    ])(
        '%s edited while a collaborator deletes it leaves both halves agreeing',
        (_label, editPath, deletePath, value) => {
            const a = anchoredDoc(1);
            const b = new Y.Doc({ gc: false });
            b.clientID = 2;
            Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
            write(a, editPath, value);
            b.transact(() =>
                deleteYPath(b.getMap('font'), [...DRAWING, ...deletePath])
            );
            sync(a, b);
            for (const doc of [a, b]) {
                expect(() => fromYType(drawingOf(doc))).not.toThrow();
            }
            expect(fromYType(drawingOf(a))).toEqual(fromYType(drawingOf(b)));
        }
    );

    test('a new id at an index the order holds is inserted there, in both halves', () => {
        const doc = anchoredDoc();
        write(doc, ['anchors', 1], { id: 'a3', name: 'center', x: 0, y: 0 });
        const drawing = drawingOf(doc);
        expect(drawing.get('anchorOrder').toArray()).toEqual([
            'a1',
            'a3',
            'a2'
        ]);
        expect(drawing.get('anchorsById').get('a1').toJSON()).toEqual({
            id: 'a1',
            name: 'top',
            x: 1,
            y: 2
        });
        expect(fromYType(drawing).anchors.map((anchor) => anchor.id)).toEqual([
            'a1',
            'a3',
            'a2'
        ]);
    });

    test('an entry without its id, or with the id of another place, is refused', () => {
        const doc = anchoredDoc();
        expect(() =>
            write(doc, ['anchors', 0], { name: 'top', x: 5, y: 2 })
        ).toThrow(/has no id/);
        expect(() =>
            write(doc, ['anchors', 0], { id: 'a2', name: 'bottom', x: 5, y: 2 })
        ).toThrow(/stored at another place/);
        expect(() =>
            write(doc, ['anchors', 'a1'], { id: 'a2', name: 'top', x: 5, y: 2 })
        ).toThrow(/whose id is “a1”/);
        expect(fromYType(drawingOf(doc)).anchors[0]).toEqual({
            id: 'a1',
            name: 'top',
            x: 1,
            y: 2
        });
    });

    test('an order id whose entry a collaborator deleted is dropped before an index write, never taken as a free slot', () => {
        const doc = anchoredDoc();
        doc.transact(() => drawingOf(doc).get('anchorsById').delete('a1'));
        // Readers list [a2]; index 0 means a2, and a new id there is a
        // new entry inserted before it.
        write(doc, ['anchors', 0], { id: 'a9', name: 'top', x: 5, y: 2 });
        expect(drawingOf(doc).get('anchorOrder').toArray()).toEqual([
            'a9',
            'a2'
        ]);
        expect(fromYType(drawingOf(doc)).anchors.map((a) => a.id)).toEqual([
            'a9',
            'a2'
        ]);
    });

    test('a whole list never replaces an entry that is not a map', () => {
        const doc = anchoredDoc();
        doc.transact(() => drawingOf(doc).get('anchorsById').set('a1', 7));
        expect(() =>
            doc.transact(() =>
                applyIndexedMapArray(drawingOf(doc), 'anchors', [
                    { id: 'a1', name: 'top', x: 1, y: 2 },
                    { id: 'a2', name: 'bottom', x: 3, y: 4 }
                ])
            )
        ).toThrow(/anchors entry “a1” is not a map/);
    });
});

describe('features', () => {
    function featureDoc() {
        const doc = new Y.Doc();
        const features = new Y.Map();
        doc.getMap('root').set('features', features);
        doc.transact(() => {
            applyIndexedMapArray(features, 'features', [
                ['liga', 'sub f i by f_i;'],
                ['kern', 'pos A V -50;']
            ]);
        });
        return { doc, features };
    }

    test.each(['tag', 'code'])(
        'a feature without its %s throws on read',
        (field) => {
            const { doc, features } = featureDoc();
            const id = features.get('featureOrder').get(0);
            doc.transact(() =>
                features.get('featuresById').get(id).delete(field)
            );
            expect(() => fromYType(features)).toThrow(
                new RegExp(`feature ${id} has no ${field}`)
            );
        }
    );

    test('a feature written by index changes its map in place', () => {
        const { doc, features } = featureDoc();
        const id = features.get('featureOrder').get(1);
        const before = features.get('featuresById').get(id);
        doc.transact(() =>
            setYPath(
                doc.getMap('root'),
                ['features', 'features', 1],
                ['kern', 'pos A V -60;']
            )
        );
        expect(features.get('featuresById').get(id)).toBe(before);
        expect(fromYType(features).features).toEqual([
            ['liga', 'sub f i by f_i;'],
            ['kern', 'pos A V -60;']
        ]);
    });

    test('a feature added past the end is a map with its tag and code', () => {
        const { doc, features } = featureDoc();
        doc.transact(() =>
            setYPath(
                doc.getMap('root'),
                ['features', 'features', 2],
                ['calt', 'sub a by a.alt;']
            )
        );
        const order = features.get('featureOrder').toArray();
        expect(order).toHaveLength(3);
        expect(new Set(order).size).toBe(3);
        expect(fromYType(features).features).toEqual([
            ['liga', 'sub f i by f_i;'],
            ['kern', 'pos A V -50;'],
            ['calt', 'sub a by a.alt;']
        ]);
    });

    test.each([
        ['tag', [undefined, 'sub a by b;']],
        ['code', ['calt']]
    ])(
        'a feature written without its %s is refused, never filled in',
        (field, value) => {
            const { doc, features } = featureDoc();
            expect(() =>
                doc.transact(() =>
                    applyIndexedMapArray(features, 'features', [
                        ['liga', 'sub f i by f_i;'],
                        value
                    ])
                )
            ).toThrow(new RegExp(`has no ${field}`));
            expect(() =>
                doc.transact(() =>
                    setYPath(
                        doc.getMap('root'),
                        ['features', 'features', 2],
                        value
                    )
                )
            ).toThrow(new RegExp(`has no ${field}`));
        }
    );
});

describe('adding an anchor past the end', () => {
    test('an anchor with a new id is added to both halves', () => {
        const doc = anchoredDoc();
        write(doc, ['anchors', 2], { id: 'a3', name: 'mid', x: 5, y: 6 });
        expect(drawingOf(doc).get('anchorOrder').toArray()).toEqual([
            'a1',
            'a2',
            'a3'
        ]);
        expect(fromYType(drawingOf(doc)).anchors[2]).toEqual({
            id: 'a3',
            name: 'mid',
            x: 5,
            y: 6
        });
    });

    test('an anchor without an id is refused', () => {
        const doc = anchoredDoc();
        expect(() =>
            write(doc, ['anchors', 2], { name: 'mid', x: 5, y: 6 })
        ).toThrow(/has no id/);
        expect(drawingOf(doc).get('anchorOrder').toArray()).toEqual([
            'a1',
            'a2'
        ]);
    });

    test('an id the pair already holds is refused, never listed twice', () => {
        const doc = anchoredDoc();
        const before = drawingOf(doc).get('anchorsById').get('a1');
        expect(() =>
            write(doc, ['anchors', 2], { id: 'a1', name: 'top', x: 9, y: 9 })
        ).toThrow(/already in the list/);
        expect(drawingOf(doc).get('anchorOrder').toArray()).toEqual([
            'a1',
            'a2'
        ]);
        expect(drawingOf(doc).get('anchorsById').get('a1')).toBe(before);
    });

    test('a whole list with one id twice is refused', () => {
        const doc = anchoredDoc();
        expect(() =>
            write(
                doc,
                ['anchors'],
                [
                    { id: 'a1', name: 'top', x: 1, y: 2 },
                    { id: 'a1', name: 'again', x: 3, y: 4 }
                ]
            )
        ).toThrow(/appears twice/);
    });

    test('a new drawing with one anchor id twice is refused', () => {
        expect(() =>
            drawingToYMap({
                id: 'd2',
                width: 500,
                master: { type: 'DefaultForMaster', master: 'm1' },
                shapes: [],
                anchors: [
                    { id: 'a1', x: 1, y: 2 },
                    { id: 'a1', x: 3, y: 4 }
                ]
            })
        ).toThrow(/appears twice/);
    });
});
