import type { CollaborationMessageEnvelope } from './collaboration-message';

const DB_NAME = 'counterpunch-cloud-outbox';
const STORE = 'pending-transactions';
const DB_VERSION = 3;

export type CloudWalState = 'prepared' | 'applied' | 'sent' | 'acknowledged';

export type CloudWalReceipt = {
    generationId: string;
    clientTransactionId: string;
    digest: string;
    byteLength: number;
};

export type CloudWalRevisionObligation = {
    kind: 'glyph-revision-publication';
    glyphIds: string[];
    published?: boolean;
};

export type CloudWalDocumentUpdate = {
    documentId: string;
    baseStateVectorBase64?: string;
    updateBase64?: string;
};

export type CloudWalRecord = {
    schemaVersion?: 1 | 2;
    transactionId?: string;
    assetId: string;
    documentId: string;
    clientTransactionId: string;
    generationId?: string;
    operations?: unknown[];
    documentUpdates?: CloudWalDocumentUpdate[];
    collaborationMessage?: CollaborationMessageEnvelope | null;
    collaborationMetadata?: CollaborationMessageEnvelope['metadata'];
    revisionObligations?: CloudWalRevisionObligation[];
    state?: CloudWalState;
    attempts: number;
    receipts?: CloudWalReceipt[];
    updateBytes?: Uint8Array;
    updateBase64?: string;
    createdAt: number;
    lastError?: string;
    quarantined?: boolean;
};

export function copyUpdateBytes(bytes: Uint8Array): Uint8Array {
    return bytes.slice();
}

export function bytesToBase64(bytes: Uint8Array): string {
    if (!bytes?.byteLength) {
        return '';
    }
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export function base64ToBytes(encoded: string | undefined): Uint8Array {
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
    return new Uint8Array();
}

export function serializeWalOperations(operations: unknown[]): unknown[] {
    return JSON.parse(JSON.stringify(operations ?? []));
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

function normalizeLoadedRecord(record: CloudWalRecord): CloudWalRecord {
    const updateBytes = walUpdateBytes(record);
    const schemaVersion = record.schemaVersion === 2 ? 2 : 1;
    const quarantined =
        record.quarantined === true ||
        schemaVersion !== 2 ||
        updateBytes.byteLength === 0;
    return {
        ...record,
        schemaVersion,
        transactionId: record.transactionId || record.clientTransactionId,
        operations: Array.isArray(record.operations) ? record.operations : [],
        documentUpdates: Array.isArray(record.documentUpdates)
            ? record.documentUpdates
            : [],
        collaborationMetadata:
            record.collaborationMetadata ||
            record.collaborationMessage?.metadata,
        revisionObligations: Array.isArray(record.revisionObligations)
            ? record.revisionObligations
            : [],
        receipts: Array.isArray(record.receipts) ? record.receipts : [],
        state:
            record.state ||
            (updateBytes.byteLength > 0 ? 'applied' : 'prepared'),
        attempts: Number(record.attempts ?? 0),
        updateBytes,
        quarantined
    };
}

function persistableRecord(record: CloudWalRecord): CloudWalRecord & {
    key: string;
} {
    const key = recordKey(record);
    const updateBytes = walUpdateBytes(record);
    const documentUpdates: CloudWalDocumentUpdate[] = (
        record.documentUpdates || []
    ).map((entry) => ({
        documentId: entry.documentId,
        baseStateVectorBase64: entry.baseStateVectorBase64,
        updateBase64: entry.updateBase64
    }));
    if (
        updateBytes.byteLength > 0 &&
        !documentUpdates.some((entry) => entry.documentId === record.documentId)
    ) {
        documentUpdates.push({
            documentId: record.documentId,
            baseStateVectorBase64: undefined,
            updateBase64: bytesToBase64(updateBytes)
        });
    }
    return {
        schemaVersion: 2,
        transactionId: record.transactionId || record.clientTransactionId,
        assetId: record.assetId,
        documentId: record.documentId,
        clientTransactionId: record.clientTransactionId,
        generationId: record.generationId,
        operations: serializeWalOperations(record.operations || []),
        documentUpdates,
        collaborationMessage: record.collaborationMessage,
        collaborationMetadata:
            record.collaborationMetadata ||
            record.collaborationMessage?.metadata,
        revisionObligations: record.revisionObligations || [],
        state: record.state || 'prepared',
        attempts: Number(record.attempts ?? 0),
        receipts: record.receipts || [],
        createdAt: record.createdAt,
        lastError: record.lastError,
        quarantined: record.quarantined === true,
        updateBytes: copyUpdateBytes(updateBytes),
        updateBase64: bytesToBase64(updateBytes),
        key
    };
}

function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB is unavailable'));
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
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
        return [...this._records.values()].filter(
            (record) =>
                record.state !== 'acknowledged' &&
                record.quarantined !== true &&
                walUpdateBytes(record).byteLength > 0
        ).length;
    }

    recordsFor(documentId?: string): CloudWalRecord[] {
        return [...this._records.values()].filter(
            (record) =>
                record.quarantined !== true &&
                (!documentId ||
                    record.documentId === documentId ||
                    record.documentUpdates?.some(
                        (entry) => entry.documentId === documentId
                    ))
        );
    }

    replayableRecords(generationId?: string | null): CloudWalRecord[] {
        const current = String(generationId || '');
        return this.recordsFor().filter((record) => {
            if (record.quarantined) {
                return false;
            }
            if (walUpdateBytes(record).byteLength === 0) {
                return false;
            }
            if (!current) {
                return true;
            }
            return record.generationId === current;
        });
    }

    quarantinedRecords(): CloudWalRecord[] {
        return [...this._records.values()].filter(
            (record) => record.quarantined === true
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
                                .map(({ key: _key, ...record }) =>
                                    normalizeLoadedRecord(
                                        record as CloudWalRecord
                                    )
                                )
                        );
                }
            );
            db.close();
            const recovered: CloudWalRecord[] = [];
            this._records.clear();
            for (const record of records) {
                if (walUpdateBytes(record).byteLength === 0) {
                    continue;
                }
                this._records.set(recordKey(record), record);
                recovered.push(record);
            }
            this._loadedAssetId = assetId;
            this._health = 'ready';
            for (const record of records) {
                if (walUpdateBytes(record).byteLength === 0) {
                    try {
                        await this.acknowledge(record);
                    } catch {
                        /* prepared-only rows are not recoverable */
                    }
                }
            }
            return recovered;
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
                const stored = persistableRecord(record);
                store.put(stored);
                const verify = store.get(stored.key);
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
            this._records.set(
                recordKey(record),
                normalizeLoadedRecord({
                    ...record,
                    ...persistableRecord(record)
                })
            );
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
            schemaVersion: 2,
            transactionId: `probe:${Date.now()}`,
            assetId: this._loadedAssetId || 'probe',
            documentId: 'wal-probe',
            clientTransactionId: `probe:${Date.now()}`,
            operations: [],
            documentUpdates: [],
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
            state: 'prepared',
            createdAt: Date.now(),
            attempts: 0
        };
        await this.append(probe);
        await this.acknowledge(probe);
    }

    async acknowledge(record: CloudWalRecord): Promise<void> {
        const db = await openDatabase();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(recordKey(record));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        }).finally(() => db.close());
        this._records.delete(recordKey(record));
    }

    async acknowledgeMany(
        assetId: string,
        documentId: string,
        clientTransactionIds: string[]
    ): Promise<void> {
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
        for (const clientTransactionId of clientTransactionIds) {
            this._records.delete(
                recordKey({ assetId, documentId, clientTransactionId })
            );
        }
    }

    async quarantineOtherGenerations(
        assetId: string,
        currentGenerationId: string
    ): Promise<CloudWalRecord[]> {
        const current = String(currentGenerationId || '');
        if (!current) {
            return [];
        }
        const stale = [...this._records.values()].filter(
            (record) =>
                record.assetId === assetId && record.generationId !== current
        );
        for (const record of stale) {
            await this.append({
                ...record,
                quarantined: true
            });
        }
        return stale.map((record) => ({ ...record, quarantined: true }));
    }

    async discardOtherGenerations(
        assetId: string,
        currentGenerationId: string
    ): Promise<number> {
        const quarantined = await this.quarantineOtherGenerations(
            assetId,
            currentGenerationId
        );
        for (const record of quarantined) {
            await this.acknowledge(record);
        }
        return quarantined.length;
    }

    exportQuarantined(): CloudWalRecord[] {
        return this.quarantinedRecords().map((record) => ({ ...record }));
    }
}
