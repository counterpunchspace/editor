const {
    coreMetricKey,
    coreZoneKey,
    CORE_STATION_METRICS,
    isStructuredStationMetricKey,
    lineSpacingDefaults,
    scriptsWithMetrics
} = require('../js/font-info-station-metrics');

const spec = (type) => CORE_STATION_METRICS.find((item) => item.type === type);

describe('station metrics in Font info', () => {
    test('line-spacing defaults match what fontc writes for empty values', () => {
        // babelfont falls back to ascender 800 / descender -200.
        expect(lineSpacingDefaults({}, 2048)).toEqual({
            TypoAscender: 800,
            TypoDescender: -200,
            TypoLineGap: Math.round(1.2 * 2048 - 200 - 800),
            HheaAscender: 800 + Math.round(1.2 * 2048 - 200 - 800),
            HheaDescender: -200,
            HheaLineGap: 0,
            WinAscent: 800 + Math.round(1.2 * 2048 - 200 - 800),
            WinDescent: 200
        });
        // A set typo line gap feeds hhea and Win ascent; it never goes negative.
        expect(
            lineSpacingDefaults(
                { Ascender: 1000, Descender: -400, TypoLineGap: 50 },
                1000
            )
        ).toEqual(
            expect.objectContaining({
                TypoLineGap: 50,
                HheaAscender: 1050,
                WinAscent: 1050,
                WinDescent: 400
            })
        );
        expect(
            lineSpacingDefaults({ Ascender: 1000, Descender: -400 }, 1000)
                .TypoLineGap
        ).toBe(0);
    });

    test('finds existing keys in any case and names new ones like babelfont', () => {
        const glyphsImport = { 'xHeight': 500, 'xHeight overshoot': 10 };
        expect(coreMetricKey(glyphsImport, spec('xHeight'))).toBe('xHeight');
        expect(coreZoneKey(glyphsImport, spec('xHeight'))).toBe(
            'xHeight overshoot'
        );
        expect(coreMetricKey({}, spec('capHeight'))).toBe('CapHeight');
        expect(coreZoneKey({}, spec('capHeight'))).toBe('capHeight overshoot');
    });

    test('sorts out which keys have their own fields', () => {
        for (const key of [
            'Ascender',
            'xHeight overshoot',
            'baseline overshoot',
            'ItalicAngle',
            'TypoLineGap',
            'WinDescent',
            'descender (filter script == "arabic") overshoot'
        ]) {
            expect(isStructuredStationMetricKey(key)).toBe(true);
        }
        for (const key of [
            'UnderlinePosition',
            'Alef',
            'xHeight (filter case == 3)'
        ]) {
            expect(isStructuredStationMetricKey(key)).toBe(false);
        }
        expect(
            scriptsWithMetrics({
                'xHeight (filter script == "greek")': 1,
                'ascender (filter script == "cyrillic")': 1,
                'xHeight (filter script == "zzz")': 1
            })
        ).toEqual(['cyrillic', 'greek', 'zzz']);
    });
});
