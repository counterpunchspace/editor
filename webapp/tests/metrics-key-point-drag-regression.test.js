const fs = require('fs');
const path = require('path');
const { PatchSyncEngine: ChangeBridge } = require('../js/patch-sync-engine');
const { Font, withSuppressedModelRecording } = require('../js/babelfont-model');
const { open_font_file } = require('../wasm-dist/babelfont_fontc_web');

function loadFontFixture(fileName) {
    const fixturePath = path.join(__dirname, '..', 'examples', fileName);
    const fileContents = fs.readFileSync(fixturePath, 'utf-8');
    return JSON.parse(open_font_file(fileName, fileContents));
}

function cloneValue(value) {
    return JSON.parse(JSON.stringify(value));
}

function getLayerNodes(layerJson) {
    const shape = layerJson?.shapes?.[0];
    const nodes = shape?.nodes || shape?.Path?.nodes || [];
    return nodes.map(({ smooth, id, ...node }) =>
        smooth === false ? node : { ...node, smooth }
    );
}

describe('metrics-key point drag regression', () => {
    afterEach(() => {
        window.changeBridge = null;
    });

    test.each([
        { label: 'x-only drag', deltaX: -20, deltaY: 0 },
        { label: 'x+y drag', deltaX: -20, deltaY: 15 }
    ])(
        'glyph a fixed left key sync/undo round-trips cleanly for $label',
        ({ deltaX, deltaY }) => {
            const fontJson = loadFontFixture('metricskeys.glyphs');
            const font = Font.fromData(fontJson);
            const glyph = font.findGlyph('a');

            withSuppressedModelRecording(() => {
                glyph.leftMetricsKey = '=60';
                font.recomputeMetricsKeys(new Set(['a']));
            });

            const bridge = new ChangeBridge(`metrics-key-point-drag-${deltaY}`);
            bridge.initFromJson(JSON.parse(font.toJSONString()));
            window.changeBridge = bridge;

            const layer = glyph.layers[0];
            const originalSnapshot = cloneValue(layer.toJSON());
            const originalNodes = getLayerNodes(originalSnapshot);
            const leftmostNode = layer.paths[0].nodes.reduce((left, node) =>
                node.x < left.x ? node : left
            );
            const originalNode = { x: leftmostNode.x, y: leftmostNode.y };

            withSuppressedModelRecording(() => {
                leftmostNode.x += deltaX;
                leftmostNode.y += deltaY;
                font.recomputeMetricsKeys(new Set(['a']));
            });

            const changedSnapshot = cloneValue(layer.toJSON());
            const changedNodes = getLayerNodes(changedSnapshot);

            bridge.setFontJson(JSON.parse(font.toJSONString()));
            bridge.syncGlyphFromJson(
                'a',
                'Drag point',
                `node '(${Math.round(originalNode.x)}, ${Math.round(originalNode.y)})'`,
                `LEFT (${Math.round(originalNode.x + deltaX)}, ${Math.round(originalNode.y + deltaY)})`,
                layer.id,
                undefined,
                undefined,
                undefined,
                'test-sync',
                null
            );

            expect(bridge.canUndo('a', layer.id)).toBe(true);
            expect(changedNodes).not.toEqual(originalNodes);

            expect(bridge.undo('a', layer.id)).toEqual(
                expect.objectContaining({
                    scope: 'layer',
                    glyphName: 'a',
                    layerId: layer.id
                })
            );

            const undoneGlyph = bridge
                .getFontJsonSnapshot()
                .glyphs.find((entry) => entry.name === 'a');
            const undoneLayer = undoneGlyph.layers.find(
                (entry) => entry.id === layer.id
            );

            expect(undoneLayer.width).toBe(originalSnapshot.width);
            expect(getLayerNodes(undoneLayer)).toEqual(originalNodes);
        }
    );
});
