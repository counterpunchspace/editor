/**
 * Worker-generated commits that touch many glyph shards at once (add or
 * remove a master). Each glyph shard gets its own packet; these tests pin
 * what peers and the cloud room receive for such a commit.
 */

const Y = require('yjs');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const { setYPath } = require('../js/change-bridge-ydoc');
const {
    fitCollaborationMessagesToBudget,
    METADATA_FIT_LEVEL
} = require('../js/generated/collab-protocol-metadata-budget');
const {
    OUTBOUND_METADATA_BUDGET_BYTES
} = require('../js/cloud-envelope-budget');

function makeFont(glyphCount) {
    return {
        upm: 1000,
        version: [1, 0],
        names: { familyName: 'MultiDoc' },
        axes: [],
        masters: [{ id: 'm1', name: { dflt: 'Regular' }, location: {} }],
        glyphs: Array.from({ length: glyphCount }, (_, index) => ({
            name: `glyph${String(index).padStart(4, '0')}`,
            production_name: null,
            category: 'Base',
            codepoints: [],
            exported: true,
            layers: [
                {
                    id: `L${index}`,
                    width: 500,
                    master: { type: 'DefaultForMaster', master: 'm1' },
                    shapes: [
                        {
                            nodes: [
                                { x: 0, y: 0, nodetype: 'line', smooth: false },
                                {
                                    x: 400,
                                    y: 0,
                                    nodetype: 'line',
                                    smooth: false
                                },
                                {
                                    x: 400,
                                    y: 700,
                                    nodetype: 'line',
                                    smooth: false
                                },
                                {
                                    x: 0,
                                    y: 700,
                                    nodetype: 'line',
                                    smooth: false
                                }
                            ],
                            closed: true
                        }
                    ],
                    anchors: []
                }
            ]
        }))
    };
}

/**
 * Builds a worker-style commit: one Yjs packet per glyph shard that sets the
 * glyph's layer width, plus the matching layer-snapshot operations.
 */
function buildWidthCommit(engine, fontJson, width) {
    const shards = engine.encodeDocumentSet();
    const operations = [];
    const documentUpdates = [];
    for (const glyph of fontJson.glyphs) {
        const layer = glyph.layers[0];
        const documentId = engine.documentIdForPath(['glyphs', glyph.name]);
        const shard = shards.find((s) => s.documentId === documentId);
        const doc = new Y.Doc({ gc: false });
        Y.applyUpdate(doc, shard.bytes);
        const baseline = Y.encodeStateVector(doc);
        const oldLayer = JSON.parse(JSON.stringify(layer));
        const newLayer = { ...oldLayer, width };
        doc.transact(() => {
            setYPath(doc.getMap('glyph'), ['layers', layer.id], newLayer);
        });
        documentUpdates.push({
            documentId,
            update: Y.encodeStateAsUpdate(doc, baseline)
        });
        operations.push({
            op: 'set',
            path: ['glyphs', glyph.name, 'layers', layer.id],
            oldValue: oldLayer,
            newValue: newLayer,
            applyMode: 'layer-snapshot',
            workerReplayTargets: [{ glyphName: glyph.name, layerId: layer.id }]
        });
    }
    return { shards, operations, documentUpdates };
}

describe('multi-document worker commits', () => {
    afterEach(() => {
        delete window.changeBridge;
    });

    test('every packet of a commit across hundreds of glyphs fits the room metadata budget', () => {
        const fontJson = makeFont(600);
        const engine = new PatchSyncEngine('multi-doc-budget');
        engine.initFromJson(fontJson);
        window.changeBridge = engine;
        const messages = [];
        engine.onLocalUpdate((_update, message) => {
            messages.push(message);
        });

        const { operations, documentUpdates } = buildWidthCommit(
            engine,
            fontJson,
            612
        );
        engine.applyLocalGeneratedYjsUpdate(
            documentUpdates[0].update,
            operations,
            'Add master',
            null,
            documentUpdates
        );

        expect(messages).toHaveLength(documentUpdates.length);
        for (const message of messages) {
            const fit = fitCollaborationMessagesToBudget(
                [message],
                OUTBOUND_METADATA_BUDGET_BYTES
            );
            // Sent as it is: no packet needs shrinking, let alone refusal.
            expect(fit.level).toBe(METADATA_FIT_LEVEL.NONE);
            expect(message.changes).toHaveLength(1);
        }
        engine.destroy();
    });

    test('a commit stamps glyph revisions so peers outside the live set catch up', () => {
        const fontJson = makeFont(3);
        const engine = new PatchSyncEngine('multi-doc-revisions');
        engine.initFromJson(fontJson);
        window.changeBridge = engine;
        const emitted = [];
        engine.onLocalUpdate((update, message, _entries, documentId) => {
            emitted.push({ kind: 'packet', update, message, documentId });
        });
        engine.onGlyphRevisionSignal((update, entries) => {
            emitted.push({ kind: 'revisions', update, entries });
        });

        const { shards, operations, documentUpdates } = buildWidthCommit(
            engine,
            fontJson,
            640
        );
        engine.applyLocalGeneratedYjsUpdate(
            documentUpdates[0].update,
            operations,
            'Remove master',
            null,
            documentUpdates
        );

        // The core revision signal comes after every glyph packet.
        expect(emitted.map((item) => item.kind)).toEqual([
            'packet',
            'packet',
            'packet',
            'revisions'
        ]);
        const tokens = new Map(
            engine
                .listGlyphRevisionTokens()
                .map((token) => [token.glyphId, token.revision])
        );
        const glyphDocumentIds = documentUpdates.map((p) => p.documentId);
        for (const documentId of glyphDocumentIds) {
            expect(tokens.get(documentId.slice('glyph:'.length))).toBeTruthy();
        }

        // A peer that applies only the glyph packets holds each stamped
        // revision, so a revision-driven catch-up accepts these shards.
        const peerJson = JSON.parse(JSON.stringify(fontJson));
        for (const glyph of peerJson.glyphs) {
            glyph.layers[0].width = 500;
        }
        const peer = new PatchSyncEngine('multi-doc-revisions-peer');
        peer.setFontJson(peerJson);
        peer.applyDocumentSetState(shards);
        for (const item of emitted.filter((i) => i.kind === 'packet')) {
            peer.applyRemoteUpdate(
                item.update,
                undefined,
                [item.message],
                item.documentId,
                { captureInUndo: false }
            );
            const glyphId = item.documentId.slice('glyph:'.length);
            expect(
                peer.glyphHasCatchUpRevision(
                    item.documentId,
                    tokens.get(glyphId)
                )
            ).toBe(true);
        }
        expect(peerJson.glyphs.map((g) => g.layers[0].width)).toEqual([
            640, 640, 640
        ]);
        engine.destroy();
        peer.destroy();
    });
});
