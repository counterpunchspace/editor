const fs = require('fs');
const path = require('path');
const { Font } = require('../js/babelfont-model');
const { open_font_file } = require('../wasm-dist/babelfont_fontc_web');
import {
    buildPlaceholderPath,
    paintPlaceholderGlyph,
    placeholderCcmpParts,
    placeholderContoursForReference,
    rememberPlaceholderDrawing
} from '../js/language-packs/placeholder-outlines';

const IDENTITY = [1, 0, 0, 1, 0, 0];

function layer(type, master, shapes) {
    return {
        master: { type, master },
        paths: shapes.paths || [],
        components: shapes.components || [],
        anchors: shapes.anchors || []
    };
}

function component(name) {
    return { reference: name, transform: IDENTITY };
}

function pathInk() {
    return {
        nodes: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 100 }
        ]
    };
}

function installFont() {
    const glyphs = {
        edieresis: {
            codepoints: [0x00eb],
            findLayerByMasterId() {
                return this.layers[0];
            },
            layers: [
                layer('AssociatedWithMaster', 'light', {}),
                layer('DefaultForMaster', 'light', {
                    components: [component('e'), component('dieresiscomb')]
                })
            ]
        },
        e: {
            codepoints: [0x0065],
            layers: [layer('DefaultForMaster', 'light', { paths: [pathInk()] })]
        },
        dieresiscomb: {
            codepoints: [0x0308],
            findLayerByMasterId() {
                return this.layers[0];
            },
            layers: [
                layer('AssociatedWithMaster', 'light', {
                    anchors: [{ name: '_top', x: 147, y: 492 }]
                }),
                layer('DefaultForMaster', 'light', {
                    components: [
                        component('dotaccentcomb'),
                        component('dotaccentcomb')
                    ]
                })
            ]
        },
        dotaccentcomb: {
            codepoints: [0x0307],
            layers: [layer('DefaultForMaster', 'light', { paths: [pathInk()] })]
        },
        aring: {
            codepoints: [0x00e5],
            layers: [layer('DefaultForMaster', 'light', {})]
        },
        skeleton: {
            layers: [layer('DefaultForMaster', 'light', {})]
        }
    };
    window.glyphCanvas = {
        textRunEditor: { selectedMasterId: 'light' }
    };
    window.currentFontModel = {
        upm: 1000,
        features: {
            features: [
                [
                    'ccmp',
                    {
                        code: 'sub edieresis by e dieresiscomb;',
                        automatic: true,
                        format_specific: {
                            'com.counterpunch.generator': {
                                generator: 'space.counterpunch.ccmp',
                                version: '1',
                                block: 'decomposition',
                                capability: 'ccmp'
                            }
                        }
                    }
                ]
            ]
        },
        findGlyph(name) {
            return glyphs[name] || null;
        }
    };
}

function paintEvents(name) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    paintPlaceholderGlyph(ctx, name, { appearance: 'text' });
    return ctx
        .__getEvents()
        .filter((event) =>
            ['fill', 'stroke', 'fillText', 'strokeText'].includes(event.type)
        );
}

describe('placeholder hints on composed glyphs', () => {
    beforeEach(() => {
        installFont();
        rememberPlaceholderDrawing('dieresiscomb', {
            upm: 1000,
            width: 294,
            paths: [
                {
                    closed: true,
                    nodes: [
                        { x: 0, y: 600, nodetype: 'Line' },
                        { x: 80, y: 600, nodetype: 'Line' },
                        { x: 80, y: 680, nodetype: 'Line' }
                    ]
                }
            ],
            anchors: []
        });
        rememberPlaceholderDrawing('aring', {
            upm: 1000,
            width: 500,
            paths: [],
            anchors: []
        });
        rememberPlaceholderDrawing('skeleton', {
            upm: 1000,
            width: 400,
            paths: [
                {
                    closed: true,
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Line' },
                        { x: 200, y: 0, nodetype: 'Line' },
                        { x: 200, y: 400, nodetype: 'Line' }
                    ]
                }
            ],
            anchors: []
        });
    });

    afterEach(() => {
        delete window.currentFontModel;
        delete window.glyphCanvas;
    });

    test('a composed mark does not get a stand-in over its real components', () => {
        expect(placeholderContoursForReference('dieresiscomb')).toEqual([]);
        expect(buildPlaceholderPath('dieresiscomb')).toBeNull();
        expect(placeholderCcmpParts('edieresis')).toEqual([]);
        expect(paintEvents('edieresis')).toEqual([]);
        expect(paintEvents('dieresiscomb')).toEqual([]);
    });

    test('an empty encoded glyph still gets the fallback character', () => {
        const painted = paintEvents('aring');
        expect(painted.map((event) => event.props.text)).toEqual([
            String.fromCodePoint(0x00e5),
            String.fromCodePoint(0x00e5)
        ]);
    });

    test('an empty component glyph still gets its sample outline', () => {
        const contours = placeholderContoursForReference('skeleton');
        expect(contours).toHaveLength(1);
        expect(contours[0].nodes[1]).toMatchObject({ x: 200, y: 0 });
    });
});

describe('Fustat edieresis placeholder', () => {
    test('does not paint a dieresiscomb stand-in over the real component', () => {
        const fixturePath = path.join(
            __dirname,
            '..',
            'examples',
            'Fustat.glyphs'
        );
        const font = Font.fromData(
            JSON.parse(
                open_font_file(
                    'Fustat.glyphs',
                    fs.readFileSync(fixturePath, 'utf-8')
                )
            )
        );
        const masterId = font.masters[0].id;
        window.glyphCanvas = {
            textRunEditor: { selectedMasterId: masterId }
        };
        window.currentFontModel = font;
        rememberPlaceholderDrawing('dieresiscomb', {
            upm: 1000,
            width: 294,
            paths: [
                {
                    closed: true,
                    nodes: [
                        { x: 0, y: 600, nodetype: 'Line' },
                        { x: 80, y: 600, nodetype: 'Line' },
                        { x: 80, y: 680, nodetype: 'Line' }
                    ]
                }
            ],
            anchors: []
        });

        const mark = font.findGlyph('dieresiscomb');
        expect(mark.layers.some((layer) => layer.components.length > 0)).toBe(
            true
        );
        expect(paintEvents('edieresis')).toEqual([]);
        expect(paintEvents('dieresiscomb')).toEqual([]);
        expect(placeholderContoursForReference('dieresiscomb')).toEqual([]);

        delete window.currentFontModel;
        delete window.glyphCanvas;
    });
});
