/**
 * CloudAdapter free helpers (catch-up, HTTP publish, shard IO progress, encoding).
 * The WebSocket transport + outbox class lives in cloud-adapter.ts.
 */

import { recordCollabTrace } from './collab-trace';
import { BrokenDocumentError, ClockGapError } from './yjs-update-integrity';
import { assertEncodableDocumentState } from './cloud-document-encode-gate';
import {
    needsOutboundParts,
    planOutboundParts
} from './cloud-adapter-outbound-parts';
import type { PatchSyncEngine } from './patch-sync-engine';
import type { ChangeLogEntry } from './change-log';
import { Logger } from './logger';
import {
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID,
    glyphIdFromDocumentId
} from './filesystem-plugins/cloud-document-set';
import { throwIfAborted, yieldToUi } from './yield-to-ui';
import {
    collaborationMessageKey,
    createCollaborationMessageEnvelopesFromChangeLogEntries,
    createLinkedWindowCatchUpEnvelope,
    type CollaborationMessageEnvelope
} from './collaboration-message';
import { isProduction } from './settings';
import { resolveWebsiteURL } from './website-url';
import {
    allocateClientTransactionId,
    isExactDurableAck
} from './generated/collab-protocol-durability-contract';
import {
    normalizeCloudShardHttpUrl,
    normalizeCloudShardLiveHttpUrl
} from './cloud-adapter-bootstrap';
import {
    decodeCollabLiveFrames,
    decodeCheckpointMeta,
    assembleTailTransactionsFromFrames,
    CollabFrameError
} from './cloud-adapter-frames';
import { CloudDurableWal } from './cloud-durable-wal';

const console = new Logger('CloudAdapterSupport');

/** The room’s stream broke its own ordering rules (a log id hole, a bad page). */
export class CloudProtocolError extends Error {
    constructor(documentId: string, detail: string) {
        super(`Cloud collaboration protocol error in ${documentId}: ${detail}`);
        this.name = 'CloudProtocolError';
    }
}

/**
 * Check a page of journal rows before any of it applies: rows follow one
 * another from `afterLogId + 1` (when known), each row frame is whole, a
 * transaction split into chunks has every chunk in the page, and the page
 * does not end before its last row. Throws `CloudProtocolError`; nothing in
 * the page may apply after a hole.
 */
export function assertContiguousTailFrames(
    documentId: string,
    frames: Array<{ type: number; logId: number; payload?: Uint8Array }>,
    afterLogId: number | null,
    throughLogId: number
): void {
    let previous = afterLogId;
    const chunked = new Map<string, { total: number; seen: Set<number> }>();
    for (const frame of frames) {
        if (frame.type !== 2) {
            continue;
        }
        if (!Number.isInteger(frame.logId) || frame.logId <= 0) {
            throw new CloudProtocolError(
                documentId,
                'sync page row without a log id'
            );
        }
        if (previous !== null && frame.logId !== previous + 1) {
            throw new CloudProtocolError(
                documentId,
                `sync page row ${frame.logId} does not follow ${previous}`
            );
        }
        previous = frame.logId;
        const payload = frame.payload;
        if (!payload) {
            continue;
        }
        if (payload.byteLength < 12) {
            throw new CloudProtocolError(
                documentId,
                `sync page row ${frame.logId} is truncated`
            );
        }
        const view = new DataView(
            payload.buffer,
            payload.byteOffset,
            payload.byteLength
        );
        const chunkIndex = view.getUint32(0, false);
        const totalChunks = Math.max(1, view.getUint32(4, false));
        if (totalChunks <= 1) {
            continue;
        }
        const txnLen = view.getUint32(8, false);
        const key =
            new TextDecoder().decode(payload.subarray(12, 12 + txnLen)) ||
            String(frame.logId);
        const state = chunked.get(key) || {
            total: totalChunks,
            seen: new Set<number>()
        };
        state.seen.add(chunkIndex);
        chunked.set(key, state);
    }
    for (const [key, state] of chunked) {
        if (state.seen.size < state.total) {
            throw new CloudProtocolError(
                documentId,
                `sync page carries ${state.seen.size} of ${state.total} chunks of transaction ${key}`
            );
        }
    }
    if (
        previous !== null &&
        Number.isInteger(throughLogId) &&
        throughLogId > 0 &&
        throughLogId < previous
    ) {
        throw new CloudProtocolError(
            documentId,
            `sync page ends at ${throughLogId} but carries row ${previous}`
        );
    }
}

/**
 * The room refused one of this window’s transactions (`clock_gap` or another
 * permanent refusal). The document’s queue stops at `seq`; its rows stay in
 * the write-ahead log.
 */
/**
 * Refusal codes the room sends for one of this window’s rows, over the
 * socket (`{type: 'error', code, seq, …}`) or as an HTTP body. Each is
 * terminal for that document: `clock_gap` (the room misses an earlier row
 * of ours), `prior_refused` (a row after a refusal that already stopped the
 * queue), `metadata_too_large` (our own envelope fitter failed),
 * `packet_too_large`, `digest_mismatch` (the bytes are not what their
 * digest names) and `broken_journal` (the room can't read its own journal).
 */
export const TERMINAL_REFUSAL_CODES: ReadonlySet<string> = new Set([
    'clock_gap',
    'prior_refused',
    'metadata_too_large',
    'packet_too_large',
    'digest_mismatch',
    'broken_journal'
]);

/**
 * Codes the room answers an HTTP request with when it can't take or serve
 * it right now. Nothing is missing: the same request (same seq) is sent
 * again later.
 */
export const TRANSIENT_ROOM_HTTP_CODES: ReadonlySet<string> = new Set([
    'tail_full',
    'rate_limit',
    'journal_failed',
    'validator_unavailable',
    'spool_busy',
    'incomplete_limit',
    'asset_migrating',
    'commit_unacknowledged',
    'state_superseded',
    'state_unavailable'
]);

/**
 * A room HTTP answer that is not a terminal refusal, with what its JSON
 * body says: `code`, `retryable` and the `seq` it is about.
 */
export class CloudRoomHttpError extends Error {
    readonly status: number;
    readonly code: string | null;
    readonly retryable: boolean | null;
    readonly seq: number | null;
    /**
     * A held row: the earlier seq of this writer the room waits for. The
     * writer sends again from that row, with the same seqs.
     */
    readonly refusedSeq: number | null;

    constructor(
        message: string,
        details: {
            status: number;
            code?: unknown;
            retryable?: unknown;
            seq?: unknown;
            refusedSeq?: unknown;
        }
    ) {
        super(message);
        this.name = 'CloudRoomHttpError';
        this.status = details.status;
        this.code = typeof details.code === 'string' ? details.code : null;
        this.retryable =
            typeof details.retryable === 'boolean' ? details.retryable : null;
        this.seq =
            typeof details.seq === 'number' && Number.isFinite(details.seq)
                ? details.seq
                : null;
        this.refusedSeq =
            typeof details.refusedSeq === 'number' &&
            Number.isFinite(details.refusedSeq)
                ? details.refusedSeq
                : null;
    }
}

/**
 * True when a room HTTP answer says “not now”: the same request succeeds
 * later. A terminal code, or `retryable: false`, never is.
 */
export function isTransientRoomHttpAnswer(answer: {
    status: number;
    code?: string | null;
    retryable?: boolean | null;
}): boolean {
    if (answer.code && TERMINAL_REFUSAL_CODES.has(answer.code)) {
        return false;
    }
    if (answer.retryable === true) {
        return true;
    }
    if (answer.retryable === false) {
        return false;
    }
    if (answer.code && TRANSIENT_ROOM_HTTP_CODES.has(answer.code)) {
        return true;
    }
    return (
        answer.status === 408 ||
        answer.status === 409 ||
        answer.status === 429 ||
        answer.status >= 500
    );
}

/** The JSON body of a room error answer, or null. */
export async function readRoomErrorBody(
    response: Response
): Promise<Record<string, unknown> | null> {
    if (typeof response.text !== 'function') {
        const parsed: unknown = await response.json().catch(() => null);
        return parsed && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>)
            : null;
    }
    const text = await response.text().catch(() => '');
    if (!text) {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(text);
        return parsed && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

export class CloudRefusalError extends Error {
    readonly code: string;
    readonly seq: number | null;
    readonly client: number | null;
    readonly need: number | null;
    readonly have: number | null;
    readonly refusedSeq: number | null;

    constructor(
        documentId: string,
        refusal: {
            code: string;
            message?: string;
            seq?: unknown;
            client?: unknown;
            need?: unknown;
            have?: unknown;
            refusedSeq?: unknown;
        }
    ) {
        const num = (value: unknown): number | null =>
            typeof value === 'number' && Number.isFinite(value) ? value : null;
        const seq = num(refusal.seq);
        const detail =
            refusal.code === 'clock_gap'
                ? `client ${String(num(refusal.client) ?? '?')} needs clock ${String(num(refusal.need) ?? '?')}, the room has ${String(num(refusal.have) ?? '?')}`
                : refusal.code === 'prior_refused'
                  ? `update ${String(num(refusal.refusedSeq) ?? '?')} was refused before it`
                  : refusal.message || refusal.code;
        super(
            `The room refused update ${seq === null ? '?' : seq} of ${documentId} (${refusal.code}): ${detail}`
        );
        this.name = 'CloudRefusalError';
        this.code = refusal.code;
        this.seq = seq;
        this.client = num(refusal.client);
        this.need = num(refusal.need);
        this.have = num(refusal.have);
        this.refusedSeq = num(refusal.refusedSeq);
    }
}

/**
 * The room’s refusal of one row, read from an HTTP body, or null when the
 * body names no terminal refusal code.
 */
export function cloudRefusalFromBody(
    documentId: string,
    body: Record<string, unknown> | null,
    seq: number | undefined
): CloudRefusalError | null {
    const code = body?.code;
    if (typeof code !== 'string' || !TERMINAL_REFUSAL_CODES.has(code)) {
        return null;
    }
    return new CloudRefusalError(documentId, {
        code,
        message: typeof body?.message === 'string' ? body.message : undefined,
        seq: body?.seq ?? seq,
        client: body?.client,
        need: body?.need,
        have: body?.have,
        refusedSeq: body?.refusedSeq
    });
}

/**
 * Errors no retry can fix: the document is missing an update, is broken, or
 * holds a drawing that breaks its invariants, or the room refused a row.
 * `DrawingInvariantError` is matched by name; the engine defines it.
 */
export function isTerminalDocumentError(error: unknown): boolean {
    return (
        error instanceof ClockGapError ||
        error instanceof BrokenDocumentError ||
        error instanceof CloudRefusalError ||
        error instanceof CloudProtocolError ||
        error instanceof CollabFrameError ||
        (error instanceof Error && error.name === 'DrawingInvariantError')
    );
}

export { assertEncodableDocumentState };

const DEFAULT_PRODUCTION_ROOM_WORKER_URL =
    'https://room.fonteditor.workers.dev';
const DEFAULT_LOCAL_ROOM_WORKER_URL = 'ws://localhost:8787';
export const CLOUD_ASSET_DELETED_MESSAGE = 'Cloud asset was deleted';
export const CLOUD_GLYPH_CATCH_UP_MAX_ATTEMPTS = 8;
export const CLOUD_GLYPH_CATCH_UP_RETRY_MS = 50;
export const CLOUD_GLYPH_CATCH_UP_CONCURRENCY = 4;
// Shards without a live socket publish over HTTP, and each request waits
// for a cold shard room to load its baseline. A station change publishes
// every glyph shard, so two at a time took ~15 minutes for ~1,000 glyphs
// on staging.
export const CLOUD_GLYPH_PUBLISH_CONCURRENCY = 6;
export const CLOUD_PING_INTERVAL_MS = 10_000;
export const CLOUD_LIVENESS_STALE_MS = 25_000;
/**
 * Must match the room worker's KEEPALIVE_PING_MESSAGE byte for byte. The room
 * answers this exact text while hibernated.
 */
export const CLOUD_KEEPALIVE_PING = '{"type":"ping"}';
export const CLOUD_RECONNECT_BASE_MS = 1_000;
export const CLOUD_RECONNECT_MAX_MS = 30_000;

/** Failed attempts (about two minutes) before an idle hidden tab slows down. */
export const CLOUD_RECONNECT_IDLE_AFTER_ATTEMPTS = 8;
export const CLOUD_RECONNECT_IDLE_MAX_MS = 5 * 60_000;

/**
 * `idle` is a hidden tab with nothing to send: once the quick attempts have
 * failed it retries every few minutes, so a forgotten tab does not keep
 * requesting room tokens through an outage. Showing the tab reconnects at once.
 */
export function cloudReconnectDelayMs(attempt: number, idle = false): number {
    const bounded = Math.max(0, attempt);
    const exponential =
        idle && bounded >= CLOUD_RECONNECT_IDLE_AFTER_ATTEMPTS
            ? CLOUD_RECONNECT_IDLE_MAX_MS
            : Math.min(
                  CLOUD_RECONNECT_BASE_MS * 2 ** Math.min(bounded, 30),
                  CLOUD_RECONNECT_MAX_MS
              );
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.round(exponential * jitter);
}

export function isForbiddenCloudCredentialError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
        /room-token request failed: 40[13]\b/.test(message) ||
        subscriptionLapsedCredentialDetail(error) !== null
    );
}
export const CLOUD_SUBSCRIPTION_LAPSED_CODE = 'subscription_lapsed';
export const CLOUD_SUBSCRIPTION_LAPSED_MESSAGE =
    'Collaboration on this font stopped because the owner’s subscription ended.';
/**
 * The website refused a room token because the owner’s subscription lapsed
 * past the grace period (HTTP 402). Returns the message to show, or null.
 */
export function subscriptionLapsedCredentialDetail(
    error: unknown
): string | null {
    if (
        error instanceof Error &&
        (error as Error & { code?: string }).code ===
            CLOUD_SUBSCRIPTION_LAPSED_CODE
    ) {
        return error.message || CLOUD_SUBSCRIPTION_LAPSED_MESSAGE;
    }
    const message = error instanceof Error ? error.message : String(error);
    const match = /room-token request failed: 402\b\s*([\s\S]*)$/.exec(message);
    if (!match) {
        return null;
    }
    try {
        const body = JSON.parse(match[1]) as {
            error?: string;
            subscriptionLapse?: { message?: string };
        };
        return (
            body?.subscriptionLapse?.message ||
            body?.error ||
            CLOUD_SUBSCRIPTION_LAPSED_MESSAGE
        );
    } catch {
        return CLOUD_SUBSCRIPTION_LAPSED_MESSAGE;
    }
}
/** The website session ended; access to the font itself is unchanged. */
export function isSignedOutCloudCredentialError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /room-token request failed: 401\b/.test(message);
}
export const CLOUD_SIGNED_OUT_MESSAGE =
    'You are signed out. Sign in again to keep editing; unsent edits are kept on this device.';
export const CLOUD_COLLAB_RELOAD_MESSAGE =
    'Please reload the editor to continue collaborating.';
export const CLOUD_COLLAB_FORMAT_CHANGED_MESSAGE =
    'The collaboration format changed. Please reload the editor to continue collaborating.';
export const CLOUD_COLLAB_SERVICE_UPDATING_MESSAGE =
    'The collaboration service is updating. Please try again in a moment.';

export function getDefaultRoomWorkerUrl(): string {
    return isProduction()
        ? DEFAULT_PRODUCTION_ROOM_WORKER_URL
        : DEFAULT_LOCAL_ROOM_WORKER_URL;
}

/** Default website base URL for the room-token endpoint. */
export const DEFAULT_WEBSITE_BASE_URL = resolveWebsiteURL();

export type CloudAssetRole = 'owner' | 'editor' | 'viewer';

export type CloudSeededShardAttestation = {
    shardId: string;
    checkpointObjectKey: string;
    checkpointSha256: string;
    checkpointByteLength: number;
    checkpointLogId: number;
    checkpointAt?: number;
};

export type CloudSeedDocumentSetResult = {
    coreCheckpointLogId: number | null;
    attestations: CloudSeededShardAttestation[];
};

export type CloudShardIoProgress = {
    completed: number;
    total: number;
    bytesCompleted: number;
    bytesTotal: number;
    shardId?: string;
};

/** Overrides for bounded shard HTTP. Production callers omit this. */
export type CloudShardIoOptions = {
    concurrency?: number;
    maxRequests?: number;
    maxBytes?: number;
    transport?: 'auto' | 'pack' | 'per-shard';
    signal?: AbortSignal;
    progressOffset?: number;
    progressTotal?: number;
    progressBytesOffset?: number;
    progressBytesTotal?: number;
    onProgress?: (progress: CloudShardIoProgress) => void | Promise<void>;
    onShardLanded?: (
        attestation: CloudSeededShardAttestation
    ) => void | Promise<void>;
};

export function shardIoConcurrency(
    options: CloudShardIoOptions | undefined,
    fallback: number
): number {
    return Math.max(1, options?.concurrency ?? fallback);
}

export function shardIoTotals(
    options: CloudShardIoOptions | undefined,
    itemCount: number,
    byteLength: number
): {
    completed: number;
    total: number;
    bytesCompleted: number;
    bytesTotal: number;
} {
    return {
        completed: options?.progressOffset ?? 0,
        total: options?.progressTotal ?? itemCount,
        bytesCompleted: options?.progressBytesOffset ?? 0,
        bytesTotal: options?.progressBytesTotal ?? byteLength
    };
}

export async function emitShardIoProgress(
    options: CloudShardIoOptions | undefined,
    progress: CloudShardIoProgress
): Promise<void> {
    throwIfAborted(options?.signal);
    await options?.onProgress?.(progress);
    await yieldToUi();
    throwIfAborted(options?.signal);
}

export function getCloudRequestHeaders(
    extraHeaders: Record<string, string> = {}
): Record<string, string> {
    const headers = { ...extraHeaders };
    const sessionToken = window.authManager?.getSessionToken?.();
    if (sessionToken) {
        headers.Authorization = `Bearer ${sessionToken}`;
    }
    return headers;
}

export const HYDRATE_PACK_FETCH_TIMEOUT_MS = 90_000;

/**
 * AbortSignal.timeout() rejects as TimeoutError ("signal timed out").
 * Older browsers used AbortError for the same timer. A caller-cancelled
 * signal is a different abort and must not be retried.
 */
export function shouldRetryHydrateTransport(
    error: unknown,
    callerAborted: boolean,
    attempt: number
): boolean {
    if (callerAborted || attempt >= 3) {
        return false;
    }
    const name = error instanceof Error ? error.name : '';
    const message = error instanceof Error ? error.message : String(error);
    const ownTimeout =
        name === 'TimeoutError' || /signal timed out/i.test(message);
    if (ownTimeout) {
        return attempt < 1;
    }
    if (name === 'AbortError') {
        return false;
    }
    // The room can't read its own journal: every try fails the same way.
    if (error instanceof CloudRefusalError || /broken_journal/.test(message)) {
        return false;
    }
    // The state moved on or is being rebuilt: asking again gets it.
    if (error instanceof CloudRoomHttpError) {
        return isTransientRoomHttpAnswer(error);
    }
    if (/state_superseded|state_unavailable/.test(message)) {
        return true;
    }
    return /503|Failed to fetch|ERR_ABORTED|ERR_FAILED|NETWORK_CHANGED|unavailable|do_timeout|incomplete|aborted|shard pack hydrate failed: 5\d\d/i.test(
        message
    );
}

export function abortSignalWithTimeout(
    signal: AbortSignal | undefined,
    timeoutMs: number
): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (!signal) {
        return timeout;
    }
    if (typeof AbortSignal.any === 'function') {
        return AbortSignal.any([signal, timeout]);
    }
    return timeout;
}

export async function parseRequiredJsonResponse<T>(
    response: Response,
    errorPrefix: string
): Promise<T> {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
        const body = await response.text().catch(() => '');
        const bodyPreview = body.trim().slice(0, 160);
        throw new Error(
            `${errorPrefix}: expected JSON response but received ${contentType || 'unknown content type'}${bodyPreview ? ` (${bodyPreview})` : ''}`
        );
    }

    return (await response.json()) as T;
}

export type CloudLiveDocumentState = {
    update: string;
    serverStateVector?: string;
    collaborationMessageHistory?: CollaborationMessageEnvelope[];
};

export async function sha256Digest(bytes: Uint8Array): Promise<Uint8Array> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle?.digest) {
        throw new Error('SHA-256 is unavailable in this environment');
    }
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return new Uint8Array(await subtle.digest('SHA-256', buffer));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await sha256Digest(bytes);
    return Array.from(digest, (byte) =>
        byte.toString(16).padStart(2, '0')
    ).join('');
}

export function isPackUnsupportedStatus(status: number): boolean {
    return status === 404 || status === 405;
}

export async function formatPackHttpError(
    response: Response,
    prefix = 'shard pack seed failed'
): Promise<string> {
    const detail = (await response.text().catch(() => '')).trim();
    const clipped = detail.slice(0, 500);
    return clipped
        ? `${prefix}: ${response.status} ${clipped}`
        : `${prefix}: ${response.status}`;
}

export function ackIsDurable(
    msg: Record<string, unknown>,
    pendingIds: string[],
    seq: number
): boolean {
    if (msg.durable !== true) {
        return false;
    }
    if (!pendingIds.length) {
        return true;
    }
    return pendingIds.some((clientTransactionId) =>
        isExactDurableAck(msg, {
            clientTransactionId,
            seq
        })
    );
}

function defaultGlyphCatchUpWait(attempt: number): Promise<void> {
    const delayMs = CLOUD_GLYPH_CATCH_UP_RETRY_MS * 2 ** attempt;
    return new Promise((resolve) => {
        window.setTimeout(resolve, delayMs);
    });
}

function resolvedCatchUpRevision(options: {
    expectedRevision?: string;
    resolveExpectedRevision?: () => string | undefined;
}): string | undefined {
    const live = options.resolveExpectedRevision?.();
    if (typeof live === 'string' && live) {
        return live;
    }
    if (
        typeof options.expectedRevision === 'string' &&
        options.expectedRevision
    ) {
        return options.expectedRevision;
    }
    return undefined;
}

function editorGlyphNamesShowingCloudDocument(documentId: string): string[] {
    const glyphId = glyphIdFromDocumentId(documentId);
    if (!glyphId) {
        return [];
    }
    const outlineEditor = window.glyphCanvas?.outlineEditor;
    if (!outlineEditor?.active) {
        return [];
    }
    const parsed = outlineEditor.parseGlyphStack?.() ?? [];
    const names = [
        ...parsed.map((item: { glyphName?: string }) => item.glyphName),
        window.glyphCanvas?.getCurrentGlyphName?.()
    ].filter((name): name is string => Boolean(name));
    const bridge = window.changeBridge ?? window.patchSyncEngine;
    const matching: string[] = [];
    for (const name of names) {
        if (bridge?.glyphDocumentIdForName?.(name) === documentId) {
            matching.push(name);
            continue;
        }
        const glyph = window.currentFontModel?.resolveGlyphView?.(name);
        if (glyph && 'id' in glyph && glyph.id === glyphId) {
            matching.push(name);
        }
    }
    return matching;
}

/**
 * After a main window applies cloud state for a glyph, its linked windows get
 * the glyph document as main now holds it. A catch-up or socket bootstrap may
 * bring only a tail of transactions, and a linked window that lacks what the
 * tail builds on would keep it pending and never show it, or compile a drawing
 * without its width. The full state merges into whatever the linked window
 * has.
 */
export function relayGlyphStateToLinkedWindows(
    bridge: Pick<PatchSyncEngine, 'encodeDocumentState'>,
    documentId: string
): void {
    if (!window.windowRole?.isMainWindow?.()) {
        return;
    }
    const bytes = bridge.encodeDocumentState?.(documentId);
    if (!bytes?.byteLength) {
        return;
    }
    // Linked windows get only what this window integrated, never changes
    // it holds pending or a document it marked broken.
    assertEncodableDocumentState(bytes, documentId);
    window.windowSync?.broadcastCloudRelayUpdate?.(
        bytes,
        createLinkedWindowCatchUpEnvelope(
            documentId,
            window.windowRole?.instanceId ?? null
        ),
        documentId
    );
}

/**
 * Glyph catch-up patches the Y.Doc and overview tiles, but the outline
 * editor keeps the drawing snapshot loaded at restore. Reload that snapshot
 * the same way a drawing switch does.
 */
export function refreshEditorAfterGlyphDocumentCatchUp(
    documentId: string
): void {
    const showing = editorGlyphNamesShowingCloudDocument(documentId);
    if (!showing.length) {
        return;
    }
    const refresh = window.syncRustCacheAndRefreshCanvas;
    if (typeof refresh === 'function') {
        void refresh(showing[0], showing[0], {
            allowSelectedDrawingFallback: true
        });
        return;
    }
    const outlineEditor = window.glyphCanvas?.outlineEditor;
    if (outlineEditor?.selectedDrawingId) {
        void outlineEditor.fetchDrawingData?.(true, showing[0]);
        return;
    }
    void outlineEditor?.interpolateCurrentGlyph?.(true);
}

/**
 * The room log id each loaded glyph document already holds. A catch-up asks
 * only for log entries after it; without one, `/live` from log zero is
 * answered with the folded shard state. The cursor lives on the document
 * object itself: a document that is unloaded or replaced starts without
 * one, so a cursor never outlives the rows it stands for.
 */
let glyphLogCursors = new WeakMap<object, number>();

type GlyphDocumentInstanceSource = {
    getDocumentInstance?: (documentId: string) => object | null | undefined;
};

function glyphDocumentInstance(
    bridge: unknown,
    documentId: string
): object | null {
    return (
        (bridge as GlyphDocumentInstanceSource | null)?.getDocumentInstance?.(
            documentId
        ) ?? null
    );
}

function glyphLogCursorFor(bridge: unknown, documentId: string): number {
    const doc = glyphDocumentInstance(bridge, documentId);
    return doc ? (glyphLogCursors.get(doc) ?? 0) : 0;
}

/** Move the cursor; call only after every row through `logId` applied. */
function rememberGlyphLogCursor(
    bridge: unknown,
    documentId: string,
    logId: number
): void {
    if (!Number.isFinite(logId) || logId <= 0) {
        return;
    }
    const doc = glyphDocumentInstance(bridge, documentId);
    if (!doc || (glyphLogCursors.get(doc) ?? 0) >= logId) {
        return;
    }
    glyphLogCursors.set(doc, logId);
}

/**
 * Record the log id a room state carried once that state is in the loaded
 * document, so the next catch-up asks only for rows after it. `logId` is
 * what the room said the state holds (`X-Checkpoint-Log-Id`, a pack
 * receipt’s `throughLogId`); a load path that got none leaves the cursor
 * where it is (0 for a fresh document, so the next catch-up gets the whole
 * state) and says so in the trace. Call only after the state applied.
 */
export function rememberLoadedDocumentLogCursor(
    bridge: unknown,
    documentId: string,
    logId: number | null | undefined,
    path: string
): void {
    rememberLoadedDocumentLogCursors(bridge, [[documentId, logId]], path);
}

/**
 * `rememberLoadedDocumentLogCursor` for every document one load applied.
 * Documents without a log id share one trace naming the path.
 */
export function rememberLoadedDocumentLogCursors(
    bridge: unknown,
    loads: Iterable<readonly [string, number | null | undefined]>,
    path: string
): void {
    const withoutLogId: string[] = [];
    for (const [documentId, logId] of loads) {
        if (typeof logId === 'number' && Number.isInteger(logId) && logId > 0) {
            rememberGlyphLogCursor(bridge, documentId, logId);
        } else {
            withoutLogId.push(documentId);
        }
    }
    if (withoutLogId.length) {
        recordCollabTrace('log-cursor-unknown', [], {
            path,
            count: withoutLogId.length,
            documents: withoutLogId.slice(0, 20)
        });
    }
}

/** The cursor the next catch-up of `documentId` asks after (tests, traces). */
export function loadedDocumentLogCursor(
    bridge: unknown,
    documentId: string
): number {
    return glyphLogCursorFor(bridge, documentId);
}

/** Forget every cursor (tests). */
export function resetGlyphLogCursors(): void {
    glyphLogCursors = new WeakMap();
}

export async function catchUpCloudDocument(options: {
    bridge: PatchSyncEngine;
    token: string;
    roomUrl: string;
    websiteBaseUrl: string;
    assetId: string;
    documentId: string;
    expectedRevision?: string;
    resolveExpectedRevision?: () => string | undefined;
    maxAttempts?: number;
    wait?: (attempt: number) => Promise<void>;
}): Promise<boolean> {
    const liveUrl = new URL(
        normalizeCloudShardLiveHttpUrl(
            options.roomUrl,
            options.websiteBaseUrl,
            options.assetId,
            options.documentId
        )
    );
    let afterLogId = 0;
    const setAfterLogId = (cursor: number): void => {
        afterLogId = cursor;
        liveUrl.searchParams.set('afterLogId', String(cursor));
    };
    const resident =
        typeof options.bridge.hasResidentGlyphDocument !== 'function' ||
        options.bridge.hasResidentGlyphDocument(options.documentId) === true;
    // When the cursor is below the room’s checkpoint, the room answers with the
    // folded shard state (`X-Catch-Up: state`) instead of a 409 and a second
    // request to /state.
    liveUrl.searchParams.set('rebaseline', 'state');
    // The cursor belongs to one document instance. Rows after it apply only
    // to that instance: an unload or a new hydrate meanwhile replaces it.
    let cursorInstance = resident
        ? glyphDocumentInstance(options.bridge, options.documentId)
        : null;
    setAfterLogId(
        resident ? glyphLogCursorFor(options.bridge, options.documentId) : 0
    );
    recordCollabTrace('log-fetch', [], {
        document: options.documentId,
        after: afterLogId,
        resident,
        caller: new Error().stack?.split('\n').slice(2, 6) ?? []
    });
    /**
     * True when the document the cursor was read from is gone or replaced.
     * The cursor then restarts from the current instance (0, the folded
     * state, when it is not loaded); the response is thrown away.
     */
    const cursorInstanceReplaced = (): boolean => {
        if (afterLogId <= 0) {
            // From 0 the room answers with the whole state, which applies
            // to whichever instance holds the document.
            return false;
        }
        const current = glyphDocumentInstance(
            options.bridge,
            options.documentId
        );
        if (current === cursorInstance) {
            return false;
        }
        cursorInstance = current;
        setAfterLogId(
            current ? glyphLogCursorFor(options.bridge, options.documentId) : 0
        );
        return true;
    };
    const noteCursorInstance = (): void => {
        cursorInstance = glyphDocumentInstance(
            options.bridge,
            options.documentId
        );
    };
    let instanceRestarts = 0;
    const maxAttempts = Math.max(
        1,
        options.maxAttempts ?? CLOUD_GLYPH_CATCH_UP_MAX_ATTEMPTS
    );
    const wait = options.wait ?? defaultGlyphCatchUpWait;
    let lastError: Error | null = null;
    let fetchedCertifiedCheckpoint = false;

    const revisionSatisfied = (): boolean => {
        const expectedRevision = resolvedCatchUpRevision(options);
        if (
            !expectedRevision ||
            typeof options.bridge.glyphHasCatchUpRevision !== 'function'
        ) {
            return true;
        }
        return options.bridge.glyphHasCatchUpRevision(
            options.documentId,
            expectedRevision
        );
    };

    const applyCatchUpBytes = (bytes: Uint8Array): boolean => {
        if (!bytes.byteLength) {
            return false;
        }
        let applied = false;
        if (typeof options.bridge.applyDocumentCatchUp === 'function') {
            applied = options.bridge.applyDocumentCatchUp(
                options.documentId,
                bytes,
                undefined,
                undefined,
                resolvedCatchUpRevision(options)
            );
        } else {
            options.bridge.applyDocumentCheckpoint?.(options.documentId, bytes);
            applied = true;
        }
        // Main keeps what it received even when the revision is not there yet
        // or its own document had it already; its linked windows may not.
        relayGlyphStateToLinkedWindows(options.bridge, options.documentId);
        if (applied && !revisionSatisfied()) {
            applied = false;
        }
        return applied;
    };

    const applyCertifiedCheckpoint = async (
        stateResponse?: Response
    ): Promise<boolean> => {
        const stateUrl = normalizeCloudShardHttpUrl(
            options.roomUrl,
            options.websiteBaseUrl,
            options.assetId,
            options.documentId
        );
        const response =
            stateResponse ??
            (await fetch(stateUrl, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${options.token}`,
                    Accept: 'application/octet-stream'
                }
            }));
        if (!response.ok) {
            return false;
        }
        const through = Number(response.headers.get('X-Checkpoint-Log-Id'));
        const bytes = new Uint8Array(await response.arrayBuffer());
        const ok = applyCatchUpBytes(bytes);
        if (bytes.byteLength) {
            // The state is the checkpoint folded with the live tail through
            // this log id; later catch-ups start after it.
            noteCursorInstance();
            rememberGlyphLogCursor(options.bridge, options.documentId, through);
            if (Number.isInteger(through) && through > afterLogId) {
                setAfterLogId(through);
            }
        }
        return ok;
    };

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (attempt > 0) {
            await wait(attempt - 1);
        }
        const expectedRevision = resolvedCatchUpRevision(options);
        if (
            expectedRevision &&
            typeof options.bridge.glyphHasCatchUpRevision === 'function' &&
            options.bridge.glyphHasCatchUpRevision(
                options.documentId,
                expectedRevision
            )
        ) {
            return true;
        }
        try {
            const response = await fetch(liveUrl.toString(), {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${options.token}`,
                    Accept: 'application/octet-stream, application/json'
                }
            });
            if (response.status === 401 || response.status === 403) {
                throw new Error(
                    `Live glyph catch-up failed (${response.status}) for ${options.documentId}`
                );
            }
            if (response.status === 404) {
                lastError = new Error(
                    `Live glyph catch-up not found for ${options.documentId}`
                );
                if (!expectedRevision) {
                    return false;
                }
                continue;
            }
            if (response.status === 409) {
                const body = (await response.json().catch(() => null)) as {
                    code?: string;
                    lastCheckpointLogId?: number;
                } | null;
                const nextCursor = Number(body?.lastCheckpointLogId);
                if (
                    body?.code === 'rebaseline_required' &&
                    Number.isInteger(nextCursor) &&
                    nextCursor > afterLogId
                ) {
                    setAfterLogId(nextCursor);
                }
                if (
                    body?.code === 'rebaseline_required' &&
                    !fetchedCertifiedCheckpoint
                ) {
                    // Log zero is behind the retained checkpoint. The shard
                    // state response is the checkpoint folded with the live
                    // tail, which is the outline the room will serve.
                    fetchedCertifiedCheckpoint = true;
                    if (await applyCertifiedCheckpoint()) {
                        refreshEditorAfterGlyphDocumentCatchUp(
                            options.documentId
                        );
                        return true;
                    }
                }
                lastError = new Error(
                    `Live glyph catch-up failed (409) for ${options.documentId}`
                );
                continue;
            }
            if (!response.ok) {
                const body = await readRoomErrorBody(response);
                const refusal = cloudRefusalFromBody(
                    options.documentId,
                    body,
                    undefined
                );
                if (refusal) {
                    // `broken_journal`: the room can't read this glyph's
                    // journal; asking again gets the same answer.
                    throw refusal;
                }
                lastError = new CloudRoomHttpError(
                    `Live glyph catch-up failed (${response.status}${typeof body?.code === 'string' ? ` ${body.code}` : ''}) for ${options.documentId}`,
                    {
                        status: response.status,
                        code: body?.code,
                        retryable: body?.retryable
                    }
                );
                continue;
            }
            if (response.headers.get('X-Catch-Up') === 'state') {
                fetchedCertifiedCheckpoint = true;
                if (await applyCertifiedCheckpoint(response)) {
                    refreshEditorAfterGlyphDocumentCatchUp(options.documentId);
                    return true;
                }
                lastError = new Error(
                    `Live glyph catch-up revision mismatch for ${options.documentId}`
                );
                continue;
            }
            const contentType = response.headers.get('content-type') || '';
            let tailHighWater = Number.NaN;
            let update: Uint8Array = new Uint8Array();
            let collaborationMessageHistory:
                CollaborationMessageEnvelope[] | undefined;
            let payloadsToApply: Uint8Array[] = [];
            if (
                contentType.toLowerCase().includes('application/octet-stream')
            ) {
                const bytes = new Uint8Array(await response.arrayBuffer());
                const frames = decodeCollabLiveFrames(bytes);
                const terminal = frames.find((frame) => frame.type === 3);
                const hasTerminal = !!terminal;
                tailHighWater = Number(terminal?.logId);
                if (!hasTerminal) {
                    lastError = new Error(
                        `Live glyph catch-up missing terminal frame for ${options.documentId}`
                    );
                    continue;
                }
                const checkpoint = frames.find((frame) => frame.type === 1);
                if (checkpoint) {
                    collaborationMessageHistory = decodeCheckpointMeta(
                        checkpoint.payload
                    ).collaborationMessageHistory;
                }
                // Rows follow the cursor, or the room's checkpoint when the
                // cursor is older; a hole throws before anything applies.
                const checkpointLogId =
                    checkpoint && Number.isInteger(checkpoint.logId)
                        ? checkpoint.logId
                        : 0;
                assertContiguousTailFrames(
                    options.documentId,
                    frames,
                    afterLogId > 0
                        ? Math.max(afterLogId, checkpointLogId)
                        : null,
                    tailHighWater
                );
                payloadsToApply = assembleTailTransactionsFromFrames(frames);
                update = payloadsToApply[0] || new Uint8Array();
            } else {
                const payload =
                    await parseRequiredJsonResponse<CloudLiveDocumentState>(
                        response,
                        'Live glyph catch-up'
                    );
                collaborationMessageHistory =
                    payload.collaborationMessageHistory;
                update =
                    typeof payload.update === 'string' &&
                    payload.update.length > 0
                        ? base64ToU8(payload.update)
                        : new Uint8Array();
            }
            if (cursorInstanceReplaced()) {
                // Rows after the old cursor would land on a document that
                // does not hold the rows before them. Ask again from the
                // current instance's cursor; this does not use up an attempt.
                lastError = new Error(
                    `Live glyph catch-up for ${options.documentId} started on a document that was unloaded or replaced`
                );
                if (instanceRestarts < maxAttempts) {
                    instanceRestarts += 1;
                    attempt -= 1;
                }
                continue;
            }
            if (!update.length && !payloadsToApply.length) {
                // Nothing after this document's cursor: it already holds the
                // room's tail. The room names a revision only once its write
                // is durable, so the expected write is in it, whichever
                // concurrent writer's stamp the document kept. Waiting for
                // that stamp would hold back every later catch-up.
                if (resident && Number.isInteger(tailHighWater)) {
                    return true;
                }
                lastError = new Error(
                    `Live glyph catch-up returned empty state for ${options.documentId}`
                );
                if (!expectedRevision) {
                    return false;
                }
                continue;
            }
            let applied = false;
            const updatesToApply = payloadsToApply.length
                ? payloadsToApply
                : [update];
            // Parts apply strictly in log order; a part that does not
            // integrate throws (the integrity gate), so the cursor below only
            // moves once every part is in the document.
            for (const part of updatesToApply) {
                if (!part.byteLength) {
                    continue;
                }
                if (typeof options.bridge.applyDocumentCatchUp === 'function') {
                    applied = options.bridge.applyDocumentCatchUp(
                        options.documentId,
                        part,
                        collaborationMessageHistory
                    );
                } else {
                    options.bridge.applyDocumentCheckpoint?.(
                        options.documentId,
                        part
                    );
                    applied = true;
                }
            }
            // Everything through the tail’s high-water log id is now in the
            // document; a retry or the next catch-up starts after it.
            noteCursorInstance();
            rememberGlyphLogCursor(
                options.bridge,
                options.documentId,
                tailHighWater
            );
            if (Number.isInteger(tailHighWater) && tailHighWater > afterLogId) {
                setAfterLogId(tailHighWater);
            }
            if (updatesToApply.some((part) => part.byteLength)) {
                // Main keeps these parts even when the revision is not there
                // yet or it had them already; its linked windows may not.
                relayGlyphStateToLinkedWindows(
                    options.bridge,
                    options.documentId
                );
            }
            // Through the room's tail, the document holds the expected
            // write even when a concurrent writer's stamp won (see above).
            if (
                applied &&
                expectedRevision &&
                !Number.isInteger(tailHighWater) &&
                typeof options.bridge.glyphHasCatchUpRevision === 'function' &&
                !options.bridge.glyphHasCatchUpRevision(
                    options.documentId,
                    expectedRevision
                )
            ) {
                applied = false;
            }
            if (!applied) {
                lastError = new Error(
                    `Live glyph catch-up revision mismatch for ${options.documentId}`
                );
                continue;
            }
            refreshEditorAfterGlyphDocumentCatchUp(options.documentId);
            return true;
        } catch (error) {
            // A gap, a broken document or a drawing that breaks its
            // invariants comes back the same on every attempt.
            if (
                isTerminalDocumentError(error) ||
                (error instanceof Error &&
                    /Live glyph catch-up failed \(40[13]\)/.test(error.message))
            ) {
                throw error;
            }
            lastError =
                error instanceof Error
                    ? error
                    : new Error(
                          `Live glyph catch-up failed for ${options.documentId}`
                      );
        }
    }

    if (lastError) {
        throw lastError;
    }
    return false;
}

type PublishCloudDocumentUpdateOptions = {
    token: string;
    roomUrl: string;
    websiteBaseUrl: string;
    assetId: string;
    documentId: string;
    update: Uint8Array;
    collaborationMessage?: CollaborationMessageEnvelope | null;
    /**
     * This writer's name in the room, one per live session: the room keeps
     * its refusals and holds under it. Required; never derived.
     */
    clientId: string;
    /** The seq of an update sent as one transaction. */
    seq: number;
    /**
     * The seqs of an update sent in several parts, one increasing seq per
     * part, asked for once per update with the part count. The caller keeps
     * them, so a resend uses the same seqs. Required for a parted update.
     */
    partSeqs?: (count: number) => readonly number[];
    clientTransactionId?: string | null;
    signal?: AbortSignal;
};

/** The writer name a publish carries; throws when it has none. */
function requireHttpClientId(options: { clientId?: unknown }): string {
    const clientId =
        typeof options.clientId === 'string' ? options.clientId.trim() : '';
    if (!clientId) {
        throw new TypeError(
            'A cloud HTTP publish needs the live session’s writer name (clientId).'
        );
    }
    return clientId;
}

/** The part seqs `options.partSeqs` gives for `count` parts, checked. */
function requirePartSeqs(
    options: PublishCloudDocumentUpdateOptions,
    count: number
): readonly number[] {
    if (typeof options.partSeqs !== 'function') {
        throw new TypeError(
            `A cloud HTTP update of ${options.documentId} in ${count} parts needs one seq per part.`
        );
    }
    const seqs = options.partSeqs(count);
    const valid =
        seqs.length === count &&
        seqs.every(
            (seq, index) =>
                Number.isSafeInteger(seq) &&
                seq > 0 &&
                (index === 0 || seq > seqs[index - 1])
        );
    if (!valid) {
        throw new TypeError(
            `The part seqs of a cloud HTTP update of ${options.documentId} must be ${count} increasing numbers, got ${JSON.stringify(seqs)}.`
        );
    }
    return seqs;
}

/** Acknowledged parts per large HTTP edit, so a retried publish resumes. */
const httpPartProgress = new Map<string, number>();
const MAX_HTTP_PART_PROGRESS_ENTRIES = 200;
/** Delays before sending a part again while the room’s tail is full. */
export const HTTP_PART_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new Error('aborted'));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason ?? new Error('aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * POST one update to a glyph room over HTTP `/live`. An update too large for
 * one room transaction is sent as several, one after another (see
 * cloud-adapter-outbound-parts.ts); the result is true once the last part is
 * durable.
 */
export async function publishCloudDocumentUpdate(
    options: PublishCloudDocumentUpdateOptions
): Promise<boolean> {
    if (
        !options.documentId ||
        options.documentId === FONT_CORE_DOCUMENT_ID ||
        options.documentId === FONT_DEPS_DOCUMENT_ID ||
        !options.update?.length
    ) {
        return false;
    }
    requireHttpClientId(options);
    const clientTransactionId =
        options.clientTransactionId || allocateClientTransactionId('http');
    const parts = needsOutboundParts(options.update)
        ? planOutboundParts({
              update: options.update,
              collaborationMessage: options.collaborationMessage,
              clientTransactionId
          })
        : null;
    if (!parts || parts.length <= 1) {
        return publishCloudDocumentPart({ ...options, clientTransactionId });
    }
    // One increasing seq per part, the same on every resend: the room
    // orders the parts against each other and holds a later part behind an
    // earlier one it has not committed.
    const seqs = requirePartSeqs(options, parts.length);
    const noteProgress = (nextIndex: number): void => {
        if (httpPartProgress.size >= MAX_HTTP_PART_PROGRESS_ENTRIES) {
            const oldest = httpPartProgress.keys().next().value;
            if (oldest !== undefined) {
                httpPartProgress.delete(oldest);
            }
        }
        httpPartProgress.set(clientTransactionId, nextIndex);
    };
    let index = Math.min(
        httpPartProgress.get(clientTransactionId) ?? 0,
        parts.length - 1
    );
    let attempt = 0;
    while (index < parts.length) {
        const part = parts[index];
        try {
            const durable = await publishCloudDocumentPart({
                ...options,
                update: part.update,
                collaborationMessage: part.collaborationMessage ?? null,
                seq: seqs[index],
                clientTransactionId:
                    part.clientTransactionId || clientTransactionId
            });
            if (!durable) {
                return false;
            }
        } catch (error) {
            const status = (error as { status?: number }).status;
            // A full tail clears once the room has compacted the parts
            // before this one; a busy validator answers again shortly.
            // A refusal (`clock_gap`, `prior_refused`, also a 409) is
            // terminal and never retried.
            const retryable =
                !(error instanceof CloudRefusalError) &&
                (error instanceof CloudRoomHttpError
                    ? isTransientRoomHttpAnswer(error)
                    : status === 409 || status === 503);
            if (!retryable) {
                throw error;
            }
            // A held part names the earlier part the room waits for: send
            // again from that one, with the same seqs.
            const refusedIndex =
                error instanceof CloudRoomHttpError && error.refusedSeq !== null
                    ? seqs.indexOf(error.refusedSeq)
                    : -1;
            if (refusedIndex >= 0 && refusedIndex < index) {
                index = refusedIndex;
                noteProgress(index);
            }
            if (attempt >= HTTP_PART_RETRY_DELAYS_MS.length) {
                throw error;
            }
            await waitForRetry(
                HTTP_PART_RETRY_DELAYS_MS[attempt],
                options.signal
            );
            attempt += 1;
            continue;
        }
        attempt = 0;
        index += 1;
        if (index < parts.length) {
            noteProgress(index);
        }
    }
    httpPartProgress.delete(clientTransactionId);
    return true;
}

async function publishCloudDocumentPart(
    options: PublishCloudDocumentUpdateOptions & { clientTransactionId: string }
): Promise<boolean> {
    const liveUrl = normalizeCloudShardLiveHttpUrl(
        options.roomUrl,
        options.websiteBaseUrl,
        options.assetId,
        options.documentId
    );
    const clientTransactionId = options.clientTransactionId;
    const body: Record<string, unknown> = {
        type: 'update',
        update: u8ToBase64(options.update),
        seq: options.seq,
        clientId: requireHttpClientId(options),
        clientTransactionId
    };
    if (options.collaborationMessage) {
        body.collaborationMessages = [options.collaborationMessage];
    }
    const response = await fetch(liveUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${options.token}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: options.signal
    });
    if (response.status === 401 || response.status === 403) {
        const error = new Error(
            `Live glyph publish failed (${response.status}) for ${options.documentId}`
        ) as Error & { status?: number };
        error.status = response.status;
        throw error;
    }
    if (!response.ok) {
        const refusal = await readRoomErrorBody(response);
        const refusalError = cloudRefusalFromBody(
            options.documentId,
            refusal,
            options.seq
        );
        if (refusalError) {
            // The room refused this row for good (a missing earlier row, an
            // earlier refusal): stop here, never retry like `tail_full`.
            const error = refusalError as CloudRefusalError & {
                status?: number;
            };
            error.status = response.status;
            throw error;
        }
        const answer = new CloudRoomHttpError(
            `Live glyph publish failed (${response.status}${typeof refusal?.code === 'string' ? ` ${refusal.code}` : ''}) for ${options.documentId}`,
            {
                status: response.status,
                code: refusal?.code,
                retryable: refusal?.retryable,
                seq: refusal?.seq ?? options.seq,
                refusedSeq: refusal?.refusedSeq
            }
        );
        if (
            !isTransientRoomHttpAnswer(answer) &&
            refusal?.code &&
            (answer.retryable === false ||
                response.status === 400 ||
                response.status === 413 ||
                response.status === 422)
        ) {
            // A code the room says it refuses every time (`retryable:
            // false`): terminal for this row, like the codes above.
            const error = new CloudRefusalError(options.documentId, {
                code: String(refusal.code),
                message:
                    typeof refusal.message === 'string'
                        ? refusal.message
                        : undefined,
                seq: refusal.seq ?? options.seq,
                refusedSeq: refusal.refusedSeq
            }) as CloudRefusalError & { status?: number };
            error.status = response.status;
            throw error;
        }
        throw answer;
    }
    const payload = (await response.json().catch(() => null)) as Record<
        string,
        unknown
    > | null;
    const acceptedRefusal = cloudRefusalFromBody(
        options.documentId,
        payload,
        options.seq
    );
    if (acceptedRefusal) {
        throw acceptedRefusal;
    }
    return isExactDurableAck(
        payload
            ? {
                  type: 'ack',
                  ...payload
              }
            : null,
        {
            clientTransactionId,
            seq: options.seq
        }
    );
}

/**
 * Maximum bytes per WebSocket message (Cloudflare Workers limit: 1 MB).
 * We target 750 KB per chunk to leave headroom for JSON framing.
 */
export const CLIENT_RECONNECT_CLOSE_CODE = 4000;
export const AUTHENTICATION_TIMEOUT_MS = 10000;
export const AUTHENTICATION_MAX_WAIT_MS = 30000;
export const OUTBOUND_ACK_TIMEOUT_MS = 10000;
export const OUTBOUND_ACK_MAX_WAIT_MS = 30000;
export const INITIAL_SYNC_TIMEOUT_MS = 10000;
export const INITIAL_SYNC_MAX_WAIT_MS = 30000;
export const TRANSFER_ACTIVITY_HOLD_MS = 450;

export type CloudConnectionStatus =
    | 'disconnected'
    | 'connecting'
    | 'authenticating'
    | 'syncing'
    | 'connected'
    | 'error';

export type CloudTransferActivity = 'idle' | 'sending' | 'receiving';

export type CloudAdapterOptions = {
    assetId: string;
    websiteBaseUrl?: string;
    roomWorkerBaseUrl?: string;
    documentId?: string;
    onConnectionStatus?: (
        status: CloudConnectionStatus,
        detail?: string
    ) => void;
    onPendingSyncCountChange?: (count: number) => void;
    onTransferActivityChange?: (activity: CloudTransferActivity) => void;
    /** Session owns the one reconnect rebaseline after every live shard is fresh. */
    deferVisibleRebaseline?: boolean;
    wal?: CloudDurableWal;
    refreshCredentials?: () => Promise<{ token: string; roomUrl: string }>;
    /**
     * The room refused an edit because this user may no longer write. The
     * owner of the shared outbox (the session) keeps every unsent edit in
     * the write-ahead log and stops sending.
     */
    onWriteAccessLost?: () => void;
    /** True while this window may not send edits (the session knows). */
    isReadOnly?: () => boolean;
    /**
     * True while this document's edits go out through the session's HTTP
     * outbox (it still has HTTP rows to send). The socket then leaves this
     * window's local edits to that outbox, so the room gets the document's
     * edits over one channel, in order, and never a later one first.
     */
    routesOutboundElsewhere?: () => boolean;
    /** Unsent edits were found and kept, not restored, while read-only. */
    onUnsentEditsKept?: (count: number) => void;
};

export type CloudConnectionHealth = {
    wsReadyState: number | null;
    lastInboundMessageAt: number;
    lastInboundAgeMs: number | null;
    livenessTimeoutCount: number;
    lastReconnectReason: string | null;
};

export type CloudAccessCloseEvent = {
    code: number;
    reason: string;
};

export type CloudAccessServerError = {
    message: string;
    code?: string;
};

export type CloudAdapterAccessSnapshot = {
    documentId: string;
    status: CloudConnectionStatus;
    statusDetail?: string;
    wsReadyState: number | null;
    lastClose: CloudAccessCloseEvent | null;
    lastServerError: CloudAccessServerError | null;
    accessRevoked: boolean;
    reconnectForbidden: boolean;
    roomToken?: string | null;
    roomUrl: string | null;
    role: CloudAssetRole | null;
};

export type CloudLiveUpdateMessage = {
    update: Uint8Array;
    collaborationMessages?: CollaborationMessageEnvelope[];
    logId?: number;
    /** Sender's client id, kept for protocol error reports. */
    clientId?: string;
    /** This window's own row: already in the document, only the cursor moves. */
    ownRow?: boolean;
};

type CloudVisibleRebaselineTargets = {
    editingFontRecompiled: boolean;
    textPreviewReshaped: boolean;
    canvasRefreshed: boolean;
    overviewRefreshed: boolean;
    fontInfoRefreshed: boolean;
};

export async function runCloudVisibleReconnectRebaseline(): Promise<CloudVisibleRebaselineTargets> {
    const refreshed: CloudVisibleRebaselineTargets = {
        editingFontRecompiled: false,
        textPreviewReshaped: false,
        canvasRefreshed: false,
        overviewRefreshed: false,
        fontInfoRefreshed: false
    };

    if (typeof window.syncRustCacheAndRefreshCanvas === 'function') {
        await window.syncRustCacheAndRefreshCanvas(undefined, undefined, {
            allowSelectedDrawingFallback: true
        });
        refreshed.canvasRefreshed = true;
    }

    if (typeof window.fontManager?.recompileEditingFont === 'function') {
        await window.fontManager.recompileEditingFont();
        refreshed.editingFontRecompiled = true;
    }

    const textRunEditor = window.glyphCanvas?.textRunEditor as
        | {
              shapeText?: (skipRender?: boolean) => void;
          }
        | undefined;
    if (typeof textRunEditor?.shapeText === 'function') {
        textRunEditor.shapeText();
        refreshed.textPreviewReshaped = true;
    }

    const glyphOverview = window.glyphOverviewInstance as
        | {
              renderGlyphOutlines?: (
                  location?: Record<string, number>
              ) => Promise<void>;
              syncActiveGlyphFocus?: () => void;
              currentLocation?: Record<string, number>;
          }
        | null
        | undefined;
    if (typeof glyphOverview?.renderGlyphOutlines === 'function') {
        await glyphOverview.renderGlyphOutlines(
            glyphOverview.currentLocation ?? {}
        );
        glyphOverview.syncActiveGlyphFocus?.();
        refreshed.overviewRefreshed = true;
    }

    if (
        typeof window.fontInfoManager?.refreshVisibleContentForExternalSync ===
        'function'
    ) {
        window.fontInfoManager.refreshVisibleContentForExternalSync();
        refreshed.fontInfoRefreshed = true;
    }

    return refreshed;
}

export function dedupeCollaborationMessages(
    envelopes: CollaborationMessageEnvelope[]
): CollaborationMessageEnvelope[] {
    const seenEnvelopeKeys = new Set<string>();
    const deduped: CollaborationMessageEnvelope[] = [];

    for (const envelope of envelopes) {
        const envelopeKey = collaborationMessageKey(envelope);
        if (seenEnvelopeKeys.has(envelopeKey)) {
            continue;
        }
        seenEnvelopeKeys.add(envelopeKey);
        deduped.push(envelope);
    }

    return deduped;
}

export function importCollaborationMessageHistory(
    bridge: PatchSyncEngine,
    collaborationMessageHistory?: CollaborationMessageEnvelope[],
    pendingCollaborationMessages: CollaborationMessageEnvelope[] = []
): void {
    const envelopes = dedupeCollaborationMessages([
        ...(collaborationMessageHistory ?? []),
        ...pendingCollaborationMessages
    ]);

    if (!envelopes.length) {
        return;
    }

    // The room’s history lists every author’s edits. It goes to the History
    // view as collaborator items only: undo is author-only, and this
    // window’s own edits are already in its change log.
    bridge.mergeImportedCollaborationMessages(
        envelopes.map((message) => ({
            id: collaborationMessageKey(message),
            direction: 'remote',
            timestamp: message.timestamp,
            transactionDurationMs:
                message.metadata.transactionDurationMs ?? null,
            summary: message.summary,
            label: message.label,
            source: message.source,
            editSource: message.metadata.editSource ?? null,
            windowId: message.windowId,
            windowRoleLabel:
                message.metadata.sourceWindowRoleLabel ??
                window.windowRole?.getRoleLabel?.() ??
                'main',
            historyItemId: message.metadata.historyItemId,
            promptGroupId: message.metadata.promptGroupId ?? null,
            historyAction: message.metadata.historyAction,
            targetHistoryItemId: message.metadata.targetHistoryItemId ?? null,
            undoScope: message.metadata.undoScope,
            undoSurfaceAffinity: message.metadata.undoSurfaceAffinity ?? null,
            historyTargetKey: message.metadata.historyTargetKey ?? null,
            historyTargetLabel: message.metadata.historyTargetLabel ?? null,
            originatingGlyphName: message.metadata.originatingGlyphName ?? null,
            originatingLayerId: message.metadata.originatingLayerId ?? null,
            updateByteLength: 0,
            updateBase64Preview: '',
            changedGlyphNames: [...message.metadata.changedGlyphNames],
            changedLayerIds: [...message.metadata.changedLayerIds],
            workerReplayTargets: [...message.metadata.workerReplayTargets],
            ...allGlyphsChangedFlag(message.metadata),
            changes: message.changes,
            derivedForwardChanges: []
        }))
    );
}

/**
 * `metadata.allGlyphsChanged` says the envelope was widened to every glyph
 * of its document (its glyph lists are empty on purpose). Every copy of an
 * envelope's metadata carries it, or a receiver would read “no glyphs”.
 */
export function allGlyphsChangedFlag(metadata: object): {
    allGlyphsChanged?: true;
} {
    return (metadata as { allGlyphsChanged?: unknown }).allGlyphsChanged ===
        true
        ? { allGlyphsChanged: true }
        : {};
}

// ── Binary ↔ base64 helpers ──────────────────────────────────────────────────

export function u8ToBase64(u8: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < u8.length; i++) {
        binary += String.fromCharCode(u8[i]);
    }
    return btoa(binary);
}

export function base64ToU8(b64: string): Uint8Array {
    const binary = atob(b64);
    const u8 = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        u8[i] = binary.charCodeAt(i);
    }
    return u8;
}

export function getLiveUpdateChunkKey(
    clientId: string | null | undefined,
    seq: number | null | undefined
): string | null {
    if (!clientId || typeof seq !== 'number' || !Number.isFinite(seq)) {
        return null;
    }

    return `${clientId}:${seq}`;
}
