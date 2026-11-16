const { Font } = require('../js/babelfont-model');

// toString() is what Python prints for model objects.
function buildFont(componentTransform) {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [
            {
                tag: 'wght',
                name: { dflt: 'Weight' },
                min: 0,
                max: 900,
                default: 400
            }
        ],
        cross_axis_mappings: [],
        instances: [{ name: { dflt: 'Light' }, location: { wght: 55.00001 } }],
        masters: [
            {
                id: 'm',
                name: { dflt: 'Regular' },
                location: { wght: 400 },
                guides: [{ pos: { x: 0, y: 500, angle: 0 }, name: 'xheight' }],
                metrics: {},
                kerning: {}
            }
        ],
        names: { family_name: { dflt: 'Test Sans' } },
        glyphs: [
            {
                name: 'u',
                layers: [
                    {
                        id: 'm',
                        master: { type: 'DefaultForMaster', master: 'm' },
                        width: 571,
                        anchors: [{ name: 'top', x: 283.00004, y: 500 }],
                        guides: [{ pos: { x: 10, y: 20, angle: 90 } }],
                        shapes: [
                            { reference: 'n', transform: componentTransform }
                        ]
                    }
                ]
            },
            { name: 'n', layers: [] }
        ]
    });
}

const transform = (overrides) => ({
    translation: [0, 0],
    scale: [1, 1],
    rotation: 0,
    skew: [0, 0],
    order: 'Glyphs',
    ...overrides
});

describe('model object string representations', () => {
    test.each([
        [undefined, '<Component "n">'],
        [transform({}), '<Component "n">'],
        [
            transform({ translation: [571, 500], rotation: Math.PI }),
            '<Component "n" translate=(571, 500) rotate=180°>'
        ],
        [
            transform({ scale: [-1, 1], skew: [Math.PI / 18, 0] }),
            '<Component "n" scale=(-1, 1) skew=(10°, 0°)>'
        ],
        [transform({ rotation: 1e-12 }), '<Component "n">']
    ])('Component with transform %j', (componentTransform, expected) => {
        const drawing = buildFont(componentTransform).glyphs[0].drawings[0];
        expect(String(drawing.components[0])).toBe(expected);
        expect(String(drawing.shapes[0])).toBe(`<Shape:${expected}>`);
    });

    test('guides, anchors, stations, instances, axes and fonts', () => {
        const font = buildFont();
        const drawing = font.glyphs[0].drawings[0];

        expect(String(drawing.anchors[0])).toBe('<Anchor "top" (283, 500)>');
        expect(String(drawing.guides[0])).toBe('<Guide (10, 20) angle=90°>');
        expect(String(font.stations[0].guides[0])).toBe(
            '<Guide "xheight" (0, 500)>'
        );
        expect(String(font.stations[0])).toBe(
            '<Station "Regular" id="m" wght=400>'
        );
        expect(String(font.instances[0])).toBe('<Instance "Light" wght=55>');
        expect(String(font.axes[0])).toBe(
            '<Axis "Weight" tag="wght" 0-400-900>'
        );
        expect(String(font)).toBe('<Font "Test Sans" 2 glyphs>');
    });
});
