// The fuzz's reading of compiled fonts: contour geometry from model nodes and
// from HarfBuzz paths, and the rules the comparison with the model applies.

const {
    modelContours,
    svgContours,
    compareContours,
    compareBinaryWithModel,
    confirmEditChanged,
    locationKey
} = require('./helpers/fuzz-binary-checks');

const rect = (x0, y0, x1, y1) => ({
    closed: true,
    nodes: [
        { x: x0, y: y0, nodetype: 'Line' },
        { x: x1, y: y0, nodetype: 'Line' },
        { x: x1, y: y1, nodetype: 'Line' },
        { x: x0, y: y1, nodetype: 'Line' }
    ]
});

describe('contours', () => {
    it('reads model and compiled contours, the compiled one reversed', () => {
        const model = modelContours([rect(80, 0, 140, 700)]);
        const compiled = svgContours('M80,700L140,700L140,0L80,0L80,700Z');
        expect(model).toEqual([
            { area: 42000, minX: 80, minY: 0, maxX: 140, maxY: 700 }
        ]);
        expect(compiled[0].area).toBe(-42000);
        expect(compareContours(model, compiled)).toEqual([]);
    });

    it('matches a cubic model curve to its quadratic compile', () => {
        // A quarter circle of radius 100, cubic, against two quadratics.
        const k = 55.228;
        const model = modelContours([
            {
                closed: true,
                nodes: [
                    { x: 0, y: 0, nodetype: 'Line' },
                    { x: 100, y: 0, nodetype: 'Line' },
                    { x: 100, y: k, nodetype: 'OffCurve' },
                    { x: k, y: 100, nodetype: 'OffCurve' },
                    { x: 0, y: 100, nodetype: 'Curve' }
                ]
            }
        ]);
        const compiled = svgContours('M0,100Q41,100 71,71Q100,41 100,0L0,0Z');
        // The cubic circle approximation is a hair larger than π/4 · 100².
        expect(Math.abs(model[0].area - 7854)).toBeLessThan(5);
        expect(compareContours(model, compiled)).toEqual([]);
    });

    it('notices a moved point, a missing contour and a wrong direction', () => {
        const model = modelContours([
            rect(80, 0, 140, 700),
            rect(200, 0, 260, 500)
        ]);
        expect(
            compareContours(model, svgContours('M80,700L150,700L150,0L80,0Z'))
        ).toEqual(
            expect.arrayContaining([
                '1 contours, model has 2',
                expect.stringMatching(/^no contour like model \[80 0 140 700\]/)
            ])
        );
        // Same box, drawn the model's way round: not what a compile makes.
        expect(
            compareContours(
                modelContours([rect(80, 0, 140, 700)]),
                svgContours('M80,0L140,0L140,700L80,700Z')
            )
        ).toHaveLength(2);
    });
});

function rawFacts(overrides = {}) {
    const stations = [
        { id: 'M1', location: { wght: 100 }, metrics: {}, kerning: {} },
        { id: 'M2', location: { wght: 900 }, metrics: {}, kerning: {} }
    ];
    const glyph = (name, codepoint, category = 'Base', anchors = []) => ({
        name,
        productionName: null,
        category,
        codepoints: [codepoint],
        hasComponents: false,
        stations: Object.fromEntries(
            stations.map((station) => [
                station.id,
                {
                    location: station.location,
                    width: category === 'Mark' ? 0 : 500,
                    paths: [],
                    anchors
                }
            ])
        ),
        free: [],
        variations: []
    });
    const glyphs = [
        glyph('a', 0x61, 'Base', [{ name: 'top', x: 250, y: 500 }]),
        glyph('l', 0x6c),
        glyph('dotaccentcomb', 0x307, 'Mark', [{ name: '_top', x: 50, y: 500 }])
    ];
    const row = [
        ['', 500],
        ['', 500],
        ['', 500],
        ['', 0]
    ];
    const outlines = Object.fromEntries(
        stations.map((station) => [locationKey(station.location), row])
    );
    return {
        model: {
            axes: [{ tag: 'wght', min: 100, default: 100, max: 900 }],
            stations,
            firstGroups: { L: ['l'] },
            secondGroups: { A: ['a'] },
            glyphs,
            features: [],
            languageSystems: '',
            designer: null,
            version: [1, 0],
            vendor: null,
            instances: [],
            ...overrides.model
        },
        binary: {
            glyphNames: ['.notdef', 'a', 'l', 'uni0307'],
            outlines,
            unicodes: [0x61, 0x6c, 0x307],
            cmap: { [0x61]: 1, [0x6c]: 2, [0x307]: 3 },
            gsubFeatures: [],
            gsubScripts: [],
            substitutions: {},
            variationSamples: {},
            marks: {},
            kerning: {},
            names: { 5: 'Version 1.000;fontc' },
            tables: {},
            ...overrides.binary
        }
    };
}

const defaults = { a: 'a', l: 'l', dotaccentcomb: 'uni0307' };
const kerningProblems = (stations, kerning) =>
    compareBinaryWithModel(
        rawFacts({
            model: {
                stations: stations.map((kerningMap, index) => ({
                    id: `M${index + 1}`,
                    location: { wght: index ? 900 : 100 },
                    metrics: {},
                    kerning: kerningMap
                }))
            },
            binary: { kerning }
        }),
        defaults
    ).problems.filter((problem) => problem.startsWith('kern'));

describe('compareBinaryWithModel', () => {
    it('resolves a glyph pair before group pairs', () => {
        expect(
            kerningProblems(
                [{ 'l:a': -30, '@L:a': -10, 'l:@A': -20 }, { 'l:a': 0 }],
                {
                    'l:a@wght=100': [2, -30],
                    'l:a@wght=900': [2, 0]
                }
            )
        ).toEqual([]);
        expect(
            kerningProblems([{ '@L:@A': -15, 'l:@A': -20 }, { 'a:a': 1 }], {
                'l:a@wght=100': [2, -15]
            })
        ).toEqual([
            expect.stringMatching(/^kern l a at M1: -15, model -20 \(l:@A\);/)
        ]);
    });

    it('resolves each station alone: a pair it lacks falls back to its group pairs', () => {
        // fontmake and fontc: an explicit 0 holds where it is defined only.
        expect(
            kerningProblems([{ 'l:a': 0, 'l:@A': -40 }, { 'l:@A': -50 }], {
                'l:a@wght=100': [2, 0],
                'l:a@wght=900': [2, -50]
            })
        ).toEqual([]);
    });

    it('swaps group sides for Arabic glyphs in right-to-left kerning', () => {
        // beh-ar is in an RTL pair: read from the right it kerns first with
        // its left group (BEH), not its right group (BEH_RIGHT).
        const arabic = (name, codepoint) => ({
            ...rawFacts().model.glyphs[1],
            name,
            codepoints: [codepoint]
        });
        const problems = (kerning) => {
            const raw = rawFacts({
                model: {
                    firstGroups: { BEH_RIGHT: ['beh-ar'], ALEF: ['alef-ar'] },
                    secondGroups: { BEH: ['beh-ar'] },
                    stations: [
                        {
                            id: 'M1',
                            location: { wght: 100 },
                            metrics: {},
                            kerning: {
                                'beh-ar:reh-ar': -5,
                                '@BEH:@ALEF': -30,
                                '@BEH_RIGHT:@ALEF': -20
                            },
                            rtlPairs: [
                                'beh-ar:reh-ar',
                                '@BEH:@ALEF',
                                '@BEH_RIGHT:@ALEF'
                            ]
                        },
                        {
                            id: 'M2',
                            location: { wght: 900 },
                            metrics: {},
                            kerning: {}
                        }
                    ]
                },
                binary: { kerning }
            });
            raw.model.glyphs.push(
                arabic('beh-ar', 0x628),
                arabic('alef-ar', 0x627)
            );
            raw.binary.glyphNames.push('uni0628', 'uni0627');
            return compareBinaryWithModel(raw, {
                ...defaults,
                'beh-ar': 'uni0628',
                'alef-ar': 'uni0627'
            }).problems.filter((problem) => problem.startsWith('kern'));
        };
        expect(problems({ 'beh-ar:alef-ar@wght=100': [4, -30] })).toEqual([]);
        expect(problems({ 'beh-ar:alef-ar@wght=100': [4, -20] })).toHaveLength(
            1
        );
    });

    it('leaves a station without any pair to the compiler', () => {
        expect(
            kerningProblems([{ 'l:a': -40 }, {}], {
                'l:a@wght=100': [2, -40],
                'l:a@wght=900': [2, -40]
            })
        ).toEqual([]);
    });

    it('wants a nonspacing mark without advance, whatever width its drawing has', () => {
        const check = (nonspacing, advance) => {
            const raw = rawFacts();
            const mark = raw.model.glyphs[2];
            mark.nonspacing = nonspacing;
            for (const drawing of Object.values(mark.stations))
                drawing.width = 300;
            for (const row of Object.values(raw.binary.outlines))
                row[3] = ['', advance];
            return compareBinaryWithModel(raw, defaults).problems.filter(
                (problem) =>
                    problem.startsWith('dotaccentcomb') &&
                    problem.includes('advance')
            );
        };
        expect(check(true, 0)).toEqual([]);
        expect(check(false, 300)).toEqual([]);
        expect(check(true, 300)).toHaveLength(2);
    });

    it('puts a mark at base anchor minus mark anchor, after the base', () => {
        const check = (dx, dy) =>
            compareBinaryWithModel(
                rawFacts({
                    binary: {
                        marks: { 'a+dotaccentcomb@wght=100': [1, 3, dx, dy] }
                    }
                }),
                defaults
            ).problems.filter((problem) => problem.includes('mark'));
        expect(check(250 - 50 - 500, 0)).toEqual([]);
        expect(check(0, 0)).toEqual([
            'a+dotaccentcomb@wght=100: mark at (0, 0), anchors put it at (-300, 0)'
        ]);
    });

    it('expects no mark positioning in Latin text when kerning brings latn and the font does not declare it', () => {
        const check = (languageSystems, dx, kerning = { 'a:l': -5 }) =>
            compareBinaryWithModel(
                rawFacts({
                    model: {
                        languageSystems,
                        stations: [
                            {
                                id: 'M1',
                                location: { wght: 100 },
                                metrics: {},
                                kerning
                            },
                            {
                                id: 'M2',
                                location: { wght: 900 },
                                metrics: {},
                                kerning: {}
                            }
                        ]
                    },
                    binary: {
                        marks: { 'a+dotaccentcomb@wght=100': [1, 3, dx, 0] }
                    }
                }),
                defaults
            ).problems.filter((problem) => problem.includes('mark'));
        expect(check('languagesystem DFLT dflt;', 0)).toEqual([]);
        expect(
            check('languagesystem DFLT dflt;\nlanguagesystem latn dflt;', -300)
        ).toEqual([]);
        expect(
            check('languagesystem DFLT dflt;\nlanguagesystem latn dflt;', 0)
        ).toHaveLength(1);
        // Kerning of Arabic glyphs only adds an `arab` record: Latin text
        // keeps the DFLT mark positioning.
        expect(
            check('languagesystem DFLT dflt;', -300, { 'beh-ar:alef-ar': -20 })
        ).toEqual([]);
        expect(
            check('languagesystem DFLT dflt;', 0, { 'beh-ar:alef-ar': -20 })
        ).toHaveLength(1);
        // A group pair at 0 everywhere is dropped: no `latn` record.
        expect(
            check('languagesystem DFLT dflt;', -300, { '@L:@A': 0 })
        ).toEqual([]);
        // A glyph pair at 0 is kept.
        expect(check('languagesystem DFLT dflt;', 0, { 'l:a': 0 })).toEqual([]);
    });

    it('names a glyph the compiled font lacks, and a stray codepoint', () => {
        const { problems } = compareBinaryWithModel(
            rawFacts({
                binary: {
                    glyphNames: ['.notdef', 'a', 'uni0307'],
                    unicodes: [0x61, 0x307, 0xe001]
                }
            }),
            defaults
        );
        expect(problems).toEqual(
            expect.arrayContaining([
                'glyph count 3, model exports 4',
                'l: not in the compiled font as “l”',
                'U+E001: in the compiled cmap, on no exported glyph'
            ])
        );
    });
});

describe('confirmEditChanged', () => {
    const digest = (glyphs) => ({
        glyphSet: 'a l',
        glyphs,
        marks: '',
        kerning: '',
        cmap: '',
        gdef: '',
        gsub: '',
        metrics: '',
        names: '',
        instances: '',
        variations: {}
    });
    const snapshot = { props: {}, kerning: {}, kerningRtl: {}, font: {} };

    it('wants an outline edit in the compiled outline', () => {
        const edit = {
            kind: 'outline',
            glyph: 'a',
            master: 'M1',
            shape: 0,
            node: 0,
            dx: 3,
            dy: 0
        };
        expect(
            confirmEditChanged(
                edit,
                digest({ a: '1' }),
                digest({ a: '2' }),
                snapshot,
                snapshot
            )
        ).toBeNull();
        expect(
            confirmEditChanged(
                edit,
                digest({ a: '1' }),
                digest({ a: '1' }),
                snapshot,
                snapshot
            )
        ).toBe(
            'the compiled font did not change: a’s outline or advance (a: 1)'
        );
    });

    it('wants a background drawing to change nothing', () => {
        const edit = {
            kind: 'background',
            glyph: 'a',
            master: 'M1',
            op: 'add',
            dx: 1,
            dy: 1
        };
        expect(
            confirmEditChanged(
                edit,
                digest({ a: '1' }),
                digest({ a: '1' }),
                snapshot,
                snapshot
            )
        ).toBeNull();
        expect(
            confirmEditChanged(
                edit,
                digest({ a: '1' }),
                digest({ a: '2' }),
                snapshot,
                snapshot
            )
        ).toBe('a background drawing changed the compiled font');
    });
});
