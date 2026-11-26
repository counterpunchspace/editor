import {
    ensureLocalGlyphsHydratedForPython,
    openPythonEditContext,
    planLocalSparseHydrationForPython
} from '../js/python-ui-sync';
import { commitPythonExecutionSyntheticChanges } from '../js/python-post-execution';

describe('Local sparse Python pre-hydration and scoped snapshots', () => {
    afterEach(() => {
        delete window.fontManager;
        delete window.patchSyncEngine;
        delete window.cloudPlugin;
        window.pythonExecutionHistoryContext = null;
        jest.restoreAllMocks();
    });

    test('plans zero hydration for non-glyph or active-glyph Python code', () => {
        expect(planLocalSparseHydrationForPython('1 + 1')).toEqual({
            mode: 'none',
            names: []
        });
        expect(
            planLocalSparseHydrationForPython(
                'g = Glyph()\nprint(g.drawings[0].width)'
            )
        ).toEqual({
            mode: 'none',
            names: []
        });
        expect(planLocalSparseHydrationForPython('print(Font().upm)')).toEqual({
            mode: 'none',
            names: []
        });
    });

    test('plans targeted hydration for literal findGlyph and glyphs subscript calls', () => {
        expect(
            planLocalSparseHydrationForPython(
                'g = Font().findGlyph("uniAC00")\nprint(len(g.drawings))'
            )
        ).toEqual({
            mode: 'named',
            names: ['uniAC00']
        });
        expect(
            planLocalSparseHydrationForPython(
                'a = font.glyphs["A"]\nb = font.findGlyph(\'B\')'
            )
        ).toEqual({
            mode: 'named',
            names: ['B', 'A']
        });
    });

    test('plans full local hydration for glyphs iteration, len, dynamic findGlyph, and OtherFonts', () => {
        expect(
            planLocalSparseHydrationForPython(
                'for g in Font().glyphs:\n    print(g.name)'
            ).mode
        ).toBe('all');
        expect(planLocalSparseHydrationForPython('len(font.glyphs)').mode).toBe(
            'all'
        );
        expect(
            planLocalSparseHydrationForPython('font.findGlyph(target_name)')
                .mode
        ).toBe('all');
        expect(
            planLocalSparseHydrationForPython('for f in OtherFonts(): pass')
                .mode
        ).toBe('all');
    });

    test('hydrates only on local sparse fonts and never on cloud or resident fonts', async () => {
        const ensureLocalGlyphsHydrated = jest.fn(async () => undefined);
        const hydrateAllLocalGlyphs = jest.fn(async () => undefined);

        window.fontManager = {
            isLocalSparseFont: () => false,
            ensureLocalGlyphsHydrated,
            hydrateAllLocalGlyphs
        };
        await ensureLocalGlyphsHydratedForPython('len(Font().glyphs)');
        expect(ensureLocalGlyphsHydrated).not.toHaveBeenCalled();
        expect(hydrateAllLocalGlyphs).not.toHaveBeenCalled();

        window.fontManager.isLocalSparseFont = () => true;
        await ensureLocalGlyphsHydratedForPython('Font().findGlyph("uniAC00")');
        expect(ensureLocalGlyphsHydrated).toHaveBeenCalledWith(['uniAC00']);
        expect(hydrateAllLocalGlyphs).not.toHaveBeenCalled();

        await ensureLocalGlyphsHydratedForPython(
            'for g in Font().glyphs: len(g.drawings)'
        );
        expect(hydrateAllLocalGlyphs).toHaveBeenCalledTimes(1);
    });

    test('scoped snapshot skips JSON.parse for unchanged glyphs and diffs only mutated ones', () => {
        const glyphs = Array.from({ length: 200 }, (_, i) => ({
            name: i === 0 ? 'A' : `g${i}`,
            layers: [{ id: 'm', width: 500 + i }]
        }));
        const fontData = {
            upm: 1000,
            glyphs
        };
        const currentFont = {
            babelfontData: fontData,
            babelfontJson: '',
            syncJsonFromModel: jest.fn()
        };
        const bridge = {
            beginTransaction: jest.fn(),
            beginRecordingSuppression: jest.fn(() => jest.fn()),
            setRecordingSuppressed: jest.fn(),
            applySyntheticChangeSet: jest.fn(),
            endTransaction: jest.fn(() => ({ changeLogEntries: [] }))
        };
        window.fontManager = { currentFont };
        window.patchSyncEngine = bridge;

        const ctx = openPythonEditContext(
            'Font().findGlyph("A").drawings[0].width = 700'
        );
        expect(ctx.beforeFontDataJson).toBeNull();
        expect(ctx.beforeCoreJson).toBe(JSON.stringify({ upm: 1000 }));
        expect(ctx.beforeGlyphJsonByName.size).toBe(200);

        const parseSpy = jest.spyOn(JSON, 'parse');
        // Mutate only glyph A's width
        fontData.glyphs[0].layers[0].width = 700;

        commitPythonExecutionSyntheticChanges(currentFont, ctx, bridge);

        // Only glyph A (before + after) and cloneValue calls should be parsed,
        // not the 199 unchanged glyphs.
        expect(parseSpy.mock.calls.length).toBeLessThan(10);
        expect(bridge.applySyntheticChangeSet).toHaveBeenCalledTimes(1);
        expect(bridge.applySyntheticChangeSet.mock.calls[0][1]).toEqual([
            expect.objectContaining({
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'm', 'width'],
                oldValue: 500,
                newValue: 700
            })
        ]);
    });
});
