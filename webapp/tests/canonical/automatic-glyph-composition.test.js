/**
 * Automatic Glyph Composition — Canonical Tests
 *
 * These tests lock down the behavior described in APP.md § Automatic Glyph
 * Composition and the adjacent automatic-component editing rules:
 *
 *   - automatic composition only applies to component-only layers where every
 *     component is automatically aligned
 *   - anchor-family matching treats unsuffixed and suffixed anchors as one
 *     family, with explicit Component.anchor overrides selecting the exact
 *     target anchor
 *   - base-plus-mark compositions stack in component order and keep width
 *     derived from base components rather than attached marks
 *   - anchor edits on source glyphs rebuild downstream automatic composites
 *   - automatic layers reject direct sidebearing inputs and only accept
 *     =+/- and ==+/- adjustments
 *   - fully automatic layers expose anchor overrides and lock component
 *     translation fields in the property panel, while mixed layers keep
 *     components movable
 *   - automatic and manual components are rendered with distinct fill and
 *     explicit stroke styling
 */

const { Font } = require('../../js/babelfont-model');
const fontManager = require('../../js/font-manager').default;
const APP_SETTINGS = require('../../js/settings').default;

const GLYPHS_COMPONENT_ALIGNMENT_KEY = 'com.schriftgestalt.Glyphs.alignment';
const GLYPHS_COMPONENT_ANCHOR_KEY = 'com.schriftgestalt.Glyphs.componentAnchor';

function makeStation() {
    return {
        id: 'M0',
        name: { en: 'Regular' },
        location: {},
        guides: [],
        metrics: {},
        kerning: {},
        custom_ot_values: {},
        format_specific: {}
    };
}

function makeRectPath(minX, minY, maxX, maxY) {
    return {
        nodes: [
            { type: 'l', x: minX, y: minY },
            { type: 'l', x: maxX, y: minY },
            { type: 'l', x: maxX, y: maxY },
            { type: 'l', x: minX, y: maxY }
        ],
        closed: true
    };
}

function makeComponent(reference, options = {}) {
    const {
        x = 0,
        y = 0,
        auto = true,
        anchor,
        transform = {
            translation: [x, y],
            scale: [1, 1],
            rotation: 0,
            skew: [0, 0],
            tCenter: [0, 0],
            order: 'RestOfTheWorld'
        }
    } = options;
    const formatSpecific = {
        [GLYPHS_COMPONENT_ALIGNMENT_KEY]: auto ? 1 : -1
    };
    if (anchor) {
        formatSpecific[GLYPHS_COMPONENT_ANCHOR_KEY] = anchor;
    }
    return {
        reference,
        transform,
        format_specific: formatSpecific
    };
}

function getSerializedTranslationX(shape) {
    const shapeData = 'Component' in shape ? shape.Component : shape;
    const transform = shapeData?.transform;
    return Array.isArray(transform)
        ? transform[4]
        : (transform?.translation?.[0] ?? 0);
}

function makeAutomaticCompositionFont() {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [makeStation()],
        glyphs: [
            {
                name: 'A',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'A0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(50, 0, 450, 700)],
                        anchors: [
                            { name: 'top', x: 250, y: 700 },
                            { name: 'top_alt', x: 320, y: 700 },
                            { name: 'bottom', x: 250, y: 0 }
                        ],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'B',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'B0',
                        width: 300,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(20, 0, 280, 650)],
                        anchors: [{ name: 'top', x: 150, y: 650 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'acutecomb',
                category: 'Mark',
                exported: true,
                layers: [
                    {
                        id: 'AC0',
                        width: 180,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(-40, 680, 40, 780)],
                        anchors: [
                            { name: '_top', x: 0, y: 720 },
                            { name: 'top', x: 0, y: 820 }
                        ],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'gravecomb',
                category: 'Mark',
                exported: true,
                layers: [
                    {
                        id: 'GC0',
                        width: 180,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(-35, 670, 35, 770)],
                        anchors: [{ name: '_top', x: 0, y: 710 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'adieresis',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'AD0',
                        width: 0,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('A'),
                            makeComponent('acutecomb'),
                            makeComponent('gravecomb')
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'AB',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'AB0',
                        width: 0,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeComponent('A'), makeComponent('B')],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'hybrid',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'HY0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeRectPath(0, 0, 100, 100),
                            makeComponent('A')
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'manualComposite',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'MC0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('A'),
                            makeComponent('acutecomb', { auto: false })
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            }
        ],
        names: { family_name: { en: 'Automatic Composition Canonical' } },
        note: '',
        date: '2026-04-06',
        features: { classes: {}, prefixes: {}, features: [] },
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

function makeVisibleAnchorCascadeFont() {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [makeStation()],
        glyphs: [
            {
                name: 'A',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'A0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(0, 0, 500, 700)],
                        anchors: [{ name: 'top', x: 250, y: 700 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'acutecomb',
                category: 'Mark',
                exported: true,
                layers: [
                    {
                        id: 'AC0',
                        width: 180,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(0, 0, 80, 120)],
                        anchors: [{ name: '_top', x: 40, y: 0 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'visibleComposite',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'VC0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('A'),
                            makeComponent('acutecomb')
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'hiddenComposite',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'HC0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('A'),
                            makeComponent('acutecomb')
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            }
        ],
        names: { family_name: { en: 'Visible Anchor Cascade' } },
        note: '',
        date: '2026-04-07',
        features: { classes: {}, prefixes: {}, features: [] },
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

function makeRecursiveDependencyFont() {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [makeStation()],
        glyphs: [
            {
                name: 'source',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'SRC0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(0, 0, 100, 100)],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'directDependent',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'DD0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeComponent('source')],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'nestedDependent',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'ND0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeComponent('directDependent')],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'unrelated',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'U0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(0, 0, 80, 80)],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            }
        ],
        names: { family_name: { en: 'Recursive Dependency Canonical' } },
        note: '',
        date: '2026-05-11',
        features: { classes: {}, prefixes: {}, features: [] },
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

function makeNestedVisibleAnchorCascadeFont() {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [makeStation()],
        glyphs: [
            {
                name: 'A',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'A0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(0, 0, 500, 700)],
                        anchors: [{ name: 'top', x: 250, y: 700 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'acutecomb',
                category: 'Mark',
                exported: true,
                layers: [
                    {
                        id: 'AC0',
                        width: 180,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(0, 0, 80, 120)],
                        anchors: [{ name: '_top', x: 40, y: 0 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'visibleComposite',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'VC0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('A'),
                            makeComponent('acutecomb')
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'nestedVisibleComposite',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'NVC0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeComponent('visibleComposite')],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            }
        ],
        names: { family_name: { en: 'Nested Visible Anchor Cascade' } },
        note: '',
        date: '2026-05-11',
        features: { classes: {}, prefixes: {}, features: [] },
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

function makeSingleOffsetAutomaticFont() {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [makeStation()],
        glyphs: [
            {
                name: 'acutecomb',
                category: 'Mark',
                exported: true,
                layers: [
                    {
                        id: 'AC0',
                        width: 180,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(-40, 680, 40, 780)],
                        anchors: [
                            { name: '_top', x: 0, y: 720 },
                            { name: 'top', x: 0, y: 820 }
                        ],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'acutecomb.case',
                category: 'Mark',
                exported: true,
                layers: [
                    {
                        id: 'ACC0',
                        width: 0,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('acutecomb', {
                                y: 190
                            })
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            }
        ],
        names: { family_name: { en: 'Automatic Offset Canonical' } },
        note: '',
        date: '2026-04-06',
        features: { classes: {}, prefixes: {}, features: [] },
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

function makeRotatedAutomaticBaseFont() {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [makeStation()],
        glyphs: [
            {
                name: 'n',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'N0',
                        width: 571,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(40, 0, 531, 492)],
                        anchors: [
                            { name: 'bottom', x: 260, y: 0 },
                            { name: 'top', x: 280, y: 492 }
                        ],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'u',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'U0',
                        width: 0,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('n', {
                                transform: {
                                    translation: [571, 492],
                                    scale: [1, 1],
                                    rotation: Math.PI,
                                    skew: [0, 0],
                                    tCenter: [0, 0],
                                    order: 'Glyphs'
                                }
                            })
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            }
        ],
        names: { family_name: { en: 'Automatic Rotated Base Canonical' } },
        note: '',
        date: '2026-04-06',
        features: { classes: {}, prefixes: {}, features: [] },
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

function makeChainedBaseAutomaticFont() {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [makeStation()],
        glyphs: [
            {
                name: 'leftBase',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'LB0',
                        width: 400,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(40, 0, 360, 300)],
                        anchors: [{ name: '#exit', x: 340, y: 150 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'middleBase',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'MB0',
                        width: 350,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(20, 0, 320, 300)],
                        anchors: [
                            { name: '#entry', x: 20, y: 150 },
                            { name: '#exit', x: 300, y: 150 }
                        ],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'rightBase',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'RB0',
                        width: 280,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(10, 0, 250, 300)],
                        anchors: [{ name: '#entry', x: 30, y: 150 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'chainedWord',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'CW0',
                        width: 0,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('leftBase'),
                            makeComponent('middleBase'),
                            makeComponent('rightBase')
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            }
        ],
        names: { family_name: { en: 'Automatic Chained Bases Canonical' } },
        note: '',
        date: '2026-04-07',
        features: { classes: {}, prefixes: {}, features: [] },
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

function makeChainedBaseSidebearingKeyFont() {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [makeStation()],
        glyphs: [
            {
                name: 'leftChainBase',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'LCB0',
                        width: 420,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(45, 0, 365, 300)],
                        anchors: [{ name: '#exit', x: 340, y: 150 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'rightChainBase',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'RCB0',
                        width: 360,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(30, 0, 300, 300)],
                        anchors: [{ name: '#entry', x: 30, y: 150 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'sidebearingChain',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'SBC0',
                        width: 0,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('leftChainBase'),
                            makeComponent('rightChainBase')
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            }
        ],
        names: { family_name: { en: 'Automatic Chained Sidebearing Keys' } },
        note: '',
        date: '2026-04-07',
        features: { classes: {}, prefixes: {}, features: [] },
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

function setupCanvasForDrawing(canvas, font, glyphName, drawingId) {
    canvas.outlineEditor.active = true;
    canvas.outlineEditor.selectedDrawingId = drawingId;
    canvas.outlineEditor.glyphStack = `${glyphName}@${drawingId}`;
    canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
        { glyphName, layerId: drawingId }
    ]);
    canvas.getCurrentGlyphName = jest.fn(() => glyphName);
    const drawing = font.findGlyph(glyphName).findDrawingById(drawingId);
    canvas.outlineEditor.drawingData = {
        ...drawing.toJSON(),
        isInterpolated: false
    };
    return drawing;
}

describe('Automatic Glyph Composition canonical behavior', () => {
    test('an explicit manual alignment flag makes the component layer manual', () => {
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            instances: [],
            masters: [makeStation()],
            glyphs: [
                {
                    name: 'dotaccentcomb',
                    category: 'Mark',
                    exported: true,
                    layers: [
                        {
                            id: 'DOT0',
                            width: 200,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [makeRectPath(0, 0, 60, 60)],
                            anchors: [{ name: '_top', x: 30, y: 30 }],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'dieresiscomb',
                    category: 'Mark',
                    exported: true,
                    layers: [
                        {
                            id: 'DIER0',
                            width: 200,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [
                                {
                                    reference: 'dotaccentcomb',
                                    transform: [1, 0, 0, 1, 0, 0],
                                    format_specific: {}
                                },
                                {
                                    reference: 'dotaccentcomb',
                                    transform: [1, 0, 0, 1, 120, 0],
                                    format_specific: {
                                        [GLYPHS_COMPONENT_ALIGNMENT_KEY]: -1
                                    }
                                }
                            ],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                }
            ],
            names: { family_name: { en: 'Automatic Alignment Explicit Only' } },
            note: '',
            date: '2026-04-06',
            features: { classes: {}, prefixes: {}, features: [] },
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const drawing = font.findGlyph('dieresiscomb').drawings[0];

        expect(drawing.components[0].isAutomaticAligned()).toBe(false);
        expect(drawing.components[1].isAutomaticAligned()).toBe(false);
        expect(drawing.isAutomaticAlignedDrawing()).toBe(false);
    });

    function enableAutomaticAlignment(drawing) {
        for (const component of drawing.components) {
            component.automaticAlignment = true;
        }
    }

    test('enabling automatic alignment copies base kerning groups and creates missing groups by glyph name', () => {
        const font = makeAutomaticCompositionFont();
        const drawing = font.findGlyph('manualComposite').drawings[0];

        enableAutomaticAlignment(drawing);

        expect(drawing.isAutomaticAlignedDrawing()).toBe(true);
        expect(font.second_kern_groups).toEqual({
            A: ['A', 'manualComposite']
        });
        expect(font.first_kern_groups).toEqual({
            A: ['A', 'manualComposite']
        });
    });

    test('enabling automatic alignment reuses existing base kerning groups on each side', () => {
        const font = makeAutomaticCompositionFont();
        font.second_kern_groups = { ALeft: ['A'] };
        font.first_kern_groups = { ARight: ['A'] };
        const drawing = font.findGlyph('manualComposite').drawings[0];

        enableAutomaticAlignment(drawing);

        expect(font.second_kern_groups).toEqual({
            ALeft: ['A', 'manualComposite']
        });
        expect(font.first_kern_groups).toEqual({
            ARight: ['A', 'manualComposite']
        });
    });

    test('rebuilds and disabling automatic alignment do not change kerning groups', () => {
        const font = makeAutomaticCompositionFont();
        const adieresis = font.findGlyph('adieresis').drawings[0];
        adieresis.rebuildAutomaticComposition();

        expect(font.first_kern_groups).toEqual({});
        expect(font.second_kern_groups).toEqual({});

        const drawing = font.findGlyph('manualComposite').drawings[0];
        enableAutomaticAlignment(drawing);
        drawing.components[0].automaticAlignment = false;

        expect(drawing.isAutomaticAlignedDrawing()).toBe(false);
        expect(font.second_kern_groups).toEqual({
            A: ['A', 'manualComposite']
        });
        expect(font.first_kern_groups).toEqual({
            A: ['A', 'manualComposite']
        });
    });

    test('automatic ligatures take the left group from the first base and the right group from the last base', () => {
        const font = makeAutomaticCompositionFont();
        const drawing = font.findGlyph('AB').drawings[0];
        for (const component of drawing.components) {
            component.automaticAlignment = false;
        }

        expect(font.first_kern_groups).toEqual({});
        expect(font.second_kern_groups).toEqual({});

        enableAutomaticAlignment(drawing);

        expect(font.second_kern_groups).toEqual({ A: ['A', 'AB'] });
        expect(font.first_kern_groups).toEqual({ B: ['AB', 'B'] });
    });

    test('automatic composites follow nested automatic bases recursively for kerning groups', () => {
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            instances: [],
            masters: [makeStation()],
            glyphs: [
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'A0',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [makeRectPath(50, 0, 450, 700)],
                            anchors: [
                                { name: 'top', x: 250, y: 700 },
                                { name: '#exit', x: 480, y: 150 }
                            ],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'E',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'E0',
                            width: 400,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [makeRectPath(20, 0, 380, 700)],
                            anchors: [
                                { name: 'top', x: 200, y: 700 },
                                { name: '#entry', x: 20, y: 150 }
                            ],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'acutecomb',
                    category: 'Mark',
                    exported: true,
                    layers: [
                        {
                            id: 'AC0',
                            width: 180,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [makeRectPath(-40, 680, 40, 780)],
                            anchors: [{ name: '_top', x: 0, y: 720 }],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'AE',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'AE0',
                            width: 0,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [makeComponent('A'), makeComponent('E')],
                            anchors: [{ name: 'top', x: 250, y: 700 }],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'AEacute',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'AEA0',
                            width: 0,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [
                                makeComponent('AE', { auto: false }),
                                makeComponent('acutecomb', { auto: false })
                            ],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                }
            ],
            names: { family_name: { en: 'Nested Automatic Ligature Kerning' } },
            note: '',
            date: '2026-08-14',
            features: { classes: {}, prefixes: {}, features: [] },
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        enableAutomaticAlignment(font.findGlyph('AEacute').drawings[0]);

        expect(font.second_kern_groups).toEqual({ A: ['A', 'AEacute'] });
        expect(font.first_kern_groups).toEqual({ E: ['AEacute', 'E'] });
        expect(font.second_kern_groups.A).not.toContain('AE');
        expect(font.first_kern_groups.E).not.toContain('AE');
    });

    test('only component-only layers with all-auto components participate in automatic composition', () => {
        const font = makeAutomaticCompositionFont();

        expect(
            font.findGlyph('adieresis').drawings[0].isAutomaticAlignedDrawing()
        ).toBe(true);
        expect(
            font.findGlyph('AB').drawings[0].isAutomaticAlignedDrawing()
        ).toBe(true);
        expect(
            font.findGlyph('hybrid').drawings[0].isAutomaticAlignedDrawing()
        ).toBe(false);
        expect(
            font
                .findGlyph('manualComposite')
                .drawings[0].isAutomaticAlignedDrawing()
        ).toBe(false);
    });

    test('base-plus-mark compositions stack by shape order and keep width derived from bases', () => {
        const font = makeAutomaticCompositionFont();
        const drawing = font.findGlyph('adieresis').drawings[0];
        const changed = drawing.rebuildAutomaticComposition();
        const [base, acute, grave] = drawing.components;

        expect(changed).toBe(true);
        expect(base.toAffineArray()[4]).toBeCloseTo(0, 5);
        expect(base.toAffineArray()[5]).toBeCloseTo(0, 5);
        expect(acute.toAffineArray()[4]).toBeCloseTo(250, 5);
        expect(acute.toAffineArray()[5]).toBeCloseTo(-20, 5);
        expect(grave.toAffineArray()[4]).toBeCloseTo(250, 5);
        expect(grave.toAffineArray()[5]).toBeCloseTo(90, 5);
        expect(drawing.width).toBeCloseTo(500, 5);
    });

    test('multiple base components advance in component order', () => {
        const font = makeAutomaticCompositionFont();
        const drawing = font.findGlyph('AB').drawings[0];
        const changed = drawing.rebuildAutomaticComposition();
        const [leftBase, rightBase] = drawing.components;

        expect(changed).toBe(true);
        expect(leftBase.toAffineArray()[4]).toBeCloseTo(0, 5);
        expect(rightBase.toAffineArray()[4]).toBeCloseTo(500, 5);
        expect(drawing.width).toBeCloseTo(800, 5);
    });

    test('single unattached automatic components preserve stored offsets', () => {
        const font = makeSingleOffsetAutomaticFont();
        const drawing = font.findGlyph('acutecomb.case').drawings[0];
        const changed = drawing.rebuildAutomaticComposition();
        const [base] = drawing.components;

        expect(changed).toBe(true);
        expect(drawing.isAutomaticAlignedDrawing()).toBe(true);
        expect(base.toAffineArray()[4]).toBeCloseTo(0, 5);
        expect(base.toAffineArray()[5]).toBeCloseTo(190, 5);
        expect(drawing.width).toBeCloseTo(180, 5);
    });

    test('rotated unattached automatic bases keep positive width and in-width placement', () => {
        const font = makeRotatedAutomaticBaseFont();
        const drawing = font.findGlyph('u').drawings[0];
        const changed = drawing.rebuildAutomaticComposition();
        const [base] = drawing.components;

        expect(changed).toBe(true);
        expect(drawing.isAutomaticAlignedDrawing()).toBe(true);
        expect(base.toAffineArray()[4]).toBeCloseTo(571, 5);
        expect(base.toAffineArray()[5]).toBeCloseTo(492, 5);
        expect(drawing.width).toBeCloseTo(571, 5);
        expect(drawing.lsb).toBeCloseTo(40, 5);
        expect(drawing.rsb).toBeCloseTo(40, 5);
    });

    test('chained base components align by #exit and #entry and derive metrics from the chain ends', () => {
        const font = makeChainedBaseAutomaticFont();
        const drawing = font.findGlyph('chainedWord').drawings[0];
        const changed = drawing.rebuildAutomaticComposition();
        const [leftBase, middleBase, rightBase] = drawing.components;

        expect(changed).toBe(true);
        expect(drawing.isAutomaticAlignedDrawing()).toBe(true);
        expect(leftBase.toAffineArray()[4]).toBeCloseTo(0, 5);
        expect(middleBase.toAffineArray()[4]).toBeCloseTo(320, 5);
        expect(rightBase.toAffineArray()[4]).toBeCloseTo(590, 5);
        expect(drawing.width).toBeCloseTo(870, 5);
        expect(drawing.lsb).toBeCloseTo(40, 5);
        expect(drawing.rsb).toBeCloseTo(30, 5);
    });

    test('anchor families expose override choices and explicit overrides pick the exact target anchor', () => {
        const font = makeAutomaticCompositionFont();
        const drawing = font.findGlyph('adieresis').drawings[0];
        const acute = drawing.components[1];
        const grave = drawing.components[2];

        expect(drawing.getAutomaticComponentTargetAnchorOptions(acute)).toEqual(
            ['top', 'top_alt']
        );

        acute.anchor = 'top_alt';
        drawing.rebuildAutomaticComposition();

        expect(acute.anchor).toBe('top_alt');
        expect(acute.toAffineArray()[4]).toBeCloseTo(320, 5);
        expect(grave.toAffineArray()[4]).toBeCloseTo(320, 5);
    });

    test('live automatic placement keeps attached components anchored after scaling raw layer data', () => {
        const font = makeAutomaticCompositionFont();
        const drawing = font.findGlyph('adieresis').drawings[0];

        drawing.rebuildAutomaticComposition();
        const liveDrawingData = drawing.toCompileJSON();
        liveDrawingData.shapes[0].transform.scale = [2, 2];

        const changed =
            drawing.applyAutomaticCompositionToDrawingData(liveDrawingData);
        const [baseShape, acuteShape, graveShape] = liveDrawingData.shapes;

        expect(changed).toBe(true);
        expect(getSerializedTranslationX(baseShape)).toBeCloseTo(0, 5);
        expect(getSerializedTranslationX(acuteShape)).toBeCloseTo(500, 5);
        expect(getSerializedTranslationX(graveShape)).toBeCloseTo(500, 5);
        expect(liveDrawingData.width).toBeCloseTo(1000, 5);
    });

    test('moving a source anchor rebuilds downstream automatic composites', () => {
        const font = makeAutomaticCompositionFont();
        const baseDrawing = font.findGlyph('A').drawings[0];
        const compositeDrawing = font.findGlyph('adieresis').drawings[0];
        const acute = compositeDrawing.components[1];

        acute.anchor = 'top_alt';
        compositeDrawing.rebuildAutomaticComposition();
        expect(acute.toAffineArray()[4]).toBeCloseTo(320, 5);

        const topAlt = baseDrawing.anchors.find(
            (anchor) => anchor.name === 'top_alt'
        );
        topAlt.x = 360;

        const rebuiltGlyphNames = font.rebuildAutomaticCompositesForGlyphs(
            new Set(['A'])
        );

        expect(rebuiltGlyphNames.has('adieresis')).toBe(true);
        expect(compositeDrawing.components[1].toAffineArray()[4]).toBeCloseTo(
            360,
            5
        );
    });

    test('editing chained base anchors rebuilds inheriting composites in the same automatic recomposition pass', () => {
        const font = makeChainedBaseAutomaticFont();
        const middleBaseDrawing = font.findGlyph('middleBase').drawings[0];
        const compositeDrawing = font.findGlyph('chainedWord').drawings[0];

        compositeDrawing.rebuildAutomaticComposition();
        expect(compositeDrawing.components[2].toAffineArray()[4]).toBeCloseTo(
            590,
            5
        );

        const exitAnchor = middleBaseDrawing.anchors.find(
            (anchor) => anchor.name === '#exit'
        );
        exitAnchor.x = 330;

        const rebuiltGlyphNames = font.rebuildAutomaticCompositesForGlyphs(
            new Set(['middleBase'])
        );

        expect(rebuiltGlyphNames.has('chainedWord')).toBe(true);
        expect(compositeDrawing.components[2].toAffineArray()[4]).toBeCloseTo(
            620,
            5
        );
        expect(compositeDrawing.width).toBeCloseTo(900, 5);
    });

    test('automatic layers reject direct sidebearing values and accept automatic offsets', () => {
        const font = makeAutomaticCompositionFont();
        const glyph = font.findGlyph('adieresis');
        const drawing = glyph.drawings[0];

        drawing.rebuildAutomaticComposition();
        const rejected = drawing.applySidebearingInput('left', '50');
        const accepted = drawing.applySidebearingInput('left', '=+20');

        expect(rejected.error).toBe(
            'Automatic sidebearings only accept =+/- or ==+/- adjustments'
        );
        expect(glyph.leftMetricsKey).toBe('=+20');
        expect(accepted.error).toBeNull();
        expect(accepted.value).not.toBeNull();
        expect(drawing.resolveMetricsKey('left').value).not.toBeNull();
    });

    test('automatic chained layers ignore imported direct-reference metrics keys and keep implicit derived sidebearings', () => {
        const font = makeChainedBaseAutomaticFont();
        const glyph = font.findGlyph('chainedWord');
        const drawing = glyph.drawings[0];

        glyph.leftMetricsKey = '=leftBase';
        glyph.rightMetricsKey = '=rightBase';

        drawing.rebuildAutomaticComposition();

        expect(drawing.resolveMetricsKey('left').input).toBe('');
        expect(drawing.resolveMetricsKey('right').input).toBe('');
        expect(drawing.resolveMetricsKey('left').value).toBeCloseTo(40, 5);
        expect(drawing.resolveMetricsKey('right').value).toBeCloseTo(30, 5);
    });

    test('automatic chained layers apply sidebearing key offsets from the implicitly derived chain sidebearings', () => {
        const font = makeChainedBaseSidebearingKeyFont();
        const glyph = font.findGlyph('sidebearingChain');
        const drawing = glyph.drawings[0];

        drawing.rebuildAutomaticComposition();

        expect(drawing.lsb).toBeCloseTo(45, 5);
        expect(drawing.rsb).toBeCloseTo(60, 5);
        expect(drawing.components[0].toAffineArray()[4]).toBeCloseTo(0, 5);
        expect(drawing.components[1].toAffineArray()[4]).toBeCloseTo(310, 5);
        expect(drawing.width).toBeCloseTo(670, 5);

        const leftAdjusted = drawing.applySidebearingInput('left', '=+10');
        const rightAdjusted = drawing.applySidebearingInput('right', '=-10');

        expect(leftAdjusted.error).toBeNull();
        expect(rightAdjusted.error).toBeNull();
        expect(drawing.resolveMetricsKey('left').value).toBeCloseTo(55, 5);
        expect(drawing.resolveMetricsKey('right').value).toBeCloseTo(50, 5);

        const serialized = drawing.toCompileJSON();
        expect(getSerializedTranslationX(serialized.shapes[0])).toBeCloseTo(
            10,
            5
        );
        expect(getSerializedTranslationX(serialized.shapes[1])).toBeCloseTo(
            320,
            5
        );
        expect(serialized.width).toBeCloseTo(670, 5);
    });

    test('automatic LSB offsets move serialized component positions while RSB offsets only widen the serialized advance', () => {
        const leftFont = makeChainedBaseSidebearingKeyFont();
        const leftDrawing = leftFont.findGlyph('sidebearingChain').drawings[0];

        leftDrawing.rebuildAutomaticComposition();
        leftDrawing.applySidebearingInput('left', '=+100');

        // Resting toJSON stays logical (unoffset translates); compile JSON bakes.
        const logical = leftDrawing.toJSON();
        expect(getSerializedTranslationX(logical.shapes[0])).toBeCloseTo(0, 5);
        expect(logical.width).toBeCloseTo(770, 5);

        const leftSerialized = leftDrawing.toCompileJSON();
        expect(getSerializedTranslationX(leftSerialized.shapes[0])).toBeCloseTo(
            100,
            5
        );
        expect(getSerializedTranslationX(leftSerialized.shapes[1])).toBeCloseTo(
            410,
            5
        );
        expect(leftSerialized.width).toBeCloseTo(770, 5);

        // Round-trip: baking compile JSON must not pollute resting toJSON.
        expect(
            getSerializedTranslationX(leftDrawing.toJSON().shapes[0])
        ).toBeCloseTo(0, 5);

        const rightFont = makeChainedBaseSidebearingKeyFont();
        const rightDrawing =
            rightFont.findGlyph('sidebearingChain').drawings[0];

        rightDrawing.rebuildAutomaticComposition();
        rightDrawing.applySidebearingInput('right', '=+100');

        const rightSerialized = rightDrawing.toCompileJSON();
        expect(
            getSerializedTranslationX(rightSerialized.shapes[0])
        ).toBeCloseTo(0, 5);
        expect(
            getSerializedTranslationX(rightSerialized.shapes[1])
        ).toBeCloseTo(310, 5);
        expect(rightSerialized.width).toBeCloseTo(770, 5);
    });

    test('sequential base LSB edits keep compile-facing auto RSB stable without double-baking', () => {
        const font = makeAutomaticCompositionFont();
        const baseDrawing = font.findGlyph('A').drawings[0];
        const autoDrawing = font.findGlyph('adieresis').drawings[0];

        autoDrawing.rebuildAutomaticComposition();
        autoDrawing.applySidebearingInput('left', '=+50');
        autoDrawing.rebuildAutomaticComposition();

        const physicalRsb = (drawing) => {
            const compiled = drawing.toCompileJSON();
            const shapes = compiled.shapes || [];
            let maxX = -Infinity;
            for (const shape of shapes) {
                const data = shape.Component || shape;
                const tx = Array.isArray(data.transform)
                    ? data.transform[4]
                    : data.transform?.translation?.[0] || 0;
                // Base glyph ink is 50..450 (width 500) in this fixture.
                maxX = Math.max(maxX, tx + 450);
            }
            return compiled.width - maxX;
        };

        const rsbAfterSetup = physicalRsb(autoDrawing);
        expect(
            getSerializedTranslationX(autoDrawing.toJSON().shapes[0])
        ).toBeCloseTo(0, 5);
        expect(
            getSerializedTranslationX(autoDrawing.toCompileJSON().shapes[0])
        ).toBeCloseTo(50, 5);

        // Drag 1 on base `A` LSB.
        baseDrawing.setDirectSidebearing('left', baseDrawing.lsb + 40);
        font.rebuildAutomaticCompositesForGlyphs(new Set(['A']));
        const rsbAfterDrag1 = physicalRsb(autoDrawing);
        expect(rsbAfterDrag1).toBeCloseTo(rsbAfterSetup, 5);
        expect(
            getSerializedTranslationX(autoDrawing.toJSON().shapes[0])
        ).toBeCloseTo(0, 5);

        // Drag 2 — compile-facing RSB must not drift (no dual bake).
        baseDrawing.setDirectSidebearing('left', baseDrawing.lsb + 25);
        font.rebuildAutomaticCompositesForGlyphs(new Set(['A']));
        const rsbAfterDrag2 = physicalRsb(autoDrawing);
        expect(rsbAfterDrag2).toBeCloseTo(rsbAfterSetup, 5);
        expect(
            getSerializedTranslationX(autoDrawing.toCompileJSON().shapes[0])
        ).toBeCloseTo(50, 5);
    });

    test('two live compile-facing stage cycles after mouseup teardown keep auto RSB stable', () => {
        // Live preview stages toCompileJSON into the worker overlay, then
        // mouseup clears that overlay. Drag 2 must stage a fresh physical
        // payload from logical resting state — never double-bake =+.
        const font = makeAutomaticCompositionFont();
        const baseDrawing = font.findGlyph('A').drawings[0];
        const autoDrawing = font.findGlyph('adieresis').drawings[0];

        autoDrawing.rebuildAutomaticComposition();
        autoDrawing.applySidebearingInput('left', '=+50');
        autoDrawing.rebuildAutomaticComposition();

        const physicalRsb = (compiled) => {
            const shapes = compiled.shapes || [];
            let maxX = -Infinity;
            for (const shape of shapes) {
                const data = shape.Component || shape;
                const tx = Array.isArray(data.transform)
                    ? data.transform[4]
                    : data.transform?.translation?.[0] || 0;
                maxX = Math.max(maxX, tx + 450);
            }
            return compiled.width - maxX;
        };

        const stageCompileFacingPayload = () => {
            // Same boundary as collectChangedDrawingUpdatesFromTargets({
            //   compileFacing: true }) for automatic dependents.
            return {
                resting: autoDrawing.toJSON(),
                overlay: autoDrawing.toCompileJSON()
            };
        };

        const rsbAfterSetup = physicalRsb(autoDrawing.toCompileJSON());

        // Drag 1 live stage
        baseDrawing.setDirectSidebearing('left', baseDrawing.lsb + 40);
        font.rebuildAutomaticCompositesForGlyphs(new Set(['A']));
        const stage1 = stageCompileFacingPayload();
        expect(getSerializedTranslationX(stage1.resting.shapes[0])).toBeCloseTo(
            0,
            5
        );
        expect(getSerializedTranslationX(stage1.overlay.shapes[0])).toBeCloseTo(
            50,
            5
        );
        const rsbAfterDrag1 = physicalRsb(stage1.overlay);
        expect(rsbAfterDrag1).toBeCloseTo(rsbAfterSetup, 5);

        // Mouseup teardown: overlay discarded; resting stays logical.
        // (Worker clearLiveDragPreview / apply_yjs_update — model unchanged.)
        expect(
            getSerializedTranslationX(autoDrawing.toJSON().shapes[0])
        ).toBeCloseTo(0, 5);

        // Drag 2 live stage — must match drag-1 physical RSB, still tx=50.
        baseDrawing.setDirectSidebearing('left', baseDrawing.lsb + 25);
        font.rebuildAutomaticCompositesForGlyphs(new Set(['A']));
        const stage2 = stageCompileFacingPayload();
        expect(getSerializedTranslationX(stage2.resting.shapes[0])).toBeCloseTo(
            0,
            5
        );
        expect(getSerializedTranslationX(stage2.overlay.shapes[0])).toBeCloseTo(
            50,
            5
        );
        expect(physicalRsb(stage2.overlay)).toBeCloseTo(rsbAfterSetup, 5);
        expect(physicalRsb(stage2.overlay)).toBeCloseTo(rsbAfterDrag1, 5);
    });

    test('automatic layers clear sidebearing override keys back to implicit auto when input is deleted', () => {
        const font = makeChainedBaseSidebearingKeyFont();
        const glyph = font.findGlyph('sidebearingChain');
        const drawing = glyph.drawings[0];

        drawing.rebuildAutomaticComposition();
        drawing.applySidebearingInput('left', '=+10');
        drawing.applySidebearingInput('right', '=-10');

        expect(drawing.resolveMetricsKey('left').value).toBeCloseTo(55, 5);
        expect(drawing.resolveMetricsKey('right').value).toBeCloseTo(
            60 - 10,
            5
        );

        const clearedLeft = drawing.applySidebearingInput('left', '');
        const clearedRight = drawing.applySidebearingInput('right', '');

        expect(clearedLeft.error).toBeNull();
        expect(clearedRight.error).toBeNull();
        expect(glyph.leftMetricsKey).toBeUndefined();
        expect(glyph.rightMetricsKey).toBeUndefined();
        expect(drawing.resolveMetricsKey('left').input).toBe('');
        expect(drawing.resolveMetricsKey('right').input).toBe('');
        expect(drawing.resolveMetricsKey('left').value).toBeCloseTo(45, 5);
        expect(drawing.resolveMetricsKey('right').value).toBeCloseTo(60, 5);
    });

    test('Font.toJSONString() keeps logical component positions by default; compileFacing bakes =+ offsets', () => {
        // Resting/Yjs serialization must stay logical. Physical =+/- bake is
        // requested explicitly via { compileFacing: true } for export/preview.
        const font = makeChainedBaseSidebearingKeyFont();
        const drawing = font.findGlyph('sidebearingChain').drawings[0];

        drawing.rebuildAutomaticComposition();

        // Baseline: before any key, toJSONString must have base positions (x=0 for first component)
        const baseJson = JSON.parse(font.toJSONString());
        const baseDrawing = baseJson.glyphs.find(
            (g) => g.name === 'sidebearingChain'
        ).layers[0];
        expect(getSerializedTranslationX(baseDrawing.shapes[0])).toBeCloseTo(
            0,
            5
        );
        expect(baseDrawing.width).toBeCloseTo(670, 5);

        // Apply a left sidebearing offset of +100
        drawing.applySidebearingInput('left', '=+100');

        // Default serialization stays logical (unoffset translates; width includes key).
        const logicalJson = JSON.parse(font.toJSONString());
        const logicalDrawing = logicalJson.glyphs.find(
            (g) => g.name === 'sidebearingChain'
        ).layers[0];
        expect(getSerializedTranslationX(logicalDrawing.shapes[0])).toBeCloseTo(
            0,
            5
        );
        expect(logicalDrawing.width).toBeCloseTo(770, 5);

        // Explicit compile-facing serialization bakes left offsets into translates.
        const adjustedJson = JSON.parse(
            font.toJSONString({ compileFacing: true })
        );
        const adjustedDrawing = adjustedJson.glyphs.find(
            (g) => g.name === 'sidebearingChain'
        ).layers[0];

        expect(
            getSerializedTranslationX(adjustedDrawing.shapes[0])
        ).toBeCloseTo(100, 5);
        expect(
            getSerializedTranslationX(adjustedDrawing.shapes[1])
        ).toBeCloseTo(410, 5);
        expect(adjustedDrawing.width).toBeCloseTo(770, 5);
    });

    test('Font.toJSONString() includes offset-applied width for automatic layers with =+ RSB keys', () => {
        const font = makeChainedBaseSidebearingKeyFont();
        const drawing = font.findGlyph('sidebearingChain').drawings[0];

        drawing.rebuildAutomaticComposition();
        drawing.applySidebearingInput('right', '=+100');

        const adjustedJson = JSON.parse(font.toJSONString());
        const adjustedDrawing = adjustedJson.glyphs.find(
            (g) => g.name === 'sidebearingChain'
        ).layers[0];

        // RSB offset widens the advance but does not shift component positions
        expect(
            getSerializedTranslationX(adjustedDrawing.shapes[0])
        ).toBeCloseTo(0, 5);
        expect(
            getSerializedTranslationX(adjustedDrawing.shapes[1])
        ).toBeCloseTo(310, 5);
        expect(adjustedDrawing.width).toBeCloseTo(770, 5);
    });

    test('Font.toJSONString() reverts to base positions after the sidebearing key is cleared', () => {
        const font = makeChainedBaseSidebearingKeyFont();
        const drawing = font.findGlyph('sidebearingChain').drawings[0];

        drawing.rebuildAutomaticComposition();
        drawing.applySidebearingInput('left', '=+100');
        drawing.applySidebearingInput('left', '');

        const clearedJson = JSON.parse(font.toJSONString());
        const clearedDrawing = clearedJson.glyphs.find(
            (g) => g.name === 'sidebearingChain'
        ).layers[0];

        expect(getSerializedTranslationX(clearedDrawing.shapes[0])).toBeCloseTo(
            0,
            5
        );
        expect(clearedDrawing.width).toBeCloseTo(670, 5);
    });

    test('rebuild recovers logical first-base translate after compile-facing writeback poison', () => {
        const font = makeAutomaticCompositionFont();
        const autoDrawing = font.findGlyph('adieresis').drawings[0];

        autoDrawing.rebuildAutomaticComposition();
        autoDrawing.applySidebearingInput('left', '=+50');
        autoDrawing.rebuildAutomaticComposition();

        const physicalRsb = (drawing) => {
            const compiled = drawing.toCompileJSON();
            const shapes = compiled.shapes || [];
            let maxX = -Infinity;
            for (const shape of shapes) {
                const data = shape.Component || shape;
                const tx = Array.isArray(data.transform)
                    ? data.transform[4]
                    : data.transform?.translation?.[0] || 0;
                maxX = Math.max(maxX, tx + 450);
            }
            return compiled.width - maxX;
        };

        const rsbBefore = physicalRsb(autoDrawing);
        expect(
            getSerializedTranslationX(autoDrawing.toJSON().shapes[0])
        ).toBeCloseTo(0, 5);

        // Simulate the old live-preview writeback bug: resting first-base
        // translate equals the automatic left bake.
        expect(
            autoDrawing.setComponentTranslation(
                autoDrawing.components[0],
                50,
                0
            )
        ).toBe(true);
        autoDrawing._cachedLayout = undefined;

        expect(
            getSerializedTranslationX(autoDrawing.toJSON().shapes[0])
        ).toBeCloseTo(50, 5);

        autoDrawing.rebuildAutomaticComposition();
        expect(
            getSerializedTranslationX(autoDrawing.toJSON().shapes[0])
        ).toBeCloseTo(0, 5);
        expect(physicalRsb(autoDrawing)).toBeCloseTo(rsbBefore, 5);
        expect(
            getSerializedTranslationX(autoDrawing.toCompileJSON().shapes[0])
        ).toBeCloseTo(50, 5);
    });
});

describe('Automatic component editing canonical behavior', () => {
    let canvas;
    let font;
    let currentFontSpy;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        font = makeAutomaticCompositionFont();
        font.findGlyph('adieresis').drawings[0].rebuildAutomaticComposition();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });
        window.changeBridge = null;
    });

    afterEach(() => {
        currentFontSpy.mockRestore();
        canvas.destroy();
    });

    test('property panel disables component translation for fully automatic layers and exposes anchor override choices', () => {
        const drawing = setupCanvasForDrawing(canvas, font, 'adieresis', 'AD0');
        canvas.outlineEditor.selectedComponents = [1];
        canvas.outlineEditor.selectedPoints = [];
        canvas.outlineEditor.selectedAnchors = [];

        canvas.updatePropertyPanel();

        const translateX = canvas.propertyPanel.querySelector(
            'input[data-property-field="component-translateX"]'
        );
        const translateY = canvas.propertyPanel.querySelector(
            'input[data-property-field="component-translateY"]'
        );
        const anchorSelect = canvas.propertyPanel.querySelector(
            'select[data-property-field="component-anchor"]'
        );

        expect(drawing.components[1].isAutomaticAligned()).toBe(true);
        expect(translateX).toBeTruthy();
        expect(translateY).toBeTruthy();
        expect(translateX.disabled).toBe(true);
        expect(translateY.disabled).toBe(true);
        expect(translateX.title).toBe(
            'Automatic component translation is derived from anchor alignment'
        );
        expect(anchorSelect).toBeTruthy();
        expect(
            Array.from(anchorSelect.options).map((option) => option.value)
        ).toEqual(['', 'top', 'top_alt']);
    });

    test('manual component layers keep every component movable', () => {
        const drawing = setupCanvasForDrawing(
            canvas,
            font,
            'manualComposite',
            'MC0'
        );
        canvas.outlineEditor.saveDrawingData = jest.fn();
        canvas.outlineEditor.selectedComponents = [0];
        canvas.outlineEditor.selectedPoints = [];
        canvas.outlineEditor.selectedAnchors = [];

        canvas.updatePropertyPanel();

        const translateX = canvas.propertyPanel.querySelector(
            'input[data-property-field="component-translateX"]'
        );
        const translateY = canvas.propertyPanel.querySelector(
            'input[data-property-field="component-translateY"]'
        );
        const anchorSelect = canvas.propertyPanel.querySelector(
            'select[data-property-field="component-anchor"]'
        );

        expect(drawing.isAutomaticAlignedDrawing()).toBe(false);
        expect(drawing.components[0].isAutomaticAligned()).toBe(false);
        expect(translateX).toBeTruthy();
        expect(translateY).toBeTruthy();
        expect(translateX.disabled).toBe(false);
        expect(translateY.disabled).toBe(false);
        expect(anchorSelect).toBeNull();

        canvas.outlineEditor.moveSelectedComponents(15, 25);

        expect(
            canvas.outlineEditor.drawingData.shapes[0].transform.translation[0]
        ).toBe(15);
        expect(
            canvas.outlineEditor.drawingData.shapes[0].transform.translation[1]
        ).toBe(25);
    });

    test('component alignment toggles mutate raw metadata in a manual layer', () => {
        const drawing = setupCanvasForDrawing(
            canvas,
            font,
            'manualComposite',
            'MC0'
        );
        const automaticComponent = drawing.components[0];

        expect(drawing.isAutomaticAlignedDrawing()).toBe(false);
        expect(automaticComponent.hasExplicitManualAlignment()).toBe(false);
        expect(automaticComponent.isAutomaticAligned()).toBe(false);
        automaticComponent.format_specific = {};

        expect(
            canvas.setComponentAutoAlignmentValue(automaticComponent, true)
        ).toBe(true);
        expect(
            automaticComponent.format_specific[GLYPHS_COMPONENT_ALIGNMENT_KEY]
        ).toBe(1);

        expect(
            canvas.setComponentAutoAlignmentValue(automaticComponent, false)
        ).toBe(true);
        expect(automaticComponent.hasExplicitManualAlignment()).toBe(true);
        expect(
            automaticComponent.format_specific[GLYPHS_COMPONENT_ALIGNMENT_KEY]
        ).toBe(-1);
    });

    test('renderer uses distinct fill and stroke styling for automatic and manual components', () => {
        const assignedFillStyles = [];
        const assignedStrokeStyles = [];
        const assignedLineWidths = [];
        let fillStyleValue = '';
        let strokeStyleValue = '';
        let lineWidthValue = 1;
        Object.defineProperty(canvas.renderer.ctx, 'fillStyle', {
            configurable: true,
            get: () => fillStyleValue,
            set: (value) => {
                fillStyleValue = value;
                assignedFillStyles.push(value);
            }
        });
        Object.defineProperty(canvas.renderer.ctx, 'strokeStyle', {
            configurable: true,
            get: () => strokeStyleValue,
            set: (value) => {
                strokeStyleValue = value;
                assignedStrokeStyles.push(value);
            }
        });
        Object.defineProperty(canvas.renderer.ctx, 'lineWidth', {
            configurable: true,
            get: () => lineWidthValue,
            set: (value) => {
                lineWidthValue = value;
                assignedLineWidths.push(value);
            }
        });

        const outlineShapes = [
            {
                nodes: [
                    { x: 0, y: 0, nodetype: 'Line' },
                    { x: 100, y: 0, nodetype: 'Line' },
                    { x: 100, y: 100, nodetype: 'Line' },
                    { x: 0, y: 100, nodetype: 'Line' }
                ],
                closed: true
            }
        ];

        canvas.renderer.drawComponentWithOutlines(
            outlineShapes,
            false,
            false,
            false,
            false,
            1,
            false
        );
        const manualFill = assignedFillStyles[assignedFillStyles.length - 1];
        const manualStroke =
            assignedStrokeStyles[assignedStrokeStyles.length - 1];
        const manualLineWidth =
            assignedLineWidths[assignedLineWidths.length - 1];

        canvas.renderer.drawComponentWithOutlines(
            outlineShapes,
            false,
            false,
            true,
            false,
            1,
            false
        );
        const automaticFill = assignedFillStyles[assignedFillStyles.length - 1];
        const automaticStroke =
            assignedStrokeStyles[assignedStrokeStyles.length - 1];
        const automaticLineWidth =
            assignedLineWidths[assignedLineWidths.length - 1];

        expect(manualFill).toBeTruthy();
        expect(automaticFill).toBeTruthy();
        expect(manualStroke).toBeTruthy();
        expect(automaticStroke).toBeTruthy();
        expect(automaticFill).not.toBe(manualFill);
        expect(automaticStroke).not.toBe(manualStroke);
        expect(manualStroke).not.toBe(manualFill);
        expect(automaticStroke).not.toBe(automaticFill);
        expect(manualLineWidth).toBe(1);
        expect(automaticLineWidth).toBe(1);
        expect(automaticFill).toContain('93, 129, 182');
        expect(APP_SETTINGS.OUTLINE_EDITOR.COMPONENT_FILLS.AUTO_NORMAL).toBe(
            '#5d81b6cc'
        );
    });

    test('renderer styles every component in a manually aligned layer as manual', () => {
        const outlineShapes = [
            {
                nodes: [
                    { x: 0, y: 0, nodetype: 'Line' },
                    { x: 100, y: 0, nodetype: 'Line' },
                    { x: 100, y: 100, nodetype: 'Line' },
                    { x: 0, y: 100, nodetype: 'Line' }
                ],
                closed: true
            }
        ];
        const drawingData = {
            shapes: [
                {
                    reference: 'dotaccentcomb',
                    transform: [1, 0, 0, 1, 0, 0],
                    format_specific: {},
                    layerData: { shapes: outlineShapes }
                },
                {
                    reference: 'dotaccentcomb',
                    transform: [1, 0, 0, 1, 120, 0],
                    format_specific: {
                        [GLYPHS_COMPONENT_ALIGNMENT_KEY]: -1
                    },
                    layerData: { shapes: outlineShapes }
                }
            ]
        };
        const drawComponent = jest
            .spyOn(canvas.renderer, 'drawComponentWithOutlines')
            .mockImplementation(() => {});

        canvas.renderer.renderDrawingShapes(drawingData, 1, false, false);

        expect(drawComponent).toHaveBeenCalledTimes(2);
        expect(drawComponent.mock.calls.map((call) => call[3])).toEqual([
            false,
            false
        ]);
    });

    test('automatic chained layers show auto placeholders instead of imported direct-reference metrics keys', () => {
        const chainedFont = makeChainedBaseAutomaticFont();
        const glyph = chainedFont.findGlyph('chainedWord');
        const drawing = glyph.drawings[0];

        glyph.leftMetricsKey = '=leftBase';
        glyph.rightMetricsKey = '=rightBase';
        drawing.rebuildAutomaticComposition();

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: chainedFont });

        setupCanvasForDrawing(canvas, chainedFont, 'chainedWord', 'CW0');
        canvas.updatePropertyPanel();

        const inputs = document.querySelectorAll('.glyph-property-input');
        expect(inputs[0].value).toBe('');
        expect(inputs[1].value).toBe('');
        expect(inputs[0].getAttribute('placeholder')).toBe('=+0 or ==+0');
        expect(inputs[1].getAttribute('placeholder')).toBe('=+0 or ==+0');
    });

    test('anchor drag limits downstream automatic recomposition to visible glyphs and uses incremental cache refresh', async () => {
        const dragFont = makeVisibleAnchorCascadeFont();
        const currentFont = {
            fontModel: dragFont,
            syncJsonFromModel: jest.fn(),
            requestRecompileWithoutDataChange: jest.fn()
        };

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);

        const stageLiveDragPreviewFromModelSpy = jest
            .spyOn(fontManager, 'stageLiveDragPreviewFromModel')
            .mockResolvedValue();
        const glyphChangedHandler = jest.fn();
        const autoCompileManager = window.autoCompileManager;
        window.autoCompileManager = {
            ...(autoCompileManager || {}),
            checkAndSchedule: jest.fn()
        };
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            setupCanvasForDrawing(canvas, dragFont, 'A', 'A0');
            expect(
                dragFont
                    .findGlyph('visibleComposite')
                    .drawings[0].isAutomaticAlignedDrawing()
            ).toBe(true);
            fontManager.updateEditingSubsetSnapshot(['visibleComposite']);
            canvas.textRunEditor.glyphNameBuffer = ['visibleComposite'];

            const topAnchor = canvas.outlineEditor.drawingData.anchors.find(
                (anchor) => anchor.name === 'top'
            );
            topAnchor.x = 320;

            const affectedGlyphNames =
                canvas.outlineEditor.rebuildAutomaticCompositesForCurrentEditedGlyph(
                    {
                        limitToDragVisibleGlyphs: true
                    }
                );

            expect(Array.from(affectedGlyphNames)).toEqual([
                'A',
                'visibleComposite'
            ]);

            canvas.outlineEditor.syncDependentGlyphsAfterAnchorEdit(
                'A',
                affectedGlyphNames,
                { liveVisibleOnly: true }
            );

            // Fire-and-forget path: flush microtask queue + macrotask
            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));

            // liveVisibleOnly skips syncJsonFromModel (deferred to mouseup)
            expect(currentFont.syncJsonFromModel).not.toHaveBeenCalled();
            expect(stageLiveDragPreviewFromModelSpy).toHaveBeenCalledTimes(1);
            expect(stageLiveDragPreviewFromModelSpy.mock.calls[0][0]).toEqual([
                { glyphName: 'A', layerId: 'A0' },
                { glyphName: 'visibleComposite', layerId: 'VC0' }
            ]);
            expect(stageLiveDragPreviewFromModelSpy.mock.calls[0][1]).toBe(
                'A0'
            );
            expect(stageLiveDragPreviewFromModelSpy.mock.calls[0][2]).toEqual({
                dispatchGlyphChanged: false,
                layerTargets: [
                    { glyphName: 'A', layerId: 'A0' },
                    { glyphName: 'visibleComposite', layerId: 'VC0' }
                ]
            });
            expect(glyphChangedHandler).not.toHaveBeenCalled();
            expect(
                window.autoCompileManager.checkAndSchedule
            ).not.toHaveBeenCalled();
            expect(
                currentFont.requestRecompileWithoutDataChange
            ).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
            window.autoCompileManager = autoCompileManager;
            stageLiveDragPreviewFromModelSpy.mockRestore();
            fontManager.updateEditingSubsetSnapshot([]);
        }
    });

    test('anchor drag reuses component source serialization across dependent composite rebuilds', () => {
        const dragFont = makeVisibleAnchorCascadeFont();

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: dragFont });

        setupCanvasForDrawing(canvas, dragFont, 'A', 'A0');

        const sourceDrawing = dragFont.findGlyph('A').drawings[0];
        const drawingPrototype = Object.getPrototypeOf(sourceDrawing);
        const originalToJSON = drawingPrototype.toJSON;
        const toJSONGlyphNames = [];
        const drawingToJSONSpy = jest
            .spyOn(drawingPrototype, 'toJSON')
            .mockImplementation(function (...args) {
                toJSONGlyphNames.push(this.parent()?.name || null);
                return originalToJSON.apply(this, args);
            });

        try {
            const topAnchor = canvas.outlineEditor.drawingData.anchors.find(
                (anchor) => anchor.name === 'top'
            );
            topAnchor.x = 320;

            const affectedGlyphNames =
                canvas.outlineEditor.rebuildAutomaticCompositesForCurrentEditedGlyph();

            expect(Array.from(affectedGlyphNames)).toEqual([
                'A',
                'visibleComposite',
                'hiddenComposite'
            ]);
            expect(
                toJSONGlyphNames.filter((glyphName) => glyphName === 'A')
            ).toHaveLength(1);
            expect(
                toJSONGlyphNames.filter(
                    (glyphName) => glyphName === 'acutecomb'
                )
            ).toHaveLength(1);
        } finally {
            drawingToJSONSpy.mockRestore();
        }
    });

    test('anchor drag still requests a live anchor-only recompile when no downstream composites are affected', async () => {
        const dragFont = makeVisibleAnchorCascadeFont();
        const currentFont = {
            fontModel: dragFont,
            syncJsonFromModel: jest.fn(),
            requestRecompileWithoutDataChange: jest.fn()
        };

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);

        const stageLiveDragPreviewFromModelSpy = jest
            .spyOn(fontManager, 'stageLiveDragPreviewFromModel')
            .mockResolvedValue();
        const glyphChangedHandler = jest.fn();
        const autoCompileManager = window.autoCompileManager;
        window.autoCompileManager = {
            ...(autoCompileManager || {}),
            checkAndSchedule: jest.fn()
        };
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            setupCanvasForDrawing(canvas, dragFont, 'A', 'A0');

            await canvas.outlineEditor.syncDependentGlyphsAfterAnchorEdit(
                'A',
                new Set(['A']),
                { liveVisibleOnly: true }
            );

            expect(currentFont.syncJsonFromModel).not.toHaveBeenCalled();
            expect(stageLiveDragPreviewFromModelSpy).toHaveBeenCalledTimes(1);
            expect(stageLiveDragPreviewFromModelSpy.mock.calls[0][0]).toEqual([
                { glyphName: 'A', layerId: 'A0' }
            ]);
            expect(stageLiveDragPreviewFromModelSpy.mock.calls[0][1]).toBe(
                'A0'
            );
            expect(stageLiveDragPreviewFromModelSpy.mock.calls[0][2]).toEqual({
                dispatchGlyphChanged: false,
                layerTargets: [{ glyphName: 'A', layerId: 'A0' }]
            });
            expect(glyphChangedHandler).not.toHaveBeenCalled();
            expect(
                currentFont.requestRecompileWithoutDataChange
            ).not.toHaveBeenCalled();
            expect(
                window.autoCompileManager.checkAndSchedule
            ).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
            window.autoCompileManager = autoCompileManager;
            stageLiveDragPreviewFromModelSpy.mockRestore();
        }
    });

    test('rebuild helper includes dependent composites even when their placement does not change', () => {
        const dragFont = makeVisibleAnchorCascadeFont();
        const currentFont = {
            fontModel: dragFont,
            syncJsonFromModel: jest.fn(),
            requestRecompileWithoutDataChange: jest.fn()
        };

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);

        setupCanvasForDrawing(canvas, dragFont, 'A', 'A0');
        canvas.outlineEditor.drawingData.shapes = [
            makeRectPath(0, 0, 520, 700)
        ];

        const affectedGlyphNames =
            canvas.outlineEditor.rebuildAutomaticCompositesForCurrentEditedGlyph();

        expect(Array.from(affectedGlyphNames)).toEqual([
            'A',
            'visibleComposite',
            'hiddenComposite'
        ]);
    });

    test('findGlyphsUsingComponent returns the full recursive dependent closure', () => {
        const font = makeRecursiveDependencyFont();

        expect(font.findDirectGlyphsUsingComponent('source')).toEqual([
            'directDependent'
        ]);
        expect(new Set(font.findGlyphsUsingComponent('source'))).toEqual(
            new Set(['directDependent', 'nestedDependent'])
        );
    });

    test('rebuild helper includes nested transitive dependents whose rendered outlines change', () => {
        const dragFont = makeNestedVisibleAnchorCascadeFont();
        const currentFont = {
            fontModel: dragFont,
            syncJsonFromModel: jest.fn(),
            requestRecompileWithoutDataChange: jest.fn()
        };

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);

        setupCanvasForDrawing(canvas, dragFont, 'A', 'A0');
        canvas.outlineEditor.drawingData.shapes = [
            makeRectPath(0, 0, 520, 700)
        ];

        const affectedGlyphNames =
            canvas.outlineEditor.rebuildAutomaticCompositesForCurrentEditedGlyph();

        expect(Array.from(affectedGlyphNames)).toEqual([
            'A',
            'visibleComposite',
            'nestedVisibleComposite'
        ]);
    });

    test('anchor drag mouseup avoids duplicate worker cache update or dependent sync', async () => {
        const dragFont = makeVisibleAnchorCascadeFont();
        const currentFont = {
            fontModel: dragFont,
            syncJsonFromModel: jest.fn(),
            requestRecompileWithoutDataChange: jest.fn()
        };

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);

        const refreshGlyphsAfterModelBatchSpy = jest
            .spyOn(fontManager, 'refreshGlyphsAfterModelBatch')
            .mockResolvedValue();
        const refreshWorkerCacheForReplayTargetsSpy = jest
            .spyOn(fontManager, 'refreshWorkerCacheForReplayTargets')
            .mockResolvedValue(true);
        const updateWorkerFontCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        let saveDrawingDataSpy;

        try {
            setupCanvasForDrawing(canvas, dragFont, 'A', 'A0');
            saveDrawingDataSpy = jest.spyOn(
                canvas.outlineEditor,
                'saveDrawingData'
            );
            fontManager.updateEditingSubsetSnapshot(['visibleComposite']);
            canvas.textRunEditor.glyphNameBuffer = ['visibleComposite'];
            const topAnchor = canvas.outlineEditor.drawingData.anchors.find(
                (anchor) => anchor.name === 'top'
            );
            topAnchor.x = 320;

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.isDraggingAnchor = true;
            canvas.outlineEditor._dragType = 'anchor';
            canvas.outlineEditor._hasMoved = true;
            canvas.outlineEditor.glyphCanvas.updatePropertyPanel = jest.fn();
            canvas.outlineEditor.onMouseUp({});
            await new Promise((resolve) => setTimeout(resolve, 0));

            // Post-commit overview refresh is now handled by the committed-change
            // funnel (onCommittedChange → handleCommittedChangeRefresh), so the
            // old separate downstream-sync calls are no longer issued from mouseup.
            expect(currentFont.syncJsonFromModel).not.toHaveBeenCalled();
            expect(
                currentFont.requestRecompileWithoutDataChange
            ).not.toHaveBeenCalled();
            expect(saveDrawingDataSpy).toHaveBeenCalledWith(
                'mouse-drag-anchor'
            );
            expect(refreshGlyphsAfterModelBatchSpy).not.toHaveBeenCalled();
            expect(
                refreshWorkerCacheForReplayTargetsSpy
            ).not.toHaveBeenCalled();
            expect(updateWorkerFontCacheSpy).not.toHaveBeenCalled();
        } finally {
            refreshGlyphsAfterModelBatchSpy.mockRestore();
            refreshWorkerCacheForReplayTargetsSpy.mockRestore();
            updateWorkerFontCacheSpy.mockRestore();
            saveDrawingDataSpy?.mockRestore();
            fontManager.updateEditingSubsetSnapshot([]);
        }
    });

    test('anchor-inclusive resize mouseup avoids duplicate worker cache update or dependent sync', async () => {
        const dragFont = makeVisibleAnchorCascadeFont();
        const currentFont = {
            fontModel: dragFont,
            syncJsonFromModel: jest.fn(),
            requestRecompileWithoutDataChange: jest.fn()
        };

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);

        const refreshGlyphsAfterModelBatchSpy = jest
            .spyOn(fontManager, 'refreshGlyphsAfterModelBatch')
            .mockResolvedValue();
        const refreshWorkerCacheForReplayTargetsSpy = jest
            .spyOn(fontManager, 'refreshWorkerCacheForReplayTargets')
            .mockResolvedValue(true);
        const updateWorkerFontCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        let saveDrawingDataSpy;

        try {
            setupCanvasForDrawing(canvas, dragFont, 'A', 'A0');
            saveDrawingDataSpy = jest.spyOn(
                canvas.outlineEditor,
                'saveDrawingData'
            );
            const topAnchor = canvas.outlineEditor.drawingData.anchors.find(
                (anchor) => anchor.name === 'top'
            );
            topAnchor.x = 320;

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.isResizingSelection = true;
            canvas.outlineEditor._dragType = 'transform';
            canvas.outlineEditor.selectionResizeSnapshot = {
                points: [],
                anchors: [
                    {
                        anchorIndex: 0,
                        startX: 300,
                        startY: 700,
                        name: 'top'
                    }
                ],
                components: [],
                bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
                includesGeometry: false,
                includesAnchors: true,
                centered: false
            };
            canvas.outlineEditor._hasMoved = true;
            canvas.outlineEditor.glyphCanvas.updatePropertyPanel = jest.fn();
            canvas.outlineEditor.onMouseUp({});
            await new Promise((resolve) => setTimeout(resolve, 0));

            // Post-commit overview refresh is now handled by the committed-change
            // funnel, so the old separate downstream-sync calls are not issued.
            expect(saveDrawingDataSpy).toHaveBeenCalledWith(
                'mouse-drag-anchor'
            );
            expect(refreshGlyphsAfterModelBatchSpy).not.toHaveBeenCalled();
            expect(
                refreshWorkerCacheForReplayTargetsSpy
            ).not.toHaveBeenCalled();
            expect(updateWorkerFontCacheSpy).not.toHaveBeenCalled();
        } finally {
            refreshGlyphsAfterModelBatchSpy.mockRestore();
            refreshWorkerCacheForReplayTargetsSpy.mockRestore();
            updateWorkerFontCacheSpy.mockRestore();
            saveDrawingDataSpy?.mockRestore();
        }
    });
});

function makeConvertStation(id, name) {
    return {
        id,
        name: { en: name },
        location: {},
        guides: [],
        metrics: {},
        kerning: {},
        custom_ot_values: {},
        format_specific: {}
    };
}

function componentTranslations(drawing) {
    return drawing.components.map((component) => [
        component.transform.translation[0],
        component.transform.translation[1]
    ]);
}

describe('Convert matching manual components to automatic', () => {
    test('summarizes converted composites for the system notification', () => {
        const {
            formatConvertToCounterpunchSummary
        } = require('../../js/convert-to-counterpunch-dialog.ts');

        expect(
            formatConvertToCounterpunchSummary({
                convertedCount: 12,
                compositeCount: 48
            })
        ).toBe('Converted 12 of 48 composite glyphs to automatic.');
        expect(
            formatConvertToCounterpunchSummary({
                renamedCount: 34,
                convertedCount: 1,
                compositeCount: 1,
                replacedFeatureCount: 5
            })
        ).toBe(
            'Renamed 34 glyphs. Converted 1 of 1 composite glyph to automatic. Replaced 5 automatic features.'
        );
    });

    test('converts a glyph only when every component attaches and positions match', () => {
        const { glyphDataIndex } = require('../../js/glyph-data.ts');
        glyphDataIndex.resetForTests();

        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            instances: [],
            masters: [makeStation()],
            glyphs: [
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'A0',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [makeRectPath(50, 0, 450, 700)],
                            anchors: [{ name: 'top', x: 250, y: 700 }],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'B',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'B0',
                            width: 300,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [makeRectPath(20, 0, 280, 650)],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'acutecomb',
                    category: 'Mark',
                    exported: true,
                    layers: [
                        {
                            id: 'AC0',
                            width: 180,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [makeRectPath(-40, 680, 40, 780)],
                            anchors: [{ name: '_top', x: 0, y: 720 }],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'Aacute',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'AA0',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [
                                makeComponent('A', { auto: false }),
                                makeComponent('acutecomb', {
                                    auto: false,
                                    x: 250,
                                    y: -20
                                })
                            ],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'AacuteManual',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'AAM0',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [
                                makeComponent('A', { auto: false }),
                                makeComponent('acutecomb', {
                                    auto: false,
                                    x: 10,
                                    y: 40
                                })
                            ],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'AB',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'AB0',
                            width: 800,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [
                                makeComponent('A', { auto: false }),
                                makeComponent('B', {
                                    auto: false,
                                    x: 500,
                                    y: 0
                                })
                            ],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                }
            ],
            names: { family_name: { en: 'Convert To Counterpunch' } },
            note: '',
            date: '2026-08-19',
            features: { classes: {}, prefixes: {}, features: [] },
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const matchingBefore = componentTranslations(
            font.findGlyph('Aacute').drawings[0]
        );
        const mismatchedBefore = componentTranslations(
            font.findGlyph('AacuteManual').drawings[0]
        );
        const stackedBefore = componentTranslations(
            font.findGlyph('AB').drawings[0]
        );

        const converted = font.convertMatchingManualComponentsToAutomatic();

        expect([...converted.convertedGlyphNames]).toEqual(['Aacute']);
        expect(converted.compositeGlyphCount).toBe(3);
        expect(
            font.findGlyph('Aacute').drawings[0].isAutomaticAlignedDrawing()
        ).toBe(true);
        expect(
            componentTranslations(font.findGlyph('Aacute').drawings[0])
        ).toEqual(matchingBefore);

        expect(
            font
                .findGlyph('AacuteManual')
                .drawings[0].isAutomaticAlignedDrawing()
        ).toBe(false);
        expect(
            componentTranslations(font.findGlyph('AacuteManual').drawings[0])
        ).toEqual(mismatchedBefore);

        expect(
            font.findGlyph('AB').drawings[0].isAutomaticAlignedDrawing()
        ).toBe(false);
        expect(componentTranslations(font.findGlyph('AB').drawings[0])).toEqual(
            stackedBefore
        );
    });

    test('refuses conversion unless every layer of the glyph matches', () => {
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            instances: [],
            masters: [
                makeConvertStation('M0', 'Regular'),
                makeConvertStation('M1', 'Bold')
            ],
            glyphs: [
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'A0',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [makeRectPath(50, 0, 450, 700)],
                            anchors: [{ name: 'top', x: 250, y: 700 }],
                            guides: [],
                            format_specific: {}
                        },
                        {
                            id: 'A1',
                            width: 540,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M1'
                            },
                            shapes: [makeRectPath(40, 0, 500, 720)],
                            anchors: [{ name: 'top', x: 280, y: 720 }],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'acutecomb',
                    category: 'Mark',
                    exported: true,
                    layers: [
                        {
                            id: 'AC0',
                            width: 180,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [makeRectPath(-40, 680, 40, 780)],
                            anchors: [{ name: '_top', x: 0, y: 720 }],
                            guides: [],
                            format_specific: {}
                        },
                        {
                            id: 'AC1',
                            width: 200,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M1'
                            },
                            shapes: [makeRectPath(-50, 700, 50, 820)],
                            anchors: [{ name: '_top', x: 0, y: 740 }],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'Aacute',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'AA0',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [
                                makeComponent('A', { auto: false }),
                                makeComponent('acutecomb', {
                                    auto: false,
                                    x: 250,
                                    y: -20
                                })
                            ],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        },
                        {
                            id: 'AA1',
                            width: 540,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M1'
                            },
                            shapes: [
                                makeComponent('A', { auto: false }),
                                makeComponent('acutecomb', {
                                    auto: false,
                                    x: 0,
                                    y: 0
                                })
                            ],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                }
            ],
            names: { family_name: { en: 'Convert Layers' } },
            note: '',
            date: '2026-08-19',
            features: { classes: {}, prefixes: {}, features: [] },
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const regularBefore = componentTranslations(
            font.findGlyph('Aacute').drawings[0]
        );
        const boldBefore = componentTranslations(
            font.findGlyph('Aacute').drawings[1]
        );

        const converted = font.convertMatchingManualComponentsToAutomatic();

        expect(converted.convertedGlyphNames.size).toBe(0);
        expect(converted.compositeGlyphCount).toBe(1);
        expect(
            font.findGlyph('Aacute').drawings[0].isAutomaticAlignedDrawing()
        ).toBe(false);
        expect(
            font.findGlyph('Aacute').drawings[1].isAutomaticAlignedDrawing()
        ).toBe(false);
        expect(
            componentTranslations(font.findGlyph('Aacute').drawings[0])
        ).toEqual(regularBefore);
        expect(
            componentTranslations(font.findGlyph('Aacute').drawings[1])
        ).toEqual(boldBefore);
    });

    test('converts a single non-mark component and skips a single mark component', () => {
        const { glyphDataIndex } = require('../../js/glyph-data.ts');
        glyphDataIndex.resetForTests();
        glyphDataIndex.loadRecordsForTests([
            {
                codepoint: 0x41,
                glyph_name: 'A',
                name: 'LATIN CAPITAL LETTER A',
                general_category: 'Lu',
                script: 'Latn'
            },
            {
                codepoint: 0x2e,
                glyph_name: 'period',
                name: 'FULL STOP',
                general_category: 'Po',
                script: 'Zyyy'
            },
            {
                codepoint: 0x301,
                glyph_name: 'acutecomb',
                name: 'COMBINING ACUTE ACCENT',
                general_category: 'Mn',
                script: 'Zinh'
            }
        ]);

        try {
            const font = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                instances: [],
                masters: [makeStation()],
                glyphs: [
                    {
                        name: 'A',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'A0',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'M0'
                                },
                                shapes: [makeRectPath(50, 0, 450, 700)],
                                anchors: [],
                                guides: [],
                                format_specific: {}
                            }
                        ],
                        format_specific: {}
                    },
                    {
                        name: 'period',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'P0',
                                width: 200,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'M0'
                                },
                                shapes: [makeRectPath(60, 0, 140, 120)],
                                anchors: [],
                                guides: [],
                                format_specific: {}
                            }
                        ],
                        format_specific: {}
                    },
                    {
                        name: 'acutecomb',
                        category: 'Mark',
                        exported: true,
                        layers: [
                            {
                                id: 'AC0',
                                width: 180,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'M0'
                                },
                                shapes: [makeRectPath(-40, 680, 40, 780)],
                                anchors: [{ name: '_top', x: 0, y: 720 }],
                                guides: [],
                                format_specific: {}
                            }
                        ],
                        format_specific: {}
                    },
                    {
                        name: 'A.ss01',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'ASS0',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'M0'
                                },
                                shapes: [makeComponent('A', { auto: false })],
                                anchors: [],
                                guides: [],
                                format_specific: {}
                            }
                        ],
                        format_specific: {}
                    },
                    {
                        name: 'period.ss01',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'PSS0',
                                width: 200,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'M0'
                                },
                                shapes: [
                                    makeComponent('period', { auto: false })
                                ],
                                anchors: [],
                                guides: [],
                                format_specific: {}
                            }
                        ],
                        format_specific: {}
                    },
                    {
                        name: 'acutecomb.case',
                        category: 'Mark',
                        exported: true,
                        layers: [
                            {
                                id: 'ACC0',
                                width: 180,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'M0'
                                },
                                shapes: [
                                    makeComponent('acutecomb', {
                                        auto: false,
                                        y: 80
                                    })
                                ],
                                anchors: [],
                                guides: [],
                                format_specific: {}
                            }
                        ],
                        format_specific: {}
                    }
                ],
                names: { family_name: { en: 'Standalone Non-Mark Convert' } },
                note: '',
                date: '2026-08-19',
                features: { classes: {}, prefixes: {}, features: [] },
                first_kern_groups: {},
                second_kern_groups: {},
                custom_ot_values: [],
                variation_sequences: [],
                format_specific: {}
            });

            const letterBefore = componentTranslations(
                font.findGlyph('A.ss01').drawings[0]
            );
            const punctuationBefore = componentTranslations(
                font.findGlyph('period.ss01').drawings[0]
            );
            const markBefore = componentTranslations(
                font.findGlyph('acutecomb.case').drawings[0]
            );

            const converted = font.convertMatchingManualComponentsToAutomatic();

            expect([...converted.convertedGlyphNames].sort()).toEqual([
                'A.ss01',
                'period.ss01'
            ]);
            expect(converted.compositeGlyphCount).toBe(3);
            expect(
                font.findGlyph('A.ss01').drawings[0].isAutomaticAlignedDrawing()
            ).toBe(true);
            expect(
                componentTranslations(font.findGlyph('A.ss01').drawings[0])
            ).toEqual(letterBefore);
            expect(
                font
                    .findGlyph('period.ss01')
                    .drawings[0].isAutomaticAlignedDrawing()
            ).toBe(true);
            expect(
                componentTranslations(font.findGlyph('period.ss01').drawings[0])
            ).toEqual(punctuationBefore);
            expect(
                font
                    .findGlyph('acutecomb.case')
                    .drawings[0].isAutomaticAlignedDrawing()
            ).toBe(false);
            expect(
                componentTranslations(
                    font.findGlyph('acutecomb.case').drawings[0]
                )
            ).toEqual(markBefore);
        } finally {
            glyphDataIndex.resetForTests();
        }
    });

    test('does not convert a single component whose stored width would change', () => {
        const { glyphDataIndex } = require('../../js/glyph-data.ts');
        glyphDataIndex.resetForTests();
        glyphDataIndex.loadRecordsForTests([
            {
                codepoint: 0x31,
                glyph_name: 'one',
                name: 'DIGIT ONE',
                general_category: 'Nd',
                script: 'Zyyy'
            }
        ]);

        try {
            const font = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                instances: [],
                masters: [makeStation()],
                glyphs: [
                    {
                        name: 'one',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'ONE0',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'M0'
                                },
                                shapes: [makeRectPath(50, 0, 450, 700)],
                                anchors: [],
                                guides: [],
                                format_specific: {}
                            }
                        ],
                        format_specific: {}
                    },
                    {
                        name: 'one.tf',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'ONETF0',
                                width: 600,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'M0'
                                },
                                shapes: [makeComponent('one', { auto: false })],
                                anchors: [],
                                guides: [],
                                format_specific: {}
                            }
                        ],
                        format_specific: {}
                    }
                ],
                names: { family_name: { en: 'Tabular Figure Convert' } },
                note: '',
                date: '2026-08-19',
                features: { classes: {}, prefixes: {}, features: [] },
                first_kern_groups: {},
                second_kern_groups: {},
                custom_ot_values: [],
                variation_sequences: [],
                format_specific: {}
            });

            const drawing = font.findGlyph('one.tf').drawings[0];
            const before = componentTranslations(drawing);
            expect(drawing.width).toBe(600);

            const converted = font.convertMatchingManualComponentsToAutomatic();

            expect([...converted.convertedGlyphNames]).toEqual([]);
            expect(converted.compositeGlyphCount).toBe(1);
            expect(drawing.isAutomaticAlignedDrawing()).toBe(false);
            expect(drawing.width).toBe(600);
            expect(componentTranslations(drawing)).toEqual(before);
        } finally {
            glyphDataIndex.resetForTests();
        }
    });
});

function makeFustatOslashAcuteFont() {
    // Fustat Regular (master 3114FB65-9464-41A5-B67E-A8F9F43C0EF1):
    // o.top = (285, 492), acutecomb._top = (47, 492), oslashacute acutecomb
    // translation = (238, 0), width = 570. oslash has a slash path plus
    // component o and stores no anchors of its own.
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [makeStation()],
        glyphs: [
            {
                name: 'o',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'O0',
                        width: 570,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(40, 0, 530, 492)],
                        anchors: [
                            { name: 'bottom', x: 285, y: 0 },
                            { name: 'center', x: 285, y: 246 },
                            { name: 'ogonek', x: 348, y: 0 },
                            { name: 'top', x: 285, y: 492 },
                            { name: 'topright', x: 550, y: 492 }
                        ],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'oslash',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'OS0',
                        width: 570,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeRectPath(77, -42, 496, 541),
                            makeComponent('o', { auto: false })
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'acutecomb',
                category: 'Mark',
                exported: true,
                layers: [
                    {
                        id: 'AC0',
                        width: 166,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(0, 492, 90, 722)],
                        anchors: [
                            { name: '_top', x: 47, y: 492 },
                            { name: 'top', x: 83, y: 722 }
                        ],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'oslashacute',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'OSA0',
                        width: 570,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('oslash', { auto: false }),
                            makeComponent('acutecomb', {
                                auto: false,
                                x: 238,
                                y: 0
                            })
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            }
        ],
        names: { family_name: { en: 'Fustat Oslashacute' } },
        note: '',
        date: '2026-08-19',
        features: { classes: {}, prefixes: {}, features: [] },
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

describe('Recursive computed anchors', () => {
    test('computes nested anchors and converts Fustat oslashacute', () => {
        const font = makeFustatOslashAcuteFont();
        const oslash = font.findGlyph('oslash');
        const oslashDrawing = oslash.drawings[0];
        const oslashacute = font.findGlyph('oslashacute');
        const compositeDrawing = oslashacute.drawings[0];

        expect(oslashDrawing.anchors).toEqual([]);
        expect(oslashDrawing.computedAnchors()).toEqual({
            bottom: { x: 285, y: 0 },
            center: { x: 285, y: 246 },
            ogonek: { x: 348, y: 0 },
            top: { x: 285, y: 492 },
            topright: { x: 550, y: 492 }
        });

        const before = componentTranslations(compositeDrawing);
        const converted = font.convertMatchingManualComponentsToAutomatic();

        expect(converted.convertedGlyphNames.has('oslashacute')).toBe(true);
        expect(compositeDrawing.isAutomaticAlignedDrawing()).toBe(true);
        expect(componentTranslations(compositeDrawing)).toEqual(before);
        expect(compositeDrawing.width).toBe(570);
        expect(oslashDrawing.anchors).toEqual([]);

        expect(oslash.applyComputedAnchors(['top'])).toBe(true);
        expect(oslashDrawing.findAnchor('top')).toMatchObject({
            x: 285,
            y: 492
        });
        expect(oslashDrawing.findAnchor('bottom')).toBeUndefined();

        expect(oslash.applyComputedAnchors()).toBe(true);
        expect(oslashDrawing.findAnchor('bottom')).toMatchObject({
            x: 285,
            y: 0
        });
    });

    test('does not inherit _top from a nested mark drawing such as Fustat dotbelow-ar', () => {
        // Fustat Regular: dotbelow-ar is a shifted dotabove-ar with its own
        // `_bottom`. beh-ar is behDotless-ar plus that below dot at (418, -96).
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            instances: [],
            masters: [makeStation()],
            glyphs: [
                {
                    name: 'behDotless-ar',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'BD0',
                            width: 881,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [makeRectPath(40, 0, 840, 338)],
                            anchors: [
                                { name: 'bottom', x: 443, y: -96 },
                                { name: 'ring', x: 443, y: 28 },
                                { name: 'top', x: 443, y: 338 }
                            ],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'dotabove-ar',
                    category: 'Mark',
                    exported: true,
                    layers: [
                        {
                            id: 'DA0',
                            width: 50,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [makeRectPath(0, 428, 50, 528)],
                            anchors: [
                                { name: '_top', x: 25, y: 428 },
                                { name: 'top', x: 25, y: 528 }
                            ],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'dotbelow-ar',
                    category: 'Mark',
                    exported: true,
                    layers: [
                        {
                            id: 'DB0',
                            width: 50,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [
                                makeComponent('dotabove-ar', {
                                    x: 0,
                                    y: -478
                                })
                            ],
                            anchors: [
                                { name: '_bottom', x: 25, y: 0 },
                                { name: 'bottom', x: 25, y: -100 }
                            ],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'beh-ar',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'BEH0',
                            width: 881,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [
                                makeComponent('behDotless-ar'),
                                makeComponent('dotbelow-ar', {
                                    x: 418,
                                    y: -96
                                })
                            ],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                }
            ],
            names: { family_name: { en: 'Fustat Beh-ar' } },
            note: '',
            date: '2026-08-19',
            features: { classes: {}, prefixes: {}, features: [] },
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const dotbelowDrawing = font.findGlyph('dotbelow-ar').drawings[0];
        expect(dotbelowDrawing.computedAnchors()).toEqual({});

        const drawing = font.findGlyph('beh-ar').drawings[0];
        expect(drawing.computedAnchors().top).toEqual({ x: 443, y: 338 });
        expect(drawing.computedAnchors()._top).toBeUndefined();

        const before = componentTranslations(drawing);
        drawing.rebuildAutomaticComposition();
        expect(componentTranslations(drawing)).toEqual(before);
        expect(drawing.components[1].toAffineArray()[4]).toBeCloseTo(418, 5);
        expect(drawing.components[1].toAffineArray()[5]).toBeCloseTo(-96, 5);
    });
});

describe('Add component enables automatic composition', () => {
    function makeAddComponentFont() {
        return makeAutomaticCompositionFont();
    }

    test('adds a letter component to an empty layer as automatic', () => {
        const { glyphDataIndex } = require('../../js/glyph-data.ts');
        glyphDataIndex.resetForTests();
        glyphDataIndex.loadRecordsForTests([
            {
                codepoint: 0x41,
                glyph_name: 'A',
                name: 'LATIN CAPITAL LETTER A',
                general_category: 'Lu',
                script: 'Latn'
            }
        ]);

        try {
            const font = makeAddComponentFont();
            const drawing = font.addGlyph('empty').drawings[0];
            const component = drawing.addComponent('A');

            expect(drawing.isAutomaticAlignedDrawing()).toBe(true);
            expect(component.automaticAlignment).toBe(true);
            expect(drawing.width).toBeCloseTo(500, 5);
        } finally {
            glyphDataIndex.resetForTests();
        }
    });

    test('does not auto-align a component added beside paths', () => {
        const font = makeAutomaticCompositionFont();
        const drawing = font.findGlyph('A').drawings[0];
        const component = drawing.addComponent('B');

        expect(drawing.isAutomaticAlignedDrawing()).toBe(false);
        expect(component.automaticAlignment).toBe(false);
        expect(drawing.paths.length).toBeGreaterThan(0);
    });

    test('auto-aligns a mark added onto a letter component', () => {
        const { glyphDataIndex } = require('../../js/glyph-data.ts');
        glyphDataIndex.resetForTests();
        glyphDataIndex.loadRecordsForTests([
            {
                codepoint: 0x41,
                glyph_name: 'A',
                name: 'LATIN CAPITAL LETTER A',
                general_category: 'Lu',
                script: 'Latn'
            }
        ]);

        try {
            const font = makeAddComponentFont();
            const drawing = font.addGlyph('empty').drawings[0];
            drawing.addComponent('A');
            drawing.addComponent('acutecomb');

            expect(drawing.isAutomaticAlignedDrawing()).toBe(true);
            expect(drawing.components[1].toAffineArray()[4]).toBeCloseTo(
                250,
                5
            );
            expect(drawing.components[1].toAffineArray()[5]).toBeCloseTo(
                -20,
                5
            );
            expect(drawing.width).toBeCloseTo(500, 5);
        } finally {
            glyphDataIndex.resetForTests();
        }
    });

    test('does not auto-align a single mark component', () => {
        const font = makeAddComponentFont();
        const drawing = font.addGlyph('empty').drawings[0];
        const component = drawing.addComponent('acutecomb');

        expect(drawing.isAutomaticAlignedDrawing()).toBe(false);
        expect(component.automaticAlignment).toBe(false);
    });

    test('keeps both letters automatic when adding a second ligature component', () => {
        const { glyphDataIndex } = require('../../js/glyph-data.ts');
        glyphDataIndex.resetForTests();
        glyphDataIndex.loadRecordsForTests([
            {
                codepoint: 0x41,
                glyph_name: 'A',
                name: 'LATIN CAPITAL LETTER A',
                general_category: 'Lu',
                script: 'Latn'
            },
            {
                codepoint: 0x42,
                glyph_name: 'B',
                name: 'LATIN CAPITAL LETTER B',
                general_category: 'Lu',
                script: 'Latn'
            }
        ]);

        try {
            const font = makeAddComponentFont();
            const drawing = font.addGlyph('AB.liga').drawings[0];
            drawing.addComponent('A');
            drawing.addComponent('B');

            expect(drawing.isAutomaticAlignedDrawing()).toBe(true);
            expect(
                drawing.components.every(
                    (component) => component.automaticAlignment
                )
            ).toBe(true);
            expect(drawing.components[0].toAffineArray()[4]).toBeCloseTo(0, 5);
            expect(drawing.components[1].toAffineArray()[4]).toBeCloseTo(
                500,
                5
            );
            expect(drawing.width).toBeCloseTo(800, 5);
        } finally {
            glyphDataIndex.resetForTests();
        }
    });
});

function loadLatinABGlyphData() {
    const { glyphDataIndex } = require('../../js/glyph-data.ts');
    glyphDataIndex.resetForTests();
    glyphDataIndex.loadRecordsForTests([
        {
            codepoint: 0x41,
            glyph_name: 'A',
            name: 'LATIN CAPITAL LETTER A',
            general_category: 'Lu',
            script: 'Latn'
        },
        {
            codepoint: 0x42,
            glyph_name: 'B',
            name: 'LATIN CAPITAL LETTER B',
            general_category: 'Lu',
            script: 'Latn'
        }
    ]);
    return glyphDataIndex;
}

describe('Ligature kerning in automatic composition', () => {
    const {
        setKerningPairValueOnStation
    } = require('../../js/kerning-utils.ts');
    const {
        applyKerningGroupMembership
    } = require('../../js/glyph-canvas/kerning-group-widget.ts');

    test('places the second unattached base using glyph-pair kerning', () => {
        const font = makeAutomaticCompositionFont();
        const drawing = font.findGlyph('AB').drawings[0];
        drawing.rebuildAutomaticComposition();
        expect(drawing.components[1].toAffineArray()[4]).toBeCloseTo(500, 5);

        setKerningPairValueOnStation(font.stations[0], 'A', 'B', -50);

        expect(drawing.components[1].toAffineArray()[4]).toBeCloseTo(450, 5);
        expect(drawing.width).toBeCloseTo(750, 5);
    });

    test('prefers a non-zero glyph pair over a group pair', () => {
        const font = makeAutomaticCompositionFont();
        applyKerningGroupMembership(font, 'first', ['A'], 'ALeft', true);
        applyKerningGroupMembership(font, 'second', ['B'], 'BRight', true);
        setKerningPairValueOnStation(
            font.stations[0],
            '@ALeft',
            '@BRight',
            -50
        );
        setKerningPairValueOnStation(font.stations[0], 'A', 'B', -20);

        const drawing = font.findGlyph('AB').drawings[0];
        expect(drawing.components[1].toAffineArray()[4]).toBeCloseTo(480, 5);
        expect(drawing.width).toBeCloseTo(780, 5);
    });

    test('uses the group pair when no non-zero glyph pair exists', () => {
        const font = makeAutomaticCompositionFont();
        applyKerningGroupMembership(font, 'first', ['A'], 'ALeft', true);
        applyKerningGroupMembership(font, 'second', ['B'], 'BRight', true);
        setKerningPairValueOnStation(
            font.stations[0],
            '@ALeft',
            '@BRight',
            -50
        );

        const drawing = font.findGlyph('AB').drawings[0];
        expect(drawing.components[1].toAffineArray()[4]).toBeCloseTo(450, 5);
        expect(drawing.width).toBeCloseTo(750, 5);
    });

    test('does not kern an attached mark or a chained #entry/#exit base', () => {
        const letterFont = makeAutomaticCompositionFont();
        const adieresis = letterFont.findGlyph('adieresis').drawings[0];
        adieresis.rebuildAutomaticComposition();
        const markX = adieresis.components[1].toAffineArray()[4];
        const markY = adieresis.components[1].toAffineArray()[5];
        setKerningPairValueOnStation(
            letterFont.stations[0],
            'A',
            'acutecomb',
            -80
        );
        expect(adieresis.components[1].toAffineArray()[4]).toBeCloseTo(
            markX,
            5
        );
        expect(adieresis.components[1].toAffineArray()[5]).toBeCloseTo(
            markY,
            5
        );

        const chainedFont = makeChainedBaseAutomaticFont();
        const chained = chainedFont.findGlyph('chainedWord').drawings[0];
        chained.rebuildAutomaticComposition();
        const middleX = chained.components[1].toAffineArray()[4];
        setKerningPairValueOnStation(
            chainedFont.stations[0],
            'leftBase',
            'middleBase',
            -80
        );
        expect(chained.components[1].toAffineArray()[4]).toBeCloseTo(
            middleX,
            5
        );
    });

    test('converts a kerned ligature only when stored positions already match', () => {
        const glyphDataIndex = loadLatinABGlyphData();
        try {
            const matching = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                instances: [],
                masters: [
                    {
                        ...makeStation(),
                        kerning: { A: { B: -50 } }
                    }
                ],
                glyphs: [
                    {
                        name: 'A',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'A0',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'M0'
                                },
                                shapes: [makeRectPath(50, 0, 450, 700)],
                                anchors: [],
                                guides: [],
                                format_specific: {}
                            }
                        ],
                        format_specific: {}
                    },
                    {
                        name: 'B',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'B0',
                                width: 300,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'M0'
                                },
                                shapes: [makeRectPath(20, 0, 280, 650)],
                                anchors: [],
                                guides: [],
                                format_specific: {}
                            }
                        ],
                        format_specific: {}
                    },
                    {
                        name: 'AB',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'AB0',
                                width: 750,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'M0'
                                },
                                shapes: [
                                    makeComponent('A', { auto: false }),
                                    makeComponent('B', {
                                        auto: false,
                                        x: 450,
                                        y: 0
                                    })
                                ],
                                anchors: [],
                                guides: [],
                                format_specific: {}
                            }
                        ],
                        format_specific: {}
                    }
                ],
                names: { family_name: { en: 'Kerned Ligature Convert' } },
                note: '',
                date: '2026-08-19',
                features: { classes: {}, prefixes: {}, features: [] },
                first_kern_groups: {},
                second_kern_groups: {},
                custom_ot_values: [],
                variation_sequences: [],
                format_specific: {}
            });

            const converted =
                matching.convertMatchingManualComponentsToAutomatic();
            expect([...converted.convertedGlyphNames]).toEqual(['AB']);
            expect(
                matching.findGlyph('AB').drawings[0].isAutomaticAlignedDrawing()
            ).toBe(true);

            const mismatched = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                instances: [],
                masters: [
                    {
                        ...makeStation(),
                        kerning: { A: { B: -50 } }
                    }
                ],
                glyphs: [
                    {
                        name: 'A',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'A0',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'M0'
                                },
                                shapes: [makeRectPath(50, 0, 450, 700)],
                                anchors: [],
                                guides: [],
                                format_specific: {}
                            }
                        ],
                        format_specific: {}
                    },
                    {
                        name: 'B',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'B0',
                                width: 300,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'M0'
                                },
                                shapes: [makeRectPath(20, 0, 280, 650)],
                                anchors: [],
                                guides: [],
                                format_specific: {}
                            }
                        ],
                        format_specific: {}
                    },
                    {
                        name: 'AB',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'AB0',
                                width: 800,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'M0'
                                },
                                shapes: [
                                    makeComponent('A', { auto: false }),
                                    makeComponent('B', {
                                        auto: false,
                                        x: 500,
                                        y: 0
                                    })
                                ],
                                anchors: [],
                                guides: [],
                                format_specific: {}
                            }
                        ],
                        format_specific: {}
                    }
                ],
                names: { family_name: { en: 'Unkerned Ligature Convert' } },
                note: '',
                date: '2026-08-19',
                features: { classes: {}, prefixes: {}, features: [] },
                first_kern_groups: {},
                second_kern_groups: {},
                custom_ot_values: [],
                variation_sequences: [],
                format_specific: {}
            });

            const refused =
                mismatched.convertMatchingManualComponentsToAutomatic();
            expect([...refused.convertedGlyphNames]).toEqual([]);
            expect(
                mismatched
                    .findGlyph('AB')
                    .drawings[0].isAutomaticAlignedDrawing()
            ).toBe(false);
        } finally {
            glyphDataIndex.resetForTests();
        }
    });
});
