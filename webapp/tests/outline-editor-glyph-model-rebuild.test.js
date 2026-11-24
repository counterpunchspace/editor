/**
 * An arrow-key edit waits for a debounced commit. If the engine rebuilds the
 * edited glyph's model objects from its document in that window (a live
 * socket closing before it synced, a rebaseline, a catch-up rebuild), the
 * edit must still reach the glyph's document, and the model must show it.
 */
const { Font } = require('../js/babelfont-model');
const fontManager = require('../js/font-manager').default;
const { drawingFingerprint } = require('../js/collab-trace');
const {
    getCollabIntegrityEvents
} = require('../js/cloud-collab-integrity-debug');
const {
    historyReplayNoticeMessage,
    installHistoryReplayNotices
} = require('../js/font-windows/dialogs');

const clone = (value) => JSON.parse(JSON.stringify(value));

function fontData() {
    const transform = (x, y) => ({
        translation: [x, y],
        scale: [1, 1],
        rotation: 0,
        skew: [0, 0],
        order: 'RestOfTheWorld'
    });
    return {
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [
            {
                id: 'M1',
                name: { en: 'Regular' },
                location: {},
                guides: [],
                metrics: {},
                kerning: {}
            }
        ],
        glyphs: [
            {
                name: 'n',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'M1',
                        width: 500,
                        master: { type: 'DefaultForMaster', master: 'M1' },
                        shapes: [
                            {
                                nodes: [
                                    { x: 100, y: 0, nodetype: 'Line' },
                                    { x: 400, y: 0, nodetype: 'Line' },
                                    { x: 400, y: 500, nodetype: 'Line' },
                                    { x: 100, y: 500, nodetype: 'Line' }
                                ],
                                closed: true
                            }
                        ],
                        anchors: [],
                        guides: []
                    }
                ]
            },
            {
                name: 'q',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'M1',
                        width: 660,
                        master: { type: 'DefaultForMaster', master: 'M1' },
                        shapes: [
                            { reference: 'n', transform: transform(0, 0) }
                        ],
                        anchors: [],
                        guides: []
                    }
                ]
            }
        ],
        names: { family_name: { en: 'Rebuild Test' } },
        note: '',
        date: '2026-11-23',
        features: {},
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    };
}

/**
 * Stands in for the engine: one document per drawing, packets for every
 * drawing a sync changed, and model rebuilds read from the documents.
 */
class FakeEngine {
    constructor(currentFont, { withRebuildHook }) {
        this.currentFont = currentFont;
        this.docs = new Map();
        for (const glyph of currentFont.babelfontData.glyphs) {
            for (const layer of glyph.layers) {
                this.docs.set(`${glyph.name}/${layer.id}`, clone(layer));
            }
        }
        this.packets = [];
        this.beforeListeners = [];
        this.rebuiltListeners = [];
        this.syncGlyphFromJson = jest.fn();
        this.beginTransaction = jest.fn();
        this.endTransaction = jest.fn();
        this.recordChange = jest.fn();
        if (withRebuildHook) {
            // The engine's API (patch-sync-engine.ts).
            this.onBeforeGlyphModelRebuild = (listener) => {
                this.beforeListeners.push(listener);
                return () => {
                    this.beforeListeners = this.beforeListeners.filter(
                        (entry) => entry !== listener
                    );
                };
            };
            this.onGlyphModelRebuilt = (listener) => {
                this.rebuiltListeners.push(listener);
                return () => {
                    this.rebuiltListeners = this.rebuiltListeners.filter(
                        (entry) => entry !== listener
                    );
                };
            };
        }
    }

    syncDrawingSnapshotsFromJson(snapshots) {
        if (this.applyingRemote) {
            throw new Error('commit inside a remote apply');
        }
        for (const snapshot of snapshots) {
            const key = `${snapshot.glyphName}/${snapshot.layerId}`;
            const before = this.docs.get(key);
            if (
                drawingFingerprint(before) ===
                drawingFingerprint(snapshot.drawingJson)
            ) {
                continue;
            }
            this.docs.set(key, clone(snapshot.drawingJson));
            this.packets.push({
                document: `glyph:${snapshot.glyphName}`,
                path: key
            });
        }
    }

    livePreviewDrawingDiffers(target) {
        const model = this.currentFont.fontModel
            .findGlyph(target.glyphName)
            ?.findDrawingById(target.layerId);
        return (
            drawingFingerprint(model) !==
            drawingFingerprint(
                this.docs.get(`${target.glyphName}/${target.layerId}`)
            )
        );
    }

    /**
     * Replace every model object with one read from the documents. Like the
     * engine, the before-listeners do not run inside a remote apply
     * (`insideRemoteApply`); the rebuilt listeners always do.
     */
    rebuildFromDocuments(
        glyphs,
        cause = 'rebaseline',
        { insideRemoteApply = false } = {}
    ) {
        const event = { glyphs, cause };
        if (!insideRemoteApply) {
            for (const listener of [...this.beforeListeners]) {
                listener(event);
            }
        }
        const data = clone(this.currentFont.babelfontData);
        for (const glyph of data.glyphs) {
            glyph.layers = glyph.layers.map((layer) =>
                clone(this.docs.get(`${glyph.name}/${layer.id}`))
            );
        }
        this.currentFont.babelfontData = data;
        this.currentFont.fontModel = Font.fromData(clone(data));
        this.applyingRemote = insideRemoteApply;
        try {
            for (const listener of [...this.rebuiltListeners]) {
                listener(event);
            }
        } finally {
            this.applyingRemote = false;
        }
    }
}

const arrowRight = () => ({
    key: 'ArrowRight',
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    preventDefault: jest.fn()
});

describe('arrow-key edit across a glyph model rebuild', () => {
    let canvas;
    let currentFont;
    let currentFontSpy;
    let stageSpy;
    let originalEngine;
    let originalChangeBridge;

    function setUp({ withRebuildHook }) {
        const data = fontData();
        currentFont = {
            babelfontData: clone(data),
            fontModel: Font.fromData(clone(data))
        };
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockImplementation(() => currentFont);
        stageSpy = jest
            .spyOn(fontManager, 'stageLiveDragPreviewFromModel')
            .mockResolvedValue(undefined);

        const engine = new FakeEngine(currentFont, { withRebuildHook });
        originalEngine = window.patchSyncEngine;
        originalChangeBridge = window.changeBridge;
        window.patchSyncEngine = engine;
        window.changeBridge = engine;

        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        const editor = canvas.outlineEditor;
        canvas.getCurrentGlyphName = jest.fn(() => 'q');
        editor.currentGlyphName = 'q';
        editor.active = true;
        editor.selectedDrawingId = 'M1';
        // The bridge queues the reload of the edited drawing; do what it
        // does once the queue reaches it.
        editor.requestEditedDrawingReload = jest.fn(() => {
            void Promise.resolve().then(() => {
                editor.refreshSelectedDrawingFromModel();
            });
        });
        editor.saveDrawingData = jest.fn(async () => {});
        jest.spyOn(editor, 'computeRecompositionClosure').mockReturnValue({
            allTargets: [{ glyphName: 'q', layerId: 'M1' }],
            recomposeTargets: [],
            invalidateTargets: [],
            dependentTargets: [],
            affectedGlyphNames: new Set(['q']),
            recomposeGlyphNames: new Set(),
            invalidateGlyphNames: new Set()
        });
        jest.spyOn(
            editor,
            'applyMetricsKeysToCurrentEditedDrawing'
        ).mockReturnValue(null);
        expect(editor.refreshSelectedDrawingFromModel()).toBe(true);
        editor.selectedComponents = [0];
        return engine;
    }

    afterEach(() => {
        canvas?.outlineEditor.keyboardPreviewEditFunnel.reset();
        canvas?.destroy();
        canvas = null;
        currentFontSpy?.mockRestore();
        stageSpy?.mockRestore();
        window.patchSyncEngine = originalEngine;
        window.changeBridge = originalChangeBridge;
        jest.useRealTimers();
        document.body.innerHTML = '';
    });

    const translationOf = (drawing) =>
        drawing.shapes[0].transform.translation ?? [
            drawing.shapes[0].transform[4],
            drawing.shapes[0].transform[5]
        ];

    const modelDrawing = () =>
        currentFont.fontModel.findGlyph('q').findDrawingById('M1');

    const lostEdits = (since) =>
        getCollabIntegrityEvents()
            .slice(since)
            .filter((event) => event.type === 'preview-edit-lost');

    async function commitAfterDebounce() {
        await jest.advanceTimersByTimeAsync(1500);
        await canvas.outlineEditor.flushPendingKeyboardPreviewCommit();
    }

    test('a rebuild between the arrow key and the debounced commit keeps the move (engine announces rebuilds)', async () => {
        jest.useFakeTimers();
        const engine = setUp({ withRebuildHook: true });
        const eventsBefore = getCollabIntegrityEvents().length;

        await canvas.outlineEditor.onKeyDown(arrowRight());
        expect(engine.beforeListeners).toHaveLength(1);
        expect(engine.rebuiltListeners).toHaveLength(1);
        expect(translationOf(engine.docs.get('q/M1'))).toEqual([0, 0]);

        engine.rebuildFromDocuments(['q']);
        await commitAfterDebounce();

        const doc = engine.docs.get('q/M1');
        expect(translationOf(doc)).toEqual([1, 0]);
        expect(engine.packets).toEqual([{ document: 'glyph:q', path: 'q/M1' }]);
        expect(drawingFingerprint(modelDrawing())).toBe(
            drawingFingerprint(doc)
        );
        expect(
            translationOf(canvas.outlineEditor.getCurrentDrawingDataFromStack())
        ).toEqual([1, 0]);
        expect(lostEdits(eventsBefore)).toEqual([]);
    });

    test('a rebuild announced only afterwards (inside a remote apply, every glyph) keeps the move without committing inside the apply', async () => {
        jest.useFakeTimers();
        const engine = setUp({ withRebuildHook: true });
        const eventsBefore = getCollabIntegrityEvents().length;

        await canvas.outlineEditor.onKeyDown(arrowRight());
        engine.rebuildFromDocuments(null, 'remote-update', {
            insideRemoteApply: true
        });
        // Nothing was written inside the apply.
        expect(engine.packets).toEqual([]);
        expect(
            canvas.outlineEditor.requestEditedDrawingReload
        ).toHaveBeenCalled();
        await commitAfterDebounce();

        const doc = engine.docs.get('q/M1');
        expect(translationOf(doc)).toEqual([1, 0]);
        expect(engine.packets).toEqual([{ document: 'glyph:q', path: 'q/M1' }]);
        expect(drawingFingerprint(modelDrawing())).toBe(
            drawingFingerprint(doc)
        );
        expect(lostEdits(eventsBefore)).toEqual([]);
    });

    test('a rebuild with no reload before the debounced commit still commits the move into the rebuilt model', async () => {
        jest.useFakeTimers();
        const engine = setUp({ withRebuildHook: false });
        const eventsBefore = getCollabIntegrityEvents().length;

        await canvas.outlineEditor.onKeyDown(arrowRight());
        engine.rebuildFromDocuments(['q']);
        await commitAfterDebounce();

        const doc = engine.docs.get('q/M1');
        expect(translationOf(doc)).toEqual([1, 0]);
        expect(drawingFingerprint(modelDrawing())).toBe(
            drawingFingerprint(doc)
        );
        expect(engine.packets).toHaveLength(1);
        expect(lostEdits(eventsBefore)).toEqual([]);
    });

    test('a rebuilt model drawing that already carries the editor’s own preview is not a conflict', async () => {
        // Fuzz seed 1057053092 step 20: a catch-up rebuilt every glyph, the
        // live preview wrote the move into the rebuilt drawing, and the
        // commit took the editor’s own change for a collaborator’s.
        jest.useFakeTimers();
        const engine = setUp({ withRebuildHook: false });
        const eventsBefore = getCollabIntegrityEvents().length;

        await canvas.outlineEditor.onKeyDown(arrowRight());
        // The rebuilt drawing already shows the editor’s preview: the live
        // preview wrote the move into it after the rebuild.
        const moved = clone(engine.docs.get('q/M1'));
        moved.shapes[0].transform = {
            ...moved.shapes[0].transform,
            translation: [1, 0]
        };
        const stored = engine.docs.get('q/M1');
        engine.docs.set('q/M1', moved);
        engine.rebuildFromDocuments(['q']);
        engine.docs.set('q/M1', stored);
        expect(drawingFingerprint(modelDrawing())).toBe(
            canvas.outlineEditor._previewEditGuard.editorExpected
        );
        await commitAfterDebounce();

        const doc = engine.docs.get('q/M1');
        expect(translationOf(doc)).toEqual([1, 0]);
        expect(engine.packets).toHaveLength(1);
        expect(lostEdits(eventsBefore)).toEqual([]);
    });

    test('a collaborator change under the pending edit is found by the debounced commit too', async () => {
        jest.useFakeTimers();
        const engine = setUp({ withRebuildHook: false });
        const eventsBefore = getCollabIntegrityEvents().length;

        await canvas.outlineEditor.onKeyDown(arrowRight());
        const theirs = clone(engine.docs.get('q/M1'));
        theirs.width = 700;
        engine.docs.set('q/M1', theirs);
        engine.rebuildFromDocuments(['q'], 'catch-up');
        await commitAfterDebounce();

        expect(engine.docs.get('q/M1').width).toBe(700);
        expect(engine.packets).toEqual([]);
        expect(lostEdits(eventsBefore)).toEqual([
            expect.objectContaining({
                cause: 'conflict',
                reason: 'debounced-commit'
            })
        ]);
    });

    test('a rebuild the engine does not announce is caught when the editor reloads the drawing', async () => {
        jest.useFakeTimers();
        const engine = setUp({ withRebuildHook: false });
        const eventsBefore = getCollabIntegrityEvents().length;

        await canvas.outlineEditor.onKeyDown(arrowRight());
        engine.rebuildFromDocuments(['q']);
        // The bridge's reload after the remote change.
        canvas.outlineEditor.refreshSelectedDrawingFromModel();
        await commitAfterDebounce();

        const doc = engine.docs.get('q/M1');
        expect(translationOf(doc)).toEqual([1, 0]);
        expect(drawingFingerprint(modelDrawing())).toBe(
            drawingFingerprint(doc)
        );
        expect(engine.packets).toHaveLength(1);
        expect(lostEdits(eventsBefore)).toEqual([]);
    });

    test('a collaborator change under the pending edit keeps theirs and reports the lost move', async () => {
        jest.useFakeTimers();
        const engine = setUp({ withRebuildHook: false });
        const eventsBefore = getCollabIntegrityEvents().length;

        await canvas.outlineEditor.onKeyDown(arrowRight());
        const theirs = clone(engine.docs.get('q/M1'));
        theirs.width = 700;
        engine.docs.set('q/M1', theirs);
        engine.rebuildFromDocuments(['q'], 'catch-up');
        canvas.outlineEditor.refreshSelectedDrawingFromModel();
        await commitAfterDebounce();

        expect(engine.docs.get('q/M1').width).toBe(700);
        expect(translationOf(engine.docs.get('q/M1'))).toEqual([0, 0]);
        expect(engine.packets).toEqual([]);
        expect(lostEdits(eventsBefore)).toEqual([
            expect.objectContaining({
                glyphName: 'q',
                drawingId: 'M1',
                cause: 'conflict'
            })
        ]);
        expect(document.body.textContent).toContain(
            'Your arrow-key change to “q” wasn’t saved: a collaborator changed the same drawing'
        );
    });

    test('a commit that writes nothing although the editor moved something is reported, not dropped silently', async () => {
        jest.useFakeTimers();
        const engine = setUp({ withRebuildHook: true });
        const eventsBefore = getCollabIntegrityEvents().length;
        const syncSpy = jest
            .spyOn(canvas.outlineEditor, '_syncCurrentGlyphToYDoc')
            .mockImplementation(() => {});

        await canvas.outlineEditor.onKeyDown(arrowRight());
        await commitAfterDebounce();

        expect(syncSpy).toHaveBeenCalledTimes(1);
        expect(engine.packets).toEqual([]);
        expect(lostEdits(eventsBefore)).toEqual([
            expect.objectContaining({
                glyphName: 'q',
                drawingId: 'M1',
                cause: 'not-written',
                reason: 'debounced-commit'
            })
        ]);
        expect(document.body.textContent).toContain(
            'Your arrow-key change to “q” wasn’t saved'
        );
    });

    test('moving and moving back is not a lost edit', async () => {
        jest.useFakeTimers();
        const engine = setUp({ withRebuildHook: true });
        const eventsBefore = getCollabIntegrityEvents().length;

        await canvas.outlineEditor.onKeyDown(arrowRight());
        await canvas.outlineEditor.onKeyDown({
            ...arrowRight(),
            key: 'ArrowLeft'
        });
        await commitAfterDebounce();

        expect(translationOf(engine.docs.get('q/M1'))).toEqual([0, 0]);
        expect(lostEdits(eventsBefore)).toEqual([]);
    });
});

describe('undo and redo notices', () => {
    test('messages for a refused and a failed undo or redo', () => {
        expect(
            historyReplayNoticeMessage('history-replay-blocked', {
                reason: 'document-not-loaded',
                historyAction: 'undo'
            })
        ).toBe(
            'Undo didn’t run: it changes parts of the font this window hasn’t loaded yet. Nothing was changed.'
        );
        expect(
            historyReplayNoticeMessage('history-replay-blocked', {
                reason: 'collaborator-edit',
                historyAction: 'undo'
            })
        ).toBeNull();
        expect(
            historyReplayNoticeMessage('history-replay-failed', {
                historyAction: 'redo',
                documentIdsNotRolledBack: []
            })
        ).toBe(
            'Redo failed, so nothing was changed and the history stayed where it was.'
        );
        expect(
            historyReplayNoticeMessage('history-replay-failed', {
                historyAction: 'undo',
                documentIdsNotRolledBack: ['glyph:abc']
            })
        ).toBe(
            'Undo failed part way, and some of its changes couldn’t be taken back. Reopen the font to see its current state.'
        );
    });

    test('the engine’s events show a notice', () => {
        const shownNotices = () =>
            [...document.querySelectorAll('.font-window-notice > span')].map(
                (node) => node.textContent
            );
        installHistoryReplayNotices();
        installHistoryReplayNotices();
        window.dispatchEvent(
            new CustomEvent('history-replay-blocked', {
                detail: {
                    reason: 'document-not-loaded',
                    historyAction: 'redo',
                    documentIds: ['glyph:abc']
                }
            })
        );
        window.dispatchEvent(
            new CustomEvent('history-replay-failed', {
                detail: {
                    historyAction: 'undo',
                    reason: 'boom',
                    documentIdsNotRolledBack: []
                }
            })
        );
        // Earlier notices may still be on screen; these are the newest two.
        expect(shownNotices().slice(-2)).toEqual([
            'Redo didn’t run: it changes parts of the font this window hasn’t loaded yet. Nothing was changed.',
            'Undo failed, so nothing was changed and the history stayed where it was.'
        ]);
    });
});
