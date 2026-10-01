// @ts-nocheck
/**
 * CloudPlugin sharing / membership / ownership-transfer API.
 * Installed onto CloudPlugin.prototype from cloud-plugin.ts.
 */
import { getCloudRequestHeaders } from '../../cloud-adapter-support';
import type {
    CloudAssetInvitation,
    CloudOwnershipTransfer,
    CloudShareState
} from './cloud-plugin-support';

export const cloudPluginSharingMethods = {
    _resolveShareAssetId(assetId?: string): string {
        const resolvedAssetId = assetId || this.getCurrentAssetIdForSharing();
        if (!resolvedAssetId) {
            throw new Error('No cloud asset is currently open');
        }
        return resolvedAssetId;
    },

    async getShareState(assetId?: string): Promise<CloudShareState> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            throw new Error('Authentication required');
        }

        const resolvedAssetId = this._resolveShareAssetId(assetId);
        const resp = await fetch(
            `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(resolvedAssetId)}/members`,
            {
                credentials: 'include',
                headers: getCloudRequestHeaders()
            }
        );

        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            throw new Error(
                `Failed to load sharing settings: ${resp.status} ${body}`
            );
        }

        const shareState = (await resp.json()) as CloudShareState;
        this._cacheAssetRole(resolvedAssetId, shareState.asset.role);
        return shareState;
    },

    async inviteUser(
        email: string,
        role: 'editor' | 'viewer',
        assetId?: string
    ): Promise<{
        invitation: CloudAssetInvitation;
        inviteUrl?: string;
    }> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            throw new Error('Authentication required');
        }

        const resolvedAssetId = this._resolveShareAssetId(assetId);
        const resp = await fetch(
            `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(resolvedAssetId)}/invitations`,
            {
                method: 'POST',
                credentials: 'include',
                headers: getCloudRequestHeaders({
                    'Content-Type': 'application/json'
                }),
                body: JSON.stringify({ email, role })
            }
        );

        const data = (await resp.json().catch(() => ({}))) as {
            error?: string;
            invitation?: CloudAssetInvitation;
            inviteUrl?: string;
        };
        if (!resp.ok) {
            throw new Error(data.error || 'Failed to create invitation');
        }

        if (!data.invitation) {
            throw new Error('Invitation response missing invitation data');
        }

        return {
            invitation: data.invitation,
            ...(data.inviteUrl ? { inviteUrl: data.inviteUrl } : {})
        };
    },

    async createOwnershipTransfer(
        email: string,
        previousOwnerRole: 'editor' | 'viewer' | 'remove',
        assetId?: string
    ): Promise<{
        ownershipTransfer: CloudOwnershipTransfer;
        transferUrl?: string;
    }> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            throw new Error('Authentication required');
        }

        const resolvedAssetId = this._resolveShareAssetId(assetId);
        const resp = await fetch(
            `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(resolvedAssetId)}/ownership-transfer`,
            {
                method: 'POST',
                credentials: 'include',
                headers: getCloudRequestHeaders({
                    'Content-Type': 'application/json'
                }),
                body: JSON.stringify({ email, previousOwnerRole })
            }
        );

        const data = (await resp.json().catch(() => ({}))) as {
            error?: string;
            ownershipTransfer?: CloudOwnershipTransfer;
            transferUrl?: string;
        };
        if (!resp.ok) {
            throw new Error(
                data.error || 'Failed to create ownership transfer'
            );
        }

        if (!data.ownershipTransfer) {
            throw new Error(
                'Ownership transfer response missing transfer data'
            );
        }

        return {
            ownershipTransfer: data.ownershipTransfer,
            ...(data.transferUrl ? { transferUrl: data.transferUrl } : {})
        };
    },

    async cancelOwnershipTransfer(assetId?: string): Promise<void> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            throw new Error('Authentication required');
        }

        const resolvedAssetId = this._resolveShareAssetId(assetId);
        const resp = await fetch(
            `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(resolvedAssetId)}/ownership-transfer`,
            {
                method: 'DELETE',
                credentials: 'include',
                headers: getCloudRequestHeaders({
                    'Content-Type': 'application/json'
                }),
                body: '{}'
            }
        );

        const data = (await resp.json().catch(() => ({}))) as {
            error?: string;
        };
        if (!resp.ok) {
            throw new Error(
                data.error || 'Failed to cancel ownership transfer'
            );
        }
    },

    async revokeInvitation(
        invitationId: string,
        assetId?: string
    ): Promise<void> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            throw new Error('Authentication required');
        }

        const resolvedAssetId = this._resolveShareAssetId(assetId);
        const resp = await fetch(
            `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(resolvedAssetId)}/invitations/${encodeURIComponent(invitationId)}`,
            {
                method: 'POST',
                credentials: 'include',
                headers: getCloudRequestHeaders()
            }
        );

        const data = (await resp.json().catch(() => ({}))) as {
            error?: string;
        };
        if (!resp.ok) {
            throw new Error(data.error || 'Failed to revoke invitation');
        }
    },

    async updateMemberRole(
        userId: string,
        role: 'editor' | 'viewer',
        assetId?: string
    ): Promise<void> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            throw new Error('Authentication required');
        }

        const resolvedAssetId = this._resolveShareAssetId(assetId);
        const resp = await fetch(
            `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(resolvedAssetId)}/members/${encodeURIComponent(userId)}`,
            {
                method: 'PATCH',
                credentials: 'include',
                headers: getCloudRequestHeaders({
                    'Content-Type': 'application/json'
                }),
                body: JSON.stringify({ role })
            }
        );

        const data = (await resp.json().catch(() => ({}))) as {
            error?: string;
        };
        if (!resp.ok) {
            throw new Error(data.error || 'Failed to update member role');
        }
    },

    async removeMember(userId: string, assetId?: string): Promise<void> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            throw new Error('Authentication required');
        }

        const resolvedAssetId = this._resolveShareAssetId(assetId);
        const resp = await fetch(
            `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(resolvedAssetId)}/members/${encodeURIComponent(userId)}`,
            {
                method: 'DELETE',
                credentials: 'include',
                headers: getCloudRequestHeaders({
                    'Content-Type': 'application/json'
                }),
                body: '{}'
            }
        );

        const data = (await resp.json().catch(() => ({}))) as {
            error?: string;
            accessChange?: { state?: string; warning?: string };
        };
        if (!resp.ok) {
            throw new Error(data.error || 'Failed to remove member');
        }
        if (data.accessChange?.state && data.accessChange.state !== 'applied') {
            console.warn(
                data.accessChange.warning ||
                    'Member removed, but room access revocation is still pending'
            );
        }
    }
};
