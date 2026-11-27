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

async function requestShareApi<T = Record<string, unknown>>(
    plugin,
    pathSuffix: string,
    options: {
        assetId?: string;
        method?: string;
        body?: unknown;
        defaultError: string;
        rawErrorPrefix?: string;
    }
): Promise<{ assetId: string; data: T }> {
    const user = await plugin._ensureCloudUser({
        allowSignInPrompt: true
    });
    if (!user) {
        throw new Error('Authentication required');
    }

    const resolvedAssetId = plugin._resolveShareAssetId(options.assetId);
    const hasBody = options.body !== undefined;
    const init: RequestInit = {
        ...(options.method ? { method: options.method } : {}),
        credentials: 'include',
        headers: getCloudRequestHeaders(
            hasBody ? { 'Content-Type': 'application/json' } : undefined
        ),
        ...(hasBody ? { body: JSON.stringify(options.body) } : {})
    };
    const resp = await fetch(
        `${plugin._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(resolvedAssetId)}${pathSuffix}`,
        init
    );

    if (options.rawErrorPrefix) {
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            throw new Error(
                `${options.rawErrorPrefix}: ${resp.status} ${body}`
            );
        }
        return {
            assetId: resolvedAssetId,
            data: (await resp.json()) as T
        };
    }

    const data = (await resp.json().catch(() => ({}))) as T & {
        error?: string;
    };
    if (!resp.ok) {
        throw new Error(data.error || options.defaultError);
    }
    return { assetId: resolvedAssetId, data };
}

export const cloudPluginSharingMethods = {
    _resolveShareAssetId(assetId?: string): string {
        const resolvedAssetId = assetId || this.getCurrentAssetIdForSharing();
        if (!resolvedAssetId) {
            throw new Error('No cloud asset is currently open');
        }
        return resolvedAssetId;
    },

    async getShareState(assetId?: string): Promise<CloudShareState> {
        const { assetId: resolvedAssetId, data: shareState } =
            await requestShareApi<CloudShareState>(this, '/members', {
                assetId,
                defaultError: 'Failed to load sharing settings',
                rawErrorPrefix: 'Failed to load sharing settings'
            });
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
        const { data } = await requestShareApi<{
            invitation?: CloudAssetInvitation;
            inviteUrl?: string;
        }>(this, '/invitations', {
            assetId,
            method: 'POST',
            body: { email, role },
            defaultError: 'Failed to create invitation'
        });

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
        const { data } = await requestShareApi<{
            ownershipTransfer?: CloudOwnershipTransfer;
            transferUrl?: string;
        }>(this, '/ownership-transfer', {
            assetId,
            method: 'POST',
            body: { email, previousOwnerRole },
            defaultError: 'Failed to create ownership transfer'
        });

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
        await requestShareApi(this, '/ownership-transfer', {
            assetId,
            method: 'DELETE',
            body: {},
            defaultError: 'Failed to cancel ownership transfer'
        });
    },

    async revokeInvitation(
        invitationId: string,
        assetId?: string
    ): Promise<void> {
        await requestShareApi(
            this,
            `/invitations/${encodeURIComponent(invitationId)}`,
            {
                assetId,
                method: 'POST',
                defaultError: 'Failed to revoke invitation'
            }
        );
    },

    async updateMemberRole(
        userId: string,
        role: 'editor' | 'viewer',
        assetId?: string
    ): Promise<void> {
        await requestShareApi(this, `/members/${encodeURIComponent(userId)}`, {
            assetId,
            method: 'PATCH',
            body: { role },
            defaultError: 'Failed to update member role'
        });
    },

    async removeMember(userId: string, assetId?: string): Promise<void> {
        const { data } = await requestShareApi<{
            accessChange?: { state?: string; warning?: string };
        }>(this, `/members/${encodeURIComponent(userId)}`, {
            assetId,
            method: 'DELETE',
            body: {},
            defaultError: 'Failed to remove member'
        });
        if (data.accessChange?.state && data.accessChange.state !== 'applied') {
            console.warn(
                data.accessChange.warning ||
                    'Member removed, but room access revocation is still pending'
            );
        }
    }
};
