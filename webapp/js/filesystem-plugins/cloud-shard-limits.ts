export const MAX_SHARD_BYTES = 10 * 1024 * 1024;
export const WARNING_SHARD_BYTES = Math.floor(MAX_SHARD_BYTES * 0.75);

export type ShardSizeStatus = 'ok' | 'warning' | 'blocked';

export type ShardSizeReport = {
    documentId: string;
    byteLength: number;
    status: ShardSizeStatus;
};

export type ShardSizeGate = {
    reports: ShardSizeReport[];
    canSave: boolean;
    blocking: ShardSizeReport[];
    warnings: ShardSizeReport[];
};

export function classifyShardByteLength(byteLength: number): ShardSizeStatus {
    if (byteLength >= MAX_SHARD_BYTES) {
        return 'blocked';
    }
    if (byteLength >= WARNING_SHARD_BYTES) {
        return 'warning';
    }
    return 'ok';
}

export function evaluateShardSizes(
    shards: Array<{ documentId: string; byteLength: number }>
): ShardSizeGate {
    const reports = shards.map((shard) => ({
        documentId: shard.documentId,
        byteLength: shard.byteLength,
        status: classifyShardByteLength(shard.byteLength)
    }));
    const blocking = reports.filter((report) => report.status === 'blocked');
    const warnings = reports.filter((report) => report.status === 'warning');
    return {
        reports,
        canSave: blocking.length === 0,
        blocking,
        warnings
    };
}

export function estimatePendingShardBytes(
    lastEncodedBytes: number,
    pendingUpdateBytes: number
): number {
    return lastEncodedBytes + Math.max(0, pendingUpdateBytes);
}
