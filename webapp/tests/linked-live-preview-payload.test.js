const { serialize } = require('v8');
const fontManager = require('../js/font-manager').default;

// The structured clone algorithm postMessage uses (jsdom lacks structuredClone).
const structuredClone = (value) => serialize(value);

/**
 * A live preview crosses to the other windows by postMessage, which copies
 * it with the structured clone algorithm. Layers recomposed during a drag
 * (an automatically aligned Ä when A's anchor moves) can hold live model
 * arrays that this algorithm refuses; the post then fails and linked windows
 * never see the drag.
 */
describe('linked live preview payload', () => {
    let queued;
    const originalWindowSync = window.windowSync;
    const originalBridge = window.patchSyncEngine;

    beforeEach(() => {
        queued = [];
        window.windowSync = {
            hasLinkedPeers: () => true,
            queueLivePreview: (payload) => queued.push(payload)
        };
        window.patchSyncEngine = { noteLivePreviewTick: jest.fn() };
    });

    afterEach(() => {
        window.windowSync = originalWindowSync;
        window.patchSyncEngine = originalBridge;
        jest.restoreAllMocks();
        fontManager._stagedLinkedPreview = null;
    });

    test('is plain data even when a recomposed layer holds live arrays', () => {
        // A Proxy stands in for a live model array: it cannot be cloned.
        const liveScale = new Proxy([1, 1], {});
        expect(() => structuredClone(liveScale)).toThrow();
        const recomposed = {
            width: 617,
            shapes: [
                { reference: 'A', transform: { translation: [0, 0] } },
                {
                    reference: 'dieresiscomb.case',
                    transform: { translation: [139, 0], scale: liveScale }
                }
            ]
        };
        const sourceLayer = {
            isAutomaticAlignedLayer: () => false,
            toJSON: () => ({ width: 617, anchors: [{ name: 'top', x: 1 }] })
        };
        jest.spyOn(fontManager, 'currentFont', 'get').mockReturnValue({
            fontModel: {
                findGlyph: (name) => ({
                    findLayerById: () =>
                        name === 'A'
                            ? sourceLayer
                            : { isAutomaticAlignedLayer: () => true }
                })
            }
        });
        fontManager._stagedLinkedPreview = {
            updates: [
                { glyphName: 'A', layerId: 'L', layerData: { width: 617 } },
                {
                    glyphName: 'Adieresis',
                    layerId: 'L',
                    layerData: recomposed
                }
            ],
            stagedAt: performance.now()
        };

        fontManager.broadcastLinkedLivePreview({
            changeSource: 'mouse-drag-anchor',
            editType: 'anchor'
        });

        expect(queued).toHaveLength(1);
        const payload = queued[0];
        expect(() => structuredClone(payload)).not.toThrow();
        expect(payload.overlay[1].layerData.shapes[1].transform).toEqual({
            translation: [139, 0],
            scale: [1, 1]
        });
        expect(payload.model.map((record) => record.glyphName)).toEqual(['A']);
    });
});
