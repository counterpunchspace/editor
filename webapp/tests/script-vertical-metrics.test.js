const {
    getCoreDrawableMetricLineEntries,
    getMetricOvershootBands,
    glyphsScriptForGlyph,
    glyphsScriptForUnicodeScript,
    parseScopedMetricKey,
    resolveVerticalMetricsForScript,
    scriptMetricKey
} = require('../js/glyph-canvas/vertical-metrics');

// Keys as babelfont imports them from a Glyphs file with script-scoped metrics.
const STATION_METRICS = {
    'Ascender': 750,
    'ascender overshoot': 12,
    'XHeight': 500,
    'xHeight overshoot': 10,
    'Descender': -250,
    'xHeight (filter script == "cyrillic")': 520,
    'xHeight (filter script == "cyrillic") overshoot': 14,
    'descender (filter script == "arabic")': -310,
    'xHeight (filter case == 3)': 400
};

describe('script-scoped vertical metrics', () => {
    test('maps Unicode script names to Glyphs script names', () => {
        expect(glyphsScriptForUnicodeScript('Latin')).toBe('latin');
        expect(glyphsScriptForUnicodeScript('Cyrillic')).toBe('cyrillic');
        expect(glyphsScriptForUnicodeScript('Tibetan')).toBe('tibet');
        expect(glyphsScriptForUnicodeScript('Hiragana')).toBe('kana');
        expect(glyphsScriptForUnicodeScript('Katakana')).toBe('kana');
        expect(glyphsScriptForUnicodeScript('Tai_Tham')).toBe('tham');
        expect(glyphsScriptForUnicodeScript('New_Tai_Lue')).toBe('lue');
        expect(glyphsScriptForUnicodeScript('Dives_Akuru')).toBe('divesakuru');
        expect(glyphsScriptForUnicodeScript('Pahawh_Hmong')).toBe(
            'pahawh hmong'
        );
        expect(glyphsScriptForUnicodeScript('Common')).toBeNull();
        expect(glyphsScriptForUnicodeScript('Inherited')).toBeNull();
        expect(glyphsScriptForUnicodeScript(undefined)).toBeNull();
    });

    test('a glyph’s own Glyphs script wins over Glyph Data', () => {
        expect(
            glyphsScriptForGlyph({
                format_specific: { script: 'arabic' },
                glyphData: { script: 'Latin' }
            })
        ).toBe('arabic');
        expect(
            glyphsScriptForGlyph({ glyphData: { script: 'Cyrillic' } })
        ).toBe('cyrillic');
        expect(glyphsScriptForGlyph(null)).toBeNull();
    });

    test('parses and builds scoped keys the way babelfont writes them', () => {
        expect(
            parseScopedMetricKey(
                'xHeight (filter script == "cyrillic") overshoot'
            )
        ).toEqual({ baseKey: 'xHeight', script: 'cyrillic', overshoot: true });
        expect(parseScopedMetricKey('xHeight (filter case == 3)')).toEqual({
            baseKey: 'xHeight',
            script: null,
            overshoot: false
        });
        expect(parseScopedMetricKey('XHeight')).toBeNull();
        expect(scriptMetricKey('capHeight', 'greek')).toBe(
            'capHeight (filter script == "greek")'
        );
        expect(scriptMetricKey('capHeight', 'greek', true)).toBe(
            'capHeight (filter script == "greek") overshoot'
        );
    });

    test('a Cyrillic glyph gets the Cyrillic x-height and zone', () => {
        const resolved = resolveVerticalMetricsForScript(
            STATION_METRICS,
            'cyrillic'
        );
        expect(resolved).toEqual({
            'Ascender': 750,
            'ascender overshoot': 12,
            'XHeight': 520,
            'xHeight overshoot': 14,
            'Descender': -250
        });
        const xHeightLine = getCoreDrawableMetricLineEntries(resolved).find(
            (entry) => entry.family === 'xheight'
        );
        expect(xHeightLine.y).toBe(520);
        const xHeightBand = getMetricOvershootBands(resolved).find(
            (band) => band.baseKey === 'xHeight'
        );
        expect(xHeightBand).toEqual(
            expect.objectContaining({ y: 520, overshoot: 14 })
        );
    });

    test('a scoped metric with no unscoped twin is added under its own type', () => {
        const resolved = resolveVerticalMetricsForScript(
            { 'XHeight': 500, 'capHeight (filter script == "greek")': 690 },
            'greek'
        );
        expect(resolved).toEqual({ XHeight: 500, capHeight: 690 });
        expect(
            getCoreDrawableMetricLineEntries(resolved).find(
                (entry) => entry.family === 'capheight'
            ).y
        ).toBe(690);
    });

    test('other scripts and non-script filters never reach the canvas', () => {
        const latin = resolveVerticalMetricsForScript(STATION_METRICS, 'latin');
        const unknown = resolveVerticalMetricsForScript(STATION_METRICS, null);
        const expected = {
            'Ascender': 750,
            'ascender overshoot': 12,
            'XHeight': 500,
            'xHeight overshoot': 10,
            'Descender': -250
        };
        expect(latin).toEqual(expected);
        expect(unknown).toEqual(expected);
        expect(
            getMetricOvershootBands(unknown).map((band) => band.baseKey)
        ).not.toContain('xHeight (filter script == "cyrillic")');
    });
});
