jest.mock('../js/opentype-table-reader', () => ({
    __esModule: true,
    ...jest.requireActual('../js/opentype-table-reader'),
    get_glyph_name: jest.fn(
        (_fontBytes, gid) => `glyph${String(gid).padStart(5, '0')}`
    )
}));
jest.resetModules();

const { shapeTextWithFontDetailed } = require('../js/font-compilation');

describe('shapeTextWithFontDetailed HarfBuzz compatibility', () => {
    let originalCreateHarfBuzz;
    let originalHbjs;
    let originalHbInit;

    beforeEach(() => {
        originalCreateHarfBuzz = window.createHarfBuzz;
        originalHbjs = window.hbjs;
        originalHbInit = window.hbInit;
    });

    afterEach(() => {
        window.createHarfBuzz = originalCreateHarfBuzz;
        window.hbjs = originalHbjs;
        window.hbInit = originalHbInit;
    });

    function makeApi({ includeSetVariations = true } = {}) {
        const shape = jest.fn();
        const createBlob = jest.fn(() => ({ destroy: jest.fn() }));
        const createFace = jest.fn(() => ({ destroy: jest.fn() }));
        const createFont = jest.fn(() => {
            const font = {
                destroy: jest.fn()
            };
            if (includeSetVariations) {
                font.setVariations = jest.fn();
            }
            return font;
        });
        const createBuffer = jest.fn(() => ({
            addText: jest.fn(),
            guessSegmentProperties: jest.fn(),
            json: jest.fn(() => [
                {
                    g: 1,
                    ax: 500,
                    ay: 0,
                    dx: 0,
                    dy: 0,
                    cl: 0
                }
            ]),
            destroy: jest.fn()
        }));

        return {
            createBlob,
            createFace,
            createFont,
            createBuffer,
            shape
        };
    }

    test('falls back to raw HarfBuzz API when hbjs wrapper throws', async () => {
        const rawApi = makeApi();

        window.createHarfBuzz = jest.fn(async () => rawApi);
        window.hbjs = jest.fn(() => {
            throw new Error('wrapper mismatch');
        });

        const result = await shapeTextWithFontDetailed(
            new Uint8Array([1, 2, 3]),
            'a'
        );

        expect(window.hbjs).toHaveBeenCalledTimes(1);
        expect(rawApi.createBlob).toHaveBeenCalledTimes(1);
        expect(rawApi.shape).toHaveBeenCalledTimes(1);
        expect(result.gids).toEqual([1]);
        expect(result.glyphs).toEqual(['glyph00001']);
    });

    test('does not throw when variationLocation is set but hbFont lacks setVariations', async () => {
        const rawApi = makeApi({ includeSetVariations: false });

        window.createHarfBuzz = jest.fn(async () => rawApi);
        window.hbjs = jest.fn(() => rawApi);

        await expect(
            shapeTextWithFontDetailed(new Uint8Array([1, 2, 3]), 'a', {
                variationLocation: { wght: 400 }
            })
        ).resolves.toEqual(
            expect.objectContaining({
                gids: [1],
                glyphs: ['glyph00001']
            })
        );
    });
});
