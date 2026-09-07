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
export const HYDRATE_SHARD_CONCURRENCY =
    APP_SETTINGS.CLOUD_COLLAB.HYDRATE_SHARD_CONCURRENCY;
export const SEED_SHARD_CONCURRENCY =
    APP_SETTINGS.CLOUD_COLLAB.SEED_SHARD_CONCURRENCY;
export const AUTO_SPARSE_CATALOG_GLYPHS =
    APP_SETTINGS.CLOUD_COLLAB.AUTO_SPARSE_CATALOG_GLYPHS;
export const SPARSE_RESIDENT_GLYPH_BUDGET =
    APP_SETTINGS.CLOUD_COLLAB.SPARSE_RESIDENT_GLYPH_BUDGET;
export const HYDRATE_BATCH_MAX_REQUESTS =
    APP_SETTINGS.CLOUD_COLLAB.HYDRATE_BATCH_MAX_REQUESTS;
export const HYDRATE_BATCH_MAX_BYTES =
    APP_SETTINGS.CLOUD_COLLAB.HYDRATE_BATCH_MAX_BYTES;
export const SPARSE_ESTIMATED_BYTES_PER_GLYPH =
    APP_SETTINGS.CLOUD_COLLAB.SPARSE_ESTIMATED_BYTES_PER_GLYPH;

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

/** Exact core encode only when the running estimate is near a cloud size gate. */
export function shouldExactEncodeAssetSize(
    estimatedBytes: number,
    maxBytes: number | null | undefined,
    warningBytes: number | null | undefined
): boolean {
    const ceiling = Number(warningBytes || maxBytes || 0);
    if (!Number.isFinite(ceiling) || ceiling <= 0) {
        return false;
    }
    return estimatedBytes >= ceiling * 0.9;
}

export function shouldAutoSparseHydrate(catalogGlyphCount: number): boolean {
    return Number(catalogGlyphCount) >= AUTO_SPARSE_CATALOG_GLYPHS;
}

export function trimPreviousWorkingIds(options: {
    previousWorkingIds: string[];
    requiredIds: Iterable<string>;
    budget?: number;
}): string[] {
    const budget = options.budget ?? SPARSE_RESIDENT_GLYPH_BUDGET;
    const required = [...new Set([...options.requiredIds].filter(Boolean))];
    if (required.length >= budget) {
        return [];
    }
    const requiredSet = new Set(required);
    const extras = options.previousWorkingIds.filter(
        (id) => id && !requiredSet.has(id)
    );
    return extras.slice(-(budget - required.length));
}

export function estimateSparseResidentBytes(
    glyphCount: number,
    encodedBytes: number = 0
): number {
    if (encodedBytes > 0) {
        return encodedBytes;
    }
    return Math.max(0, glyphCount) * SPARSE_ESTIMATED_BYTES_PER_GLYPH;
}

/**
 * Keep layout/compile-required IDs even when over budget; drop extras and
 * mark preview-only so the rest of the catalog stays on the server.
 */
export function applySparseResidencyBudget(options: {
    requiredIds: Iterable<string>;
    extraIds?: Iterable<string>;
    encodedBytes?: number;
    glyphBudget?: number;
    byteBudget?: number;
}): { keepExtraIds: string[]; previewOnly: boolean } {
    const required = [...new Set([...options.requiredIds].filter(Boolean))];
    const glyphBudget = options.glyphBudget ?? SPARSE_RESIDENT_GLYPH_BUDGET;
    const byteBudget = options.byteBudget ?? HYDRATE_BATCH_MAX_BYTES;
    const requiredBytes = estimateSparseResidentBytes(
        required.length,
        options.encodedBytes
    );
    const previewOnly =
        required.length > glyphBudget || requiredBytes > byteBudget;
    if (previewOnly) {
        return { keepExtraIds: [], previewOnly: true };
    }
    return {
        keepExtraIds: trimPreviousWorkingIds({
            previousWorkingIds: [...(options.extraIds || [])],
            requiredIds: required,
            budget: glyphBudget
        }),
        previewOnly: false
    };
}

export function assertHydrateBatchBudget(options: {
    requestCount: number;
    byteLength: number;
    maxRequests?: number;
    maxBytes?: number;
}): void {
    const maxRequests = options.maxRequests ?? HYDRATE_BATCH_MAX_REQUESTS;
    const maxBytes = options.maxBytes ?? HYDRATE_BATCH_MAX_BYTES;
    if (options.requestCount > maxRequests) {
        throw new Error(
            `Hydrate batch of ${options.requestCount} shards exceeds the ${maxRequests} request cap`
        );
    }
    if (options.byteLength > maxBytes) {
        throw new Error(
            `Hydrate batch of ${options.byteLength} bytes exceeds the ${maxBytes} byte cap`
        );
    }
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
        limits?.maxPacketBytes ?? hard.maxPacketBytes ?? MAX_YJS_PACKET_BYTES,
        hard.maxPacketBytes ?? MAX_YJS_PACKET_BYTES
    );
    const maxShard = Math.min(
        limits?.maxShardBytes ?? hard.maxShardBytes ?? MAX_SHARD_BYTES,
        hard.maxShardBytes ?? MAX_SHARD_BYTES
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
