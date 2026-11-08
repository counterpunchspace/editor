/**
 * Unit tests for committed-entry → glyph-filter event derivation.
 * Covers every registered path-derived event type plus compatibility toggles.
 */

jest.mock('tippy.js', () => {
    const tippy = jest.fn(() => ({
        destroy: jest.fn(),
        setProps: jest.fn(),
        show: jest.fn(),
        hide: jest.fn()
    }));

    return {
        __esModule: true,
        default: tippy
    };
});

jest.mock('tippy.js/dist/tippy.css', () => ({}), { virtual: true });

const {
    deriveGlyphFilterChangesFromCommittedEntry,
    dedupeGlyphFilterChanges,
    isComponentShapeValue,
    isPathShapeValue
} = require('../js/glyph-filter-change-derivation');
const { GlyphOverviewFilterManager } = require('../js/glyph-overview-filters');
const {
    GLYPH_FILTER_EVENT_TYPES,
    GLYPH_FILTER_EVENT_REGISTRY
} = require('../js/glyph-filter-events');

function typesOf(result) {
    return result.changes.map((change) => change.type);
}

describe('glyph-filter-events registry', () => {
    test('every registered event has a definition', () => {
        for (const type of GLYPH_FILTER_EVENT_TYPES) {
            expect(GLYPH_FILTER_EVENT_REGISTRY[type]).toBeDefined();
            expect(GLYPH_FILTER_EVENT_REGISTRY[type].name).toBeTruthy();
            expect(
                GLYPH_FILTER_EVENT_REGISTRY[type].metadataFields.length
            ).toBeGreaterThan(0);
        }
    });
});

describe('shape value classifiers', () => {
    test('detects component and path shapes', () => {
        expect(isComponentShapeValue({ reference: 'A' })).toBe(true);
        expect(isComponentShapeValue({ Component: { reference: 'A' } })).toBe(
            true
        );
        expect(isPathShapeValue({ nodes: [], closed: true })).toBe(true);
        expect(isPathShapeValue({ Path: { nodes: [], closed: true } })).toBe(
            true
        );
        expect(isComponentShapeValue({ nodes: [] })).toBe(false);
        expect(isPathShapeValue({ reference: 'A' })).toBe(false);
    });
});

describe('deriveGlyphFilterChangesFromCommittedEntry', () => {
    test('records master changes internally without a public event', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'masters.0',
            op: 'add',
            oldValue: null,
            newValue: { id: 'm1' }
        });
        expect(result.mastersChanged).toBe(true);
        expect(result.changes).toEqual([]);
    });

    test('master kerning edits do not recheck outline compatibility', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'masters.0.kerning',
            op: 'replace',
            oldValue: {},
            newValue: { 'A:V': -40 }
        });
        expect(result.mastersChanged).toBe(false);
        expect(result.changes).toEqual([]);
        expect(
            deriveGlyphFilterChangesFromCommittedEntry({
                path: 'masters.0.location',
                op: 'replace',
                oldValue: {},
                newValue: { wght: 700 }
            }).mastersChanged
        ).toBe(true);
    });

    test('glyph.created', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A',
            op: 'add',
            oldValue: null,
            newValue: { name: 'A' }
        });
        expect(result.changes).toEqual([]);
        expect(result.lifecycleChanges).toEqual([
            { kind: 'created', glyphName: 'A' }
        ]);
    });

    test('glyph.deleted', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A',
            op: 'remove',
            oldValue: { name: 'A' },
            newValue: null
        });
        expect(result.changes).toEqual([]);
        expect(result.lifecycleChanges).toEqual([
            { kind: 'deleted', glyphName: 'A' }
        ]);
    });

    test('glyph.renamed', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A.name',
            op: 'set',
            oldValue: 'A',
            newValue: 'B'
        });
        expect(result.changes).toEqual([]);
        expect(result.lifecycleChanges).toEqual([
            { kind: 'renamed', glyphName: 'B', previousGlyphName: 'A' }
        ]);
    });

    test('glyph.unicode.changed', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A.codepoints',
            op: 'set',
            oldValue: [65],
            newValue: [66]
        });
        expect(result.changes).toEqual([
            {
                type: 'glyph.unicode.changed',
                metadata: {
                    glyphName: 'A',
                    unicode: 66,
                    previousUnicode: 65
                }
            }
        ]);
    });

    test('glyph.category.changed', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A.category',
            op: 'set',
            oldValue: 'Base',
            newValue: 'Mark'
        });
        expect(typesOf(result)).toEqual(['glyph.category.changed']);
    });

    test('glyph.export.changed', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A.exported',
            op: 'set',
            oldValue: true,
            newValue: false
        });
        expect(typesOf(result)).toEqual(['glyph.export.changed']);
    });

    test('glyph.production-name.changed', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A.production_name',
            op: 'set',
            oldValue: 'uni0041',
            newValue: 'A'
        });
        expect(typesOf(result)).toEqual(['glyph.production-name.changed']);
    });

    test('glyph.paths.changed from path subtraction format_specific', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A.layers.layer-1.shapes.0.format_specific.fip001-boolean',
            op: 'set',
            oldValue: undefined,
            newValue: 'subtraction'
        });
        expect(typesOf(result)).toEqual(['glyph.paths.changed']);
        expect(result.compatibilityCheckGlyphNames).toEqual(['A']);
    });

    test('glyph.paths.changed from node edit', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A.layers.layer-1.shapes.0.nodes.2.x',
            op: 'set',
            oldValue: 10,
            newValue: 20
        });
        expect(typesOf(result)).toEqual(['glyph.paths.changed']);
        expect(result.compatibilityCheckGlyphNames).toEqual(['A']);
        expect(result.changes[0].metadata).toEqual({
            glyphName: 'A',
            layerIds: ['layer-1']
        });
    });

    test('glyph.components.changed from component add', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A.layers.layer-1.shapes.0',
            op: 'add',
            oldValue: null,
            newValue: { reference: 'acute', transform: { xx: 1, yy: 1 } }
        });
        expect(typesOf(result)).toEqual(['glyph.components.changed']);
        expect(result.compatibilityCheckGlyphNames).toEqual(['A']);
    });

    test('glyph.component.reference.changed', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A.layers.layer-1.shapes.0.reference',
            op: 'set',
            oldValue: 'acute',
            newValue: 'grave'
        });
        expect(typesOf(result)).toEqual(['glyph.component.reference.changed']);
        expect(result.compatibilityCheckGlyphNames).toEqual(['A']);
    });

    test('glyph.component.transform.changed does not request compatibility check', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A.layers.layer-1.shapes.0.transform',
            op: 'set',
            oldValue: { xx: 1, yy: 1 },
            newValue: { xx: 1, yy: 1, dx: 10 }
        });
        expect(typesOf(result)).toEqual(['glyph.component.transform.changed']);
        expect(result.compatibilityCheckGlyphNames).toEqual([]);
    });

    test('wrapped Component.transform still maps to transform.changed', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A.layers.layer-1.shapes.0.Component.transform',
            op: 'set',
            oldValue: { xx: 1 },
            newValue: { xx: 1, dx: 3 }
        });
        expect(typesOf(result)).toEqual(['glyph.component.transform.changed']);
        expect(result.compatibilityCheckGlyphNames).toEqual([]);
    });

    test('wrapped Component.reference maps to reference.changed', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A.layers.layer-1.shapes.0.Component.reference',
            op: 'set',
            oldValue: 'acute',
            newValue: 'grave'
        });
        expect(typesOf(result)).toEqual(['glyph.component.reference.changed']);
    });

    test('glyph.anchors.changed', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A.layers.layer-1.anchors.0.x',
            op: 'set',
            oldValue: 0,
            newValue: 100
        });
        expect(typesOf(result)).toEqual(['glyph.anchors.changed']);
        expect(result.compatibilityCheckGlyphNames).toEqual(['A']);
    });

    test('glyph.anchors.changed from colon-separated committed path', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A:layers.layer-1:anchors.0',
            op: 'add',
            oldValue: undefined,
            newValue: { id: 'anchor-1', name: 'top', x: 100, y: 700 }
        });
        expect(typesOf(result)).toEqual(['glyph.anchors.changed']);
        expect(result.changes[0].metadata).toEqual({
            glyphName: 'A',
            layerIds: ['layer-1']
        });
        expect(result.compatibilityCheckGlyphNames).toEqual(['A']);
    });

    test('glyph.paths.changed from colon-separated committed path', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.behDotless-ar.medi:layers.layer.regular.v1:shapes.0.nodes.2.x',
            op: 'set',
            oldValue: 10,
            newValue: 20
        });
        expect(typesOf(result)).toEqual(['glyph.paths.changed']);
        expect(result.changes[0].metadata).toEqual({
            glyphName: 'behDotless-ar.medi',
            layerIds: ['layer.regular.v1']
        });
    });

    test('glyph.unicode.changed from colon-separated glyph field path', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A:codepoints',
            op: 'set',
            oldValue: [65],
            newValue: [66]
        });
        expect(result.changes).toEqual([
            {
                type: 'glyph.unicode.changed',
                metadata: {
                    glyphName: 'A',
                    unicode: 66,
                    previousUnicode: 65
                }
            }
        ]);
    });

    test('glyph.guides.changed does not request compatibility check', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A.layers.layer-1.guides.0.pos',
            op: 'set',
            oldValue: 0,
            newValue: 200
        });
        expect(typesOf(result)).toEqual(['glyph.guides.changed']);
        expect(result.compatibilityCheckGlyphNames).toEqual([]);
    });

    test('glyph.layers.changed on layer add', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A.layers.layer-2',
            op: 'add',
            oldValue: null,
            newValue: { id: 'layer-2', shapes: [] }
        });
        expect(typesOf(result)).toEqual(['glyph.layers.changed']);
        expect(result.compatibilityCheckGlyphNames).toEqual(['A']);
    });

    test('glyph.layer.location.changed', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A.layers.layer-1.location',
            op: 'set',
            oldValue: { wght: 400 },
            newValue: { wght: 700 }
        });
        expect(typesOf(result)).toEqual(['glyph.layer.location.changed']);
        expect(result.compatibilityCheckGlyphNames).toEqual([]);
    });

    test('glyph.metrics.changed from width', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A.layers.layer-1.width',
            op: 'set',
            oldValue: 500,
            newValue: 600
        });
        expect(typesOf(result)).toEqual(['glyph.metrics.changed']);
        expect(result.compatibilityCheckGlyphNames).toEqual([]);
    });

    test('glyph.metrics-key.changed from glyph-level key', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A.format_specific.metric_left',
            op: 'set',
            oldValue: '=B',
            newValue: '=C'
        });
        expect(typesOf(result)).toEqual(['glyph.metrics-key.changed']);
    });

    test('glyph.metrics-key.changed from layer-level key', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A.layers.layer-1.format_specific.com.schriftgestalt.Glyphs.metricRight',
            op: 'set',
            oldValue: '=B',
            newValue: null
        });
        expect(typesOf(result)).toEqual(['glyph.metrics-key.changed']);
        expect(result.changes[0].metadata).toEqual({
            glyphName: 'A',
            layerIds: ['layer-1']
        });
    });

    test('does not emit glyph.compatibility.changed from path classification alone', () => {
        const result = deriveGlyphFilterChangesFromCommittedEntry({
            path: 'glyphs.A.layers.layer-1.shapes.0.nodes.0.y',
            op: 'set',
            oldValue: 0,
            newValue: 1
        });
        expect(typesOf(result)).not.toContain('glyph.compatibility.changed');
    });

    test('dedupeGlyphFilterChanges collapses identical events', () => {
        const deduped = dedupeGlyphFilterChanges([
            {
                type: 'glyph.paths.changed',
                metadata: { glyphName: 'A', layerIds: ['l1'] }
            },
            {
                type: 'glyph.paths.changed',
                metadata: { glyphName: 'A', layerIds: ['l1'] }
            },
            {
                type: 'glyph.anchors.changed',
                metadata: { glyphName: 'A', layerIds: ['l1'] }
            }
        ]);
        expect(deduped).toHaveLength(2);
    });
});

describe('GlyphOverviewFilterManager compatibility toggles', () => {
    let manager;

    beforeEach(() => {
        localStorage.clear();
        manager = new GlyphOverviewFilterManager();
        window.currentFontModel = {
            masters: [{ id: 'm1' }],
            glyphs: [],
            findGlyph: jest.fn()
        };
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete window.currentFontModel;
    });

    test('emits glyph.compatibility.changed only when isCompatible toggles', async () => {
        const glyph = {
            name: 'A',
            isCompatible: true,
            layers: [{ id: 'layer-1' }, { id: 'layer-2' }]
        };
        window.currentFontModel.glyphs = [glyph];
        window.currentFontModel.findGlyph.mockImplementation((name) =>
            name === 'A' ? glyph : undefined
        );

        manager.seedGlyphCompatibilityState();

        const batchSpy = jest
            .spyOn(manager, 'handleCommittedGlyphFilterBatch')
            .mockResolvedValue(undefined);

        glyph.isCompatible = true;
        await manager.handleCommittedChangeEntries([
            {
                path: 'glyphs.A.layers.layer-1.shapes.0.nodes.0.x',
                op: 'set',
                oldValue: 0,
                newValue: 10
            }
        ]);

        expect(batchSpy).toHaveBeenCalledWith({
            changes: [
                {
                    type: 'glyph.paths.changed',
                    metadata: { glyphName: 'A', layerIds: ['layer-1'] }
                }
            ]
        });

        glyph.isCompatible = false;
        await manager.handleCommittedChangeEntries([
            {
                path: 'glyphs.A.layers.layer-1.shapes.0.nodes.0.x',
                op: 'set',
                oldValue: 10,
                newValue: 20
            }
        ]);

        expect(batchSpy).toHaveBeenLastCalledWith({
            changes: expect.arrayContaining([
                {
                    type: 'glyph.paths.changed',
                    metadata: { glyphName: 'A', layerIds: ['layer-1'] }
                },
                {
                    type: 'glyph.compatibility.changed',
                    metadata: {
                        glyphName: 'A',
                        compatible: false,
                        layerIds: ['layer-1', 'layer-2']
                    }
                }
            ])
        });
    });

    test('does not emit compatibility.changed for transform-only edits', async () => {
        const glyph = {
            name: 'A',
            isCompatible: true,
            layers: [{ id: 'layer-1' }]
        };
        window.currentFontModel.glyphs = [glyph];
        window.currentFontModel.findGlyph.mockReturnValue(glyph);
        manager.seedGlyphCompatibilityState();

        const batchSpy = jest
            .spyOn(manager, 'handleCommittedGlyphFilterBatch')
            .mockResolvedValue(undefined);

        await manager.handleCommittedChangeEntries([
            {
                path: 'glyphs.A.layers.layer-1.shapes.0.transform',
                op: 'set',
                oldValue: { xx: 1 },
                newValue: { xx: 1, dx: 5 }
            }
        ]);

        const batch = batchSpy.mock.calls[0][0];
        expect(typesOf(batch)).toEqual(['glyph.component.transform.changed']);
        expect(typesOf(batch)).not.toContain('glyph.compatibility.changed');
    });

    test('seeds compatibility baseline on full rebuilds', async () => {
        const glyph = {
            name: 'A',
            isCompatible: false,
            layers: [{ id: 'layer-1' }]
        };
        window.currentFontModel.glyphs = [glyph];
        window.currentFontModel.findGlyph.mockReturnValue(glyph);

        manager.seedGlyphCompatibilityState();

        // After seeding, a no-op outline edit must not claim a toggle.
        const batchSpy = jest
            .spyOn(manager, 'handleCommittedGlyphFilterBatch')
            .mockResolvedValue(undefined);

        await manager.handleCommittedChangeEntries([
            {
                path: 'glyphs.A:layers.layer-1:shapes.0.nodes.0.x',
                op: 'set',
                oldValue: 0,
                newValue: 1
            }
        ]);

        const batch = batchSpy.mock.calls[0][0];
        expect(typesOf(batch)).toEqual(['glyph.paths.changed']);
        expect(typesOf(batch)).not.toContain('glyph.compatibility.changed');
    });

    test('emits glyph.anchors.changed for Add anchor commits', async () => {
        const batchSpy = jest
            .spyOn(manager, 'handleCommittedGlyphFilterBatch')
            .mockResolvedValue(undefined);

        await manager.handleCommittedChangeEntries([
            {
                path: 'glyphs.A:layers.layer-1:anchors.0',
                op: 'add',
                oldValue: undefined,
                newValue: { id: 'a1', name: 'top', x: 100, y: 700 }
            }
        ]);

        expect(batchSpy).toHaveBeenCalledWith({
            changes: [
                {
                    type: 'glyph.anchors.changed',
                    metadata: { glyphName: 'A', layerIds: ['layer-1'] }
                }
            ]
        });
    });
});
