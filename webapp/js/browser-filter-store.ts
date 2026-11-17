/**
 * User filters kept in the browser (OPFS) when no Settings Folder is set
 * up, such as the filter the tour creates. Paths are the same as in the
 * Settings Folder (`/Filters/...`); they live under `/settings` in OPFS,
 * outside the Memory plugin's `/user`.
 */

import { OPFSAdapter, type FileInfo } from './file-system-adapter';

const ROOT = '/settings';

export class BrowserFilterStore {
    private readonly fs = new OPFSAdapter();

    private full(path: string): string {
        return path === '/' ? ROOT : `${ROOT}${path}`;
    }

    private relative(path: string): string {
        return path.startsWith(ROOT) ? path.slice(ROOT.length) || '/' : path;
    }

    async scanDirectory(path: string): Promise<Record<string, FileInfo>> {
        const entries = await this.fs.scanDirectory(this.full(path));
        const result: Record<string, FileInfo> = {};
        for (const [name, info] of Object.entries(entries)) {
            result[name] = { ...info, path: this.relative(info.path) };
        }
        return result;
    }

    readFile(path: string): Promise<string | Uint8Array> {
        return this.fs.readFile(this.full(path));
    }

    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
        const folder = path.slice(0, path.lastIndexOf('/'));
        if (folder) {
            await this.fs.createFolder(this.full(folder));
        }
        // OPFS stores bytes; readers decode them as UTF-8.
        await this.fs.writeFile(
            this.full(path),
            typeof content === 'string'
                ? new TextEncoder().encode(content)
                : content
        );
    }

    createFolder(path: string): Promise<void> {
        return this.fs.createFolder(this.full(path));
    }

    deleteItem(path: string, isDir: boolean): Promise<void> {
        return this.fs.deleteItem(this.full(path), isDir);
    }

    renameItem(
        oldPath: string,
        newName: string,
        isDir: boolean
    ): Promise<void> {
        return this.fs.renameItem(this.full(oldPath), newName, isDir);
    }

    fileExists(path: string): Promise<boolean> {
        return this.fs.fileExists(this.full(path));
    }

    async listFilesRecursive(path: string, maxDepth = 3): Promise<FileInfo[]> {
        const files: FileInfo[] = [];
        const scan = async (dir: string, depth: number) => {
            if (depth > maxDepth) return;
            for (const info of Object.values(await this.scanDirectory(dir))) {
                if (info.is_dir) {
                    await scan(info.path, depth + 1);
                } else {
                    files.push(info);
                }
            }
        };
        if (await this.fileExists(path)) {
            await scan(path, 0);
        }
        return files;
    }
}

export const browserFilterStore = new BrowserFilterStore();
