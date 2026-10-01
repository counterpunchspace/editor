// @ts-nocheck
/**
 * CloudPlugin seed/hydrate batch measurement helpers.
 * Installed onto CloudPlugin.prototype from cloud-plugin.ts.
 */
import { CloudAdapter, type CloudShardIoOptions } from '../../cloud-adapter';
import { getCloudRequestHeaders } from '../../cloud-adapter-support';
import {
    captureCloudSaveSeedState,
    type CloudAsset
} from './cloud-plugin-support';

export const cloudPluginMeasureMethods = {
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
    },

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
};
