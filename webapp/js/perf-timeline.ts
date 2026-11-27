const MARK_PREFIX = 'cp';

type TimelineContext = {
    process?: string;
    traceId?: string;
    parentSpanId?: string;
    requestId?: string;
    fontRevisionKey?: string;
};

type TimelineSpanState = {
    stage: string;
    startMark: string;
    contextSuffix: string;
};

type TimelineSpanOptions = {
    detail?: TimelineDetail;
    context?: TimelineContext;
};

const activeSpans: Map<string, TimelineSpanState> = new Map();
let spanCounter = 0;
let timelineEntryCounter = 0;

const TIMELINE_PRUNE_INTERVAL = 200;
const TIMELINE_MAX_RETAINED_ENTRIES = 200;

function isRetainedLifecycleLabel(label: string): boolean {
    return label.startsWith(`${MARK_PREFIX}:font.lifecycle.`);
}

function prunePerformanceTimelineIfNeeded(): void {
    timelineEntryCounter += 1;
    if (timelineEntryCounter % TIMELINE_PRUNE_INTERVAL !== 0) {
        return;
    }
    const perf = globalThis.performance;
    if (!perf || typeof perf.getEntriesByType !== 'function') {
        return;
    }
    if (typeof perf.clearMarks === 'function') {
        const marks = perf.getEntriesByType('mark');
        const excess = marks.length - TIMELINE_MAX_RETAINED_ENTRIES;
        if (excess > 0) {
            const activeStartMarks = new Set<string>();
            for (const span of activeSpans.values()) {
                activeStartMarks.add(span.startMark);
            }
            let cleared = 0;
            for (let i = 0; i < marks.length && cleared < excess; i++) {
                const name = marks[i].name;
                if (
                    !isCodeLoadingLabel(name) &&
                    !isRetainedLifecycleLabel(name) &&
                    !activeStartMarks.has(name)
                ) {
                    perf.clearMarks(name);
                    cleared += 1;
                }
            }
        }
    }
    if (typeof perf.clearMeasures === 'function') {
        const measures = perf.getEntriesByType('measure');
        const excess = measures.length - TIMELINE_MAX_RETAINED_ENTRIES;
        if (excess > 0) {
            let cleared = 0;
            for (let i = 0; i < measures.length && cleared < excess; i++) {
                const name = measures[i].name;
                if (
                    !isCodeLoadingLabel(name) &&
                    !isRetainedLifecycleLabel(name)
                ) {
                    perf.clearMeasures(name);
                    cleared += 1;
                }
            }
        }
    }
}

type TimelineDetail = Record<string, unknown>;

function toLabel(stage: string): string {
    return `${MARK_PREFIX}:${stage}`;
}

function sanitizeContextPart(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
        return null;
    }
    return normalized.replace(/[|=:#\s]+/g, '_');
}

function contextSuffix(context?: TimelineContext): string {
    if (!context) {
        return '';
    }

    const entries: Array<[string, string | null]> = [
        ['proc', sanitizeContextPart(context.process)],
        ['trace', sanitizeContextPart(context.traceId)],
        ['parent', sanitizeContextPart(context.parentSpanId)],
        ['req', sanitizeContextPart(context.requestId)],
        ['rev', sanitizeContextPart(context.fontRevisionKey)]
    ];

    const parts = entries
        .filter(([, value]) => !!value)
        .map(([key, value]) => `${key}=${value}`);
    return parts.length > 0 ? `|${parts.join('|')}` : '';
}

function normalizeSpanOptions(
    detailOrOptions?: TimelineDetail | TimelineSpanOptions,
    explicitContext?: TimelineContext
): TimelineSpanOptions {
    if (!detailOrOptions) {
        return { context: explicitContext };
    }

    const candidate = detailOrOptions as TimelineSpanOptions;
    const candidateKeys = Object.keys(candidate as Record<string, unknown>);
    const hasOptionsShape =
        typeof detailOrOptions === 'object' &&
        detailOrOptions !== null &&
        ('detail' in candidate || 'context' in candidate) &&
        candidateKeys.every((key) => key === 'detail' || key === 'context');

    if (hasOptionsShape) {
        return {
            detail: candidate.detail,
            context: explicitContext ?? candidate.context
        };
    }

    return {
        detail: detailOrOptions as TimelineDetail,
        context: explicitContext
    };
}

function safeTimeStamp(label: string): void {
    try {
        globalThis.console?.timeStamp?.(label);
    } catch {
        // Ignore browsers without timestamp support
    }
}

function canMark(): boolean {
    return typeof globalThis.performance?.mark === 'function';
}

function canMeasure(): boolean {
    return typeof globalThis.performance?.measure === 'function';
}

export function timelineMark(stage: string, context?: TimelineContext): void {
    const label = toLabel(stage) + contextSuffix(context);
    if (canMark()) {
        globalThis.performance.mark(label);
        prunePerformanceTimelineIfNeeded();
    }
    safeTimeStamp(label);
}

export function timelineSpanStart(
    stage: string,
    detailOrOptions?: TimelineDetail | TimelineSpanOptions,
    explicitContext?: TimelineContext
): string {
    const options = normalizeSpanOptions(detailOrOptions, explicitContext);
    const suffix = contextSuffix(options.context);
    spanCounter += 1;
    const spanId = `${stage}#${spanCounter}`;
    const startMark = toLabel(`${spanId}:start`) + suffix;

    activeSpans.set(spanId, { stage, startMark, contextSuffix: suffix });
    if (canMark()) {
        if (options.detail !== undefined) {
            globalThis.performance.mark(startMark, { detail: options.detail });
        } else {
            globalThis.performance.mark(startMark);
        }
    }
    safeTimeStamp(startMark);

    return spanId;
}

export function timelineSpanEnd(spanId: string): void {
    const activeSpan = activeSpans.get(spanId);
    if (!activeSpan) {
        return;
    }

    const endMark = toLabel(`${spanId}:end`) + activeSpan.contextSuffix;
    if (canMark()) {
        globalThis.performance.mark(endMark);
    }
    if (canMeasure()) {
        try {
            globalThis.performance.measure(
                toLabel(activeSpan.stage) + activeSpan.contextSuffix,
                activeSpan.startMark,
                endMark
            );
        } catch {
            // Ignore if the start mark was externally cleared while the span was open.
        }
        prunePerformanceTimelineIfNeeded();
    }
    safeTimeStamp(endMark);

    activeSpans.delete(spanId);
}

export type CodeLoadingTimelineEntry = {
    name: string;
    startTime: number;
    duration?: number;
};

export type CodeLoadingResourceEntry = {
    name: string;
    initiator: string;
    startTime: number;
    duration: number;
    transferSize: number;
    encodedBodySize: number;
    decodedBodySize: number;
};

export type CodeLoadingTimelineDump = {
    now: number;
    navigation: {
        type: string;
        fetchStart: number;
        responseEnd: number;
        domInteractive: number;
        domContentLoaded: number;
        loadEventEnd: number;
        transferSize: number;
    } | null;
    marks: CodeLoadingTimelineEntry[];
    measures: CodeLoadingTimelineEntry[];
    resources: CodeLoadingResourceEntry[];
};

const CODE_LOADING_MARK_PREFIXES = [
    'cp:app.html.',
    'cp:app.head',
    'cp:app.body',
    'cp:app.afterFirstPaint',
    'cp:app.bootstrap.',
    'cp:app.domContentLoaded',
    'cp:python.'
];

function roundMs(value: number): number {
    return Math.round(value * 10) / 10;
}

function isCodeLoadingLabel(name: string): boolean {
    return CODE_LOADING_MARK_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function shortenResourceName(url: string): string {
    return url
        .replace(/^https:\/\/cdn\.jsdelivr\.net/, 'jsdelivr')
        .replace(/^https?:\/\/[^/]+/, '');
}

function isCodeLoadingResource(entry: PerformanceResourceTiming): boolean {
    const name = entry.name;
    if (/\.(woff2?|ttf|otf)(\?|$)/i.test(name)) {
        return false;
    }
    if (
        entry.initiatorType === 'script' ||
        entry.initiatorType === 'link' ||
        entry.initiatorType === 'css'
    ) {
        return (
            /\.(js|css|wasm|zip|whl|py|json)(\?|$)/i.test(name) ||
            name.includes('pyodide') ||
            name.includes('/npm/')
        );
    }
    return (
        /\.(js|wasm|zip|whl|py)(\?|$)/i.test(name) ||
        name.includes('pyodide') ||
        name.includes('/wheels/')
    );
}

export function dumpCodeLoadingTimeline(): CodeLoadingTimelineDump {
    const navigationEntry = performance.getEntriesByType('navigation')[0] as
        PerformanceNavigationTiming | undefined;

    const marks = performance
        .getEntriesByType('mark')
        .filter((entry) => isCodeLoadingLabel(entry.name))
        .map((entry) => ({
            name: entry.name,
            startTime: roundMs(entry.startTime)
        }));

    const measures = performance
        .getEntriesByType('measure')
        .filter((entry) => isCodeLoadingLabel(entry.name))
        .map((entry) => ({
            name: entry.name,
            startTime: roundMs(entry.startTime),
            duration: roundMs(entry.duration)
        }));

    const resources = performance
        .getEntriesByType('resource')
        .filter((entry): entry is PerformanceResourceTiming =>
            isCodeLoadingResource(entry as PerformanceResourceTiming)
        )
        .map((entry) => ({
            name: shortenResourceName(entry.name),
            initiator: entry.initiatorType,
            startTime: roundMs(entry.startTime),
            duration: roundMs(entry.duration),
            transferSize: entry.transferSize,
            encodedBodySize: entry.encodedBodySize,
            decodedBodySize: entry.decodedBodySize
        }))
        .sort((a, b) => a.startTime - b.startTime);

    return {
        now: roundMs(performance.now()),
        navigation: navigationEntry
            ? {
                  type: navigationEntry.type,
                  fetchStart: roundMs(navigationEntry.fetchStart),
                  responseEnd: roundMs(navigationEntry.responseEnd),
                  domInteractive: roundMs(navigationEntry.domInteractive),
                  domContentLoaded: roundMs(
                      navigationEntry.domContentLoadedEventEnd
                  ),
                  loadEventEnd: roundMs(navigationEntry.loadEventEnd),
                  transferSize: navigationEntry.transferSize
              }
            : null,
        marks,
        measures,
        resources
    };
}

if (typeof window !== 'undefined') {
    window.timelineMark = timelineMark;
    window.timelineSpanStart = timelineSpanStart;
    window.timelineSpanEnd = timelineSpanEnd;
    window.dumpCodeLoadingTimeline = dumpCodeLoadingTimeline;
}
