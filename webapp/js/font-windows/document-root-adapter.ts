// A Disk adapter rooted at one document, so the path-based open, save and
// reload code keeps working: the font's path is `/<name>` inside this root.
//
// The root is the font's granted folder when known. Otherwise it is a
// virtual folder that contains only the font (its file, or its package
// folder), which is all a font opened by itself can reach.

import { NativeAdapter } from '../file-system-adapter';
import type { DiskDocument } from './document-store';

type PermissionCapable = {
    queryPermission(options: {
        mode: 'read' | 'readwrite';
    }): Promise<PermissionState>;
    requestPermission(options: {
        mode: 'read' | 'readwrite';
    }): Promise<PermissionState>;
};

function notFound(name: string): DOMException {
    return new DOMException(`${name} is not in this folder`, 'NotFoundError');
}

/**
 * A stand-in directory handle holding just `entry`. It implements the part
 * of FileSystemDirectoryHandle that NativeAdapter uses.
 */
function singleEntryRoot(
    entry: FileSystemFileHandle | FileSystemDirectoryHandle
): FileSystemDirectoryHandle {
    const permissions = entry as unknown as PermissionCapable;
    const root = {
        kind: 'directory' as const,
        name: '',
        async getDirectoryHandle(name: string) {
            if (
                name === entry.name &&
                entry instanceof FileSystemDirectoryHandle
            ) {
                return entry;
            }
            throw notFound(name);
        },
        async getFileHandle(name: string) {
            if (name === entry.name && entry instanceof FileSystemFileHandle) {
                return entry;
            }
            throw notFound(name);
        },
        async removeEntry(name: string) {
            throw new DOMException(
                `${name} can’t be removed from here`,
                'NotAllowedError'
            );
        },
        async *entries() {
            yield [entry.name, entry] as [string, FileSystemHandle];
        },
        async *keys() {
            yield entry.name;
        },
        async *values() {
            yield entry;
        },
        async isSameEntry(other: FileSystemHandle) {
            return other === (root as unknown as FileSystemHandle);
        },
        async resolve(other: FileSystemHandle) {
            if (await entry.isSameEntry(other)) return [entry.name];
            if (entry instanceof FileSystemDirectoryHandle) {
                const inside = await entry.resolve(other);
                return inside ? [entry.name, ...inside] : null;
            }
            return null;
        },
        queryPermission: (options: { mode: 'read' | 'readwrite' }) =>
            permissions.queryPermission(options),
        requestPermission: (options: { mode: 'read' | 'readwrite' }) =>
            permissions.requestPermission(options)
    };
    return root as unknown as FileSystemDirectoryHandle;
}

export class DocumentRootAdapter extends NativeAdapter {
    private document: DiskDocument | null = null;

    constructor() {
        // The key is never written: this adapter's root comes from a document.
        super('disk-document-root');
    }

    /** Root the adapter at `doc`; the font's path is then `/<doc.name>`. */
    attach(doc: DiskDocument): void {
        this.document = doc;
        this.directoryHandle = doc.parent ?? singleEntryRoot(doc.handle);
        this.rootPath = '/';
    }

    detach(): void {
        this.document = null;
        this.directoryHandle = null;
        this.rootPath = '';
    }

    get attachedDocument(): DiskDocument | null {
        return this.document;
    }

    override async initialize(): Promise<boolean> {
        return this.directoryHandle !== null;
    }

    /** The real handle to watch for outside changes. */
    watchHandle(): FileSystemHandle | null {
        return this.document?.parent ?? this.document?.handle ?? null;
    }
}
