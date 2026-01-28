// File System Adapter
// Abstraction layer for OPFS (memory) and File System Access API (disk)

import { createWorker, OPFSFileSystem } from 'opfs-worker';
import { get, set, del } from 'idb-keyval';

export interface FileInfo {
    path: string;
    is_dir: boolean;
    size: number;
    mtime: string;
    handle?: FileSystemFileHandle | FileSystemDirectoryHandle;
}

export interface FileSystemAdapter {
    scanDirectory(path: string): Promise<Record<string, FileInfo>>;
    readFile(path: string): Promise<string | Uint8Array>;
    writeFile(path: string, content: string | Uint8Array): Promise<void>;
    createFolder(path: string): Promise<void>;
    deleteItem(path: string, isDir: boolean): Promise<void>;
    fileExists(path: string): Promise<boolean>;
    checkPermission?(): Promise<PermissionState>;
    requestPermission?(): Promise<PermissionState>;
}

// OPFS Adapter for memory-based file system
export class OPFSAdapter implements FileSystemAdapter {
    private fs: OPFSFileSystem | null = null;

    private async getFS(): Promise<OPFSFileSystem> {
        if (!this.fs) {
            this.fs = await createWorker();
        }
        return this.fs;
    }

    async scanDirectory(path: string = '/'): Promise<Record<string, FileInfo>> {
        try {
            const fs = await this.getFS();
            const dirHandle = await fs.readDir(path);
            const items: Record<string, FileInfo> = {};

            for (const dirEnt of dirHandle || []) {
                const is_dir = dirEnt.kind === 'directory';
                let size = 0;
                let mtime = '';
                const name = dirEnt.name;
                const itemPath = path === '/' ? `/${name}` : `${path}/${name}`;

                if (!is_dir) {
                    const fullPath =
                        path === '/'
                            ? `/${dirEnt.name}`
                            : `${path}/${dirEnt.name}`;
                    try {
                        const stat = await fs.stat(fullPath);
                        size = stat.size;
                        mtime = stat.mtime;
                    } catch (e) {
                        continue;
                    }
                }

                items[name] = { path: itemPath, is_dir, size, mtime };
            }

            return items;
        } catch (error: any) {
            console.error('[OPFSAdapter]', 'Error scanning directory:', error);
            return {};
        }
    }

    async readFile(path: string): Promise<string | Uint8Array> {
        const fs = await this.getFS();
        // Force binary mode since files are written as Uint8Array
        // This prevents UTF-8 decoding corruption of binary plist files
        return await fs.readFile(path, 'binary');
    }

    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
        const fs = await this.getFS();
        // Force binary mode for consistent Uint8Array handling
        await fs.writeFile(path, content, 'binary');
    }

    async createFolder(path: string): Promise<void> {
        const fs = await this.getFS();
        await fs.mkdir(path, { recursive: true });
    }

    async deleteItem(path: string, isDir: boolean): Promise<void> {
        const fs = await this.getFS();
        await fs.remove(path, { recursive: isDir });
    }

    async fileExists(path: string): Promise<boolean> {
        try {
            const fs = await this.getFS();
            await fs.stat(path);
            return true;
        } catch (error) {
            return false;
        }
    }
}

// Native File System Access API Adapter for disk-based file system
export class NativeAdapter implements FileSystemAdapter {
    private directoryHandle: FileSystemDirectoryHandle | null = null;
    private rootPath: string = '';
    private static readonly STORAGE_KEY = 'disk-directory-handle';

    async initialize(): Promise<boolean> {
        // Try to restore persisted directory handle
        const handle = await get(NativeAdapter.STORAGE_KEY);
        if (handle && handle instanceof FileSystemDirectoryHandle) {
            this.directoryHandle = handle;
            this.rootPath = '/';
            console.log(
                '[NativeAdapter]',
                'Restored directory handle:',
                handle.name
            );
            return true;
        }
        return false;
    }

    async selectDirectory(): Promise<void> {
        try {
            const handle = await (window as any).showDirectoryPicker({
                mode: 'readwrite'
            });
            this.directoryHandle = handle;
            this.rootPath = '/';

            // Persist handle in IndexedDB
            await set(NativeAdapter.STORAGE_KEY, handle);

            // Request permission immediately
            await this.requestPermission();

            console.log('[NativeAdapter]', 'Selected directory:', handle.name);
        } catch (error: any) {
            if (error.name === 'AbortError') {
                console.log('[NativeAdapter]', 'Directory selection cancelled');
            } else {
                console.error(
                    '[NativeAdapter]',
                    'Error selecting directory:',
                    error
                );
                throw error;
            }
        }
    }

    async clearDirectory(): Promise<void> {
        await del(NativeAdapter.STORAGE_KEY);
        this.directoryHandle = null;
        this.rootPath = '';
        console.log('[NativeAdapter]', 'Directory handle cleared');
    }

    hasDirectory(): boolean {
        return this.directoryHandle !== null;
    }

    getDirectoryName(): string {
        return this.directoryHandle?.name || '';
    }

    async checkPermission(): Promise<PermissionState> {
        if (!this.directoryHandle) {
            return 'prompt';
        }
        try {
            const permission = await (
                this.directoryHandle as any
            ).queryPermission({ mode: 'readwrite' });
            return permission;
        } catch (error) {
            console.error(
                '[NativeAdapter]',
                'Error checking permission:',
                error
            );
            return 'denied';
        }
    }

    async requestPermission(): Promise<PermissionState> {
        if (!this.directoryHandle) {
            return 'prompt';
        }
        try {
            const permission = await (
                this.directoryHandle as any
            ).requestPermission({ mode: 'readwrite' });
            console.log('[NativeAdapter]', 'Permission status:', permission);
            return permission;
        } catch (error) {
            console.error(
                '[NativeAdapter]',
                'Error requesting permission:',
                error
            );
            return 'denied';
        }
    }

    async getHandleAtPath(
        path: string
    ): Promise<FileSystemFileHandle | FileSystemDirectoryHandle> {
        if (!this.directoryHandle) {
            throw new Error('No directory selected');
        }

        // Normalize path
        const normalizedPath = path.replace(/^\/+/, '');
        if (!normalizedPath) {
            return this.directoryHandle;
        }

        const parts = normalizedPath.split('/');
        let currentHandle: FileSystemDirectoryHandle = this.directoryHandle;

        for (let i = 0; i < parts.length - 1; i++) {
            currentHandle = await currentHandle.getDirectoryHandle(parts[i]);
        }

        const lastName = parts[parts.length - 1];
        try {
            return await currentHandle.getFileHandle(lastName);
        } catch {
            return await currentHandle.getDirectoryHandle(lastName);
        }
    }

    async scanDirectory(path: string = '/'): Promise<Record<string, FileInfo>> {
        if (!this.directoryHandle) {
            return {};
        }

        try {
            const handle = await this.getHandleAtPath(path);
            if (!(handle instanceof FileSystemDirectoryHandle)) {
                return {};
            }

            const items: Record<string, FileInfo> = {};

            for await (const [name, childHandle] of (handle as any).entries()) {
                const is_dir = childHandle.kind === 'directory';
                const itemPath = path === '/' ? `/${name}` : `${path}/${name}`;
                let size = 0;
                let mtime = '';

                if (!is_dir && childHandle instanceof FileSystemFileHandle) {
                    try {
                        const file = await childHandle.getFile();
                        size = file.size;
                        mtime = new Date(file.lastModified).toISOString();
                    } catch (e) {
                        continue;
                    }
                }

                items[name] = {
                    path: itemPath,
                    is_dir,
                    size,
                    mtime,
                    handle: childHandle
                };
            }

            return items;
        } catch (error: any) {
            console.error(
                '[NativeAdapter]',
                'Error scanning directory:',
                error
            );
            return {};
        }
    }

    async readFile(path: string): Promise<string | Uint8Array> {
        const handle = await this.getHandleAtPath(path);
        if (!(handle instanceof FileSystemFileHandle)) {
            throw new Error('Path is not a file');
        }

        const file = await handle.getFile();
        const arrayBuffer = await file.arrayBuffer();
        return new Uint8Array(arrayBuffer);
    }

    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
        const handle = await this.getHandleAtPath(path);
        if (!(handle instanceof FileSystemFileHandle)) {
            throw new Error('Path is not a file');
        }

        const writable = await handle.createWritable();
        if (typeof content === 'string') {
            await writable.write(content);
        } else {
            await writable.write(new Uint8Array(content as any));
        }
        await writable.close();
    }

    async createFolder(path: string): Promise<void> {
        if (!this.directoryHandle) {
            throw new Error('No directory selected');
        }

        const normalizedPath = path.replace(/^\/+/, '');
        const parts = normalizedPath.split('/');
        let currentHandle: FileSystemDirectoryHandle = this.directoryHandle;

        for (const part of parts) {
            currentHandle = await currentHandle.getDirectoryHandle(part, {
                create: true
            });
        }
    }

    async deleteItem(path: string, isDir: boolean): Promise<void> {
        if (!this.directoryHandle) {
            throw new Error('No directory selected');
        }

        const normalizedPath = path.replace(/^\/+/, '');
        const parts = normalizedPath.split('/');
        const fileName = parts.pop()!;

        let currentHandle: FileSystemDirectoryHandle = this.directoryHandle;
        for (const part of parts) {
            currentHandle = await currentHandle.getDirectoryHandle(part);
        }

        await currentHandle.removeEntry(fileName, { recursive: isDir });
    }

    async getFileHandle(path: string): Promise<FileSystemFileHandle | null> {
        try {
            const handle = await this.getHandleAtPath(path);
            if (handle instanceof FileSystemFileHandle) {
                return handle;
            }
        } catch (error) {
            console.error(
                '[NativeAdapter]',
                'Error getting file handle:',
                error
            );
        }
        return null;
    }

    async fileExists(path: string): Promise<boolean> {
        try {
            await this.getHandleAtPath(path);
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Recursively list all files in a directory up to maxDepth levels
     * @param path Starting path
     * @param maxDepth Maximum depth to traverse (default 3)
     * @returns Array of FileInfo for all files found
     */
    async listFilesRecursive(
        path: string = '/',
        maxDepth: number = 3
    ): Promise<FileInfo[]> {
        if (!this.directoryHandle) {
            return [];
        }

        const results: FileInfo[] = [];

        const scanDir = async (
            dirPath: string,
            depth: number
        ): Promise<void> => {
            if (depth > maxDepth) return;

            try {
                const handle = await this.getHandleAtPath(dirPath);
                if (!(handle instanceof FileSystemDirectoryHandle)) {
                    return;
                }

                for await (const [name, childHandle] of (
                    handle as any
                ).entries()) {
                    const isDir = childHandle.kind === 'directory';
                    const itemPath =
                        dirPath === '/' ? `/${name}` : `${dirPath}/${name}`;

                    if (isDir) {
                        await scanDir(itemPath, depth + 1);
                    } else {
                        let size = 0;
                        let mtime = '';
                        try {
                            const file = await childHandle.getFile();
                            size = file.size;
                            mtime = new Date(file.lastModified).toISOString();
                        } catch (e) {
                            continue;
                        }
                        results.push({
                            path: itemPath,
                            is_dir: false,
                            size,
                            mtime,
                            handle: childHandle
                        });
                    }
                }
            } catch (error) {
                // Directory doesn't exist or can't be read
                console.log(
                    '[NativeAdapter]',
                    `Cannot scan ${dirPath}:`,
                    error
                );
            }
        };

        await scanDir(path, 1);
        return results;
    }
}

// Check if File System Access API is supported
export function isFileSystemAccessSupported(): boolean {
    return 'showDirectoryPicker' in window;
}
