const { Font } = require('../js/babelfont-model');

describe('Font.addGlyph', () => {
    test('creates an empty default layer for every master', () => {
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            cross_axis_mappings: [],
            instances: [],
            masters: [
                {
                    id: 'master-regular',
                    name: { dflt: 'Regular' },
                    location: {},
                    guides: [],
                    metrics: {},
                    kerning: {}
                },
                {
                    id: 'master-bold',
                    name: { dflt: 'Bold' },
                    location: { wght: 700 },
                    guides: [],
                    metrics: {},
                    kerning: {}
                }
            ],
            glyphs: []
        });

        const glyph = font.addGlyph('newGlyph');

        expect(glyph.layers).toHaveLength(2);
        expect(glyph.layers.map((layer) => layer.id)).toEqual([
            'master-regular',
            'master-bold'
        ]);
        expect(glyph.layers.map((layer) => layer.master)).toEqual([
            { type: 'DefaultForMaster', master: 'master-regular' },
            { type: 'DefaultForMaster', master: 'master-bold' }
        ]);
        expect(glyph.layers.map((layer) => layer.width)).toEqual([500, 500]);
        expect(glyph.layers.map((layer) => layer.shapes)).toEqual([[], []]);
    });

    test('addLayer DefaultForMaster uses the master id as the layer id', () => {
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            cross_axis_mappings: [],
            instances: [],
            masters: [
                {
                    id: 'master-regular',
                    name: { dflt: 'Regular' },
                    location: {},
                    guides: [],
                    metrics: {},
                    kerning: {}
                }
            ],
            glyphs: []
        });

        const glyph = font.addGlyph('newGlyph');
        while (glyph.layers.length > 0) {
            glyph.removeLayer(0);
        }

        const layer = glyph.addLayer(600, {
            type: 'DefaultForMaster',
            master: 'master-regular'
        });

        expect(layer.id).toBe('master-regular');
        expect(layer.width).toBe(600);
        expect(layer.shapes).toEqual([]);
        expect(layer.master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });
    });
});

describe('Font glyph quota plugin hook', () => {
    afterEach(() => {
        delete window.fontManager;
    });

    function fontWithMasters() {
        return Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            cross_axis_mappings: [],
            instances: [],
            masters: [
                {
                    id: 'master-regular',
                    name: { dflt: 'Regular' },
                    location: {},
                    guides: [],
                    metrics: {},
                    kerning: {}
                }
            ],
            glyphs: []
        });
    }

    test('addGlyphs refuses a batch larger than the plugin remaining cap', () => {
        window.fontManager = {
            currentFont: {
                sourcePlugin: {
                    canAddGlyphs: async () => ({ allowed: true }),
                    getCachedCanAddGlyphs: (n) => ({
                        allowed: n <= 1,
                        remaining: 1,
                        reason: 'Glyph limit reached (999/1000)'
                    })
                }
            }
        };
        const font = fontWithMasters();
        expect(() =>
            font.addGlyphs([
                { name: 'A', codepoints: [65] },
                { name: 'B', codepoints: [66] }
            ])
        ).toThrow('Glyph limit reached (999/1000)');
        expect(font.glyphs).toHaveLength(0);
    });

    test('addGlyph throws when the plugin hook forbids one more glyph', () => {
        window.fontManager = {
            currentFont: {
                sourcePlugin: {
                    canAddGlyphs: async () => ({ allowed: false }),
                    getCachedCanAddGlyphs: () => ({
                        allowed: false,
                        remaining: 0,
                        reason: 'Glyph limit reached (1000/1000)'
                    })
                }
            }
        };
        const font = fontWithMasters();
        expect(() => font.addGlyph('A')).toThrow(
            'Glyph limit reached (1000/1000)'
        );
        expect(font.glyphs).toHaveLength(0);
    });
});
