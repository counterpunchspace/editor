/**
 * Shared helpers extracted from cloud-plugin.ts
 * (open pipeline, save-as, and live orchestration support).
 */
import { assertEncodableDocumentSet } from '../../cloud-document-encode-gate';
import {
    decodeBase64UrlJson,
    extractRoleFromRoomToken,
    type CloudAssetRole
} from '../../cloud-adapter-support';
import { getCloudRequestHeaders } from '../../cloud-website-api';
import type { PatchSyncEngine } from '../../patch-sync-engine';
import {
    getPathSegments,
    glyphRenamesForHistoryAction,
    historyReplayValue,
    type ChangeLogEntry
} from '../../change-log';
import {
    catalogFromCoreJson,
    catalogNeedsUpdate,
    liveCatalogGlyphIds,
    listGlyphRecords
} from '../cloud-glyph-catalog';
import { catalogEntriesForDepsParse, depsNeedUpdate } from '../cloud-font-deps';
import {
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID,
    glyphDocumentId,
    glyphIdFromDocumentId,
    type EncodedShard
} from '../cloud-document-set';
import {
    MAX_SHARD_BYTES,
    type ShardSizeGate,
    type ShardSizeReport
} from '../cloud-shard-limits';

export { decodeBase64UrlJson, extractRoleFromRoomToken, type CloudAssetRole };

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

/**
 * The change a committed entry made to the font. An undo packet carries the
 * undone history item's own entries, which keep the forward edit's op and
 * values: undoing a glyph add removes the glyph, undoing a delete brings it
 * back, and undoing a rename restores the old name. Readers that act on what
 * changed (the catalog) read the entry as it was applied. Redo replays the
 * forward edit, so it is read as it is.
 */
export function committedEntryAsApplied<T extends ChangeLogEntry>(entry: T): T {
    if (entry.historyAction !== 'undo') {
        return entry;
    }
    const op =
        entry.op === 'add'
            ? 'remove'
            : entry.op === 'remove'
              ? 'add'
              : entry.op;
    return {
        ...entry,
        op,
        oldValue: historyReplayValue(entry, 'redo'),
        newValue: historyReplayValue(entry, 'undo'),
        replayOldValue: entry.replayNewValue,
        replayNewValue: entry.replayOldValue,
        ...(entry.glyphRenames
            ? {
                  glyphRenames: glyphRenamesForHistoryAction(
                      entry.glyphRenames,
                      'undo'
                  )
              }
            : {})
    };
}

export function deletedGlyphIdsFromCommittedEntries(
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

export function catalogGlyphNameFromCommittedEntry(entry: {
    path?: string | Array<string | number>;
    newValue?: unknown;
}): string | null {
    const path = pathFromCommittedEntry(entry);
    if (
        !catalogNeedsUpdate(path) ||
        path[0] !== 'glyphs' ||
        path[1] === undefined ||
        path[1] === null ||
        path[1] === ''
    ) {
        return null;
    }
    // A rename commits glyphs.<oldName>.name after the model already uses
    // the new name. The catalog patch has to look the glyph up by that name.
    if (
        path.length >= 3 &&
        path[2] === 'name' &&
        typeof entry.newValue === 'string' &&
        entry.newValue
    ) {
        return entry.newValue;
    }
    return String(path[1]);
}

/**
 * Glyph names whose font-deps row should be rewritten for this commit.
 * A rename records the reference edit under the old name and the new name
 * on `glyphRenames` in the same glyph packet. Deps are keyed by the name
 * the model already uses.
 */
export function depsGlyphNamesFromCommittedEntries(
    entries: Array<{
        path?: string | Array<string | number>;
        glyphRenames?: Array<{ oldName?: string; newName?: string }>;
    }>
): string[] {
    const renamedTo = new Map<string, string>();
    for (const entry of entries) {
        for (const rename of entry.glyphRenames || []) {
            if (
                rename.oldName &&
                rename.newName &&
                rename.oldName !== rename.newName
            ) {
                renamedTo.set(rename.oldName, rename.newName);
            }
        }
    }
    const names = new Set<string>();
    for (const entry of entries) {
        const path = pathFromCommittedEntry(entry);
        if (depsNeedUpdate(path) && path[0] === 'glyphs' && path[1]) {
            const name = String(path[1]);
            names.add(renamedTo.get(name) || name);
        }
    }
    return [...names];
}

export function pathFromCommittedEntry(entry: {
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

const RESIDENT_CLOSURE_CORE_ROOTS = new Set([
    'features',
    'glyphs',
    'glyphOrder',
    'glyphCatalog'
]);

/** Remote edges, feature text, or a new catalog glyph can enlarge the resident closure. */
export function committedChangeAffectsResidentClosure(
    entries: Array<{ path?: string | Array<string | number> }>,
    documentId?: string
): boolean {
    if (documentId === FONT_DEPS_DOCUMENT_ID) {
        return true;
    }
    if (documentId && documentId !== FONT_CORE_DOCUMENT_ID) {
        return false;
    }
    return entries.some((entry) =>
        RESIDENT_CLOSURE_CORE_ROOTS.has(
            String(pathFromCommittedEntry(entry)[0] ?? '')
        )
    );
}

export async function createPendingCloudAsset(options: {
    websiteBaseUrl: string;
    name: string;
    estimatedSeedBytes: number;
    estimatedGlyphCount: number;
}): Promise<CloudAsset> {
    const resp = await fetch(`${options.websiteBaseUrl}/api/cloud/assets`, {
        method: 'POST',
        credentials: 'include',
        headers: getCloudRequestHeaders({
            'Content-Type': 'application/json'
        }),
        body: JSON.stringify({
            name: options.name,
            estimatedSeedBytes: options.estimatedSeedBytes,
            estimatedGlyphCount: options.estimatedGlyphCount
        })
    });

    if (!resp.ok) {
        const err = await resp.text().catch(() => '');
        if (resp.status === 429) {
            throw new Error(
                'Cloud save blocked: too many cloud fonts were created in a short time. Try again in a few minutes.'
            );
        }
        throw new Error(`Failed to create cloud asset: ${resp.status} ${err}`);
    }

    const { asset } = (await resp.json()) as { asset: CloudAsset };
    return asset;
}

export function normalizeCloudComponentTransform(
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

export function formatCloudDebugTimestamp(timestamp: number): string {
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

export function worstCloudPieceSizeReport(
    gate: ShardSizeGate
): ShardSizeReport | null {
    const pickLargest = (reports: ShardSizeReport[]): ShardSizeReport | null =>
        [...reports].sort((a, b) => b.byteLength - a.byteLength)[0] ?? null;
    return pickLargest(gate.blocking) ?? pickLargest(gate.warnings);
}

export function cloudPieceSizeWarningState(
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

export function glyphNameForCloudDocument(
    fontJson: Record<string, unknown> | null | undefined,
    documentId: string
): string | null {
    const glyphId = glyphIdFromDocumentId(documentId);
    if (!glyphId || !fontJson) {
        return null;
    }
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

export function escapeCloudTooltipText(value: string): string {
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

function forEachCloudExportShape(
    fontJson: Record<string, unknown>,
    visitor: (shape: Record<string, unknown>) => void
): void {
    const glyphs = Array.isArray(fontJson.glyphs) ? fontJson.glyphs : [];
    for (const glyph of glyphs) {
        const glyphRecord =
            glyph && typeof glyph === 'object' && !Array.isArray(glyph)
                ? (glyph as Record<string, unknown>)
                : null;
        const drawings = Array.isArray(glyphRecord?.layers)
            ? (glyphRecord.layers as unknown[])
            : [];
        for (const drawing of drawings) {
            const shapes = Array.isArray(
                (drawing as { shapes?: unknown[] }).shapes
            )
                ? (drawing as { shapes: unknown[] }).shapes
                : [];
            for (const shape of shapes) {
                if (!shape || typeof shape !== 'object') {
                    continue;
                }
                visitor(shape as Record<string, unknown>);
            }
        }
    }
}

export function canonicalizeCloudExportFontJson(
    fontJson: Record<string, unknown>
): Record<string, unknown> {
    forEachCloudExportShape(fontJson, (shape) => {
        const componentShape = shape as {
            reference?: unknown;
            transform?: unknown;
        };
        if (typeof componentShape.reference === 'string') {
            componentShape.transform = normalizeCloudComponentTransform(
                componentShape.transform
            );
        }
    });

    return fontJson;
}

export function validateCloudExportForFontOpen(
    fontJson: Record<string, unknown>,
    _operation: 'open' | 'save' = 'open'
) {
    forEachCloudExportShape(fontJson, (shapeRecord) => {
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

        const pathShape = shapeRecord as {
            nodes?: unknown;
            closed?: boolean;
        };
        if (Array.isArray(pathShape.nodes)) {
            if (pathShape.closed === undefined) {
                throw new TypeError(
                    'Cloud-exported path shapes must carry an explicit closed flag.'
                );
            }
            return;
        }

        const componentShape = shapeRecord as {
            reference?: unknown;
            transform?: unknown;
        };
        if (typeof componentShape.reference === 'string') {
            const normalizedTransform = normalizeCloudComponentTransform(
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
    });
}

export function glyphIdsFromCoreJson(
    coreJson: Record<string, unknown>
): string[] {
    const owned = catalogFromCoreJson(coreJson);
    if (!owned) {
        return [];
    }
    return liveCatalogGlyphIds(owned.glyphCatalog);
}

export function catalogEntriesFromCoreJson(
    coreJson: Record<string, unknown>
): Array<{ glyphId: string; name: string; componentIds?: string[] }> {
    return catalogEntriesForDepsParse(coreJson);
}

export function glyphDocumentIdsFromCoreJson(
    coreJson: Record<string, unknown>
): string[] {
    return glyphIdsFromCoreJson(coreJson).map(glyphDocumentId);
}

export function getCloudFontJsonFromBridge(
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

export function assertCloudBridgeStateCanBeSaved(
    bridge: Pick<PatchSyncEngine, 'getFontJsonSnapshot'>
): void {
    const fontJson = getCloudFontJsonFromBridge(bridge);
    if (!fontJson) {
        throw new Error('No active font data to save to cloud');
    }
    validateCloudExportForFontOpen(fontJson, 'save');
}

export function cloneCloudFontJson(
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

export function estimateCloudTransferTimeoutMs(
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

export function cloneEncodedShards(shards: EncodedShard[]): EncodedShard[] {
    return shards.map((shard) => ({
        documentId: shard.documentId,
        bytes: shard.bytes.slice()
    }));
}

export function encodedShardByteLength(shards: EncodedShard[]): number {
    return shards.reduce((sum, shard) => sum + shard.bytes.byteLength, 0);
}

export async function flushPendingCloudSaveMutations(): Promise<void> {
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

export async function waitForCloudSaveBridge(
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
    const shards = cloneEncodedShards(
        bridge.encodeDocumentSetForSeed?.() ??
            bridge.encodeDocumentSet?.() ??
            []
    );
    if (!shards.length) {
        throw new Error('No live document set to seed to cloud');
    }
    // The seed becomes the new rooms' whole state: never one with a hole.
    assertEncodableDocumentSet(shards);
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
export async function waitForCloudFontJson(
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
    maxGlyphsPerFont?: number | null;
    snapshotRetentionDays: number | null;
    fontsOwnedCount: number;
    maxCloudAssetBytes?: number;
    warningCloudAssetBytes?: number;
    maxShardBytes?: number;
    warningShardBytes?: number;
    maxPacketBytes?: number;
    capabilities?: Record<string, number>;
    /** Present while the user's own subscription has lapsed. */
    subscriptionLapse?: { state?: string; message?: string };
}

/** Why Save As to the cloud can't start: a short note and the full reason. */
export type CloudSaveAsBlocker = { note: string; title: string };

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
