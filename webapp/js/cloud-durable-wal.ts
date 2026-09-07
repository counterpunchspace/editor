import type { CollaborationMessageEnvelope } from './collaboration-message';

const DB_NAME = 'counterpunch-cloud-outbox';
const STORE = 'pending-transactions';

export type CloudWalRecord = {
    assetId: string;
    documentId: string;
    clientTransactionId: string;
    updateBase64: string;
    collaborationMessage: CollaborationMessageEnvelope;
    createdAt: number;
    attempts: number;
    lastError?: string;
};

export type CloudWalHealth = 'initializing' | 'ready' | 'unavailable';

function recordKey(
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
                                .map(({ key: _key, attempts, ...record }) => ({
                                    attempts: Number(attempts ?? 0),
                                    ...record
                                }))
                        );
                }
            );
            db.close();
            this._records.clear();
            for (const record of records) {
                this._records.set(record.clientTransactionId, record);
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
                store.put({
                    ...record,
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
            this._records.set(record.clientTransactionId, record);
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
        this._records.delete(record.clientTransactionId);
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
            this._records.delete(clientTransactionId);
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
}
