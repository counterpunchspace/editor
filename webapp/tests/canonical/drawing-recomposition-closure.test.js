/**
 * Cascading Layer Recomposition Closure — Canonical Tests
 *
 * Locks the lean recomposition engine:
 *
 *   - `recomposeTargets` receive model writes / Yjs layer snapshots
 *   - `invalidateTargets` are stamped only as workerReplayTargets
 *   - Manual composites keep stored width/translates when the base LSB changes
 *   - Automatic composites still recompose from base metrics / anchors
 *   - Anchor commits persist automatic dependents even after a no-op rebuild
 *     (orphan anchors do not mutate marks, but still snapshot autos for Yjs)
 *   - Metrics-key dependents still recompose on sidebearing and outline edits
 *   - Bridge finalizer infers edit kinds and writes only recompose targets
 */

const { Font, DecomposedAffineTransform } = require('../../js/babelfont-model');
const {
    computeDrawingRecompositionClosure,
    deriveEditKindsFromOperations,
    deriveEditKindsFromChangeLogEntries,
    shouldResettleDerivedDrawingsOnHistoryReplay,
    resolveDrawingSyncTargetsFromClosure
} = require('../../js/recomposition-closure');
const { PatchSyncEngine: ChangeBridge } = require('../../js/patch-sync-engine');
const {
    buildCascadingRecompositionOperations
} = require('../../js/change-bridge-init');

const GLYPHS_COMPONENT_ALIGNMENT_KEY = 'com.schriftgestalt.Glyphs.alignment';

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
        transform = {
            translation: [x, y],
            scale: [1, 1],
            rotation: 0,
            skew: [0, 0],
            tCenter: [0, 0],
            order: 'RestOfTheWorld'
        }
    } = options;
    return {
        reference,
        transform,
        format_specific: {
            [GLYPHS_COMPONENT_ALIGNMENT_KEY]: auto ? 1 : -1
        }
    };
}

function makeLeanRecompositionFont() {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [makeStation()],
        glyphs: [
            {
                name: 'a',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'a0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(50, 0, 450, 700)],
                        anchors: [
                            { name: 'top', x: 250, y: 700 },
                            { name: 'orphan', x: 10, y: 10 }
                        ],
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
                        id: 'dc0',
                        width: 200,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(20, 0, 180, 120)],
                        anchors: [{ name: '_top', x: 100, y: 0 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'adieresisManual',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'adm0',
                        width: 520,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('a', {
                                auto: false,
                                x: 10,
                                y: 0
                            }),
                            makeComponent('dieresiscomb', {
                                auto: false,
                                x: 40,
                                y: 720
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
                name: 'adieresisAuto',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'ada0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('a', { auto: true }),
                            makeComponent('dieresiscomb', { auto: true })
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'n',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'n0',
                        width: 480,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(40, 0, 440, 700)],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {
                    metric_left: '=a'
                }
            }
        ],
        names: { family_name: { en: 'Lean Recomposition Canonical' } },
        note: '',
        date: '2026-07-24',
        features: { classes: {}, prefixes: {}, features: [] },
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

function getComponentTranslation(drawing, index) {
    const shape = drawing.shapes[index];
    const component = shape.isComponent?.() ? shape.asComponent() : shape;
    const transform = component.transform;
    if (Array.isArray(transform)) {
        return { x: transform[4], y: transform[5] };
    }
    if (transform instanceof DecomposedAffineTransform) {
        return {
            x: transform.translation[0],
            y: transform.translation[1]
        };
    }
    return {
        x: transform?.translation?.[0] ?? 0,
        y: transform?.translation?.[1] ?? 0
    };
}

function makeMirroredSidebearingCascadeFont() {
    return new Font({
        upm: 1000,
        version: [1, 0],
        axes: [],
        masters: [makeStation()],
        instances: [],
        glyphs: [
            {
                name: 'source',
                layers: [
                    {
                        id: 'source0',
                        width: 500,
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [makeRectPath(100, 0, 400, 700)],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'mirrored',
                layers: [
                    {
                        id: 'mirrored0',
                        width: 500,
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [makeRectPath(80, 0, 400, 700)],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: { metric_right: '=|source' }
            },
            {
                name: 'downstream',
                layers: [
                    {
                        id: 'downstream0',
                        width: 500,
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [makeRectPath(70, 0, 400, 700)],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: { metric_right: '=mirrored' }
            }
        ],
        names: {},
        features: { classes: {}, prefixes: {}, features: [] },
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

describe('lean cascading layer recomposition', () => {
    const originalFontManager = window.fontManager;
    const originalCurrentFontModel = window.currentFontModel;

    afterEach(() => {
        window.fontManager = originalFontManager;
        window.currentFontModel = originalCurrentFontModel;
    });

    test('keeps =| sidebearings and downstream metrics keys identical during visible and settled recomposition', () => {
        const runClosure = (scope) => {
            const font = makeMirroredSidebearingCascadeFont();
            const sourceDrawing = font
                .findGlyph('source')
                .findDrawingById('source0');
            const mirroredDrawing = font
                .findGlyph('mirrored')
                .findDrawingById('mirrored0');
            const downstreamDrawing = font
                .findGlyph('downstream')
                .findDrawingById('downstream0');

            sourceDrawing.setDirectSidebearing('left', 140);
            const closure = computeDrawingRecompositionClosure({
                sourceTargets: [{ glyphName: 'source', layerId: 'source0' }],
                editKinds: new Set(['sidebearing']),
                scope,
                fontModel: font,
                activeDrawingId: 'source0',
                sourceGlyphName: 'source',
                visibleGlyphNames: new Set(['source', 'mirrored', 'downstream'])
            });

            return {
                sourceLeft: sourceDrawing.lsb,
                mirroredRight: mirroredDrawing.rsb,
                downstreamRight: downstreamDrawing.rsb,
                replayTargets: closure.allTargets.map(
                    ({ glyphName, layerId: drawingId }) =>
                        `${glyphName}@${drawingId}`
                ),
                recomposedTargets: closure.recomposeTargets.map(
                    ({ glyphName, layerId: drawingId }) =>
                        `${glyphName}@${drawingId}`
                )
            };
        };

        const live = runClosure('visible');
        const committed = runClosure('all');

        expect(live.sourceLeft).toBe(140);
        expect(live.mirroredRight).toBe(140);
        expect(live.downstreamRight).toBe(140);
        expect(live).toEqual(committed);
        expect(live.replayTargets).toEqual(
            expect.arrayContaining([
                'source@source0',
                'mirrored@mirrored0',
                'downstream@downstream0'
            ])
        );
        expect(live.recomposedTargets).toEqual(
            expect.arrayContaining([
                'mirrored@mirrored0',
                'downstream@downstream0'
            ])
        );
    });

    test('sidebearing edit invalidates manual composites but does not recompose them', () => {
        const font = makeLeanRecompositionFont();
        const manual = font
            .findGlyph('adieresisManual')
            .findDrawingById('adm0');
        const auto = font.findGlyph('adieresisAuto').findDrawingById('ada0');
        auto.rebuildAutomaticComposition();

        const manualWidthBefore = manual.width;
        const manualTranslateBefore = getComponentTranslation(manual, 0);
        const autoWidthBefore = auto.width;

        const aDrawing = font.findGlyph('a').findDrawingById('a0');
        aDrawing.setDirectSidebearing('left', aDrawing.lsb + 40);

        const closure = computeDrawingRecompositionClosure({
            sourceTargets: [{ glyphName: 'a', layerId: 'a0' }],
            editKinds: new Set(['sidebearing']),
            scope: 'all',
            fontModel: font,
            activeDrawingId: 'a0',
            sourceGlyphName: 'a'
        });

        expect([...closure.invalidateGlyphNames].sort()).toEqual(
            expect.arrayContaining(['adieresisManual', 'adieresisAuto'])
        );
        expect(closure.recomposeGlyphNames.has('adieresisManual')).toBe(false);
        expect(closure.recomposeGlyphNames.has('adieresisAuto')).toBe(true);
        expect(closure.recomposeGlyphNames.has('n')).toBe(true);

        expect(manual.width).toBe(manualWidthBefore);
        expect(getComponentTranslation(manual, 0)).toEqual(
            manualTranslateBefore
        );
        expect(auto.width).not.toBe(autoWidthBefore);

        const syncTargets = resolveDrawingSyncTargetsFromClosure(closure, [
            { glyphName: 'a', layerId: 'a0' }
        ]);
        expect(
            syncTargets.changedDrawingTargets.map((t) => t.glyphName).sort()
        ).toEqual(expect.arrayContaining(['a', 'adieresisAuto', 'n']));
        expect(
            syncTargets.changedDrawingTargets.some(
                (t) => t.glyphName === 'adieresisManual'
            )
        ).toBe(false);
        expect(
            syncTargets.workerReplayTargets.some(
                (t) => t.glyphName === 'adieresisManual'
            )
        ).toBe(true);
    });

    test('sidebearing metrics chains rebuild automatic composites from their final base width', () => {
        // Mixed dependency graph:
        // l RSB -> n RSB -> a RSB -> adieresis (automatic component edge).
        // The final edge must run after metrics-key propagation changes a.
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            instances: [],
            masters: [makeStation()],
            glyphs: [
                {
                    name: 'l',
                    layers: [
                        {
                            id: 'l0',
                            width: 400,
                            master: { type: 'DefaultForMaster', master: 'M0' },
                            shapes: [makeRectPath(40, 0, 360, 700)],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'n',
                    layers: [
                        {
                            id: 'n0',
                            width: 380,
                            master: { type: 'DefaultForMaster', master: 'M0' },
                            shapes: [makeRectPath(40, 0, 340, 700)],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: { metric_right: '=l-10' }
                },
                {
                    name: 'a',
                    layers: [
                        {
                            id: 'a0',
                            width: 500,
                            master: { type: 'DefaultForMaster', master: 'M0' },
                            shapes: [makeRectPath(50, 0, 450, 700)],
                            anchors: [{ name: 'top', x: 250, y: 700 }],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: { metric_right: '=n' }
                },
                {
                    name: 'dieresiscomb',
                    layers: [
                        {
                            id: 'dc0',
                            width: 200,
                            master: { type: 'DefaultForMaster', master: 'M0' },
                            shapes: [makeRectPath(20, 0, 180, 120)],
                            anchors: [{ name: '_top', x: 100, y: 0 }],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'adieresis',
                    layers: [
                        {
                            id: 'ad0',
                            width: 500,
                            master: { type: 'DefaultForMaster', master: 'M0' },
                            shapes: [
                                makeComponent('a'),
                                makeComponent('dieresiscomb')
                            ],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                }
            ],
            names: {},
            features: { classes: {}, prefixes: {}, features: [] },
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const lDrawing = font.findGlyph('l').findDrawingById('l0');
        const nDrawing = font.findGlyph('n').findDrawingById('n0');
        const aDrawing = font.findGlyph('a').findDrawingById('a0');
        const adieresisDrawing = font
            .findGlyph('adieresis')
            .findDrawingById('ad0');

        lDrawing.setDirectSidebearing('right', 100);

        const closure = computeDrawingRecompositionClosure({
            sourceTargets: [{ glyphName: 'l', layerId: 'l0' }],
            editKinds: new Set(['sidebearing']),
            scope: 'all',
            fontModel: font,
            activeDrawingId: 'l0',
            sourceGlyphName: 'l'
        });

        expect(nDrawing.rsb).toBe(90);
        expect(aDrawing.rsb).toBe(90);
        expect(adieresisDrawing.width).toBe(aDrawing.width);
        expect(adieresisDrawing.rsb).toBe(aDrawing.rsb);
        expect(closure.recomposeGlyphNames.has('n')).toBe(true);
        expect(closure.recomposeGlyphNames.has('a')).toBe(true);
        expect(closure.recomposeGlyphNames.has('adieresis')).toBe(true);

        // The live closure is the same mixed graph, merely restricted to the
        // visible text-run closure. It must reach the same fixed point.
        lDrawing.setDirectSidebearing('right', 110);
        const visibleClosure = computeDrawingRecompositionClosure({
            sourceTargets: [{ glyphName: 'l', layerId: 'l0' }],
            editKinds: new Set(['sidebearing']),
            scope: 'visible',
            fontModel: font,
            activeDrawingId: 'l0',
            sourceGlyphName: 'l',
            visibleGlyphNames: new Set(['l', 'n', 'a', 'adieresis'])
        });

        expect(nDrawing.rsb).toBe(100);
        expect(aDrawing.rsb).toBe(100);
        expect(adieresisDrawing.width).toBe(aDrawing.width);
        expect(adieresisDrawing.rsb).toBe(aDrawing.rsb);
        expect(visibleClosure.recomposeGlyphNames.has('adieresis')).toBe(true);

        // The all-scope settlement sees the already-converged visible model as
        // a no-op, but must still snapshot the exact layers the live closure
        // mutated or the worker will reshape from stale a/adieresis data.
        const settledClosure = computeDrawingRecompositionClosure({
            sourceTargets: [{ glyphName: 'l', layerId: 'l0' }],
            editKinds: new Set(['sidebearing']),
            scope: 'all',
            fontModel: font,
            activeDrawingId: 'l0',
            sourceGlyphName: 'l'
        });
        const settledTargets = resolveDrawingSyncTargetsFromClosure(
            settledClosure,
            [{ glyphName: 'l', layerId: 'l0' }],
            visibleClosure.recomposeTargets
        );

        expect(
            settledTargets.changedDrawingTargets.map(
                (target) => target.glyphName
            )
        ).toEqual(expect.arrayContaining(['n', 'a', 'adieresis']));
    });

    test('visible scope includes hidden metrics-key prerequisites', () => {
        // Text can visibly contain a.ss03 while its =n key references hidden
        // n, which in turn references the edited l. The live closure must
        // include n as a prerequisite or commit resolves a.ss03 differently.
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            instances: [],
            masters: [makeStation()],
            glyphs: [
                {
                    name: 'l',
                    layers: [
                        {
                            id: 'l0',
                            width: 400,
                            master: { type: 'DefaultForMaster', master: 'M0' },
                            shapes: [makeRectPath(40, 0, 360, 700)],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'n',
                    layers: [
                        {
                            id: 'n0',
                            width: 380,
                            master: { type: 'DefaultForMaster', master: 'M0' },
                            shapes: [makeRectPath(40, 0, 340, 700)],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: { metric_right: '=l-10' }
                },
                {
                    name: 'a.ss03',
                    layers: [
                        {
                            id: 'ss0',
                            width: 500,
                            master: { type: 'DefaultForMaster', master: 'M0' },
                            shapes: [makeRectPath(50, 0, 450, 700)],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: { metric_right: '=n' }
                }
            ],
            names: {},
            features: { classes: {}, prefixes: {}, features: [] },
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });
        const lDrawing = font.findGlyph('l').findDrawingById('l0');
        const nDrawing = font.findGlyph('n').findDrawingById('n0');
        const ssDrawing = font.findGlyph('a.ss03').findDrawingById('ss0');

        lDrawing.setDirectSidebearing('right', 100);
        const closure = computeDrawingRecompositionClosure({
            sourceTargets: [{ glyphName: 'l', layerId: 'l0' }],
            editKinds: new Set(['sidebearing']),
            scope: 'visible',
            fontModel: font,
            activeDrawingId: 'l0',
            sourceGlyphName: 'l',
            // n is intentionally omitted: it must be retained from a.ss03's
            // metrics-key prerequisite closure.
            visibleGlyphNames: new Set(['l', 'a.ss03'])
        });

        expect(nDrawing.rsb).toBe(90);
        expect(ssDrawing.rsb).toBe(90);
        expect(closure.recomposeGlyphNames.has('n')).toBe(true);
        expect(closure.recomposeGlyphNames.has('a.ss03')).toBe(true);
    });

    test('sidebearing commit still persists automatic composites after a no-op rebuild', () => {
        const font = makeLeanRecompositionFont();
        const auto = font.findGlyph('adieresisAuto').findDrawingById('ada0');
        auto.rebuildAutomaticComposition();

        const aDrawing = font.findGlyph('a').findDrawingById('a0');
        aDrawing.setDirectSidebearing('left', aDrawing.lsb + 40);
        // First pass applies the live recomposition.
        font.rebuildAutomaticCompositesForGlyphs(new Set(['a']));
        const autoWidthAfterLive = auto.width;

        // Second pass mimics commit-time closure after live already converged:
        // rebuild reports no further mutations, but changedDrawingTargets must
        // still include the automatic composite for Yjs persistence.
        const rebuildSpy = jest
            .spyOn(font, 'rebuildAutomaticCompositesForGlyphs')
            .mockReturnValue(new Set());
        const closure = computeDrawingRecompositionClosure({
            sourceTargets: [{ glyphName: 'a', layerId: 'a0' }],
            editKinds: new Set(['sidebearing']),
            scope: 'all',
            fontModel: font,
            activeDrawingId: 'a0',
            sourceGlyphName: 'a'
        });

        expect(rebuildSpy).toHaveBeenCalled();
        expect(closure.recomposeGlyphNames.has('adieresisAuto')).toBe(true);
        expect(closure.recomposeGlyphNames.has('adieresisManual')).toBe(false);
        expect(
            resolveDrawingSyncTargetsFromClosure(closure, [
                { glyphName: 'a', layerId: 'a0' }
            ]).changedDrawingTargets.some(
                (target) => target.glyphName === 'adieresisAuto'
            )
        ).toBe(true);
        expect(auto.width).toBe(autoWidthAfterLive);
    });

    test('unused orphan anchor does not mutate automatic composites but still persists them', () => {
        const font = makeLeanRecompositionFont();
        font.findGlyph('adieresisAuto')
            .findDrawingById('ada0')
            .rebuildAutomaticComposition();
        const auto = font.findGlyph('adieresisAuto').findDrawingById('ada0');
        const markBefore = getComponentTranslation(auto, 1);

        const orphan = font
            .findGlyph('a')
            .findDrawingById('a0')
            .anchors.find((anchor) => anchor.name === 'orphan');
        orphan.x = 99;
        orphan.y = 88;

        const closure = computeDrawingRecompositionClosure({
            sourceTargets: [{ glyphName: 'a', layerId: 'a0' }],
            editKinds: new Set(['anchor']),
            scope: 'all',
            fontModel: font,
            activeDrawingId: 'a0',
            sourceGlyphName: 'a'
        });

        // Orphan anchors do not move marks, but commit must still snapshot
        // automatic dependents so a prior live converge cannot leave Yjs stale.
        expect(getComponentTranslation(auto, 1)).toEqual(markBefore);
        expect(closure.recomposeGlyphNames.has('adieresisAuto')).toBe(true);
        expect(closure.recomposeGlyphNames.has('adieresisManual')).toBe(false);
        expect([...closure.invalidateGlyphNames].sort()).toEqual(
            expect.arrayContaining(['adieresisManual'])
        );
        // Anchor-only must not run metrics-key inheritance.
        expect(closure.recomposeGlyphNames.has('n')).toBe(false);
    });

    test('anchor commit still persists automatic composites after a no-op rebuild', () => {
        const font = makeLeanRecompositionFont();
        const auto = font.findGlyph('adieresisAuto').findDrawingById('ada0');
        auto.rebuildAutomaticComposition();

        const top = font
            .findGlyph('a')
            .findDrawingById('a0')
            .anchors.find((anchor) => anchor.name === 'top');
        top.y = 760;
        // Live pass applies the mark move.
        font.rebuildAutomaticCompositesForGlyphs(new Set(['a']));
        const markAfterLive = getComponentTranslation(auto, 1);

        // Commit-time closure after live already converged: rebuild reports
        // no further mutations, but changedDrawingTargets must still include
        // the automatic composite for Yjs persistence.
        const rebuildSpy = jest
            .spyOn(font, 'rebuildAutomaticCompositesForGlyphs')
            .mockReturnValue(new Set());
        const closure = computeDrawingRecompositionClosure({
            sourceTargets: [{ glyphName: 'a', layerId: 'a0' }],
            editKinds: new Set(['anchor']),
            scope: 'all',
            fontModel: font,
            activeDrawingId: 'a0',
            sourceGlyphName: 'a'
        });

        expect(rebuildSpy).toHaveBeenCalled();
        expect(closure.recomposeGlyphNames.has('adieresisAuto')).toBe(true);
        expect(closure.recomposeGlyphNames.has('adieresisManual')).toBe(false);
        expect(
            resolveDrawingSyncTargetsFromClosure(closure, [
                { glyphName: 'a', layerId: 'a0' }
            ]).changedDrawingTargets.some(
                (target) => target.glyphName === 'adieresisAuto'
            )
        ).toBe(true);
        expect(getComponentTranslation(auto, 1)).toEqual(markAfterLive);
    });

    test('composition-relevant top anchor recomposes automatic dependents only', () => {
        const font = makeLeanRecompositionFont();
        const auto = font.findGlyph('adieresisAuto').findDrawingById('ada0');
        auto.rebuildAutomaticComposition();
        const markTranslateBefore = getComponentTranslation(auto, 1);

        const top = font
            .findGlyph('a')
            .findDrawingById('a0')
            .anchors.find((anchor) => anchor.name === 'top');
        top.y = 760;

        const closure = computeDrawingRecompositionClosure({
            sourceTargets: [{ glyphName: 'a', layerId: 'a0' }],
            editKinds: new Set(['anchor']),
            scope: 'all',
            fontModel: font,
            activeDrawingId: 'a0',
            sourceGlyphName: 'a'
        });

        expect(closure.recomposeGlyphNames.has('adieresisAuto')).toBe(true);
        expect(closure.recomposeGlyphNames.has('adieresisManual')).toBe(false);
        expect(getComponentTranslation(auto, 1).y).not.toBe(
            markTranslateBefore.y
        );
    });

    test('outline edit kinds invoke metrics-key recomposition', () => {
        const font = makeLeanRecompositionFont();
        const metricsSpy = jest
            .spyOn(font, 'recomputeMetricsKeys')
            .mockReturnValue(new Set(['n']));
        jest.spyOn(font, 'rebuildAutomaticCompositesForGlyphs').mockReturnValue(
            new Set()
        );
        jest.spyOn(font, 'collectComponentDependentGlyphs').mockReturnValue(
            new Set(['adieresisManual'])
        );

        const closure = computeDrawingRecompositionClosure({
            sourceTargets: [{ glyphName: 'a', layerId: 'a0' }],
            editKinds: new Set(['outline']),
            scope: 'all',
            fontModel: font,
            activeDrawingId: 'a0',
            sourceGlyphName: 'a'
        });

        expect(metricsSpy).toHaveBeenCalledWith(new Set(['a']), {
            skipInitialAutomaticCompositeRebuild: true
        });
        expect(closure.recomposeGlyphNames.has('n')).toBe(true);
        expect(closure.invalidateGlyphNames.has('adieresisManual')).toBe(true);
        expect(
            closure.recomposeTargets.some((target) => target.glyphName === 'n')
        ).toBe(true);
        expect(
            resolveDrawingSyncTargetsFromClosure(closure, [
                { glyphName: 'a', layerId: 'a0' }
            ]).changedDrawingTargets.some(
                (target) => target.glyphName === 'adieresisManual'
            )
        ).toBe(false);
    });

    test('deriveEditKindsFromOperations is path-accurate', () => {
        expect([
            ...deriveEditKindsFromOperations([
                {
                    path: ['glyphs', 'a', 'layers', 'a0', 'width'],
                    newValue: 600
                }
            ])
        ]).toEqual(['sidebearing']);
        expect([
            ...deriveEditKindsFromOperations([
                {
                    path: ['glyphs', 'a', 'layers', 'a0', 'anchors', 0],
                    newValue: { name: 'top', x: 1, y: 2 }
                }
            ])
        ]).toEqual(['anchor']);
    });

    test('finalizer writes only recomposed dependents for width cascade', () => {
        const fontJson = {
            glyphs: [
                {
                    name: 'a',
                    layers: [
                        {
                            id: 'a0',
                            width: 500,
                            anchors: [],
                            shapes: []
                        }
                    ]
                },
                {
                    name: 'adieresisManual',
                    layers: [
                        {
                            id: 'adm0',
                            width: 520,
                            anchors: [],
                            shapes: []
                        }
                    ]
                },
                {
                    name: 'adieresisAuto',
                    layers: [
                        {
                            id: 'ada0',
                            width: 500,
                            anchors: [],
                            shapes: []
                        }
                    ]
                },
                {
                    name: 'n',
                    layers: [
                        {
                            id: 'n0',
                            width: 480,
                            anchors: [],
                            shapes: []
                        }
                    ]
                }
            ]
        };
        const bridge = new ChangeBridge('lean-cascade-test');
        bridge.initFromJson(fontJson);

        fontJson.glyphs[0].layers[0].width = 560;

        const sourceDrawing = {
            id: 'a0',
            getMatchingDrawingOnGlyph: jest.fn((glyphName) => {
                if (glyphName === 'adieresisManual') return { id: 'adm0' };
                if (glyphName === 'adieresisAuto') return { id: 'ada0' };
                if (glyphName === 'n') return { id: 'n0' };
                return null;
            })
        };

        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn((glyphName) => {
                        if (glyphName === 'a') {
                            return {
                                findDrawingById: jest.fn((drawingId) =>
                                    drawingId === 'a0' ? sourceDrawing : null
                                )
                            };
                        }
                        const drawingIdByGlyph = {
                            adieresisManual: 'adm0',
                            adieresisAuto: 'ada0',
                            n: 'n0'
                        };
                        const drawingId = drawingIdByGlyph[glyphName];
                        if (!drawingId) {
                            return null;
                        }
                        return {
                            findDrawingById: jest.fn((id) =>
                                id === drawingId ? { id: drawingId } : null
                            )
                        };
                    }),
                    collectComponentDependentGlyphs: jest.fn(
                        () => new Set(['adieresisManual', 'adieresisAuto'])
                    ),
                    rebuildAutomaticCompositesForGlyphs: jest.fn(() => {
                        fontJson.glyphs.find(
                            (glyph) => glyph.name === 'adieresisAuto'
                        ).layers[0].width = 560;
                        return new Set(['adieresisAuto']);
                    }),
                    recomputeMetricsKeys: jest.fn(() => {
                        fontJson.glyphs.find(
                            (glyph) => glyph.name === 'n'
                        ).layers[0].width = 540;
                        return new Set(['n']);
                    })
                }
            }
        };

        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'set',
                path: ['glyphs', 'a', 'layers', 'a0', 'width'],
                oldValue: 500,
                newValue: 560
            }
        ]);

        const glyphNames = operations.map((op) => op.path[1]);
        expect(glyphNames).toEqual(
            expect.arrayContaining(['adieresisAuto', 'n'])
        );
        expect(glyphNames).not.toContain('adieresisManual');
        expect(
            window.fontManager.currentFont.fontModel
                .rebuildAutomaticCompositesForGlyphs
        ).toHaveBeenCalled();
        expect(
            window.fontManager.currentFont.fontModel.recomputeMetricsKeys
        ).toHaveBeenCalled();
    });

    test('finalizer does not run metrics for anchor-only packets', () => {
        const fontJson = {
            glyphs: [
                {
                    name: 'a',
                    layers: [
                        {
                            id: 'a0',
                            width: 500,
                            anchors: [{ name: 'orphan', x: 1, y: 2 }],
                            shapes: []
                        }
                    ]
                },
                {
                    name: 'adieresisManual',
                    layers: [
                        {
                            id: 'adm0',
                            width: 520,
                            anchors: [],
                            shapes: []
                        }
                    ]
                }
            ]
        };
        const bridge = new ChangeBridge('lean-anchor-cascade-test');
        bridge.initFromJson(fontJson);

        fontJson.glyphs[0].layers[0].anchors = [{ name: 'orphan', x: 9, y: 9 }];

        const sourceDrawing = {
            id: 'a0',
            getMatchingDrawingOnGlyph: jest.fn((glyphName) =>
                glyphName === 'adieresisManual' ? { id: 'adm0' } : null
            )
        };

        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn((glyphName) => {
                        if (glyphName === 'a') {
                            return {
                                findDrawingById: jest.fn((drawingId) =>
                                    drawingId === 'a0' ? sourceDrawing : null
                                )
                            };
                        }
                        if (glyphName === 'adieresisManual') {
                            return {
                                findDrawingById: jest.fn((drawingId) =>
                                    drawingId === 'adm0' ? { id: 'adm0' } : null
                                )
                            };
                        }
                        return null;
                    }),
                    collectComponentDependentGlyphs: jest.fn(
                        () => new Set(['adieresisManual'])
                    ),
                    rebuildAutomaticCompositesForGlyphs: jest.fn(
                        () => new Set()
                    ),
                    recomputeMetricsKeys: jest.fn(() => new Set(['n']))
                }
            }
        };

        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'set',
                path: ['glyphs', 'a', 'layers', 'a0', 'anchors', 0],
                oldValue: { name: 'orphan', x: 1, y: 2 },
                newValue: { name: 'orphan', x: 9, y: 9 }
            }
        ]);

        expect(operations).toEqual([]);
        expect(
            window.fontManager.currentFont.fontModel.recomputeMetricsKeys
        ).not.toHaveBeenCalled();
        expect(
            window.fontManager.currentFont.fontModel
                .rebuildAutomaticCompositesForGlyphs
        ).toHaveBeenCalled();
    });
});

describe('undo/redo derived-layer resettle helpers', () => {
    test('detects cascade kinds and derived glyphs', () => {
        const entries = [
            {
                path: 'glyphs.A:layers.layer-1',
                oldValue: { id: 'layer-1', anchors: [] },
                newValue: { id: 'layer-1', anchors: [{ name: 'top' }] }
            },
            {
                path: 'glyphs.B:layers.layer-2',
                oldValue: { id: 'layer-2', width: 650 },
                newValue: { id: 'layer-2', width: 777 }
            }
        ];
        const kinds = deriveEditKindsFromChangeLogEntries(entries);
        expect(kinds.has('anchor')).toBe(true);
        expect(
            shouldResettleDerivedDrawingsOnHistoryReplay(
                {
                    originatingGlyphName: 'A',
                    entries,
                    workerReplayTargets: [
                        { glyphName: 'A', layerId: 'layer-1' },
                        { glyphName: 'B', layerId: 'layer-2' }
                    ]
                },
                true
            )
        ).toBe(true);
        expect(
            shouldResettleDerivedDrawingsOnHistoryReplay(
                {
                    originatingGlyphName: 'A',
                    entries: [
                        {
                            path: 'glyphs.A:layers.layer-1.anchors',
                            oldValue: [],
                            newValue: [{ name: 'top' }]
                        },
                        {
                            path: 'glyphs.B:layers.layer-2',
                            oldValue: { id: 'layer-2', width: 650, shapes: [] },
                            newValue: {
                                id: 'layer-2',
                                width: 777,
                                shapes: [{ type: 'component' }]
                            }
                        }
                    ],
                    workerReplayTargets: [
                        { glyphName: 'A', layerId: 'layer-1' },
                        { glyphName: 'B', layerId: 'layer-2' }
                    ]
                },
                true
            )
        ).toBe(true);
        expect(
            shouldResettleDerivedDrawingsOnHistoryReplay(
                {
                    originatingGlyphName: 'A',
                    entries,
                    workerReplayTargets: [
                        { glyphName: 'A', layerId: 'layer-1' },
                        { glyphName: 'B', layerId: 'layer-2' }
                    ]
                },
                false
            )
        ).toBe(false);
    });
});
