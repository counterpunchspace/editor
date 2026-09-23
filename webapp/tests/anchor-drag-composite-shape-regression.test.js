const fs = require('fs');
const path = require('path');

const fontManager = require('../js/font-manager').default;
const { fontCompilation } = require('../js/font-compilation');
const { PatchSyncEngine: ChangeBridge } = require('../js/patch-sync-engine');
const { Font, withSuppressedModelRecording } = require('../js/babelfont-model');
const { yDocToJson } = require('../js/change-bridge-ydoc');
const { open_font_file } = require('../wasm-dist/babelfont_fontc_web');

function loadFontFixture(fileName) {
    const fixturePath = path.join(__dirname, '..', 'examples', fileName);
    const fileContents = fs.readFileSync(fixturePath, 'utf-8');
    return JSON.parse(open_font_file(fileName, fileContents));
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function makeWorkerCacheStatus(overrides = {}) {
    return {
        coherent: true,
        documentEpoch: 1,
        fontCacheEpoch: 1,
        filterEpoch: 1,
        subsetCacheEpoch: null,
        ...overrides
    };
}

function expectPlainShapeStructure(shapes, context) {
    expect(Array.isArray(shapes)).toBe(true);

    for (const [index, shape] of shapes.entries()) {
        expect(shape).toBeTruthy();
        expect(typeof shape).toBe('object');
        expect(Array.isArray(shape)).toBe(false);
        expect('Path' in shape).toBe(false);
        expect('Component' in shape).toBe(false);

        if ('nodes' in shape) {
            expect(Array.isArray(shape.nodes)).toBe(true);
            continue;
        }

        if ('reference' in shape) {
            expect(typeof shape.reference).toBe('string');
            continue;
        }

        throw new Error(
            `${context} shape ${index} is neither a plain path nor a plain component: ${JSON.stringify(
                shape
            )}`
        );
    }
}

function getMatchingLayerTargets(
    fontModel,
    sourceGlyphName,
    sourceLayerId,
    glyphNames
) {
    const sourceGlyph = fontModel.findGlyph(sourceGlyphName);
    const sourceLayer = sourceGlyph?.findLayerById(sourceLayerId);

    return Array.from(new Set(glyphNames))
        .map((glyphName) => {
            const glyph = fontModel.findGlyph(glyphName);
            const matchedLayer =
                glyph?.findLayerById(sourceLayerId) ||
                sourceLayer?.getMatchingLayerOnGlyph?.(glyphName) ||
                glyph?.layers?.[0] ||
                null;

            return matchedLayer?.id
                ? { glyphName, layerId: matchedLayer.id }
                : null;
        })
        .filter(Boolean);
}

describe('Fustat anchor drag component serialization', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalFontCompilationInitialized;
    let sendMessageSpy;

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        originalFontCompilationInitialized = fontCompilation.isInitialized;

        const fontData = cloneJson(loadFontFixture('Fustat.glyphs'));
        const fontModel = Font.fromData(fontData);
        const currentFont = {
            babelfontJson: JSON.stringify(fontData),
            babelfontData: fontData,
            fontModel,
            name: 'Fustat',
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = this.fontModel.toJSONString();
            }),
            requestRecompileWithoutDataChange: jest.fn()
        };

        fontManager.openedFonts = new Map([['test-font', currentFont]]);
        fontManager.currentFontId = 'test-font';
        fontCompilation.isInitialized = true;
        sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({
                success: true,
                workerCacheStatus: makeWorkerCacheStatus()
            });
    });

    afterEach(() => {
        sendMessageSpy?.mockRestore();
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
        fontCompilation.isInitialized = originalFontCompilationInitialized;
    });

    test('three top-anchor moves on o do not rebuild omitted-alignment oacute', async () => {
        const fontModel = fontManager.currentFont.fontModel;
        const glyphO = fontModel.findGlyph('o');
        const glyphOacute = fontModel.findGlyph('oacute');
        const layerO = glyphO.layers[0];
        const topAnchor = layerO.anchors.find(
            (anchor) => anchor.name === 'top'
        );

        expect(glyphO).toBeTruthy();
        expect(glyphOacute).toBeTruthy();
        expect(layerO).toBeTruthy();
        expect(topAnchor).toBeTruthy();
        for (let moveIndex = 0; moveIndex < 3; moveIndex += 1) {
            withSuppressedModelRecording(() => {
                topAnchor.y += 10;
            });

            const affectedGlyphNames =
                fontModel.rebuildAutomaticCompositesForGlyphs(new Set(['o']), {
                    preferredLayerId: layerO.id,
                    preferredSourceGlyphName: 'o'
                });

            expect(affectedGlyphNames.has('oacute')).toBe(false);

            const oacuteLayer =
                glyphOacute.findLayerById(layerO.id) || glyphOacute.layers[0];
            const rawLayerData = oacuteLayer.toJSON();
            expectPlainShapeStructure(
                rawLayerData.shapes,
                `raw oacute layer after move ${moveIndex + 1}`
            );

            const serializedLayer = fontManager.serializeLayerForStorage(
                'o',
                layerO.id,
                rawLayerData
            );
            expect(serializedLayer).toBeTruthy();
            expectPlainShapeStructure(
                serializedLayer.shapes,
                `serialized o layer after move ${moveIndex + 1}`
            );

            await expect(
                fontManager.refreshGlyphsAfterModelBatch(['o'], layerO.id, {
                    skipFingerprintBaseline: true
                })
            ).resolves.toBeUndefined();
        }
    });

    test('three top-anchor moves on o leave omitted-alignment oacute unchanged in batched layer Yjs sync', () => {
        const fontData = fontManager.currentFont.babelfontData;
        const fontModel = fontManager.currentFont.fontModel;
        const bridge = new ChangeBridge();
        bridge.initFromJson(fontData);

        const glyphO = fontModel.findGlyph('o');
        const glyphOacute = fontModel.findGlyph('oacute');
        const layerO = glyphO.layers[0];
        const topAnchor = layerO.anchors.find(
            (anchor) => anchor.name === 'top'
        );

        expect(glyphO).toBeTruthy();
        expect(glyphOacute).toBeTruthy();
        expect(layerO).toBeTruthy();
        expect(topAnchor).toBeTruthy();
        for (let moveIndex = 0; moveIndex < 3; moveIndex += 1) {
            withSuppressedModelRecording(() => {
                topAnchor.y += 10;
            });

            const affectedGlyphNames =
                fontModel.rebuildAutomaticCompositesForGlyphs(new Set(['o']), {
                    preferredLayerId: layerO.id,
                    preferredSourceGlyphName: 'o'
                });
            const layerTargets = getMatchingLayerTargets(
                fontModel,
                'o',
                layerO.id,
                ['o']
            );

            bridge.syncLayersFromJson(
                layerTargets,
                'Drag anchor',
                undefined,
                undefined,
                undefined,
                undefined,
                'mouse-drag-anchor',
                'mouse-drag-anchor',
                null
            );

            const bridgeJson = bridge.getFontJsonSnapshot();
            const bridgeGlyph = Array.isArray(bridgeJson.glyphs)
                ? bridgeJson.glyphs.find((glyph) => glyph?.name === 'o')
                : null;
            expect(bridgeGlyph).toBeTruthy();

            const bridgeLayer = Array.isArray(bridgeGlyph.layers)
                ? bridgeGlyph.layers.find((layer) => layer?.id === layerO.id)
                : null;
            expect(bridgeLayer).toBeTruthy();
            expectPlainShapeStructure(
                bridgeLayer.shapes,
                `bridge o layer after move ${moveIndex + 1}`
            );
        }
    });
});
