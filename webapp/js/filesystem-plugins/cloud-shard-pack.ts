/**
 * Browser-side shard pack codec. GENERATED/kept in sync with
 * collab/packages/protocol/src/pack.js via `npm test -w @counterpunch/collab-protocol`.
 */

export const PACK_MAGIC = new Uint8Array([0x43, 0x50, 0x4b, 0x31]);
export const PACK_CONTENT_TYPE = 'application/vnd.counterpunch.shard-pack';
export const PACK_DIGEST_BYTES = 32;
export const PACK_MAX_SHARD_ID_BYTES = 256;
export const PACK_MAX_SHARDS = 32;
export const PACK_MAX_BYTES = 48 * 1024 * 1024;
export const PACK_FRAME_TYPE = {
    SHARD: 1,
    RECEIPT: 2,
    ERROR: 3,
    END: 4
} as const;

function encodeUtf8(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function decodeUtf8(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const chunk of chunks) {
        total += chunk.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

export function hexToBytes(hex: string): Uint8Array {
    const value = String(hex || '');
    if (!value || value.length % 2 !== 0) {
        return new Uint8Array(PACK_DIGEST_BYTES);
    }
    const out = new Uint8Array(value.length / 2);
    for (let i = 0; i < out.length; i += 1) {
        out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

export function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes || [], (byte) =>
        byte.toString(16).padStart(2, '0')
    ).join('');
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

function encodePackFrame(options: {
    type: number;
    shardId?: string;
    payload?: Uint8Array;
    digest?: Uint8Array | string;
    missing?: boolean;
}): Uint8Array {
    const idBytes = encodeUtf8(String(options.shardId || ''));
    const body = options.payload || new Uint8Array();
    const digestBytes =
        options.digest instanceof Uint8Array &&
        options.digest.byteLength === PACK_DIGEST_BYTES
            ? options.digest
            : hexToBytes(
                  typeof options.digest === 'string' ? options.digest : ''
              );
    const header = new Uint8Array(
        8 + idBytes.byteLength + PACK_DIGEST_BYTES + body.byteLength
    );
    const view = new DataView(header.buffer);
    view.setUint8(0, options.type);
    view.setUint8(1, options.missing ? 1 : 0);
    view.setUint16(2, idBytes.byteLength, false);
    view.setUint32(4, body.byteLength, false);
    header.set(idBytes, 8);
    header.set(digestBytes, 8 + idBytes.byteLength);
    header.set(body, 8 + idBytes.byteLength + PACK_DIGEST_BYTES);
    return header;
}

export function encodePackShardFrame(
    shardId: string,
    payload: Uint8Array,
    digest?: Uint8Array | string
): Uint8Array {
    return encodePackFrame({
        type: PACK_FRAME_TYPE.SHARD,
        shardId,
        payload,
        digest
    });
}

export function encodePackEndFrame(count = 0): Uint8Array {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, Number(count) || 0, false);
    return encodePackFrame({
        type: PACK_FRAME_TYPE.END,
        payload
    });
}

export function encodePackBody(frames: Uint8Array[]): Uint8Array {
    return concatBytes([PACK_MAGIC, ...frames]);
}

export function createPackParser(): {
    push(chunk: Uint8Array): PackFrame[];
    finish(): void;
} {
    let buffer = new Uint8Array(0);
    let sawMagic = false;

    function take(n: number): Uint8Array | null {
        if (buffer.byteLength < n) {
            return null;
        }
        const slice = buffer.subarray(0, n);
        buffer = buffer.subarray(n);
        return slice;
    }

    return {
        push(chunk: Uint8Array): PackFrame[] {
            if (!chunk?.byteLength) {
                return [];
            }
            buffer = Uint8Array.from(concatBytes([buffer, chunk]));
            const frames: PackFrame[] = [];
            if (!sawMagic) {
                if (buffer.byteLength < PACK_MAGIC.byteLength) {
                    return frames;
                }
                const magic = take(PACK_MAGIC.byteLength);
                if (
                    !magic ||
                    magic[0] !== PACK_MAGIC[0] ||
                    magic[1] !== PACK_MAGIC[1] ||
                    magic[2] !== PACK_MAGIC[2] ||
                    magic[3] !== PACK_MAGIC[3]
                ) {
                    throw new Error('invalid shard pack magic');
                }
                sawMagic = true;
            }
            while (buffer.byteLength >= 8) {
                const view = new DataView(buffer.buffer, buffer.byteOffset, 8);
                const type = view.getUint8(0);
                const flags = view.getUint8(1);
                const idLen = view.getUint16(2, false);
                const payloadLen = view.getUint32(4, false);
                if (idLen > PACK_MAX_SHARD_ID_BYTES) {
                    throw new Error('pack shard id too long');
                }
                if (payloadLen > 5242880 && type === PACK_FRAME_TYPE.SHARD) {
                    throw new Error(
                        'pack shard payload exceeds MAX_SHARD_BYTES'
                    );
                }
                const frameLen = 8 + idLen + PACK_DIGEST_BYTES + payloadLen;
                if (buffer.byteLength < frameLen) {
                    break;
                }
                const raw = take(frameLen)!;
                const shardId = decodeUtf8(raw.subarray(8, 8 + idLen));
                const digest = raw.subarray(
                    8 + idLen,
                    8 + idLen + PACK_DIGEST_BYTES
                );
                const payload = raw.subarray(8 + idLen + PACK_DIGEST_BYTES);
                let receipt: Record<string, unknown> | null = null;
                if (
                    type === PACK_FRAME_TYPE.RECEIPT ||
                    type === PACK_FRAME_TYPE.ERROR
                ) {
                    try {
                        receipt = JSON.parse(decodeUtf8(payload));
                    } catch {
                        receipt = null;
                    }
                }
                frames.push({
                    type,
                    missing: (flags & 1) === 1,
                    shardId,
                    digest,
                    digestHex: bytesToHex(digest),
                    payload,
                    receipt,
                    count:
                        type === PACK_FRAME_TYPE.END && payload.byteLength >= 4
                            ? new DataView(
                                  payload.buffer,
                                  payload.byteOffset,
                                  payload.byteLength
                              ).getUint32(0, false)
                            : 0
                });
            }
            return frames;
        },
        finish() {
            if (buffer.byteLength > 0) {
                throw new Error('truncated shard pack');
            }
            if (!sawMagic) {
                throw new Error('empty shard pack');
            }
        }
    };
}

export function partitionPackItems<T>(
    items: readonly T[],
    byteLengthOf: (item: T) => number,
    maxItems: number,
    maxBytes: number
): T[][] {
    const batches: T[][] = [];
    let current: T[] = [];
    let bytes = 0;
    for (const item of items) {
        const size = byteLengthOf(item);
        if (
            current.length &&
            (current.length >= maxItems || bytes + size > maxBytes)
        ) {
            batches.push(current);
            current = [];
            bytes = 0;
        }
        current.push(item);
        bytes += size;
    }
    if (current.length) {
        batches.push(current);
    }
    return batches;
}
