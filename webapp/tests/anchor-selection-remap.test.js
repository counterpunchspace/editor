// Anchor selection follows anchor names across glyphs and layers: selecting
// "top" in glyph a and later entering the a component of adieresis selects
// the "top" anchor there, wherever it sits in the anchor list.
const { OutlineEditor } = require('../js/glyph-canvas/outline-editor');

function editor() {
    const instance = Object.create(OutlineEditor.prototype);
    instance.selectedAnchors = [];
    // Plain layer objects, not the active layer: anchors come from them.
    instance.resolveLayerModel = (layer) => layer;
    instance.getCurrentLayerModel = () => null;
    instance.getActiveSelectionScopeGlyphName = () => null;
    instance.getLayerGlyphName = () => null;
    return instance;
}

function anchors(...names) {
    return names.map((name, index) => ({ name, x: index * 10, y: 500 }));
}

describe('anchor selection remap by name', () => {
    test('maps names to their index in the next anchor list', () => {
        const oe = editor();
        expect(
            oe.remapAnchorSelectionNames(
                ['top'],
                anchors('bottom', 'ogonek', 'top')
            )
        ).toEqual([2]);
    });

    test('drops names the next layer lacks and uses each anchor once', () => {
        const oe = editor();
        expect(
            oe.remapAnchorSelectionNames(
                ['top', 'missing', 'top'],
                anchors('top', 'bottom', 'top')
            )
        ).toEqual([0, 2]);
        expect(oe.remapAnchorSelectionNames(['top'], [])).toEqual([]);
    });

    test('sanitizing a stored selection for another layer prefers names over indices', () => {
        const oe = editor();
        const restored = oe.sanitizeSelectionStateForLayer(
            {
                points: [],
                anchors: [0],
                anchorNames: ['top'],
                components: [],
                guideHandle: null
            },
            {
                shapes: [],
                anchors: anchors('_top', 'bottom', 'top'),
                guides: []
            }
        );
        expect(restored.anchors).toEqual([2]);
        expect(restored.anchorNames).toEqual(['top']);
    });

    test('switching between compatible layers keeps the named anchor selected', () => {
        const oe = editor();
        const previous = { shapes: [], anchors: anchors('top', 'bottom') };
        const next = { shapes: [], anchors: anchors('bottom', 'top') };
        const remapped = oe.remapSelectionStateBetweenLayers(
            {
                points: [],
                anchors: [0],
                anchorNames: [],
                components: [],
                guideHandle: null
            },
            previous,
            next
        );
        expect(remapped.anchors).toEqual([1]);
        expect(remapped.anchorNames).toEqual(['top']);
    });
});
