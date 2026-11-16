const fs = require('fs');
const path = require('path');
const model = require('../js/babelfont-model');

// The bundle is minified, so `constructor.name` is mangled. Python’s
// fonteditor.py recognizes model objects by their Symbol.toStringTag instead.
const MODEL_CLASSES = [
    'Anchor',
    'Axis',
    'Component',
    'Drawing',
    'FeatureVariationGlyph',
    'Font',
    'Glyph',
    'Guide',
    'Instance',
    'Node',
    'Path',
    'Shape',
    'Station'
];

const tagOf = (value) => Object.prototype.toString.call(value);

function pythonModelClassNames() {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'py', 'fonteditor.py'),
        'utf-8'
    );
    const block = source.match(/_DICT_LIKE_FIELDS_BY_CLASS = \{([\s\S]*?)\n\}/);
    return [...block[1].matchAll(/^ {4}'(\w+)':/gm)].map((match) => match[1]);
}

describe('model class tags for the Python bridge', () => {
    test.each(MODEL_CLASSES)('%s tags itself with its class name', (name) => {
        expect(tagOf(Object.create(model[name].prototype))).toBe(
            `[object ${name}]`
        );
    });

    test('fonteditor.py knows every model class', () => {
        expect(pythonModelClassNames()).toEqual(
            expect.arrayContaining(MODEL_CLASSES)
        );
    });

    test('objects reached through the model keep their tags', () => {
        const font = model.Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [
                {
                    tag: 'wght',
                    name: { dflt: 'Weight' },
                    min: 100,
                    max: 900,
                    default: 400
                }
            ],
            cross_axis_mappings: [],
            instances: [{ name: { dflt: 'Regular' }, location: { wght: 400 } }],
            masters: [
                {
                    id: 'm',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    guides: [{ pos: { x: 0, y: 500, angle: 0 }, name: 'g' }],
                    metrics: {},
                    kerning: {}
                }
            ],
            glyphs: [
                {
                    name: 'a',
                    codepoints: [97],
                    layers: [
                        {
                            id: 'm',
                            master: { type: 'DefaultForMaster', master: 'm' },
                            width: 500,
                            anchors: [{ name: 'top', x: 250, y: 500 }],
                            guides: [{ pos: { x: 10, y: 0, angle: 90 } }],
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Line' },
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 100, y: 100, nodetype: 'Line' }
                                    ],
                                    closed: true
                                },
                                { reference: 'b' }
                            ]
                        }
                    ]
                },
                { name: 'b', layers: [] }
            ]
        });
        const drawing = font.glyphs[0].drawings[0];

        expect(
            [
                font,
                font.axes[0],
                font.instances[0],
                font.stations[0],
                font.stations[0].guides[0],
                font.glyphs[0],
                drawing,
                drawing.shapes[0],
                drawing.paths[0],
                drawing.paths[0].nodes[0],
                drawing.components[0],
                drawing.anchors[0],
                drawing.guides[0]
            ].map(tagOf)
        ).toEqual(
            [
                'Font',
                'Axis',
                'Instance',
                'Station',
                'Guide',
                'Glyph',
                'Drawing',
                'Shape',
                'Path',
                'Node',
                'Component',
                'Anchor',
                'Guide'
            ].map((name) => `[object ${name}]`)
        );
    });
});
