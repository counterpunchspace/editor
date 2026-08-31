/**
 * CloudPlugin — FilesystemPlugin wrapper for CloudAdapter.
 *
 * Phase 1: eligibility check, openAsset, saveAs (seed DO), getAssets.
 * Exposed as window.cloudPlugin; window.cloudDebug kept for dev testing.
 */

import {
    FilesystemPlugin,
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
    normalizeCloudRoomWebSocketUrl
} from '../../cloud-adapter';
import {
    PatchSyncEngine,
    type CommittedChangeListener
} from '../../patch-sync-engine';
import { Logger } from '../../logger';
import { resolveWebsiteURL } from '../../website-url';

const console = new Logger('CloudPlugin');
const CLOUD_PLUGIN_UI_ENABLED = false;
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

function getCloudFontJsonFromBridge(
    bridge: Pick<PatchSyncEngine, 'getFontJsonSnapshot'>
): Record<string, unknown> | null {
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
}

export interface CloudEligibility {
    cloudHostingEnabled: boolean;
    maxFontsOwned: number | null;
    snapshotRetentionDays: number | null;
    fontsOwnedCount: number;
    maxCloudAssetBytes?: number;
    warningCloudAssetBytes?: number;
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
    private _activeAssetId: string | null = null;
    private _relayedAssetId: string | null = null;
    private _relayedConnectionStatus: CloudConnectionStatus = 'disconnected';
    private _relayedConnectionDetail: string | undefined;
    private _relayedPendingSyncCount = 0;
    private _eligibility: CloudEligibility | null = null;
    private _pendingOpenAsset: {
        assetId: string;
        promise: Promise<void>;
    } | null = null;
    private _cloudSessionBootstrapEmail = 'local-dev@counterpunch.test';
    private _connectionStatusByAssetId = new Map<
        string,
        CloudConnectionStatus
    >();
    private _connectionDetailByAssetId = new Map<string, string>();
    private _pendingSyncCountByAssetId = new Map<string, number>();
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
                icon: 'sync_problem',
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

        if (this._activeAssetId === assetId && this._cloudAdapter) {
            return this._cloudAdapter.pendingSyncCount;
        }

        return this._pendingSyncCountByAssetId.get(assetId) ?? 0;
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
                ...(detail ? { detail } : {})
            });
        }

        window.dispatchEvent(
            new CustomEvent('cloudConnectionStatusChanged', {
                detail: {
                    assetId,
                    status,
                    detail,
                    pendingSyncCount: this.getAssetPendingSyncCount(assetId)
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
                ...(detail ? { detail } : {})
            });
        }

        window.dispatchEvent(
            new CustomEvent('cloudConnectionStatusChanged', {
                detail: {
                    assetId,
                    status,
                    detail,
                    pendingSyncCount: this.getAssetPendingSyncCount(assetId)
                }
            })
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
        }
        this._activeAssetSizeBridge = null;
        this._activeAssetSizeListener = null;
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
                    pendingSyncCount: this._relayedPendingSyncCount
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
            : never
    ): void {
        if (!window.windowRole?.isMainWindow()) {
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
        return true; // Cloud syncs continuously
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
        };
        if (!resp.ok) {
            throw new Error(data.error || 'Failed to remove member');
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

        const openPromise = this._openAssetInternal(assetId, {
            awaitLiveBridge: false
        });
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

        const { token, roomUrl } = await this._fetchRoomToken(assetId);
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
                    const liveTokenResponse =
                        await this._fetchRoomToken(assetId);
                    const liveWsUrl = normalizeCloudRoomWebSocketUrl(
                        liveTokenResponse.roomUrl,
                        this._websiteBaseUrl
                    );
                    this._cloudAdapter = await connectAndWaitForSync(
                        liveBridge,
                        liveTokenResponse.token,
                        liveWsUrl,
                        {
                            bootstrapMode: 'skip',
                            checkpointLogId: bootstrapCheckpointLogId
                        }
                    );
                    this._startTrackingActiveAssetSize(assetId, liveBridge);
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

        const seedFontJson = canonicalizeCloudExportFontJson(
            await waitForCloudSaveSeedFontJson()
        );
        validateCloudExportForFontOpen(seedFontJson, 'save');
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
                estimatedSeedBytes: estimatedSaveBytes
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
        const wsUrl = normalizeCloudRoomWebSocketUrl(
            roomUrl,
            this._websiteBaseUrl
        );

        this._disconnectCurrent();

        const connectAndWaitForSync = async (
            bridgeToConnect: PatchSyncEngine,
            options?: {
                bootstrapMode?: 'required' | 'skip';
                reportConnectionStatus?: boolean;
            }
        ): Promise<CloudAdapter> => {
            let resolveConnected!: () => void;
            let rejectConnected!: (err: Error) => void;
            const connectedPromise = new Promise<void>((res, rej) => {
                resolveConnected = res;
                rejectConnected = rej;
            });

            const adapter = new CloudAdapter({
                assetId,
                websiteBaseUrl: this._websiteBaseUrl,
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
                    if (status === 'connected') resolveConnected();
                    if (status === 'error') {
                        rejectConnected(
                            new Error(detail ?? 'cloud connection error')
                        );
                    }
                },
                onPendingSyncCountChange: (count: number) => {
                    this._updatePendingSyncCount(assetId, count);
                }
            });

            try {
                await adapter.connectDirect(bridgeToConnect, token, wsUrl, {
                    bootstrapMode: options?.bootstrapMode ?? 'required'
                });

                const timeout = new Promise<never>((_, rej) =>
                    setTimeout(
                        () => rej(new Error('cloud save timed out')),
                        estimateCloudTransferTimeoutMs(estimatedSaveBytes)
                    )
                );
                await Promise.race([connectedPromise, timeout]);

                return adapter;
            } catch (error) {
                adapter.disconnect();
                throw error;
            }
        };

        this._disconnectCurrent();
        const liveBridge = await waitForCloudSaveBridge();
        assertCloudBridgeStateCanBeSaved(liveBridge);

        try {
            this._cloudAdapter = await connectAndWaitForSync(liveBridge, {
                bootstrapMode: 'skip'
            });
            this._startTrackingActiveAssetSize(assetId, liveBridge);
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

        this._cloudAdapter = new CloudAdapter({
            assetId,
            websiteBaseUrl: this._websiteBaseUrl,
            onConnectionStatus: (
                status: CloudConnectionStatus,
                detail?: string
            ) => {
                console.log(
                    `[${assetId}] ${status}${detail ? ` (${detail})` : ''}`
                );
                this._updateConnectionStatus(assetId, status, detail);
            },
            onPendingSyncCountChange: (count: number) => {
                this._updatePendingSyncCount(assetId, count);
            }
        });

        console.log(`Connecting to room: ${assetId}`);
        await this._cloudAdapter.connect(bridge);
        this._startTrackingActiveAssetSize(assetId, bridge);
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

        this._cloudAdapter = new CloudAdapter({
            assetId,
            websiteBaseUrl: this._websiteBaseUrl,
            onConnectionStatus: (
                status: CloudConnectionStatus,
                detail?: string
            ) => {
                console.log(
                    `[${assetId}] ${status}${detail ? ` (${detail})` : ''}`
                );
                this._updateConnectionStatus(assetId, status, detail);
            },
            onPendingSyncCountChange: (count: number) => {
                this._updatePendingSyncCount(assetId, count);
            }
        });

        const wsUrl = normalizeCloudRoomWebSocketUrl(
            roomUrl,
            this._websiteBaseUrl
        );
        console.log(`Connecting directly to room: ${assetId} at ${wsUrl}`);
        await this._cloudAdapter.connectDirect(bridge, token, wsUrl);
        this._startTrackingActiveAssetSize(assetId, bridge);
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
        this._cloudAdapter?.disconnect();
        if (this._activeAssetId) {
            this._updatePendingSyncCount(this._activeAssetId, 0);
            this._updateConnectionStatus(this._activeAssetId, 'disconnected');
        }
        this._cloudAdapter = null;
        this._activeAssetId = null;
        if (window.windowRole?.isLinkedWindow()) {
            this._relayedAssetId = null;
            this._relayedConnectionStatus = 'disconnected';
            this._relayedConnectionDetail = undefined;
            this._relayedPendingSyncCount = 0;
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

    private async _fetchRoomToken(
        assetId: string
    ): Promise<{ token: string; roomUrl: string }> {
        const url = `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(assetId)}/room-token`;
        const resp = await fetch(url, {
            method: 'POST',
            cache: 'no-store',
            credentials: 'include',
            headers: getCloudRequestHeaders({
                'Content-Type': 'application/json'
            })
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            throw new Error(
                this._normalizeRoomTokenErrorMessage(
                    assetId,
                    `room-token request failed: ${resp.status} ${body}`
                )
            );
        }
        const data = (await resp.json()) as { token: string; roomUrl: string };
        if (!data.token || !data.roomUrl) {
            throw new Error('room-token response missing token or roomUrl');
        }
        this._cacheAssetRole(assetId, extractRoleFromRoomToken(data.token));
        return data;
    }

    private async _finalizePendingAsset(assetId: string): Promise<void> {
        const url = `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(assetId)}/finalize`;
        const resp = await fetch(url, {
            method: 'POST',
            cache: 'no-store',
            credentials: 'include',
            headers: getCloudRequestHeaders({
                'Content-Type': 'application/json'
            })
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            throw new Error(`finalize request failed: ${resp.status} ${body}`);
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
