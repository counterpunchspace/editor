import type { CollaborationMessageEnvelope } from './collaboration-message';
import { Logger } from './logger';

const console = new Logger('CloudDurableWal');

const DB_NAME = 'counterpunch-cloud-outbox';
const STORE = 'pending-transactions';
/** Schema without prepared/generation quarantine; one connection per WAL. */
const DB_VERSION = 4;
const FIRST_READABLE_DB_VERSION = 4;

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

const WRITE_ATTEMPTS = 3;
const WRITE_RETRY_DELAY_MS = 100;
const RECOVERY_BASE_DELAY_MS = 1_000;
const RECOVERY_MAX_DELAY_MS = 30_000;

function isQuotaExceededError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        error.name === 'QuotaExceededError'
    );
}

/**
 * A row IndexedDB refused. The WAL still holds it in memory (so the outbox can
 * send it) and keeps retrying the write in the background.
 */
export class CloudWalPersistError extends Error {
    readonly quotaExceeded: boolean;

    constructor(cause: unknown) {
        const quotaExceeded = isQuotaExceededError(cause);
        super(
            quotaExceeded
                ? 'This browser’s storage for the site is full. Free up disk space or clear other site data so edits can be kept offline.'
                : `Cloud write-ahead storage is unavailable: ${
                      cause instanceof Error ? cause.message : String(cause)
                  }`
        );
        this.name = 'CloudWalPersistError';
        this.quotaExceeded = quotaExceeded;
    }
}

const WAL_PEER_CHANNEL = 'counterpunch-cloud-wal';

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
    private _changeListeners = new Set<() => void>();
    private _loaded = false;
    /** Keys of rows held only in memory because IndexedDB refused them. */
    private _unpersisted = new Set<string>();
    private _recoveryTimer: ReturnType<typeof setTimeout> | null = null;
    private _recoveryAttempts = 0;
    /**
     * Another tab on the same font loads the same rows. When one tab drops a
     * row, the others hear it here, so their pending count and unload prompt
     * do not wait for a row that is already gone.
     */
    private _peerChannel: BroadcastChannel | null = null;

    private _ensurePeerChannel(): void {
        if (this._peerChannel || typeof BroadcastChannel === 'undefined') {
            return;
        }
        try {
            this._peerChannel = new BroadcastChannel(WAL_PEER_CHANNEL);
            // Node (tests, tooling) would otherwise stay alive for the channel.
            (this._peerChannel as { unref?: () => void }).unref?.();
            this._peerChannel.onmessage = (event: MessageEvent) => {
                const keys = (event.data as { dropped?: unknown })?.dropped;
                if (!Array.isArray(keys)) {
                    return;
                }
                let changed = false;
                for (const key of keys) {
                    if (typeof key === 'string' && this._records.delete(key)) {
                        this._unpersisted.delete(key);
                        changed = true;
                    }
                }
                if (changed) {
                    this._emitChange();
                }
            };
        } catch {
            this._peerChannel = null;
        }
    }

    private _announceDropped(keys: string[]): void {
        if (!keys.length) {
            return;
        }
        this._ensurePeerChannel();
        try {
            this._peerChannel?.postMessage({ dropped: keys });
        } catch {
            /* other tabs fall back to their next load */
        }
    }

    get health(): CloudWalHealth {
        return this._health;
    }

    /** True once a load succeeded; appends after that never lose a row. */
    get isLoaded(): boolean {
        return this._loaded;
    }

    get pendingCount(): number {
        let count = 0;
        for (const record of this._records.values()) {
            if (this._isPending(record)) {
                count += 1;
            }
        }
        return count;
    }

    /** Unacked rows for one room. Adapters share this log, so a glyph row must not count as font-deps work. */
    pendingCountFor(documentId: string): number {
        let count = 0;
        for (const record of this._records.values()) {
            if (record.documentId === documentId && this._isPending(record)) {
                count += 1;
            }
        }
        return count;
    }

    /**
     * Fires after a row is stored or dropped. Every adapter listening on a
     * shared log needs this: an ack handled by the glyph socket otherwise
     * never wakes a waiter registered on font-deps.
     */
    onChange(listener: () => void): () => void {
        this._changeListeners.add(listener);
        return () => {
            this._changeListeners.delete(listener);
        };
    }

    private _isPending(record: CloudWalRecord): boolean {
        return (
            record.state !== 'acknowledged' &&
            (record.updateBytes?.byteLength ?? 0) > 0
        );
    }

    private _emitChange(): void {
        for (const listener of this._changeListeners) {
            listener();
        }
    }

    recordsFor(documentId?: string): CloudWalRecord[] {
        return [...this._records.values()]
            .filter((record) => !documentId || record.documentId === documentId)
            .sort((a, b) => a.createdAt - b.createdAt);
    }

    /**
     * True while a row this transaction depends on (`dependsOn`) is still
     * pending, in any document. A glyph-revision stamp must not reach peers
     * before the glyph bytes it announces are in their rooms.
     */
    hasPendingDependencies(
        documentId: string,
        clientTransactionId: string
    ): boolean {
        let record: CloudWalRecord | undefined;
        for (const candidate of this._records.values()) {
            if (
                candidate.documentId === documentId &&
                candidate.clientTransactionId === clientTransactionId
            ) {
                record = candidate;
                break;
            }
        }
        const dependsOn = record?.dependsOn ?? [];
        if (!dependsOn.length) {
            return false;
        }
        const wanted = new Set(dependsOn);
        for (const candidate of this._records.values()) {
            if (
                wanted.has(candidate.clientTransactionId) &&
                this._isPending(candidate)
            ) {
                return true;
            }
        }
        return false;
    }

    transactionIdsFor(documentId: string): Set<string> {
        const ids = new Set<string>();
        for (const record of this._records.values()) {
            if (record.documentId === documentId) {
                ids.add(record.clientTransactionId);
            }
        }
        return ids;
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
            request.onupgradeneeded = (event) => {
                const db = request.result;
                // Rows are unsent edits. Only the formats before version 4
                // are unreadable; a later bump must migrate, not drop.
                if (
                    db.objectStoreNames.contains(STORE) &&
                    event.oldVersion < FIRST_READABLE_DB_VERSION
                ) {
                    db.deleteObjectStore(STORE);
                }
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: 'key' });
                }
            };
            request.onsuccess = () =>
                settle(() => {
                    this._db = request.result;
                    this._db.onclose = () => {
                        this._db = null;
                        this._openPromise = null;
                    };
                    // A newer editor in another tab is upgrading the
                    // database; holding it open would block that tab.
                    this._db.onversionchange = () => {
                        this._db?.close();
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
            const unpersisted = [...this._unpersisted].flatMap((key) => {
                const record = this._records.get(key);
                return record ? [record] : [];
            });
            this._records.clear();
            for (const record of [...records, ...unpersisted]) {
                this._records.set(recordKey(record), record);
            }
            this._loadedAssetId = assetId;
            this._loaded = true;
            this._ensurePeerChannel();
            this._health = this._unpersisted.size ? 'unavailable' : 'ready';
            return records;
        } catch (error) {
            this._health = 'unavailable';
            this._db = null;
            this._openPromise = null;
            throw error;
        }
    }

    private _resetDb(): void {
        this._db = null;
        this._openPromise = null;
    }

    private async _putRows(
        rows: Array<CloudWalRecord & { key: string }>
    ): Promise<void> {
        const db = await this._ensureDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            for (const row of rows) {
                store.put(row);
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    private async _putRowsWithRetry(
        rows: Array<CloudWalRecord & { key: string }>
    ): Promise<void> {
        for (let attempt = 1; ; attempt += 1) {
            try {
                await this._putRows(rows);
                return;
            } catch (error) {
                this._resetDb();
                if (attempt >= WRITE_ATTEMPTS || isQuotaExceededError(error)) {
                    throw error;
                }
                await new Promise((resolve) =>
                    setTimeout(resolve, WRITE_RETRY_DELAY_MS * attempt)
                );
            }
        }
    }

    private _unpersistedRows(): Array<CloudWalRecord & { key: string }> {
        return [...this._unpersisted].flatMap((key) => {
            const record = this._records.get(key);
            return record ? [persistableRecord(record)] : [];
        });
    }

    private _markPersisted(): void {
        this._unpersisted.clear();
        this._recoveryAttempts = 0;
        if (this._recoveryTimer) {
            clearTimeout(this._recoveryTimer);
            this._recoveryTimer = null;
        }
        this._health = 'ready';
    }

    private _scheduleRecovery(): void {
        if (this._recoveryTimer || typeof indexedDB === 'undefined') {
            return;
        }
        const delay = Math.min(
            RECOVERY_MAX_DELAY_MS,
            RECOVERY_BASE_DELAY_MS * 2 ** Math.min(this._recoveryAttempts, 5)
        );
        this._recoveryAttempts += 1;
        this._recoveryTimer = setTimeout(() => {
            this._recoveryTimer = null;
            void this.recover();
        }, delay);
    }

    /**
     * Writes rows IndexedDB refused earlier (or a probe when none are left)
     * and returns the WAL to ready on success.
     */
    async recover(): Promise<boolean> {
        try {
            const rows = this._unpersistedRows();
            if (rows.length) {
                await this._putRowsWithRetry(rows);
            } else {
                await this._probe();
            }
        } catch (error) {
            console.warn('CloudDurableWal: recovery write failed', error);
            this._health = 'unavailable';
            this._scheduleRecovery();
            this._emitChange();
            return false;
        }
        this._markPersisted();
        this._emitChange();
        return true;
    }

    async append(record: CloudWalRecord): Promise<void> {
        const stored = persistableRecord(record);
        try {
            // Rows refused earlier ride along, so one good write heals the log.
            await this._putRowsWithRetry([
                stored,
                ...this._unpersistedRows().filter(
                    (row) => row.key !== stored.key
                )
            ]);
        } catch (error) {
            this._records.set(stored.key, stored);
            this._unpersisted.add(stored.key);
            this._loadedAssetId = record.assetId;
            this._health = 'unavailable';
            this._scheduleRecovery();
            this._emitChange();
            throw new CloudWalPersistError(error);
        }
        this._records.set(stored.key, stored);
        this._loadedAssetId = record.assetId;
        this._markPersisted();
        this._emitChange();
    }

    private async _probe(): Promise<void> {
        const probe = persistableRecord({
            assetId: this._loadedAssetId || 'probe',
            documentId: 'wal-probe',
            clientTransactionId: `probe:${Date.now()}`,
            updateBytes: new Uint8Array([1]),
            state: 'applied',
            createdAt: Date.now(),
            attempts: 0
        });
        await this._putRowsWithRetry([probe]);
        const db = await this._ensureDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(probe.key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async verifyWritable(): Promise<void> {
        if (!(await this.recover())) {
            throw new Error('Cloud write-ahead storage is unavailable');
        }
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
        this._unpersisted.delete(key);
        this._announceDropped([key]);
        this._emitChange();
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
        const keys = clientTransactionIds.map((clientTransactionId) =>
            recordKey({ assetId, documentId, clientTransactionId })
        );
        for (const key of keys) {
            this._records.delete(key);
            this._unpersisted.delete(key);
        }
        this._announceDropped(keys);
        this._emitChange();
    }

    close(): void {
        if (this._recoveryTimer) {
            clearTimeout(this._recoveryTimer);
            this._recoveryTimer = null;
        }
        if (this._db) {
            this._db.close();
            this._db = null;
        }
        this._openPromise = null;
        this._peerChannel?.close();
        this._peerChannel = null;
    }
}
