const fs = require('fs');
const path = require('path');

const {
    RemoteCascadePreview,
    REMOTE_CASCADE_PREVIEW_MAX_MS,
    REMOTE_CASCADE_BUSY_RETRY_MS
} = require('../js/remote-cascade-preview');
const { recomposeCollaboratorCascade } = require('../js/change-bridge-init');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const { Font, withSuppressedModelRecording } = require('../js/babelfont-model');
const { open_font_file } = require('../wasm-dist/babelfont_fontc_web');
const { joinPathWithGlyphSeparator } = require('../js/change-log');

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
            )
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
        expect(host.repaints).toEqual([['aacute']]);
        expect(preview.pendingTargets).toEqual([aacute]);
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

    it('reverts a preview whose stored layer never arrives', async () => {
        const time = fakeClock();
        const host = fakeHost([[aacute]]);
        const preview = new RemoteCascadePreview(host, time.clock);

        preview.noteCollaboratorEdit(anchorEdit);
        time.flush();
        await settled();
        time.advance(REMOTE_CASCADE_PREVIEW_MAX_MS - 1);
        expect(host.reverted).toEqual([]);
        time.advance(1);

        expect(host.reverted).toEqual([['aacute/m1']]);
        expect(preview.pendingTargets).toEqual([]);
    });

    it('waits with the revert while the window is busy with its own edit', async () => {
        const time = fakeClock();
        const host = fakeHost([[aacute]]);
        const preview = new RemoteCascadePreview(host, time.clock);

        preview.noteCollaboratorEdit(anchorEdit);
        time.flush();
        await settled();
        host.busy = true;
        time.advance(REMOTE_CASCADE_PREVIEW_MAX_MS);
        expect(host.reverted).toEqual([]);
        host.busy = false;
        time.advance(REMOTE_CASCADE_BUSY_RETRY_MS);

        expect(host.reverted).toEqual([['aacute/m1']]);
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
        const layerO = fontModel.findGlyph('o').layers[0];
        withSuppressedModelRecording(() => {
            const top = layerO.anchors.find((anchor) => anchor.name === 'top');
            top.x += 40;
            top.y += 60;
        });
        return { bridge, fontModel, layerO };
    }

    function documentsOf(bridge) {
        return Buffer.from(bridge.encodeBridgeState()).toString('base64');
    }

    it('records the same rebuild when recording is on (control)', () => {
        const { bridge, fontModel, layerO } = setUp();
        const before = documentsOf(bridge);
        bridge.beginTransaction('Control', null, {
            compileChangeSource: 'test',
            compileEditType: null
        });
        try {
            fontModel.rebuildAutomaticCompositesForGlyphs(new Set(['o']), {
                preferredLayerId: layerO.id,
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
            for (const layer of seed.findGlyph('oacute').layers) {
                for (const shape of layer.shapes) {
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
        const { bridge, fontModel, layerO } = setUp();
        const oacuteLayer = fontModel
            .findGlyph('oacute')
            .findLayerById(layerO.id);
        expect(oacuteLayer.isAutomaticAlignedLayer()).toBe(true);
        const oacuteBefore = JSON.stringify(oacuteLayer.toJSON());
        const accentOffset = () =>
            JSON.stringify(
                fontModel
                    .findGlyph('oacute')
                    .findLayerById(layerO.id)
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
                layerId: layerO.id,
                editKinds: new Set(['anchor'])
            }
        ]);

        expect(changed).toContainEqual({
            glyphName: 'oacute',
            layerId: oacuteLayer.id
        });
        expect(changed.some((target) => target.glyphName === 'o')).toBe(false);
        expect(JSON.stringify(oacuteLayer.toJSON())).not.toBe(oacuteBefore);
        // Nothing reached the documents or any committed-change listener.
        expect(documentsOf(bridge)).toBe(before);
        expect(committed).toEqual([]);

        expect(accentOffset()).not.toBe(offsetBefore);

        // A revert puts the documents’ layer back into the model.
        bridge.revertLivePreviewLayers(changed);
        expect(accentOffset()).toBe(offsetBefore);
    });

    it('reports nothing when the dependents are already up to date', () => {
        const { bridge, layerO } = setUp();
        const source = {
            glyphName: 'o',
            layerId: layerO.id,
            editKinds: new Set(['anchor'])
        };

        expect(recomposeCollaboratorCascade(bridge, [source])).not.toEqual([]);
        expect(recomposeCollaboratorCascade(bridge, [source])).toEqual([]);
    });
});
