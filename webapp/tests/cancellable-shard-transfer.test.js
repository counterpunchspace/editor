/**
 * @jest-environment jsdom
 */

const {
    seedDocumentSetWithProgress,
    isTransferCancelled
} = require('../js/filesystem-plugins/cancellable-shard-transfer.ts');
const { TransferCancelledError } = require('../js/ui/transfer-progress.ts');

describe('cancellable shard transfer', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    test('passes abort signal and progress into seedDocumentSet', async () => {
        const seeder = {
            seedDocumentSet: jest.fn(async (_t, _u, _s, _g, _n, options) => {
                expect(options.signal).toBeInstanceOf(AbortSignal);
                await options.onProgress({
                    completed: 1,
                    total: 2,
                    bytesCompleted: 10,
                    bytesTotal: 20,
                    shardId: 'font-core'
                });
                await options.onShardLanded({
                    shardId: 'font-core',
                    checkpointObjectKey: 'k',
                    checkpointSha256: 'a'.repeat(64),
                    checkpointByteLength: 10,
                    checkpointLogId: 0
                });
                return { coreCheckpointLogId: 0, attestations: [] };
            }),
            discardSeededShards: jest.fn().mockResolvedValue()
        };
        await seedDocumentSetWithProgress({
            seeder,
            token: 't',
            roomUrl: 'http://127.0.0.1:8787/room/asset-1',
            shards: [
                { documentId: 'font-core', bytes: new Uint8Array([1]) },
                { documentId: 'font-deps', bytes: new Uint8Array([2]) }
            ],
            glyphCount: 1
        });
        expect(seeder.seedDocumentSet).toHaveBeenCalled();
        expect(seeder.discardSeededShards).not.toHaveBeenCalled();
    });

    test('cancel discards landed shard ids', async () => {
        const seeder = {
            seedDocumentSet: jest.fn(async (_t, _u, _s, _g, _n, options) => {
                await options.onShardLanded({
                    shardId: 'font-core',
                    checkpointObjectKey: 'k',
                    checkpointSha256: 'a'.repeat(64),
                    checkpointByteLength: 3,
                    checkpointLogId: 0
                });
                return new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => {
                        reject(options.signal.reason);
                    });
                });
            }),
            discardSeededShards: jest.fn().mockResolvedValue()
        };
        const pending = seedDocumentSetWithProgress({
            seeder,
            token: 't',
            roomUrl: 'http://127.0.0.1:8787/room/asset-1',
            shards: [
                { documentId: 'font-core', bytes: new Uint8Array([1, 2, 3]) }
            ],
            glyphCount: 1
        });
        await Promise.resolve();
        await Promise.resolve();
        document.querySelector('[data-action="cancel"]').click();
        await expect(pending).rejects.toBeInstanceOf(TransferCancelledError);
        expect(isTransferCancelled(new TransferCancelledError())).toBe(true);
        expect(seeder.discardSeededShards).toHaveBeenCalledWith(
            't',
            'http://127.0.0.1:8787/room/asset-1',
            ['font-core']
        );
    });
});
