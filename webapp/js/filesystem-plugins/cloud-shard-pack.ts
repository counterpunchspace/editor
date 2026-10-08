/**
 * Browser-side shard pack helpers.
 * Codec is generated from collab/packages/protocol — import from generated pack.
 * partitionPackItems* are editor-only batching helpers.
 */

import {
    PACK_MAGIC,
    PACK_CONTENT_TYPE,
    PACK_DIGEST_BYTES,
    PACK_MAX_SHARD_ID_BYTES,
    PACK_MAX_SHARDS,
    PACK_MAX_BYTES,
    SEED_PACK_MAX_SHARDS,
    SEED_PACK_MAX_BYTES,
    LARGE_SHARD_BYTES,
    PACK_FRAME_TYPE,
    concatBytes,
    hexToBytes,
    bytesToHex,
    encodePackFrame,
    encodePackShardFrame,
    encodePackEndFrame,
    encodePackBody,
    createPackParser
} from '../generated/collab-protocol-pack';

export {
    PACK_MAGIC,
    PACK_CONTENT_TYPE,
    PACK_DIGEST_BYTES,
    PACK_MAX_SHARD_ID_BYTES,
    PACK_MAX_SHARDS,
    PACK_MAX_BYTES,
    SEED_PACK_MAX_SHARDS,
    SEED_PACK_MAX_BYTES,
    LARGE_SHARD_BYTES,
    PACK_FRAME_TYPE,
    concatBytes,
    hexToBytes,
    bytesToHex,
    encodePackFrame,
    encodePackShardFrame,
    encodePackEndFrame,
    encodePackBody,
    createPackParser
};

/** Prefer a live TextEncoder — generated module may capture one too early under Jest. */
export function encodePackErrorFrame(
    error:
        | { error?: string; shardId?: string; [key: string]: unknown }
        | null
        | undefined
) {
    const json = JSON.stringify(error || { error: 'pack error' });
    const payload = Uint8Array.from(Array.from(json, (ch) => ch.charCodeAt(0)));
    return encodePackFrame({
        type: PACK_FRAME_TYPE.ERROR,
        shardId: (error && error.shardId) || '',
        payload
    });
}

/** Room rejects the HTTP body at 8 MiB. Frame headers and the end frame sit on top of the payloads. */
export const SEED_PACK_FRAMING_SLACK = 1024 * 1024;

export function seedPackByteBudget(
    maxBytes: number = SEED_PACK_MAX_BYTES
): number {
    return Math.max(1, maxBytes - SEED_PACK_FRAMING_SLACK);
}

export type PackFrame = {
    type: number;
    missing: boolean;
    shardId: string;
    digest: Uint8Array;
    digestHex: string;
    payload: Uint8Array;
    receipt: Record<string, unknown> | null;
    count: number;
};

export function partitionPackItems<T>(
    items: readonly T[],
    byteLengthOf: (item: T) => number,
    maxItems: number,
    maxBytes: number
): T[][] {
    const itemCap = Math.min(maxItems, PACK_MAX_SHARDS);
    const batches: T[][] = [];
    let current: T[] = [];
    let bytes = 0;
    const flush = () => {
        if (current.length) {
            batches.push(current);
            current = [];
            bytes = 0;
        }
    };
    for (const item of items) {
        const size = byteLengthOf(item);
        if (size >= LARGE_SHARD_BYTES) {
            flush();
            batches.push([item]);
            continue;
        }
        if (
            current.length &&
            (current.length >= itemCap || bytes + size > maxBytes)
        ) {
            flush();
        }
        current.push(item);
        bytes += size;
    }
    flush();
    return batches;
}

/**
 * One request can only wait on six R2 operations. Spread a font that fits in
 * one byte budget across `lanes` packs so those requests run together.
 * A shard at or above LARGE_SHARD_BYTES stays in a pack by itself.
 */
export function spreadPackItems<T>(
    items: readonly T[],
    byteLengthOf: (item: T) => number,
    maxItems: number,
    maxBytes: number,
    lanes: number
): T[][] {
    const capped = partitionPackItems(items, byteLengthOf, maxItems, maxBytes);
    const laneCount = Math.max(1, Math.floor(lanes) || 1);
    if (capped.length >= laneCount) {
        return capped;
    }
    const exclusive = capped.filter(
        (batch) =>
            batch.length === 1 && byteLengthOf(batch[0]) >= LARGE_SHARD_BYTES
    );
    const shared = capped
        .filter(
            (batch) =>
                !(
                    batch.length === 1 &&
                    byteLengthOf(batch[0]) >= LARGE_SHARD_BYTES
                )
        )
        .flat();
    if (shared.length <= 1) {
        return capped;
    }
    const groupCount = Math.min(laneCount, shared.length);
    const groups: T[][] = Array.from({ length: groupCount }, () => []);
    const used = Array.from({ length: groupCount }, () => 0);
    const counts = Array.from({ length: groupCount }, () => 0);
    const overflow: T[] = [];
    for (const item of shared) {
        const size = byteLengthOf(item);
        let lane = 0;
        for (let index = 1; index < groupCount; index += 1) {
            if (used[index] < used[lane]) {
                lane = index;
            }
        }
        if (
            counts[lane] > 0 &&
            (counts[lane] >= maxItems || used[lane] + size > maxBytes)
        ) {
            overflow.push(item);
            continue;
        }
        groups[lane].push(item);
        used[lane] += size;
        counts[lane] += 1;
    }
    const overflowBatches = overflow.length
        ? partitionPackItems(overflow, byteLengthOf, maxItems, maxBytes)
        : [];
    return [
        ...groups.filter((group) => group.length > 0),
        ...overflowBatches,
        ...exclusive
    ];
}

/** Byte-bounded pack batches (item count is not the primary limit). */
export function partitionPackItemsByBytes<T>(
    items: readonly T[],
    byteLengthOf: (item: T) => number,
    maxBytes: number
): T[][] {
    return partitionPackItems(
        items,
        byteLengthOf,
        Number.MAX_SAFE_INTEGER,
        maxBytes
    );
}
