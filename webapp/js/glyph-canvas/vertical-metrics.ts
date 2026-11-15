/** Always-drawn station metrics (plus baseline `0`). */
export const CORE_VERTICAL_METRIC_KEYS = new Set([
    'Ascender',
    'Descender',
    'ascender',
    'descender',
    'xHeight',
    'XHeight',
    'CapHeight'
]);

/**
 * Optional OS/2 / hhea / typo metric lines. Drawn only when Show All Metrics
 * is enabled, and slightly fainter than core lines. Non-zero Typo/Hhea line
 * gaps are derived separately (descender − gap) in
 * `getAdditionalDrawableMetricLineEntries`.
 */
export const ADDITIONAL_DRAWABLE_VERTICAL_METRIC_KEYS = new Set([
    'HheaAscender',
    'HheaDescender',
    'TypoAscender',
    'TypoDescender',
    'WinAscent',
    'WinDescent'
]);

/**
 * Stations panel "Additional metrics" fields. Canvas Show All Metrics draws
 * the geometric keys plus non-zero Typo/Hhea line gaps under their descenders.
 */
export const ADDITIONAL_METRICS_PANEL_KEYS = [
    'TypoAscender',
    'TypoDescender',
    'TypoLineGap',
    'HheaAscender',
    'HheaDescender',
    'HheaLineGap',
    'WinAscent',
    'WinDescent'
] as const;

export const ADDITIONAL_METRICS_PANEL_KEY_SET = new Set<string>(
    ADDITIONAL_METRICS_PANEL_KEYS
);

const ALL_GEOMETRIC_VERTICAL_METRIC_KEYS = new Set([
    ...CORE_VERTICAL_METRIC_KEYS,
    ...ADDITIONAL_DRAWABLE_VERTICAL_METRIC_KEYS
]);

function resolveDrawableMetricY(
    metricKey: string,
    metricValue: number
): number {
    // WinDescent is stored as a positive distance below the baseline.
    if (metricKey === 'WinDescent') {
        return -Math.abs(metricValue);
    }
    return metricValue;
}

function collectUniqueMetricValues(
    verticalMetrics: Record<string, number> | null | undefined,
    keySet: Set<string>,
    options: { includeBaseline?: boolean } = {}
): number[] {
    if (!verticalMetrics) {
        return [];
    }

    const metricValues: number[] = [];
    for (const [metricKey, metricValue] of Object.entries(verticalMetrics)) {
        if (!keySet.has(metricKey)) {
            continue;
        }
        if (!Number.isFinite(metricValue)) {
            continue;
        }
        metricValues.push(resolveDrawableMetricY(metricKey, metricValue));
    }

    const uniqueMetricValues: number[] = [];
    for (const metricValue of metricValues) {
        const alreadyPresent = uniqueMetricValues.some(
            (existingValue) => Math.abs(existingValue - metricValue) < 0.25
        );
        if (!alreadyPresent) {
            uniqueMetricValues.push(metricValue);
        }
    }

    if (uniqueMetricValues.length === 0) {
        return [];
    }

    if (options.includeBaseline !== false) {
        const hasBaseline = uniqueMetricValues.some(
            (value) => Math.abs(value) < 0.25
        );
        if (!hasBaseline) {
            uniqueMetricValues.push(0);
        }
    }

    return uniqueMetricValues;
}

/** Core metrics always drawn in edit mode (includes baseline). */
export function getCoreVerticalMetricValues(
    verticalMetrics: Record<string, number> | null | undefined
): number[] {
    return collectUniqueMetricValues(
        verticalMetrics,
        CORE_VERTICAL_METRIC_KEYS,
        { includeBaseline: true }
    );
}

/**
 * Additional drawable metric Y values. Does not force baseline (core lines
 * already include it). Callers should skip values already covered by core.
 * `WinDescent` is treated as a positive stored value and drawn at `-abs(y)`.
 */
export function getAdditionalDrawableVerticalMetricValues(
    verticalMetrics: Record<string, number> | null | undefined
): number[] {
    return getAdditionalDrawableMetricLineEntries(verticalMetrics).map(
        (entry) => entry.y
    );
}

export type AdditionalMetricFamily =
    'hhea' | 'hhealinegap' | 'typo' | 'typolinegap' | 'win';

export type CoreMetricFamily =
    'ascender' | 'capheight' | 'xheight' | 'baseline' | 'descender';

export type MetricLineFamily = CoreMetricFamily | AdditionalMetricFamily;

export interface MetricLineEntry {
    family: MetricLineFamily;
    y: number;
    key: string;
}

export type AdditionalMetricLineEntry = MetricLineEntry & {
    family: AdditionalMetricFamily;
};

const CORE_METRIC_KEY_TO_FAMILY: Record<string, CoreMetricFamily> = {
    Ascender: 'ascender',
    ascender: 'ascender',
    CapHeight: 'capheight',
    XHeight: 'xheight',
    xHeight: 'xheight',
    Descender: 'descender',
    descender: 'descender'
};

const ADDITIONAL_METRIC_KEY_TO_FAMILY: Record<string, AdditionalMetricFamily> =
    {
        HheaAscender: 'hhea',
        HheaDescender: 'hhea',
        TypoAscender: 'typo',
        TypoDescender: 'typo',
        WinAscent: 'win',
        WinDescent: 'win'
    };

const LINE_GAP_DRAW_SPECS: ReadonlyArray<{
    gapKey: 'TypoLineGap' | 'HheaLineGap';
    descenderKey: 'TypoDescender' | 'HheaDescender';
    family: AdditionalMetricFamily;
}> = [
    {
        gapKey: 'TypoLineGap',
        descenderKey: 'TypoDescender',
        family: 'typolinegap'
    },
    {
        gapKey: 'HheaLineGap',
        descenderKey: 'HheaDescender',
        family: 'hhealinegap'
    }
];

/**
 * Resolve drawable additional-metric lines with short family names.
 * `WinDescent` is stored positive and drawn negative; other values are absolute.
 * Non-zero `TypoLineGap` / `HheaLineGap` add a line at `descender - gap`,
 * labeled `typolinegap` / `hhealinegap`.
 */
export function getAdditionalDrawableMetricLineEntries(
    verticalMetrics: Record<string, number> | null | undefined
): AdditionalMetricLineEntry[] {
    if (!verticalMetrics) {
        return [];
    }

    const entries: AdditionalMetricLineEntry[] = [];
    for (const [metricKey, family] of Object.entries(
        ADDITIONAL_METRIC_KEY_TO_FAMILY
    )) {
        const rawValue = verticalMetrics[metricKey];
        if (!Number.isFinite(rawValue)) {
            continue;
        }
        const y = resolveDrawableMetricY(metricKey, Number(rawValue));
        entries.push({ family, y, key: metricKey });
    }

    for (const { gapKey, descenderKey, family } of LINE_GAP_DRAW_SPECS) {
        const gap = Number(verticalMetrics[gapKey]);
        const descender = Number(verticalMetrics[descenderKey]);
        if (!Number.isFinite(gap) || gap === 0) {
            continue;
        }
        if (!Number.isFinite(descender)) {
            continue;
        }
        const y = resolveDrawableMetricY(descenderKey, descender) - gap;
        entries.push({ family, y, key: gapKey });
    }

    return entries;
}

export function formatAdditionalMetricFamiliesLabel(
    families: Iterable<MetricLineFamily>
): string {
    const order: MetricLineFamily[] = [
        'ascender',
        'capheight',
        'xheight',
        'baseline',
        'descender',
        'hhea',
        'hhealinegap',
        'typo',
        'typolinegap',
        'win'
    ];
    const present = new Set(families);
    return order.filter((family) => present.has(family)).join('+');
}

/**
 * Core metric lines always drawn in edit mode (includes baseline at 0).
 */
export function getCoreDrawableMetricLineEntries(
    verticalMetrics: Record<string, number> | null | undefined
): MetricLineEntry[] {
    if (!verticalMetrics) {
        return [];
    }

    const entries: MetricLineEntry[] = [];
    for (const [metricKey, family] of Object.entries(
        CORE_METRIC_KEY_TO_FAMILY
    )) {
        const rawValue = verticalMetrics[metricKey];
        if (!Number.isFinite(rawValue)) {
            continue;
        }
        entries.push({
            family,
            y: Number(rawValue),
            key: metricKey
        });
    }

    if (!entries.some((entry) => entry.family === 'baseline')) {
        entries.push({ family: 'baseline', y: 0, key: 'baseline' });
    }

    return entries;
}

/**
 * All geometric vertical metric Y values (core + additional drawable,
 * including non-zero Typo/Hhea line-gap lines). Used for extents, empty-glyph
 * hits, and similar layout math.
 */
export function getVisibleVerticalMetricValues(
    verticalMetrics: Record<string, number> | null | undefined
): number[] {
    const merged = collectUniqueMetricValues(
        verticalMetrics,
        ALL_GEOMETRIC_VERTICAL_METRIC_KEYS,
        { includeBaseline: true }
    );
    for (const value of getAdditionalDrawableVerticalMetricValues(
        verticalMetrics
    )) {
        const alreadyPresent = merged.some(
            (existingValue) => Math.abs(existingValue - value) < 0.25
        );
        if (!alreadyPresent) {
            merged.push(value);
        }
    }
    return merged;
}

/**
 * Metric Y values that should participate in edit-mode snapping: core always,
 * plus additional drawable metrics when Show All Metrics is on.
 */
export function getSnappableVerticalMetricValues(
    verticalMetrics: Record<string, number> | null | undefined,
    includeAdditional: boolean
): number[] {
    const core = getCoreVerticalMetricValues(verticalMetrics);
    if (!includeAdditional) {
        return core;
    }

    const additional =
        getAdditionalDrawableVerticalMetricValues(verticalMetrics);
    const merged = [...core];
    for (const value of additional) {
        const alreadyPresent = merged.some(
            (existingValue) => Math.abs(existingValue - value) < 0.25
        );
        if (!alreadyPresent) {
            merged.push(value);
        }
    }
    return merged;
}

export function getLowestVisibleVerticalMetricValue(
    verticalMetrics: Record<string, number> | null | undefined
): number | null {
    const metricValues = getVisibleVerticalMetricValues(verticalMetrics);
    return metricValues.length ? Math.min(...metricValues) : null;
}

export function getHighestVisibleVerticalMetricValue(
    verticalMetrics: Record<string, number> | null | undefined
): number | null {
    const metricValues = getVisibleVerticalMetricValues(verticalMetrics);
    return metricValues.length ? Math.max(...metricValues) : null;
}

export function isAdditionalMetricsPanelKey(metricKey: string): boolean {
    return ADDITIONAL_METRICS_PANEL_KEY_SET.has(metricKey);
}

/**
 * Station metrics that exist on Glyphs imports but are not useful in Font Info.
 * `baseline` is always 0; italic angle has no meaningful overshoot zone.
 */
export function isHiddenStationMetricsPanelKey(metricKey: string): boolean {
    const normalized = metricKey.trim().toLowerCase();
    return normalized === 'baseline' || normalized === 'italicangle overshoot';
}

const OVERSHOOT_KEY_SUFFIX = ' overshoot';

export interface MetricOvershootBand {
    baseKey: string;
    key: string;
    overshoot: number;
    y: number;
}

function normalizeMetricKey(metricKey: string): string {
    return metricKey.trim().toLowerCase();
}

function isItalicAngleMetricKey(metricKey: string): boolean {
    return normalizeMetricKey(metricKey) === 'italicangle';
}

function isBaselineMetricKey(metricKey: string): boolean {
    return normalizeMetricKey(metricKey) === 'baseline';
}

function metricKeySetHas(keySet: Set<string>, metricKey: string): boolean {
    if (keySet.has(metricKey)) {
        return true;
    }
    const normalized = normalizeMetricKey(metricKey);
    for (const existingKey of keySet) {
        if (normalizeMetricKey(existingKey) === normalized) {
            return true;
        }
    }
    return false;
}

function lookupMetricValue(
    verticalMetrics: Record<string, number>,
    metricKey: string
): number | undefined {
    const exact = verticalMetrics[metricKey];
    if (Number.isFinite(exact)) {
        return exact;
    }
    const normalized = normalizeMetricKey(metricKey);
    for (const [candidateKey, candidateValue] of Object.entries(
        verticalMetrics
    )) {
        if (
            normalizeMetricKey(candidateKey) === normalized &&
            Number.isFinite(candidateValue)
        ) {
            return candidateValue;
        }
    }
    return undefined;
}

function isAdditionalOvershootBaseKey(metricKey: string): boolean {
    return (
        metricKeySetHas(ADDITIONAL_DRAWABLE_VERTICAL_METRIC_KEYS, metricKey) ||
        normalizeMetricKey(metricKey) === 'typolinegap' ||
        normalizeMetricKey(metricKey) === 'hhealinegap'
    );
}

function resolveOvershootBaseY(
    verticalMetrics: Record<string, number>,
    baseKey: string
): number | null {
    if (isItalicAngleMetricKey(baseKey)) {
        return null;
    }
    if (isBaselineMetricKey(baseKey)) {
        return 0;
    }

    const normalized = normalizeMetricKey(baseKey);
    if (normalized === 'typolinegap' || normalized === 'hhealinegap') {
        const spec = LINE_GAP_DRAW_SPECS.find(
            (entry) => normalizeMetricKey(entry.gapKey) === normalized
        );
        if (!spec) {
            return null;
        }
        const gap = lookupMetricValue(verticalMetrics, spec.gapKey);
        const descender = lookupMetricValue(verticalMetrics, spec.descenderKey);
        if (!Number.isFinite(gap) || !Number.isFinite(descender)) {
            return null;
        }
        return (
            resolveDrawableMetricY(spec.descenderKey, descender as number) -
            (gap as number)
        );
    }

    const rawValue = lookupMetricValue(verticalMetrics, baseKey);
    if (!Number.isFinite(rawValue)) {
        return null;
    }
    return resolveDrawableMetricY(baseKey, rawValue as number);
}

/**
 * Alignment-zone bands from `* overshoot` companions. Fill from the metric
 * line at `y` to `y + overshoot` (Glyphs signed overshoot). Skip italic angle
 * and zero overshoots. Additional OS/2 / hhea / typo overshoots are omitted
 * unless `includeAdditional` is true.
 */
export function getMetricOvershootBands(
    verticalMetrics: Record<string, number> | null | undefined,
    includeAdditional = true
): MetricOvershootBand[] {
    if (!verticalMetrics) {
        return [];
    }

    const bands: MetricOvershootBand[] = [];
    for (const [metricKey, overshoot] of Object.entries(verticalMetrics)) {
        if (!normalizeMetricKey(metricKey).endsWith(OVERSHOOT_KEY_SUFFIX)) {
            continue;
        }
        if (!Number.isFinite(overshoot) || overshoot === 0) {
            continue;
        }

        const trimmedKey = metricKey.trim();
        const baseKey = trimmedKey.slice(0, -OVERSHOOT_KEY_SUFFIX.length);
        if (isItalicAngleMetricKey(baseKey)) {
            continue;
        }
        if (!includeAdditional && isAdditionalOvershootBaseKey(baseKey)) {
            continue;
        }

        const y = resolveOvershootBaseY(verticalMetrics, baseKey);
        if (y === null) {
            continue;
        }

        bands.push({
            baseKey,
            key: metricKey,
            overshoot,
            y
        });
    }
    return bands;
}
