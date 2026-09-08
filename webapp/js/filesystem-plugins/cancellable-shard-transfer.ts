/**
 * Bind the general transfer-progress dialog to document-set seed/load I/O.
 */

import type { EncodedShard } from './cloud-document-set';
import type {
    CloudSeedDocumentSetResult,
    CloudShardIoOptions,
    CloudShardIoProgress
} from '../cloud-adapter';
import {
    runWithTransferProgress,
    type TransferProgressSession
} from '../ui/transfer-progress';

export {
    isTransferCancelled,
    TransferCancelledError
} from '../ui/transfer-progress';

type ShardSeeder = {
    seedDocumentSet: (
        token: string,
        roomUrl: string,
        shards: EncodedShard[],
        glyphCount: number,
        migrationNonce?: string,
        options?: CloudShardIoOptions
    ) => Promise<CloudSeedDocumentSetResult>;
};

function bindSessionProgress(
    session: TransferProgressSession,
    message: string
): (progress: CloudShardIoProgress) => void {
    return (progress) => {
        session.update({
            completed: progress.completed,
            total: progress.total,
            bytesCompleted: progress.bytesCompleted,
            bytesTotal: progress.bytesTotal,
            message
        });
    };
}

export async function seedDocumentSetWithProgress(params: {
    seeder: ShardSeeder;
    token: string;
    roomUrl: string;
    shards: EncodedShard[];
    glyphCount: number;
    migrationNonce?: string;
    ioOptions?: CloudShardIoOptions;
}): Promise<CloudSeedDocumentSetResult> {
    const bytesTotal = params.shards.reduce(
        (sum, shard) => sum + shard.bytes.byteLength,
        0
    );
    return runWithTransferProgress({
        kind: 'seed',
        title: 'Saving',
        message: 'Uploading font to cloud…',
        total: params.shards.length,
        bytesTotal,
        work: (session) =>
            params.seeder.seedDocumentSet(
                params.token,
                params.roomUrl,
                params.shards,
                params.glyphCount,
                params.migrationNonce,
                {
                    ...params.ioOptions,
                    signal: session.signal,
                    onProgress: bindSessionProgress(
                        session,
                        'Uploading font to cloud…'
                    )
                }
            )
    });
}

export async function loadDocumentSetWithProgress<T>(params: {
    total?: number;
    bytesTotal?: number;
    work: (session: TransferProgressSession) => Promise<T>;
}): Promise<T> {
    return runWithTransferProgress({
        kind: 'load',
        title: 'Opening',
        message: 'Loading font…',
        total: params.total ?? 0,
        bytesTotal: params.bytesTotal,
        work: params.work
    });
}

export function shardIoOptionsFromSession(
    session: TransferProgressSession,
    extra?: CloudShardIoOptions
): CloudShardIoOptions {
    return {
        ...extra,
        signal: session.signal,
        onProgress: bindSessionProgress(session, 'Loading font…')
    };
}
