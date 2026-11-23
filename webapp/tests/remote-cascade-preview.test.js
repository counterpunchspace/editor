const fs = require('fs');
const path = require('path');

const {
    RemoteCascadePreview,
    REMOTE_CASCADE_PREVIEW_MAX_MS,
    REMOTE_CASCADE_CHECK_MAX_WAIT_MS,
    REMOTE_CASCADE_BUSY_RETRY_MS
} = require('../js/remote-cascade-preview');
const {
    recomposeCollaboratorCascade,
    recomposeForSettle,
    recomposeStaleComposites
} = require('../js/change-bridge-init');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const { Font, withSuppressedModelRecording } = require('../js/babelfont-model');
const { open_font_file } = require('../wasm-dist/babelfont_fontc_web');
const { joinPathWithGlyphSeparator } = require('../js/change-log');
const { drawingFingerprint } = require('../js/collab-trace');

const at = (...segments) => joinPathWithGlyphSeparator(segments);

function fakeClock() {
    let now = 0;
    const timers = new Map();
    let nextHandle = 1;
    const queued = [];
    return {
        clock: {
            now: () => now,
            setTimer: (callback, ms) => {
                const handle = nextHandle++;
                timers.set(handle, { callback, at: now + ms });
                return handle;
            },
            clearTimer: (handle) => timers.delete(handle),
            queue: (callback) => queued.push(callback)
        },
        flush() {
            while (queued.length) {
                queued.shift()();
            }
        },
        advance(ms) {
            this.flush();
            const target = now + ms;
            for (;;) {
                const due = [...timers.entries()]
                    .filter(([, timer]) => timer.at <= target)
                    .sort((left, right) => left[1].at - right[1].at)[0];
                if (!due) break;
                timers.delete(due[0]);
                now = due[1].at;
                due[1].callback();
                this.flush();
            }
            now = target;
        }
    };
}

function fakeHost(recomposeResults = []) {
    const host = {
        busy: false,
        recomposeCalls: [],
        staged: [],
        compiles: 0,
        repaints: [],
        reverted: [],
        settled: [],
        isBusyLocally: () => host.busy,
        recompose: (sources) => {
            host.recomposeCalls.push(
                sources.map((source) => ({
                    glyphName: source.glyphName,
                    layerId: source.layerId,
                    editKinds: [...source.editKinds].sort()
                }))
            );
            return recomposeResults.shift() ?? [];
        },
        stageOverlay: async (targets) => {
            host.staged.push(targets.map((t) => `${t.glyphName}/${t.layerId}`));
            return true;
        },
        requestCompile: () => {
            host.compiles += 1;
        },
        repaint: (glyphNames) => host.repaints.push(glyphNames),
        revert: (targets) =>
            host.reverted.push(
                targets.map((t) => `${t.glyphName}/${t.layerId}`)
            ),
        repairCalls: [],
        repairComposites: (glyphNames, stillPending = []) => {
            host.repairCalls.push({
                glyphNames: [...glyphNames].sort(),
                stillPending: stillPending.map(
                    (t) => `${t.glyphName}/${t.layerId}`
                )
            });
            return [];
        },
        settleSources: [],
        settle: (targets, sources = [], stillPending = []) => {
            host.settled.push(
                targets.map((t) => `${t.glyphName}/${t.layerId}`)
            );
            host.settleSources.push({
                sources: sources.map((s) => `${s.glyphName}/${s.layerId}`),
                stillPending: stillPending.map(
                    (t) => `${t.glyphName}/${t.layerId}`
                )
            });
            return targets;
        }
    };
    return host;
}

const anchorEdit = [
    {
        path: at('glyphs', 'a', 'layers', 'm1', 'anchors', 0, 'y'),
        oldValue: 500,
        newValue: 540,
        compileEditType: 'anchor'
    }
];
const aacute = { glyphName: 'aacute', layerId: 'm1' };

async function settled() {
    await Promise.resolve();
    await Promise.resolve();
}

describe('RemoteCascadePreview', () => {
    it('recomposes a collaborator’s edit, stages the dependents and compiles', async () => {
        const time = fakeClock();
        const host = fakeHost([[aacute]]);
        const preview = new RemoteCascadePreview(host, time.clock);

        preview.noteCollaboratorEdit(anchorEdit);
        time.flush();
        await settled();

        expect(host.recomposeCalls).toEqual([
            [{ glyphName: 'a', layerId: 'm1', editKinds: ['anchor'] }]
        ]);
        expect(host.staged).toEqual([['aacute/m1']]);
        expect(host.compiles).toBe(1);
        // Once from the model, once more after the overlay is staged.
        expect(host.repaints).toEqual([['aacute'], ['aacute']]);
        expect(preview.pendingTargets).toEqual([aacute]);
    });

    it('repaints again only once the worker holds the overlay', async () => {
        const time = fakeClock();
        const host = fakeHost([[aacute]]);
        let stage;
        host.stageOverlay = () =>
            new Promise((resolve) => {
                stage = resolve;
            });
        const preview = new RemoteCascadePreview(host, time.clock);

        preview.noteCollaboratorEdit(anchorEdit);
        time.flush();
        await settled();
        // Overview tiles fetched now would get the outline before the preview.
        expect(host.repaints).toEqual([['aacute']]);

        stage(true);
        await settled();
        expect(host.repaints).toEqual([['aacute'], ['aacute']]);
        expect(host.compiles).toBe(1);
    });

    it('keeps the stored layer once a catch-up brings it', async () => {
        const time = fakeClock();
        const host = fakeHost([[aacute], []]);
        const preview = new RemoteCascadePreview(host, time.clock);

        preview.noteCollaboratorEdit(anchorEdit);
        time.flush();
        await settled();
        preview.noteStoredChange([
            {
                path: at(
                    'glyphs',
                    'aacute',
                    'layers',
                    'm1',
                    'shapes',
                    1,
                    'transform'
                )
            }
        ]);
        time.flush();
        await settled();

        // The base did not move on: recomposing again changes nothing, so
        // the stored layer is shown and nothing is reverted later.
        expect(host.recomposeCalls).toHaveLength(2);
        expect(preview.pendingTargets).toEqual([]);
        time.advance(REMOTE_CASCADE_PREVIEW_MAX_MS * 2);
        expect(host.reverted).toEqual([]);
    });

    it('recomposes again when the base moved on before the catch-up', async () => {
        const time = fakeClock();
        const host = fakeHost([[aacute], [aacute], [aacute]]);
        const preview = new RemoteCascadePreview(host, time.clock);

        preview.noteCollaboratorEdit(anchorEdit);
        time.flush();
        preview.noteCollaboratorEdit(anchorEdit);
        time.flush();
        // The first edit’s stored layer arrives after the second edit: the
        // preview of the second edit is shown again, not the older layer.
        preview.noteStoredChange([
            { path: at('glyphs', 'aacute', 'layers', 'm1', 'width') }
        ]);
        time.flush();
        await settled();

        expect(host.recomposeCalls).toHaveLength(3);
        expect(preview.pendingTargets).toEqual([aacute]);
        expect(host.staged.at(-1)).toEqual(['aacute/m1']);
    });

    it('settles a preview whose stored layer never catches up', async () => {
        const time = fakeClock();
        const host = fakeHost([[aacute]]);
        const preview = new RemoteCascadePreview(host, time.clock);

        preview.noteCollaboratorEdit(anchorEdit);
        time.flush();
        await settled();
        time.advance(REMOTE_CASCADE_PREVIEW_MAX_MS - 1);
        expect(host.settled).toEqual([]);
        time.advance(1);

        expect(host.settled).toEqual([['aacute/m1']]);
        expect(host.reverted).toEqual([]);
        expect(preview.pendingTargets).toEqual([]);
    });

    it('settles previews of different cascades each with its own sources', async () => {
        const time = fakeClock();
        const odieresis = { glyphName: 'odieresis', layerId: 'm1' };
        const host = fakeHost([[aacute], [odieresis]]);
        const preview = new RemoteCascadePreview(host, time.clock);

        preview.noteCollaboratorEdit(anchorEdit);
        time.flush();
        await settled();
        time.advance(REMOTE_CASCADE_PREVIEW_MAX_MS / 2);
        preview.noteCollaboratorEdit([
            {
                path: at('glyphs', 'o', 'layers', 'm1', 'anchors', 0, 'y'),
                oldValue: 500,
                newValue: 540,
                compileEditType: 'anchor'
            }
        ]);
        time.flush();
        await settled();
        // A drag of this window's own holds both until both are due.
        host.busy = true;
        time.advance(REMOTE_CASCADE_PREVIEW_MAX_MS);
        expect(host.settled).toEqual([]);
        host.busy = false;
        time.advance(REMOTE_CASCADE_BUSY_RETRY_MS);

        expect(host.settled).toEqual([['aacute/m1'], ['odieresis/m1']]);
        expect(host.settleSources).toEqual([
            { sources: ['a/m1'], stillPending: ['odieresis/m1'] },
            { sources: ['a/m1', 'o/m1'], stillPending: [] }
        ]);
    });

    it('checks the composites of changed glyphs once their stored changes are quiet', async () => {
        const time = fakeClock();
        const host = fakeHost();
        const preview = new RemoteCascadePreview(host, time.clock);

        preview.noteStoredChange([
            { path: at('glyphs', 'a', 'layers', 'm1', 'width'), newValue: 500 }
        ]);
        expect(preview.pendingChecks).toEqual(['a']);
        time.advance(REMOTE_CASCADE_PREVIEW_MAX_MS / 2);
        // A later change to another glyph restarts the wait for both.
        preview.noteStoredChange([
            { path: at('glyphs', 'q', 'layers', 'm1', 'width'), newValue: 900 }
        ]);
        time.advance(REMOTE_CASCADE_PREVIEW_MAX_MS - 1);
        expect(host.repairCalls).toEqual([]);
        time.advance(1);

        expect(host.repairCalls).toEqual([
            { glyphNames: ['a', 'q'], stillPending: [] }
        ]);
        expect(preview.pendingChecks).toEqual([]);
    });

    it('checks composites at the latest a minute after the first unchecked change', async () => {
        const time = fakeClock();
        const host = fakeHost();
        const preview = new RemoteCascadePreview(host, time.clock);
        // A collaborator keeps committing more often than the quiet wait.
        for (
            let elapsed = 0;
            elapsed < REMOTE_CASCADE_CHECK_MAX_WAIT_MS;
            elapsed += REMOTE_CASCADE_PREVIEW_MAX_MS / 2
        ) {
            preview.noteStoredChange([
                {
                    path: at('glyphs', 'a', 'layers', 'm1', 'width'),
                    newValue: elapsed
                }
            ]);
            time.advance(REMOTE_CASCADE_PREVIEW_MAX_MS / 2);
        }
        expect(host.repairCalls).toHaveLength(1);
    });

    it('waits with the composite check while this window is busy', async () => {
        const time = fakeClock();
        const host = fakeHost();
        const preview = new RemoteCascadePreview(host, time.clock);
        preview.noteStoredChange([
            { path: at('glyphs', 'a', 'layers', 'm1', 'width'), newValue: 500 }
        ]);
        host.busy = true;
        time.advance(REMOTE_CASCADE_PREVIEW_MAX_MS);
        expect(host.repairCalls).toEqual([]);
        host.busy = false;
        time.advance(REMOTE_CASCADE_BUSY_RETRY_MS);
        expect(host.repairCalls).toHaveLength(1);
    });

    it('stages the previews still pending again after settling others', async () => {
        const time = fakeClock();
        const adieresis = { glyphName: 'adieresis', layerId: 'm1' };
        const host = fakeHost([[aacute], [adieresis], []]);
        const preview = new RemoteCascadePreview(host, time.clock);

        preview.noteCollaboratorEdit(anchorEdit);
        time.flush();
        await settled();
        time.advance(REMOTE_CASCADE_PREVIEW_MAX_MS / 2);
        preview.noteCollaboratorEdit(anchorEdit);
        time.flush();
        await settled();
        host.staged.length = 0;
        time.advance(REMOTE_CASCADE_PREVIEW_MAX_MS / 2);
        await settled();

        // Settling aacute dropped the worker's whole overlay.
        expect(host.settled).toEqual([['aacute/m1']]);
        expect(preview.pendingTargets).toEqual([adieresis]);
        expect(host.staged).toEqual([['adieresis/m1']]);
    });

    it('waits to settle while the window is busy with its own edit', async () => {
        const time = fakeClock();
        const host = fakeHost([[aacute]]);
        const preview = new RemoteCascadePreview(host, time.clock);

        preview.noteCollaboratorEdit(anchorEdit);
        time.flush();
        await settled();
        host.busy = true;
        time.advance(REMOTE_CASCADE_PREVIEW_MAX_MS);
        expect(host.settled).toEqual([]);
        host.busy = false;
        time.advance(REMOTE_CASCADE_BUSY_RETRY_MS);

        expect(host.settled).toEqual([['aacute/m1']]);
    });

    it('leaves the model alone while the window is busy with its own edit', () => {
        const time = fakeClock();
        const host = fakeHost([[aacute]]);
        host.busy = true;
        const preview = new RemoteCascadePreview(host, time.clock);

        preview.noteCollaboratorEdit(anchorEdit);
        time.flush();

        expect(host.recomposeCalls).toEqual([]);
        expect(host.staged).toEqual([]);
    });

    it('ignores edits that cannot change other glyphs', () => {
        const time = fakeClock();
        const host = fakeHost();
        const preview = new RemoteCascadePreview(host, time.clock);

        preview.noteCollaboratorEdit([
            {
                path: at('glyphs', 'a', 'category'),
                oldValue: 'Letter',
                newValue: 'Mark'
            }
        ]);
        time.flush();

        expect(host.recomposeCalls).toEqual([]);
    });
});

describe('recomposeCollaboratorCascade', () => {
    const originalFontManager = window.fontManager;
    const originalPatchSyncEngine = window.patchSyncEngine;

    afterEach(() => {
        window.fontManager = originalFontManager;
        window.patchSyncEngine = originalPatchSyncEngine;
    });

    function setUp() {
        const fontData = loadFustat();
        const bridge = new PatchSyncEngine();
        bridge.initFromJson(JSON.parse(JSON.stringify(fontData)));
        const fontModel = Font.fromData(fontData);
        // Model setters record into this bridge unless recording is off.
        window.patchSyncEngine = bridge;
        window.fontManager = {
            currentFont: { fontModel, markDirty: () => {} }
        };
        const drawingO = fontModel.findGlyph('o').drawings[0];
        withSuppressedModelRecording(() => {
            const top = drawingO.anchors.find(
                (anchor) => anchor.name === 'top'
            );
            top.x += 40;
            top.y += 60;
        });
        return { bridge, fontModel, layerO: drawingO };
    }

    /** Every document the bridge holds: font-core, font-deps and glyphs. */
    function documentsOf(bridge) {
        return ['font-core', 'font-deps', ...bridge.listLiveGlyphDocumentIds()]
            .map(
                (documentId) =>
                    `${documentId}:${Buffer.from(
                        bridge.encodeDocumentState(documentId)
                    ).toString('base64')}`
            )
            .join('|');
    }

    it('records the same rebuild when recording is on (control)', () => {
        const { bridge, fontModel, layerO: drawingO } = setUp();
        const before = documentsOf(bridge);
        bridge.beginTransaction('Control', null, {
            compileChangeSource: 'test',
            compileEditType: null
        });
        try {
            fontModel.rebuildAutomaticCompositesForGlyphs(new Set(['o']), {
                preferredDrawingId: drawingO.id,
                preferredSourceGlyphName: 'o'
            });
        } finally {
            bridge.endTransaction();
        }
        expect(documentsOf(bridge)).not.toBe(before);
    });

    function loadFustat() {
        const fixturePath = path.join(
            __dirname,
            '..',
            'examples',
            'Fustat.glyphs'
        );
        const raw = JSON.parse(
            open_font_file(
                'Fustat.glyphs',
                fs.readFileSync(fixturePath, 'utf-8')
            )
        );
        // Fustat’s composites are aligned by hand; align oacute
        // automatically so moving o’s top anchor recomposes it.
        const seed = Font.fromData(raw);
        withSuppressedModelRecording(() => {
            for (const drawing of seed.findGlyph('oacute').drawings) {
                for (const shape of drawing.shapes) {
                    const component = shape.asComponent?.();
                    if (component) {
                        component.automaticAlignment = true;
                    }
                }
            }
        });
        return JSON.parse(seed.toJSONString());
    }

    it('recomposes the dependents in the model and writes nothing', () => {
        const { bridge, fontModel, layerO: drawingO } = setUp();
        const oacuteDrawing = fontModel
            .findGlyph('oacute')
            .findDrawingById(drawingO.id);
        expect(oacuteDrawing.isAutomaticAlignedDrawing()).toBe(true);
        const oacuteBefore = JSON.stringify(oacuteDrawing.toJSON());
        const accentOffset = () =>
            JSON.stringify(
                fontModel
                    .findGlyph('oacute')
                    .findDrawingById(drawingO.id)
                    .toJSON()
                    .shapes.find((shape) => shape.reference === 'acutecomb')
                    .transform?.translation
            );
        const offsetBefore = accentOffset();
        const committed = [];
        bridge.onCommittedChange((entries) => committed.push(entries));
        const before = documentsOf(bridge);

        const changed = recomposeCollaboratorCascade(bridge, [
            {
                glyphName: 'o',
                layerId: drawingO.id,
                editKinds: new Set(['anchor'])
            }
        ]);

        expect(changed).toContainEqual({
            glyphName: 'oacute',
            layerId: oacuteDrawing.id
        });
        expect(changed.some((target) => target.glyphName === 'o')).toBe(false);
        expect(JSON.stringify(oacuteDrawing.toJSON())).not.toBe(oacuteBefore);
        // Nothing reached the documents or any committed-change listener.
        expect(documentsOf(bridge)).toBe(before);
        expect(committed).toEqual([]);

        expect(accentOffset()).not.toBe(offsetBefore);

        // A revert puts the documents’ layer back into the model.
        bridge.revertLivePreviewDrawings(changed);
        expect(accentOffset()).toBe(offsetBefore);
    });

    it('settles a preview into the documents outside the undo history', () => {
        const { bridge, fontModel, layerO: drawingO } = setUp();
        const changed = recomposeCollaboratorCascade(bridge, [
            {
                glyphName: 'o',
                layerId: drawingO.id,
                editKinds: new Set(['anchor'])
            }
        ]);
        const oacuteId = fontModel
            .findGlyph('oacute')
            .findDrawingById(drawingO.id).id;
        const previewed = drawingFingerprint(
            fontModel.findGlyph('oacute').findDrawingById(oacuteId)
        );
        const committed = [];
        bridge.onCommittedChange((entries) => committed.push(entries));
        const envelopes = [];
        bridge.onLocalUpdate((_update, envelope, _entries, documentId) =>
            envelopes.push({ envelope, documentId })
        );
        const before = documentsOf(bridge);

        const written = bridge.writeLivePreviewDrawings(changed);
        // Stamped like a commit, so windows without a socket for the glyph
        // learn of it from the revision feed.
        const oacutePacket = envelopes.find(
            ({ documentId }) =>
                documentId ===
                `glyph:${bridge.glyphDocumentIdForName('oacute').replace(/^glyph:/, '')}`
        );
        expect(oacutePacket?.envelope?.glyphRevision).toEqual(
            expect.stringContaining(':')
        );

        expect(written).toContainEqual({
            glyphName: 'oacute',
            layerId: oacuteId
        });
        expect(documentsOf(bridge)).not.toBe(before);
        expect(committed.flat().map((entry) => entry.path)).toContain(
            `glyphs.oacute:layers.${oacuteId}:`
        );
        // The documents now hold the preview: a revert keeps it.
        bridge.revertLivePreviewDrawings(written);
        expect(
            drawingFingerprint(
                fontModel.findGlyph('oacute').findDrawingById(oacuteId)
            )
        ).toBe(previewed);
        expect(bridge.canUndo('oacute', oacuteId)).toBe(false);
        // Written once: a second settle finds nothing to change.
        expect(bridge.writeLivePreviewDrawings(written)).toEqual([]);
    });

    it('settles what the cascade makes now, not a preview made before the base changed', () => {
        const { bridge, fontModel, layerO: drawingO } = setUp();
        const oacuteId = fontModel
            .findGlyph('oacute')
            .findDrawingById(drawingO.id).id;
        const stored = drawingFingerprint(
            fontModel.findGlyph('oacute').findDrawingById(oacuteId)
        );
        const sources = [
            {
                glyphName: 'o',
                layerId: drawingO.id,
                editKinds: new Set(['anchor'])
            }
        ];
        // Previewed against the moved anchor of o …
        const changed = recomposeCollaboratorCascade(bridge, sources);
        expect(changed).toContainEqual({
            glyphName: 'oacute',
            layerId: oacuteId
        });
        // … then o is back to what its documents hold, without recomposing
        // oacute.
        bridge.revertLivePreviewDrawings([
            { glyphName: 'o', layerId: drawingO.id }
        ]);

        expect(recomposeForSettle(bridge, changed, sources)).toEqual([]);
        expect(
            drawingFingerprint(
                fontModel.findGlyph('oacute').findDrawingById(oacuteId)
            )
        ).toBe(stored);
    });

    it('settles a preview the cascade still makes', () => {
        const { bridge, fontModel, layerO: drawingO } = setUp();
        const sources = [
            {
                glyphName: 'o',
                layerId: drawingO.id,
                editKinds: new Set(['anchor'])
            }
        ];
        const changed = recomposeCollaboratorCascade(bridge, sources);
        const oacuteId = fontModel
            .findGlyph('oacute')
            .findDrawingById(drawingO.id).id;
        expect(recomposeForSettle(bridge, changed, sources)).toContainEqual({
            glyphName: 'oacute',
            layerId: oacuteId
        });
    });

    /** Fustat with o's left sidebearing moved in the model only. */
    function setUpSidebearing(prepareSeed = () => {}) {
        const seed = Font.fromData(loadFustat());
        withSuppressedModelRecording(() => prepareSeed(seed));
        const fontData = JSON.parse(seed.toJSONString());
        const bridge = new PatchSyncEngine();
        bridge.initFromJson(JSON.parse(JSON.stringify(fontData)));
        const fontModel = Font.fromData(fontData);
        window.patchSyncEngine = bridge;
        window.fontManager = {
            currentFont: { fontModel, markDirty: () => {} }
        };
        const drawingO = fontModel.findGlyph('o').drawings[0];
        withSuppressedModelRecording(() => {
            drawingO.setDirectSidebearing('left', drawingO.lsb + 50);
        });
        const sources = [
            {
                glyphName: 'o',
                layerId: drawingO.id,
                editKinds: new Set(['sidebearing'])
            }
        ];
        return { bridge, fontModel, sources };
    }

    it('settles a composite and the composite built on it together', () => {
        const { bridge, sources } = setUpSidebearing((seed) => {
            for (const name of ['oslash', 'oslashacute']) {
                for (const drawing of seed.findGlyph(name).drawings) {
                    for (const shape of drawing.shapes) {
                        if (shape.isComponent?.()) {
                            shape.asComponent().automaticAlignment = true;
                        }
                    }
                }
            }
        });
        const changed = recomposeCollaboratorCascade(bridge, sources);
        const nested = changed.filter((target) =>
            ['oslash', 'oslashacute'].includes(target.glyphName)
        );
        expect(nested.map((target) => target.glyphName).sort()).toEqual([
            'oslash',
            'oslashacute'
        ]);
        expect(
            recomposeForSettle(bridge, nested, sources)
                .map((target) => target.glyphName)
                .sort()
        ).toEqual(['oslash', 'oslashacute']);
    });

    it('settles what the cascade builds on a settled composite with it', () => {
        const { bridge, sources } = setUpSidebearing((seed) => {
            for (const name of ['oslash', 'oslashacute']) {
                for (const drawing of seed.findGlyph(name).drawings) {
                    for (const shape of drawing.shapes) {
                        if (shape.isComponent?.()) {
                            shape.asComponent().automaticAlignment = true;
                        }
                    }
                }
            }
        });
        const changed = recomposeCollaboratorCascade(bridge, sources);
        // oslashacute's stored drawing arrived, built on the old oslash;
        // oslash is still waiting for its own.
        bridge.revertLivePreviewDrawings(
            changed.filter((target) => target.glyphName === 'oslashacute')
        );
        const oslash = changed.filter(
            (target) => target.glyphName === 'oslash'
        );
        expect(
            recomposeForSettle(bridge, oslash, sources)
                .map((target) => target.glyphName)
                .sort()
        ).toEqual(['oslash', 'oslashacute']);
    });

    it('finds a stored composite its components no longer make', () => {
        // o's sidebearing moved and was stored, but oacute was stored from
        // the old o (a collaborator's stale write won).
        const { bridge, fontModel } = setUpSidebearing();
        const drawingId = fontModel.findGlyph('o').drawings[0].id;
        const stale = recomposeStaleComposites(bridge, ['o']);
        expect(stale).toContainEqual({
            glyphName: 'oacute',
            layerId: drawingId
        });
        // Rebuilt the way the editor rebuilds it: nothing left to repair.
        const oacute = fontModel.findGlyph('oacute').findDrawingById(drawingId);
        oacute.invalidateLayoutCache?.();
        expect(oacute.rebuildAutomaticComposition()).toBe(false);
        // Written, then nothing is left to repair.
        bridge.writeLivePreviewDrawings(stale);
        expect(recomposeStaleComposites(bridge, ['o'])).toEqual([]);
    });

    it('leaves a composite whose automatic component is scaled as it was stored', () => {
        // A collaborator scaled the accent of oacute; the editor keeps the
        // scale and places it. That stored drawing is not stale.
        const seed = Font.fromData(loadFustat());
        withSuppressedModelRecording(() => {
            for (const drawing of seed.findGlyph('oacute').drawings) {
                const accent = drawing.components[1];
                accent.transform = {
                    ...(accent.transform ?? {}),
                    scale: [1.1, 1.1]
                };
                drawing.invalidateLayoutCache?.();
                drawing.rebuildAutomaticComposition();
            }
        });
        const fontData = JSON.parse(seed.toJSONString());
        const bridge = new PatchSyncEngine();
        bridge.initFromJson(JSON.parse(JSON.stringify(fontData)));
        window.patchSyncEngine = bridge;
        window.fontManager = {
            currentFont: {
                fontModel: Font.fromData(fontData),
                markDirty: () => {}
            }
        };
        expect(
            recomposeStaleComposites(bridge, ['oacute', 'acutecomb'])
        ).toEqual([]);
    });

    it('leaves a composite whose component this window does not hold', () => {
        // oacute is stale (o moved), but acutecomb's document is not
        // resident here: its data may be old, so nothing is rebuilt.
        const { bridge } = setUpSidebearing();
        const acutecomb = bridge.glyphDocumentIdForName('acutecomb');
        const resident = bridge.hasResidentGlyphDocument.bind(bridge);
        bridge.hasResidentGlyphDocument = (documentId) =>
            documentId !== acutecomb && resident(documentId);
        expect(
            recomposeStaleComposites(bridge, ['o']).map((t) => t.glyphName)
        ).not.toContain('oacute');
    });

    it('leaves a composite that is not automatically aligned throughout', () => {
        // oslash is a contour and an automatic o: the editor does not
        // recompose it, so neither does the repair.
        const { bridge } = setUpSidebearing((seed) => {
            for (const drawing of seed.findGlyph('oslash').drawings) {
                for (const shape of drawing.shapes) {
                    if (shape.isComponent?.()) {
                        shape.asComponent().automaticAlignment = true;
                    }
                }
            }
        });
        expect(
            recomposeStaleComposites(bridge, ['o']).map((t) => t.glyphName)
        ).not.toContain('oslash');
    });

    it('repairs only composites that depend on what changed', () => {
        // o moved in the model only. A change to acutecomb rebuilds oacute
        // (built on both); a change to an unrelated glyph rebuilds nothing.
        const { bridge } = setUpSidebearing();
        expect(
            recomposeStaleComposites(bridge, ['acutecomb']).map(
                (target) => target.glyphName
            )
        ).toContain('oacute');
        expect(recomposeStaleComposites(bridge, ['x'])).toEqual([]);
    });

    it('finds nothing to repair in a consistent font', () => {
        const { bridge } = setUp();
        // setUp moved o's anchor in the model only: put it back first.
        const drawingO =
            window.fontManager.currentFont.fontModel.findGlyph('o').drawings[0];
        bridge.revertLivePreviewDrawings([
            { glyphName: 'o', layerId: drawingO.id }
        ]);
        expect(recomposeStaleComposites(bridge, ['o', 'oacute'])).toEqual([]);
    });

    it('settles a width a metrics key sets', () => {
        const { bridge, sources } = setUpSidebearing((seed) => {
            const n = seed.findGlyph('n');
            n.format_specific = {
                ...(n.format_specific ?? {}),
                metric_left: '=o'
            };
        });
        const changed = recomposeCollaboratorCascade(bridge, sources);
        const n = changed.filter((target) => target.glyphName === 'n');
        expect(n).toHaveLength(1);
        expect(recomposeForSettle(bridge, n, sources)).toEqual(n);
    });

    it('leaves a collaborator’s automatic composite as it was stored', () => {
        // o’s top anchor moved here only (setUp): the collaborator placed
        // the accent of oacute against an o this window does not have.
        const { bridge, fontModel, layerO: drawingO } = setUp();
        const oacuteDrawing = fontModel
            .findGlyph('oacute')
            .findDrawingById(drawingO.id);
        const stored = JSON.stringify(oacuteDrawing.toJSON());

        const changed = recomposeCollaboratorCascade(bridge, [
            {
                glyphName: 'oacute',
                layerId: drawingO.id,
                editKinds: new Set(['component', 'anchor'])
            }
        ]);

        expect(JSON.stringify(oacuteDrawing.toJSON())).toBe(stored);
        expect(changed.some((target) => target.glyphName === 'oacute')).toBe(
            false
        );
    });

    it('leaves a collaborator’s keyed sidebearing as it was stored', () => {
        const { bridge, fontModel, layerO: drawingO } = setUp();
        const glyphN = fontModel.findGlyph('n');
        const drawingN = glyphN.findDrawingById(drawingO.id);
        withSuppressedModelRecording(() => {
            glyphN.format_specific = {
                ...(glyphN.format_specific ?? {}),
                metric_left: '=o'
            };
            // The collaborator’s n follows an o this window does not have.
            drawingN.setDirectSidebearing('left', drawingN.lsb + 30);
        });
        const stored = JSON.stringify(drawingN.toJSON());

        recomposeCollaboratorCascade(bridge, [
            {
                glyphName: 'n',
                layerId: drawingO.id,
                editKinds: new Set(['sidebearing'])
            }
        ]);

        expect(JSON.stringify(drawingN.toJSON())).toBe(stored);
    });

    it('traces each recompose: sources, rewrites and previews', () => {
        const { bridge, layerO: drawingO } = setUp();
        window.__collabTrace = { enabled: true, entries: [] };
        try {
            recomposeCollaboratorCascade(bridge, [
                {
                    glyphName: 'o',
                    layerId: drawingO.id,
                    editKinds: new Set(['anchor'])
                }
            ]);
            const [entry] = window.__collabTrace.entries;
            expect(entry.kind).toBe('cascade-recompose');
            expect(entry.detail.sources).toEqual([`o/${drawingO.id} [anchor]`]);
            expect(entry.detail.sourcesRewritten).toEqual({});
            expect(Object.keys(entry.detail.previewed)).toContain(
                `oacute/${drawingO.id}`
            );
            expect(entry.glyphs).toEqual(
                expect.arrayContaining(['o', 'oacute'])
            );
        } finally {
            delete window.__collabTrace;
        }
    });

    it('reports nothing when the dependents are already up to date', () => {
        const { bridge, layerO: drawingO } = setUp();
        const source = {
            glyphName: 'o',
            layerId: drawingO.id,
            editKinds: new Set(['anchor'])
        };

        expect(recomposeCollaboratorCascade(bridge, [source])).not.toEqual([]);
        expect(recomposeCollaboratorCascade(bridge, [source])).toEqual([]);
    });
});

describe('createRemoteCascadePreviewHost', () => {
    const {
        createRemoteCascadePreviewHost
    } = require('../js/change-bridge-init');

    afterEach(() => {
        delete window.fontManager;
        delete window.cloudPlugin;
    });

    it('counts a linked window’s live preview as busy', () => {
        let previewing = true;
        const host = createRemoteCascadePreviewHost({}, () => previewing);
        expect(host.isBusyLocally()).toBe(true);
        previewing = false;
        expect(host.isBusyLocally()).toBe(false);
    });

    it('clears the worker overlay before recompiling a reverted preview', async () => {
        const calls = [];
        let clear;
        window.fontManager = {
            clearRemoteCascadePreviewOverlay: () => {
                calls.push('clear');
                return new Promise((resolve) => {
                    clear = resolve;
                });
            },
            currentFont: {
                requestRecompileWithoutDataChange: () => calls.push('compile')
            }
        };
        // The documents already hold the preview: nothing is written.
        const bridge = {
            writeLivePreviewDrawings: () => [],
            revertLivePreviewDrawings: () => calls.push('revert')
        };
        const host = createRemoteCascadePreviewHost(bridge);

        expect(host.settle([aacute], [], [])).toEqual([]);
        // Put back before recomposing, then reverted as unchanged.
        expect(calls).toEqual(['revert', 'revert', 'clear']);
        clear();
        await settled();
        expect(calls).toEqual(['revert', 'revert', 'clear', 'compile']);
    });
});
