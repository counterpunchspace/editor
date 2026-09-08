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
                return { coreCheckpointLogId: 0, attestations: [] };
            })
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
    });

    test('cancel does not locally discard shards; website abort owns rollback', async () => {
        const seeder = {
            seedDocumentSet: jest.fn(async (_t, _u, _s, _g, _n, options) => {
                return new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => {
                        reject(options.signal.reason);
                    });
                });
            })
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
    });
});
