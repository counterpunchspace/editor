// @ts-nocheck
/**
 * CloudAdapter shard seed/hydrate (HTTP pack + per-shard).
 * Installed onto CloudAdapter.prototype from cloud-adapter.ts.
 */
import type { EncodedShard } from './filesystem-plugins/cloud-document-set';
import {
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID
} from './filesystem-plugins/cloud-document-set';
import {
    mapPool,
    HYDRATE_SHARD_CONCURRENCY,
    SEED_SHARD_CONCURRENCY
} from './filesystem-plugins/cloud-bounded-io';
import {
    assertHydrateBatchBudget,
    HYDRATE_BATCH_MAX_BYTES,
    HYDRATE_BATCH_MAX_REQUESTS,
    SPARSE_ESTIMATED_BYTES_PER_GLYPH
} from './filesystem-plugins/cloud-shard-limits';
import {
    createPackParser,
    encodePackBody,
    encodePackShardFrame,
    PACK_FRAME_TYPE,
    SEED_PACK_MAX_SHARDS,
    partitionPackItems,
    seedPackByteBudget,
    spreadPackItems,
    type PackFrame
} from './filesystem-plugins/cloud-shard-pack';
import { throwIfAborted, yieldToUi } from './yield-to-ui';
import {
    normalizeCloudShardHttpUrl,
    normalizeCloudShardPackUrl
} from './cloud-adapter-bootstrap';
import {
    emitShardIoProgress,
    shardIoConcurrency,
    shardIoTotals,
    sha256Digest,
    isPackUnsupportedStatus,
    formatPackHttpError,
    abortSignalWithTimeout,
    HYDRATE_PACK_FETCH_TIMEOUT_MS,
    type CloudShardIoOptions,
    type CloudShardIoProgress,
    type CloudSeededShardAttestation,
    type CloudSeedDocumentSetResult
} from './cloud-adapter-support';
import { Logger } from './logger';

const console = new Logger('CloudAdapterShardIo');

/** Browser console, not the in-app logger. Seed and hydrate failures land here
 * with the room's phase, status, and debug payload so the next failure is
 * visible without a worker tail. */
function logCloudPackFailure(
    channel: 'pack seed failed' | 'pack hydrate failed',
    detail: Record<string, unknown>
): void {
    globalThis.console.log(`[CloudAdapter] ${channel}`, detail);
}

const LARGE_SHARD_BYTES = 1024 * 1024;
const CLIENT_PACK_CONCURRENCY = 6;
const CLIENT_PACK_INFLIGHT_BYTES = 48 * 1024 * 1024;

export const cloudAdapterShardIoMethods = {
    async _ensureSaveGrant(glyphCount: number): Promise<void> {
        if (this._saveGrant || !this._assetId || !this._websiteBaseUrl) {
            return;
        }
        try {
            const response = await fetch(
                `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(this._assetId)}/seed-grant`,
                {
                    method: 'POST',
                    credentials: 'include',
                    cache: 'no-store',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ glyphCount })
                }
            );
            if (!response.ok) {
                return;
            }
            const data = await response.json();
            if (data?.grant) {
                this._saveGrant = data.grant;
            }
        } catch {
            /* The room still accepts a per-pack authorize grant. */
        }
    },
    async _runPackSlots<T>(
        batches: T[][],
        byteLengthOf: (batch: T[]) => number,
        run: (batch: T[]) => Promise<unknown>,
        options?: { signal?: AbortSignal }
    ): Promise<unknown[]> {
        let slots = CLIENT_PACK_CONCURRENCY;
        let inFlight = 0;
        let inFlightBytes = 0;
        let cursor = 0;
        const results: unknown[] = new Array(batches.length);
        const exclusive = (batch: T[]) =>
            byteLengthOf(batch) >= LARGE_SHARD_BYTES && batch.length === 1;
        await new Promise<void>((resolve, reject) => {
            const launch = () => {
                if (options?.signal?.aborted) {
                    reject(options.signal.reason || new Error('aborted'));
                    return;
                }
                if (cursor >= batches.length && inFlight === 0) {
                    resolve();
                    return;
                }
                while (cursor < batches.length && inFlight < slots) {
                    const batch = batches[cursor];
                    const bytes = byteLengthOf(batch);
                    const alone = exclusive(batch);
                    if (alone && inFlight > 0) {
                        break;
                    }
                    if (
                        !alone &&
                        inFlight > 0 &&
                        inFlightBytes + bytes > CLIENT_PACK_INFLIGHT_BYTES
                    ) {
                        break;
                    }
                    const index = cursor;
                    cursor += 1;
                    inFlight += 1;
                    inFlightBytes += bytes;
                    globalThis.console.log('[CloudAdapter] pack in flight', {
                        bytes,
                        inFlight,
                        inFlightBytes,
                        slots
                    });
                    Promise.resolve()
                        .then(() => run(batch))
                        .then((value) => {
                            results[index] = value;
                        })
                        .catch(async (error) => {
                            const message =
                                error instanceof Error
                                    ? error.message
                                    : String(error);
                            const retryable =
                                /503|1102|10001|exceededMemory|internal error/i.test(
                                    message
                                );
                            const attempts = Number(
                                (batch as { packAttempts?: number })
                                    .packAttempts || 0
                            );
                            if (retryable && attempts < 1) {
                                slots = Math.max(1, Math.floor(slots / 2));
                                globalThis.console.log(
                                    '[CloudAdapter] pack slots reduced',
                                    { slots }
                                );
                                (
                                    batch as { packAttempts?: number }
                                ).packAttempts = attempts + 1;
                                try {
                                    results[index] = await run(batch);
                                } catch (retryError) {
                                    results[index] =
                                        retryError instanceof Error
                                            ? retryError
                                            : new Error(String(retryError));
                                }
                                return;
                            }
                            results[index] =
                                error instanceof Error
                                    ? error
                                    : new Error(message);
                        })
                        .finally(() => {
                            inFlight -= 1;
                            inFlightBytes -= bytes;
                            launch();
                        });
                    if (alone) {
                        break;
                    }
                }
            };
            launch();
        });
        const failure = results.find((result) => result instanceof Error);
        if (failure) {
            throw failure;
        }
        return results;
    },
    async seedDocumentSet(
        token: string,
        roomUrl: string,
        shards: EncodedShard[],
        glyphCount: number,
        options?: CloudShardIoOptions
    ): Promise<CloudSeedDocumentSetResult> {
        await this._ensureSaveGrant(glyphCount);
        const seedStartedAt = performance.now();
        const batches = spreadPackItems(
            shards,
            (shard) => shard.bytes.byteLength,
            Math.min(
                options?.maxRequests ?? HYDRATE_BATCH_MAX_REQUESTS,
                SEED_PACK_MAX_SHARDS
            ),
            seedPackByteBudget(options?.maxBytes ?? HYDRATE_BATCH_MAX_BYTES),
            CLIENT_PACK_CONCURRENCY
        );
        const bytesTotal = shards.reduce(
            (sum, shard) => sum + shard.bytes.byteLength,
            0
        );
        globalThis.console.log('[CloudAdapter] seed start', {
            packs: batches.length,
            shards: shards.length,
            bytes: bytesTotal,
            lanes: CLIENT_PACK_CONCURRENCY
        });
        for (const batch of batches) {
            assertHydrateBatchBudget({
                requestCount: batch.length,
                byteLength: batch.reduce(
                    (sum, shard) => sum + shard.bytes.byteLength,
                    0
                ),
                maxRequests: options?.maxRequests,
                maxBytes: options?.maxBytes
            });
        }
        const usePack = options?.transport !== 'per-shard';
        const rows: Array<{
            coreCheckpointLogId: number | null;
            attestation: CloudSeededShardAttestation | null;
        }> = [];
        const cursor = shardIoTotals(options, shards.length, bytesTotal);
        await emitShardIoProgress(options, {
            completed: cursor.completed,
            total: cursor.total,
            bytesCompleted: cursor.bytesCompleted,
            bytesTotal: cursor.bytesTotal
        });
        if (usePack) {
            const packedRows = await this._runPackSlots(
                batches,
                (batch) =>
                    batch.reduce(
                        (sum, shard) => sum + shard.bytes.byteLength,
                        0
                    ),
                (batch) =>
                    this._seedPack(
                        token,
                        roomUrl,
                        batch,
                        glyphCount,
                        options,
                        cursor
                    ),
                options
            );
            rows.push(...packedRows.flat());
        }
        for (const batch of usePack ? [] : batches) {
            throwIfAborted(options?.signal);
            if (usePack) {
                continue;
            }
            rows.push(
                ...(await mapPool(
                    batch,
                    shardIoConcurrency(options, SEED_SHARD_CONCURRENCY),
                    async (shard) =>
                        this._seedOneShard(
                            token,
                            roomUrl,
                            shard,
                            glyphCount,
                            options,
                            cursor
                        )
                ))
            );
        }
        let coreCheckpointLogId: number | null = null;
        const attestations: CloudSeededShardAttestation[] = [];
        for (const row of rows) {
            if (row.coreCheckpointLogId !== null) {
                coreCheckpointLogId = row.coreCheckpointLogId;
            }
            if (row.attestation) {
                attestations.push(row.attestation);
            }
        }
        globalThis.console.log('[CloudAdapter] seed done', {
            packs: batches.length,
            shards: shards.length,
            attested: attestations.length,
            bytes: bytesTotal,
            totalMs: Math.round(performance.now() - seedStartedAt)
        });
        return { coreCheckpointLogId, attestations };
    },
    _isTransientPackHydrateError(error: unknown): boolean {
        if (error instanceof Error && error.name === 'AbortError') {
            return true;
        }
        const message = error instanceof Error ? error.message : String(error);
        return /503|Failed to fetch|ERR_ABORTED|ERR_FAILED|NETWORK_CHANGED|unavailable|do_timeout|incomplete|aborted|shard pack hydrate failed: 5\d\d/i.test(
            message
        );
    },
    async _seedPack(
        token: string,
        roomUrl: string,
        shards: EncodedShard[],
        glyphCount: number,
        options: CloudShardIoOptions | undefined,
        cursor: CloudShardIoProgress
    ): Promise<
        Array<{
            coreCheckpointLogId: number | null;
            attestation: CloudSeededShardAttestation | null;
        }>
    > {
        const bytesById = new Map(
            shards.map((shard) => [shard.documentId, shard.bytes.byteLength])
        );
        const completedBefore = cursor.completed;
        const bytesBefore = cursor.bytesCompleted;
        const idempotencyKey =
            globalThis.crypto?.randomUUID?.() ||
            `seed-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        let lastError: unknown = null;
        let remaining = shards.slice();
        const allRows: Array<{
            coreCheckpointLogId: number | null;
            attestation: CloudSeededShardAttestation | null;
        }> = [];
        for (let attempt = 0; attempt < 4; attempt += 1) {
            throwIfAborted(options?.signal);
            cursor.completed =
                completedBefore +
                allRows.filter((row) => row.attestation).length;
            cursor.bytesCompleted =
                bytesBefore +
                allRows.reduce(
                    (sum, row) =>
                        sum +
                        (row.attestation
                            ? bytesById.get(row.attestation.shardId) ||
                              row.attestation.checkpointByteLength ||
                              0
                            : 0),
                    0
                );
            try {
                this._noteTransferActivity('sending');
                const remainingFrames: Uint8Array[] = [];
                const assemblyStartedAt = performance.now();
                for (let index = 0; index < remaining.length; index += 1) {
                    const shard = remaining[index];
                    throwIfAborted(options?.signal);
                    remainingFrames.push(
                        encodePackShardFrame(
                            shard.documentId,
                            shard.bytes,
                            await sha256Digest(shard.bytes)
                        )
                    );
                    if (index % 64 === 63) {
                        await yieldToUi();
                    }
                }
                const remainingBody = encodePackBody(remainingFrames);
                const assemblyMs = Math.round(
                    performance.now() - assemblyStartedAt
                );
                const httpStartedAt = performance.now();
                const response = await fetch(
                    normalizeCloudShardPackUrl(
                        roomUrl,
                        this._websiteBaseUrl,
                        this._assetId
                    ),
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/octet-stream',
                            'X-Glyph-Count': String(glyphCount),
                            'X-Collab-Idempotency-Key': idempotencyKey,
                            ...(this._saveGrant
                                ? {
                                      'X-Collab-Save-Grant': JSON.stringify(
                                          this._saveGrant
                                      )
                                  }
                                : {})
                        },
                        body: remainingBody as unknown as BodyInit,
                        signal: options?.signal
                    }
                );
                if (isPackUnsupportedStatus(response.status)) {
                    logCloudPackFailure('pack seed failed', {
                        phase: 'http',
                        status: response.status,
                        message: 'pack unsupported'
                    });
                    throw new Error('pack unsupported');
                }
                if (!response.ok) {
                    const message = await formatPackHttpError(response);
                    logCloudPackFailure('pack seed failed', {
                        phase: 'http',
                        status: response.status,
                        message
                    });
                    throw new Error(message);
                }
                globalThis.console.log('[CloudAdapter] seed pack response', {
                    shards: remaining.length,
                    bytes: remainingBody.byteLength,
                    assemblyMs,
                    httpWaitMs: Math.round(performance.now() - httpStartedAt),
                    status: response.status
                });
                if (!response.body) {
                    throw new Error(
                        `shard pack seed failed: ${response.status} empty body`
                    );
                }
                const rows: Array<{
                    coreCheckpointLogId: number | null;
                    attestation: CloudSeededShardAttestation | null;
                }> = [];
                let packError: string | null = null;
                const parser = createPackParser();
                const reader = response.body.getReader();
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (value) {
                            for (const frame of parser.push(value)) {
                                const before = rows.length;
                                this._collectPackSeedFrame(
                                    frame,
                                    rows,
                                    (message) => {
                                        packError = message;
                                    }
                                );
                                if (rows.length > before) {
                                    const row = rows[rows.length - 1];
                                    if (row?.attestation) {
                                        await options?.onShardLanded?.(
                                            row.attestation
                                        );
                                        cursor.completed += 1;
                                        cursor.bytesCompleted +=
                                            bytesById.get(
                                                row.attestation.shardId
                                            ) ||
                                            row.attestation
                                                .checkpointByteLength ||
                                            0;
                                        await options?.onProgress?.({
                                            ...cursor,
                                            shardId: row.attestation.shardId
                                        });
                                        if (cursor.completed % 64 === 0) {
                                            await yieldToUi();
                                        }
                                    }
                                }
                            }
                        }
                        if (done) {
                            break;
                        }
                    }
                    parser.finish();
                } finally {
                    reader.releaseLock();
                }
                if (packError) {
                    throw new Error(
                        packError ||
                            `shard pack seed failed: ${response.status}`
                    );
                }
                allRows.push(...rows);
                const landed = new Set(
                    allRows
                        .map((row) => row.attestation?.shardId)
                        .filter((shardId): shardId is string => !!shardId)
                );
                remaining = remaining.filter(
                    (shard) => !landed.has(shard.documentId)
                );
                if (!remaining.length) {
                    globalThis.console.log('[CloudAdapter] seed pack done', {
                        shards: shards.length,
                        attested: allRows.filter((row) => row.attestation)
                            .length,
                        assemblyMs,
                        totalMs: Math.round(performance.now() - httpStartedAt)
                    });
                    return allRows;
                }
                throw new Error('shard pack seed incomplete');
            } catch (error) {
                lastError = error;
                const message =
                    error instanceof Error ? error.message : String(error);
                const retryable =
                    !options?.signal?.aborted &&
                    /503|10001|Failed to fetch|ERR_ABORTED|ERR_FAILED|NETWORK_CHANGED|unavailable|do_timeout|incomplete|internal error/i.test(
                        message
                    );
                logCloudPackFailure('pack seed failed', {
                    phase: 'transport',
                    attempt,
                    retryable,
                    message
                });
                if (!retryable || attempt === 3) {
                    throw error;
                }
                await new Promise((resolve) =>
                    setTimeout(resolve, 800 * 2 ** attempt)
                );
            }
        }
        throw lastError instanceof Error
            ? lastError
            : new Error(String(lastError));
    },
    _collectPackSeedFrame(
        frame: PackFrame,
        rows: Array<{
            coreCheckpointLogId: number | null;
            attestation: CloudSeededShardAttestation | null;
        }>,
        onError: (message: string) => void
    ): void {
        if (frame.type === PACK_FRAME_TYPE.ERROR) {
            const receipt = frame.receipt || {};
            const message =
                typeof receipt.error === 'string'
                    ? receipt.error
                    : 'shard pack seed failed';
            logCloudPackFailure('pack seed failed', {
                phase:
                    typeof receipt.phase === 'string' ? receipt.phase : 'pack',
                status: receipt.status,
                code: receipt.code,
                shardId: receipt.shardId || frame.shardId,
                message,
                debug: receipt.debug
            });
            onError(message);
            return;
        }
        if (frame.type !== PACK_FRAME_TYPE.RECEIPT || !frame.receipt) {
            return;
        }
        const receipt = frame.receipt;
        const shardId = String(receipt.shardId || frame.shardId || '');
        const attestation =
            typeof receipt.checkpointObjectKey === 'string' &&
            typeof (receipt.checkpointSha256 || receipt.snapshotSha256) ===
                'string' &&
            typeof (receipt.checkpointByteLength || receipt.snapshotBytes) ===
                'number'
                ? {
                      shardId,
                      checkpointObjectKey: String(receipt.checkpointObjectKey),
                      checkpointSha256: String(
                          receipt.checkpointSha256 || receipt.snapshotSha256
                      ),
                      checkpointByteLength: Number(
                          receipt.checkpointByteLength || receipt.snapshotBytes
                      ),
                      checkpointLogId:
                          typeof receipt.checkpointLogId === 'number'
                              ? receipt.checkpointLogId
                              : 0,
                      checkpointAt:
                          typeof receipt.checkpointAt === 'number'
                              ? receipt.checkpointAt
                              : undefined
                  }
                : null;
        rows.push({
            coreCheckpointLogId:
                attestation && shardId === FONT_CORE_DOCUMENT_ID
                    ? attestation.checkpointLogId
                    : null,
            attestation
        });
    },
    async _seedOneShard(
        token: string,
        roomUrl: string,
        shard: EncodedShard,
        glyphCount: number,
        options: CloudShardIoOptions | undefined,
        cursor: CloudShardIoProgress
    ): Promise<{
        coreCheckpointLogId: number | null;
        attestation: CloudSeededShardAttestation | null;
    }> {
        throwIfAborted(options?.signal);
        const httpUrl = normalizeCloudShardHttpUrl(
            roomUrl,
            this._websiteBaseUrl,
            this._assetId,
            shard.documentId
        );
        this._noteTransferActivity('sending');
        let response: Response | null = null;
        let lastError: unknown = null;
        // Initial seeding is idempotent: a successful first attempt makes
        // a retry return 409. Retrying transient browser/workerd transport
        // failures prevents a single dropped glyph upload from abandoning
        // the entire Save As operation.
        for (let attempt = 0; attempt < 3; attempt += 1) {
            throwIfAborted(options?.signal);
            const controller = new AbortController();
            const onUserAbort = () => controller.abort();
            options?.signal?.addEventListener('abort', onUserAbort);
            const timeoutId = window.setTimeout(
                () => controller.abort(),
                15_000
            );
            try {
                response = await fetch(httpUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/octet-stream',
                        'X-Glyph-Count': String(glyphCount)
                    },
                    body: shard.bytes as unknown as BodyInit,
                    signal: controller.signal
                });
                break;
            } catch (error) {
                lastError = error;
                throwIfAborted(options?.signal);
                if (attempt < 2) {
                    await new Promise<void>((resolve) => {
                        window.setTimeout(resolve, 100 * (attempt + 1));
                    });
                }
            } finally {
                options?.signal?.removeEventListener('abort', onUserAbort);
                window.clearTimeout(timeoutId);
            }
        }
        if (!response) {
            const detail =
                lastError instanceof Error
                    ? lastError.message
                    : String(lastError ?? 'unknown transport error');
            throw new Error(
                `shard seed request failed (${shard.documentId}): ${detail}`
            );
        }
        if (response.status === 409) {
            const conflictBody = await response.text().catch(() => '');
            let code = '';
            try {
                code = String(JSON.parse(conflictBody)?.code || '');
            } catch {
                /* not JSON */
            }
            if (code === 'seed_digest_conflict') {
                throw new Error(
                    `shard seed digest conflict (${shard.documentId})`
                );
            }
            throw new Error(
                `shard seed failed (${shard.documentId}): 409 ${conflictBody.slice(0, 160)}`
            );
        }
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(
                `shard seed failed (${shard.documentId}): ${response.status} ${body.slice(0, 160)}`
            );
        }
        try {
            const result = (await response.json()) as {
                checkpointLogId?: unknown;
                checkpointObjectKey?: unknown;
                snapshotSha256?: unknown;
                snapshotBytes?: unknown;
                checkpointAt?: unknown;
            };
            const coreCheckpointLogId =
                typeof result.checkpointLogId === 'number' &&
                shard.documentId === FONT_CORE_DOCUMENT_ID
                    ? result.checkpointLogId
                    : null;
            const attestation =
                typeof result.checkpointObjectKey === 'string' &&
                typeof result.snapshotSha256 === 'string' &&
                typeof result.snapshotBytes === 'number'
                    ? {
                          shardId: shard.documentId,
                          checkpointObjectKey: result.checkpointObjectKey,
                          checkpointSha256: result.snapshotSha256,
                          checkpointByteLength: result.snapshotBytes,
                          checkpointLogId:
                              typeof result.checkpointLogId === 'number'
                                  ? result.checkpointLogId
                                  : 0,
                          checkpointAt:
                              typeof result.checkpointAt === 'number'
                                  ? result.checkpointAt
                                  : undefined
                      }
                    : null;
            if (attestation) {
                await options?.onShardLanded?.(attestation);
                cursor.completed += 1;
                cursor.bytesCompleted += shard.bytes.byteLength;
                await emitShardIoProgress(options, {
                    ...cursor,
                    shardId: attestation.shardId
                });
            }
            return { coreCheckpointLogId, attestation };
        } catch {
            return { coreCheckpointLogId: null, attestation: null };
        }
    },
    async hydrateDocumentSet(
        token: string,
        roomUrl: string,
        documentIds: string[],
        options?: CloudShardIoOptions
    ): Promise<Map<string, Uint8Array>> {
        const batches = partitionPackItems(
            documentIds,
            () => SPARSE_ESTIMATED_BYTES_PER_GLYPH,
            options?.maxRequests ?? HYDRATE_BATCH_MAX_REQUESTS,
            options?.maxBytes ?? HYDRATE_BATCH_MAX_BYTES
        );
        for (const batch of batches) {
            assertHydrateBatchBudget({
                requestCount: batch.length,
                byteLength: batch.length * SPARSE_ESTIMATED_BYTES_PER_GLYPH,
                maxRequests: options?.maxRequests,
                maxBytes: options?.maxBytes
            });
        }
        const result = new Map<string, Uint8Array>();
        const usePack = options?.transport !== 'per-shard';
        const cursor = shardIoTotals(options, documentIds.length, 0);
        await emitShardIoProgress(options, {
            completed: cursor.completed,
            total: cursor.total,
            bytesCompleted: cursor.bytesCompleted,
            bytesTotal: cursor.bytesTotal
        });
        const packed = await this._runPackSlots(
            batches,
            (batch: string[]) =>
                batch.length * SPARSE_ESTIMATED_BYTES_PER_GLYPH,
            async (batch: string[]) => {
                throwIfAborted(options?.signal);
                return usePack
                    ? await this._hydratePack(
                          token,
                          roomUrl,
                          batch,
                          options,
                          cursor
                      )
                    : await this._hydratePerShard(
                          token,
                          roomUrl,
                          batch,
                          options,
                          cursor
                      );
            },
            { signal: options?.signal }
        );
        for (const batchResult of packed) {
            for (const [documentId, bytes] of batchResult as Map<
                string,
                Uint8Array
            >) {
                result.set(documentId, bytes);
            }
        }
        return result;
    },
    async _hydratePack(
        token: string,
        roomUrl: string,
        documentIds: string[],
        options: CloudShardIoOptions | undefined,
        cursor: CloudShardIoProgress
    ): Promise<Map<string, Uint8Array>> {
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
                return await this._hydratePackOnce(
                    token,
                    roomUrl,
                    documentIds,
                    options,
                    cursor
                );
            } catch (error) {
                lastError = error;
                const packTimedOut =
                    error instanceof Error && error.name === 'AbortError';
                const message =
                    error instanceof Error ? error.message : String(error);
                const retryable =
                    !options?.signal?.aborted &&
                    !packTimedOut &&
                    this._isTransientPackHydrateError(error) &&
                    attempt < 3;
                logCloudPackFailure('pack hydrate failed', {
                    phase: 'transport',
                    attempt,
                    retryable,
                    message
                });
                if (!retryable) {
                    throw error;
                }
                await new Promise((resolve) =>
                    setTimeout(resolve, 100 * 2 ** attempt)
                );
            }
        }
        throw lastError instanceof Error
            ? lastError
            : new Error(String(lastError));
    },
    async _hydratePackOnce(
        token: string,
        roomUrl: string,
        documentIds: string[],
        options: CloudShardIoOptions | undefined,
        cursor: CloudShardIoProgress
    ): Promise<Map<string, Uint8Array>> {
        this._noteTransferActivity('receiving');
        const response = await fetch(
            normalizeCloudShardPackUrl(
                roomUrl,
                this._websiteBaseUrl,
                this._assetId
            ),
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ ids: documentIds }),
                signal: abortSignalWithTimeout(
                    options?.signal,
                    HYDRATE_PACK_FETCH_TIMEOUT_MS
                )
            }
        );
        if (isPackUnsupportedStatus(response.status)) {
            throw new Error('pack unsupported');
        }
        if (!response.ok) {
            const message = await formatPackHttpError(
                response,
                'shard pack hydrate failed'
            );
            logCloudPackFailure('pack hydrate failed', {
                phase: 'http',
                status: response.status,
                message
            });
            throw new Error(message);
        }
        if (!response.body) {
            throw new Error(
                `shard pack hydrate failed: ${response.status} empty body`
            );
        }
        const result = new Map<string, Uint8Array>();
        let packError: string | null = null;
        const parser = createPackParser();
        const reader = response.body.getReader();
        try {
            while (true) {
                throwIfAborted(options?.signal);
                const { done, value } = await reader.read();
                if (value) {
                    for (const frame of parser.push(value)) {
                        if (frame.type === PACK_FRAME_TYPE.ERROR) {
                            const receipt = frame.receipt || {};
                            packError =
                                typeof receipt.error === 'string'
                                    ? receipt.error
                                    : 'shard pack hydrate failed';
                            logCloudPackFailure('pack hydrate failed', {
                                phase:
                                    typeof receipt.phase === 'string'
                                        ? receipt.phase
                                        : 'pack',
                                status: receipt.status,
                                code: receipt.code,
                                shardId: receipt.shardId || frame.shardId,
                                message: packError,
                                debug: receipt.debug
                            });
                        } else if (
                            frame.type === PACK_FRAME_TYPE.SHARD &&
                            !frame.missing
                        ) {
                            if (frame.payload.byteLength) {
                                result.set(
                                    frame.shardId,
                                    frame.payload.slice()
                                );
                            }
                            cursor.completed += 1;
                            cursor.bytesCompleted += frame.payload.byteLength;
                            await emitShardIoProgress(options, {
                                ...cursor,
                                shardId: frame.shardId
                            });
                        }
                    }
                }
                if (done) {
                    break;
                }
            }
            parser.finish();
        } finally {
            reader.releaseLock();
        }
        if (!response.ok || packError) {
            throw new Error(
                packError || `shard pack hydrate failed: ${response.status}`
            );
        }
        return result;
    },
    async _hydratePerShard(
        token: string,
        roomUrl: string,
        documentIds: string[],
        options: CloudShardIoOptions | undefined,
        cursor: CloudShardIoProgress
    ): Promise<Map<string, Uint8Array>> {
        const result = new Map<string, Uint8Array>();
        const rows = await mapPool(
            documentIds,
            shardIoConcurrency(options, HYDRATE_SHARD_CONCURRENCY),
            async (documentId) => {
                throwIfAborted(options?.signal);
                const httpUrl = normalizeCloudShardHttpUrl(
                    roomUrl,
                    this._websiteBaseUrl,
                    this._assetId,
                    documentId
                );
                this._noteTransferActivity('receiving');
                const response = await fetch(httpUrl, {
                    headers: { Authorization: `Bearer ${token}` },
                    signal: options?.signal
                });
                if (response.status === 404) {
                    cursor.completed += 1;
                    await emitShardIoProgress(options, {
                        ...cursor,
                        shardId: documentId
                    });
                    return { documentId, bytes: null as Uint8Array | null };
                }
                if (!response.ok) {
                    throw new Error(
                        `shard hydrate failed (${documentId}): ${response.status}`
                    );
                }
                const bytes = new Uint8Array(await response.arrayBuffer());
                cursor.completed += 1;
                cursor.bytesCompleted += bytes.byteLength;
                await emitShardIoProgress(options, {
                    ...cursor,
                    shardId: documentId
                });
                return { documentId, bytes };
            }
        );
        for (const row of rows) {
            if (row.bytes) {
                result.set(row.documentId, row.bytes);
            }
        }
        return result;
    }
};
