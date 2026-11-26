import * as Y from 'yjs';
import { PatchSyncEngine } from '../js/patch-sync-engine';

function makeFontJson(glyphCount) {
    const glyphs = Array.from({ length: glyphCount }, (_, index) => ({
        name: `g${index}`,
        id: `id-g${index}`,
        category: 'Base',
        codepoints: [0x0041 + index],
        layers: [
            {
                id: `layer-${index}`,
                width: 500 + index,
                master: {
                    type: 'DefaultForMaster',
                    master: 'master-regular'
                },
                shapes: [
                    {
                        id: `path-${index}`,
                        closed: true,
                        nodes: [
                            { x: 10, y: 20, nodetype: 'line' },
                            { x: 110, y: 20, nodetype: 'line' },
                            { x: 110, y: 700, nodetype: 'line' }
                        ]
                    }
                ],
                anchors: [],
                guides: []
            }
        ]
    }));

    return {
        upm: 1000,
        axes: [],
        masters: [{ id: 'master-regular', name: { dflt: 'Regular' } }],
        instances: [],
        glyphs,
        glyphOrder: glyphs.map((g) => g.name)
    };
}

describe('PatchSyncEngine dormant glyph shards & LRU eviction', () => {
    test('parks excess glyphs on initFromJson, encodes without waking, and wakes cleanly for edit + undo/redo', () => {
        const engine = new PatchSyncEngine('win-dormant');
        try {
            const fontJson = makeFontJson(30);
            engine.initFromJson(fontJson);

            const afterInit = engine.getMemoryInspectionSnapshot();
            expect(afterInit.liveGlyphCount).toBe(16);
            expect(afterInit.dormantGlyphCount).toBe(14);
            expect(afterInit.dormantGlyphBytes).toBeGreaterThan(0);

            // encodeDocumentSet must emit every shard without waking dormant docs.
            const shards = engine.encodeDocumentSet();
            expect(
                shards.filter((s) => s.documentId.startsWith('glyph:')).length
            ).toBe(30);
            expect(engine.getMemoryInspectionSnapshot().liveGlyphCount).toBe(
                16
            );

            // Single-shard encodeDocumentState on a dormant glyph (g0 was parked first)
            // must not wake it.
            const rawBeforeEdit = engine.encodeDocumentState('glyph:id-g0');
            expect(rawBeforeEdit.byteLength).toBeGreaterThan(0);
            expect(engine.getMemoryInspectionSnapshot().liveGlyphCount).toBe(
                16
            );

            // Build a peer Y.Doc from the dormant bytes to prove incremental delta compatibility.
            const peerDoc = new Y.Doc({ gc: true });
            Y.applyUpdate(peerDoc, rawBeforeEdit);

            const emittedUpdates = [];
            engine.setYjsWorkerCallback((update, _entries, documentId) => {
                if (documentId === 'glyph:id-g0') {
                    emittedUpdates.push(update);
                }
            });

            // Editing dormant g0 wakes only g0 and emits a valid incremental Yjs delta.
            fontJson.glyphs[0].layers[0].width = 650;
            engine.recordChange(
                ['glyphs', 'g0', 'layers', 'layer-0'],
                'width',
                500,
                650
            );

            expect(engine.getMemoryInspectionSnapshot().liveGlyphCount).toBe(
                17
            );
            expect(engine.getMemoryInspectionSnapshot().dormantGlyphCount).toBe(
                13
            );
            expect(emittedUpdates.length).toBeGreaterThan(0);

            for (const update of emittedUpdates) {
                Y.applyUpdate(peerDoc, update);
            }
            const peerWidth = peerDoc
                .getMap('glyph')
                .get('layers')
                .get('layer-0')
                .get('width');
            expect(peerWidth).toBe(650);

            // Undo & redo round-trip cleanly.
            engine.undo('g0', 'layer-0');
            expect(fontJson.glyphs[0].layers[0].width).toBe(500);
            engine.redo('g0', 'layer-0');
            expect(fontJson.glyphs[0].layers[0].width).toBe(650);

            peerDoc.destroy();
        } finally {
            engine.destroy();
        }
    });

    test('LRU eviction re-parks idle live glyph docs when exceeding cap and preserves state vectors', () => {
        const engine = new PatchSyncEngine('win-lru');
        try {
            const fontJson = makeFontJson(80);
            engine.initFromJson(fontJson);
            expect(engine.getMemoryInspectionSnapshot().liveGlyphCount).toBe(
                16
            );
            expect(engine.getMemoryInspectionSnapshot().dormantGlyphCount).toBe(
                64
            );

            // Edit 75 distinct glyphs (cap is 64).
            for (let i = 0; i < 75; i++) {
                fontJson.glyphs[i].layers[0].width = 700 + i;
                engine.recordChange(
                    ['glyphs', `g${i}`, 'layers', `layer-${i}`],
                    'width',
                    500 + i,
                    700 + i
                );
            }

            const snap = engine.getMemoryInspectionSnapshot();
            expect(snap.liveGlyphCount).toBeLessThanOrEqual(64);
            expect(snap.liveGlyphCount + snap.dormantGlyphCount).toBe(80);

            // g0 was evicted back to dormant; capture its state vector, re-edit & undo it.
            const stateBefore = engine.encodeDocumentState('glyph:id-g0');
            const svBefore = Y.encodeStateVectorFromUpdate(stateBefore);

            fontJson.glyphs[0].layers[0].width = 812;
            engine.recordChange(
                ['glyphs', 'g0', 'layers', 'layer-0'],
                'width',
                700,
                812
            );
            expect(fontJson.glyphs[0].layers[0].width).toBe(812);

            const svAfter = engine.encodeDocumentStateVector('glyph:id-g0');
            expect(svAfter.byteLength).toBeGreaterThanOrEqual(
                svBefore.byteLength
            );

            engine.undo('g0', 'layer-0');
            expect(fontJson.glyphs[0].layers[0].width).toBe(700);
        } finally {
            engine.destroy();
        }
    });
});
