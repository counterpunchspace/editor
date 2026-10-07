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
import { cloudPluginOpenMethods } from './cloud-plugin-open';
import { cloudPluginSaveAsMethods } from './cloud-plugin-save-as';
import { cloudPluginLiveMethods } from './cloud-plugin-live';
import { cloudPluginSharingMethods } from './cloud-plugin-sharing';
import { cloudPluginMeasureMethods } from './cloud-plugin-measure';
import { cloudPluginCatchUpMethods } from './cloud-plugin-catch-up';
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
    tombstoneCloudOwnedGlyphs,
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
    readFontDepsIndex,
    resolveHydrationSeeds,
    writeCompleteFontDepsIfLoaded
} from '../cloud-font-deps';
import {
    CloudDocumentSet,
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID,
    glyphDocumentId,
    glyphIdsFromCatalogEntries,
    glyphIdsFromRevisionEntries,
    hydrateSparseGlyphsToFixedPoint,
    type EncodedShard
} from '../cloud-document-set';
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
import { getCloudRequestHeaders } from '../../cloud-website-api';
import { deleteCloudAssetUntilComplete } from '../../cloud-delete-asset';
import './cloud-plugin-open';
import './cloud-plugin-save-as';
import './cloud-plugin-live';

import {
    deletedGlyphIdsFromCommittedEntries,
    catalogGlyphNameFromCommittedEntry,
    depsGlyphNamesFromCommittedEntries,
    pathFromCommittedEntry,
    committedChangeAffectsResidentClosure,
    decodeBase64UrlJson,
    extractRoleFromRoomToken,
    normalizeCloudComponentTransform,
    formatCloudDebugTimestamp,
    formatCloudByteCount,
    describeCloudStoredPiece,
    worstCloudPieceSizeReport,
    cloudPieceSizeWarningState,
    glyphNameForCloudDocument,
    escapeCloudTooltipText,
    formatCloudStatusTooltipHtml,
    canonicalizeCloudExportFontJson,
    validateCloudExportForFontOpen,
    glyphIdsFromCoreJson,
    catalogEntriesFromCoreJson,
    glyphDocumentIdsFromCoreJson,
    getCloudFontJsonFromBridge,
    assertCloudBridgeStateCanBeSaved,
    cloneCloudFontJson,
    estimateCloudTransferTimeoutMs,
    cloneEncodedShards,
    encodedShardByteLength,
    flushPendingCloudSaveMutations,
    waitForCloudSaveBridge,
    captureCloudSaveSeedState,
    recaptureCloudSaveSeedIfBridgeChanged,
    waitForCloudSaveReady,
    waitForCloudFontJson,
    EMPTY_CLOUD_LIVE_SHARD_STATS,
    type CloudAssetRole,
    type CloudLiveShardStats,
    type CloudSaveSeedCapture,
    type CloudAsset,
    type CloudEligibility,
    type CloudAssetLimits,
    type CloudAssetMember,
    type CloudAssetInvitation,
    type CloudOwnershipTransfer,
    type CloudShareState
} from './cloud-plugin-support';

export {
    deletedGlyphIdsFromCommittedEntries,
    catalogGlyphNameFromCommittedEntry,
    depsGlyphNamesFromCommittedEntries,
    pathFromCommittedEntry,
    committedChangeAffectsResidentClosure,
    decodeBase64UrlJson,
    extractRoleFromRoomToken,
    normalizeCloudComponentTransform,
    formatCloudDebugTimestamp,
    formatCloudByteCount,
    describeCloudStoredPiece,
    worstCloudPieceSizeReport,
    cloudPieceSizeWarningState,
    glyphNameForCloudDocument,
    escapeCloudTooltipText,
    formatCloudStatusTooltipHtml,
    canonicalizeCloudExportFontJson,
    validateCloudExportForFontOpen,
    glyphIdsFromCoreJson,
    catalogEntriesFromCoreJson,
    glyphDocumentIdsFromCoreJson,
    getCloudFontJsonFromBridge,
    assertCloudBridgeStateCanBeSaved,
    cloneCloudFontJson,
    estimateCloudTransferTimeoutMs,
    cloneEncodedShards,
    encodedShardByteLength,
    flushPendingCloudSaveMutations,
    waitForCloudSaveBridge,
    captureCloudSaveSeedState,
    recaptureCloudSaveSeedIfBridgeChanged,
    waitForCloudSaveReady,
    waitForCloudFontJson,
    EMPTY_CLOUD_LIVE_SHARD_STATS
} from './cloud-plugin-support';

export type {
    CloudAssetRole,
    CloudLiveShardStats,
    CloudSaveSeedCapture,
    CloudAsset,
    CloudEligibility,
    CloudAssetLimits,
    CloudAssetMember,
    CloudAssetInvitation,
    CloudOwnershipTransfer,
    CloudShareState
} from './cloud-plugin-support';

const console = new Logger('CloudPlugin');
const CLOUD_PLUGIN_UI_ENABLED = true;
const CLOUD_ASSET_DELETED_MESSAGE = 'Cloud asset was deleted';
const CLOUD_ASSET_LOCALIZED_EVENT = 'cloudAssetLocalizedToMemory';

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

const GLYPH_ORPHAN_LIVE_LIST_LIMIT = 20000;

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
    private _openRetryCancel: (() => void) | null = null;
    private _openRetryInFlight = false;
    private _relayedAssetId: string | null = null;
    private _relayedConnectionStatus: CloudConnectionStatus = 'disconnected';
    private _relayedConnectionDetail: string | undefined;
    private _relayedPendingSyncCount = 0;
    private _relayedTransferActivity: CloudTransferActivity = 'idle';
    private _sparsePreviewOnly = false;
    private _eligibility: CloudEligibility | null = null;
    private _assetLimits: CloudAssetLimits | null = null;
    private _assetLimitsEpoch = 0;
    private _catalogGlyphCountTarget: { assetId: string } | null = null;
    private _catalogGlyphCountDrain: Promise<void> | null = null;
    private _glyphOrphanState: {
        assetId: string;
        known: Set<string>;
        reconciled: boolean;
        forbidden: boolean;
    } | null = null;
    private _documentSet: CloudDocumentSet | null = null;
    private _catalogListener: CommittedChangeListener | null = null;
    private _glyphCatchUpListener: CommittedChangeListener | null = null;
    private _residentClosureListener: CommittedChangeListener | null = null;
    private _catalogClosureListener: (() => void) | null = null;
    private _residentClosureTimer: number | null = null;
    private _residentClosureAttempt = 0;
    private _coreHydratedListener: (() => void) | null = null;
    private _seenGlyphRevisions = new Map<string, string>();
    private _glyphRevisionSnapshotReady = false;
    private _glyphCatchUpInFlight = new Set<string>();
    private _glyphCatchUpAgain = new Set<string>();
    private _glyphCatchUpAttempts = new Map<string, number>();
    private _glyphCatchUpRetryTimer: number | null = null;
    private _glyphCatchUpRetryIds = new Set<string>();
    private _glyphCatchUpForceBody = new Set<string>();
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
            return false;
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
        documentId: string,
        dependsOn?: string[]
    ): Promise<boolean> {
        if (!this._liveSession) {
            return false;
        }
        return this._liveSession.persistOutgoingUpdate(
            update,
            collaborationMessage,
            documentId,
            dependsOn
        );
    }

    async persistCloudMutationIntent(
        documentIds: string[],
        intentBytes?: Uint8Array | null
    ): Promise<boolean> {
        if (!this._liveSession) {
            return false;
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
            return { durable: false, reason: 'no-live-session' };
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
            if (this._residentClosureListener) {
                bridge.offCommittedChange?.(this._residentClosureListener);
            }
            if (this._coreHydratedListener) {
                this._activeAssetSizeBridge.offCoreHydrated?.(
                    this._coreHydratedListener
                );
            }
            this._seenGlyphRevisions.clear();
            this._glyphRevisionSnapshotReady = false;
        }
        this._activeAssetSizeBridge = null;
        this._activeAssetSizeListener = null;
        this._catalogListener = null;
        this._glyphCatchUpListener = null;
        this._residentClosureListener = null;
        if (this._catalogClosureListener) {
            window.removeEventListener(
                'cloud-catalog-resident-closure',
                this._catalogClosureListener
            );
            this._catalogClosureListener = null;
        }
        this._residentClosureAttempt = 0;
        if (this._residentClosureTimer !== null) {
            window.clearTimeout(this._residentClosureTimer);
            this._residentClosureTimer = null;
        }
        this._glyphCatchUpInFlight.clear();
        this._glyphCatchUpAgain.clear();
        this._glyphCatchUpAttempts.clear();
        this._glyphCatchUpRetryIds.clear();
        this._glyphCatchUpForceBody.clear();
        if (this._glyphCatchUpRetryTimer !== null) {
            window.clearTimeout(this._glyphCatchUpRetryTimer);
            this._glyphCatchUpRetryTimer = null;
        }
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
        this._residentClosureListener = (entries, context) => {
            if (context.origin !== 'remote') {
                return;
            }
            if (
                !committedChangeAffectsResidentClosure(
                    entries,
                    context.documentId
                )
            ) {
                return;
            }
            this._residentClosureAttempt = 0;
            this._scheduleResidentClosureHydration();
        };
        (
            bridge as PatchSyncEngine & {
                onCommittedChange?: (cb: CommittedChangeListener) => void;
            }
        ).onCommittedChange?.(this._residentClosureListener);
        this._coreHydratedListener = () => {
            if (bridge.hasSparseWorkingSet?.()) {
                return;
            }
            this._catchUpFromCoreRevisionMap();
        };
        bridge.onCoreHydrated?.(this._coreHydratedListener);
        this._catalogClosureListener = () => {
            this._residentClosureAttempt = 0;
            this._scheduleResidentClosureHydration();
        };
        window.addEventListener(
            'cloud-catalog-resident-closure',
            this._catalogClosureListener
        );
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
        const glyphCount = listGlyphRecords(fontJson).length;
        if (
            this._eligibility?.maxGlyphsPerFont != null &&
            glyphCount > this._eligibility.maxGlyphsPerFont
        ) {
            throw new Error(
                `Cloud seed blocked: font has ${glyphCount} glyphs but this account allows ${this._eligibility.maxGlyphsPerFont}.`
            );
        }
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
        const gate = await this.canAddGlyphs(0);
        if (!gate.allowed) {
            throw new Error(
                gate.reason || 'Cloud seed blocked: glyph quota exceeded.'
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
        return null;
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
            case 'delete': {
                if (target.isDir) {
                    return false;
                }
                const assetId = String(target.path || '')
                    .replace(/^cloud:\/\//, '')
                    .trim();
                return this.getCachedAssetRole(assetId) === 'owner';
            }
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
     * After a remote edge, feature, or catalog change, close the glyphs this
     * window already has. Seeds are the resident working set, so a new
     * composite, a new base, or a new GSUB alternate of those seeds is fetched.
     * Linked windows leave fetching to the main window.
     */
    private _scheduleResidentClosureHydration(): void {
        if (window.windowRole?.isLinkedWindow?.()) {
            return;
        }
        const bridge = window.patchSyncEngine;
        if (!bridge?.hasSparseWorkingSet?.()) {
            return;
        }
        if (this._residentClosureTimer !== null) {
            window.clearTimeout(this._residentClosureTimer);
        }
        const delay = Math.min(2000, 250 * 2 ** this._residentClosureAttempt);
        this._residentClosureTimer = window.setTimeout(() => {
            this._residentClosureTimer = null;
            void this._hydrateResidentClosure();
        }, delay);
    }

    private _residentWorkingGlyphNames(bridge: PatchSyncEngine): string[] {
        const fontJson = this._currentFontJson() || {};
        const catalog = Object.values(
            catalogFromCoreJson(fontJson)?.glyphCatalog || {}
        );
        const nameById = new Map(
            catalog.map((entry) => [entry.glyphId, entry.name])
        );
        const names = new Set<string>();
        for (const glyphId of bridge.listSparseWorkingGlyphIds?.() ?? []) {
            const name = nameById.get(glyphId);
            if (name) {
                names.add(name);
            }
        }
        for (const name of activeEditorGlyphNames()) {
            if (name) {
                names.add(name);
            }
        }
        return [...names];
    }

    private async _hydrateResidentClosure(): Promise<void> {
        if (window.windowRole?.isLinkedWindow?.()) {
            return;
        }
        const bridge = window.patchSyncEngine;
        if (!bridge?.hasSparseWorkingSet?.()) {
            return;
        }
        const glyphNames = this._residentWorkingGlyphNames(bridge);
        if (!glyphNames.length) {
            return;
        }
        try {
            await this.ensureSparseHydration({
                glyphNames,
                purpose: 'ui'
            });
            this._residentClosureAttempt = 0;
        } catch (error) {
            console.warn(
                'CloudPlugin: resident closure hydration failed',
                error
            );
            if (this._residentClosureAttempt >= 40) {
                return;
            }
            this._residentClosureAttempt += 1;
            this._scheduleResidentClosureHydration();
        }
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

    /** Linked windows mirror the main window's preview-only flag. */
    applyRelayedSparseResidency(residency: { previewOnly: boolean }): void {
        this._sparsePreviewOnly = residency.previewOnly === true;
    }

    async hydrateOverviewGlyphs(seedNames: string[]): Promise<string[]> {
        return this.ensureSparseHydration({ glyphNames: seedNames });
    }

    async ensureSparseHydration(input: {
        text?: string;
        glyphNames?: string[];
        purpose?: 'ui' | 'compile';
    }): Promise<string[]> {
        if (window.windowRole?.isLinkedWindow?.()) {
            const sync = window.windowSync;
            if (!sync?.requestHydration) {
                throw new Error(
                    'Linked window cannot hydrate glyphs without the main window'
                );
            }
            return sync.requestHydration(input);
        }
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
        bridge.refreshOwnedCatalogFromYDoc?.();
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
                const liveIds = bridge.listLiveGlyphDocumentIds?.() ?? [];
                window.windowSync?.broadcastSparseResidency?.({
                    sparse: bridge.hasSparseWorkingSet?.() === true,
                    workingGlyphIds: bridge.listSparseWorkingGlyphIds?.() ?? [],
                    residentGlyphIds: liveIds.map((documentId) =>
                        documentId.startsWith('glyph:')
                            ? documentId.slice('glyph:'.length)
                            : documentId
                    ),
                    previewOnly: this._sparsePreviewOnly
                });
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
        const epoch = ++this._assetLimitsEpoch;
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
            if (epoch === this._assetLimitsEpoch) {
                this._assetLimits = data;
            }
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
        entries,
        context
    ) => {
        if (context.origin === 'remote') {
            return;
        }
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
        const depsGlyphs = new Set(depsGlyphNamesFromCommittedEntries(entries));
        if (!catalogDirty && depsGlyphs.size === 0) {
            return;
        }
        const catalogGlyphs = [
            ...new Set(
                entries
                    .map(catalogGlyphNameFromCommittedEntry)
                    .filter((name): name is string => Boolean(name))
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
                    const owned = pending.deletedGlyphIds.length
                        ? tombstoneCloudOwnedGlyphs(
                              fontJson,
                              pending.deletedGlyphIds
                          )
                        : pending.catalogGlyphs.length !== 1
                          ? applyCloudOwnedData(fontJson)
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
    ) =>
        cloudPluginCatchUpMethods._syncGlyphCatchUpFromCommittedChange.call(
            this,
            entries,
            context
        );

    private _catchUpFromCoreRevisionMap(): void {
        cloudPluginCatchUpMethods._catchUpFromCoreRevisionMap.call(this);
    }

    private _editingSubsetGlyphIdsForCatchUp(
        bridge: PatchSyncEngine
    ): string[] {
        return cloudPluginCatchUpMethods._editingSubsetGlyphIdsForCatchUp.call(
            this,
            bridge
        );
    }

    private _staleGlyphIdsForCatchUp(bridge: PatchSyncEngine): string[] {
        return cloudPluginCatchUpMethods._staleGlyphIdsForCatchUp.call(
            this,
            bridge
        );
    }

    private _glyphIdEligibleForCatchUp(
        bridge: PatchSyncEngine,
        glyphId: string,
        subsetIds: string[]
    ): boolean {
        return cloudPluginCatchUpMethods._glyphIdEligibleForCatchUp.call(
            this,
            bridge,
            glyphId,
            subsetIds
        );
    }

    private _enqueueGlyphCatchUp(
        glyphIds?: string[],
        options?: { includeUnloaded?: boolean }
    ): void {
        cloudPluginCatchUpMethods._enqueueGlyphCatchUp.call(
            this,
            glyphIds,
            options
        );
    }

    private _scheduleGlyphCatchUpRetry(glyphIds: string[]): void {
        cloudPluginCatchUpMethods._scheduleGlyphCatchUpRetry.call(
            this,
            glyphIds
        );
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
        return cloudPluginSharingMethods._resolveShareAssetId.call(
            this,
            assetId
        );
    }

    async getShareState(assetId?: string): Promise<CloudShareState> {
        return cloudPluginSharingMethods.getShareState.call(this, assetId);
    }

    async inviteUser(
        email: string,
        role: 'editor' | 'viewer',
        assetId?: string
    ): Promise<{
        invitation: CloudAssetInvitation;
        inviteUrl?: string;
    }> {
        return cloudPluginSharingMethods.inviteUser.call(
            this,
            email,
            role,
            assetId
        );
    }

    async createOwnershipTransfer(
        email: string,
        previousOwnerRole: 'editor' | 'viewer' | 'remove',
        assetId?: string
    ): Promise<{
        ownershipTransfer: CloudOwnershipTransfer;
        transferUrl?: string;
    }> {
        return cloudPluginSharingMethods.createOwnershipTransfer.call(
            this,
            email,
            previousOwnerRole,
            assetId
        );
    }

    async cancelOwnershipTransfer(assetId?: string): Promise<void> {
        return cloudPluginSharingMethods.cancelOwnershipTransfer.call(
            this,
            assetId
        );
    }

    async revokeInvitation(
        invitationId: string,
        assetId?: string
    ): Promise<void> {
        return cloudPluginSharingMethods.revokeInvitation.call(
            this,
            invitationId,
            assetId
        );
    }

    async updateMemberRole(
        userId: string,
        role: 'editor' | 'viewer',
        assetId?: string
    ): Promise<void> {
        return cloudPluginSharingMethods.updateMemberRole.call(
            this,
            userId,
            role,
            assetId
        );
    }

    async removeMember(userId: string, assetId?: string): Promise<void> {
        return cloudPluginSharingMethods.removeMember.call(
            this,
            userId,
            assetId
        );
    }

    syncCatalogGlyphCount(): void {
        const assetId = this.getCurrentAssetIdForSharing();
        if (!assetId) {
            return;
        }
        this._postCatalogGlyphCount(assetId);
    }

    async deleteAsset(assetId?: string): Promise<void> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            throw new Error('Authentication required');
        }
        const resolvedAssetId = this._resolveShareAssetId(assetId);
        // A live session would keep reconnecting to rooms that are being
        // purged, and each reconnect can recreate an empty room.
        if (this.getCurrentAssetIdForSharing() === resolvedAssetId) {
            this.disconnectFromRoom();
        }
        await deleteCloudAssetUntilComplete({
            websiteBaseUrl: this._websiteBaseUrl,
            assetId: resolvedAssetId
        });
    }

    private _postCatalogGlyphCount(assetId: string): void {
        this._catalogGlyphCountTarget = { assetId };
        if (this._catalogGlyphCountDrain) {
            return;
        }
        this._catalogGlyphCountDrain = this._drainCatalogGlyphCount().finally(
            () => {
                this._catalogGlyphCountDrain = null;
                if (this._catalogGlyphCountTarget) {
                    this._postCatalogGlyphCount(
                        this._catalogGlyphCountTarget.assetId
                    );
                }
            }
        );
    }

    /**
     * Posts go out strictly one at a time and are never aborted: an aborted
     * fetch can still commit on the server, so a stale post must never be
     * able to land after a newer one. Each post waits until the room has
     * confirmed every local change (a new glyph's first write is what reserves
     * its quota), then reads the model's current count.
     */
    /**
     * Tells the website which glyph rooms became orphans (deleted locally) or
     * came back (undo), so the server can purge the room, R2 objects and rows
     * once the 24h undo window has passed. On first sync per asset it also
     * sends the full live list so orphans missed by a crash are reconciled.
     * Only owners and editors may do this; after a 403 we stop trying.
     */
    private async _syncGlyphOrphans(assetId: string): Promise<void> {
        let state = this._glyphOrphanState;
        if (!state || state.assetId !== assetId) {
            state = {
                assetId,
                known: new Set(),
                reconciled: false,
                forbidden: false
            };
            this._glyphOrphanState = state;
        }
        if (state.forbidden) {
            return;
        }
        const live = new Set(
            listGlyphRecords(this._currentFontJson() || {})
                .map((glyph) => String(glyph.id || ''))
                .filter(Boolean)
        );
        const body: { mark?: string[]; clear?: string[]; live?: string[] } = {};
        if (!state.reconciled) {
            if (live.size > GLYPH_ORPHAN_LIVE_LIST_LIMIT) {
                console.warn(
                    'Font too large to reconcile deleted glyphs; skipping'
                );
                state.reconciled = true;
            } else if (live.size > 0) {
                body.live = [...live];
            }
        } else {
            const removed = [...state.known].filter((id) => !live.has(id));
            const added = [...live].filter((id) => !state.known.has(id));
            if (removed.length) body.mark = removed;
            if (added.length) body.clear = added;
        }
        if (!body.live && !body.mark && !body.clear) {
            state.known = live;
            return;
        }
        try {
            const resp = await fetch(
                `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(assetId)}/glyph-orphans`,
                {
                    method: 'POST',
                    credentials: 'include',
                    headers: getCloudRequestHeaders({
                        'Content-Type': 'application/json'
                    }),
                    body: JSON.stringify(body)
                }
            );
            if (resp.status === 403 || resp.status === 404) {
                state.forbidden = true;
                return;
            }
            if (!resp.ok) {
                // Leave `known` untouched so the diff is retried next time.
                console.warn(`Glyph orphan sync failed (${resp.status})`);
                return;
            }
            if (body.live) {
                state.reconciled = true;
            }
            state.known = live;
        } catch (error) {
            console.warn('Glyph orphan sync failed:', error);
        }
    }

    private async _drainCatalogGlyphCount(): Promise<void> {
        while (this._catalogGlyphCountTarget) {
            const { assetId } = this._catalogGlyphCountTarget;
            this._catalogGlyphCountTarget = null;
            for (let wait = 0; wait < 120; wait += 1) {
                const durability = await this.waitForCloudGlyphDurability();
                if (durability.durable) {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
            await this._syncGlyphOrphans(assetId);
            let transportFailures = 0;
            for (let attempt = 0; attempt < 8; attempt += 1) {
                if (this._catalogGlyphCountTarget) {
                    break;
                }
                const glyphCount = this._liveGlyphCount();
                try {
                    const resp = await fetch(
                        `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(assetId)}/glyph-count`,
                        {
                            method: 'POST',
                            credentials: 'include',
                            headers: getCloudRequestHeaders({
                                'Content-Type': 'application/json'
                            }),
                            body: JSON.stringify({ glyphCount })
                        }
                    );
                    if (!resp.ok) {
                        const data = (await resp.json().catch(() => ({}))) as {
                            error?: string;
                        };
                        console.warn(
                            data.error ||
                                `Catalog glyph count update failed (${resp.status})`
                        );
                        break;
                    }
                    const data = (await resp.json().catch(() => ({}))) as {
                        glyphCount?: number;
                    };
                    if (Number(data.glyphCount) >= glyphCount) {
                        break;
                    }
                    // Reservation not visible yet; re-read the model and retry.
                } catch (error) {
                    transportFailures += 1;
                    if (transportFailures > 1) {
                        console.warn(
                            'Catalog glyph count update failed:',
                            error
                        );
                        break;
                    }
                }
                await new Promise((resolve) =>
                    setTimeout(resolve, Math.min(1000, 250 * (attempt + 1)))
                );
            }
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
        return cloudPluginOpenMethods.openAsset.call(this, assetId);
    }

    async saveAs(name: string): Promise<string> {
        return cloudPluginSaveAsMethods.saveAs.call(this, name);
    }

    async connectToRoom(assetId: string): Promise<void> {
        return cloudPluginLiveMethods.connectToRoom.call(this, assetId);
    }

    async connectToRoomWithToken(
        assetId: string,
        token: string,
        roomUrl: string
    ): Promise<void> {
        return cloudPluginLiveMethods.connectToRoomWithToken.call(
            this,
            assetId,
            token,
            roomUrl
        );
    }

    disconnectFromRoom(): void {
        cloudPluginLiveMethods.disconnectFromRoom.call(this);
    }

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
        return cloudPluginMeasureMethods.measureCloudSeedBatch.call(
            this,
            assetName,
            concurrency,
            options
        );
    }

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
        return cloudPluginMeasureMethods.measureCloudHydrateBatch.call(
            this,
            assetId,
            documentIds,
            concurrency,
            options
        );
    }

    private _disconnectCurrent(): void {
        this._assetLimitsEpoch += 1;
        this._assetLimits = null;
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
        _assetId: string,
        ioOptions?: CloudShardIoOptions
    ): Promise<Map<string, Uint8Array>> {
        // Live rooms are the sole content truth — no published-pair alignment.
        return hydrator.hydrateDocumentSet(
            token,
            roomUrl,
            [FONT_CORE_DOCUMENT_ID, FONT_DEPS_DOCUMENT_ID],
            ioOptions
        );
    }

    private async _fetchRoomToken(assetId: string): Promise<{
        token: string;
        roomUrl: string;
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
            generationId?: string;
        } = {};
        try {
            data = body ? JSON.parse(body) : {};
        } catch {
            data = {};
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
        const coreReceipt = receipts.find(
            (receipt) => receipt.shardId === FONT_CORE_DOCUMENT_ID
        );
        const depsReceipt = receipts.find(
            (receipt) => receipt.shardId === FONT_DEPS_DOCUMENT_ID
        );
        if (!coreReceipt || !depsReceipt) {
            throw new Error(
                'Cloud seed finalize requires core and deps write receipts'
            );
        }
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
                coreRevision: coreReceipt.checkpointSha256,
                depsRevision: depsReceipt.checkpointSha256,
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
        if (resp.status === 404 || resp.ok) {
            // One attempt. A partial purge finishes via resumeAbandonedCloudPurges.
            return;
        }
        const body = await resp.text().catch(() => '');
        throw new Error(`abort request failed: ${resp.status} ${body}`);
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
}

Object.assign(CloudPlugin.prototype, {
    _openAssetInternal: cloudPluginOpenMethods._openAssetInternal,
    _scheduleOpenRetry: cloudPluginOpenMethods._scheduleOpenRetry,
    _cancelOpenRetry: cloudPluginOpenMethods._cancelOpenRetry,
    _authFailureIsUnreachableBackend:
        cloudPluginOpenMethods._authFailureIsUnreachableBackend,
    _finalizeCurrentFontAsSavedCloudAsset:
        cloudPluginOpenMethods._finalizeCurrentFontAsSavedCloudAsset
});
