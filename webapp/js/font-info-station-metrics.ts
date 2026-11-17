// Station metrics in Font info: vertical metrics with their zones, metrics for
// one writing script (Glyphs metric filters), and line spacing.
//
// What the compiler does with each value comes from babelfont's fontir bridge
// and fontc: xHeight/capHeight go to OS/2, ascender/descender only feed the
// line-spacing defaults, zones (`* overshoot`) and script metrics are never
// compiled, and empty line-spacing values are derived as in
// `lineSpacingDefaults`.

import {
    ADDITIONAL_METRICS_PANEL_KEY_SET,
    parseScopedMetricKey
} from './glyph-canvas/vertical-metrics';

export interface CoreMetricSpec {
    /** Type name as Babelfont writes it in custom keys (`xHeight`). */
    type: string;
    label: string;
    /** Key a new value is stored under (the Babelfont JSON variant name). */
    nativeKey: string;
    helper: string;
}

export const CORE_STATION_METRICS: CoreMetricSpec[] = [
    {
        type: 'ascender',
        label: 'Ascender',
        nativeKey: 'Ascender',
        helper: 'Not written as is. Empty line-spacing values are derived from it.'
    },
    {
        type: 'capHeight',
        label: 'Cap height',
        nativeKey: 'CapHeight',
        helper: 'Written to OS/2 sCapHeight.'
    },
    {
        type: 'xHeight',
        label: 'x-height',
        nativeKey: 'XHeight',
        helper: 'Written to OS/2 sxHeight.'
    },
    {
        type: 'baseline',
        label: 'Baseline',
        nativeKey: 'baseline',
        helper: 'Always 0. Only its zone can be set.'
    },
    {
        type: 'descender',
        label: 'Descender',
        nativeKey: 'Descender',
        helper: 'Not written as is. Empty line-spacing values are derived from it.'
    }
];

/** Metric types a writing script can override, as in Glyphs. */
export const SCRIPT_METRIC_TYPES = CORE_STATION_METRICS.filter(
    (spec) => spec.type !== 'baseline'
);

const ITALIC_ANGLE_KEYS = ['ItalicAngle', 'italicAngle'];

/**
 * Writing scripts Glyphs can scope metrics to, by their Glyphs names.
 * Labels are what Font info shows.
 */
export const GLYPHS_METRIC_SCRIPTS: Array<[string, string]> = [
    ['latin', 'Latin'],
    ['cyrillic', 'Cyrillic'],
    ['greek', 'Greek'],
    ['arabic', 'Arabic'],
    ['hebrew', 'Hebrew'],
    ['syriac', 'Syriac'],
    ['thaana', 'Thaana'],
    ['armenian', 'Armenian'],
    ['georgian', 'Georgian'],
    ['devanagari', 'Devanagari'],
    ['bengali', 'Bengali'],
    ['gurmukhi', 'Gurmukhi'],
    ['gujarati', 'Gujarati'],
    ['oriya', 'Oriya'],
    ['tamil', 'Tamil'],
    ['telugu', 'Telugu'],
    ['kannada', 'Kannada'],
    ['malayalam', 'Malayalam'],
    ['sinhala', 'Sinhala'],
    ['thai', 'Thai'],
    ['lao', 'Lao'],
    ['khmer', 'Khmer'],
    ['myanmar', 'Myanmar'],
    ['tibet', 'Tibetan'],
    ['han', 'Han'],
    ['kana', 'Hiragana and Katakana'],
    ['hangul', 'Hangul'],
    ['ethiopic', 'Ethiopic'],
    ['cherokee', 'Cherokee'],
    ['canadian', 'Canadian Aboriginal'],
    ['nko', 'N’Ko'],
    ['adlam', 'Adlam'],
    ['tifinagh', 'Tifinagh'],
    ['mongolian', 'Mongolian']
];

export function glyphsScriptLabel(script: string): string {
    const known = GLYPHS_METRIC_SCRIPTS.find(([name]) => name === script);
    if (known) {
        return known[1];
    }
    return script.charAt(0).toUpperCase() + script.slice(1);
}

function normalize(key: string): string {
    return key.trim().toLowerCase();
}

/** The existing key for any of `candidates`, compared without case. */
export function findMetricKey(
    metrics: Record<string, number>,
    candidates: string[]
): string | undefined {
    const wanted = new Set(candidates.map(normalize));
    return Object.keys(metrics).find((key) => wanted.has(normalize(key)));
}

/** Key of the value for `spec`, existing or the one a new value gets. */
export function coreMetricKey(
    metrics: Record<string, number>,
    spec: CoreMetricSpec
): string {
    return (
        findMetricKey(metrics, [spec.nativeKey, spec.type]) ?? spec.nativeKey
    );
}

/** Key of the zone for `spec`, existing or `<type> overshoot`. */
export function coreZoneKey(
    metrics: Record<string, number>,
    spec: CoreMetricSpec
): string {
    const candidates = [spec.nativeKey, spec.type].map(
        (base) => `${base} overshoot`
    );
    return findMetricKey(metrics, candidates) ?? `${spec.type} overshoot`;
}

export function italicAngleKey(metrics: Record<string, number>): string {
    return findMetricKey(metrics, ITALIC_ANGLE_KEYS) ?? 'ItalicAngle';
}

/** Writing scripts that have at least one scoped metric, in list order. */
export function scriptsWithMetrics(metrics: Record<string, number>): string[] {
    const scripts = new Set<string>();
    for (const key of Object.keys(metrics)) {
        const scoped = parseScopedMetricKey(key);
        if (scoped?.script) {
            scripts.add(scoped.script);
        }
    }
    const order = GLYPHS_METRIC_SCRIPTS.map(([name]) => name);
    return [...scripts].sort((left, right) => {
        const leftIndex = order.indexOf(left);
        const rightIndex = order.indexOf(right);
        if (leftIndex === -1 && rightIndex === -1) {
            return left.localeCompare(right);
        }
        if (leftIndex === -1) return 1;
        if (rightIndex === -1) return -1;
        return leftIndex - rightIndex;
    });
}

/** Keys Font info shows in its own fields, so not under “Other metrics”. */
export function isStructuredStationMetricKey(metricKey: string): boolean {
    const key = normalize(metricKey);
    const base = key.endsWith(' overshoot')
        ? key.slice(0, -' overshoot'.length)
        : key;
    if (parseScopedMetricKey(metricKey)?.script) {
        return true;
    }
    if (base === 'italicangle') {
        return true;
    }
    if (
        CORE_STATION_METRICS.some(
            (spec) =>
                normalize(spec.nativeKey) === base ||
                normalize(spec.type) === base
        )
    ) {
        return true;
    }
    return [...ADDITIONAL_METRICS_PANEL_KEY_SET].some(
        (additional) => normalize(additional) === key
    );
}

export interface LineSpacingValues {
    TypoAscender: number;
    TypoDescender: number;
    TypoLineGap: number;
    HheaAscender: number;
    HheaDescender: number;
    HheaLineGap: number;
    WinAscent: number;
    WinDescent: number;
}

function metricValue(
    metrics: Record<string, number>,
    candidates: string[]
): number | undefined {
    const key = findMetricKey(metrics, candidates);
    const value = key === undefined ? undefined : metrics[key];
    return Number.isFinite(value) ? value : undefined;
}

/**
 * What fontc writes for each line-spacing value the station leaves empty.
 * Mirrors fontir's defaults: ascender/descender fall back to 800/-200
 * (babelfont), the typo line gap fills the rest of 1.2 em, hhea and Win
 * ascent add that gap, and Win descent is the descender's size.
 */
export function lineSpacingDefaults(
    metrics: Record<string, number>,
    upm: number
): LineSpacingValues {
    const ascender = metricValue(metrics, ['Ascender', 'ascender']) ?? 800;
    const descender = metricValue(metrics, ['Descender', 'descender']) ?? -200;
    const typoAscender = metricValue(metrics, ['TypoAscender']) ?? ascender;
    const typoDescender = metricValue(metrics, ['TypoDescender']) ?? descender;
    const typoLineGap =
        metricValue(metrics, ['TypoLineGap']) ??
        Math.max(0, Math.round(1.2 * upm + descender - ascender));
    return {
        TypoAscender: typoAscender,
        TypoDescender: typoDescender,
        TypoLineGap: typoLineGap,
        HheaAscender: ascender + typoLineGap,
        HheaDescender: descender,
        HheaLineGap: 0,
        WinAscent: ascender + typoLineGap,
        WinDescent: Math.abs(descender)
    };
}

export interface MetricsPreviewInput {
    lines: Array<{ label: string; y: number; zone: number }>;
    italicAngle: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgElement<K extends keyof SVGElementTagNameMap>(
    name: K,
    attributes: Record<string, string | number>
): SVGElementTagNameMap[K] {
    const element = document.createElementNS(SVG_NS, name);
    for (const [attribute, value] of Object.entries(attributes)) {
        element.setAttribute(attribute, String(value));
    }
    return element;
}

/**
 * A small drawing of the metric lines with their zones. A non-zero italic
 * angle adds a slanted line through the x-height (positive leans right).
 */
export function createMetricsPreview(
    input: MetricsPreviewInput
): SVGSVGElement {
    const width = 220;
    const height = 300;
    const values = input.lines.flatMap((line) => [line.y, line.y + line.zone]);
    const top = Math.max(...values, 0) + 60;
    const bottom = Math.min(...values, 0) - 60;
    const span = top - bottom || 1;
    const toY = (value: number): number => 10 + ((top - value) / span) * 280;

    const svg = svgElement('svg', {
        'class': 'fontinfo-metrics-preview',
        width,
        height,
        'viewBox': `0 0 ${width} ${height}`,
        'role': 'img',
        'aria-label': 'Preview of the vertical metrics and their zones'
    });

    for (const line of input.lines) {
        if (line.zone !== 0) {
            const y1 = toY(line.y);
            const y2 = toY(line.y + line.zone);
            svg.appendChild(
                svgElement('rect', {
                    class: 'fontinfo-metrics-preview-zone',
                    x: 10,
                    y: Math.min(y1, y2),
                    width: width - 20,
                    // Zones are small; keep them visible at preview scale.
                    height: Math.max(3, Math.abs(y2 - y1))
                })
            );
        }
    }

    for (const line of input.lines) {
        const y = toY(line.y);
        svg.appendChild(
            svgElement('line', {
                class: 'fontinfo-metrics-preview-line',
                x1: 10,
                x2: width - 10,
                y1: y,
                y2: y
            })
        );
        const label = svgElement('text', {
            class: 'fontinfo-metrics-preview-label',
            x: 14,
            y: y - 4
        });
        label.textContent = `${line.label} ${line.y}`;
        svg.appendChild(label);
    }

    if (input.italicAngle !== 0 && Number.isFinite(input.italicAngle)) {
        const xHeight =
            input.lines.find((line) => line.label === 'x-height')?.y ??
            Math.max(...input.lines.map((line) => line.y));
        const baseY = toY(0);
        const topY = toY(xHeight);
        const run =
            Math.tan((input.italicAngle * Math.PI) / 180) * (baseY - topY);
        const x = width / 2;
        svg.appendChild(
            svgElement('line', {
                class: 'fontinfo-metrics-preview-slant',
                x1: x - run / 2,
                y1: baseY,
                x2: x + run / 2,
                y2: topY
            })
        );
        const angleLabel = svgElement('text', {
            class: 'fontinfo-metrics-preview-label',
            x: x + run / 2 + 4,
            y: topY + 12
        });
        angleLabel.textContent = `${input.italicAngle}°`;
        svg.appendChild(angleLabel);
    }

    return svg;
}
