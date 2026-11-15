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

        expect(glyph.drawings).toHaveLength(2);
        expect(glyph.drawings.map((drawing) => drawing.id)).toEqual([
            'master-regular',
            'master-bold'
        ]);
        expect(glyph.drawings.map((drawing) => drawing.station)).toEqual([
            { type: 'DefaultForMaster', master: 'master-regular' },
            { type: 'DefaultForMaster', master: 'master-bold' }
        ]);
        expect(glyph.drawings.map((drawing) => drawing.width)).toEqual([
            500, 500
        ]);
        expect(glyph.drawings.map((drawing) => drawing.shapes)).toEqual([
            [],
            []
        ]);
    });

    test('addDrawing DefaultForMaster uses the master id as the layer id', () => {
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
        while (glyph.drawings.length > 0) {
            glyph.removeDrawing(0);
        }

        const drawing = glyph.addDrawing(600, {
            type: 'DefaultForMaster',
            master: 'master-regular'
        });

        expect(drawing.id).toBe('master-regular');
        expect(drawing.width).toBe(600);
        expect(drawing.shapes).toEqual([]);
        expect(drawing.station).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });
    });
});

describe('Font glyph quota plugin hook', () => {
    afterEach(() => {
        delete window.fontManager;
    });

    function fontWithStations() {
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
        const font = fontWithStations();
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
        const font = fontWithStations();
        expect(() => font.addGlyph('A')).toThrow(
            'Glyph limit reached (1000/1000)'
        );
        expect(font.glyphs).toHaveLength(0);
    });
});
