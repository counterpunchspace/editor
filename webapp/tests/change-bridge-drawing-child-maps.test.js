/**
 * A drawing’s keyed child maps (anchors, guides, node positions, shape
 * data) are created together with the drawing, so two collaborators adding
 * the first anchor at once write into the same map instead of competing
 * maps. Readers never fill in a missing stored value: an anchor without its
 * own id, a missing order list, or a shape without its data throws.
 */

const Y = require('yjs');
const {
    applyDrawingDelta,
    applyIndexedMapArray,
    deleteYPath,
    drawingToYMap,
    fromYType,
    getYPath,
    replaceYMapContents,
    setYPath
} = require('../js/change-bridge-ydoc');
const {
    assertDrawingGeometryComplete,
    isYTypeNewInCurrentTransaction,
    writeDrawingGeometry
} = require('../js/drawing-geometry-ydoc');

function drawingJson(extra = {}) {
    return {
        id: 'd1',
        width: 500,
        master: { type: 'DefaultForMaster', master: 'm1' },
        ...extra
    };
}

/** A glyph document holding glyph “A” with one drawing built by `build`. */
function glyphDoc(build, clientID) {
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
        glyph.set('category', 'Base');
        const drawings = new Y.Map();
        glyph.set('layers', drawings);
        glyph.set('layerOrder', Y.Array.from(['d1']));
        drawings.set('d1', build());
    });
    return doc;
}

function drawingOf(doc) {
    return doc.getMap('font').get('glyphs').get('A').get('layers').get('d1');
}

function sync(a, b) {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

function startTrace() {
    window.__collabTrace = { enabled: true, entries: [] };
}

function lateEvents() {
    return window.__collabTrace.entries.filter(
        (entry) => entry.kind === 'drawing-child-map-created-late'
    );
}

afterEach(() => {
    delete window.__collabTrace;
});

describe('child maps are created with the drawing', () => {
    test('a drawing without anchors, guides or shapes still gets every keyed map', () => {
        const doc = glyphDoc(() => drawingToYMap(drawingJson()));
        const map = drawingOf(doc);
        expect(map.get('anchorsById')).toBeInstanceOf(Y.Map);
        expect(map.get('anchorOrder')).toBeInstanceOf(Y.Array);
        expect(map.get('guidesById')).toBeInstanceOf(Y.Map);
        expect(map.get('guideOrder')).toBeInstanceOf(Y.Array);
        expect(map.get('nodePositionsById')).toBeInstanceOf(Y.Map);
        expect(map.get('shapeDataById')).toBeInstanceOf(Y.Map);
        expect(fromYType(map)).toMatchObject({
            anchors: [],
            guides: [],
            shapes: []
        });
    });

    test('two collaborators adding the first anchor at once keep both anchors', () => {
        const a = glyphDoc(() => drawingToYMap(drawingJson()), 1);
        const b = new Y.Doc({ gc: false });
        b.clientID = 2;
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

        a.transact(() =>
            applyIndexedMapArray(drawingOf(a), 'anchors', [
                { id: 'top', name: 'top', x: 1, y: 2 }
            ])
        );
        b.transact(() =>
            setYPath(
                b.getMap('font'),
                ['glyphs', 'A', 'layers', 'd1', 'anchors', 0],
                { id: 'bottom', name: 'bottom', x: 3, y: 4 }
            )
        );
        sync(a, b);

        for (const doc of [a, b]) {
            const names = fromYType(drawingOf(doc))
                .anchors.map((anchor) => anchor.name)
                .sort();
            expect(names).toEqual(['bottom', 'top']);
        }
    });

    test('a drawing created in the running transaction counts as new; a stored one does not', () => {
        const doc = new Y.Doc({ gc: false });
        const root = doc.getMap('root');
        doc.transact(() => {
            const fresh = new Y.Map();
            root.set('fresh', fresh);
            expect(isYTypeNewInCurrentTransaction(fresh)).toBe(true);
        });
        doc.transact(() => {
            expect(isYTypeNewInCurrentTransaction(root.get('fresh'))).toBe(
                false
            );
        });
        expect(isYTypeNewInCurrentTransaction(new Y.Map())).toBe(true);
    });

    test('a drawing stored without anchor maps still takes its first anchor, and that is recorded', () => {
        startTrace();
        // A drawing written before every drawing got its maps.
        const doc = glyphDoc(() => {
            const legacy = new Y.Map();
            legacy.set('id', 'd1');
            legacy.set('width', 500);
            return legacy;
        });
        expect(lateEvents()).toHaveLength(0);
        doc.transact(() =>
            applyIndexedMapArray(drawingOf(doc), 'anchors', [
                { id: 'top', name: 'top', x: 1, y: 2 }
            ])
        );
        expect(drawingOf(doc).get('anchorsById').get('top')).toBeInstanceOf(
            Y.Map
        );
        expect(lateEvents()).toEqual([
            expect.objectContaining({
                glyphs: ['A'],
                detail: { drawing: 'd1', key: 'anchorsById' }
            })
        ]);
    });

    test('geometry and other child maps created late inside a stored drawing are recorded', () => {
        startTrace();
        const doc = glyphDoc(() => {
            const legacy = new Y.Map();
            legacy.set('id', 'd1');
            legacy.set('width', 500);
            return legacy;
        });
        doc.transact(() => writeDrawingGeometry(drawingOf(doc), []));
        doc.transact(() =>
            setYPath(
                doc.getMap('font'),
                [
                    'glyphs',
                    'A',
                    'layers',
                    'd1',
                    'format_specific',
                    'com.example'
                ],
                1
            )
        );
        expect(lateEvents().map((entry) => entry.detail.key)).toEqual([
            'nodePositionsById',
            'shapeDataById',
            'format_specific'
        ]);
    });

    test('a new drawing writes all its maps in its own transaction and records nothing', () => {
        startTrace();
        glyphDoc(() => drawingToYMap(drawingJson({ anchors: [] })));
        expect(lateEvents()).toHaveLength(0);
    });

    test('anchors: null empties the anchors and keeps their maps', () => {
        const doc = glyphDoc(() =>
            drawingToYMap(
                drawingJson({
                    anchors: [{ id: 'top', name: 'top', x: 1, y: 2 }]
                })
            )
        );
        const byIdBefore = drawingOf(doc).get('anchorsById');
        doc.transact(() =>
            applyDrawingDelta(doc.getMap('font'), 'A', 'd1', { anchors: null })
        );
        expect(drawingOf(doc).get('anchorsById')).toBe(byIdBefore);
        expect(fromYType(drawingOf(doc)).anchors).toEqual([]);
    });
});

describe('readers throw instead of filling in', () => {
    test('an anchor without its own id is refused, never given its key', () => {
        const doc = glyphDoc(() => drawingToYMap(drawingJson()));
        doc.transact(() => {
            const anchor = new Y.Map();
            anchor.set('name', 'top');
            drawingOf(doc).get('anchorsById').set('top', anchor);
            drawingOf(doc).get('anchorOrder').push(['top']);
        });
        expect(() => fromYType(drawingOf(doc))).toThrow(
            /Anchor “top” has no id/
        );
    });

    test('an anchor map without its order list is refused', () => {
        const doc = glyphDoc(() => drawingToYMap(drawingJson()));
        doc.transact(() => drawingOf(doc).delete('anchorOrder'));
        expect(() => fromYType(drawingOf(doc))).toThrow(
            /anchorOrder is missing/
        );
        expect(() =>
            doc.transact(() =>
                applyIndexedMapArray(drawingOf(doc), 'anchors', [
                    { id: 'top', name: 'top', x: 1, y: 2 }
                ])
            )
        ).toThrow(/anchorOrder is missing/);
    });

    test('an anchor written straight into anchorsById must carry its key as id', () => {
        const doc = glyphDoc(() => drawingToYMap(drawingJson()));
        expect(() =>
            doc.transact(() =>
                setYPath(
                    doc.getMap('font'),
                    ['glyphs', 'A', 'layers', 'd1', 'anchorsById', 'top'],
                    { name: 'top', x: 1, y: 2 }
                )
            )
        ).toThrow(/must be a map whose id is “top”/);
    });

    test('a path without its stored shape data fails the completeness check', () => {
        const doc = glyphDoc(() =>
            drawingToYMap(
                drawingJson({
                    shapes: [
                        {
                            id: 'p1',
                            closed: true,
                            nodes: [{ id: 'n1', x: 0, y: 0, nodetype: 'Line' }]
                        }
                    ]
                })
            )
        );
        expect(() =>
            assertDrawingGeometryComplete(drawingOf(doc))
        ).not.toThrow();
        doc.transact(() => drawingOf(doc).get('shapeDataById').delete('p1'));
        expect(() => assertDrawingGeometryComplete(drawingOf(doc))).toThrow(
            /Missing data for path p1/
        );
        expect(() => fromYType(drawingOf(doc))).toThrow(
            /Missing data for path p1/
        );
    });
});

describe('anchors and guides stored by an older font worker', () => {
    /** A stored drawing with normalized geometry and a flat anchors list. */
    function flatAnchorDoc() {
        return glyphDoc(() => {
            const legacy = new Y.Map();
            legacy.set('id', 'd1');
            legacy.set('width', 500);
            legacy.set('master', { type: 'DefaultForMaster', master: 'm1' });
            writeDrawingGeometry(legacy, []);
            legacy.set(
                'anchors',
                Y.Array.from([{ id: 'top', name: 'top', x: 1, y: 2 }])
            );
            return legacy;
        });
    }

    test('a flat anchors list is read as stored, never dropped', () => {
        const doc = flatAnchorDoc();
        expect(fromYType(drawingOf(doc)).anchors).toEqual([
            { id: 'top', name: 'top', x: 1, y: 2 }
        ]);
    });

    test('a write of the whole list replaces the flat list with the keyed pair', () => {
        const doc = flatAnchorDoc();
        doc.transact(() =>
            applyDrawingDelta(doc.getMap('font'), 'A', 'd1', {
                anchors: [{ id: 'base', name: 'bottom', x: 3, y: 0 }]
            })
        );
        const map = drawingOf(doc);
        expect(map.has('anchors')).toBe(false);
        expect(map.get('anchorOrder').toArray()).toEqual(['base']);
        expect(fromYType(map).anchors).toEqual([
            { id: 'base', name: 'bottom', x: 3, y: 0 }
        ]);
    });

    test('a partial write next to a flat list is refused instead of hiding it', () => {
        const doc = flatAnchorDoc();
        expect(() =>
            doc.transact(() =>
                setYPath(
                    doc.getMap('font'),
                    ['glyphs', 'A', 'layers', 'd1', 'anchorOrder'],
                    ['top']
                )
            )
        ).toThrow(/stored as a flat list/);
        expect(fromYType(drawingOf(doc)).anchors).toHaveLength(1);
    });
});

describe('the keyed pair is never created one half at a time', () => {
    function bareDoc() {
        return glyphDoc(() => {
            const legacy = new Y.Map();
            legacy.set('id', 'd1');
            legacy.set('width', 500);
            return legacy;
        });
    }

    test('a write of anchorOrder on an older drawing creates both halves and is recorded', () => {
        startTrace();
        const doc = bareDoc();
        doc.transact(() =>
            setYPath(
                doc.getMap('font'),
                ['glyphs', 'A', 'layers', 'd1', 'anchorOrder'],
                []
            )
        );
        const map = drawingOf(doc);
        expect(map.get('anchorsById')).toBeInstanceOf(Y.Map);
        expect(map.get('anchorOrder')).toBeInstanceOf(Y.Array);
        expect(fromYType(map).anchors).toEqual([]);
        expect(lateEvents().map((entry) => entry.detail.key)).toEqual([
            'anchorsById'
        ]);
    });

    test('a write of a new entry into guidesById alone is refused before anything is created', () => {
        // The entry would have no id in guideOrder: entries are added with
        // their place in the order (the guides list path), never into the
        // map alone.
        const doc = bareDoc();
        expect(() =>
            doc.transact(() =>
                setYPath(
                    doc.getMap('font'),
                    ['glyphs', 'A', 'layers', 'd1', 'guidesById', 'g1'],
                    { id: 'g1', pos: { x: 0, y: 0, angle: 0 } }
                )
            )
        ).toThrow(/guidesById has no entry “g1”/);
        const map = drawingOf(doc);
        expect(map.get('guidesById')).toBeUndefined();
        expect(map.get('guideOrder')).toBeUndefined();
    });
});

describe('format_specific is created with the drawing', () => {
    const MARKER = 'com.counterpunch.formerFreeDrawing';

    test('a new drawing holds an empty map, read back as no format_specific', () => {
        const doc = glyphDoc(() => drawingToYMap(drawingJson()));
        const map = drawingOf(doc);
        expect(map.get('format_specific')).toBeInstanceOf(Y.Map);
        expect(map.get('format_specific').size).toBe(0);
        // Snapshots and exports stay as they were: an empty map is the
        // drawing having no format-specific data.
        expect('format_specific' in fromYType(map)).toBe(false);
    });

    test('stored format-specific data is read back unchanged', () => {
        const doc = glyphDoc(() =>
            drawingToYMap(drawingJson({ format_specific: { 'com.x': 1 } }))
        );
        expect(fromYType(drawingOf(doc)).format_specific).toEqual({
            'com.x': 1
        });
    });

    test('a format_specific that is not an object is refused', () => {
        expect(() =>
            drawingToYMap(drawingJson({ format_specific: 'oops' }))
        ).toThrow(/format_specific is not a plain object/);
    });

    test('two collaborators writing the first entry at once keep both entries', () => {
        startTrace();
        const a = glyphDoc(() => drawingToYMap(drawingJson()), 1);
        const b = new Y.Doc({ gc: false });
        b.clientID = 2;
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

        a.transact(() =>
            setYPath(
                a.getMap('font'),
                ['glyphs', 'A', 'layers', 'd1', 'format_specific', MARKER],
                { location: { wght: 650 } }
            )
        );
        b.transact(() =>
            applyDrawingDelta(b.getMap('font'), 'A', 'd1', {
                format_specific: { 'com.example.keep': 1 }
            })
        );
        sync(a, b);

        for (const doc of [a, b]) {
            expect(fromYType(drawingOf(doc)).format_specific).toEqual({
                [MARKER]: { location: { wght: 650 } },
                'com.example.keep': 1
            });
        }
        expect(lateEvents()).toEqual([]);
    });

    test('removing format_specific empties the map and keeps it', () => {
        const writes = [
            (doc) =>
                applyDrawingDelta(doc.getMap('font'), 'A', 'd1', {
                    format_specific: null
                }),
            (doc) =>
                deleteYPath(doc.getMap('font'), [
                    'glyphs',
                    'A',
                    'layers',
                    'd1',
                    'format_specific'
                ]),
            (doc) =>
                setYPath(
                    doc.getMap('font'),
                    ['glyphs', 'A', 'layers', 'd1', 'format_specific'],
                    {}
                ),
            (doc) => {
                const { format_specific: _omit, ...rest } = fromYType(
                    drawingOf(doc)
                );
                replaceYMapContents(drawingOf(doc), rest);
            }
        ];
        for (const write of writes) {
            const doc = glyphDoc(() =>
                drawingToYMap(
                    drawingJson({ format_specific: { [MARKER]: {} } })
                )
            );
            const before = drawingOf(doc).get('format_specific');
            doc.transact(() => write(doc));
            const after = drawingOf(doc).get('format_specific');
            expect(after).toBe(before);
            expect(after.size).toBe(0);
            expect('format_specific' in fromYType(drawingOf(doc))).toBe(false);
        }
    });

    test('a whole format_specific write replaces the entries in the same map', () => {
        const doc = glyphDoc(() =>
            drawingToYMap(drawingJson({ format_specific: { old: 1 } }))
        );
        const before = drawingOf(doc).get('format_specific');
        doc.transact(() =>
            setYPath(
                doc.getMap('font'),
                ['glyphs', 'A', 'layers', 'd1', 'format_specific'],
                { next: 2 }
            )
        );
        expect(drawingOf(doc).get('format_specific')).toBe(before);
        expect(fromYType(drawingOf(doc)).format_specific).toEqual({ next: 2 });
    });

    test('an older drawing without the map gets it on its first write, recorded', () => {
        startTrace();
        const doc = glyphDoc(() => {
            const legacy = drawingToYMap(drawingJson());
            legacy.delete('format_specific');
            return legacy;
        });
        doc.transact(() =>
            applyDrawingDelta(doc.getMap('font'), 'A', 'd1', {
                format_specific: { k: 1 }
            })
        );
        expect(fromYType(drawingOf(doc)).format_specific).toEqual({ k: 1 });
        expect(lateEvents().map((entry) => entry.detail.key)).toEqual([
            'format_specific'
        ]);
    });
});

describe('an entry of a keyed pair is never in one half alone', () => {
    function anchoredDoc() {
        return glyphDoc(() =>
            drawingToYMap(
                drawingJson({
                    anchors: [
                        { id: 'top', name: 'top', x: 1, y: 2 },
                        { id: 'bottom', name: 'bottom', x: 3, y: 4 }
                    ]
                })
            )
        );
    }

    test('an anchor the order does not list is refused on read', () => {
        const doc = anchoredDoc();
        doc.transact(() => {
            const order = drawingOf(doc).get('anchorOrder');
            order.delete(1, 1);
        });
        expect(() => fromYType(drawingOf(doc))).toThrow(
            /anchorsById holds anchor id bottom, which anchorOrder does not list/
        );
        expect(() =>
            getYPath(doc.getMap('font'), [
                'glyphs',
                'A',
                'layers',
                'd1',
                'anchors'
            ])
        ).toThrow(/does not list/);
    });

    test('a guide the order does not list is refused on read', () => {
        const doc = glyphDoc(() =>
            drawingToYMap(
                drawingJson({
                    guides: [{ id: 'g1', pos: { x: 0, y: 0, angle: 0 } }]
                })
            )
        );
        doc.transact(() => drawingOf(doc).get('guideOrder').delete(0, 1));
        expect(() => fromYType(drawingOf(doc))).toThrow(
            /guidesById holds guide id g1/
        );
    });

    test('a feature the order does not list is refused on read', () => {
        const doc = new Y.Doc();
        const features = new Y.Map();
        doc.getMap('root').set('features', features);
        doc.transact(() => {
            applyIndexedMapArray(features, 'features', [
                ['liga', 'sub f i by f_i;']
            ]);
            features.set('classes', new Y.Map());
            features.get('featureOrder').delete(0, 1);
        });
        expect(() => fromYType(features)).toThrow(
            /featuresById holds feature id/
        );
    });

    test('an order id whose anchor a collaborator deleted is skipped on read', () => {
        const doc = anchoredDoc();
        doc.transact(() => drawingOf(doc).get('anchorsById').delete('top'));
        expect(
            fromYType(drawingOf(doc)).anchors.map((anchor) => anchor.id)
        ).toEqual(['bottom']);
    });

    test('a write of the order alone may reorder but not add or drop ids', () => {
        const doc = anchoredDoc();
        const path = ['glyphs', 'A', 'layers', 'd1', 'anchorOrder'];
        doc.transact(() =>
            setYPath(doc.getMap('font'), path, ['bottom', 'top'])
        );
        expect(
            fromYType(drawingOf(doc)).anchors.map((anchor) => anchor.id)
        ).toEqual(['bottom', 'top']);
        expect(() =>
            doc.transact(() => setYPath(doc.getMap('font'), path, ['top']))
        ).toThrow(/may only reorder the anchors \(drops bottom\)/);
        expect(() =>
            doc.transact(() =>
                setYPath(doc.getMap('font'), path, ['top', 'bottom', 'x'])
            )
        ).toThrow(/adds x/);
        expect(fromYType(drawingOf(doc)).anchors).toHaveLength(2);
    });

    test('a new entry written into anchorsById alone is refused', () => {
        const doc = anchoredDoc();
        expect(() =>
            doc.transact(() =>
                setYPath(
                    doc.getMap('font'),
                    ['glyphs', 'A', 'layers', 'd1', 'anchorsById', 'new'],
                    { id: 'new', name: 'new', x: 0, y: 0 }
                )
            )
        ).toThrow(/added with its place in the order/);
        expect(() =>
            doc.transact(() =>
                setYPath(
                    doc.getMap('font'),
                    ['glyphs', 'A', 'layers', 'd1', 'anchorsById', 'new', 'x'],
                    5
                )
            )
        ).toThrow(/anchorsById has no entry “new”/);
        expect(drawingOf(doc).get('anchorsById').has('new')).toBe(false);
        expect(fromYType(drawingOf(doc)).anchors).toHaveLength(2);
    });

    test('an existing entry written through anchorsById is changed in place', () => {
        const doc = anchoredDoc();
        doc.transact(() =>
            setYPath(
                doc.getMap('font'),
                ['glyphs', 'A', 'layers', 'd1', 'anchorsById', 'top', 'x'],
                9
            )
        );
        expect(fromYType(drawingOf(doc)).anchors[0].x).toBe(9);
    });

    test('deleting through either half removes the entry from both', () => {
        for (const path of [
            ['glyphs', 'A', 'layers', 'd1', 'anchorsById', 'top'],
            ['glyphs', 'A', 'layers', 'd1', 'anchorOrder', 0],
            ['glyphs', 'A', 'layers', 'd1', 'anchors', 0]
        ]) {
            const doc = anchoredDoc();
            doc.transact(() => deleteYPath(doc.getMap('font'), path));
            const map = drawingOf(doc);
            expect(map.get('anchorsById').has('top')).toBe(false);
            expect(map.get('anchorOrder').toArray()).toEqual(['bottom']);
            expect(fromYType(map).anchors.map((anchor) => anchor.id)).toEqual([
                'bottom'
            ]);
        }
    });

    test('an id listed twice (two collaborators moved it at once) is read once and deleted entirely', () => {
        const doc = anchoredDoc();
        doc.transact(() => drawingOf(doc).get('anchorOrder').push(['top']));
        expect(
            fromYType(drawingOf(doc)).anchors.map((anchor) => anchor.id)
        ).toEqual(['top', 'bottom']);
        doc.transact(() =>
            deleteYPath(doc.getMap('font'), [
                'glyphs',
                'A',
                'layers',
                'd1',
                'anchors',
                0
            ])
        );
        expect(drawingOf(doc).get('anchorOrder').toArray()).toEqual(['bottom']);
        expect(fromYType(drawingOf(doc)).anchors).toHaveLength(1);
    });

    test('deleting a drawing’s whole anchors list empties the pair and keeps it', () => {
        const doc = anchoredDoc();
        const before = drawingOf(doc).get('anchorsById');
        doc.transact(() =>
            deleteYPath(doc.getMap('font'), [
                'glyphs',
                'A',
                'layers',
                'd1',
                'anchors'
            ])
        );
        expect(drawingOf(doc).get('anchorsById')).toBe(before);
        expect(fromYType(drawingOf(doc)).anchors).toEqual([]);
    });

    test('the normal writers keep both halves together, also across collaborators', () => {
        const a = anchoredDoc();
        a.clientID = 1;
        const b = new Y.Doc({ gc: false });
        b.clientID = 2;
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
        // One removes an anchor while the other edits it and adds one.
        a.transact(() =>
            applyIndexedMapArray(drawingOf(a), 'anchors', [
                { id: 'bottom', name: 'bottom', x: 3, y: 4 }
            ])
        );
        b.transact(() =>
            applyIndexedMapArray(drawingOf(b), 'anchors', [
                { id: 'top', name: 'top', x: 7, y: 2 },
                { id: 'bottom', name: 'bottom', x: 3, y: 4 },
                { id: 'new', name: 'new', x: 0, y: 0 }
            ])
        );
        sync(a, b);
        for (const doc of [a, b]) {
            expect(
                fromYType(drawingOf(doc)).anchors.map((anchor) => anchor.id)
            ).toEqual(['bottom', 'new']);
        }
    });
});
