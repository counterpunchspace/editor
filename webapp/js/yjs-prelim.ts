/**
 * Read Y.Map / Y.Array contents without triggering Yjs
 * `warnPrematureAccess` while types are still prelim (not yet on a Doc).
 */

import * as Y from 'yjs';

function prelimMap(map: Y.Map<unknown>): Map<string, unknown> | undefined {
    return (map as unknown as { _prelimContent?: Map<string, unknown> })
        ._prelimContent;
}

function prelimArray(arr: Y.Array<unknown>): unknown[] | undefined {
    return (arr as unknown as { _prelimContent?: unknown[] })._prelimContent;
}

export function yMapGet(map: Y.Map<unknown>, key: string): unknown {
    if (map.doc) {
        return map.get(key);
    }
    return prelimMap(map)?.get(key);
}

export function yMapHas(map: Y.Map<unknown>, key: string): boolean {
    if (map.doc) {
        return map.has(key);
    }
    return Boolean(prelimMap(map)?.has(key));
}

export function yMapKeys(map: Y.Map<unknown>): string[] {
    if (map.doc) {
        return Array.from(map.keys());
    }
    const prelim = prelimMap(map);
    return prelim ? Array.from(prelim.keys()) : [];
}

export function yMapForEach(
    map: Y.Map<unknown>,
    fn: (value: unknown, key: string, map: Y.Map<unknown>) => void
): void {
    if (map.doc) {
        map.forEach(fn);
        return;
    }
    prelimMap(map)?.forEach((value: unknown, key: string) => {
        fn(value, key, map);
    });
}

export function yArrayToArray(arr: Y.Array<unknown>): unknown[] {
    if (arr.doc) {
        return arr.toArray();
    }
    return [...(prelimArray(arr) ?? [])];
}
