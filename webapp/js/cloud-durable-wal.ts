import type { CollaborationMessageEnvelope } from './collaboration-message';

const DB_NAME = 'counterpunch-cloud-outbox';
const STORE = 'pending-transactions';

export type CloudWalRecord = {
    assetId: string;
    documentId: string;
    clientTransactionId: string;
    updateBytes?: Uint8Array;
    updateBase64?: string;
    collaborationMessage: CollaborationMessageEnvelope;
    createdAt: number;
    attempts: number;
    lastError?: string;
    generationId?: string;
};

export function copyUpdateBytes(bytes: Uint8Array): Uint8Array {
    return bytes.slice();
}

export function walUpdateBytes(record: CloudWalRecord): Uint8Array {
    const raw = record.updateBytes as unknown;
    if (raw instanceof Uint8Array) {
        return copyUpdateBytes(raw);
    }
    if (raw instanceof ArrayBuffer) {
        return new Uint8Array(raw.slice(0));
    }
    if (
        raw &&
        typeof raw === 'object' &&
        (raw as { buffer?: unknown }).buffer instanceof ArrayBuffer
    ) {
        const view = raw as ArrayBufferView;
        return new Uint8Array(
            view.buffer.slice(
                view.byteOffset,
                view.byteOffset + view.byteLength
            )
        );
    }
    const encoded = record.updateBase64;
    if (!encoded) {
        return new Uint8Array();
    }
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

export type CloudWalHealth = 'initializing' | 'ready' | 'unavailable';

export function recordKey(
    record: Pick<
        CloudWalRecord,
        'assetId' | 'documentId' | 'clientTransactionId'
    >
): string {
    return `${record.assetId}:${record.documentId}:${record.clientTransactionId}`;
}

function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB is unavailable'));
            return;
        }
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE)) {
                request.result.createObjectStore(STORE, { keyPath: 'key' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('IndexedDB is blocked'));
    });
}

export class CloudDurableWal {
    private _health: CloudWalHealth = 'initializing';
    private _records = new Map<string, CloudWalRecord>();
    private _loadedAssetId: string | null = null;

    get health(): CloudWalHealth {
        return this._health;
    }

    get pendingCount(): number {
        return this._records.size;
    }

    recordsFor(documentId?: string): CloudWalRecord[] {
        return [...this._records.values()].filter(
            (record) => !documentId || record.documentId === documentId
        );
    }

    async load(assetId: string): Promise<CloudWalRecord[]> {
        if (typeof indexedDB === 'undefined') {
            this._health = 'unavailable';
            return [];
        }
        try {
            const db = await openDatabase();
            const records = await new Promise<CloudWalRecord[]>(
                (resolve, reject) => {
                    const tx = db.transaction(STORE, 'readonly');
                    const request = tx.objectStore(STORE).getAll();
                    request.onerror = () => reject(request.error);
                    request.onsuccess = () =>
                        resolve(
                            (
                                request.result as Array<
                                    CloudWalRecord & { key: string }
                                >
                            )
                                .filter((record) => record.assetId === assetId)
                                .map(({ key: _key, attempts, ...record }) => {
                                    const updateBytes = walUpdateBytes(
                                        record as CloudWalRecord
                                    );
                                    return {
                                        ...(record as CloudWalRecord),
                                        attempts: Number(attempts ?? 0),
                                        updateBytes
                                    };
                                })
                        );
                }
            );
            db.close();
            this._records.clear();
            for (const record of records) {
                this._records.set(recordKey(record), record);
            }
            this._loadedAssetId = assetId;
            this._health = 'ready';
            return records;
        } catch (error) {
            this._health = 'unavailable';
            throw error;
        }
    }

    async append(record: CloudWalRecord): Promise<void> {
        if (this._health === 'unavailable') {
            throw new Error('Cloud write-ahead storage is unavailable');
        }
        try {
            const db = await openDatabase();
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(STORE, 'readwrite');
                const store = tx.objectStore(STORE);
                const key = recordKey(record);
                const updateBytes = walUpdateBytes(record);
                store.put({
                    assetId: record.assetId,
                    documentId: record.documentId,
                    clientTransactionId: record.clientTransactionId,
                    collaborationMessage: record.collaborationMessage,
                    createdAt: record.createdAt,
                    attempts: record.attempts,
                    lastError: record.lastError,
                    generationId: record.generationId,
                    updateBytes: copyUpdateBytes(updateBytes),
                    key
                });
                const verify = store.get(key);
                verify.onerror = () => reject(verify.error);
                verify.onsuccess = () => {
                    if (!verify.result) {
                        reject(
                            new Error(
                                'Cloud write-ahead persist could not be verified'
                            )
                        );
                    }
                };
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            }).finally(() => db.close());
            this._records.set(recordKey(record), {
                ...record,
                updateBytes: walUpdateBytes(record)
            });
            this._loadedAssetId = record.assetId;
            this._health = 'ready';
        } catch (error) {
            this._health = 'unavailable';
            throw error;
        }
    }

    async verifyWritable(): Promise<void> {
        if (this._health === 'unavailable') {
            throw new Error('Cloud write-ahead storage is unavailable');
        }
        const probe: CloudWalRecord = {
            assetId: this._loadedAssetId || 'probe',
            documentId: 'wal-probe',
            clientTransactionId: `probe:${Date.now()}`,
            updateBase64: '',
            collaborationMessage: {
                schemaVersion: 1,
                transactionId: 'wal-probe',
                localSequence: 0,
                roomSequence: null,
                baseRevision: null,
                changes: [],
                metadata: {
                    editType: 'font',
                    changedGlyphNames: [],
                    changedLayerIds: [],
                    workerReplayTargets: [],
                    historyItemId: 'wal-probe',
                    historyAction: 'change',
                    undoScope: 'font'
                },
                source: 'wal-probe',
                label: null,
                summary: '',
                windowId: null,
                timestamp: Date.now()
            },
            createdAt: Date.now(),
            attempts: 0
        };
        await this.append(probe);
        await this.acknowledge(probe);
    }

    async acknowledge(record: CloudWalRecord): Promise<void> {
        this._records.delete(recordKey(record));
        const db = await openDatabase();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(recordKey(record));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        }).finally(() => db.close());
    }

    async acknowledgeMany(
        assetId: string,
        documentId: string,
        clientTransactionIds: string[]
    ): Promise<void> {
        for (const clientTransactionId of clientTransactionIds) {
            this._records.delete(
                recordKey({ assetId, documentId, clientTransactionId })
            );
        }
        if (!clientTransactionIds.length) {
            return;
        }
        const db = await openDatabase();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            for (const clientTransactionId of clientTransactionIds) {
                store.delete(
                    recordKey({ assetId, documentId, clientTransactionId })
                );
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        }).finally(() => db.close());
    }

    async discardOtherGenerations(
        assetId: string,
        currentGenerationId: string
    ): Promise<number> {
        const current = String(currentGenerationId || '');
        if (!current) {
            return 0;
        }
        const stale = [...this._records.values()].filter(
            (record) =>
                record.assetId === assetId &&
                record.generationId &&
                record.generationId !== current
        );
        for (const record of stale) {
            await this.acknowledge(record);
        }
        return stale.length;
    }
}
