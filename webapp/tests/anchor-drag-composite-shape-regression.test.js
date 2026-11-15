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

function getMatchingDrawingTargets(
    fontModel,
    sourceGlyphName,
    sourceDrawingId,
    glyphNames
) {
    const sourceGlyph = fontModel.findGlyph(sourceGlyphName);
    const sourceDrawing = sourceGlyph?.findDrawingById(sourceDrawingId);

    return Array.from(new Set(glyphNames))
        .map((glyphName) => {
            const glyph = fontModel.findGlyph(glyphName);
            const matchedDrawing =
                glyph?.findDrawingById(sourceDrawingId) ||
                sourceDrawing?.getMatchingDrawingOnGlyph?.(glyphName) ||
                glyph?.layers?.[0] ||
                null;

            return matchedDrawing?.id
                ? { glyphName, layerId: matchedDrawing.id }
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
        const drawingO = glyphO.drawings[0];
        const topAnchor = drawingO.anchors.find(
            (anchor) => anchor.name === 'top'
        );

        expect(glyphO).toBeTruthy();
        expect(glyphOacute).toBeTruthy();
        expect(drawingO).toBeTruthy();
        expect(topAnchor).toBeTruthy();
        for (let moveIndex = 0; moveIndex < 3; moveIndex += 1) {
            withSuppressedModelRecording(() => {
                topAnchor.y += 10;
            });

            const affectedGlyphNames =
                fontModel.rebuildAutomaticCompositesForGlyphs(new Set(['o']), {
                    preferredDrawingId: drawingO.id,
                    preferredSourceGlyphName: 'o'
                });

            expect(affectedGlyphNames.has('oacute')).toBe(false);

            const oacuteDrawing =
                glyphOacute.findDrawingById(drawingO.id) ||
                glyphOacute.drawings[0];
            const rawDrawingData = oacuteDrawing.toJSON();
            expectPlainShapeStructure(
                rawDrawingData.shapes,
                `raw oacute layer after move ${moveIndex + 1}`
            );

            const serializedDrawing = fontManager.serializeDrawingForStorage(
                'o',
                drawingO.id,
                rawDrawingData
            );
            expect(serializedDrawing).toBeTruthy();
            expectPlainShapeStructure(
                serializedDrawing.shapes,
                `serialized o layer after move ${moveIndex + 1}`
            );

            await expect(
                fontManager.refreshGlyphsAfterModelBatch(['o'], drawingO.id, {
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
        const drawingO = glyphO.drawings[0];
        const topAnchor = drawingO.anchors.find(
            (anchor) => anchor.name === 'top'
        );

        expect(glyphO).toBeTruthy();
        expect(glyphOacute).toBeTruthy();
        expect(drawingO).toBeTruthy();
        expect(topAnchor).toBeTruthy();
        for (let moveIndex = 0; moveIndex < 3; moveIndex += 1) {
            withSuppressedModelRecording(() => {
                topAnchor.y += 10;
            });

            const affectedGlyphNames =
                fontModel.rebuildAutomaticCompositesForGlyphs(new Set(['o']), {
                    preferredDrawingId: drawingO.id,
                    preferredSourceGlyphName: 'o'
                });
            const drawingTargets = getMatchingDrawingTargets(
                fontModel,
                'o',
                drawingO.id,
                ['o']
            );

            bridge.syncDrawingsFromJson(
                drawingTargets,
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

            const bridgeDrawing = Array.isArray(bridgeGlyph.layers)
                ? bridgeGlyph.layers.find(
                      (drawing) => drawing?.id === drawingO.id
                  )
                : null;
            expect(bridgeDrawing).toBeTruthy();
            expectPlainShapeStructure(
                bridgeDrawing.shapes,
                `bridge o layer after move ${moveIndex + 1}`
            );
        }
    });
});
