/**
 * Remote cloud updates that land while Python is running also change the live
 * font. Fold those paths into the pre-Python snapshot so the post-Python diff
 * records only what the script changed.
 */

function segmentsOf(path: string): string[] {
    return path.split('/').filter((segment) => segment.length > 0);
}

function child(
    current: unknown,
    segment: string
): { found: boolean; value: unknown } {
    if (Array.isArray(current)) {
        const named = current.find(
            (item) =>
                !!item &&
                typeof item === 'object' &&
                (item as { name?: unknown }).name === segment
        );
        if (named) return { found: true, value: named };
        const index = Number(segment);
        if (Number.isInteger(index) && index >= 0 && index < current.length) {
            return { found: true, value: current[index] };
        }
        return { found: false, value: undefined };
    }
    if (!current || typeof current !== 'object') {
        return { found: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        return { found: false, value: undefined };
    }
    return {
        found: true,
        value: (current as Record<string, unknown>)[segment]
    };
}

function readPath(
    root: unknown,
    segments: string[]
): {
    found: boolean;
    value: unknown;
} {
    let current = root;
    for (const segment of segments) {
        const next = child(current, segment);
        if (!next.found) return next;
        current = next.value;
    }
    return { found: true, value: current };
}

function writePath(root: unknown, segments: string[], value: unknown): boolean {
    if (!segments.length) return false;
    let current = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
        const next = child(current, segments[index]);
        if (!next.found || !next.value || typeof next.value !== 'object') {
            return false;
        }
        current = next.value;
    }
    const leaf = segments[segments.length - 1];
    if (Array.isArray(current)) {
        const index = Number(leaf);
        if (
            Number.isInteger(index) &&
            String(index) === leaf &&
            index >= 0 &&
            index < current.length
        ) {
            current[index] = value;
            return true;
        }
        const namedIndex = current.findIndex(
            (item) =>
                !!item &&
                typeof item === 'object' &&
                (item as { name?: unknown }).name === leaf
        );
        if (namedIndex >= 0) {
            current[namedIndex] = value;
            return true;
        }
        return false;
    }
    if (!current || typeof current !== 'object') return false;
    (current as Record<string, unknown>)[leaf] = value;
    return true;
}

function deletePath(root: unknown, segments: string[]): boolean {
    if (!segments.length || !root || typeof root !== 'object') return false;
    let current: unknown = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
        const next = child(current, segments[index]);
        if (!next.found) return false;
        current = next.value;
    }
    const leaf = segments[segments.length - 1];
    if (Array.isArray(current)) return false;
    if (!current || typeof current !== 'object') return false;
    if (!Object.prototype.hasOwnProperty.call(current, leaf)) return false;
    delete (current as Record<string, unknown>)[leaf];
    return true;
}

export function rebasePythonExecutionBaseline(
    beforeFontDataJson: string,
    fontJson: unknown,
    paths: string[]
): string {
    if (!paths.length || !fontJson || typeof fontJson !== 'object') {
        return beforeFontDataJson;
    }
    let before: unknown;
    try {
        before = JSON.parse(beforeFontDataJson);
    } catch {
        return beforeFontDataJson;
    }
    let changed = false;
    for (const path of paths) {
        const segments = segmentsOf(path);
        if (!segments.length) {
            return JSON.stringify(fontJson);
        }
        const source = readPath(fontJson, segments);
        const cloned = source.found
            ? JSON.parse(JSON.stringify(source.value))
            : undefined;
        if (source.found) {
            changed = writePath(before, segments, cloned) || changed;
        } else {
            changed = deletePath(before, segments) || changed;
        }
    }
    return changed ? JSON.stringify(before) : beforeFontDataJson;
}
