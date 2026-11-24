/**
 * Removing a station in the model follows the font worker’s background
 * rules: a background belongs to the drawing whose `background_layer_id`
 * names it and goes, moves or relinks with it. A worker batch the font
 * worker refuses leaves the model as it was and names the edit.
 */

const {
    Font,
    FORMER_FREE_DRAWING_KEY,
    planStationRemovalDrawings,
    StationEditRefusedError
} = require('../js/babelfont-model');
const fontManager = require('../js/font-manager').default;

const at = (station) => ({ type: 'DefaultForMaster', master: station });

function fontData(layers, extraStations = []) {
    return {
        upm: 1000,
        version: [1, 0],
        axes: [
            {
                name: { dflt: 'Weight' },
                tag: 'wght',
                min: 100,
                default: 400,
                max: 900
            }
        ],
        cross_axis_mappings: [],
        instances: [],
        masters: [
            {
                name: { dflt: 'Regular' },
                id: 'm1',
                location: { wght: 400 },
                guides: [],
                metrics: {},
                kerning: {}
            },
            {
                name: { dflt: 'Bold' },
                id: 'm2',
                location: { wght: 700 },
                guides: [],
                metrics: {},
                kerning: {}
            },
            ...extraStations
        ],
        glyphs: [{ name: 'A', category: 'Base', exported: true, layers }],
        note: '',
        date: new Date('2020-01-01T00:00:00.000Z'),
        names: {},
        features: { classes: {}, prefixes: {}, features: [] }
    };
}

function swapGlobals(font, bridge) {
    const previous = {
        fontModel: window.currentFontModel,
        bridge: window.patchSyncEngine,
        fontManager: window.fontManager
    };
    window.currentFontModel = font;
    window.fontManager = fontManager;
    window.patchSyncEngine = bridge;
    return () => {
        window.currentFontModel = previous.fontModel;
        window.patchSyncEngine = previous.bridge;
        window.fontManager = previous.fontManager;
    };
}

const regular = { width: 500, id: 'm1', master: at('m1'), shapes: [] };

describe('planStationRemovalDrawings', () => {
    test('a removed drawing takes its background, also a Glyphs “.bg” one', () => {
        const plan = planStationRemovalDrawings(
            'A',
            [
                regular,
                {
                    width: 600,
                    id: 'm2',
                    master: at('m2'),
                    background_layer_id: 'bg-webapp'
                },
                {
                    width: 600,
                    id: 'bg-webapp',
                    master: at('m2'),
                    is_background: true
                },
                {
                    width: 610,
                    id: 'brace',
                    master: { type: 'AssociatedWithMaster', master: 'm2' },
                    location: { wght: 550 },
                    background_layer_id: 'brace.bg'
                },
                {
                    width: 610,
                    id: 'brace.bg',
                    master: at(''),
                    is_background: true
                }
            ],
            ['m2']
        );
        expect(plan.replacements).toEqual([]);
        expect(plan.removeIds.sort()).toEqual(
            ['bg-webapp', 'brace', 'brace.bg', 'm2'].sort()
        );
    });

    test('a drawing going back to a free drawing takes its background along', () => {
        const plan = planStationRemovalDrawings(
            'A',
            [
                regular,
                {
                    width: 600,
                    id: 'm2',
                    master: at('m2'),
                    background_layer_id: 'm2-bg',
                    format_specific: {
                        [FORMER_FREE_DRAWING_KEY]: {
                            location: { wght: 650 }
                        }
                    }
                },
                {
                    width: 600,
                    id: 'm2-bg',
                    master: at('m2'),
                    is_background: true,
                    shapes: []
                }
            ],
            ['m2']
        );
        expect(plan.removeIds).toEqual([]);
        expect(plan.replacements).toEqual([
            {
                id: 'm2',
                layer: {
                    width: 600,
                    id: 'm2',
                    master: { type: 'FreeFloating' },
                    location: { wght: 650 },
                    background_layer_id: 'm2-bg'
                }
            },
            {
                id: 'm2-bg',
                layer: {
                    width: 600,
                    id: 'm2-bg',
                    master: { type: 'FreeFloating' },
                    location: { wght: 650 },
                    is_background: true,
                    shapes: []
                }
            }
        ]);
    });

    test('a restored drawing’s background linked to no removed station stays', () => {
        const plan = planStationRemovalDrawings(
            'A',
            [
                {
                    width: 600,
                    id: 'm2',
                    master: at('m2'),
                    background_layer_id: 'm2.bg',
                    format_specific: {
                        [FORMER_FREE_DRAWING_KEY]: {
                            location: { wght: 650 }
                        }
                    }
                },
                {
                    width: 600,
                    id: 'm2.bg',
                    master: at(''),
                    is_background: true
                }
            ],
            ['m2']
        );
        expect(plan.removeIds).toEqual([]);
        expect(plan.replacements.map(({ id }) => id)).toEqual(['m2']);
    });

    test('a background at the removed station whose drawing stays follows that drawing', () => {
        const plan = planStationRemovalDrawings(
            'A',
            [
                { ...regular, background_layer_id: 'shared-bg' },
                {
                    width: 500,
                    id: 'brace',
                    master: { type: 'AssociatedWithMaster', master: 'm1' },
                    location: { wght: 550 },
                    background_layer_id: 'brace-bg'
                },
                {
                    width: 500,
                    id: 'shared-bg',
                    master: at('m2'),
                    location: { wght: 700 },
                    is_background: true
                },
                {
                    width: 500,
                    id: 'brace-bg',
                    master: at('m2'),
                    is_background: true
                }
            ],
            ['m2']
        );
        expect(plan.removeIds).toEqual([]);
        expect(plan.replacements).toEqual([
            {
                id: 'shared-bg',
                layer: {
                    width: 500,
                    id: 'shared-bg',
                    master: at('m1'),
                    is_background: true
                }
            },
            {
                id: 'brace-bg',
                layer: {
                    width: 500,
                    id: 'brace-bg',
                    master: { type: 'AssociatedWithMaster', master: 'm1' },
                    location: { wght: 550 },
                    is_background: true
                }
            }
        ]);
    });

    test('a background at the removed station that no drawing owns goes with it', () => {
        const plan = planStationRemovalDrawings(
            'A',
            [
                regular,
                {
                    width: 500,
                    id: 'orphan',
                    master: at('m2'),
                    is_background: true
                },
                {
                    width: 500,
                    id: 'other-orphan',
                    master: at('m1'),
                    is_background: true
                }
            ],
            ['m2']
        );
        expect(plan).toEqual({ removeIds: ['orphan'], replacements: [] });
    });

    test('a background shared with a drawing that stays is kept', () => {
        const plan = planStationRemovalDrawings(
            'A',
            [
                { ...regular, background_layer_id: 'shared.bg' },
                {
                    width: 600,
                    id: 'm2',
                    master: at('m2'),
                    background_layer_id: 'shared.bg'
                },
                {
                    width: 600,
                    id: 'shared.bg',
                    master: at(''),
                    is_background: true
                }
            ],
            ['m2']
        );
        expect(plan).toEqual({ removeIds: ['m2'], replacements: [] });
    });

    test('drawings going back to different locations refuse their shared background', () => {
        const marked = (id, wght) => ({
            width: 600,
            id,
            master: at('m2'),
            background_layer_id: 'shared-bg',
            format_specific: {
                [FORMER_FREE_DRAWING_KEY]: { location: { wght } }
            }
        });
        expect(() =>
            planStationRemovalDrawings(
                'A',
                [
                    marked('a', 600),
                    marked('b', 650),
                    {
                        width: 600,
                        id: 'shared-bg',
                        master: at('m2'),
                        is_background: true
                    }
                ],
                ['m2']
            )
        ).toThrow(/go back to different locations/);
    });

    test('staying drawings at different locations refuse their shared background', () => {
        expect(() =>
            planStationRemovalDrawings(
                'A',
                [
                    { ...regular, background_layer_id: 'shared-bg' },
                    {
                        width: 500,
                        id: 'brace',
                        master: { type: 'AssociatedWithMaster', master: 'm1' },
                        location: { wght: 550 },
                        background_layer_id: 'shared-bg'
                    },
                    {
                        width: 500,
                        id: 'shared-bg',
                        master: at('m2'),
                        is_background: true
                    }
                ],
                ['m2']
            )
        ).toThrow(/sit at different locations/);
    });

    test('nothing is filled in for missing ids', () => {
        expect(() =>
            planStationRemovalDrawings(
                'A',
                [{ width: 500, master: at('m2') }],
                ['m2']
            )
        ).toThrow(/drawing id is not a non-empty string/);
        expect(() =>
            planStationRemovalDrawings(
                'A',
                [{ width: 500, master: at('m2'), is_background: true }],
                ['m2']
            )
        ).toThrow(/background drawing without an id/);
        expect(() =>
            planStationRemovalDrawings(
                'A',
                [
                    {
                        width: 500,
                        master: at('m1'),
                        background_layer_id: 'bg'
                    },
                    {
                        width: 500,
                        id: 'bg',
                        master: at('m2'),
                        is_background: true
                    }
                ],
                ['m2']
            )
        ).toThrow(/a drawing without an id that stays owns it/);
    });

    test('a rewritten record that may not be stored is refused, no width filled in', () => {
        // The background has lost its width: following its drawing must not
        // write it back without one, nor make one up.
        expect(() =>
            planStationRemovalDrawings(
                'A',
                [
                    { ...regular, background_layer_id: 'bg' },
                    {
                        id: 'bg',
                        master: at('m2'),
                        is_background: true
                    }
                ],
                ['m2']
            )
        ).toThrow(/drawing width is not a finite number/);
        expect(() =>
            planStationRemovalDrawings(
                'A',
                [
                    {
                        width: 500,
                        id: 'm2',
                        master: at('m2'),
                        background_layer_id: 'bg',
                        format_specific: {
                            [FORMER_FREE_DRAWING_KEY]: {
                                location: { wght: 600 }
                            }
                        }
                    },
                    {
                        id: 'bg',
                        master: at('m2'),
                        is_background: true
                    }
                ],
                ['m2']
            )
        ).toThrow(/drawing width is not a finite number/);
    });
});

describe('Font.removeStationsByIds without the worker', () => {
    function layersWithBackgrounds() {
        return [
            { ...regular, background_layer_id: 'm1-bg' },
            {
                width: 600,
                id: 'm2',
                master: at('m2'),
                background_layer_id: 'm2-bg',
                format_specific: {
                    'com.example.keep': 1,
                    [FORMER_FREE_DRAWING_KEY]: { location: { wght: 650 } }
                },
                shapes: []
            },
            {
                width: 600,
                id: 'm2-bg',
                master: at('m2'),
                is_background: true,
                shapes: []
            },
            {
                width: 500,
                id: 'm1-bg',
                master: at('m2'),
                is_background: true,
                shapes: []
            },
            {
                width: 500,
                id: 'orphan',
                master: at('m2'),
                is_background: true,
                shapes: []
            }
        ];
    }

    test('backgrounds move, follow or go with their drawings, in place and recorded', async () => {
        const font = Font.fromData(fontData(layersWithBackgrounds()));
        const operations = [];
        const recordingBridge = {
            recordChange: (path, prop, oldValue, newValue) =>
                operations.push({ op: 'set', path: [...path, prop] }),
            recordAdd: (path, value) =>
                operations.push({ op: 'add', path, value }),
            recordRemove: (path) => operations.push({ op: 'remove', path })
        };
        const restore = swapGlobals(null, recordingBridge);
        try {
            expect(await font.removeStationsByIds(['m2'])).toBe(true);
        } finally {
            restore();
        }
        expect(font.findStation('m2')).toBeUndefined();
        const layers = font.findGlyph('A').toJSON().layers;
        expect(layers.map((layer) => layer.id)).toEqual([
            'm1',
            'm2',
            'm2-bg',
            'm1-bg'
        ]);
        expect(layers[1]).toEqual({
            width: 600,
            id: 'm2',
            master: { type: 'FreeFloating' },
            location: { wght: 650 },
            background_layer_id: 'm2-bg',
            format_specific: { 'com.example.keep': 1 },
            shapes: []
        });
        expect(layers[2].master).toEqual({ type: 'FreeFloating' });
        expect(layers[2].location).toEqual({ wght: 650 });
        expect(layers[3].master).toEqual(at('m1'));
        expect(layers[3].location).toBeUndefined();

        const drawingOps = operations.filter(
            (operation) => operation.path[2] === 'layers'
        );
        // Each rewritten drawing is recorded as removed and added whole, so
        // the keys it drops are gone for undo, redo and collaborators too.
        for (const id of ['m2', 'm2-bg', 'm1-bg']) {
            expect(
                drawingOps
                    .filter((operation) => operation.path[3] === id)
                    .map((operation) => operation.op)
            ).toEqual(['remove', 'add']);
        }
        expect(
            drawingOps
                .filter((operation) => operation.path[3] === 'orphan')
                .map((operation) => operation.op)
        ).toEqual(['remove']);
    });

    test('a refused background leaves the font as it was', async () => {
        const layers = layersWithBackgrounds();
        // Two drawings that go back to different locations share m2-bg.
        layers.push({
            width: 600,
            id: 'm2-second',
            master: at('m2'),
            background_layer_id: 'm2-bg',
            format_specific: {
                [FORMER_FREE_DRAWING_KEY]: { location: { wght: 600 } }
            }
        });
        const font = Font.fromData(fontData(layers));
        const before = JSON.parse(JSON.stringify(font.toJSON()));
        const restore = swapGlobals(null, undefined);
        try {
            await expect(font.removeStationsByIds(['m2'])).rejects.toThrow(
                /go back to different locations/
            );
        } finally {
            restore();
        }
        expect(JSON.parse(JSON.stringify(font.toJSON()))).toEqual(before);
    });
});

describe('a station edit the font worker refuses', () => {
    function liveFont() {
        return Font.fromData(
            fontData([
                regular,
                { width: 600, id: 'm2', master: at('m2'), shapes: [] }
            ])
        );
    }

    async function expectRefused(font, spyName, run, pattern) {
        const before = JSON.parse(JSON.stringify(font.toJSON()));
        const spy = jest
            .spyOn(fontManager, spyName)
            .mockRejectedValue(
                new Error(
                    'Refusing to reinterpolate drawing A::m2: the font has no such drawing'
                )
            );
        const applyLocalGeneratedYjsUpdate = jest.fn();
        const restore = swapGlobals(font, { applyLocalGeneratedYjsUpdate });
        let caught = null;
        try {
            await run();
        } catch (error) {
            caught = error;
        } finally {
            restore();
            spy.mockRestore();
        }
        expect(caught).toBeInstanceOf(StationEditRefusedError);
        expect(caught.message).toMatch(pattern);
        expect(caught.message).toMatch(/so nothing was changed/);
        expect(caught.message).toMatch(/the font has no such drawing/);
        expect(caught.workerError).toBeInstanceOf(Error);
        expect(applyLocalGeneratedYjsUpdate).not.toHaveBeenCalled();
        expect(JSON.parse(JSON.stringify(font.toJSON()))).toEqual(before);
    }

    test('removing a station', async () => {
        const font = liveFont();
        await expectRefused(
            font,
            'buildWorkerRemoveStationsBatch',
            () => font.removeStationsByIds(['m2']),
            /^Couldn’t remove the station/
        );
        expect(font.findStation('m2')).toBeDefined();
    });

    test('reinterpolating a station’s drawings', async () => {
        const font = liveFont();
        await expectRefused(
            font,
            'buildWorkerReinterpolateStationDrawingsBatch',
            () => font.findStation('m2').reinterpolateDrawings(),
            /^Couldn’t reinterpolate the station’s drawings/
        );
    });

    test('adding a station outside the axes puts the axes back', async () => {
        const font = liveFont();
        await expectRefused(
            font,
            'buildWorkerAddStationWithInterpolatedDrawingsBatch',
            () =>
                font.addStation({
                    name: { dflt: 'Black' },
                    id: 'm3',
                    location: { wght: 1000 },
                    guides: [],
                    metrics: {},
                    kerning: {}
                }),
            /^Couldn’t add the station/
        );
        expect(font.toJSON().axes[0].max).toBe(900);
    });

    test('adding an axis with station copies', async () => {
        const font = liveFont();
        await expectRefused(
            font,
            'buildWorkerAddAxisWithStationCopiesBatch',
            () =>
                font.addAxisWithStationCopies({
                    axis: {
                        name: { dflt: 'Width' },
                        tag: 'wdth',
                        min: 75,
                        default: 100,
                        max: 100
                    },
                    copies: []
                }),
            /^Couldn’t add the axis/
        );
    });
});
