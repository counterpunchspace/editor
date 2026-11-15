/**
 * Carrying edits over from the rooms a rebase moved away from.
 *
 * A rebase copies the catalog or kerning rooms into new ones and then points
 * every window at them. An edit that reaches an old room after the copy
 * (made while the copy was being stored, or by a window that had not yet
 * switched) is not in the new rooms. Any window that holds the old room can
 * find such edits: items the copy's snapshot did not know, and deletions it
 * did not know. Their keys' current values are written to the new rooms,
 * unless the new room's value was edited since the move, which is the newer
 * edit and stays.
 *
 * Compacted rooms drop the content of overwritten values, so nothing here
 * reads old values: only item ids and the current state.
 */

import * as Y from 'yjs';

/** What a rebase stores about one room it copied. */
export type MovedRoomRecord = { at: number; snapshot: string };
/** What a rebase stores about one room it filled. */
export type SeededRoomRecord = { at: number; client: number; clock: number };

/** The root map key an item belongs to, or null outside that map. */
function rootKeyOf(item: Y.Item, root: Y.Map<unknown>): string | null {
    let current: Y.Item = item;
    for (let depth = 0; depth < 64; depth += 1) {
        const parent = current.parent as Y.AbstractType<unknown> | null;
        if (!parent || typeof parent !== 'object') {
            return null;
        }
        if (parent === (root as unknown)) {
            return current.parentSub;
        }
        const up = parent._item;
        if (!up) {
            return null;
        }
        current = up;
    }
    return null;
}

/**
 * Keys of `root` that changed after `snapshot` was taken: a value set or
 * edited inside, or deleted, by any client.
 */
export function keysChangedSinceSnapshot(
    doc: Y.Doc,
    root: Y.Map<unknown>,
    snapshot: Y.Snapshot
): Set<string> {
    const keys = new Set<string>();
    doc.store.clients.forEach((structs, client) => {
        const known = snapshot.sv.get(client) ?? 0;
        for (const struct of structs) {
            if (!(struct instanceof Y.Item)) {
                continue;
            }
            const createdLate = struct.id.clock + struct.length > known;
            const deletedLate =
                struct.deleted && !Y.isDeleted(snapshot.ds, struct.id);
            if (!createdLate && !deletedLate) {
                continue;
            }
            const key = rootKeyOf(struct, root);
            if (key !== null) {
                keys.add(key);
            }
        }
    });
    return keys;
}

/**
 * True when a root map entry is still exactly what the move copied: the
 * entry's item and everything inside it are the seed's, none deleted.
 */
export function isUntouchedSeedEntry(
    item: Y.Item,
    seed: SeededRoomRecord
): boolean {
    const isSeed = (candidate: Y.Item) =>
        !candidate.deleted &&
        candidate.id.client === seed.client &&
        candidate.id.clock < seed.clock;
    const walk = (candidate: Y.Item): boolean => {
        if (!isSeed(candidate)) {
            return false;
        }
        if (candidate.content instanceof Y.ContentType) {
            const type = candidate.content.type;
            for (const child of type._map.values()) {
                if (!walk(child)) {
                    return false;
                }
            }
            for (let child = type._start; child; child = child.right) {
                if (!walk(child)) {
                    return false;
                }
            }
        }
        return true;
    };
    return walk(item);
}

/** A Y value as JSON; undefined when absent. */
export function yValueJson(value: unknown): unknown {
    return value instanceof Y.AbstractType ? value.toJSON() : value;
}

/** JSON with sorted keys, so equal values compare equal. */
export function stableJson(value: unknown): string {
    if (value === undefined) {
        return 'undefined';
    }
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableJson).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
        .join(',')}}`;
}

/** A forwarded value as stored in the `forwarded` map. */
export type ForwardedValue = { value?: unknown; deleted?: true };

export function forwardedValueOf(value: unknown): ForwardedValue {
    return value === undefined ? { deleted: true } : { value };
}

export function forwardedValueMatches(
    stored: unknown,
    current: unknown
): boolean {
    if (!stored || typeof stored !== 'object') {
        return false;
    }
    const record = stored as ForwardedValue;
    if (record.deleted) {
        return current === undefined;
    }
    return stableJson(record.value) === stableJson(current);
}
