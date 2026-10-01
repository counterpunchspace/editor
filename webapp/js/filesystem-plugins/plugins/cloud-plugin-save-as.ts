// @ts-nocheck
/** CloudPlugin saveAs pipeline. */
import {
    CloudAdapter,
    type CloudSeededShardAttestation
} from '../../cloud-adapter';
import { getCloudRequestHeaders } from '../../cloud-website-api';
import { seedDocumentSetWithProgress } from '../cancellable-shard-transfer';
import {
    captureCloudSaveSeedState,
    estimateCloudTransferTimeoutMs,
    formatCloudByteCount,
    recaptureCloudSaveSeedIfBridgeChanged
} from './cloud-plugin-support';

export const cloudPluginSaveAsMethods = {
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
        void this._fetchAssetLimits(assetId);
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
};
