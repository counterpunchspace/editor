/**
 * CloudPlugin — FilesystemPlugin wrapper for CloudAdapter.
 *
 * Phase 1: eligibility check, openAsset, saveAs (seed DO), getAssets.
 * Exposed as window.cloudPlugin; window.cloudDebug kept for dev testing.
 */

import {
    FilesystemPlugin,
    type CanAddGlyphsResult,
    type FileContextAction,
    type FileContextTarget,
    type PluginMessageOptions,
    type TitleBarMenuItem
} from '../filesystem-plugin';
import { pluginRegistry } from '../registry';
import {
    CloudAdapter,
    CloudAdapterOptions,
    CloudConnectionStatus,
    type CloudTransferActivity,
    type CloudSeededShardAttestation,
    type CloudShardIoOptions,
    normalizeCloudRoomWebSocketUrl
} from '../../cloud-adapter';
import {
    isTransferCancelled,
    loadDocumentSetWithProgress,
    seedDocumentSetWithProgress,
    shardIoOptionsFromSession
} from '../cancellable-shard-transfer';
import {
    CloudLiveSession,
    activeEditorGlyphNames,
    liveGlyphDocumentIdsFromSubset
} from '../../cloud-live-session';
import {
    PatchSyncEngine,
    type CommittedChangeListener
} from '../../patch-sync-engine';
import { setCollabIntegritySnapshotProvider } from '../../cloud-collab-integrity-debug';
import { Logger } from '../../logger';
import { getPathSegments } from '../../change-log';
import { resolveWebsiteURL } from '../../website-url';
import { readUrlState } from '../../url-state';
import { beginLoadingCursor, endLoadingCursor } from '../../loading-cursor';
import {
    applyCloudOwnedData,
    catalogFromCoreJson,
    catalogNeedsUpdate,
    incompleteCloudSeedReason,
    liveCatalogGlyphIds,
    listGlyphRecords,
    patchCloudOwnedGlyph,
    stripOwnedFontData
} from '../cloud-glyph-catalog';
import { missingRequiredCloudCapabilities } from '../cloud-collab-capabilities';
import {
    catalogEntriesForDepsParse,
    depsNeedUpdate,
    readFontDepsIndex,
    resolveHydrationSeeds,
    writeCompleteFontDepsIfLoaded
} from '../cloud-font-deps';
import {
    CloudDocumentSet,
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID,
    glyphDocumentId,
    glyphIdsFromRevisionEntries,
    hydrateSparseGlyphsToFixedPoint,
    hydrateCoreDepsToPublishedPair,
    type EncodedShard
} from '../cloud-document-set';
import {
    ensureMigrationRevisionTokens,
    hashShardBytes,
    revisionCoverageFromDocumentSet
} from '../cloud-asset-migration';
import {
    evaluateShardSizes,
    evaluateCollabSubmit,
    formatCollabSubmitRejection,
    MAX_SHARD_BYTES,
    MAX_YJS_PACKET_BYTES,
    shouldAutoSparseHydrate,
    shouldExactEncodeAssetSize,
    type ShardSizeGate,
    type ShardSizeReport,
    type CollabSubmitDecision,
    type CollabSubmitRequest
} from '../cloud-shard-limits';
import type { CollaborationMessageEnvelope } from '../../collaboration-message';

const console = new Logger('CloudPlugin');
const CLOUD_PLUGIN_UI_ENABLED = true;
const CLOUD_ASSET_DELETED_MESSAGE = 'Cloud asset was deleted';
const CLOUD_ASSET_LOCALIZED_EVENT = 'cloudAssetLocalizedToMemory';

export type CloudAssetRole = 'owner' | 'editor' | 'viewer';

type CloudAssetSizeWarningState = {
    visible: boolean;
    title: string;
    label: string;
    icon: string;
    tone: 'warning' | 'error';
};

type CloudSaveSizeWarningState = CloudAssetSizeWarningState & {
    canSave: boolean;
};

function deletedGlyphIdsFromCommittedEntries(
    entries: Array<{ op?: string; path?: string | Array<string | number> }>,
    fontJson: Record<string, unknown>
): string[] {
    const owned = catalogFromCoreJson(fontJson);
    const ids = new Set<string>();
    for (const entry of entries) {
        if (entry.op !== 'remove') {
            continue;
        }
        const path = pathFromCommittedEntry(entry);
        if (path[0] !== 'glyphs' || path.length !== 2 || !path[1]) {
            continue;
        }
        const name = String(path[1]);
        const fromCatalog = Object.values(owned?.glyphCatalog || {}).find(
            (item) => item.name === name && item.deleted !== true
        )?.glyphId;
        const fromBody = listGlyphRecords(fontJson).find(
            (glyph) => String(glyph.name || '') === name
        );
        const glyphId =
            fromCatalog || (fromBody ? String(fromBody.id || '') : '') || name;
        if (glyphId) {
            ids.add(glyphId);
        }
    }
    return [...ids];
}

function pathFromCommittedEntry(entry: {
    path?: string | Array<string | number>;
}): Array<string | number> {
    const rawPath = entry.path;
    if (Array.isArray(rawPath)) {
        return rawPath;
    }
    if (typeof rawPath === 'string') {
        return getPathSegments(rawPath);
    }
    return [];
}

function decodeBase64UrlJson<T>(value: string): T | null {
    try {
        const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalized.padEnd(
            Math.ceil(normalized.length / 4) * 4,
            '='
        );
        const decoded = atob(padded);
        return JSON.parse(decoded) as T;
    } catch {
        return null;
    }
}

function extractRoleFromRoomToken(token: string): CloudAssetRole | null {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) {
        return null;
    }

    const payload = decodeBase64UrlJson<{ role?: string }>(parts[1]);
    if (
        payload?.role === 'owner' ||
        payload?.role === 'editor' ||
        payload?.role === 'viewer'
    ) {
        return payload.role;
    }

    return null;
}

function normalizeCloudComponentTransform(
    transform: unknown
): Record<string, unknown> {
    if (
        !transform ||
        typeof transform !== 'object' ||
        Array.isArray(transform)
    ) {
        return {
            translation: [0, 0],
            rotation: 0,
            scale: [1, 1],
            skew: [0, 0],
            order: 'RestOfTheWorld'
        };
    }

    const record = transform as Record<string, unknown>;
    const translation = Array.isArray(record.translation)
        ? [
              Number(record.translation[0]) || 0,
              Number(record.translation[1]) || 0
          ]
        : [0, 0];
    const scale = Array.isArray(record.scale)
        ? [Number(record.scale[0]) || 1, Number(record.scale[1]) || 1]
        : [1, 1];
    const rawSkew = Array.isArray(record.skew)
        ? record.skew
        : [record.skew ?? 0, 0];

    return {
        translation,
        rotation: Number(record.rotation) || 0,
        scale,
        skew: [Number(rawSkew[0]) || 0, Number(rawSkew[1]) || 0],
        order:
            record.order === 'Glyphs' || record.order === 'RestOfTheWorld'
                ? record.order
                : 'RestOfTheWorld'
    };
}

function getCloudRequestHeaders(
    extraHeaders: Record<string, string> = {}
): Record<string, string> {
    const headers = { ...extraHeaders };
    const sessionToken = window.authManager?.getSessionToken?.();
    if (sessionToken) {
        headers.Authorization = `Bearer ${sessionToken}`;
    }
    return headers;
}

function formatCloudDebugTimestamp(timestamp: number): string {
    return new Date(timestamp).toISOString();
}

export function formatCloudByteCount(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 B';
    }
    if (bytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    }
    if (bytes >= 1024) {
        return `${(bytes / 1024).toFixed(1)} KiB`;
    }
    return `${Math.round(bytes)} B`;
}

export function describeCloudStoredPiece(
    documentId: string,
    glyphName?: string | null
): string {
    if (documentId === FONT_CORE_DOCUMENT_ID) {
        return 'The shared font (core)';
    }
    if (documentId === FONT_DEPS_DOCUMENT_ID) {
        return 'Shared dependencies';
    }
    if (documentId.startsWith('glyph:')) {
        const name =
            typeof glyphName === 'string' && glyphName.trim()
                ? glyphName.trim()
                : null;
        return name ? `The glyph “${name}”` : 'A glyph';
    }
    return 'Part of this font';
}

function worstCloudPieceSizeReport(
    gate: ShardSizeGate
): ShardSizeReport | null {
    const pickLargest = (reports: ShardSizeReport[]): ShardSizeReport | null =>
        [...reports].sort((a, b) => b.byteLength - a.byteLength)[0] ?? null;
    return pickLargest(gate.blocking) ?? pickLargest(gate.warnings);
}

function cloudPieceSizeWarningState(
    report: ShardSizeReport,
    options: {
        kind: 'status' | 'save';
        glyphName?: string | null;
    }
): CloudSaveSizeWarningState {
    const piece = describeCloudStoredPiece(
        report.documentId,
        options.glyphName
    );
    const size = formatCloudByteCount(report.byteLength);
    const cap = formatCloudByteCount(MAX_SHARD_BYTES);
    if (report.status === 'blocked') {
        const prefix =
            options.kind === 'save' ? 'Cloud save blocked' : 'Cloud status';
        return {
            visible: true,
            title: `${prefix}: ${piece} exceeds the 5\u202fMiB limit (${size} of ${cap}). Save As and edits for that piece are refused.`,
            label: 'Too large',
            icon: 'cloud_alert',
            tone: 'error',
            canSave: false
        };
    }
    const prefix =
        options.kind === 'save' ? 'Cloud save warning' : 'Cloud status';
    return {
        visible: true,
        title: `${prefix}: ${piece} is near the 5\u202fMiB limit (${size} of ${cap}). Save As or an edit that would go over is refused.`,
        label: 'Near limit',
        icon: 'warning',
        tone: 'warning',
        canSave: true
    };
}

function glyphNameForCloudDocument(
    fontJson: Record<string, unknown> | null | undefined,
    documentId: string
): string | null {
    if (!documentId.startsWith('glyph:') || !fontJson) {
        return null;
    }
    const glyphId = documentId.slice('glyph:'.length);
    const match = listGlyphRecords(fontJson).find(
        (glyph) => glyph.id === glyphId || glyph.name === glyphId
    );
    return typeof match?.name === 'string' ? match.name : null;
}

export type CloudLiveShardStats = {
    fontCoreBytes: number;
    fontDepsBytes: number;
    largestGlyphBytes: number;
    largestGlyphName: string | null;
    activeWebSocketCount: number;
};

export const EMPTY_CLOUD_LIVE_SHARD_STATS: CloudLiveShardStats = {
    fontCoreBytes: 0,
    fontDepsBytes: 0,
    largestGlyphBytes: 0,
    largestGlyphName: null,
    activeWebSocketCount: 0
};

function escapeCloudTooltipText(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function formatCloudStatusTooltipHtml(
    statusTitle: string,
    stats: CloudLiveShardStats = EMPTY_CLOUD_LIVE_SHARD_STATS
): string {
    const largestLabel = stats.largestGlyphName
        ? `${formatCloudByteCount(stats.largestGlyphBytes)} (${stats.largestGlyphName})`
        : formatCloudByteCount(stats.largestGlyphBytes);
    return `<div class="info-popup-content cloud-status-tooltip"><p class="cloud-status-tooltip-sentence">${escapeCloudTooltipText(statusTitle)}</p><ul><li>font-core: ${escapeCloudTooltipText(formatCloudByteCount(stats.fontCoreBytes))}</li><li>font-deps: ${escapeCloudTooltipText(formatCloudByteCount(stats.fontDepsBytes))}</li><li>Largest glyph shard: ${escapeCloudTooltipText(largestLabel)}</li><li>Active WebSockets: ${Math.max(0, Math.floor(stats.activeWebSocketCount) || 0)}</li></ul></div>`;
}

function canonicalizeCloudExportFontJson(
    fontJson: Record<string, unknown>
): Record<string, unknown> {
    const glyphs = Array.isArray(fontJson.glyphs) ? fontJson.glyphs : [];
    for (const glyph of glyphs) {
        const glyphRecord =
            glyph && typeof glyph === 'object' && !Array.isArray(glyph)
                ? (glyph as Record<string, unknown>)
                : null;
        const layers = Array.isArray(glyphRecord?.layers)
            ? (glyphRecord.layers as unknown[])
            : [];
        for (const layer of layers) {
            const shapes = Array.isArray(
                (layer as { shapes?: unknown[] }).shapes
            )
                ? (layer as { shapes: unknown[] }).shapes
                : [];
            for (const shape of shapes) {
                if (!shape || typeof shape !== 'object') {
                    continue;
                }

                const componentShape = shape as {
                    reference?: unknown;
                    transform?: unknown;
                };
                if (typeof componentShape.reference === 'string') {
                    componentShape.transform = normalizeCloudComponentTransform(
                        componentShape.transform
                    );
                }
            }
        }
    }

    return fontJson;
}

function validateCloudExportForFontOpen(
    fontJson: Record<string, unknown>,
    _operation: 'open' | 'save' = 'open'
) {
    const glyphs = Array.isArray(fontJson.glyphs) ? fontJson.glyphs : [];
    for (const glyph of glyphs) {
        const glyphRecord =
            glyph && typeof glyph === 'object' && !Array.isArray(glyph)
                ? (glyph as Record<string, unknown>)
                : null;
        const layers = Array.isArray(glyphRecord?.layers)
            ? (glyphRecord.layers as unknown[])
            : [];
        for (const layer of layers) {
            const shapes = Array.isArray(
                (layer as { shapes?: unknown[] }).shapes
            )
                ? (layer as { shapes: unknown[] }).shapes
                : [];
            for (const shape of shapes) {
                if (!shape || typeof shape !== 'object') {
                    continue;
                }

                const shapeRecord = shape as Record<string, unknown>;
                if (
                    'Path' in shapeRecord &&
                    shapeRecord.Path &&
                    typeof shapeRecord.Path === 'object' &&
                    !Array.isArray(shapeRecord.Path)
                ) {
                    throw new TypeError(
                        'Wrapped Path shapes are not allowed in cloud-exported font data.'
                    );
                } else if (
                    'Component' in shapeRecord &&
                    shapeRecord.Component &&
                    typeof shapeRecord.Component === 'object' &&
                    !Array.isArray(shapeRecord.Component)
                ) {
                    throw new TypeError(
                        'Wrapped Component shapes are not allowed in cloud-exported font data.'
                    );
                }

                const pathShape = shape as {
                    nodes?: unknown;
                    closed?: boolean;
                };
                if (Array.isArray(pathShape.nodes)) {
                    if (pathShape.closed === undefined) {
                        throw new TypeError(
                            'Cloud-exported path shapes must carry an explicit closed flag.'
                        );
                    }
                    continue;
                }

                const componentShape = shape as {
                    reference?: unknown;
                    transform?: unknown;
                };
                if (typeof componentShape.reference === 'string') {
                    const normalizedTransform =
                        normalizeCloudComponentTransform(
                            componentShape.transform
                        );
                    const transform = componentShape.transform;
                    if (
                        !transform ||
                        typeof transform !== 'object' ||
                        Array.isArray(transform) ||
                        Object.keys(transform).length !==
                            Object.keys(normalizedTransform).length ||
                        !Object.keys(normalizedTransform).every(
                            (key) =>
                                JSON.stringify(
                                    (transform as Record<string, unknown>)[key]
                                ) === JSON.stringify(normalizedTransform[key])
                        )
                    ) {
                        throw new TypeError(
                            'Cloud-exported component shapes must carry canonical transform objects.'
                        );
                    }
                }
            }
        }
    }
}

function glyphIdsFromCoreJson(coreJson: Record<string, unknown>): string[] {
    const owned = catalogFromCoreJson(coreJson);
    if (!owned) {
        return [];
    }
    return liveCatalogGlyphIds(owned.glyphCatalog);
}

function catalogEntriesFromCoreJson(
    coreJson: Record<string, unknown>
): Array<{ glyphId: string; name: string; componentIds?: string[] }> {
    return catalogEntriesForDepsParse(coreJson);
}

function glyphDocumentIdsFromCoreJson(
    coreJson: Record<string, unknown>
): string[] {
    return glyphIdsFromCoreJson(coreJson).map(glyphDocumentId);
}

function getCloudFontJsonFromBridge(
    bridge: Pick<PatchSyncEngine, 'getFontJsonSnapshot'>
): Record<string, unknown> | null {
    if (typeof bridge.getFontJsonSnapshot !== 'function') {
        return null;
    }
    const fontJson = bridge.getFontJsonSnapshot();
    if (!fontJson || Object.keys(fontJson).length === 0) {
        return null;
    }

    return fontJson;
}

function assertCloudBridgeStateCanBeSaved(
    bridge: Pick<PatchSyncEngine, 'getFontJsonSnapshot'>
): void {
    const fontJson = getCloudFontJsonFromBridge(bridge);
    if (!fontJson) {
        throw new Error('No active font data to save to cloud');
    }
    validateCloudExportForFontOpen(fontJson, 'save');
}

function cloneCloudFontJson(
    fontJson: Record<string, unknown>
): Record<string, unknown> {
    return JSON.parse(JSON.stringify(fontJson)) as Record<string, unknown>;
}

const CLOUD_TRANSFER_TIMEOUT_FLOOR_MS = 5 * 60_000;
const CLOUD_TRANSFER_TIMEOUT_CHUNK_BYTES = 750_000;
const CLOUD_TRANSFER_TIMEOUT_PER_CHUNK_MS = 15_000;

export type CloudSaveSeedCapture = {
    bridge: PatchSyncEngine;
    fontJson: Record<string, unknown>;
    shards: EncodedShard[];
    glyphCount: number;
    byteLength: number;
    captureEncodeMs: number;
};

function estimateCloudTransferTimeoutMs(
    approximateByteLength?: number | null
): number {
    if (
        typeof approximateByteLength !== 'number' ||
        !Number.isFinite(approximateByteLength) ||
        approximateByteLength <= 0
    ) {
        return CLOUD_TRANSFER_TIMEOUT_FLOOR_MS;
    }

    const estimatedChunkCount = Math.max(
        1,
        Math.ceil(approximateByteLength / CLOUD_TRANSFER_TIMEOUT_CHUNK_BYTES)
    );
    return Math.max(
        CLOUD_TRANSFER_TIMEOUT_FLOOR_MS,
        estimatedChunkCount * CLOUD_TRANSFER_TIMEOUT_PER_CHUNK_MS
    );
}

function cloneEncodedShards(shards: EncodedShard[]): EncodedShard[] {
    return shards.map((shard) => ({
        documentId: shard.documentId,
        bytes: shard.bytes.slice()
    }));
}

function encodedShardByteLength(shards: EncodedShard[]): number {
    return shards.reduce((sum, shard) => sum + shard.bytes.byteLength, 0);
}

async function flushPendingCloudSaveMutations(): Promise<void> {
    await (
        window as Window & {
            glyphCanvas?: {
                outlineEditor?: {
                    flushPendingKeyboardPreviewCommit?: () => Promise<void>;
                };
            };
        }
    ).glyphCanvas?.outlineEditor?.flushPendingKeyboardPreviewCommit?.();
}

async function waitForCloudSaveBridge(
    timeoutMs = 15000
): Promise<PatchSyncEngine> {
    return await new Promise((resolve, reject) => {
        const startedAt = Date.now();

        const poll = () => {
            const bridge = window.patchSyncEngine;
            if (bridge) {
                resolve(bridge);
                return;
            }

            if (Date.now() - startedAt >= timeoutMs) {
                reject(new Error('Cloud bridge not ready for save'));
                return;
            }

            window.requestAnimationFrame(poll);
        };

        poll();
    });
}

export async function captureCloudSaveSeedState(
    preferredBridge?: PatchSyncEngine | null
): Promise<CloudSaveSeedCapture> {
    const captureStartedAt =
        typeof performance !== 'undefined' && performance.now
            ? performance.now()
            : Date.now();
    await flushPendingCloudSaveMutations();
    const liveBridge = window.patchSyncEngine;
    const bridge =
        preferredBridge && liveBridge === preferredBridge
            ? preferredBridge
            : liveBridge || (await waitForCloudSaveBridge());
    assertCloudBridgeStateCanBeSaved(bridge);
    const snapshot = getCloudFontJsonFromBridge(bridge);
    if (!snapshot) {
        throw new Error('No active font data to save to cloud');
    }
    const fontJson = canonicalizeCloudExportFontJson(
        cloneCloudFontJson(snapshot)
    );
    validateCloudExportForFontOpen(fontJson, 'save');
    const shards = cloneEncodedShards(bridge.encodeDocumentSet?.() ?? []);
    if (!shards.length) {
        throw new Error('No live document set to seed to cloud');
    }
    const captureEncodeMs =
        (typeof performance !== 'undefined' && performance.now
            ? performance.now()
            : Date.now()) - captureStartedAt;
    return {
        bridge,
        fontJson,
        shards,
        glyphCount: listGlyphRecords(fontJson).length,
        byteLength: encodedShardByteLength(shards),
        captureEncodeMs
    };
}

export async function recaptureCloudSaveSeedIfBridgeChanged(
    capture: CloudSaveSeedCapture
): Promise<CloudSaveSeedCapture> {
    const liveBridge = window.patchSyncEngine;
    if (liveBridge && liveBridge === capture.bridge) {
        return capture;
    }
    return await captureCloudSaveSeedState(liveBridge);
}

export async function waitForCloudSaveReady(): Promise<PatchSyncEngine> {
    await flushPendingCloudSaveMutations();
    const bridge = await waitForCloudSaveBridge();
    assertCloudBridgeStateCanBeSaved(bridge);
    return bridge;
}

/**
 * Wait for the initial synced document to contain font data.
 * Some cloud rooms connect before their persisted snapshot has been applied.
 */
async function waitForCloudFontJson(
    bridge: Pick<PatchSyncEngine, 'getFontJsonSnapshot' | 'yDoc'>,
    timeoutMs = 8000
): Promise<Record<string, unknown> | null> {
    const immediateFontJson = getCloudFontJsonFromBridge(bridge);
    if (immediateFontJson) {
        return immediateFontJson;
    }

    return await new Promise((resolve) => {
        let settled = false;

        const finish = (fontJson: Record<string, unknown> | null) => {
            if (settled) {
                return;
            }
            settled = true;
            window.clearTimeout(timeoutId);
            bridge.yDoc.off('update', onUpdate);
            resolve(fontJson);
        };

        const onUpdate = () => {
            const nextFontJson = getCloudFontJsonFromBridge(bridge);
            if (nextFontJson) {
                finish(nextFontJson);
            }
        };

        const timeoutId = window.setTimeout(() => {
            finish(getCloudFontJsonFromBridge(bridge));
        }, timeoutMs);

        bridge.yDoc.on('update', onUpdate);
    });
}

export interface CloudAsset {
    id: string;
    name: string;
    role: CloudAssetRole;
    ownerUserId: string;
    createdAt: number;
    updatedAt: number;
    connectedPeers?: number;
    needsMigration?: boolean;
    manifestRevision?: number;
    ydocSchemaVersion?: number;
    migrationStatus?: string;
}

export interface CloudEligibility {
    cloudHostingEnabled: boolean;
    maxFontsOwned: number | null;
    maxGlyphsPerFont?: number | null;
    snapshotRetentionDays: number | null;
    fontsOwnedCount: number;
    maxCloudAssetBytes?: number;
    warningCloudAssetBytes?: number;
    maxShardBytes?: number;
    warningShardBytes?: number;
    maxPacketBytes?: number;
    capabilities?: Record<string, number>;
}

export interface CloudAssetLimits {
    ownerUserId: string;
    maxFontsOwned: number | null;
    maxGlyphsPerFont: number | null;
    glyphCount: number;
    fontsOwnedCount: number;
    remainingGlyphs: number | null;
    maxShardBytes: number;
    warningShardBytes: number;
    maxPacketBytes?: number;
}

export interface CloudAssetMember {
    userId: string;
    email: string;
    role: CloudAssetRole;
    invitedByUserId: string | null;
    invitedByEmail: string | null;
    createdAt: number;
    updatedAt: number;
}

export interface CloudAssetInvitation {
    id: string;
    email: string;
    role: 'editor' | 'viewer';
    targetUserId: string | null;
    targetUserEmail: string | null;
    createdAt: number;
    expiresAt: number | null;
    lastSentAt: number | null;
    resendCount: number;
}

export interface CloudOwnershipTransfer {
    id: string;
    email: string;
    targetUserId: string | null;
    targetUserEmail: string | null;
    previousOwnerRole: 'editor' | 'viewer' | 'remove';
    sourceOwnerUserId: string;
    sourceOwnerEmail: string | null;
    createdAt: number;
    expiresAt: number | null;
}

export interface CloudShareState {
    asset: CloudAsset & {
        ownerEmail?: string | null;
        accessEpoch?: number;
    };
    permissions: {
        canManage: boolean;
    };
    members: CloudAssetMember[];
    invitations: CloudAssetInvitation[];
    ownershipTransfer: CloudOwnershipTransfer | null;
}

export class CloudPlugin extends FilesystemPlugin {
    private _cloudAdapter: CloudAdapter | null = null;
    private _liveSession: CloudLiveSession | null = null;
    private _attachingSession: CloudLiveSession | null = null;
    private _editingSubsetListener: (() => void) | null = null;
    private _isSyncingCatalog = false;
    private _pendingCatalogProjection: {
        catalogDirty: boolean;
        deletedGlyphIds: string[];
        catalogGlyphs: string[];
        depsGlyphs: Set<string>;
    } | null = null;
    private _activeAssetId: string | null = null;
    private _relayedAssetId: string | null = null;
    private _relayedConnectionStatus: CloudConnectionStatus = 'disconnected';
    private _relayedConnectionDetail: string | undefined;
    private _relayedPendingSyncCount = 0;
    private _relayedTransferActivity: CloudTransferActivity = 'idle';
    private _sparsePreviewOnly = false;
    private _eligibility: CloudEligibility | null = null;
    private _assetLimits: CloudAssetLimits | null = null;
    private _documentSet: CloudDocumentSet | null = null;
    private _catalogListener: CommittedChangeListener | null = null;
    private _glyphCatchUpListener: CommittedChangeListener | null = null;
    private _coreHydratedListener: (() => void) | null = null;
    private _glyphCatchUpInFlight = new Set<string>();
    private _pendingOpenAsset: {
        assetId: string;
        promise: Promise<void>;
    } | null = null;
    private _pendingSparseHydration = false;
    private _cloudIoInFlight: Promise<unknown> | null = null;
    private _hydrationGeneration = 0;
    private _overviewHydrateInFlight: Promise<string[]> | null = null;
    private _overviewHydrateGeneration: number | null = null;
    private _overviewHydrateQueued: Array<{
        text?: string;
        glyphNames?: string[];
        purpose?: 'ui' | 'compile';
    }> = [];
    private _cloudSessionBootstrapEmail = 'local-dev@counterpunch.test';
    private _connectionStatusByAssetId = new Map<
        string,
        CloudConnectionStatus
    >();
    private _connectionDetailByAssetId = new Map<string, string>();
    private _pendingSyncCountByAssetId = new Map<string, number>();
    private _transferActivityByAssetId = new Map<
        string,
        CloudTransferActivity
    >();
    private _connectionTraceByAssetId = new Map<
        string,
        Array<{
            timestamp: number;
            status: CloudConnectionStatus;
            detail?: string;
        }>
    >();
    private _connectedAssetIds = new Set<string>();
    private _lastAlertedConnectionErrorByAssetId = new Map<string, string>();
    private _availabilityErrorMessage: string | null = null;
    private _assetEstimatedBytesByAssetId = new Map<string, number>();
    private _activeAssetSizeBridge: PatchSyncEngine | null = null;
    private _activeAssetSizeListener: CommittedChangeListener | null = null;
    private _activeAssetSizeRecomputeTimer: number | null = null;

    private _getDeletedAssetRecoveryPath(): string {
        const currentFont = window.fontManager?.currentFont;
        const rawName = String(currentFont?.name || '').trim();
        const sanitizedBaseName = (rawName || 'Recovered Cloud Font')
            .replace(/[\\/:*?"<>|]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const fileName = sanitizedBaseName.endsWith('.babelfont')
            ? sanitizedBaseName
            : `${sanitizedBaseName}.babelfont`;
        return `/user/${fileName}`;
    }

    handleDeletedAsset(
        assetId: string,
        detail?: string,
        options?: {
            suppressAlert?: boolean;
        }
    ): void {
        const currentFont = window.fontManager?.currentFont;
        const memoryPlugin = pluginRegistry.get('memory');
        const currentAssetId = this.getCurrentAssetIdForSharing();
        if (
            !currentFont ||
            currentFont.sourcePlugin?.getId?.() !== 'cloud' ||
            !memoryPlugin ||
            currentAssetId !== assetId
        ) {
            return;
        }

        const recoveryPath = this._getDeletedAssetRecoveryPath();
        currentFont.sourcePlugin = memoryPlugin;
        currentFont.path = recoveryPath;
        currentFont.fileHandle = undefined;
        currentFont.directoryHandle = undefined;
        currentFont.hasUnsavedChanges = true;

        this._disconnectCurrent();
        this._connectionStatusByAssetId.delete(assetId);

        void window.fontManager?.updateFontDisplay?.();
        void window.fontManager?.updateDirtyIndicator?.();
        window.saveButton?.updateButtonState?.();
        window.dispatchEvent(
            new CustomEvent(CLOUD_ASSET_LOCALIZED_EVENT, {
                detail: {
                    assetId,
                    path: recoveryPath,
                    message: detail ?? CLOUD_ASSET_DELETED_MESSAGE
                }
            })
        );

        const alertMessage =
            detail === CLOUD_ASSET_DELETED_MESSAGE
                ? 'Cloud asset was deleted. The open font was kept locally in Memory with unsaved changes.'
                : `Cloud connection error: ${detail ?? CLOUD_ASSET_DELETED_MESSAGE}`;
        if (
            !options?.suppressAlert &&
            this._lastAlertedConnectionErrorByAssetId.get(assetId) !==
                alertMessage
        ) {
            this._lastAlertedConnectionErrorByAssetId.set(
                assetId,
                alertMessage
            );
            alert(alertMessage);
        }
    }

    constructor(
        options: Omit<CloudAdapterOptions, 'assetId'> & {
            assetId?: string;
        } = {}
    ) {
        // Pass a stub adapter — real connections are created per-asset.
        const stubAdapter = new CloudAdapter({
            ...options,
            assetId: options.assetId ?? '__none__'
        });
        super(stubAdapter);
        setCollabIntegritySnapshotProvider((glyphName) =>
            this.captureCollabIntegritySnapshot(glyphName)
        );
    }

    captureCollabIntegritySnapshot(
        glyphName?: string
    ): Record<string, unknown> {
        const bridge =
            this._activeAssetSizeBridge ??
            (
                window as Window & {
                    patchSyncEngine?: PatchSyncEngine;
                }
            ).patchSyncEngine;
        const glyphSnapshot = glyphName
            ? bridge?.debugCollabGlyphSnapshot?.(glyphName)
            : null;
        return {
            connectionStatus: this.connectionStatus,
            activeAssetId: this._activeAssetId,
            pendingSyncCount: this._activeAssetId
                ? this.getAssetPendingSyncCount(this._activeAssetId)
                : null,
            liveAccess: this.getLiveAccessSnapshot(),
            session: this._liveSession?.captureIntegritySnapshot() ?? null,
            glyph: glyphSnapshot ?? null,
            online: typeof navigator !== 'undefined' ? navigator.onLine : null
        };
    }

    private _getCloudAdapter(): CloudAdapter {
        return this.getAdapter() as CloudAdapter;
    }

    private _cacheAssetRole(
        assetId: string,
        role: CloudAssetRole | null | undefined
    ): void {
        this._getCloudAdapter().cacheAssetRole(assetId, role);
        window.dispatchEvent(
            new CustomEvent('cloudAssetRoleChanged', {
                detail: { assetId, role: role ?? null }
            })
        );
    }

    private get _websiteBaseUrl(): string {
        return window.authManager?.websiteURL || resolveWebsiteURL();
    }

    getAssetConnectionStatus(assetId: string): CloudConnectionStatus {
        return this._connectionStatusByAssetId.get(assetId) ?? 'disconnected';
    }

    getAssetConnectionDetail(assetId: string): string | undefined {
        return this._connectionDetailByAssetId.get(assetId);
    }

    getAssetSizeWarningState(
        assetId: string
    ): CloudAssetSizeWarningState | null {
        const piece = this._getAssetPieceSizeWarningState(assetId);
        const policy = this._getCloudAssetSizePolicy();
        const rawByteLength = this._assetEstimatedBytesByAssetId.get(assetId);
        const total =
            policy &&
            typeof rawByteLength === 'number' &&
            Number.isFinite(rawByteLength)
                ? this._getAssetSizeWarningStateForByteLength(
                      rawByteLength,
                      policy
                  )
                : null;
        if (piece?.tone === 'error') {
            return piece;
        }
        if (total?.tone === 'error') {
            return total;
        }
        return piece ?? total;
    }

    private _getAssetPieceSizeWarningState(
        assetId: string
    ): CloudAssetSizeWarningState | null {
        const stats = this.getAssetLiveShardStats(assetId);
        const shards: Array<{ documentId: string; byteLength: number }> = [
            {
                documentId: FONT_CORE_DOCUMENT_ID,
                byteLength: stats.fontCoreBytes
            },
            {
                documentId: FONT_DEPS_DOCUMENT_ID,
                byteLength: stats.fontDepsBytes
            }
        ];
        if (stats.largestGlyphBytes > 0) {
            shards.push({
                documentId: 'glyph:live',
                byteLength: stats.largestGlyphBytes
            });
        }
        if (!shards.some((shard) => shard.byteLength > 0)) {
            return null;
        }
        const worst = worstCloudPieceSizeReport(evaluateShardSizes(shards));
        if (!worst) {
            return null;
        }
        const { canSave: _canSave, ...state } = cloudPieceSizeWarningState(
            worst,
            {
                kind: 'status',
                glyphName: worst.documentId.startsWith('glyph:')
                    ? stats.largestGlyphName
                    : null
            }
        );
        return state;
    }

    getAssetLiveShardStats(assetId: string): CloudLiveShardStats {
        const matchesActiveAsset =
            !!assetId &&
            (this._activeAssetId === assetId ||
                this._relayedAssetId === assetId);
        const bridge = matchesActiveAsset ? this._activeAssetSizeBridge : null;
        const sizeBridge =
            bridge ??
            (typeof window !== 'undefined'
                ? (
                      window as Window & {
                          patchSyncEngine?: PatchSyncEngine;
                      }
                  ).patchSyncEngine
                : null);
        const sizes = sizeBridge?.getLiveShardSizeSnapshot?.() ?? {
            fontCoreBytes: 0,
            fontDepsBytes: 0,
            largestGlyphBytes: 0,
            largestGlyphName: null
        };
        const activeWebSocketCount =
            this._activeAssetId === assetId
                ? (this._liveSession?.activeWebSocketCount() ?? 0)
                : 0;
        return {
            fontCoreBytes: sizes.fontCoreBytes,
            fontDepsBytes: sizes.fontDepsBytes,
            largestGlyphBytes: sizes.largestGlyphBytes,
            largestGlyphName: sizes.largestGlyphName,
            activeWebSocketCount
        };
    }

    getCloudStatusTooltipHtml(assetId: string, statusTitle: string): string {
        return formatCloudStatusTooltipHtml(
            statusTitle,
            this.getAssetLiveShardStats(assetId)
        );
    }

    async waitForSaveReady(): Promise<PatchSyncEngine> {
        return await waitForCloudSaveReady();
    }

    async getCurrentSaveAsWarningState(): Promise<CloudSaveSizeWarningState | null> {
        const seed = await captureCloudSaveSeedState();
        const estimated = seed.bridge.getEstimatedLiveEncodedBytes?.() ?? 0;
        const byteLength = estimated > 0 ? estimated : seed.byteLength;
        const policy = await this._ensureCloudSizePolicy();
        const pieceGate = evaluateShardSizes(
            seed.shards.map((shard) => ({
                documentId: shard.documentId,
                byteLength: shard.bytes.byteLength
            }))
        );
        const worstPiece = worstCloudPieceSizeReport(pieceGate);
        const piece = worstPiece
            ? cloudPieceSizeWarningState(worstPiece, {
                  kind: 'save',
                  glyphName: glyphNameForCloudDocument(
                      seed.fontJson,
                      worstPiece.documentId
                  )
              })
            : null;
        const total =
            policy && byteLength > policy.maxCloudAssetBytes
                ? {
                      visible: true,
                      title: `Cloud save blocked: Font exceeds the current cloud size limit (${formatCloudByteCount(byteLength)} of ${formatCloudByteCount(policy.maxCloudAssetBytes)}). A larger compaction tier is required before saving to cloud.`,
                      label: 'Too large',
                      icon: 'sync_problem',
                      tone: 'error' as const,
                      canSave: false
                  }
                : policy && byteLength >= policy.warningCloudAssetBytes
                  ? {
                        visible: true,
                        title: `Cloud save warning: Font is near the current cloud size limit (${formatCloudByteCount(byteLength)} of ${formatCloudByteCount(policy.maxCloudAssetBytes)}). Saving may still work now, but cloud editing can stop working if the font grows further.`,
                        label: 'Near limit',
                        icon: 'warning',
                        tone: 'warning' as const,
                        canSave: true
                    }
                  : null;
        if (piece?.tone === 'error') {
            return piece;
        }
        if (total?.tone === 'error') {
            return total;
        }
        return piece ?? total;
    }

    private _getAssetSizeWarningStateForByteLength(
        byteLength: number,
        policy: {
            maxCloudAssetBytes: number;
            warningCloudAssetBytes: number;
        }
    ): CloudAssetSizeWarningState | null {
        if (byteLength > policy.maxCloudAssetBytes) {
            return {
                visible: true,
                title: `Cloud status: Font exceeds the current cloud size limit (${formatCloudByteCount(byteLength)} of ${formatCloudByteCount(policy.maxCloudAssetBytes)}). Cloud editing will stop working until a larger compaction tier exists.`,
                label: 'Too large',
                icon: 'cloud_alert',
                tone: 'error'
            };
        }

        if (byteLength >= policy.warningCloudAssetBytes) {
            return {
                visible: true,
                title: `Cloud status: Font is near the current cloud size limit (${formatCloudByteCount(byteLength)} of ${formatCloudByteCount(policy.maxCloudAssetBytes)}).`,
                label: 'Near limit',
                icon: 'warning',
                tone: 'warning'
            };
        }

        return null;
    }

    getAssetPendingSyncCount(assetId: string): number {
        if (
            window.windowRole?.isLinkedWindow() &&
            assetId === this._relayedAssetId
        ) {
            return this._relayedPendingSyncCount;
        }

        if (this._activeAssetId === assetId && this._liveSession) {
            return this._liveSession.pendingSyncCount;
        }
        if (this._activeAssetId === assetId && this._cloudAdapter) {
            return this._cloudAdapter.pendingSyncCount;
        }

        return this._pendingSyncCountByAssetId.get(assetId) ?? 0;
    }

    getAssetTransferActivity(assetId: string): CloudTransferActivity {
        if (
            window.windowRole?.isLinkedWindow() &&
            assetId === this._relayedAssetId
        ) {
            return this._relayedTransferActivity;
        }

        if (this._activeAssetId === assetId && this._liveSession) {
            return this._liveSession.transferActivity;
        }
        if (this._activeAssetId === assetId && this._cloudAdapter) {
            return this._cloudAdapter.transferActivity;
        }

        return this._transferActivityByAssetId.get(assetId) ?? 'idle';
    }

    getConnectionTrace(assetId: string): Array<{
        timestamp: number;
        status: CloudConnectionStatus;
        detail?: string;
    }> {
        return [...(this._connectionTraceByAssetId.get(assetId) ?? [])];
    }

    getCloudDebugSnapshot(): string {
        return this._buildCloudDebugSnapshot();
    }

    async copyCloudDebugSnapshot(): Promise<void> {
        try {
            await navigator.clipboard.writeText(this.getCloudDebugSnapshot());
        } catch (error) {
            console.error('Failed to copy cloud debug snapshot:', error);
            alert(
                'Clipboard access failed while copying cloud debug snapshot.'
            );
            throw error;
        }
    }

    /**
     * One-time repair: rewrite the live font-deps shard with the same
     * `buildFontDepsIndex` + `writeFontDepsYMap` path as cloud seed.
     * Requires every catalog glyph body to be loaded (not a sparse open).
     */
    rebuildFontDepsFromLoadedGlyphs(): boolean {
        const currentFont = window.fontManager?.currentFont;
        if (!currentFont?.isCloudBacked?.()) {
            alert('Open a cloud font first.');
            return false;
        }
        if (!this.canMutateCurrentAsset()) {
            alert('You cannot update font-deps on a read-only cloud font.');
            return false;
        }
        const fontJson = this._currentFontJson();
        const bridge = window.patchSyncEngine;
        if (!fontJson || !bridge?.syncCompleteFontDepsFromLoadedGlyphs) {
            alert('The current font is not ready.');
            return false;
        }
        const wrote = bridge.syncCompleteFontDepsFromLoadedGlyphs(fontJson);
        if (!wrote) {
            alert(
                'Cannot rebuild font-deps until every catalog glyph is loaded. Open the font without sparse hydration.'
            );
            return false;
        }
        const sourceCount = Object.keys(
            readFontDepsIndex(bridge.depsDoc.getMap('deps')).edges
        ).length;
        alert(`Rebuilt font-deps from loaded glyphs (${sourceCount} sources).`);
        return true;
    }

    getCachedAssetRole(assetId: string): CloudAssetRole | null {
        return this._getCloudAdapter().getCachedAssetRole(assetId);
    }

    private _isCurrentFontOpenForAsset(assetId: string): boolean {
        const currentPath = String(window.fontManager?.currentFont?.path || '');
        return currentPath === assetId || currentPath === `cloud://${assetId}`;
    }

    private _handleBackgroundBridgeBootstrapFailure(
        assetId: string,
        error: unknown
    ): void {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
            '[CloudPlugin]',
            'Background cloud bridge bootstrap failed:',
            error
        );

        if (
            this._isCurrentFontOpenForAsset(assetId) &&
            (message === 'cloud sync timed out' ||
                message === 'cloud bridge bootstrap timed out')
        ) {
            this._updateConnectionStatus(assetId, 'connecting', message);
            void this.connectToRoom(assetId);
            return;
        }

        this._updateConnectionStatus(assetId, 'error', message);
    }

    getCurrentAssetRole(): CloudAssetRole | null {
        const assetId = this.getCurrentAssetIdForSharing();
        if (!assetId) {
            return null;
        }
        return this.getCachedAssetRole(assetId);
    }

    canMutateCurrentAsset(): boolean {
        const currentFont = window.fontManager?.currentFont;
        if (!currentFont?.isCloudBacked?.()) {
            return true;
        }
        const sessionSnapshot = this._liveSession?.getAccessSnapshot();
        if (
            sessionSnapshot?.accessRevoked === true ||
            sessionSnapshot?.reconnectForbidden === true
        ) {
            return false;
        }
        const connectionDetail = this._activeAssetId
            ? this.getAssetConnectionDetail(this._activeAssetId)
            : undefined;
        if (connectionDetail === 'tail_full') {
            return false;
        }
        const role = this.getCurrentAssetRole();
        if (role === 'viewer') {
            return false;
        }
        const walHealth = this._liveSession?.walHealth;
        if (this._liveSession) {
            if (walHealth !== 'ready') {
                return false;
            }
        } else if (this.connectionStatus !== 'connected') {
            return false;
        }
        if (
            this._eligibility &&
            missingRequiredCloudCapabilities(this._eligibility.capabilities)
                .length
        ) {
            return false;
        }
        const glyphName = window.glyphCanvas?.getCurrentGlyphName?.();
        // Text mode reports the sentinel string "undefined" from
        // getCurrentGlyphName. That must not lock the canvas: it blocked
        // double-click-to-edit while Cmd+Enter still worked. Only refuse
        // writes once a real sparse-hidden glyph is being edited.
        const editingSparseHiddenGlyph =
            !!window.glyphCanvas?.outlineEditor?.active &&
            !!glyphName &&
            glyphName !== 'undefined' &&
            window.patchSyncEngine?.hasSparseWorkingSet?.() &&
            window.patchSyncEngine.isSparseWorkingGlyphName?.(glyphName) ===
                false;
        if (editingSparseHiddenGlyph) {
            return false;
        }
        return true;
    }

    async persistPreparedCloudTransaction(record: {
        transactionId: string;
        documentId?: string;
        operations: unknown[];
        documentUpdates?: unknown;
        collaborationMessage: CollaborationMessageEnvelope;
        revisionObligations?: unknown;
        generationId?: string | null;
        state?: string;
    }): Promise<boolean> {
        if (!this._liveSession) {
            return true;
        }
        return this._liveSession.persistPreparedTransaction(
            record as Parameters<
                CloudLiveSession['persistPreparedTransaction']
            >[0]
        );
    }

    async persistOutgoingCloudUpdate(
        update: Uint8Array,
        collaborationMessage: CollaborationMessageEnvelope | null | undefined,
        documentId: string
    ): Promise<boolean> {
        if (!this._liveSession) {
            return true;
        }
        return this._liveSession.persistOutgoingUpdate(
            update,
            collaborationMessage,
            documentId
        );
    }

    async persistCloudMutationIntent(
        documentIds: string[],
        intentBytes?: Uint8Array | null
    ): Promise<boolean> {
        if (!this._liveSession) {
            return true;
        }
        return this._liveSession.persistMutationIntents(
            documentIds,
            intentBytes
        );
    }

    async replayPendingOfflinePublishes(): Promise<void> {
        await this._liveSession?.replayPendingOfflinePublishes();
    }

    async waitForCloudGlyphDurability(): Promise<{
        durable: boolean;
        reason?: string;
        pendingCount?: number;
    }> {
        if (!this._liveSession) {
            return { durable: true, pendingCount: 0 };
        }
        return this._liveSession.waitForGlyphAndDepsDurability();
    }

    getLiveAccessSnapshot(): {
        role: CloudAssetRole | null;
        canMutate: boolean;
        connectionStatus: string;
        connectionDetail?: string;
        accessRevoked: boolean;
        reconnectForbidden: boolean;
        lastClose: { code: number; reason: string } | null;
        lastServerError: { message: string; code?: string } | null;
        openSocketCount: number;
        roomToken?: string | null;
        roomUrl: string | null;
        adapters: Array<{
            documentId: string;
            status: string;
            wsReadyState: number | null;
        }>;
    } {
        const sessionSnapshot = this._liveSession?.getAccessSnapshot();
        const role = this.getCurrentAssetRole();
        const accessRevoked = sessionSnapshot?.accessRevoked === true;
        const reconnectForbidden = sessionSnapshot?.reconnectForbidden === true;
        return {
            role,
            canMutate: this.canMutateCurrentAsset(),
            connectionStatus: this.connectionStatus,
            connectionDetail: this._activeAssetId
                ? this.getAssetConnectionDetail(this._activeAssetId)
                : undefined,
            accessRevoked,
            reconnectForbidden,
            lastClose: sessionSnapshot?.lastClose ?? null,
            lastServerError: sessionSnapshot?.lastServerError ?? null,
            openSocketCount: sessionSnapshot?.openSocketCount ?? 0,
            roomToken: sessionSnapshot?.roomToken ?? null,
            roomUrl: sessionSnapshot?.roomUrl ?? null,
            adapters: (sessionSnapshot?.adapters || []).map((adapter) => ({
                documentId: adapter.documentId,
                status: adapter.status,
                wsReadyState: adapter.wsReadyState
            }))
        };
    }

    probeUnauthorizedLiveWrite(): boolean {
        return this._liveSession?.probeUnauthorizedLiveWrite() === true;
    }

    hasConnectionProblem(assetId: string): boolean {
        const status = this.getAssetConnectionStatus(assetId);
        if (status === 'error') {
            return true;
        }

        if (
            status === 'connecting' ||
            status === 'authenticating' ||
            status === 'syncing' ||
            status === 'disconnected'
        ) {
            return (
                this._connectedAssetIds.has(assetId) ||
                this._activeAssetId === assetId ||
                this._isCurrentFontOpenForAsset(assetId)
            );
        }

        return false;
    }

    private _updateConnectionStatus(
        assetId: string,
        status: CloudConnectionStatus,
        detail?: string
    ): void {
        this._connectionStatusByAssetId.set(assetId, status);
        if (detail) {
            this._connectionDetailByAssetId.set(assetId, detail);
        } else {
            this._connectionDetailByAssetId.delete(assetId);
        }
        this._connectionTraceByAssetId.set(
            assetId,
            [
                ...(this._connectionTraceByAssetId.get(assetId) ?? []),
                {
                    timestamp: Date.now(),
                    status,
                    ...(detail ? { detail } : {})
                }
            ].slice(-50)
        );

        if (status === 'connected') {
            this._connectedAssetIds.add(assetId);
        }
        if (status !== 'error') {
            this._lastAlertedConnectionErrorByAssetId.delete(assetId);
        } else if (detail === CLOUD_ASSET_DELETED_MESSAGE) {
            this.handleDeletedAsset(assetId, detail);
        }

        if (window.windowRole?.isMainWindow()) {
            window.windowSync?.broadcastCloudConnectionStatus?.({
                assetId,
                status,
                pendingSyncCount: this.getAssetPendingSyncCount(assetId),
                transferActivity: this.getAssetTransferActivity(assetId),
                ...(detail ? { detail } : {})
            });
            if (status === 'connected') {
                window.windowSync?.notifyCloudBootstrapReady?.();
            }
        }

        window.dispatchEvent(
            new CustomEvent('cloudConnectionStatusChanged', {
                detail: {
                    assetId,
                    status,
                    detail,
                    pendingSyncCount: this.getAssetPendingSyncCount(assetId),
                    transferActivity: this.getAssetTransferActivity(assetId)
                }
            })
        );
    }

    private _updatePendingSyncCount(assetId: string, count: number): void {
        this._pendingSyncCountByAssetId.set(assetId, Math.max(0, count));

        const status = this.getAssetConnectionStatus(assetId);
        const detail = this.getAssetConnectionDetail(assetId);

        if (window.windowRole?.isMainWindow()) {
            window.windowSync?.broadcastCloudConnectionStatus?.({
                assetId,
                status,
                pendingSyncCount: this.getAssetPendingSyncCount(assetId),
                transferActivity: this.getAssetTransferActivity(assetId),
                ...(detail ? { detail } : {})
            });
        }

        window.dispatchEvent(
            new CustomEvent('cloudConnectionStatusChanged', {
                detail: {
                    assetId,
                    status,
                    detail,
                    pendingSyncCount: this.getAssetPendingSyncCount(assetId),
                    transferActivity: this.getAssetTransferActivity(assetId)
                }
            })
        );
    }

    private _updateTransferActivity(
        assetId: string,
        activity: CloudTransferActivity
    ): void {
        this._transferActivityByAssetId.set(assetId, activity);
        this._updatePendingSyncCount(
            assetId,
            this.getAssetPendingSyncCount(assetId)
        );
    }

    private _getCloudAssetSizePolicy(): {
        maxCloudAssetBytes: number;
        warningCloudAssetBytes: number;
    } | null {
        const maxCloudAssetBytes = Number(
            this._eligibility?.maxCloudAssetBytes ?? 0
        );
        const warningCloudAssetBytes = Number(
            this._eligibility?.warningCloudAssetBytes ?? 0
        );
        if (
            !Number.isFinite(maxCloudAssetBytes) ||
            maxCloudAssetBytes <= 0 ||
            !Number.isFinite(warningCloudAssetBytes) ||
            warningCloudAssetBytes <= 0
        ) {
            return null;
        }
        return {
            maxCloudAssetBytes,
            warningCloudAssetBytes: Math.min(
                maxCloudAssetBytes,
                warningCloudAssetBytes
            )
        };
    }

    private _setAssetEstimatedBytes(assetId: string, byteLength: number): void {
        if (!Number.isFinite(byteLength) || byteLength <= 0) {
            this._assetEstimatedBytesByAssetId.delete(assetId);
        } else {
            this._assetEstimatedBytesByAssetId.set(assetId, byteLength);
        }

        if (this._activeAssetId === assetId) {
            void window.fontManager?.updateFontDisplay?.();
        }
    }

    private _stopTrackingActiveAssetSize(): void {
        if (this._activeAssetSizeRecomputeTimer !== null) {
            window.clearTimeout(this._activeAssetSizeRecomputeTimer);
            this._activeAssetSizeRecomputeTimer = null;
        }
        if (this._activeAssetSizeBridge && this._activeAssetSizeListener) {
            const bridge = this._activeAssetSizeBridge as PatchSyncEngine & {
                offCommittedChange?: (cb: CommittedChangeListener) => void;
            };
            bridge.offCommittedChange?.(this._activeAssetSizeListener);
            if (this._catalogListener) {
                bridge.offCommittedChange?.(this._catalogListener);
            }
            if (this._glyphCatchUpListener) {
                bridge.offCommittedChange?.(this._glyphCatchUpListener);
            }
            if (this._coreHydratedListener) {
                this._activeAssetSizeBridge.offCoreHydrated?.(
                    this._coreHydratedListener
                );
            }
        }
        this._activeAssetSizeBridge = null;
        this._activeAssetSizeListener = null;
        this._catalogListener = null;
        this._glyphCatchUpListener = null;
        this._coreHydratedListener = null;
    }

    private _recomputeActiveAssetSize(): void {
        this._activeAssetSizeRecomputeTimer = null;
        if (!this._activeAssetId || !this._activeAssetSizeBridge) {
            return;
        }

        const bridge = this._activeAssetSizeBridge as PatchSyncEngine & {
            encodeBridgeState?: () => Uint8Array;
            getEstimatedLiveEncodedBytes?: () => number;
        };
        const estimated = bridge.getEstimatedLiveEncodedBytes?.() ?? 0;
        const policy = this._getCloudAssetSizePolicy();
        if (
            shouldExactEncodeAssetSize(
                estimated,
                policy?.maxCloudAssetBytes,
                policy?.warningCloudAssetBytes
            )
        ) {
            const encodedState = bridge.encodeBridgeState?.();
            if (encodedState) {
                this._setAssetEstimatedBytes(
                    this._activeAssetId,
                    encodedState.length
                );
                return;
            }
        }
        if (estimated > 0) {
            this._setAssetEstimatedBytes(this._activeAssetId, estimated);
        }
    }

    private _scheduleActiveAssetSizeRecompute(): void {
        if (this._activeAssetSizeRecomputeTimer !== null) {
            return;
        }

        this._activeAssetSizeRecomputeTimer = window.setTimeout(() => {
            this._recomputeActiveAssetSize();
        }, 100);
    }

    private _startTrackingActiveAssetSize(
        assetId: string,
        bridge: PatchSyncEngine
    ): void {
        this._stopTrackingActiveAssetSize();
        this._activeAssetId = assetId;
        this._activeAssetSizeBridge = bridge;
        this._activeAssetSizeListener = () => {
            this._scheduleActiveAssetSizeRecompute();
        };
        (
            bridge as PatchSyncEngine & {
                onCommittedChange?: (cb: CommittedChangeListener) => void;
            }
        ).onCommittedChange?.(this._activeAssetSizeListener);
        this._catalogListener = this._syncCatalogFromCommittedChange;
        (
            bridge as PatchSyncEngine & {
                onCommittedChange?: (cb: CommittedChangeListener) => void;
            }
        ).onCommittedChange?.(this._catalogListener);
        this._glyphCatchUpListener = this._syncGlyphCatchUpFromCommittedChange;
        (
            bridge as PatchSyncEngine & {
                onCommittedChange?: (cb: CommittedChangeListener) => void;
            }
        ).onCommittedChange?.(this._glyphCatchUpListener);
        this._coreHydratedListener = () => {
            if (bridge.hasSparseWorkingSet?.()) {
                return;
            }
            this._catchUpFromCoreRevisionMap();
        };
        bridge.onCoreHydrated?.(this._coreHydratedListener);
        this._recomputeActiveAssetSize();
    }

    private async _ensureCloudSizePolicy(): Promise<{
        maxCloudAssetBytes: number;
        warningCloudAssetBytes: number;
    } | null> {
        if (!this._getCloudAssetSizePolicy()) {
            await this.checkEligibility();
        }
        return this._getCloudAssetSizePolicy();
    }

    private _warnBeforeNearLimitCloudSave(seed: {
        byteLength: number;
        shards?: EncodedShard[];
        fontJson?: Record<string, unknown>;
    }): void {
        const pieceGate = evaluateShardSizes(
            (seed.shards ?? []).map((shard) => ({
                documentId: shard.documentId,
                byteLength: shard.bytes.byteLength
            }))
        );
        const worstPiece = worstCloudPieceSizeReport(pieceGate);
        if (worstPiece?.status === 'warning') {
            const state = cloudPieceSizeWarningState(worstPiece, {
                kind: 'save',
                glyphName: glyphNameForCloudDocument(
                    seed.fontJson,
                    worstPiece.documentId
                )
            });
            const proceed = window.confirm(
                `${state.title} Continue saving to cloud?`
            );
            if (!proceed) {
                throw new Error(
                    'Cloud save cancelled near the current size limit'
                );
            }
            return;
        }

        const policy = this._getCloudAssetSizePolicy();
        if (!policy || seed.byteLength < policy.warningCloudAssetBytes) {
            return;
        }
        if (seed.byteLength > policy.maxCloudAssetBytes) {
            return;
        }

        const proceed = window.confirm(
            `This font is near the current cloud size limit (${formatCloudByteCount(seed.byteLength)} of ${formatCloudByteCount(policy.maxCloudAssetBytes)}). Cloud editing may stop working if it grows further. Continue saving to cloud?`
        );
        if (!proceed) {
            throw new Error('Cloud save cancelled near the current size limit');
        }
    }

    getRelayConnectionState(): {
        assetId: string | null;
        status: CloudConnectionStatus;
        detail?: string;
        pendingSyncCount?: number;
        transferActivity?: CloudTransferActivity;
    } {
        const detail = this._activeAssetId
            ? this.getAssetConnectionDetail(this._activeAssetId)
            : undefined;
        return {
            assetId: this._activeAssetId,
            status: this.connectionStatus,
            ...(this._activeAssetId
                ? {
                      pendingSyncCount: this.getAssetPendingSyncCount(
                          this._activeAssetId
                      ),
                      transferActivity: this.getAssetTransferActivity(
                          this._activeAssetId
                      )
                  }
                : {}),
            ...(detail ? { detail } : {})
        };
    }

    applyRelayedConnectionState(state: {
        assetId: string | null;
        status: string;
        detail?: string;
        pendingSyncCount?: number;
        transferActivity?: CloudTransferActivity;
    }): void {
        if (window.windowRole?.isMainWindow()) {
            return;
        }

        this._relayedAssetId = state.assetId;
        this._relayedConnectionStatus = state.status as CloudConnectionStatus;
        this._relayedConnectionDetail = state.detail;
        this._relayedPendingSyncCount = Math.max(
            0,
            Number(state.pendingSyncCount ?? 0)
        );
        this._relayedTransferActivity =
            state.transferActivity === 'sending' ||
            state.transferActivity === 'receiving'
                ? state.transferActivity
                : 'idle';

        if (state.assetId) {
            this._connectionStatusByAssetId.set(
                state.assetId,
                this._relayedConnectionStatus
            );
            if (state.detail) {
                this._connectionDetailByAssetId.set(
                    state.assetId,
                    state.detail
                );
            } else {
                this._connectionDetailByAssetId.delete(state.assetId);
            }
            this._pendingSyncCountByAssetId.set(
                state.assetId,
                this._relayedPendingSyncCount
            );
            this._transferActivityByAssetId.set(
                state.assetId,
                this._relayedTransferActivity
            );
        }

        if (
            state.assetId &&
            this._relayedConnectionStatus === 'error' &&
            state.detail === CLOUD_ASSET_DELETED_MESSAGE
        ) {
            this.handleDeletedAsset(state.assetId, state.detail);
        }

        window.dispatchEvent(
            new CustomEvent('cloudConnectionStatusChanged', {
                detail: {
                    assetId: state.assetId,
                    status: this._relayedConnectionStatus,
                    detail: state.detail,
                    pendingSyncCount: this._relayedPendingSyncCount,
                    transferActivity: this._relayedTransferActivity
                }
            })
        );
    }

    relayPeerWindowUpdateToCloud(
        update: Uint8Array,
        collaborationMessage: CloudAdapter['sendForwardedUpdate'] extends (
            update: Uint8Array,
            collaborationMessage?: infer T
        ) => void
            ? T
            : never,
        documentId?: string
    ): void {
        if (!window.windowRole?.isMainWindow()) {
            return;
        }
        if (this._liveSession) {
            this._liveSession.sendForwardedUpdate(
                update,
                collaborationMessage,
                documentId
            );
            return;
        }
        this._cloudAdapter?.sendForwardedUpdate(update, collaborationMessage);
    }

    getId(): string {
        return 'cloud';
    }

    getName(): string {
        return 'Cloud';
    }

    getIcon(): string {
        return '<span class="material-symbols-outlined">cloud</span>';
    }

    isVisibleInUI(): boolean {
        return CLOUD_PLUGIN_UI_ENABLED;
    }

    canSave(): boolean {
        const gate = this._documentSet?.evaluateSizes();
        if (gate && !gate.canSave) {
            return false;
        }
        return true;
    }

    async prepareToSave(): Promise<void> {
        await this._refreshOwnedCatalogAndSizes();
    }

    async prepareToSeed(): Promise<void> {
        const fontJson = this._currentFontJson();
        if (!fontJson) {
            return;
        }
        await this.checkEligibility();
        if (this._eligibility?.capabilities) {
            const missingCaps = missingRequiredCloudCapabilities(
                this._eligibility.capabilities
            );
            if (missingCaps.length) {
                throw new Error(
                    `Cloud seed blocked: server is missing capabilities (${missingCaps.join(', ')}).`
                );
            }
        }
        const owned = applyCloudOwnedData(fontJson);
        window.patchSyncEngine?.syncCloudOwnedProjection?.(owned);
        const incomplete = incompleteCloudSeedReason(fontJson);
        if (incomplete) {
            throw new Error(incomplete);
        }
        const wroteDeps =
            window.patchSyncEngine?.syncCompleteFontDepsFromLoadedGlyphs?.(
                fontJson
            );
        if (wroteDeps === false) {
            throw new Error(
                'Cloud seed blocked: font-deps could not be rebuilt from loaded glyphs.'
            );
        }
        const glyphCount = listGlyphRecords(fontJson).length;
        const gate = await this.canAddGlyphs(0);
        if (!gate.allowed) {
            throw new Error(
                gate.reason || 'Cloud seed blocked: glyph quota exceeded.'
            );
        }
        if (
            this._eligibility?.maxGlyphsPerFont != null &&
            glyphCount > this._eligibility.maxGlyphsPerFont
        ) {
            throw new Error(
                `Cloud seed blocked: font has ${glyphCount} glyphs but this account allows ${this._eligibility.maxGlyphsPerFont}.`
            );
        }
    }

    async canAddGlyphs(
        additionalGlyphCount: number
    ): Promise<CanAddGlyphsResult> {
        const additional = Math.max(0, Math.floor(additionalGlyphCount) || 0);
        const assetId = this.getCurrentAssetIdForSharing();
        if (assetId) {
            const limits = await this._fetchAssetLimits(assetId);
            if (!limits) {
                return { allowed: false, reason: 'Cloud limits unavailable' };
            }
            return this._glyphAddGate(additional, limits);
        }
        await this.checkEligibility();
        return this._glyphAddGate(additional, this._assetLimits);
    }

    getCachedCanAddGlyphs(additionalGlyphCount: number): CanAddGlyphsResult {
        return this._glyphAddGate(
            Math.max(0, Math.floor(additionalGlyphCount) || 0),
            this._assetLimits
        );
    }

    canSubmitCollabUpdate(
        requests: CollabSubmitRequest[]
    ): CollabSubmitDecision {
        const max = Math.min(
            this._assetLimits?.maxShardBytes ?? MAX_SHARD_BYTES,
            MAX_SHARD_BYTES
        );
        const maxPacket = Math.min(
            this._assetLimits?.maxPacketBytes ?? MAX_YJS_PACKET_BYTES,
            MAX_YJS_PACKET_BYTES
        );
        return evaluateCollabSubmit(requests, {
            maxShardBytes: max,
            maxPacketBytes: maxPacket
        });
    }

    notifyCollabSubmitRejected(decision: CollabSubmitDecision): void {
        const message = formatCollabSubmitRejection(decision);
        if (!message) {
            return;
        }
        window.dispatchEvent(
            new CustomEvent('collab-capacity-rejected', { detail: decision })
        );
        alert(message);
    }

    private _liveGlyphCount(): number {
        const model = window.currentFontModel;
        if (model && Array.isArray(model.glyphs)) {
            return model.glyphs.length;
        }
        return listGlyphRecords(this._currentFontJson() || {}).length;
    }

    private _resolveMaxGlyphsPerFont(
        limits?: CloudAssetLimits | null
    ): number | null {
        if (
            limits &&
            Object.prototype.hasOwnProperty.call(limits, 'maxGlyphsPerFont')
        ) {
            return limits.maxGlyphsPerFont;
        }
        if (
            this._assetLimits &&
            Object.prototype.hasOwnProperty.call(
                this._assetLimits,
                'maxGlyphsPerFont'
            )
        ) {
            return this._assetLimits.maxGlyphsPerFont;
        }
        if (
            this._eligibility &&
            Object.prototype.hasOwnProperty.call(
                this._eligibility,
                'maxGlyphsPerFont'
            )
        ) {
            return this._eligibility.maxGlyphsPerFont ?? null;
        }
        return 1000;
    }

    private _glyphAddGate(
        additionalGlyphCount: number,
        limits?: CloudAssetLimits | null
    ): CanAddGlyphsResult {
        const max = this._resolveMaxGlyphsPerFont(limits);
        if (max === null) {
            return { allowed: true, remaining: null };
        }
        const liveCount = this._liveGlyphCount();
        const liveRemaining = Math.max(0, max - liveCount);
        const serverRemaining = limits?.remainingGlyphs;
        const remaining =
            typeof serverRemaining === 'number'
                ? Math.min(liveRemaining, serverRemaining)
                : liveRemaining;
        const allowed = additionalGlyphCount <= remaining;
        return {
            allowed,
            remaining,
            reason: allowed
                ? undefined
                : `Glyph limit reached (${liveCount}/${max})`
        };
    }

    stripOwnedFontData<T>(fontJson: T): T {
        return stripOwnedFontData(fontJson);
    }

    showsManualRefreshButton(): boolean {
        return true;
    }

    supportsUpload(): boolean {
        return false;
    }

    supportsNewFolder(): boolean {
        return false; // Cloud uses a flat asset list — no folders
    }

    supportsNewFile(): boolean {
        return false; // New assets are created via Save As, not New File
    }

    supportsFileContextAction(
        action: FileContextAction,
        target: FileContextTarget
    ): boolean {
        switch (action) {
            case 'download':
            case 'rename':
                return false;
            case 'delete':
                return !target.isDir;
            default:
                return super.supportsFileContextAction(action, target);
        }
    }

    /**
     * Cloud Save As is handled entirely by this plugin:
     * create the asset, seed the DO, connect Yjs — no writeFile needed.
     */
    get interceptsSaveAs(): boolean {
        return true;
    }

    async handleSaveAs(name: string): Promise<boolean> {
        try {
            await this._runExclusiveCloudIo('save', () => this.saveAs(name));
            return true;
        } catch (error) {
            if (isTransferCancelled(error)) {
                return false;
            }
            throw error;
        }
    }

    async handleOpenPath(path: string): Promise<boolean> {
        if (!path.startsWith('cloud://')) {
            return false;
        }

        const assetId = path.slice('cloud://'.length).replace(/^\/+/, '');
        if (!assetId) {
            throw new Error('Missing cloud asset id');
        }

        try {
            await this._runExclusiveCloudIo('open', () =>
                this.openAsset(assetId)
            );
            return true;
        } catch (error) {
            if (isTransferCancelled(error)) {
                return false;
            }
            throw error;
        }
    }

    setPendingSparseHydration(sparse: boolean): void {
        this._pendingSparseHydration = sparse;
    }

    /**
     * Hydrate selected catalog glyphs plus their layout/graph closure.
     * Linked windows receive the shard bytes over WindowSync.
     */
    isHydratingOverviewGlyphs(): boolean {
        return this._overviewHydrateInFlight !== null;
    }

    /** True when sparse closure exceeded the residency budget and remaining glyphs stay on the server. */
    isSparsePreviewOnly(): boolean {
        return this._sparsePreviewOnly;
    }

    async hydrateOverviewGlyphs(seedNames: string[]): Promise<string[]> {
        return this.ensureSparseHydration({ glyphNames: seedNames });
    }

    async ensureSparseHydration(input: {
        text?: string;
        glyphNames?: string[];
        purpose?: 'ui' | 'compile';
    }): Promise<string[]> {
        const generation = this._hydrationGeneration;
        if (
            this._overviewHydrateInFlight &&
            this._overviewHydrateGeneration !== generation
        ) {
            return this._overviewHydrateInFlight
                .catch(() => [])
                .then(() => this.ensureSparseHydration(input));
        }
        this._overviewHydrateQueued.push({
            text: input.text,
            glyphNames: input.glyphNames,
            purpose: input.purpose
        });
        if (this._overviewHydrateInFlight) {
            return this._overviewHydrateInFlight;
        }
        const hydrate = (async () => {
            const loaded: string[] = [];
            while (this._overviewHydrateQueued.length) {
                const purpose = this._overviewHydrateQueued[0].purpose || 'ui';
                const batch: typeof this._overviewHydrateQueued = [];
                while (
                    this._overviewHydrateQueued.length &&
                    (this._overviewHydrateQueued[0].purpose || 'ui') === purpose
                ) {
                    batch.push(this._overviewHydrateQueued.shift()!);
                }
                const glyphNames = [
                    ...new Set(batch.flatMap((entry) => entry.glyphNames || []))
                ];
                const text = batch.map((entry) => entry.text || '').join('');
                loaded.push(
                    ...(await this._hydrateOverviewGlyphs({
                        text,
                        glyphNames,
                        purpose
                    }))
                );
            }
            return [...new Set(loaded)];
        })();
        this._overviewHydrateInFlight = hydrate;
        this._overviewHydrateGeneration = generation;
        try {
            return await hydrate;
        } finally {
            if (this._overviewHydrateInFlight === hydrate) {
                this._overviewHydrateInFlight = null;
                this._overviewHydrateGeneration = null;
            }
            if (generation === this._hydrationGeneration) {
                window.dispatchEvent(new CustomEvent('fontModelSync'));
            }
        }
    }

    private async _hydrateOverviewGlyphs(input: {
        text?: string;
        glyphNames?: string[];
        purpose?: 'ui' | 'compile';
    }): Promise<string[]> {
        const assetId = this.activeAssetId;
        const bridge = window.patchSyncEngine;
        const hydrationGeneration = this._hydrationGeneration;
        if (!assetId || !bridge) {
            return [];
        }
        const isCurrent = () =>
            hydrationGeneration === this._hydrationGeneration &&
            this.activeAssetId === assetId &&
            window.patchSyncEngine === bridge;
        const fontJson =
            this._currentFontJson() || getCloudFontJsonFromBridge(bridge) || {};
        const owned = catalogFromCoreJson(fontJson);
        if (!owned) {
            return [];
        }
        const { seedIds, layoutIds } = resolveHydrationSeeds({
            fontJson,
            text: input.text,
            glyphNames: input.glyphNames
        });
        if (!seedIds.length) {
            return [];
        }
        const catalog = Object.values(owned.glyphCatalog).filter(
            (entry) => entry.glyphId && entry.deleted !== true && entry.name
        );
        const catalogEntries = catalog.map((entry) => ({
            glyphId: entry.glyphId,
            name: entry.name,
            ...(Array.isArray(entry.componentIds) && entry.componentIds.length
                ? { componentIds: entry.componentIds }
                : {})
        }));
        const catalogIds = liveCatalogGlyphIds(owned.glyphCatalog);
        const idToName = new Map(
            catalog.map((entry) => [entry.glyphId, entry.name])
        );
        const previousWorkingIds = [
            ...(bridge.listSparseWorkingGlyphIds?.() ?? [])
        ];
        const rememberWorkingIds = (workingIds: string[]): boolean => {
            if (!isCurrent()) {
                return false;
            }
            const previous = new Set(
                bridge.listSparseWorkingGlyphIds?.() ?? []
            );
            if (
                workingIds.length === previous.size &&
                workingIds.every((id) => previous.has(id))
            ) {
                return false;
            }
            bridge.replaceSparseWorkingGlyphIds?.(workingIds);
            window.dispatchEvent(new CustomEvent('fontModelSync'));
            return true;
        };
        const hydrator = new CloudAdapter({
            assetId,
            websiteBaseUrl: this._websiteBaseUrl
        });
        let credentials: Promise<{ token: string; roomUrl: string }> | null =
            null;
        const loadedNames: string[] = [];
        bridge.beginDeferredAfterSync?.();
        try {
            const result = await hydrateSparseGlyphsToFixedPoint({
                session: {
                    assembleFontJson: () =>
                        this._currentFontJson() ||
                        getCloudFontJsonFromBridge(bridge) ||
                        fontJson,
                    loadedGlyphIds: () =>
                        (bridge.listLiveGlyphDocumentIds?.() ?? []).map(
                            (documentId) => documentId.slice('glyph:'.length)
                        ),
                    applyGlyphUpdate: (documentId, bytes) => {
                        const applied = bridge.applyDocumentCatchUp?.(
                            documentId,
                            bytes
                        );
                        if (applied === false) {
                            throw new Error(
                                `Failed to apply hydrated shard ${documentId}`
                            );
                        }
                    },
                    depsMap: () => bridge.depsDoc.getMap('deps'),
                    isCurrent,
                    glyphRevision: (glyphId) => {
                        const tokens = bridge.listGlyphRevisionTokens?.() ?? [];
                        return tokens.find((token) => token.glyphId === glyphId)
                            ?.revision;
                    },
                    persistWorkingIds: rememberWorkingIds,
                    afterFetchedGlyphs: (glyphIds) => {
                        if (!isCurrent()) {
                            return;
                        }
                        for (const glyphId of glyphIds) {
                            const documentId = glyphDocumentId(glyphId);
                            const bytes =
                                bridge.encodeDocumentState?.(documentId);
                            if (!bytes?.byteLength) {
                                throw new Error(
                                    `Hydrated shard is empty: ${documentId}`
                                );
                            }
                            window.windowSync?.broadcastDocumentCatchUp?.(
                                documentId,
                                bytes
                            );
                            const name = idToName.get(glyphId);
                            if (name) {
                                loadedNames.push(name);
                            }
                        }
                    }
                },
                catalogIds,
                seedIds,
                layoutIds,
                previousWorkingIds,
                catalog: catalogEntries,
                requireFetchedGlyphs: true,
                planner: input.purpose === 'compile' ? 'compile' : 'ui',
                visibleIds:
                    input.purpose === 'compile'
                        ? resolveHydrationSeeds({
                              fontJson,
                              glyphNames: input.glyphNames
                          }).seedIds
                        : undefined,
                fetchGlyphs: async (documentIds) => {
                    credentials ||= this._fetchRoomToken(assetId);
                    const { token, roomUrl } = await credentials;
                    if (!isCurrent()) {
                        throw new Error('Sparse hydration session changed');
                    }
                    return hydrator.hydrateDocumentSet(
                        token,
                        roomUrl,
                        documentIds
                    );
                }
            });
            if (
                isCurrent() &&
                typeof bridge.unloadCleanGlyphDocuments === 'function'
            ) {
                bridge.unloadCleanGlyphDocuments([
                    ...result.workingIds,
                    ...result.hiddenIds
                ]);
            }
            if (isCurrent()) {
                this._sparsePreviewOnly = result.previewOnly === true;
            }
            const changedNames = [...new Set(loadedNames)];
            if (!changedNames.length) {
                return result.workingIds
                    .map((id) => idToName.get(id))
                    .filter((name): name is string => Boolean(name));
            }
            return changedNames;
        } finally {
            bridge.endDeferredAfterSync?.();
            hydrator.disconnect();
        }
    }

    requiresPermission(): boolean {
        return true;
    }

    /**
     * Activate the cloud plugin.
     * Returns true only when the user is authenticated and cloud hosting is
     * enabled for their account. Returning false causes switchContext to call
     * updateUI which shows the appropriate cloud-panel message.
     */
    async onActivate(): Promise<boolean> {
        this._availabilityErrorMessage = null;

        try {
            const user = await this._ensureCloudUser({
                allowLoginRedirect: true
            });
            if (!user) return false;

            this._eligibility = null; // bust cache on every activation
            void this.checkEligibility();
            return true;
        } catch (error) {
            const message = this._describeAvailabilityError(error);
            this._availabilityErrorMessage = message;
            console.warn('[CloudPlugin]', 'Cloud activation failed:', error);
            return false;
        }
    }

    async onDeactivate(): Promise<void> {
        const cloudPanel = document.getElementById('cloud-panel');
        if (cloudPanel) cloudPanel.classList.remove('visible');
    }

    /**
     * Update cloud-specific UI.
     * Manages the #cloud-panel element to show login-required or
     * eligibility-required messages, hiding it when ready to browse.
     */
    async updateUI(uiCallbacks: {
        showOpenFolderUI: () => void;
        hideOpenFolderUI: () => void;
        showPermissionBanner: (show: boolean) => void;
        showUnsupportedBrowserUI: () => void;
        hideUnsupportedBrowserUI: () => void;
        showPluginMessage: (options: PluginMessageOptions) => void;
        hidePluginMessage: () => void;
    }): Promise<void> {
        uiCallbacks.hideUnsupportedBrowserUI();
        uiCallbacks.showPermissionBanner(false);
        uiCallbacks.hideOpenFolderUI();
        uiCallbacks.hidePluginMessage();

        const cloudPanel = document.getElementById('cloud-panel');
        const titleEl = document.getElementById('cloud-panel-title');
        const msgEl = document.getElementById('cloud-panel-message');
        const loginBtn = document.getElementById('cloud-panel-login-btn');

        if (this._availabilityErrorMessage) {
            if (cloudPanel) cloudPanel.classList.remove('visible');
            uiCallbacks.showPluginMessage({
                icon: 'cloud_off',
                title: 'Cloud Unavailable',
                message: this._availabilityErrorMessage,
                tone: 'warning',
                actionLabel: 'Retry',
                onAction: () => {
                    void (window as any).switchContext?.(this.getId());
                }
            });
            return;
        }

        const authMgr = (window as any).authManager;
        const user = authMgr
            ? await authMgr.checkAuthStatus().catch(() => null)
            : null;

        if (!user) {
            if (titleEl) titleEl.textContent = 'Cloud Storage';
            if (msgEl)
                msgEl.textContent =
                    'Log in to save and open fonts from the cloud.';
            if (loginBtn) loginBtn.style.display = '';
            if (cloudPanel) cloudPanel.classList.add('visible');
            return;
        }

        // Authenticated users may access shared assets even if they cannot host
        // their own cloud fonts. Creation remains separately server-enforced.
        if (cloudPanel) cloudPanel.classList.remove('visible');

        // Refresh the asset list so it reflects the latest server state.
        if ((window as any).refreshFileSystem) {
            (window as any).refreshFileSystem();
        }
    }

    getTitleBarMenuItems(): TitleBarMenuItem[] {
        return [
            {
                label: 'Save to Cloud',
                icon: 'cloud_upload',
                action: async () => {
                    await window.showFontFileDialog?.({
                        mode: 'save-as',
                        pluginId: 'cloud'
                    });
                }
            },
            {
                label: 'Copy Cloud Debug Snapshot',
                icon: 'content_copy',
                action: async () => {
                    await this.copyCloudDebugSnapshot();
                }
            },
            {
                label: 'Rebuild Font-Deps',
                icon: 'account_tree',
                action: async () => {
                    this.rebuildFontDepsFromLoadedGlyphs();
                }
            }
        ];
    }

    async isReady(): Promise<boolean> {
        return (
            this._cloudAdapter?.status === 'connected' ||
            this._cloudAdapter?.status === 'syncing'
        );
    }

    // ── Eligibility ──────────────────────────────────────────────

    /**
     * Fetch (and cache) cloud eligibility for the current user.
     * Returns null if the user is not authenticated or an error occurs.
     */
    async checkEligibility(): Promise<CloudEligibility | null> {
        if (this._eligibility) return this._eligibility;
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            return null;
        }
        try {
            const resp = await fetch(
                `${this._websiteBaseUrl}/api/cloud/eligibility`,
                {
                    credentials: 'include',
                    headers: getCloudRequestHeaders()
                }
            );
            if (!resp.ok) return null;
            const data = (await resp.json()) as CloudEligibility;
            this._eligibility = data;
            return data;
        } catch {
            return null;
        }
    }

    private _currentFontJson(): Record<string, unknown> | null {
        const currentFont = (window as any).fontManager?.currentFont;
        const model = currentFont?.fontModel;
        if (model && typeof model.toJSON === 'function') {
            try {
                return model.toJSON({ compileFacing: false }) as Record<
                    string,
                    unknown
                >;
            } catch {
                // Fall through to stored JSON
            }
        }
        if (
            currentFont?.babelfontData &&
            typeof currentFont.babelfontData === 'object'
        ) {
            return currentFont.babelfontData as Record<string, unknown>;
        }
        return null;
    }

    private async _fetchAssetLimits(
        assetId: string
    ): Promise<CloudAssetLimits | null> {
        try {
            const resp = await fetch(
                `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(assetId)}/limits`,
                {
                    credentials: 'include',
                    headers: getCloudRequestHeaders()
                }
            );
            if (!resp.ok) {
                return null;
            }
            const data = (await resp.json()) as CloudAssetLimits;
            this._assetLimits = data;
            return data;
        } catch {
            return null;
        }
    }

    private async _refreshOwnedCatalogAndSizes(): Promise<ShardSizeGate | null> {
        const encoded = window.patchSyncEngine?.encodeDocumentSet?.();
        if (!encoded?.length) {
            return null;
        }
        const gate = evaluateShardSizes(
            encoded.map((shard) => ({
                documentId: shard.documentId,
                byteLength: shard.bytes.byteLength
            }))
        );
        if (!gate.canSave) {
            const blocked = gate.blocking
                .map(
                    (report) =>
                        `${report.documentId} (${report.byteLength} bytes)`
                )
                .join(', ');
            const first = gate.blocking[0];
            this.notifyCollabSubmitRejected({
                allowed: false,
                kind: 'shard',
                documentId: first?.documentId,
                shardBytes: first?.byteLength,
                packetBytes: 0,
                reason: `Cloud save blocked: shard exceeds ${MAX_SHARD_BYTES} bytes (${blocked}).`
            });
            throw new Error(
                `Cloud save blocked: shard exceeds ${MAX_SHARD_BYTES} bytes (${blocked}).`
            );
        }
        return gate;
    }

    private _syncCatalogFromCommittedChange: CommittedChangeListener = (
        entries
    ) => {
        const fontJson = this._currentFontJson();
        if (!fontJson) {
            return;
        }
        const catalogDirty = entries.some((entry) =>
            catalogNeedsUpdate(pathFromCommittedEntry(entry))
        );
        const deletedGlyphIds = deletedGlyphIdsFromCommittedEntries(
            entries,
            fontJson
        );
        const depsGlyphs = new Set<string>();
        for (const entry of entries) {
            const path = pathFromCommittedEntry(entry);
            if (depsNeedUpdate(path) && path[0] === 'glyphs' && path[1]) {
                depsGlyphs.add(String(path[1]));
            }
        }
        if (!catalogDirty && depsGlyphs.size === 0) {
            return;
        }
        const catalogGlyphs = [
            ...new Set(
                entries
                    .map(pathFromCommittedEntry)
                    .filter(
                        (path) =>
                            catalogNeedsUpdate(path) &&
                            path[0] === 'glyphs' &&
                            path[1]
                    )
                    .map((path) => String(path[1]))
            )
        ];
        this._enqueueCatalogProjection({
            catalogDirty,
            deletedGlyphIds,
            catalogGlyphs,
            depsGlyphs
        });
    };

    private _enqueueCatalogProjection(update: {
        catalogDirty: boolean;
        deletedGlyphIds: string[];
        catalogGlyphs: string[];
        depsGlyphs: Set<string>;
    }): void {
        if (this._pendingCatalogProjection) {
            const pending = this._pendingCatalogProjection;
            pending.catalogDirty = pending.catalogDirty || update.catalogDirty;
            pending.deletedGlyphIds = [
                ...new Set([
                    ...pending.deletedGlyphIds,
                    ...update.deletedGlyphIds
                ])
            ];
            pending.catalogGlyphs = [
                ...new Set([...pending.catalogGlyphs, ...update.catalogGlyphs])
            ];
            for (const glyph of update.depsGlyphs) {
                pending.depsGlyphs.add(glyph);
            }
        } else {
            this._pendingCatalogProjection = {
                catalogDirty: update.catalogDirty,
                deletedGlyphIds: [...update.deletedGlyphIds],
                catalogGlyphs: [...update.catalogGlyphs],
                depsGlyphs: new Set(update.depsGlyphs)
            };
        }
        if (this._isSyncingCatalog) {
            return;
        }
        this._flushCatalogProjection();
    }

    private _flushCatalogProjection(): void {
        const fontJson = this._currentFontJson();
        while (this._pendingCatalogProjection && fontJson) {
            const pending = this._pendingCatalogProjection;
            this._pendingCatalogProjection = null;
            this._isSyncingCatalog = true;
            try {
                if (pending.catalogDirty) {
                    const owned =
                        pending.deletedGlyphIds.length ||
                        pending.catalogGlyphs.length !== 1
                            ? applyCloudOwnedData(fontJson, {
                                  deletedGlyphIds: pending.deletedGlyphIds
                              })
                            : patchCloudOwnedGlyph(
                                  fontJson,
                                  pending.catalogGlyphs[0]
                              );
                    window.patchSyncEngine?.syncCloudOwnedProjection?.(owned);
                }
                if (pending.depsGlyphs.size > 0) {
                    window.patchSyncEngine?.syncFontDepsFromFontJson?.(
                        fontJson,
                        [...pending.depsGlyphs]
                    );
                }
                void this._refreshAssetLimitsAfterCatalogChange();
            } finally {
                this._isSyncingCatalog = false;
            }
        }
    }

    private _syncGlyphCatchUpFromCommittedChange: CommittedChangeListener = (
        entries,
        context
    ) => {
        if (context.origin !== 'remote') {
            return;
        }
        if (
            context.documentId &&
            context.documentId !== FONT_CORE_DOCUMENT_ID
        ) {
            return;
        }
        const glyphIds = glyphIdsFromRevisionEntries(entries);
        if (!glyphIds.length) {
            return;
        }
        const bridge = this._activeAssetSizeBridge;
        const subsetIds = bridge
            ? this._editingSubsetGlyphIdsForCatchUp(bridge)
            : [];
        const catchUpIds = glyphIds.filter((glyphId) =>
            subsetIds.includes(glyphId)
        );
        this._enqueueGlyphCatchUp(catchUpIds);
        const fontJson = this._currentFontJson();
        if (!fontJson || !bridge) {
            return;
        }
        const loadedNames = listGlyphRecords(fontJson)
            .filter((glyph) => catchUpIds.includes(String(glyph.id || '')))
            .map((glyph) => String(glyph.name || ''))
            .filter(Boolean);
        if (loadedNames.length) {
            bridge.syncFontDepsFromFontJson?.(fontJson, loadedNames);
        }
    };

    private _catchUpFromCoreRevisionMap(): void {
        const bridge = this._activeAssetSizeBridge;
        if (!bridge) {
            return;
        }
        const subsetIds = this._editingSubsetGlyphIdsForCatchUp(bridge);
        const staleIds = this._staleGlyphIdsForCatchUp(bridge).filter(
            (glyphId) => subsetIds.includes(glyphId)
        );
        this._enqueueGlyphCatchUp([...new Set([...subsetIds, ...staleIds])]);
    }

    /**
     * HTTP catch-up is for the live editing glyphs, not overview residency
     * or the compile snapshot. Sparse working-set IDs and
     * deriveSubsetGlyphsFromText(compile text) close layout/components
     * across most of a Fustat catalog and fan GET /live after reconnect.
     */
    private _editingSubsetGlyphIdsForCatchUp(
        bridge: PatchSyncEngine
    ): string[] {
        const fontManager = window.fontManager;
        const names = [
            ...activeEditorGlyphNames(fontManager),
            ...((window as any).glyphCanvas?.textRunEditor?.glyphNameBuffer ||
                [])
        ];
        return liveGlyphDocumentIdsFromSubset(bridge, names)
            .filter((documentId) => documentId.startsWith('glyph:'))
            .map((documentId) => documentId.slice('glyph:'.length));
    }

    private _staleGlyphIdsForCatchUp(bridge: PatchSyncEngine): string[] {
        const tokens = bridge.listGlyphRevisionTokens?.() ?? [];
        if (typeof bridge.glyphHasCatchUpRevision !== 'function') {
            return [];
        }
        return tokens
            .filter(
                (token) =>
                    !!token.glyphId &&
                    !!token.revision &&
                    !bridge.glyphHasCatchUpRevision(
                        glyphDocumentId(token.glyphId),
                        token.revision
                    )
            )
            .map((token) => token.glyphId);
    }

    private _enqueueGlyphCatchUp(glyphIds?: string[]): void {
        const bridge = this._activeAssetSizeBridge;
        if (!this._liveSession || !bridge) {
            return;
        }
        const tokens = bridge.listGlyphRevisionTokens?.() ?? [];
        const subsetIds = this._editingSubsetGlyphIdsForCatchUp(bridge);
        const requestedIds = glyphIds?.length
            ? subsetIds.length
                ? glyphIds.filter((glyphId) => subsetIds.includes(glyphId))
                : []
            : subsetIds;
        if (!requestedIds.length) {
            return;
        }
        const selected = requestedIds.map((glyphId) => {
            const token = tokens.find((entry) => entry.glyphId === glyphId);
            return {
                glyphId,
                revision: token?.revision
            };
        });
        const targets = selected
            .map((entry) => ({
                documentId: glyphDocumentId(entry.glyphId),
                expectedRevision: entry.revision
            }))
            .filter((target) => {
                if (this._glyphCatchUpInFlight.has(target.documentId)) {
                    return false;
                }
                if (
                    target.expectedRevision &&
                    typeof bridge.glyphHasCatchUpRevision === 'function' &&
                    bridge.glyphHasCatchUpRevision(
                        target.documentId,
                        target.expectedRevision
                    )
                ) {
                    return false;
                }
                return true;
            });
        if (!targets.length) {
            return;
        }
        for (const target of targets) {
            this._glyphCatchUpInFlight.add(target.documentId);
        }
        void this._liveSession
            .catchUpDocuments(targets, { includeLiveDocuments: true })
            .catch((error) => {
                console.warn(
                    '[CloudPlugin] Failed to catch up glyphs outside the live subset:',
                    error
                );
            })
            .finally(() => {
                for (const target of targets) {
                    this._glyphCatchUpInFlight.delete(target.documentId);
                }
            });
    }

    private async _refreshAssetLimitsAfterCatalogChange(): Promise<void> {
        const assetId = this.getCurrentAssetIdForSharing();
        if (assetId) {
            await this._fetchAssetLimits(assetId);
        }
    }

    // ── Asset listing ────────────────────────────────────────────

    /**
     * List all cloud assets accessible to the current user.
     */
    async getAssets(): Promise<CloudAsset[]> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            return [];
        }
        const resp = await fetch(`${this._websiteBaseUrl}/api/cloud/assets`, {
            credentials: 'include',
            headers: getCloudRequestHeaders()
        });
        if (!resp.ok) {
            throw new Error(`Failed to list cloud assets: ${resp.status}`);
        }
        const data = (await resp.json()) as { assets: CloudAsset[] };
        for (const asset of data.assets ?? []) {
            this._cacheAssetRole(asset.id, asset.role);
        }
        return data.assets;
    }

    getCurrentAssetIdForSharing(): string | null {
        const currentFont = (window as any).fontManager?.currentFont;
        const currentPlugin = currentFont?.sourcePlugin;
        const currentPluginId = currentPlugin?.getId?.();
        if (currentPlugin !== this && currentPluginId !== this.getId()) {
            return null;
        }

        const rawPath = String(currentFont?.path || '').trim();
        if (!rawPath) {
            return this.activeAssetId;
        }

        if (rawPath.startsWith('cloud://')) {
            return rawPath.slice('cloud://'.length).replace(/^\/+/, '') || null;
        }

        return rawPath.replace(/^\/+/, '') || this.activeAssetId;
    }

    private _resolveShareAssetId(assetId?: string): string {
        const resolvedAssetId = assetId || this.getCurrentAssetIdForSharing();
        if (!resolvedAssetId) {
            throw new Error('No cloud asset is currently open');
        }
        return resolvedAssetId;
    }

    async getShareState(assetId?: string): Promise<CloudShareState> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            throw new Error('Authentication required');
        }

        const resolvedAssetId = this._resolveShareAssetId(assetId);
        const resp = await fetch(
            `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(resolvedAssetId)}/members`,
            {
                credentials: 'include',
                headers: getCloudRequestHeaders()
            }
        );

        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            throw new Error(
                `Failed to load sharing settings: ${resp.status} ${body}`
            );
        }

        const shareState = (await resp.json()) as CloudShareState;
        this._cacheAssetRole(resolvedAssetId, shareState.asset.role);
        return shareState;
    }

    async inviteUser(
        email: string,
        role: 'editor' | 'viewer',
        assetId?: string
    ): Promise<{
        invitation: CloudAssetInvitation;
        inviteUrl?: string;
    }> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            throw new Error('Authentication required');
        }

        const resolvedAssetId = this._resolveShareAssetId(assetId);
        const resp = await fetch(
            `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(resolvedAssetId)}/invitations`,
            {
                method: 'POST',
                credentials: 'include',
                headers: getCloudRequestHeaders({
                    'Content-Type': 'application/json'
                }),
                body: JSON.stringify({ email, role })
            }
        );

        const data = (await resp.json().catch(() => ({}))) as {
            error?: string;
            invitation?: CloudAssetInvitation;
            inviteUrl?: string;
        };
        if (!resp.ok) {
            throw new Error(data.error || 'Failed to create invitation');
        }

        if (!data.invitation) {
            throw new Error('Invitation response missing invitation data');
        }

        return {
            invitation: data.invitation,
            ...(data.inviteUrl ? { inviteUrl: data.inviteUrl } : {})
        };
    }

    async createOwnershipTransfer(
        email: string,
        previousOwnerRole: 'editor' | 'viewer' | 'remove',
        assetId?: string
    ): Promise<{
        ownershipTransfer: CloudOwnershipTransfer;
        transferUrl?: string;
    }> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            throw new Error('Authentication required');
        }

        const resolvedAssetId = this._resolveShareAssetId(assetId);
        const resp = await fetch(
            `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(resolvedAssetId)}/ownership-transfer`,
            {
                method: 'POST',
                credentials: 'include',
                headers: getCloudRequestHeaders({
                    'Content-Type': 'application/json'
                }),
                body: JSON.stringify({ email, previousOwnerRole })
            }
        );

        const data = (await resp.json().catch(() => ({}))) as {
            error?: string;
            ownershipTransfer?: CloudOwnershipTransfer;
            transferUrl?: string;
        };
        if (!resp.ok) {
            throw new Error(
                data.error || 'Failed to create ownership transfer'
            );
        }

        if (!data.ownershipTransfer) {
            throw new Error(
                'Ownership transfer response missing transfer data'
            );
        }

        return {
            ownershipTransfer: data.ownershipTransfer,
            ...(data.transferUrl ? { transferUrl: data.transferUrl } : {})
        };
    }

    async cancelOwnershipTransfer(assetId?: string): Promise<void> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            throw new Error('Authentication required');
        }

        const resolvedAssetId = this._resolveShareAssetId(assetId);
        const resp = await fetch(
            `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(resolvedAssetId)}/ownership-transfer`,
            {
                method: 'DELETE',
                credentials: 'include',
                headers: getCloudRequestHeaders()
            }
        );

        const data = (await resp.json().catch(() => ({}))) as {
            error?: string;
        };
        if (!resp.ok) {
            throw new Error(
                data.error || 'Failed to cancel ownership transfer'
            );
        }
    }

    async revokeInvitation(
        invitationId: string,
        assetId?: string
    ): Promise<void> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            throw new Error('Authentication required');
        }

        const resolvedAssetId = this._resolveShareAssetId(assetId);
        const resp = await fetch(
            `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(resolvedAssetId)}/invitations/${encodeURIComponent(invitationId)}`,
            {
                method: 'POST',
                credentials: 'include',
                headers: getCloudRequestHeaders()
            }
        );

        const data = (await resp.json().catch(() => ({}))) as {
            error?: string;
        };
        if (!resp.ok) {
            throw new Error(data.error || 'Failed to revoke invitation');
        }
    }

    async updateMemberRole(
        userId: string,
        role: 'editor' | 'viewer',
        assetId?: string
    ): Promise<void> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            throw new Error('Authentication required');
        }

        const resolvedAssetId = this._resolveShareAssetId(assetId);
        const resp = await fetch(
            `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(resolvedAssetId)}/members/${encodeURIComponent(userId)}`,
            {
                method: 'PATCH',
                credentials: 'include',
                headers: getCloudRequestHeaders({
                    'Content-Type': 'application/json'
                }),
                body: JSON.stringify({ role })
            }
        );

        const data = (await resp.json().catch(() => ({}))) as {
            error?: string;
        };
        if (!resp.ok) {
            throw new Error(data.error || 'Failed to update member role');
        }
    }

    async removeMember(userId: string, assetId?: string): Promise<void> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            throw new Error('Authentication required');
        }

        const resolvedAssetId = this._resolveShareAssetId(assetId);
        const resp = await fetch(
            `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(resolvedAssetId)}/members/${encodeURIComponent(userId)}`,
            {
                method: 'DELETE',
                credentials: 'include',
                headers: getCloudRequestHeaders()
            }
        );

        const data = (await resp.json().catch(() => ({}))) as {
            error?: string;
            accessChange?: { state?: string; warning?: string };
        };
        if (!resp.ok) {
            throw new Error(data.error || 'Failed to remove member');
        }
        if (data.accessChange?.state && data.accessChange.state !== 'applied') {
            console.warn(
                data.accessChange.warning ||
                    'Member removed, but room access revocation is still pending'
            );
        }
    }

    // ── Opening a cloud font ─────────────────────────────────────

    /**
     * Open an existing cloud font by asset ID.
     *
     * Flow:
     *  1. Fetch room token from the website.
     *  2. Connect a temporary PatchSyncEngine to the room WebSocket.
     *  3. Wait for the initial CRDT sync to complete.
     *  4. Extract babelfont JSON from the synced Yjs doc.
     *  5. Dispatch `fontLoaded` to trigger the normal font-loading pipeline.
     *  6. Bootstrap the real bridge from the synced Yjs state after
     *     `fontModelReady`, then rebind the adapter to it.
     */
    async openAsset(assetId: string): Promise<void> {
        if (this._pendingOpenAsset?.assetId === assetId) {
            return this._pendingOpenAsset.promise;
        }

        beginLoadingCursor();
        const urlSparse = readUrlState().sparse === true;
        const linkedOrSync =
            window.windowRole?.isLinkedWindow?.() === true ||
            (typeof location !== 'undefined' &&
                new URLSearchParams(location.search).has('sync'));
        const openPromise = this._openAssetInternal(assetId, {
            awaitLiveBridge: true,
            sparseHydration:
                this._pendingSparseHydration || urlSparse || linkedOrSync
        });
        this._pendingSparseHydration = false;
        this._pendingOpenAsset = {
            assetId,
            promise: openPromise
        };

        try {
            await openPromise;
        } catch (error) {
            (
                window as Window & { __cloudOpenError?: string }
            ).__cloudOpenError =
                error instanceof Error ? error.message : String(error);
            throw error;
        } finally {
            if (this._pendingOpenAsset?.promise === openPromise) {
                this._pendingOpenAsset = null;
            }
            endLoadingCursor();
        }
    }

    private async _openAssetInternal(
        assetId: string,
        options?: {
            awaitLiveBridge?: boolean;
            sparseHydration?: boolean;
        }
    ): Promise<void> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            throw new Error('Authentication required');
        }

        void this._ensureCloudSizePolicy().then(() => {
            void window.fontManager?.updateFontDisplay?.();
        });

        this._disconnectCurrent();

        let { token, roomUrl, needsMigration } =
            await this._fetchRoomToken(assetId);
        if (needsMigration) {
            await this._migrateAssetToProtocol5(assetId);
            ({ token, roomUrl } = await this._fetchRoomToken(assetId));
        }

        const hydrator = new CloudAdapter({
            assetId,
            websiteBaseUrl: this._websiteBaseUrl
        });
        let hydratedShards: EncodedShard[] | null = null;
        let hydratedFontJson: Record<string, unknown> | null = null;
        let sparseWorkingGlyphIds: string[] = [];
        let usedSparseHydration = options?.sparseHydration === true;
        try {
            await loadDocumentSetWithProgress({
                total: 2,
                work: async (session) => {
                    const io = shardIoOptionsFromSession(session, {
                        progressTotal: 2
                    });
                    const coreAndDeps = await this._hydrateCoreDepsConsistent(
                        hydrator,
                        token,
                        roomUrl,
                        assetId,
                        io
                    );
                    const coreBytes = coreAndDeps.get(FONT_CORE_DOCUMENT_ID);
                    if (!coreBytes?.byteLength) {
                        return;
                    }
                    const documentSet = new CloudDocumentSet();
                    documentSet.applyRemoteUpdate(
                        FONT_CORE_DOCUMENT_ID,
                        coreBytes
                    );
                    const depsBytes = coreAndDeps.get(FONT_DEPS_DOCUMENT_ID);
                    if (depsBytes?.byteLength) {
                        documentSet.applyRemoteUpdate(
                            FONT_DEPS_DOCUMENT_ID,
                            depsBytes
                        );
                    }
                    const coreJson = documentSet.assembleFontJson();
                    const catalogIds = glyphIdsFromCoreJson(coreJson);
                    const urlText = readUrlState().text || '';
                    const useSparse =
                        usedSparseHydration ||
                        shouldAutoSparseHydrate(catalogIds.length);
                    usedSparseHydration = useSparse;
                    let glyphBytes = new Map<string, Uint8Array>();
                    const fetchGlyphs = (documentIds: string[]) =>
                        hydrator.hydrateDocumentSet(
                            token,
                            roomUrl,
                            documentIds,
                            shardIoOptionsFromSession(session, {
                                progressOffset: session.completed,
                                progressTotal: session.total
                            })
                        );
                    if (!useSparse) {
                        session.update({
                            total: 2 + catalogIds.length,
                            message: 'Loading font…'
                        });
                        const documentIds = catalogIds.map(glyphDocumentId);
                        glyphBytes = await fetchGlyphs(documentIds);
                        const missingPublished = documentIds.filter(
                            (documentId) =>
                                !glyphBytes.get(documentId)?.byteLength
                        );
                        if (missingPublished.length) {
                            throw new Error(
                                `Published glyph shards not found: ${missingPublished.join(', ')}`
                            );
                        }
                        for (const [documentId, bytes] of glyphBytes) {
                            documentSet.applyRemoteUpdate(documentId, bytes);
                        }
                    } else {
                        const { seedIds, layoutIds } = resolveHydrationSeeds({
                            fontJson: coreJson,
                            text: urlText || 'Hamburgevons'
                        });
                        session.update({
                            total: 2 + seedIds.length,
                            message: 'Loading font…'
                        });
                        if (seedIds.length) {
                            const hydrateResult =
                                await hydrateSparseGlyphsToFixedPoint({
                                    documentSet,
                                    catalogIds,
                                    seedIds,
                                    layoutIds,
                                    previousWorkingIds: [],
                                    catalog:
                                        catalogEntriesFromCoreJson(coreJson),
                                    requireFetchedGlyphs: true,
                                    fetchGlyphs
                                });
                            glyphBytes = hydrateResult.glyphBytes;
                            sparseWorkingGlyphIds = hydrateResult.workingIds;
                            this._sparsePreviewOnly =
                                hydrateResult.previewOnly === true;
                        }
                    }
                    hydratedFontJson = documentSet.assembleFontJson();
                    hydratedShards = [
                        {
                            documentId: FONT_CORE_DOCUMENT_ID,
                            bytes: coreBytes
                        },
                        ...(depsBytes?.byteLength
                            ? [
                                  {
                                      documentId: FONT_DEPS_DOCUMENT_ID,
                                      bytes: depsBytes
                                  }
                              ]
                            : []),
                        ...[...glyphBytes.entries()].map(
                            ([documentId, bytes]) => ({
                                documentId,
                                bytes
                            })
                        )
                    ];
                    documentSet.destroy();
                }
            });
        } catch (error) {
            throw error instanceof Error ? error : new Error(String(error));
        } finally {
            hydrator.disconnect();
        }

        // Fail closed: HTTP hydrate either produced shards or threw. Never
        // fall back to an unbounded full-room WebSocket bootstrap.
        const openedShards = (hydratedShards || []) as EncodedShard[];
        if (openedShards.length > 0 && hydratedFontJson) {
            try {
                validateCloudExportForFontOpen(hydratedFontJson);
            } catch (error) {
                throw error;
            }

            const babelfontJson = JSON.stringify(hydratedFontJson);
            (
                window as Window & {
                    __pendingCloudBridgeBootstrapDocuments?: EncodedShard[];
                    __skipCloudBridgeRebindMerge?: boolean;
                }
            ).__pendingCloudBridgeBootstrapDocuments = openedShards;
            (
                window as Window & {
                    __skipCloudBridgeRebindMerge?: boolean;
                }
            ).__skipCloudBridgeRebindMerge = true;

            this._activeAssetId = assetId;
            if (usedSparseHydration) {
                (
                    window as Window & {
                        __pendingSparseSession?: boolean;
                        __pendingSparseWorkingGlyphIds?: string[];
                    }
                ).__pendingSparseSession = true;
                (
                    window as Window & {
                        __pendingSparseWorkingGlyphIds?: string[];
                    }
                ).__pendingSparseWorkingGlyphIds = sparseWorkingGlyphIds;
            }
            const bridgeReadyPromise = new Promise<void>((resolve, reject) => {
                const timeoutId = window.setTimeout(() => {
                    window.removeEventListener(
                        'fontModelReady',
                        onFontModelReady
                    );
                    reject(new Error('cloud bridge bootstrap timed out'));
                }, 30_000);

                const onFontModelReady = async () => {
                    window.clearTimeout(timeoutId);
                    window.removeEventListener(
                        'fontModelReady',
                        onFontModelReady
                    );
                    try {
                        const liveBridge = window.patchSyncEngine;
                        if (!liveBridge) {
                            throw new Error(
                                'cloud bridge bootstrap missing live bridge'
                            );
                        }
                        if (window.windowRole?.isLinkedWindow()) {
                            resolve();
                            return;
                        }
                        const liveTokenResponse =
                            await this._fetchRoomToken(assetId);
                        await this._attachLiveSession({
                            assetId,
                            token: liveTokenResponse.token,
                            roomUrl: liveTokenResponse.roomUrl,
                            bridge: liveBridge,
                            bootstrapMode: 'skip',
                            generationId: liveTokenResponse.generationId
                        });
                        resolve();
                    } catch (error) {
                        reject(
                            error instanceof Error
                                ? error
                                : new Error(String(error))
                        );
                    }
                };

                window.addEventListener('fontModelReady', onFontModelReady);
            });

            window.dispatchEvent(
                new CustomEvent('fontLoaded', {
                    detail: {
                        path: `cloud://${assetId}`,
                        babelfontJson,
                        sourcePlugin: this,
                        fileHandle: undefined,
                        directoryHandle: undefined
                    }
                })
            );

            if (options?.awaitLiveBridge === false) {
                void bridgeReadyPromise.catch((error) => {
                    this._handleBackgroundBridgeBootstrapFailure(
                        assetId,
                        error
                    );
                });
                return;
            }

            await bridgeReadyPromise;
            return;
        }

        throw new Error(
            `Cloud asset ${assetId} has no published core/deps snapshot`
        );
    }

    // ── Saving a font to the cloud ───────────────────────────────

    /**
     * Mark the currently open local font as the just-created cloud asset.
     * Save As now seeds the room with the live bridge directly, so this runs
     * only after the owner is already attached to the new room.
     */
    private _finalizeCurrentFontAsSavedCloudAsset(assetId: string): void {
        const currentFont = (window as any).fontManager?.currentFont;
        if (!currentFont) {
            return;
        }

        // Use the bare assetId as the path so createFileUri produces
        // cloud:///assetId (no double-slash from a leading slash).
        currentFont.path = assetId;
        currentFont.sourcePlugin = this;
        currentFont.fileHandle = undefined;
        currentFont.directoryHandle = undefined;
        currentFont.needsRecompile = false;
        currentFont.hasUnsavedChanges = false;

        const fileUri = `cloud:///${assetId}`;
        if (window.stateManager) {
            window.stateManager.editor_file = fileUri;
        }
        window.windowSync?.rebindChannel?.(assetId);

        void (window as any).fontManager?.updateFontDisplay?.();
        void (window as any).fontManager?.updateDirtyIndicator?.();
        (window as any).saveButton?.updateButtonState?.();
    }

    /**
     * Save the current font as a new cloud asset with the given name.
     *
     * Flow:
     *  1. Create a new asset via POST /api/cloud/assets.
     *  2. Fetch room token for the new asset.
     *  3. Connect the current live bridge to the new room.
     *     The auto-sync protocol seeds the empty DO and attaches the owner in
     *     the same handshake, so Save As does not need a second bridge handoff.
     */
    async saveAs(name: string): Promise<string> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            throw new Error('Authentication required');
        }

        await this.prepareToSeed();
        let seed = await captureCloudSaveSeedState();
        const sizePolicy = await this._ensureCloudSizePolicy();
        if (sizePolicy && seed.byteLength > sizePolicy.maxCloudAssetBytes) {
            throw new Error(
                `Cloud save blocked: font is ${formatCloudByteCount(seed.byteLength)} but the current cloud tier only supports up to ${formatCloudByteCount(sizePolicy.maxCloudAssetBytes)}.`
            );
        }
        this._warnBeforeNearLimitCloudSave(seed);

        const resp = await fetch(`${this._websiteBaseUrl}/api/cloud/assets`, {
            method: 'POST',
            credentials: 'include',
            headers: getCloudRequestHeaders({
                'Content-Type': 'application/json'
            }),
            body: JSON.stringify({
                name,
                estimatedSeedBytes: seed.byteLength,
                estimatedGlyphCount: seed.glyphCount
            })
        });

        if (!resp.ok) {
            const err = await resp.text().catch(() => '');
            throw new Error(
                `Failed to create cloud asset: ${resp.status} ${err}`
            );
        }

        const { asset } = (await resp.json()) as { asset: CloudAsset };
        const assetId = asset.id;

        const { token, roomUrl } = await this._fetchRoomToken(assetId);
        this._disconnectCurrent();
        seed = await recaptureCloudSaveSeedIfBridgeChanged(seed);
        const seeder = new CloudAdapter({
            assetId,
            websiteBaseUrl: this._websiteBaseUrl
        });
        let seededCheckpointLogId: number | null = null;
        let seedReceipts: CloudSeededShardAttestation[] = [];
        try {
            const seeded = await seedDocumentSetWithProgress({
                seeder,
                token,
                roomUrl,
                shards: seed.shards,
                glyphCount: seed.glyphCount
            });
            seededCheckpointLogId =
                seeded && typeof seeded === 'object'
                    ? seeded.coreCheckpointLogId
                    : typeof seeded === 'number'
                      ? seeded
                      : null;
            if (
                seeded &&
                typeof seeded === 'object' &&
                Array.isArray(seeded.attestations)
            ) {
                seedReceipts = seeded.attestations;
            }
        } catch (error) {
            await this._abortPendingAsset(assetId).catch((abortError) => {
                console.warn(
                    '[CloudPlugin]',
                    'Failed to abort pending cloud asset after seed failure:',
                    abortError
                );
            });
            throw error;
        } finally {
            seeder.disconnect();
        }

        this._disconnectCurrent();

        let attachMs = 0;
        let finalizeMs = 0;
        try {
            const attachStartedAt = performance.now();
            await this._attachLiveSession({
                assetId,
                token,
                roomUrl,
                bridge: seed.bridge,
                bootstrapMode: 'skip',
                ...(seededCheckpointLogId !== null
                    ? { checkpointLogId: seededCheckpointLogId }
                    : {}),
                connectedTimeoutMs: estimateCloudTransferTimeoutMs(
                    seed.byteLength
                )
            });
            attachMs = performance.now() - attachStartedAt;
            const finalizeStartedAt = performance.now();
            await this._finalizePendingAsset(assetId, {
                shards: seed.shards,
                receipts: seedReceipts,
                glyphCount: seed.glyphCount
            });
            finalizeMs = performance.now() - finalizeStartedAt;
        } catch (error) {
            this._disconnectCurrent();
            await this._abortPendingAsset(assetId).catch((abortError) => {
                console.warn(
                    '[CloudPlugin]',
                    'Failed to abort pending cloud asset:',
                    abortError
                );
            });
            throw error;
        }

        this._activeAssetId = assetId;
        this._cacheAssetRole(assetId, asset.role);
        this._finalizeCurrentFontAsSavedCloudAsset(assetId);
        console.log('[CloudPlugin] saveAs phases', {
            captureEncodeMs: seed.captureEncodeMs,
            attachMs,
            finalizeMs,
            shardCount: seed.shards.length,
            byteLength: seed.byteLength
        });

        return assetId;
    }

    /**
     * Seed the current in-memory font to a new pending asset using the same
     * HTTP path as Save As, with an explicit shard POST concurrency.
     * Does not attach a live WebSocket. Used by the shard-I/O bench.
     */
    async measureCloudSeedBatch(
        assetName: string,
        concurrency: number,
        options?: { transport?: 'auto' | 'pack' | 'per-shard' }
    ): Promise<{
        assetId: string;
        seedMs: number;
        shardCount: number;
        byteLength: number;
        documentIds: string[];
        glyphCount: number;
    }> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            throw new Error('Authentication required');
        }

        await this.prepareToSeed();
        const seed = await captureCloudSaveSeedState();
        const ioOptions: CloudShardIoOptions = {
            concurrency,
            transport: options?.transport
        };

        const resp = await fetch(`${this._websiteBaseUrl}/api/cloud/assets`, {
            method: 'POST',
            credentials: 'include',
            headers: getCloudRequestHeaders({
                'Content-Type': 'application/json'
            }),
            body: JSON.stringify({
                name: assetName,
                estimatedSeedBytes: seed.byteLength,
                estimatedGlyphCount: seed.glyphCount
            })
        });
        if (!resp.ok) {
            const err = await resp.text().catch(() => '');
            throw new Error(
                `Failed to create cloud asset: ${resp.status} ${err}`
            );
        }
        const { asset } = (await resp.json()) as { asset: CloudAsset };
        const assetId = asset.id;
        const { token, roomUrl } = await this._fetchRoomToken(assetId);
        const seeder = new CloudAdapter({
            assetId,
            websiteBaseUrl: this._websiteBaseUrl
        });
        const startedAt = performance.now();
        try {
            const seeded = await seeder.seedDocumentSet(
                token,
                roomUrl,
                seed.shards,
                seed.glyphCount,
                undefined,
                ioOptions
            );
            const seedMs = performance.now() - startedAt;
            await this._finalizePendingAsset(assetId, {
                shards: seed.shards,
                receipts: seeded.attestations,
                glyphCount: seed.glyphCount
            });
            return {
                assetId,
                seedMs,
                shardCount: seed.shards.length,
                byteLength: seed.byteLength,
                documentIds: seed.shards.map((shard) => shard.documentId),
                glyphCount: seed.glyphCount
            };
        } catch (error) {
            await this._abortPendingAsset(assetId).catch(() => undefined);
            throw error;
        } finally {
            seeder.disconnect();
        }
    }

    /**
     * GET every listed shard through CloudAdapter.hydrateDocumentSet.
     * Used by the shard-I/O bench for a full Fustat load.
     */
    async measureCloudHydrateBatch(
        assetId: string,
        documentIds: string[],
        concurrency: number,
        options?: { transport?: 'auto' | 'pack' | 'per-shard' }
    ): Promise<{
        hydrateMs: number;
        loaded: number;
        byteLength: number;
    }> {
        const { token, roomUrl } = await this._fetchRoomToken(assetId);
        const hydrator = new CloudAdapter({
            assetId,
            websiteBaseUrl: this._websiteBaseUrl
        });
        const ioOptions: CloudShardIoOptions = {
            concurrency,
            transport: options?.transport
        };
        try {
            const startedAt = performance.now();
            const shards = await hydrator.hydrateDocumentSet(
                token,
                roomUrl,
                documentIds,
                ioOptions
            );
            const hydrateMs = performance.now() - startedAt;
            let byteLength = 0;
            for (const bytes of shards.values()) {
                byteLength += bytes.byteLength;
            }
            return {
                hydrateMs,
                loaded: shards.size,
                byteLength
            };
        } finally {
            hydrator.disconnect();
        }
    }

    /**
     * Connect to a cloud room for the currently open font.
     * Requires a font to already be loaded (window.patchSyncEngine must exist).
     */
    async connectToRoom(assetId: string): Promise<void> {
        const bridge = window.patchSyncEngine;
        this._disconnectCurrent();
        this._activeAssetId = assetId;

        if (!bridge) {
            console.error('No patchSyncEngine available — load a font first');
            this._updateConnectionStatus(
                assetId,
                'error',
                'Cloud bridge not ready'
            );
            return;
        }

        const { token, roomUrl, generationId } =
            await this._fetchRoomToken(assetId);
        console.log(`Connecting to room: ${assetId}`);
        await this._attachLiveSession({
            assetId,
            token,
            roomUrl,
            bridge,
            bootstrapMode: 'required',
            generationId
        });
    }

    /**
     * Dev-only: Connect directly with a pre-built token and room URL,
     * bypassing the website auth endpoint.
     */
    async connectToRoomWithToken(
        assetId: string,
        token: string,
        roomUrl: string
    ): Promise<void> {
        const hostname =
            typeof location !== 'undefined' ? location.hostname : '';
        if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
            throw new Error('Direct room-token connections are disabled');
        }
        const bridge = window.patchSyncEngine;
        this._disconnectCurrent();
        this._activeAssetId = assetId;

        if (!bridge) {
            console.error('No patchSyncEngine available — load a font first');
            this._updateConnectionStatus(
                assetId,
                'error',
                'Cloud bridge not ready'
            );
            return;
        }

        console.log(`Connecting directly to room: ${assetId}`);
        await this._attachLiveSession({
            assetId,
            token,
            roomUrl,
            bridge,
            bootstrapMode: 'required'
        });
    }

    /** Disconnect from the current room. */
    disconnectFromRoom(): void {
        this._disconnectCurrent();
    }

    get connectionStatus(): CloudConnectionStatus {
        if (window.windowRole?.isLinkedWindow()) {
            return this._relayedConnectionStatus;
        }
        if (this._activeAssetId) {
            return this.getAssetConnectionStatus(this._activeAssetId);
        }
        return this._liveSession?.status ?? 'disconnected';
    }

    get activeAssetId(): string | null {
        if (window.windowRole?.isLinkedWindow()) {
            return this._relayedAssetId;
        }
        return this._activeAssetId;
    }

    // ── Private helpers ──────────────────────────────────────────

    private async _runExclusiveCloudIo<T>(
        op: 'save' | 'open',
        work: () => Promise<T>
    ): Promise<T> {
        if (this._cloudIoInFlight) {
            throw new Error(
                `Cannot ${op} while another cloud transfer is in progress`
            );
        }
        const run = work();
        this._cloudIoInFlight = run;
        try {
            return await run;
        } finally {
            if (this._cloudIoInFlight === run) {
                this._cloudIoInFlight = null;
            }
        }
    }

    private _disconnectCurrent(): void {
        this._stopTrackingActiveAssetSize();
        this._stopEditingSubsetSync();
        const pending =
            this._liveSession?.pendingSyncCount ??
            (this._activeAssetId
                ? this.getAssetPendingSyncCount(this._activeAssetId)
                : 0);
        this._attachingSession?.destroy?.();
        this._attachingSession = null;
        this._liveSession?.destroy?.();
        this._liveSession = null;
        this._cloudAdapter?.disconnect();
        this._cloudAdapter = null;
        if (this._activeAssetId) {
            this._updatePendingSyncCount(this._activeAssetId, pending);
            this._updateConnectionStatus(this._activeAssetId, 'disconnected');
        }
        this._activeAssetId = null;
        this._hydrationGeneration += 1;
        this._overviewHydrateQueued = [];
        window.windowSync?.notifyCloudBootstrapPending?.();
        if (window.windowRole?.isLinkedWindow()) {
            this._relayedAssetId = null;
            this._relayedConnectionStatus = 'disconnected';
            this._relayedConnectionDetail = undefined;
            this._relayedPendingSyncCount = 0;
        }
    }

    private async _attachLiveSession(options: {
        assetId: string;
        token: string;
        roomUrl: string;
        bridge: PatchSyncEngine;
        bootstrapMode?: 'required' | 'skip';
        checkpointLogId?: number | null;
        connectedTimeoutMs?: number;
        reportConnectionStatus?: boolean;
        generationId?: string;
    }): Promise<void> {
        window.windowSync?.notifyCloudBootstrapPending?.();
        const session = new CloudLiveSession({
            assetId: options.assetId,
            websiteBaseUrl: this._websiteBaseUrl,
            token: options.token,
            roomUrl: options.roomUrl,
            bridge: options.bridge,
            bootstrapMode: options.bootstrapMode ?? 'skip',
            generationId: options.generationId,
            ...(options.checkpointLogId !== undefined
                ? { checkpointLogId: options.checkpointLogId }
                : {}),
            connectedTimeoutMs: options.connectedTimeoutMs,
            onConnectionStatus: (status, detail) => {
                console.log(
                    `[${options.assetId}] ${status}${detail ? ` (${detail})` : ''}`
                );
                if (options.reportConnectionStatus !== false) {
                    this._updateConnectionStatus(
                        options.assetId,
                        status,
                        detail
                    );
                }
            },
            onPendingSyncCountChange: (count) => {
                this._updatePendingSyncCount(options.assetId, count);
            },
            onTransferActivityChange: (activity) => {
                this._updateTransferActivity(options.assetId, activity);
            },
            refreshCredentials: async () => {
                const next = await this._fetchRoomToken(options.assetId);
                await session.applyConfirmedGeneration(
                    next.generationId || null
                );
                return { token: next.token, roomUrl: next.roomUrl };
            },
            keepRequestedGlyphSockets: this.getCurrentAssetRole() === 'viewer'
        });
        this._attachingSession = session;
        const glyphDocumentIds = liveGlyphDocumentIdsFromSubset(
            options.bridge,
            activeEditorGlyphNames()
        );
        try {
            await session.syncLiveDocumentIds(glyphDocumentIds);
        } catch (error) {
            session.disconnect();
            if (this._attachingSession === session) {
                this._attachingSession = null;
            }
            throw error;
        }
        if (this._attachingSession !== session) {
            session.disconnect();
            return;
        }
        this._attachingSession = null;
        this._liveSession = session;
        await session.applyConfirmedGeneration(options.generationId || null);
        this._cloudAdapter = session.coreAdapter;
        this._startTrackingActiveAssetSize(options.assetId, options.bridge);
        this._startEditingSubsetSync(options.bridge);
        this._editingSubsetListener?.();
        if (options.bridge.hasSparseWorkingSet?.()) {
            const text = readUrlState().text || '';
            if (text) {
                await this.ensureSparseHydration({ text });
            }
        }
        // Do not HTTP-catch-up the core revision map on attach. After save or
        // R2 hydrate the in-memory glyph docs are already the published
        // snapshots; a dirty revision map would fan GET /live across the
        // catalog. Later remote core commits still enqueue via
        // `_coreHydratedListener`.
    }

    private _liveGlyphNamesForSync(): string[] {
        // Viewers and editors both follow the current glyph plus the shaped
        // text run. getLiveVisibleGlyphNames also includes the compile subset
        // snapshot, which opens a Fustat catalog of empty glyph Durable Objects
        // and races GET /state on the glyph the e2e actually probes.
        const names = [
            ...activeEditorGlyphNames(),
            ...((window as any).glyphCanvas?.textRunEditor?.glyphNameBuffer ||
                [])
        ];
        return [
            ...new Set(
                names.filter(
                    (name) =>
                        typeof name === 'string' && name && name !== 'undefined'
                )
            )
        ];
    }

    private _startEditingSubsetSync(bridge: PatchSyncEngine): void {
        this._stopEditingSubsetSync();
        this._editingSubsetListener = () => {
            if (!this._liveSession) {
                return;
            }
            this._liveSession.setKeepRequestedGlyphSockets(
                this.getCurrentAssetRole() === 'viewer'
            );
            const glyphDocumentIds = liveGlyphDocumentIdsFromSubset(
                bridge,
                this._liveGlyphNamesForSync()
            );
            void this._liveSession
                .syncLiveDocumentIds(glyphDocumentIds)
                .catch((error) => {
                    console.warn(
                        '[CloudPlugin] Failed to sync live glyph rooms:',
                        error
                    );
                });
        };
        window.addEventListener(
            'editingSubsetChanged',
            this._editingSubsetListener
        );
        window.addEventListener(
            'activeEditorGlyphChanged',
            this._editingSubsetListener
        );
        this._editingSubsetListener();
    }

    private _stopEditingSubsetSync(): void {
        if (this._editingSubsetListener) {
            window.removeEventListener(
                'editingSubsetChanged',
                this._editingSubsetListener
            );
            window.removeEventListener(
                'activeEditorGlyphChanged',
                this._editingSubsetListener
            );
            this._editingSubsetListener = null;
        }
    }

    private _buildCloudDebugSnapshot(): string {
        const fontManager = window.fontManager as
            | (typeof window.fontManager & {
                  workerCacheUpdatePromise?: Promise<unknown> | null;
                  pendingBabelfontJsonSyncAfterDrag?: boolean;
              })
            | undefined;
        const currentFont = window.fontManager?.currentFont;
        const fontCompilation = window.fontCompilation;
        const activeAssetId = this.activeAssetId;
        const status = activeAssetId
            ? this.getAssetConnectionStatus(activeAssetId)
            : this.connectionStatus;
        const detail = activeAssetId
            ? this.getAssetConnectionDetail(activeAssetId)
            : undefined;
        const pendingSyncCount = activeAssetId
            ? this.getAssetPendingSyncCount(activeAssetId)
            : 0;
        const trace = activeAssetId
            ? this.getConnectionTrace(activeAssetId).slice(-12)
            : [];
        const roleLabel = window.windowRole?.getRoleLabel?.() ?? 'Main';
        const connectedAssetIds = [...this._connectionStatusByAssetId.entries()]
            .filter(([, connectionStatus]) => connectionStatus === 'connected')
            .map(([assetId]) => assetId)
            .sort();
        const outboundSeq = (
            window as Window & {
                __lastCloudOutboundUpdateSeq?: number;
            }
        ).__lastCloudOutboundUpdateSeq;
        const inboundCount = (
            window as Window & {
                __lastCloudInboundUpdateCount?: number;
            }
        ).__lastCloudInboundUpdateCount;
        const workerCacheReady =
            typeof fontCompilation?.hasWorkerCacheDocument === 'function'
                ? fontCompilation.hasWorkerCacheDocument()
                : undefined;
        const connectionHealth =
            activeAssetId && this._cloudAdapter?.assetId === activeAssetId
                ? this._cloudAdapter.getConnectionHealth()
                : null;

        return [
            `capturedAt: ${formatCloudDebugTimestamp(Date.now())}`,
            `windowRole: ${roleLabel}`,
            `activeAssetId: ${activeAssetId ?? 'none'}`,
            `fontPath: ${String(currentFont?.path || 'none')}`,
            `cloudBacked: ${currentFont?.isCloudBacked?.() ? 'yes' : 'no'}`,
            `fontChangeVersion: ${currentFont?.changeVersion ?? 'none'}`,
            `compileRequestVersion: ${currentFont?.compileRequestVersion ?? 'none'}`,
            `workerCacheReady: ${workerCacheReady === undefined ? 'unknown' : workerCacheReady ? 'yes' : 'no'}`,
            `workerCacheUpdatePending: ${fontManager?.workerCacheUpdatePromise ? 'yes' : 'no'}`,
            `pendingBabelfontJsonSyncAfterDrag: ${fontManager?.pendingBabelfontJsonSyncAfterDrag ? 'yes' : 'no'}`,
            `connectionStatus: ${status}`,
            ...(detail ? [`connectionDetail: ${detail}`] : []),
            `pendingSyncCount: ${pendingSyncCount}`,
            `transferActivity: ${
                activeAssetId
                    ? this.getAssetTransferActivity(activeAssetId)
                    : 'idle'
            }`,
            `connectedAssetIds: ${connectedAssetIds.length ? connectedAssetIds.join(', ') : 'none'}`,
            `lastOutboundSeq: ${outboundSeq ?? 'none'}`,
            `lastInboundCount: ${inboundCount ?? 'none'}`,
            `wsReadyState: ${connectionHealth?.wsReadyState ?? 'none'}`,
            `lastInboundAgeMs: ${connectionHealth?.lastInboundAgeMs ?? 'none'}`,
            `livenessTimeoutCount: ${connectionHealth?.livenessTimeoutCount ?? 'none'}`,
            `lastReconnectReason: ${connectionHealth?.lastReconnectReason ?? 'none'}`,
            'trace:',
            ...(trace.length
                ? trace.map(
                      (entry) =>
                          `- ${formatCloudDebugTimestamp(entry.timestamp)} ${entry.status}${entry.detail ? ` | ${entry.detail}` : ''}`
                  )
                : ['- none'])
        ].join('\n');
    }

    private async _ensureCloudUser(options?: {
        allowLoginRedirect?: boolean;
    }): Promise<Record<string, unknown> | null> {
        const authMgr = window.authManager;
        if (!authMgr) {
            return null;
        }

        if (typeof authMgr.ensureCloudSession === 'function') {
            return await authMgr.ensureCloudSession({
                localEmail: this._cloudSessionBootstrapEmail,
                allowLoginRedirect: options?.allowLoginRedirect
            });
        }

        const user = await authMgr.checkAuthStatus().catch(() => null);
        if (user) {
            return user;
        }

        if (options?.allowLoginRedirect !== false) {
            await authMgr.login();
        }

        return null;
    }

    private _describeAvailabilityError(error: unknown): string {
        const message =
            error instanceof Error ? error.message : String(error || '');

        if (/failed to fetch/i.test(message)) {
            return 'The local cloud server is not reachable right now.';
        }

        return `Cloud storage could not be reached: ${message}`;
    }

    private _normalizeRoomTokenErrorMessage(
        assetId: string,
        message: string
    ): string {
        if (
            this._isCurrentFontOpenForAsset(assetId) &&
            /room-token request failed: 404/i.test(message)
        ) {
            return CLOUD_ASSET_DELETED_MESSAGE;
        }

        return message;
    }

    private async _hydrateCoreDepsConsistent(
        hydrator: CloudAdapter,
        token: string,
        roomUrl: string,
        assetId: string,
        ioOptions?: CloudShardIoOptions
    ): Promise<Map<string, Uint8Array>> {
        const published = await this._fetchPublishedManifestForAsset(assetId);
        if (!published) {
            return hydrator.hydrateDocumentSet(
                token,
                roomUrl,
                [FONT_CORE_DOCUMENT_ID, FONT_DEPS_DOCUMENT_ID],
                ioOptions
            );
        }
        const aligned = await hydrateCoreDepsToPublishedPair({
            expected: {
                coreRevision: published.coreRevision,
                depsRevision: published.depsRevision
            },
            hash: hashShardBytes,
            fetchCoreDeps: async () => {
                const fetched = await hydrator.hydrateDocumentSet(
                    token,
                    roomUrl,
                    [FONT_CORE_DOCUMENT_ID, FONT_DEPS_DOCUMENT_ID],
                    ioOptions
                );
                return {
                    core: fetched.get(FONT_CORE_DOCUMENT_ID) || null,
                    deps: fetched.get(FONT_DEPS_DOCUMENT_ID) || null
                };
            }
        });
        const result = new Map<string, Uint8Array>();
        result.set(FONT_CORE_DOCUMENT_ID, aligned.core);
        if (aligned.deps?.byteLength) {
            result.set(FONT_DEPS_DOCUMENT_ID, aligned.deps);
        }
        return result;
    }

    private async _fetchPublishedManifestForAsset(
        assetId: string
    ): Promise<{ coreRevision: string; depsRevision: string } | null> {
        const url = `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(assetId)}/manifests`;
        const resp = await fetch(url, {
            cache: 'no-store',
            credentials: 'include',
            headers: getCloudRequestHeaders()
        });
        if (!resp) {
            return null;
        }
        if (!resp.ok) {
            if (resp.status === 404) {
                return null;
            }
            throw new Error(`manifest fetch failed: ${resp.status}`);
        }
        const data = (await resp.json()) as {
            current?: { coreRevision?: string; depsRevision?: string } | null;
        };
        if (!data.current?.coreRevision || !data.current?.depsRevision) {
            return null;
        }
        return {
            coreRevision: data.current.coreRevision,
            depsRevision: data.current.depsRevision
        };
    }

    private async _migrateAssetToProtocol5(assetId: string): Promise<void> {
        const migrateUrl = `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(assetId)}/migrate`;
        const migrateResp = await fetch(migrateUrl, {
            method: 'POST',
            cache: 'no-store',
            credentials: 'include',
            headers: getCloudRequestHeaders({
                'Content-Type': 'application/json'
            })
        });
        if (!migrateResp.ok) {
            const body = await migrateResp.text().catch(() => '');
            throw new Error(
                `schema migration failed: ${migrateResp.status} ${body}`
            );
        }
        const migration = (await migrateResp.json()) as {
            migrationNonce?: string;
            nextManifestRevision?: number;
        };
        if (
            !migration.migrationNonce ||
            typeof migration.nextManifestRevision !== 'number' ||
            !Number.isInteger(migration.nextManifestRevision) ||
            migration.nextManifestRevision < 1
        ) {
            throw new Error(
                'schema migration did not return a migration nonce'
            );
        }
        const expectedCurrentRevision = migration.nextManifestRevision - 1;
        const { token, roomUrl } = await this._fetchRoomToken(assetId);
        const hydrator = new CloudAdapter({
            assetId,
            websiteBaseUrl: this._websiteBaseUrl
        });
        try {
            let documentSet: CloudDocumentSet | null = null;
            const shards = await hydrator.hydrateDocumentSet(token, roomUrl, [
                FONT_CORE_DOCUMENT_ID,
                FONT_DEPS_DOCUMENT_ID
            ]);
            const coreBytes = shards.get(FONT_CORE_DOCUMENT_ID);
            if (coreBytes?.byteLength) {
                documentSet = new CloudDocumentSet();
                documentSet.applyRemoteUpdate(FONT_CORE_DOCUMENT_ID, coreBytes);
                const depsBytes = shards.get(FONT_DEPS_DOCUMENT_ID);
                if (depsBytes?.byteLength) {
                    documentSet.applyRemoteUpdate(
                        FONT_DEPS_DOCUMENT_ID,
                        depsBytes
                    );
                }
                const catalogIds = glyphIdsFromCoreJson(
                    documentSet.assembleFontJson()
                );
                if (catalogIds.length) {
                    const glyphBytes = await hydrator.hydrateDocumentSet(
                        token,
                        roomUrl,
                        catalogIds.map(glyphDocumentId)
                    );
                    for (const [documentId, bytes] of glyphBytes) {
                        documentSet.applyRemoteUpdate(documentId, bytes);
                    }
                    if (glyphBytes.size !== catalogIds.length) {
                        throw new Error(
                            'schema migration could not fetch every live glyph shard'
                        );
                    }
                }
            } else {
                throw new Error(
                    'schema migration found no checkpoint to reseed'
                );
            }
            if (
                !writeCompleteFontDepsIfLoaded(
                    documentSet.depsDoc.getMap('deps'),
                    documentSet.assembleFontJson()
                )
            ) {
                throw new Error(
                    'schema migration dependencies could not be rebuilt'
                );
            }
            ensureMigrationRevisionTokens(documentSet);
            const coverage = revisionCoverageFromDocumentSet(documentSet);
            if (!coverage.ok) {
                throw new Error(
                    `schema migration coverage failed (${coverage.missing.join(',')})`
                );
            }
            const encoded = documentSet.encodeAll();
            await hydrator.seedDocumentSet(
                token,
                roomUrl,
                encoded,
                coverage.liveGlyphIds.length,
                migration.migrationNonce
            );
            const core = encoded.find(
                (shard) => shard.documentId === FONT_CORE_DOCUMENT_ID
            );
            const deps = encoded.find(
                (shard) => shard.documentId === FONT_DEPS_DOCUMENT_ID
            );
            if (!core || !deps) {
                throw new Error('schema migration missing core/deps shards');
            }
            const commitUrl = `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(assetId)}/manifests`;
            const commitResp = await fetch(commitUrl, {
                method: 'POST',
                cache: 'no-store',
                credentials: 'include',
                headers: getCloudRequestHeaders({
                    'Content-Type': 'application/json'
                }),
                body: JSON.stringify({
                    coreRevision: await hashShardBytes(core.bytes),
                    depsRevision: await hashShardBytes(deps.bytes),
                    shardIds: encoded.map((shard) => shard.documentId),
                    coverage,
                    migrationNonce: migration.migrationNonce,
                    expectedCurrentRevision
                })
            });
            if (!commitResp.ok) {
                const body = await commitResp.text().catch(() => '');
                throw new Error(
                    `schema migration commit failed: ${commitResp.status} ${body}`
                );
            }
            documentSet.destroy();
        } finally {
            hydrator.disconnect();
        }
    }

    private async _fetchRoomToken(assetId: string): Promise<{
        token: string;
        roomUrl: string;
        needsMigration?: boolean;
        generationId?: string;
    }> {
        const url = `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(assetId)}/room-token`;
        const resp = await fetch(url, {
            method: 'POST',
            cache: 'no-store',
            credentials: 'include',
            headers: getCloudRequestHeaders({
                'Content-Type': 'application/json'
            })
        });
        const body = await resp.text().catch(() => '');
        let data: {
            token?: string;
            roomUrl?: string;
            code?: string;
            needsMigration?: boolean;
            generationId?: string;
        } = {};
        try {
            data = body ? JSON.parse(body) : {};
        } catch {
            data = {};
        }
        if (resp.status === 423 && data.code === 'schema_migration_required') {
            return {
                token: '',
                roomUrl: data.roomUrl || '',
                needsMigration: true
            };
        }
        if (!resp.ok) {
            throw new Error(
                this._normalizeRoomTokenErrorMessage(
                    assetId,
                    `room-token request failed: ${resp.status} ${body}`
                )
            );
        }
        if (!data.token || !data.roomUrl) {
            throw new Error('room-token response missing token or roomUrl');
        }
        this._cacheAssetRole(assetId, extractRoleFromRoomToken(data.token));
        return {
            token: data.token,
            roomUrl: data.roomUrl,
            needsMigration: data.needsMigration === true,
            generationId: data.generationId
        };
    }

    private async _finalizePendingAsset(
        assetId: string,
        seed?: {
            shards: Array<{ documentId: string; bytes: Uint8Array }>;
            receipts: CloudSeededShardAttestation[];
            glyphCount: number;
        }
    ): Promise<void> {
        const shards = seed?.shards ?? [];
        const receipts = seed?.receipts ?? [];
        const core = shards.find(
            (shard) => shard.documentId === FONT_CORE_DOCUMENT_ID
        );
        const deps = shards.find(
            (shard) => shard.documentId === FONT_DEPS_DOCUMENT_ID
        );
        const coreReceipt = receipts.find(
            (receipt) => receipt.shardId === FONT_CORE_DOCUMENT_ID
        );
        const depsReceipt = receipts.find(
            (receipt) => receipt.shardId === FONT_DEPS_DOCUMENT_ID
        );
        const url = `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(assetId)}/finalize`;
        const resp = await fetch(url, {
            method: 'POST',
            cache: 'no-store',
            credentials: 'include',
            headers: getCloudRequestHeaders({
                'Content-Type': 'application/json'
            }),
            body: JSON.stringify({
                glyphCount:
                    seed?.glyphCount ??
                    listGlyphRecords(this._currentFontJson() || {}).length,
                coreRevision:
                    coreReceipt?.checkpointSha256 ||
                    (core ? await hashShardBytes(core.bytes) : 'bootstrap'),
                depsRevision:
                    depsReceipt?.checkpointSha256 ||
                    (deps ? await hashShardBytes(deps.bytes) : 'bootstrap'),
                shardIds: shards.length
                    ? shards.map((shard) => shard.documentId)
                    : receipts.map((receipt) => receipt.shardId),
                receipts
            })
        });
        if (!resp.ok) {
            const failBody = await resp.text().catch(() => '');
            throw new Error(
                `finalize request failed: ${resp.status} ${failBody}`
            );
        }
    }

    private async _abortPendingAsset(assetId: string): Promise<void> {
        const url = `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(assetId)}/abort`;
        const resp = await fetch(url, {
            method: 'POST',
            cache: 'no-store',
            credentials: 'include',
            headers: getCloudRequestHeaders({
                'Content-Type': 'application/json'
            }),
            body: JSON.stringify({ reason: 'bootstrap_failed' })
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            throw new Error(`abort request failed: ${resp.status} ${body}`);
        }
    }
}
