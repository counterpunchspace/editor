/**
 * An opt-in record of how collaboration changed this window, for the cloud
 * fuzz and e2e specs: every remote update applied, every committed local
 * change, undo and redo, and every step of the collaborator-cascade preview,
 * with a short fingerprint of each drawing involved.
 *
 * Recording is off unless `window.__collabTrace` exists. The specs create it
 * before the app loads, in any build, staging included; nothing else does,
 * so a normal session pays one property check per event.
 */

export interface CollabTraceEntry {
    sequence: number;
    /** `performance.now()` in milliseconds, rounded. */
    at: number;
    kind: string;
    /** Glyph names the event touched, for filtering. */
    glyphs: string[];
    detail: Record<string, unknown>;
}

export interface CollabTraceState {
    enabled: boolean;
    entries: CollabTraceEntry[];
    sequence?: number;
}

const MAX_ENTRIES = 5000;

function traceState(): CollabTraceState | null {
    const state =
        typeof window !== 'undefined' ? window.__collabTrace : undefined;
    return state?.enabled ? state : null;
}

export function isCollabTraceOn(): boolean {
    return traceState() !== null;
}

/** Record one event; a no-op unless the trace is on. */
export function recordCollabTrace(
    kind: string,
    glyphs: Iterable<string>,
    detail: Record<string, unknown> = {}
): void {
    const state = traceState();
    if (!state) {
        return;
    }
    state.sequence = (state.sequence ?? 0) + 1;
    state.entries.push({
        sequence: state.sequence,
        at: Math.round(performance.now()),
        kind,
        glyphs: [...new Set(glyphs)],
        detail
    });
    if (state.entries.length > MAX_ENTRIES) {
        state.entries.splice(0, state.entries.length - MAX_ENTRIES);
    }
}

function hashString(text: string): string {
    // FNV-1a: enough to tell two drawings apart in a trace.
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

type CanonicalShape =
    | { reference: string; transform: number[] }
    | { closed: boolean; nodes: Array<[number, number, string, number]> };

/** A drawing reduced to what is drawn, independent of ids and defaults. */
export type CanonicalDrawing = {
    width: number | null;
    shapes: CanonicalShape[];
    anchors: Array<[string, number, number]>;
};

const round = (value: unknown): number =>
    typeof value === 'number' ? Math.round(value * 1000) / 1000 : NaN;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function canonicalShape(shape: unknown): CanonicalShape | null {
    const record = asRecord(shape);
    if (!record) {
        return null;
    }
    if (typeof record.reference === 'string') {
        const transform = asRecord(record.transform) ?? {};
        const pair = (value: unknown, fallback: number): number[] =>
            Array.isArray(value)
                ? [round(value[0]), round(value[1])]
                : [fallback, fallback];
        return {
            reference: record.reference,
            // translation, scale, rotation, skew
            transform: [
                ...pair(transform.translation, 0),
                ...pair(transform.scale, 1),
                typeof transform.rotation === 'number'
                    ? round(transform.rotation)
                    : 0,
                ...pair(transform.skew, 0)
            ]
        };
    }
    const nodes = Array.isArray(record.nodes) ? record.nodes : [];
    return {
        closed: record.closed !== false,
        nodes: nodes.map((node) => {
            const point = asRecord(node) ?? {};
            return [
                round(point.x),
                round(point.y),
                String(point.nodetype ?? ''),
                point.smooth === true ? 1 : 0
            ];
        })
    };
}

/** Width, shapes and anchors of a drawing (model object or JSON), or null. */
export function canonicalDrawing(drawing: unknown): CanonicalDrawing | null {
    const source = asRecord(drawing);
    if (!source) {
        return null;
    }
    const record =
        typeof source.toJSON === 'function'
            ? asRecord((source.toJSON as () => unknown)())
            : source;
    if (!record) {
        return null;
    }
    return {
        width: typeof record.width === 'number' ? round(record.width) : null,
        shapes: (Array.isArray(record.shapes) ? record.shapes : [])
            .map(canonicalShape)
            .filter((shape): shape is CanonicalShape => shape !== null),
        anchors: (Array.isArray(record.anchors) ? record.anchors : [])
            .map((anchor): [string, number, number] => {
                const point = asRecord(anchor) ?? {};
                return [
                    String(point.name ?? ''),
                    round(point.x),
                    round(point.y)
                ];
            })
            .sort((left, right) => left[0].localeCompare(right[0]))
    };
}

/** Where two drawings first differ, in words, or null when they match. */
export function describeDrawingDifference(
    left: CanonicalDrawing | null,
    right: CanonicalDrawing | null
): string | null {
    if (!left || !right) {
        return left === right
            ? null
            : `${left ? 'only left' : 'only right'} exists`;
    }
    if (left.width !== right.width) {
        return `width ${left.width} vs ${right.width}`;
    }
    const shapeCount = Math.max(left.shapes.length, right.shapes.length);
    for (let index = 0; index < shapeCount; index += 1) {
        const a = JSON.stringify(left.shapes[index] ?? null);
        const b = JSON.stringify(right.shapes[index] ?? null);
        if (a !== b) {
            return `shape ${index}: ${a.slice(0, 300)} vs ${b.slice(0, 300)}`;
        }
    }
    const anchorsLeft = JSON.stringify(left.anchors);
    const anchorsRight = JSON.stringify(right.anchors);
    if (anchorsLeft !== anchorsRight) {
        return `anchors ${anchorsLeft} vs ${anchorsRight}`;
    }
    return null;
}

/**
 * `w<width> #<hash>` of a drawing's canonical form, so the model's and the
 * documents' fingerprints of one drawing compare; `-` for a missing drawing.
 */
export function drawingFingerprint(drawing: unknown): string {
    const canonical = canonicalDrawing(drawing);
    if (!canonical) {
        return '-';
    }
    return `w${canonical.width} #${hashString(JSON.stringify(canonical))}`;
}
