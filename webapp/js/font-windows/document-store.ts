// Fonts opened from this computer, folders the user granted access to, and
// recently opened fonts of every source, kept in IndexedDB.
//
// A disk document is a file or package handle with a stable id. The id goes
// into the URL (`?file=disk:///<id>/<name>`) because browsers never reveal a
// file's path. Handles stay valid across sessions; access may need to be
// granted again after the browser restarts (unless the app is installed).

import { Logger } from '../logger';
import { isSameEntry } from './file-access';
import type { FontFormatKey } from './font-formats';

const console = new Logger('FontWindows');

const DB_NAME = 'counterpunch-documents';
const DB_VERSION = 1;

export type DiskDocument = {
    id: string;
    name: string;
    format: FontFormatKey;
    /** The font's file, or its folder for .ufo and .glyphspackage. */
    handle: FileSystemFileHandle | FileSystemDirectoryHandle;
    /** The folder the font is in, when granted. A .designspace needs it. */
    parent?: FileSystemDirectoryHandle;
    addedAt: number;
};

export type GrantedFolder = {
    id: string;
    name: string;
    handle: FileSystemDirectoryHandle;
    addedAt: number;
};

export type RecentSource = 'disk' | 'memory' | 'cloud';

/** One recently opened font, keyed by its document key (file URI). */
export type RecentFont = {
    key: string;
    source: RecentSource;
    name: string;
    lastOpened: number;
};

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
    dbPromise ??= new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const database = request.result;
            database.createObjectStore('disk', { keyPath: 'id' });
            database.createObjectStore('folders', { keyPath: 'id' });
            database.createObjectStore('recents', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    return dbPromise;
}

async function run<T>(
    store: 'disk' | 'folders' | 'recents',
    mode: IDBTransactionMode,
    action: (objectStore: IDBObjectStore) => IDBRequest<T> | void
): Promise<T | undefined> {
    const database = await db();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(store, mode);
        const request = action(transaction.objectStore(store));
        transaction.oncomplete = () =>
            resolve(request ? request.result : undefined);
        transaction.onerror = () => reject(transaction.error);
    });
}

export const newDocumentId = () => crypto.randomUUID().slice(0, 8);

// --- Disk documents ---------------------------------------------------------

export async function getDiskDocument(
    id: string
): Promise<DiskDocument | null> {
    return (
        ((await run('disk', 'readonly', (s) => s.get(id))) as DiskDocument) ??
        null
    );
}

export async function allDiskDocuments(): Promise<DiskDocument[]> {
    return (
        ((await run('disk', 'readonly', (s) =>
            s.getAll()
        )) as DiskDocument[]) ?? []
    );
}

export async function putDiskDocument(doc: DiskDocument): Promise<void> {
    await run('disk', 'readwrite', (s) => {
        s.put(doc);
    });
}

export async function deleteDiskDocument(id: string): Promise<void> {
    await run('disk', 'readwrite', (s) => {
        s.delete(id);
    });
}

/** Store a font found on disk, reusing the entry if it's the same file. */
export async function upsertDiskDocument(
    fields: Omit<DiskDocument, 'id' | 'addedAt'>
): Promise<DiskDocument> {
    let existing: DiskDocument | null = null;
    for (const doc of await allDiskDocuments()) {
        if (await isSameEntry(doc.handle, fields.handle)) {
            existing = doc;
            break;
        }
    }
    const doc: DiskDocument = {
        ...(existing ?? { id: newDocumentId(), addedAt: Date.now() }),
        ...fields,
        // Keep a known parent folder when the handle arrives without one.
        parent: fields.parent ?? existing?.parent
    };
    await putDiskDocument(doc);
    return doc;
}

// --- Granted folders --------------------------------------------------------

export async function allGrantedFolders(): Promise<GrantedFolder[]> {
    return (
        ((await run('folders', 'readonly', (s) =>
            s.getAll()
        )) as GrantedFolder[]) ?? []
    );
}

export async function rememberFolder(
    handle: FileSystemDirectoryHandle
): Promise<GrantedFolder> {
    for (const folder of await allGrantedFolders()) {
        if (await isSameEntry(folder.handle, handle)) return folder;
    }
    const folder: GrantedFolder = {
        id: newDocumentId(),
        name: handle.name,
        handle,
        addedAt: Date.now()
    };
    await run('folders', 'readwrite', (s) => {
        s.put(folder);
    });
    console.log('Remembered folder', handle.name);
    return folder;
}

// --- Recent fonts -----------------------------------------------------------

export async function allRecentFonts(): Promise<RecentFont[]> {
    return (
        ((await run('recents', 'readonly', (s) =>
            s.getAll()
        )) as RecentFont[]) ?? []
    );
}

export async function touchRecentFont(
    entry: Omit<RecentFont, 'lastOpened'>
): Promise<void> {
    await run('recents', 'readwrite', (s) => {
        s.put({ ...entry, lastOpened: Date.now() });
    });
}

export async function removeRecentFont(key: string): Promise<void> {
    await run('recents', 'readwrite', (s) => {
        s.delete(key);
    });
}
