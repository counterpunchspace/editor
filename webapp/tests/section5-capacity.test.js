import * as Y from 'yjs';
import { jsonToCoreFontMap, toYType } from '../js/change-bridge-ydoc';
import { writeLayerGeometry } from '../js/layer-geometry-ydoc';
import { writeFontDepsYMap } from '../js/filesystem-plugins/cloud-font-deps';
import { fillGlyphYMap } from '../js/change-bridge-ydoc';

function countStructs(doc) {
    let n = 0;
    doc.store.clients.forEach((structs) => {
        n += structs.length;
    });
    return n;
}

describe('section 5 production toYType capacity samples', () => {
    test('jsonToCoreFontMap catalog+cmap without embedded fontDeps', () => {
        const glyphs = Array.from({ length: 674 }, (_, i) => ({
            name: `g${i}`,
            id: `id-${i}`
        }));
        const doc = new Y.Doc({ gc: true });
        jsonToCoreFontMap(
            {
                upm: 1000,
                glyphs,
                glyphOrder: glyphs.map((g) => g.name),
                format_specific: {
                    'com.counterpunch.cloud': {
                        glyphCatalog: Object.fromEntries(
                            glyphs.map((g) => [g.id, { name: g.name }])
                        ),
                        codepointIndex: Object.fromEntries(
                            glyphs.map((g, i) => [String(i), g.id])
                        )
                    }
                }
            },
            doc.getMap('font')
        );
        const encoded = Y.encodeStateAsUpdate(doc);
        expect(encoded.byteLength).toBeGreaterThan(1000);
        expect(countStructs(doc)).toBeGreaterThan(674);
        doc.destroy();
    });

    test('writeFontDepsYMap stores component, metrics-key, and both', () => {
        const doc = new Y.Doc({ gc: true });
        writeFontDepsYMap(doc.getMap('deps'), {
            edges: {
                'id-a': { 'id-b': 'component', 'id-c': 'metrics-key' },
                'id-d': { 'id-e': 'both' }
            },
            sourceRevision: { 'id-a': 'r1', 'id-d': 'r2' }
        });
        const edges = doc.getMap('deps').get('edges');
        expect(edges.get('id-a').get('id-b')).toBe('component');
        expect(edges.get('id-a').get('id-c')).toBe('metrics-key');
        expect(edges.get('id-d').get('id-e')).toBe('both');
        doc.destroy();
    });

    test('gc:false undo/redo, two-doc merge, and rebaseline keep unsent', () => {
        const doc = new Y.Doc({ gc: false });
        const glyphMap = doc.getMap('glyph');
        fillGlyphYMap(
            {
                name: 'A',
                layers: [
                    {
                        id: 'layer-1',
                        shapes: [
                            {
                                id: 's1',
                                nodes: Array.from({ length: 50 }, (_, i) => ({
                                    id: `n${i}`,
                                    x: i,
                                    y: i,
                                    nodetype: 'Line',
                                    smooth: false
                                }))
                            }
                        ]
                    }
                ]
            },
            glyphMap
        );
        const layerMap = glyphMap.get('layers').get('layer-1');
        const undo = new Y.UndoManager(layerMap);
        for (let i = 0; i < 200; i++) {
            writeLayerGeometry(
                layerMap,
                [
                    {
                        id: 's1',
                        nodes: Array.from({ length: 50 }, (_, n) => ({
                            id: `n${n}`,
                            x: n + i,
                            y: n,
                            nodetype: 'Line',
                            smooth: false
                        }))
                    }
                ],
                toYType
            );
            undo.stopCapturing();
        }
        const afterEdits = Y.encodeStateAsUpdate(doc).byteLength;
        undo.undo();
        undo.redo();
        const peer = new Y.Doc({ gc: false });
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
        peer.getMap('glyph').set('note', 'peer');
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
        const checkpoint = Y.encodeStateAsUpdate(doc);
        const sv = Y.encodeStateVector(doc);
        glyphMap.set('pending', 'unsent');
        const unsent = Y.encodeStateAsUpdate(doc, sv);
        const fresh = new Y.Doc({ gc: false });
        Y.applyUpdate(fresh, checkpoint);
        Y.applyUpdate(fresh, unsent);
        expect(fresh.getMap('glyph').get('pending')).toBe('unsent');
        expect(afterEdits).toBeGreaterThan(100);
        expect(undo.undoStack.length + undo.redoStack.length).toBeGreaterThan(
            0
        );
        doc.destroy();
        peer.destroy();
        fresh.destroy();
    });
});
