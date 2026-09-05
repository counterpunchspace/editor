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
    normalizeCloudRoomWebSocketUrl
} from '../../cloud-adapter';
import {
    CloudLiveSession,
    liveGlyphDocumentIdsFromSubset
} from '../../cloud-live-session';
import {
    PatchSyncEngine,
    type CommittedChangeListener
} from '../../patch-sync-engine';
import { Logger } from '../../logger';
import { resolveWebsiteURL } from '../../website-url';
import { readUrlState } from '../../url-state';
import {
    applyCloudOwnedData,
    catalogFromCoreJson,
    catalogNeedsUpdate,
    liveCatalogGlyphIds,
    listGlyphRecords,
    patchCloudOwnedGlyph,
    stripOwnedFontData
} from '../cloud-glyph-catalog';
import {
    depsNeedUpdate,
    resolveHydrationSeeds,
    readWorkingGlyphIds
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
    documentSetFromWholeFontUpdate,
    ensureMigrationRevisionTokens,
    hashShardBytes,
    revisionCoverageFromDocumentSet
} from '../cloud-asset-migration';
import {
    evaluateShardSizes,
    evaluateCollabSubmit,
    formatCollabSubmitRejection,
    MAX_SHARD_BYTES,
    type ShardSizeGate,
    type CollabSubmitDecision,
    type CollabSubmitRequest
} from '../cloud-shard-limits';

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

function pathFromCommittedEntry(entry: {
    path?: string | Array<string | number>;
}): Array<string | number> {
    const rawPath = entry.path;
    if (Array.isArray(rawPath)) {
        return rawPath;
    }
    if (typeof rawPath === 'string') {
        return rawPath.split('.');
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

function formatCloudByteCount(bytes: number): string {
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
): Array<{ glyphId: string; name: string }> {
    const owned = catalogFromCoreJson(coreJson);
    if (!owned) {
        return [];
    }
    return Object.values(owned.glyphCatalog).map((entry) => ({
        glyphId: entry.glyphId,
        name: entry.name
    }));
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

function parseCloudFontJsonString(
    fontJson: string | null | undefined
): Record<string, unknown> | null {
    if (!fontJson) {
        return null;
    }

    try {
        return JSON.parse(fontJson) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function getCloudFontJsonStructureSignature(
    fontJson: Record<string, unknown> | null | undefined
): string | null {
    if (!fontJson || typeof fontJson !== 'object') {
        return null;
    }

    const glyphs = Array.isArray(fontJson.glyphs)
        ? (fontJson.glyphs as Array<Record<string, unknown>>)
        : [];

    return JSON.stringify(
        glyphs
            .map((glyph) => {
                const layers = Array.isArray(glyph?.layers)
                    ? (glyph.layers as Array<Record<string, unknown>>)
                    : [];

                return {
                    name: String(glyph?.name || ''),
                    layers: layers
                        .map((layer) => ({
                            id: String(layer?.id || ''),
                            shapes: Array.isArray(layer?.shapes)
                                ? layer.shapes.length
                                : 0,
                            anchors: Array.isArray(layer?.anchors)
                                ? layer.anchors.length
                                : 0,
                            guides: Array.isArray(layer?.guides)
                                ? layer.guides.length
                                : 0
                        }))
                        .sort((left, right) => left.id.localeCompare(right.id))
                };
            })
            .sort((left, right) => left.name.localeCompare(right.name))
    );
}

function getCloudFontModelStructureSignature(
    fontModel: unknown
): string | null {
    const glyphs = Array.isArray((fontModel as { glyphs?: unknown[] })?.glyphs)
        ? ((fontModel as { glyphs: Array<Record<string, unknown>> })
              .glyphs as Array<Record<string, unknown>>)
        : [];

    return JSON.stringify(
        glyphs
            .map((glyph) => {
                const layers = Array.isArray(glyph?.layers)
                    ? (glyph.layers as Array<Record<string, unknown>>)
                    : [];

                return {
                    name: String(glyph?.name || ''),
                    layers: layers
                        .map((layer) => ({
                            id: String(layer?.id || ''),
                            shapes: Array.isArray(layer?.shapes)
                                ? layer.shapes.length
                                : (Array.isArray(layer?.paths)
                                      ? layer.paths.length
                                      : 0) +
                                  (Array.isArray(layer?.components)
                                      ? layer.components.length
                                      : 0),
                            anchors: Array.isArray(layer?.anchors)
                                ? layer.anchors.length
                                : 0,
                            guides: Array.isArray(layer?.guides)
                                ? layer.guides.length
                                : 0
                        }))
                        .sort((left, right) => left.id.localeCompare(right.id))
                };
            })
            .sort((left, right) => left.name.localeCompare(right.name))
    );
}

function getCloudFontContentScore(
    fontJson: Record<string, unknown> | null | undefined
): number {
    if (!fontJson || typeof fontJson !== 'object') {
        return -1;
    }

    const glyphs = Array.isArray(fontJson.glyphs)
        ? (fontJson.glyphs as Array<Record<string, unknown>>)
        : [];
    let score = glyphs.length * 1000;

    for (const glyph of glyphs) {
        const layers = Array.isArray(glyph?.layers)
            ? (glyph.layers as Array<Record<string, unknown>>)
            : [];
        score += layers.length * 100;
        for (const layer of layers) {
            score += Array.isArray(layer?.shapes)
                ? layer.shapes.length * 10
                : 0;
            score += Array.isArray(layer?.anchors) ? layer.anchors.length : 0;
            score += Array.isArray(layer?.guides) ? layer.guides.length : 0;
        }
    }

    return score;
}

const CLOUD_TRANSFER_TIMEOUT_FLOOR_MS = 5 * 60_000;
const CLOUD_TRANSFER_TIMEOUT_CHUNK_BYTES = 750_000;
const CLOUD_TRANSFER_TIMEOUT_PER_CHUNK_MS = 15_000;

interface CloudSaveSeedCacheEntry {
    currentFont: object;
    changeVersion: number | null;
    fontJson: Record<string, unknown>;
}

let cloudSaveSeedCache: CloudSaveSeedCacheEntry | null = null;

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

async function waitForCloudSaveSeedFontJson(
    timeoutMs = 15000
): Promise<Record<string, unknown>> {
    return await new Promise((resolve, reject) => {
        const startedAt = Date.now();
        let bestCandidate: Record<string, unknown> | null = null;
        let bestCandidateScore = -1;
        let lastAttemptedFont: object | null = null;
        let lastAttemptedChangeVersion: number | null = null;

        const poll = () => {
            const currentFont = (window as any).fontManager?.currentFont;
            const fontModel =
                (window as any).currentFontModel || currentFont?.fontModel;
            const startupReady = Boolean(
                (window as any).glyphCanvas?.initialFontLoaded &&
                (window as any).fontManager?.editingFont
            );

            if (currentFont && fontModel && startupReady) {
                const changeVersion =
                    typeof currentFont.changeVersion === 'number'
                        ? currentFont.changeVersion
                        : null;
                const cachedSeed = cloudSaveSeedCache;
                if (changeVersion === null) {
                    cloudSaveSeedCache = null;
                }
                if (
                    changeVersion !== null &&
                    cachedSeed &&
                    cachedSeed.currentFont === currentFont &&
                    cachedSeed.changeVersion === changeVersion
                ) {
                    resolve(cachedSeed.fontJson);
                    return;
                }

                if (
                    changeVersion !== null &&
                    lastAttemptedFont === currentFont &&
                    lastAttemptedChangeVersion === changeVersion
                ) {
                    if (Date.now() - startedAt >= timeoutMs) {
                        if (bestCandidate) {
                            resolve(bestCandidate);
                            return;
                        }

                        reject(
                            new Error(
                                'Cloud font model did not settle into a savable JSON snapshot'
                            )
                        );
                        return;
                    }

                    window.requestAnimationFrame(poll);
                    return;
                }

                lastAttemptedFont = currentFont;
                lastAttemptedChangeVersion = changeVersion;
                const preSyncFontJson = parseCloudFontJsonString(
                    currentFont.babelfontJson
                );
                const preSyncScore = getCloudFontContentScore(preSyncFontJson);
                if (preSyncFontJson && preSyncScore > bestCandidateScore) {
                    bestCandidate = canonicalizeCloudExportFontJson(
                        cloneCloudFontJson(preSyncFontJson)
                    );
                    bestCandidateScore = preSyncScore;
                }

                currentFont.syncJsonFromModel?.();
                const fontJson = currentFont.babelfontData as
                    Record<string, unknown> | undefined;
                const syncedScore = getCloudFontContentScore(fontJson);
                if (fontJson && syncedScore > bestCandidateScore) {
                    bestCandidate = canonicalizeCloudExportFontJson(
                        cloneCloudFontJson(fontJson)
                    );
                    bestCandidateScore = syncedScore;
                }
                const modelSignature =
                    getCloudFontModelStructureSignature(fontModel);
                const fontJsonSignature =
                    getCloudFontJsonStructureSignature(fontJson);

                if (
                    fontJson &&
                    modelSignature &&
                    fontJsonSignature &&
                    modelSignature === fontJsonSignature
                ) {
                    const canonicalFontJson = canonicalizeCloudExportFontJson(
                        cloneCloudFontJson(fontJson)
                    );
                    if (changeVersion !== null) {
                        cloudSaveSeedCache = {
                            currentFont,
                            changeVersion,
                            fontJson: canonicalFontJson
                        };
                    }
                    resolve(canonicalFontJson);
                    return;
                }
            }

            if (Date.now() - startedAt >= timeoutMs) {
                if (bestCandidate) {
                    resolve(bestCandidate);
                    return;
                }

                reject(
                    new Error(
                        'Cloud font model did not settle into a savable JSON snapshot'
                    )
                );
                return;
            }

            window.requestAnimationFrame(poll);
        };

        poll();
    });
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
    private _editingSubsetListener: (() => void) | null = null;
    private _isSyncingCatalog = false;
    private _activeAssetId: string | null = null;
    private _relayedAssetId: string | null = null;
    private _relayedConnectionStatus: CloudConnectionStatus = 'disconnected';
    private _relayedConnectionDetail: string | undefined;
    private _relayedPendingSyncCount = 0;
    private _relayedTransferActivity: CloudTransferActivity = 'idle';
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
    private _overviewHydrateInFlight: Promise<string[]> | null = null;
    private _overviewHydrateQueued: Array<{
        text?: string;
        glyphNames?: string[];
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
        const policy = this._getCloudAssetSizePolicy();
        const rawByteLength = this._assetEstimatedBytesByAssetId.get(assetId);
        if (
            !policy ||
            typeof rawByteLength !== 'number' ||
            !Number.isFinite(rawByteLength)
        ) {
            return null;
        }
        const byteLength = rawByteLength;

        return this._getAssetSizeWarningStateForByteLength(byteLength, policy);
    }

    async getCurrentSaveAsWarningState(): Promise<CloudSaveSizeWarningState | null> {
        const seedFontJson = canonicalizeCloudExportFontJson(
            await waitForCloudSaveSeedFontJson()
        );
        validateCloudExportForFontOpen(seedFontJson, 'save');

        const byteLength = new TextEncoder().encode(
            JSON.stringify(seedFontJson)
        ).length;
        const policy = await this._ensureCloudSizePolicy();
        if (!policy) {
            return null;
        }

        if (byteLength > policy.maxCloudAssetBytes) {
            return {
                visible: true,
                title: `Cloud save blocked: Font exceeds the current cloud size limit (${formatCloudByteCount(byteLength)} of ${formatCloudByteCount(policy.maxCloudAssetBytes)}). A larger compaction tier is required before saving to cloud.`,
                label: 'Too large',
                icon: 'sync_problem',
                tone: 'error',
                canSave: false
            };
        }

        if (byteLength >= policy.warningCloudAssetBytes) {
            return {
                visible: true,
                title: `Cloud save warning: Font is near the current cloud size limit (${formatCloudByteCount(byteLength)} of ${formatCloudByteCount(policy.maxCloudAssetBytes)}). Saving may still work now, but cloud editing can stop working if the font grows further.`,
                label: 'Near limit',
                icon: 'warning',
                tone: 'warning',
                canSave: true
            };
        }

        return null;
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
        const role = this.getCurrentAssetRole();
        if (role === 'viewer') {
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
        roomToken: string | null;
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
        };
        const encodedState = bridge.encodeBridgeState?.();
        if (!encodedState) {
            return;
        }

        this._setAssetEstimatedBytes(this._activeAssetId, encodedState.length);
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

    private _warnBeforeNearLimitCloudSave(byteLength: number): void {
        const policy = this._getCloudAssetSizePolicy();
        if (!policy || byteLength < policy.warningCloudAssetBytes) {
            return;
        }
        if (byteLength > policy.maxCloudAssetBytes) {
            return;
        }

        const proceed = window.confirm(
            `This font is near the current cloud size limit (${formatCloudByteCount(byteLength)} of ${formatCloudByteCount(policy.maxCloudAssetBytes)}). Cloud editing may stop working if it grows further. Continue saving to cloud?`
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
        const glyphCount = listGlyphRecords(fontJson).length;
        const gate = await this.canAddGlyphs(0);
        if (
            this._eligibility?.maxGlyphsPerFont != null &&
            glyphCount > this._eligibility.maxGlyphsPerFont
        ) {
            throw new Error(
                `Cloud seed blocked: font has ${glyphCount} glyphs but this account allows ${this._eligibility.maxGlyphsPerFont}.`
            );
        }
        void gate;
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
        return evaluateCollabSubmit(requests, {
            maxShardBytes: max,
            maxPacketBytes: max
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
        await this.saveAs(name);
        return true;
    }

    async handleOpenPath(path: string): Promise<boolean> {
        if (!path.startsWith('cloud://')) {
            return false;
        }

        const assetId = path.slice('cloud://'.length).replace(/^\/+/, '');
        if (!assetId) {
            throw new Error('Missing cloud asset id');
        }

        await this.openAsset(assetId);
        return true;
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

    async hydrateOverviewGlyphs(seedNames: string[]): Promise<string[]> {
        return this.ensureSparseHydration({ glyphNames: seedNames });
    }

    async ensureSparseHydration(input: {
        text?: string;
        glyphNames?: string[];
    }): Promise<string[]> {
        this._overviewHydrateQueued.push({
            text: input.text,
            glyphNames: input.glyphNames
        });
        if (this._overviewHydrateInFlight) {
            return this._overviewHydrateInFlight;
        }
        const hydrate = (async () => {
            const loaded: string[] = [];
            while (this._overviewHydrateQueued.length) {
                const batch = this._overviewHydrateQueued.splice(0);
                const glyphNames = [
                    ...new Set(batch.flatMap((entry) => entry.glyphNames || []))
                ];
                const text = batch.map((entry) => entry.text || '').join('');
                loaded.push(
                    ...(await this._hydrateOverviewGlyphs({ text, glyphNames }))
                );
            }
            return [...new Set(loaded)];
        })();
        this._overviewHydrateInFlight = hydrate;
        try {
            return await hydrate;
        } finally {
            if (this._overviewHydrateInFlight === hydrate) {
                this._overviewHydrateInFlight = null;
            }
        }
    }

    private async _hydrateOverviewGlyphs(input: {
        text?: string;
        glyphNames?: string[];
    }): Promise<string[]> {
        const assetId = this.activeAssetId;
        const bridge = window.patchSyncEngine;
        if (!assetId || !bridge) {
            return [];
        }
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
        bridge.syncCompleteFontDepsFromLoadedGlyphs?.(fontJson);
        const catalog = Object.values(owned.glyphCatalog).filter(
            (entry) => entry.glyphId && entry.deleted !== true && entry.name
        );
        const catalogEntries = catalog.map((entry) => ({
            glyphId: entry.glyphId,
            name: entry.name
        }));
        const catalogIds = liveCatalogGlyphIds(owned.glyphCatalog);
        const idToName = new Map(
            catalog.map((entry) => [entry.glyphId, entry.name])
        );
        const previousWorkingIds = readWorkingGlyphIds(
            bridge.depsDoc.getMap('deps')
        );
        const { token, roomUrl } = await this._fetchRoomToken(assetId);
        const hydrator = new CloudAdapter({
            assetId,
            websiteBaseUrl: this._websiteBaseUrl
        });
        const loadedNames: string[] = [];
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
                    glyphRevision: (glyphId) => {
                        const tokens = bridge.listGlyphRevisionTokens?.() ?? [];
                        return tokens.find((token) => token.glyphId === glyphId)
                            ?.revision;
                    },
                    persistWorkingIds: (workingIds) => {
                        bridge.replaceSparseWorkingGlyphIds?.(workingIds);
                    },
                    afterFetchedGlyphs: (glyphIds) => {
                        const nextJson =
                            getCloudFontJsonFromBridge(bridge) ||
                            this._currentFontJson() ||
                            fontJson;
                        const passNames: string[] = [];
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
                                passNames.push(name);
                                loadedNames.push(name);
                            }
                        }
                        if (
                            !bridge.syncCompleteFontDepsFromLoadedGlyphs?.(
                                nextJson
                            )
                        ) {
                            bridge.syncFontDepsFromFontJson?.(
                                nextJson,
                                passNames
                            );
                        }
                    }
                },
                catalogIds,
                seedIds,
                layoutIds,
                catalog: catalogEntries,
                requireFetchedGlyphs: true,
                fetchGlyphs: (documentIds) =>
                    hydrator.hydrateDocumentSet(token, roomUrl, documentIds)
            });
            const previousWorking = new Set(previousWorkingIds);
            const changedNames = [
                ...new Set([
                    ...loadedNames,
                    ...result.workingIds
                        .filter((id) => !previousWorking.has(id))
                        .map((id) => idToName.get(id))
                        .filter((name): name is string => Boolean(name))
                ])
            ];
            if (!changedNames.length) {
                window.dispatchEvent(new CustomEvent('fontModelSync'));
                return result.workingIds
                    .map((id) => idToName.get(id))
                    .filter((name): name is string => Boolean(name));
            }
            window.dispatchEvent(new CustomEvent('fontModelSync'));
            window.dispatchEvent(
                new CustomEvent('glyphChanged', {
                    detail: {
                        glyphNames: changedNames,
                        forceImmediateRefresh: true
                    }
                })
            );
            return changedNames;
        } finally {
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
        if (this._isSyncingCatalog) {
            return;
        }
        this._isSyncingCatalog = true;
        try {
            if (catalogDirty) {
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
                const owned =
                    catalogGlyphs.length === 1
                        ? patchCloudOwnedGlyph(fontJson, catalogGlyphs[0])
                        : applyCloudOwnedData(fontJson);
                window.patchSyncEngine?.syncCloudOwnedProjection?.(owned);
            }
            if (depsGlyphs.size > 0) {
                window.patchSyncEngine?.syncFontDepsFromFontJson?.(fontJson, [
                    ...depsGlyphs
                ]);
            }
            void this._refreshAssetLimitsAfterCatalogChange();
        } finally {
            this._isSyncingCatalog = false;
        }
    };

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
        this._enqueueGlyphCatchUp(glyphIds);
        const fontJson = this._currentFontJson();
        const bridge = this._activeAssetSizeBridge;
        if (!fontJson || !bridge) {
            return;
        }
        const loadedNames = listGlyphRecords(fontJson)
            .filter((glyph) => glyphIds.includes(String(glyph.id || '')))
            .map((glyph) => String(glyph.name || ''))
            .filter(Boolean);
        if (loadedNames.length) {
            bridge.syncFontDepsFromFontJson?.(fontJson, loadedNames);
        }
    };

    private _catchUpFromCoreRevisionMap(): void {
        this._enqueueGlyphCatchUp();
    }

    /**
     * HTTP catch-up is for glyphs the live WebSocket subset does not cover.
     * Never walk the full core revision map: that is the whole catalog and
     * will freeze open while every glyph shard is fetched.
     */
    private _editingSubsetGlyphIdsForCatchUp(
        bridge: PatchSyncEngine
    ): string[] {
        const names =
            window.fontManager?.getConstrainedEditingSubsetGlyphs?.() ?? [
                ...(window.fontManager?.getEditingSubsetSnapshot?.() ?? []),
                ...(window.fontManager?.getLiveVisibleGlyphNames?.() ?? [])
            ];
        return liveGlyphDocumentIdsFromSubset(bridge, names)
            .filter((documentId) => documentId.startsWith('glyph:'))
            .map((documentId) => documentId.slice('glyph:'.length));
    }

    private _enqueueGlyphCatchUp(glyphIds?: string[]): void {
        const bridge = this._activeAssetSizeBridge;
        if (!this._liveSession || !bridge) {
            return;
        }
        const tokens = bridge.listGlyphRevisionTokens?.() ?? [];
        const subsetIds = this._editingSubsetGlyphIdsForCatchUp(bridge);
        const requestedIds = glyphIds?.length
            ? glyphIds.length > 64
                ? glyphIds.filter((glyphId) => subsetIds.includes(glyphId))
                : glyphIds
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
            throw new Error(
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

        const urlSparse = readUrlState().sparse === true;
        const openPromise = this._openAssetInternal(assetId, {
            awaitLiveBridge: true,
            sparseHydration: this._pendingSparseHydration || urlSparse
        });
        this._pendingSparseHydration = false;
        this._pendingOpenAsset = {
            assetId,
            promise: openPromise
        };

        try {
            await openPromise;
        } finally {
            if (this._pendingOpenAsset?.promise === openPromise) {
                this._pendingOpenAsset = null;
            }
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
            await this._migrateAssetToProtocol4(assetId);
            ({ token, roomUrl } = await this._fetchRoomToken(assetId));
        }
        const wsUrl = normalizeCloudRoomWebSocketUrl(
            roomUrl,
            this._websiteBaseUrl
        );

        const connectAndWaitForSync = async (
            bridgeToConnect: PatchSyncEngine,
            nextToken: string,
            nextWsUrl: string,
            options?: {
                bootstrapMode?: 'required' | 'skip';
                checkpointLogId?: number | null;
                suppressSyncComplete?: boolean;
                reportConnectionStatus?: boolean;
                awaitConnected?: boolean;
            }
        ): Promise<CloudAdapter> => {
            let resolveConnected: (() => void) | null = null;
            let rejectConnected: ((err: Error) => void) | null = null;
            const shouldAwaitConnected = options?.awaitConnected !== false;
            const connectedPromise = shouldAwaitConnected
                ? new Promise<void>((res, rej) => {
                      resolveConnected = res;
                      rejectConnected = rej;
                  })
                : null;

            const adapter = new CloudAdapter({
                assetId,
                websiteBaseUrl: this._websiteBaseUrl,
                documentId: FONT_CORE_DOCUMENT_ID,
                suppressSyncComplete: options?.suppressSyncComplete,
                onConnectionStatus: (
                    status: CloudConnectionStatus,
                    detail?: string
                ) => {
                    console.log(
                        `[${assetId}] ${status}${detail ? ` (${detail})` : ''}`
                    );
                    if (options?.reportConnectionStatus !== false) {
                        this._updateConnectionStatus(assetId, status, detail);
                    }
                    if (status === 'connected') {
                        resolveConnected?.();
                    }
                    if (status === 'error') {
                        rejectConnected?.(
                            new Error(detail ?? 'cloud connection error')
                        );
                    }
                },
                onPendingSyncCountChange: (count: number) => {
                    this._updatePendingSyncCount(assetId, count);
                },
                onTransferActivityChange: (activity) => {
                    this._updateTransferActivity(assetId, activity);
                }
            });

            try {
                await adapter.connectDirect(
                    bridgeToConnect,
                    nextToken,
                    nextWsUrl,
                    {
                        bootstrapMode: options?.bootstrapMode ?? 'required',
                        checkpointLogId: options?.checkpointLogId ?? null
                    }
                );

                if (connectedPromise) {
                    const timeout = new Promise<never>((_, rej) =>
                        setTimeout(
                            () => rej(new Error('cloud sync timed out')),
                            estimateCloudTransferTimeoutMs()
                        )
                    );
                    await Promise.race([connectedPromise, timeout]);
                }

                return adapter;
            } catch (error) {
                adapter.disconnect();
                throw error;
            }
        };

        const hydrator = new CloudAdapter({
            assetId,
            websiteBaseUrl: this._websiteBaseUrl
        });
        let hydratedShards: EncodedShard[] | null = null;
        let hydratedFontJson: Record<string, unknown> | null = null;
        try {
            const coreAndDeps = await this._hydrateCoreDepsConsistent(
                hydrator,
                token,
                roomUrl,
                assetId
            );
            const coreBytes = coreAndDeps.get(FONT_CORE_DOCUMENT_ID);
            if (coreBytes?.byteLength) {
                const documentSet = new CloudDocumentSet();
                documentSet.applyRemoteUpdate(FONT_CORE_DOCUMENT_ID, coreBytes);
                const depsBytes = coreAndDeps.get(FONT_DEPS_DOCUMENT_ID);
                if (depsBytes?.byteLength) {
                    documentSet.applyRemoteUpdate(
                        FONT_DEPS_DOCUMENT_ID,
                        depsBytes
                    );
                }
                const coreJson = documentSet.assembleFontJson();
                const catalogIds = glyphIdsFromCoreJson(coreJson);
                // Default open hydrates every live catalog glyph. Sparse
                // residency (`?sparse=true` or the open-dialog checkbox)
                // hydrates the `?text=` closure, or nothing if text is empty.
                let glyphBytes = new Map<string, Uint8Array>();
                if (!options?.sparseHydration) {
                    glyphBytes = (
                        await hydrateSparseGlyphsToFixedPoint({
                            documentSet,
                            catalogIds,
                            seedIds: catalogIds,
                            layoutIds: [],
                            catalog: catalogEntriesFromCoreJson(coreJson),
                            fetchGlyphs: (documentIds) =>
                                hydrator.hydrateDocumentSet(
                                    token,
                                    roomUrl,
                                    documentIds
                                )
                        })
                    ).glyphBytes;
                } else {
                    const { seedIds, layoutIds } = resolveHydrationSeeds({
                        fontJson: coreJson,
                        text: readUrlState().text || ''
                    });
                    if (seedIds.length) {
                        glyphBytes = (
                            await hydrateSparseGlyphsToFixedPoint({
                                documentSet,
                                catalogIds,
                                seedIds,
                                layoutIds,
                                previousWorkingIds: [],
                                catalog: catalogEntriesFromCoreJson(coreJson),
                                fetchGlyphs: (documentIds) =>
                                    hydrator.hydrateDocumentSet(
                                        token,
                                        roomUrl,
                                        documentIds
                                    )
                            })
                        ).glyphBytes;
                    }
                }
                hydratedFontJson = documentSet.assembleFontJson();
                const depsOut = documentSet.encodeDocument(
                    FONT_DEPS_DOCUMENT_ID
                );
                hydratedShards = [
                    {
                        documentId: FONT_CORE_DOCUMENT_ID,
                        bytes: coreBytes
                    },
                    ...(depsOut.byteLength
                        ? [
                              {
                                  documentId: FONT_DEPS_DOCUMENT_ID,
                                  bytes: depsOut
                              }
                          ]
                        : []),
                    ...[...glyphBytes.entries()].map(([documentId, bytes]) => ({
                        documentId,
                        bytes
                    }))
                ];
                documentSet.destroy();
            }
        } catch (error) {
            if (options?.sparseHydration) {
                throw error instanceof Error ? error : new Error(String(error));
            }
            console.warn(
                '[CloudPlugin] Shard hydrate failed; falling back to room bootstrap:',
                error
            );
        } finally {
            hydrator.disconnect();
        }

        if (hydratedShards?.length && hydratedFontJson) {
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
            ).__pendingCloudBridgeBootstrapDocuments = hydratedShards;
            (
                window as Window & {
                    __skipCloudBridgeRebindMerge?: boolean;
                }
            ).__skipCloudBridgeRebindMerge = true;

            this._activeAssetId = assetId;
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
                            bootstrapMode: 'skip'
                        });
                        const readyJson =
                            this._currentFontJson() ||
                            getCloudFontJsonFromBridge(liveBridge);
                        if (readyJson) {
                            liveBridge.syncCompleteFontDepsFromLoadedGlyphs?.(
                                readyJson
                            );
                        }
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

        // Temporary bridge receives the initial CRDT state from the room.
        const tempBridge = new PatchSyncEngine(`cloud-bootstrap-${assetId}`);
        const bootstrapAdapter = await connectAndWaitForSync(
            tempBridge,
            token,
            wsUrl,
            {
                bootstrapMode: 'required',
                suppressSyncComplete: true,
                reportConnectionStatus: false,
                awaitConnected: false
            }
        );

        // Extract babelfont JSON from the synced Yjs document.
        const fontJson = await waitForCloudFontJson(tempBridge);
        if (!fontJson) {
            bootstrapAdapter.disconnect();
            throw new Error(`Cloud asset ${assetId} has no font data`);
        }

        try {
            validateCloudExportForFontOpen(fontJson);
        } catch (error) {
            bootstrapAdapter.disconnect();
            throw error;
        }

        const babelfontJson = JSON.stringify(fontJson);
        const bridgeState = tempBridge.getFullState();
        const bootstrapChangeLog = tempBridge.getChangeLog();
        const bootstrapCheckpointLogId = bootstrapAdapter.checkpointLogId;
        bootstrapAdapter.disconnect();

        this._activeAssetId = assetId;

        (
            window as Window & {
                __pendingCloudBridgeBootstrapState?: Uint8Array;
                __pendingCloudBridgeBootstrapChangeLog?: ReturnType<
                    PatchSyncEngine['getChangeLog']
                >;
                __skipCloudBridgeRebindMerge?: boolean;
            }
        ).__pendingCloudBridgeBootstrapState = bridgeState;
        (
            window as Window & {
                __pendingCloudBridgeBootstrapState?: Uint8Array;
                __pendingCloudBridgeBootstrapChangeLog?: ReturnType<
                    PatchSyncEngine['getChangeLog']
                >;
                __skipCloudBridgeRebindMerge?: boolean;
            }
        ).__pendingCloudBridgeBootstrapChangeLog = bootstrapChangeLog;
        (
            window as Window & {
                __pendingCloudBridgeBootstrapState?: Uint8Array;
                __pendingCloudBridgeBootstrapChangeLog?: ReturnType<
                    PatchSyncEngine['getChangeLog']
                >;
                __skipCloudBridgeRebindMerge?: boolean;
            }
        ).__skipCloudBridgeRebindMerge = true;

        const bridgeReadyPromise = new Promise<void>((resolve, reject) => {
            const timeoutId = window.setTimeout(() => {
                window.removeEventListener('fontModelReady', onFontModelReady);
                reject(new Error('cloud bridge bootstrap timed out'));
            }, 30_000);

            const onFontModelReady = async () => {
                window.clearTimeout(timeoutId);
                window.removeEventListener('fontModelReady', onFontModelReady);

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
                        checkpointLogId: bootstrapCheckpointLogId
                    });
                    const readyJson =
                        this._currentFontJson() ||
                        getCloudFontJsonFromBridge(liveBridge);
                    if (readyJson) {
                        liveBridge.syncCompleteFontDepsFromLoadedGlyphs?.(
                            readyJson
                        );
                    }
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

        // Dispatch fontLoaded — triggers the normal pipeline.
        // After fontModelReady, the adapter's handler will rebind to the real bridge.
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
                this._handleBackgroundBridgeBootstrapFailure(assetId, error);
            });
            return;
        }

        await bridgeReadyPromise;
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
        const seedFontJson = canonicalizeCloudExportFontJson(
            await waitForCloudSaveSeedFontJson()
        );
        validateCloudExportForFontOpen(seedFontJson, 'save');
        const estimatedGlyphCount = listGlyphRecords(seedFontJson).length;
        const estimatedSaveBytes = new TextEncoder().encode(
            JSON.stringify(seedFontJson)
        ).length;
        const sizePolicy = await this._ensureCloudSizePolicy();
        if (sizePolicy && estimatedSaveBytes > sizePolicy.maxCloudAssetBytes) {
            throw new Error(
                `Cloud save blocked: font is ${formatCloudByteCount(estimatedSaveBytes)} but the current cloud tier only supports up to ${formatCloudByteCount(sizePolicy.maxCloudAssetBytes)}.`
            );
        }
        this._warnBeforeNearLimitCloudSave(estimatedSaveBytes);

        const resp = await fetch(`${this._websiteBaseUrl}/api/cloud/assets`, {
            method: 'POST',
            credentials: 'include',
            headers: getCloudRequestHeaders({
                'Content-Type': 'application/json'
            }),
            body: JSON.stringify({
                name,
                estimatedSeedBytes: estimatedSaveBytes,
                estimatedGlyphCount
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
        const liveBridge = await waitForCloudSaveBridge();
        assertCloudBridgeStateCanBeSaved(liveBridge);
        const shards = liveBridge.encodeDocumentSet?.() ?? [];
        if (!shards.length) {
            throw new Error('No live document set to seed to cloud');
        }
        const seeder = new CloudAdapter({
            assetId,
            websiteBaseUrl: this._websiteBaseUrl
        });
        let seededCheckpointLogId: number | null = null;
        try {
            seededCheckpointLogId = await seeder.seedDocumentSet(
                token,
                roomUrl,
                shards,
                estimatedGlyphCount
            );
        } finally {
            seeder.disconnect();
        }

        this._disconnectCurrent();

        try {
            await this._attachLiveSession({
                assetId,
                token,
                roomUrl,
                bridge: liveBridge,
                bootstrapMode: 'skip',
                ...(seededCheckpointLogId !== null
                    ? { checkpointLogId: seededCheckpointLogId }
                    : {}),
                connectedTimeoutMs:
                    estimateCloudTransferTimeoutMs(estimatedSaveBytes)
            });
            await this._finalizePendingAsset(assetId);
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

        return assetId;
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

        const { token, roomUrl } = await this._fetchRoomToken(assetId);
        console.log(`Connecting to room: ${assetId}`);
        await this._attachLiveSession({
            assetId,
            token,
            roomUrl,
            bridge,
            bootstrapMode: 'required'
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
        return this._cloudAdapter?.status ?? 'disconnected';
    }

    get activeAssetId(): string | null {
        if (window.windowRole?.isLinkedWindow()) {
            return this._relayedAssetId;
        }
        return this._activeAssetId;
    }

    // ── Private helpers ──────────────────────────────────────────

    private _disconnectCurrent(): void {
        this._stopTrackingActiveAssetSize();
        this._stopEditingSubsetSync();
        this._liveSession?.disconnect();
        this._liveSession = null;
        this._cloudAdapter?.disconnect();
        this._cloudAdapter = null;
        if (this._activeAssetId) {
            this._updatePendingSyncCount(this._activeAssetId, 0);
            this._updateConnectionStatus(this._activeAssetId, 'disconnected');
        }
        this._activeAssetId = null;
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
    }): Promise<void> {
        const session = new CloudLiveSession({
            assetId: options.assetId,
            websiteBaseUrl: this._websiteBaseUrl,
            token: options.token,
            roomUrl: options.roomUrl,
            bridge: options.bridge,
            bootstrapMode: options.bootstrapMode ?? 'skip',
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
            }
        });
        const glyphDocumentIds = liveGlyphDocumentIdsFromSubset(
            options.bridge,
            window.fontManager?.getConstrainedEditingSubsetGlyphs?.() ??
                window.fontManager?.getEditingSubsetSnapshot?.() ??
                []
        );
        try {
            await session.syncLiveDocumentIds(glyphDocumentIds);
        } catch (error) {
            session.disconnect();
            throw error;
        }
        this._liveSession = session;
        this._cloudAdapter = session.coreAdapter;
        this._startTrackingActiveAssetSize(options.assetId, options.bridge);
        this._startEditingSubsetSync(options.bridge);
        this._editingSubsetListener?.();
        this._catchUpFromCoreRevisionMap();
    }

    private _startEditingSubsetSync(bridge: PatchSyncEngine): void {
        this._stopEditingSubsetSync();
        this._editingSubsetListener = () => {
            if (!this._liveSession) {
                return;
            }
            const glyphDocumentIds = liveGlyphDocumentIdsFromSubset(
                bridge,
                window.fontManager?.getConstrainedEditingSubsetGlyphs?.() ??
                    window.fontManager?.getEditingSubsetSnapshot?.() ??
                    []
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
        this._editingSubsetListener();
    }

    private _stopEditingSubsetSync(): void {
        if (this._editingSubsetListener) {
            window.removeEventListener(
                'editingSubsetChanged',
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
        assetId: string
    ): Promise<Map<string, Uint8Array>> {
        const published = await this._fetchPublishedManifestForAsset(assetId);
        if (!published) {
            return hydrator.hydrateDocumentSet(token, roomUrl, [
                FONT_CORE_DOCUMENT_ID,
                FONT_DEPS_DOCUMENT_ID
            ]);
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
                    [FONT_CORE_DOCUMENT_ID, FONT_DEPS_DOCUMENT_ID]
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
        if (!resp.ok) {
            return null;
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

    private async _migrateAssetToProtocol4(assetId: string): Promise<void> {
        const migrateUrl = `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(assetId)}/migrate`;
        const migrateResp = await fetch(migrateUrl, {
            method: 'POST',
            cache: 'no-store',
            credentials: 'include',
            headers: getCloudRequestHeaders({
                'Content-Type': 'application/json'
            })
        });
        if (!migrateResp.ok && migrateResp.status !== 409) {
            const body = await migrateResp.text().catch(() => '');
            throw new Error(
                `schema migration failed: ${migrateResp.status} ${body}`
            );
        }
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
                }
            } else {
                const legacyUrl = `${roomUrl.replace(/\/$/, '')}/state`;
                const legacy = await fetch(legacyUrl, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (legacy.ok) {
                    documentSet = documentSetFromWholeFontUpdate(
                        new Uint8Array(await legacy.arrayBuffer())
                    );
                }
            }
            if (!documentSet) {
                throw new Error(
                    'schema migration found no checkpoint to reseed'
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
                coverage.liveGlyphIds.length
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
                    coverage
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
            needsMigration: data.needsMigration === true
        };
    }

    private async _finalizePendingAsset(assetId: string): Promise<void> {
        const liveBridge = window.patchSyncEngine;
        const shards = liveBridge?.encodeDocumentSet?.() ?? [];
        const core = shards.find(
            (shard) => shard.documentId === FONT_CORE_DOCUMENT_ID
        );
        const deps = shards.find(
            (shard) => shard.documentId === FONT_DEPS_DOCUMENT_ID
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
                glyphCount: listGlyphRecords(this._currentFontJson() || {})
                    .length,
                coreRevision: core
                    ? await hashShardBytes(core.bytes)
                    : 'bootstrap',
                depsRevision: deps
                    ? await hashShardBytes(deps.bytes)
                    : 'bootstrap',
                shardIds: shards.map((shard) => shard.documentId)
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
