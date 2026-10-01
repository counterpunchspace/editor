// @ts-nocheck
/**
 * CloudAdapter FileSystemAdapter stubs (directory listing + CRUD).
 * Installed onto CloudAdapter.prototype from cloud-adapter.ts.
 */
import type { FileInfo } from './file-system-adapter';
import { getCloudRequestHeaders } from './cloud-adapter-support';
import { deleteCloudAssetUntilComplete } from './cloud-delete-asset';
import type { CloudAssetRole } from './cloud-adapter-support';

export const cloudAdapterFsMethods = {
    async scanDirectory(_path: string): Promise<Record<string, FileInfo>> {
        try {
            const resp = await fetch(
                `${this._websiteBaseUrl}/api/cloud/assets`,
                {
                    credentials: 'include',
                    headers: getCloudRequestHeaders()
                }
            );
            if (!resp.ok) {
                return {};
            }
            const data = (await resp.json()) as {
                assets: Array<{
                    id: string;
                    name: string;
                    updatedAt: number;
                    role?: CloudAssetRole;
                    connectedPeers?: number;
                }>;
            };
            const items: Record<string, FileInfo> = {};
            this._assetRoles.clear();
            for (const asset of data.assets ?? []) {
                if (asset.role) {
                    this._assetRoles.set(asset.id, asset.role);
                }
                const displayName = asset.name.endsWith('.babelfont')
                    ? asset.name
                    : `${asset.name}.babelfont`;
                items[displayName] = {
                    path: `cloud://${asset.id}`,
                    is_dir: false,
                    mtime: new Date(asset.updatedAt).toISOString(),
                    ...(asset.role ? { cloudRole: asset.role } : {}),
                    ...(typeof asset.connectedPeers === 'number'
                        ? { cloudConnectedPeers: asset.connectedPeers }
                        : {})
                };
            }
            return items;
        } catch {
            return {};
        }
    },

    async readFile(_path: string): Promise<string | Uint8Array> {
        throw new Error('CloudAdapter.readFile not implemented in Phase 0');
    },

    async writeFile(
        _path: string,
        _content: string | Uint8Array
    ): Promise<void> {
        throw new Error('CloudAdapter.writeFile not implemented in Phase 0');
    },

    async createFolder(_path: string): Promise<void> {
        throw new Error('CloudAdapter.createFolder not implemented in Phase 0');
    },

    async deleteItem(path: string, isDir: boolean): Promise<void> {
        if (isDir) {
            throw new Error('Cloud folders are not supported');
        }

        const assetId = path.replace(/^cloud:\/\//, '').trim();
        if (!assetId) {
            throw new Error('Missing cloud asset id');
        }

        await deleteCloudAssetUntilComplete({
            websiteBaseUrl: this._websiteBaseUrl,
            assetId
        });
        if (this._assetId === assetId) {
            this.disconnect();
        }
    },

    async renameItem(
        _oldPath: string,
        _newName: string,
        _isDir: boolean
    ): Promise<void> {
        throw new Error('CloudAdapter.renameItem not implemented in Phase 0');
    },

    async fileExists(_path: string): Promise<boolean> {
        return false;
    }
};
