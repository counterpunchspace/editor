export const MAX_SYNC_RESPONSE_CHUNKS = 32;
export const MAX_SYNC_RESPONSE_BYTES = 5 * 1024 * 1024;

export type CloudChunkAccumulator = {
    chunks: Array<Uint8Array | undefined>;
    received: number;
    total: number;
    receivedBytes: number;
};

export function createChunkAccumulator(
    totalChunks: unknown
): CloudChunkAccumulator | null {
    if (
        !Number.isInteger(totalChunks) ||
        (totalChunks as number) < 2 ||
        (totalChunks as number) > MAX_SYNC_RESPONSE_CHUNKS
    ) {
        return null;
    }
    return {
        chunks: new Array(totalChunks as number),
        received: 0,
        total: totalChunks as number,
        receivedBytes: 0
    };
}

export function acceptChunk(
    state: CloudChunkAccumulator,
    chunkIndex: unknown,
    bytes: Uint8Array
): boolean {
    if (
        !Number.isInteger(chunkIndex) ||
        (chunkIndex as number) < 0 ||
        (chunkIndex as number) >= state.total
    ) {
        return false;
    }
    if (state.chunks[chunkIndex as number]) {
        return true;
    }
    const nextBytes = state.receivedBytes + bytes.byteLength;
    if (nextBytes > MAX_SYNC_RESPONSE_BYTES) {
        return false;
    }
    state.chunks[chunkIndex as number] = bytes;
    state.received += 1;
    state.receivedBytes = nextBytes;
    return true;
}
