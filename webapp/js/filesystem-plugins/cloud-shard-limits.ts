import APP_SETTINGS from '../settings';

export const MAX_SHARD_BYTES = APP_SETTINGS.CLOUD_COLLAB.MAX_SHARD_BYTES;
export const MAX_YJS_PACKET_BYTES =
    APP_SETTINGS.CLOUD_COLLAB.MAX_YJS_PACKET_BYTES;
export const WARNING_SHARD_BYTES =
    APP_SETTINGS.CLOUD_COLLAB.WARNING_SHARD_BYTES;
/** Live `{gc:false}` warning — not the Worker compact peak. Keep in sync with collab protocol. */
export const CLIENT_LIVE_MEMORY_WARNING_STRUCTS =
    APP_SETTINGS.CLOUD_COLLAB.CLIENT_LIVE_MEMORY_WARNING_STRUCTS;
export const CLIENT_LIVE_MEMORY_WARNING_ENCODED_BYTES = WARNING_SHARD_BYTES;

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

export type LiveShardMemoryInput = {
    encodedBytes?: number;
    decodedStructs?: number;
    pendingUnsentBytes?: number;
    undoStackItems?: number;
    truncateHistory?: boolean;
    explicitHistoryTruncation?: boolean;
    dropUnsent?: boolean;
};

export type LiveShardMemoryReport = {
    status: 'ok' | 'warning';
    encodedBytes: number;
    decodedStructs: number;
    pendingUnsentBytes: number;
    undoStackItems: number;
    canRebaseline: boolean;
    rebaselineBlockReason: string | null;
};

export type CollabSubmitRequest = {
    documentId: string;
    packetBytes: number;
    shardBytes: number;
};

export type CollabSubmitDecision = {
    allowed: boolean;
    reason?: string;
    kind?: 'packet' | 'shard';
    documentId?: string;
    packetBytes?: number;
    shardBytes?: number;
};

export type CollabSubmitLimits = {
    maxShardBytes?: number;
    maxPacketBytes?: number;
};

export function collabSubmitHardLimits(): CollabSubmitLimits {
    return {
        maxShardBytes: APP_SETTINGS.CLOUD_COLLAB.MAX_SHARD_BYTES,
        maxPacketBytes: APP_SETTINGS.CLOUD_COLLAB.MAX_YJS_PACKET_BYTES
    };
}

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

/**
 * Avoid a full encode when cached size plus this packet is still under the
 * cap (the sum overestimates merged state). Encode that shard only when the
 * cache is missing or the estimate would reject.
 */
export function measureShardBytesForSubmit(options: {
    lastEncodedBytes: number;
    packetBytes: number;
    encodeFullShard: () => number;
    maxShardBytes?: number;
}): { shardBytes: number; encodedFull: boolean } {
    const cap =
        options.maxShardBytes ?? APP_SETTINGS.CLOUD_COLLAB.MAX_SHARD_BYTES;
    const last = Math.max(0, Number(options.lastEncodedBytes) || 0);
    const packet = Math.max(0, Number(options.packetBytes) || 0);
    if (last <= 0) {
        return { shardBytes: options.encodeFullShard(), encodedFull: true };
    }
    const estimated = estimatePendingShardBytes(last, packet);
    if (estimated < cap) {
        return { shardBytes: estimated, encodedFull: false };
    }
    return { shardBytes: options.encodeFullShard(), encodedFull: true };
}

export function evaluateCollabSubmit(
    requests: CollabSubmitRequest[],
    limits?: CollabSubmitLimits
): CollabSubmitDecision {
    const hard = collabSubmitHardLimits();
    const maxPacket = Math.min(
        limits?.maxPacketBytes ?? hard.maxPacketBytes,
        hard.maxPacketBytes
    );
    const maxShard = Math.min(
        limits?.maxShardBytes ?? hard.maxShardBytes,
        hard.maxShardBytes
    );
    for (const request of requests) {
        const packetBytes = Math.max(0, Number(request.packetBytes) || 0);
        const shardBytes = Math.max(0, Number(request.shardBytes) || 0);
        if (packetBytes >= maxPacket) {
            return {
                allowed: false,
                kind: 'packet',
                documentId: request.documentId,
                packetBytes,
                shardBytes,
                reason: `Yjs packet for ${request.documentId} is ${packetBytes} bytes (limit ${maxPacket})`
            };
        }
        if (shardBytes >= maxShard) {
            return {
                allowed: false,
                kind: 'shard',
                documentId: request.documentId,
                packetBytes,
                shardBytes,
                reason: `Shard ${request.documentId} would be ${shardBytes} bytes (limit ${maxShard})`
            };
        }
    }
    return { allowed: true };
}

export function formatCollabSubmitRejection(
    decision: CollabSubmitDecision
): string {
    if (decision.allowed) {
        return '';
    }
    const packetLimit =
        decision.kind === 'packet'
            ? APP_SETTINGS.CLOUD_COLLAB.MAX_YJS_PACKET_BYTES
            : APP_SETTINGS.CLOUD_COLLAB.MAX_SHARD_BYTES;
    const limitLabel =
        packetLimit >= 1024 * 1024
            ? `${packetLimit / (1024 * 1024)} MB`
            : `${Math.round(packetLimit / 1024)} KB`;
    const shardName = decision.documentId || 'this shard';
    if (decision.kind === 'packet') {
        return `This change was reverted because the Yjs update for ${shardName} is ${decision.packetBytes} bytes, which exceeds the ${limitLabel} cloud packet limit.`;
    }
    return `This change was reverted because ${shardName} would be ${decision.shardBytes} bytes, which exceeds the ${limitLabel} cloud shard limit.`;
}

export function evaluateLiveShardMemory(
    input: LiveShardMemoryInput
): LiveShardMemoryReport {
    const encodedBytes = Math.max(0, Number(input.encodedBytes) || 0);
    const decodedStructs = Math.max(0, Number(input.decodedStructs) || 0);
    const pendingUnsentBytes = Math.max(
        0,
        Number(input.pendingUnsentBytes) || 0
    );
    const undoStackItems = Math.max(0, Number(input.undoStackItems) || 0);
    const warn =
        encodedBytes >= CLIENT_LIVE_MEMORY_WARNING_ENCODED_BYTES ||
        decodedStructs >= CLIENT_LIVE_MEMORY_WARNING_STRUCTS;
    let rebaselineBlockReason: string | null = null;
    if (pendingUnsentBytes > 0 && input.dropUnsent === true) {
        rebaselineBlockReason = 'unsent-updates';
    } else if (
        input.truncateHistory === true &&
        input.explicitHistoryTruncation !== true
    ) {
        rebaselineBlockReason = 'history-truncation-not-explicit';
    }
    return {
        status: warn ? 'warning' : 'ok',
        encodedBytes,
        decodedStructs,
        pendingUnsentBytes,
        undoStackItems,
        canRebaseline: rebaselineBlockReason === null,
        rebaselineBlockReason
    };
}

export function assertSafeRebaseline(input: LiveShardMemoryInput): void {
    const report = evaluateLiveShardMemory(input);
    if (report.canRebaseline) {
        return;
    }
    if (report.rebaselineBlockReason === 'unsent-updates') {
        throw new Error('Refusing rebaseline that would drop unsent updates');
    }
    throw new Error(
        'Refusing rebaseline that would truncate undo history without an explicit truncateUndoHistory() call'
    );
}
