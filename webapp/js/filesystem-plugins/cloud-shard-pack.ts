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
