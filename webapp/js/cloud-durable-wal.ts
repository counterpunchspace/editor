import type { CollaborationMessageEnvelope } from './collaboration-message';
import { Logger } from './logger';

const console = new Logger('CloudDurableWal');

const DB_NAME = 'counterpunch-cloud-outbox';
const STORE = 'pending-transactions';
/** Schema without prepared/generation quarantine; one connection per WAL. */
const DB_VERSION = 4;

export type CloudWalState = 'applied' | 'sent' | 'acknowledged';

export type CloudWalRevisionObligation = {
    kind: 'glyph-revision-publication';
    glyphIds: string[];
    published?: boolean;
};

export type CloudWalRecord = {
    assetId: string;
    documentId: string;
    clientTransactionId: string;
    /** Transaction ids that must be ACK'd before this row may flush. */
    dependsOn?: string[];
    collaborationMessage?: CollaborationMessageEnvelope | null;
    collaborationMetadata?: CollaborationMessageEnvelope['metadata'];
    revisionObligations?: CloudWalRevisionObligation[];
    state?: CloudWalState;
    attempts: number;
    updateBytes: Uint8Array;
    createdAt: number;
    lastError?: string;
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

function normalizeLoadedRecord(record: CloudWalRecord): CloudWalRecord | null {
    const updateBytes = walUpdateBytes(record);
    if (updateBytes.byteLength === 0) {
        return null;
    }
    const dependsOn = Array.isArray(record.dependsOn)
        ? record.dependsOn.filter(
              (id): id is string => typeof id === 'string' && id.length > 0
          )
        : [];
    return {
        assetId: record.assetId,
        documentId: record.documentId,
        clientTransactionId: record.clientTransactionId,
        dependsOn,
        collaborationMessage: record.collaborationMessage ?? null,
        collaborationMetadata:
            record.collaborationMetadata ||
            record.collaborationMessage?.metadata,
        revisionObligations: Array.isArray(record.revisionObligations)
            ? record.revisionObligations
            : [],
        state: record.state === 'sent' ? 'sent' : 'applied',
        attempts: Number(record.attempts ?? 0),
        updateBytes,
        createdAt: Number(record.createdAt || Date.now()),
        lastError: record.lastError
    };
}

function persistableRecord(record: CloudWalRecord): CloudWalRecord & {
    key: string;
} {
    const normalized = normalizeLoadedRecord(record);
    if (!normalized) {
        throw new Error('Cloud WAL row requires update bytes');
    }
    return {
        ...normalized,
        updateBytes: copyUpdateBytes(normalized.updateBytes),
        key: recordKey(normalized)
    };
}

export class CloudDurableWal {
    private _health: CloudWalHealth = 'initializing';
    private _records = new Map<string, CloudWalRecord>();
    private _loadedAssetId: string | null = null;
    private _db: IDBDatabase | null = null;
    private _openPromise: Promise<IDBDatabase> | null = null;

    get health(): CloudWalHealth {
        return this._health;
    }

    get pendingCount(): number {
        return [...this._records.values()].filter(
            (record) =>
                record.state !== 'acknowledged' &&
                walUpdateBytes(record).byteLength > 0
        ).length;
    }

    recordsFor(documentId?: string): CloudWalRecord[] {
        return [...this._records.values()]
            .filter((record) => !documentId || record.documentId === documentId)
            .sort((a, b) => a.createdAt - b.createdAt);
    }

    /** Unacked rows in dependsOn order (creation order within independent rows). */
    replayableRecords(): CloudWalRecord[] {
        const pending = this.recordsFor().filter(
            (record) => record.state !== 'acknowledged'
        );
        const byId = new Map(
            pending.map((record) => [record.clientTransactionId, record])
        );
        const result: CloudWalRecord[] = [];
        const visiting = new Set<string>();
        const visited = new Set<string>();
        const visit = (id: string): void => {
            if (visited.has(id) || visiting.has(id)) {
                return;
            }
            const record = byId.get(id);
            if (!record) {
                return;
            }
            visiting.add(id);
            for (const dep of record.dependsOn || []) {
                if (byId.has(dep)) {
                    visit(dep);
                }
            }
            visiting.delete(id);
            visited.add(id);
            result.push(record);
        };
        for (const record of pending) {
            visit(record.clientTransactionId);
        }
        return result;
    }

    private async _ensureDb(): Promise<IDBDatabase> {
        if (this._db) {
            return this._db;
        }
        if (this._openPromise) {
            return this._openPromise;
        }
        this._openPromise = new Promise<IDBDatabase>((resolve, reject) => {
            if (typeof indexedDB === 'undefined') {
                reject(new Error('IndexedDB is unavailable'));
                return;
            }
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            let timer: ReturnType<typeof setTimeout> | undefined;
            let settled = false;
            const settle = (fn: () => void) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timer) {
                    clearTimeout(timer);
                }
                fn();
            };
            timer = setTimeout(() => {
                settle(() => reject(new Error('IndexedDB open timed out')));
            }, 1500);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (db.objectStoreNames.contains(STORE)) {
                    db.deleteObjectStore(STORE);
                }
                db.createObjectStore(STORE, { keyPath: 'key' });
            };
            request.onsuccess = () =>
                settle(() => {
                    this._db = request.result;
                    this._db.onclose = () => {
                        this._db = null;
                        this._openPromise = null;
                    };
                    resolve(this._db);
                });
            request.onerror = () => settle(() => reject(request.error));
            request.onblocked = () =>
                settle(() => reject(new Error('IndexedDB is blocked')));
        }).finally(() => {
            if (!this._db) {
                this._openPromise = null;
            }
        });
        return this._openPromise;
    }

    async load(assetId: string): Promise<CloudWalRecord[]> {
        if (typeof indexedDB === 'undefined') {
            this._health = 'unavailable';
            return [];
        }
        try {
            const db = await this._ensureDb();
            const records = await new Promise<CloudWalRecord[]>(
                (resolve, reject) => {
                    const tx = db.transaction(STORE, 'readonly');
                    const request = tx.objectStore(STORE).getAll();
                    request.onerror = () => reject(request.error);
                    request.onsuccess = () => {
                        const loaded: CloudWalRecord[] = [];
                        for (const raw of request.result as Array<
                            CloudWalRecord & { key: string }
                        >) {
                            if (raw.assetId !== assetId) {
                                continue;
                            }
                            const normalized = normalizeLoadedRecord(raw);
                            if (normalized) {
                                loaded.push(normalized);
                            }
                        }
                        resolve(loaded);
                    };
                }
            );
            this._records.clear();
            for (const record of records) {
                this._records.set(recordKey(record), record);
            }
            this._loadedAssetId = assetId;
            this._health = 'ready';
            return records;
        } catch (error) {
            this._health = 'unavailable';
            this._db = null;
            this._openPromise = null;
            throw error;
        }
    }

    async append(record: CloudWalRecord): Promise<void> {
        if (this._health === 'unavailable') {
            throw new Error('Cloud write-ahead storage is unavailable');
        }
        const stored = persistableRecord(record);
        try {
            const db = await this._ensureDb();
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).put(stored);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
            this._records.set(stored.key, {
                ...stored,
                updateBytes: copyUpdateBytes(stored.updateBytes)
            });
            this._loadedAssetId = record.assetId;
            this._health = 'ready';
        } catch (error) {
            this._health = 'unavailable';
            this._db = null;
            this._openPromise = null;
            throw error;
        }
    }

    async verifyWritable(): Promise<void> {
        if (this._health === 'unavailable') {
            throw new Error('Cloud write-ahead storage is unavailable');
        }
        const probeId = `probe:${Date.now()}`;
        const probe: CloudWalRecord = {
            assetId: this._loadedAssetId || 'probe',
            documentId: 'wal-probe',
            clientTransactionId: probeId,
            updateBytes: new Uint8Array([1]),
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
            state: 'applied',
            createdAt: Date.now(),
            attempts: 0
        };
        await this.append(probe);
        await this.acknowledge(probe);
    }

    async acknowledge(record: CloudWalRecord): Promise<void> {
        const key = recordKey(record);
        try {
            const db = await this._ensureDb();
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).delete(key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (error) {
            console.warn('CloudDurableWal: acknowledge failed', error);
            this._db = null;
            this._openPromise = null;
            throw error;
        }
        this._records.delete(key);
    }

    async acknowledgeMany(
        assetId: string,
        documentId: string,
        clientTransactionIds: string[]
    ): Promise<void> {
        if (!clientTransactionIds.length) {
            return;
        }
        const db = await this._ensureDb();
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
        });
        for (const clientTransactionId of clientTransactionIds) {
            this._records.delete(
                recordKey({ assetId, documentId, clientTransactionId })
            );
        }
    }

    close(): void {
        if (this._db) {
            this._db.close();
            this._db = null;
        }
        this._openPromise = null;
    }
}
