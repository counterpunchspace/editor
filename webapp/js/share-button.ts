// Share Button
// Title-bar control and share dialog. Markup is built in this file; chrome
// uses the shared info-popup / dialog-button / dialog-input styles in
// css/ui/dialogs.css.

import type {
    CloudAssetInvitation,
    CloudAssetMember,
    CloudOwnershipTransfer,
    CloudPlugin,
    CloudShareState
} from './filesystem-plugins/plugins/cloud-plugin';
import { Logger } from './logger';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';

const console = new Logger('ShareButton');

let shareDialogOverlay: HTMLDivElement | null = null;
let shareDialogEscapeBinding: ModalEscapeBinding | null = null;

type ShareRole = 'editor' | 'viewer';
type PreviousOwnerPolicy = ShareRole | 'remove';

type ShareDialogState = {
    isOpen: boolean;
    isLoading: boolean;
    isSubmitting: boolean;
    error: string | null;
    notice: string | null;
    shareState: CloudShareState | null;
    inviteEmail: string;
    inviteRole: ShareRole;
    transferEmail: string;
    previousOwnerRole: PreviousOwnerPolicy;
    latestInviteUrl: string | null;
    latestTransferUrl: string | null;
};

let shareDialogState: ShareDialogState = {
    isOpen: false,
    isLoading: false,
    isSubmitting: false,
    error: null,
    notice: null,
    shareState: null,
    inviteEmail: '',
    inviteRole: 'editor',
    transferEmail: '',
    previousOwnerRole: 'editor',
    latestInviteUrl: null,
    latestTransferUrl: null
};

function getCloudPlugin(): CloudPlugin | null {
    return window.cloudPlugin || null;
}

function isCloudShareAvailable(): boolean {
    const cloudPlugin = getCloudPlugin();
    if (!cloudPlugin || cloudPlugin.isVisibleInUI() === false) {
        return false;
    }

    return !!cloudPlugin.getCurrentAssetIdForSharing();
}

function escapeHtml(value: string | null | undefined): string {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatTimestamp(timestamp: number | null | undefined): string {
    if (!timestamp) {
        return 'Unknown time';
    }
    return new Date(timestamp).toLocaleString();
}

async function copyToClipboard(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (error) {
        console.error('[ShareButton]', 'Failed to copy to clipboard:', error);
        return false;
    }
}

function formatRole(role: string | null | undefined): string {
    if (!role) {
        return 'Unknown';
    }
    return role.charAt(0).toUpperCase() + role.slice(1);
}

function formatPreviousOwnerPolicy(
    policy: PreviousOwnerPolicy | null | undefined
): string {
    if (policy === 'remove') {
        return 'Removed entirely';
    }
    return `Kept as ${formatRole(policy)}`;
}

function renderMemberRow(
    member: CloudAssetMember,
    canManage: boolean,
    ownerUserId: string
): string {
    const isOwner = member.userId === ownerUserId || member.role === 'owner';
    const controls =
        canManage && !isOwner
            ? `
            <form class="share-dialog-form" data-user-id="${escapeHtml(member.userId)}" data-share-role-form>
                <select class="dialog-input" name="role">
                    <option value="editor" ${member.role === 'editor' ? 'selected' : ''}>Editor</option>
                    <option value="viewer" ${member.role === 'viewer' ? 'selected' : ''}>Viewer</option>
                </select>
                <button type="submit" class="dialog-button">Update</button>
                <button type="button" class="dialog-button dialog-button-danger" data-share-dialog-action="remove-member" data-user-id="${escapeHtml(member.userId)}">Remove</button>
            </form>
        `
            : '';

    return `
        <li class="share-dialog-row">
            <div>
                <strong>${escapeHtml(member.email)}</strong>
                <p>
                    ${isOwner ? 'Owner' : formatRole(member.role)}
                    ${member.invitedByEmail ? ` · Invited by ${escapeHtml(member.invitedByEmail)}` : ''}
                    · Added ${escapeHtml(formatTimestamp(member.createdAt))}
                </p>
            </div>
            ${controls}
        </li>
    `;
}

function renderInvitationRow(
    invitation: CloudAssetInvitation,
    canManage: boolean
): string {
    return `
        <li class="share-dialog-row">
            <div>
                <strong>${escapeHtml(invitation.email)}</strong>
                <p>
                    Pending ${formatRole(invitation.role).toLowerCase()}
                    ${invitation.targetUserEmail ? ` · Matches ${escapeHtml(invitation.targetUserEmail)}` : ''}
                    · Sent ${escapeHtml(formatTimestamp(invitation.lastSentAt || invitation.createdAt))}
                </p>
            </div>
            ${canManage ? `<button type="button" class="dialog-button dialog-button-danger" data-share-dialog-action="revoke-invite" data-invitation-id="${escapeHtml(invitation.id)}">Revoke</button>` : ''}
        </li>
    `;
}

function renderOwnershipTransferCard(
    ownershipTransfer: CloudOwnershipTransfer
): string {
    return `
        <div class="share-dialog-row">
            <div>
                <strong>Pending transfer to ${escapeHtml(ownershipTransfer.email)}</strong>
                <p>
                    ${escapeHtml(formatPreviousOwnerPolicy(ownershipTransfer.previousOwnerRole))}
                    ${ownershipTransfer.targetUserEmail ? ` · Matches ${escapeHtml(ownershipTransfer.targetUserEmail)}` : ''}
                    · Requested ${escapeHtml(formatTimestamp(ownershipTransfer.createdAt))}
                    ${ownershipTransfer.expiresAt ? ` · Expires ${escapeHtml(formatTimestamp(ownershipTransfer.expiresAt))}` : ''}
                </p>
            </div>
            <button type="button" class="dialog-button dialog-button-danger" data-share-dialog-action="cancel-transfer">Cancel</button>
        </div>
    `;
}

function renderShareDialog(): void {
    if (!shareDialogOverlay) {
        return;
    }

    const shareState = shareDialogState.shareState;
    const assetRole = shareState?.asset?.role || '';
    const canManage = shareState?.permissions?.canManage === true;
    const canViewMembers = assetRole !== 'viewer';
    const ownerUserId = shareState?.asset?.ownerUserId || '';
    const ownerEmail = shareState?.asset?.ownerEmail || null;
    const ownershipTransfer = shareState?.ownershipTransfer || null;
    const title = shareState?.asset?.name || 'Share Font';
    const showDevelopmentLinks = window.isDevelopment?.() ?? false;

    shareDialogOverlay.innerHTML = `
        <div class="info-popup share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title">
            <div class="info-popup-header">
                <h3 id="share-dialog-title">Share</h3>
                <button type="button" class="info-popup-close" data-share-dialog-action="close" aria-label="Close">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="info-popup-content">
                <p>
                    ${
                        shareState
                            ? `<strong>${escapeHtml(title)}</strong> · ${formatRole(shareState.asset.role)} access${ownerEmail ? ` · Owner ${escapeHtml(ownerEmail)}` : ''}`
                            : 'Load sharing settings for this cloud font.'
                    }
                </p>
                ${shareDialogState.error ? `<p role="alert">${escapeHtml(shareDialogState.error)}</p>` : ''}
                ${shareDialogState.notice ? `<div class="info-highlight"><p>${escapeHtml(shareDialogState.notice)}</p></div>` : ''}
                ${
                    showDevelopmentLinks && shareDialogState.latestInviteUrl
                        ? `
                    <div class="info-highlight">
                        <strong>Latest invite link</strong>
                        <p>Use this to test acceptance locally if email delivery is stubbed.</p>
                        <div class="share-dialog-form">
                            <input class="dialog-input" type="text" readonly value="${escapeHtml(shareDialogState.latestInviteUrl)}" />
                            <button type="button" class="dialog-button" data-share-dialog-action="copy-latest-link">Copy</button>
                        </div>
                    </div>
                `
                        : ''
                }
                ${
                    showDevelopmentLinks && shareDialogState.latestTransferUrl
                        ? `
                    <div class="info-highlight">
                        <strong>Latest transfer link</strong>
                        <p>Use this to review the ownership transfer locally if email delivery is stubbed.</p>
                        <div class="share-dialog-form">
                            <input class="dialog-input" type="text" readonly value="${escapeHtml(shareDialogState.latestTransferUrl)}" />
                            <button type="button" class="dialog-button" data-share-dialog-action="copy-latest-transfer-link">Copy</button>
                        </div>
                    </div>
                `
                        : ''
                }
                ${
                    shareDialogState.isLoading
                        ? `<p>Loading sharing settings…</p>`
                        : ''
                }
                ${
                    shareState
                        ? `
                    ${
                        canManage
                            ? `
                        <section class="share-dialog-section">
                            <h4>Invite people</h4>
                            <p>Invite by email. Editors can change the font; viewers cannot.</p>
                            <form class="share-dialog-form" data-share-invite-form>
                                <input class="dialog-input" type="email" name="email" placeholder="name@example.com" value="${escapeHtml(shareDialogState.inviteEmail)}" ${shareDialogState.isSubmitting ? 'disabled' : ''} required />
                                <select class="dialog-input" name="role" ${shareDialogState.isSubmitting ? 'disabled' : ''}>
                                    <option value="editor" ${shareDialogState.inviteRole === 'editor' ? 'selected' : ''}>Editor</option>
                                    <option value="viewer" ${shareDialogState.inviteRole === 'viewer' ? 'selected' : ''}>Viewer</option>
                                </select>
                                <button type="submit" class="dialog-button dialog-button-primary" ${shareDialogState.isSubmitting ? 'disabled' : ''}>${shareDialogState.isSubmitting ? 'Sending…' : 'Send invite'}</button>
                            </form>
                        </section>

                        <section class="share-dialog-section">
                            <h4>Transfer ownership</h4>
                            <p>If they accept, you keep the selected access or are removed.</p>
                            ${ownershipTransfer ? renderOwnershipTransferCard(ownershipTransfer) : '<p>No pending transfer.</p>'}
                            <form class="share-dialog-form" data-share-transfer-form>
                                <input class="dialog-input" type="email" name="email" placeholder="new-owner@example.com" value="${escapeHtml(shareDialogState.transferEmail)}" ${shareDialogState.isSubmitting ? 'disabled' : ''} required />
                                <select class="dialog-input" name="previousOwnerRole" ${shareDialogState.isSubmitting ? 'disabled' : ''}>
                                    <option value="editor" ${shareDialogState.previousOwnerRole === 'editor' ? 'selected' : ''}>Keep me as editor</option>
                                    <option value="viewer" ${shareDialogState.previousOwnerRole === 'viewer' ? 'selected' : ''}>Keep me as viewer</option>
                                    <option value="remove" ${shareDialogState.previousOwnerRole === 'remove' ? 'selected' : ''}>Remove me entirely</option>
                                </select>
                                <button type="submit" class="dialog-button dialog-button-primary" ${shareDialogState.isSubmitting ? 'disabled' : ''}>${shareDialogState.isSubmitting ? 'Sending…' : ownershipTransfer ? 'Replace transfer' : 'Request transfer'}</button>
                            </form>
                        </section>
                    `
                            : `
                        <section class="share-dialog-section">
                            <h4>Your access</h4>
                            <p>${
                                canViewMembers
                                    ? 'You can view who has access. Only the owner can change it.'
                                    : 'The owner manages access for this font.'
                            }</p>
                        </section>
                    `
                    }

                    ${
                        canViewMembers
                            ? `
                    <section class="share-dialog-section">
                        <h4>People with access</h4>
                        <p>${shareState.members.length} member${shareState.members.length === 1 ? '' : 's'}</p>
                        <ul class="share-dialog-people">
                            ${shareState.members.length ? shareState.members.map((member) => renderMemberRow(member, canManage, ownerUserId)).join('') : '<li>No members found.</li>'}
                        </ul>
                    </section>
                    `
                            : ''
                    }

                    ${
                        canManage
                            ? `
                    <section class="share-dialog-section">
                        <h4>Pending invites</h4>
                        <p>${shareState.invitations.length} pending</p>
                        <ul class="share-dialog-people">
                            ${shareState.invitations.length ? shareState.invitations.map((invitation) => renderInvitationRow(invitation, canManage)).join('') : '<li>No pending invites.</li>'}
                        </ul>
                    </section>
                    `
                            : ''
                    }
                `
                        : ''
                }
            </div>
            <div class="confirm-dialog-actions share-dialog-actions">
                <button type="button" class="dialog-button" data-share-dialog-action="refresh" ${shareDialogState.isLoading || shareDialogState.isSubmitting ? 'disabled' : ''}>Refresh</button>
                <button type="button" class="dialog-button dialog-button-primary" data-share-dialog-action="close">Close</button>
            </div>
        </div>
    `;

    const inviteForm = shareDialogOverlay.querySelector(
        '[data-share-invite-form]'
    ) as HTMLFormElement | null;
    if (inviteForm) {
        inviteForm.addEventListener('submit', (event) => {
            event.preventDefault();
            void handleInviteSubmit(inviteForm);
        });
    }

    const transferForm = shareDialogOverlay.querySelector(
        '[data-share-transfer-form]'
    ) as HTMLFormElement | null;
    if (transferForm) {
        transferForm.addEventListener('submit', (event) => {
            event.preventDefault();
            void handleTransferSubmit(transferForm);
        });
    }

    shareDialogOverlay
        .querySelectorAll('[data-share-role-form]')
        .forEach((formElement) => {
            formElement.addEventListener('submit', (event) => {
                event.preventDefault();
                void handleMemberRoleSubmit(formElement as HTMLFormElement);
            });
        });

    shareDialogOverlay
        .querySelectorAll('[data-share-dialog-action]')
        .forEach((element) => {
            element.addEventListener('click', async (event) => {
                const target = event.currentTarget as HTMLElement;
                const action = target.dataset.shareDialogAction;
                switch (action) {
                    case 'close':
                        closeShareDialog();
                        break;
                    case 'refresh':
                        await refreshShareDialogState();
                        break;
                    case 'copy-latest-link':
                        if (shareDialogState.latestInviteUrl) {
                            const success = await copyToClipboard(
                                shareDialogState.latestInviteUrl
                            );
                            shareDialogState.notice = success
                                ? 'Invite link copied to clipboard.'
                                : 'Failed to copy invite link.';
                            shareDialogState.error = success
                                ? null
                                : 'Clipboard access failed.';
                            renderShareDialog();
                        }
                        break;
                    case 'copy-latest-transfer-link':
                        if (shareDialogState.latestTransferUrl) {
                            const success = await copyToClipboard(
                                shareDialogState.latestTransferUrl
                            );
                            shareDialogState.notice = success
                                ? 'Transfer link copied to clipboard.'
                                : 'Failed to copy transfer link.';
                            shareDialogState.error = success
                                ? null
                                : 'Clipboard access failed.';
                            renderShareDialog();
                        }
                        break;
                    case 'revoke-invite':
                        await handleRevokeInvitation(
                            target.dataset.invitationId || ''
                        );
                        break;
                    case 'cancel-transfer':
                        await handleCancelOwnershipTransfer();
                        break;
                    case 'remove-member':
                        await handleRemoveMember(target.dataset.userId || '');
                        break;
                }
            });
        });
}

function ensureShareDialog(): HTMLDivElement {
    if (shareDialogOverlay) {
        return shareDialogOverlay;
    }

    shareDialogOverlay = document.createElement('div');
    shareDialogOverlay.className = 'info-popup-overlay share-dialog-overlay';
    shareDialogOverlay.addEventListener('click', (event) => {
        if (event.target === shareDialogOverlay) {
            closeShareDialog();
        }
    });
    document.body.appendChild(shareDialogOverlay);

    return shareDialogOverlay;
}

function openShareDialog(): void {
    if (!isCloudShareAvailable()) {
        alert('Open a cloud font to manage invites and members.');
        return;
    }

    ensureShareDialog();
    shareDialogState = {
        isOpen: true,
        isLoading: true,
        isSubmitting: false,
        error: null,
        notice: null,
        shareState: null,
        inviteEmail: '',
        inviteRole: 'editor',
        transferEmail: '',
        previousOwnerRole: 'editor',
        latestInviteUrl: null,
        latestTransferUrl: null
    };
    shareDialogOverlay?.classList.add('visible');
    document.body.classList.add('share-dialog-open');
    if (!shareDialogEscapeBinding) {
        shareDialogEscapeBinding = bindModalEscape(() => closeShareDialog(), {
            isOpen: () => shareDialogState.isOpen
        });
    }
    renderShareDialog();
    void refreshShareDialogState();
}

function closeShareDialog(): void {
    shareDialogEscapeBinding?.release();
    shareDialogEscapeBinding = null;
    shareDialogState.isOpen = false;
    shareDialogOverlay?.classList.remove('visible');
    document.body.classList.remove('share-dialog-open');
}

async function refreshShareDialogState(options?: {
    preserveInviteUrl?: boolean;
    preserveTransferUrl?: boolean;
    notice?: string | null;
}): Promise<void> {
    const cloudPlugin = getCloudPlugin();
    if (!cloudPlugin) {
        shareDialogState.isLoading = false;
        shareDialogState.error = 'Cloud sharing is unavailable in this window.';
        renderShareDialog();
        return;
    }

    shareDialogState.isLoading = true;
    shareDialogState.error = null;
    if (options?.notice !== undefined) {
        shareDialogState.notice = options.notice;
    }
    renderShareDialog();

    try {
        const shareState = await cloudPlugin.getShareState();
        shareDialogState.shareState = shareState;
        shareDialogState.isLoading = false;
        shareDialogState.error = null;
        if (!options?.preserveInviteUrl) {
            shareDialogState.latestInviteUrl = null;
        }
        if (!options?.preserveTransferUrl) {
            shareDialogState.latestTransferUrl = null;
        }
    } catch (error) {
        shareDialogState.isLoading = false;
        shareDialogState.error = (error as Error).message;
    }

    renderShareDialog();
}

async function handleInviteSubmit(form: HTMLFormElement): Promise<void> {
    const cloudPlugin = getCloudPlugin();
    if (!cloudPlugin) {
        return;
    }

    const formData = new FormData(form);
    const email = String(formData.get('email') || '').trim();
    const role = String(formData.get('role') || 'editor') as ShareRole;
    if (!email) {
        shareDialogState.error = 'Enter an email address to send an invite.';
        renderShareDialog();
        return;
    }

    shareDialogState.inviteEmail = email;
    shareDialogState.inviteRole = role;
    shareDialogState.isSubmitting = true;
    shareDialogState.error = null;
    shareDialogState.notice = null;
    renderShareDialog();

    try {
        const result = await cloudPlugin.inviteUser(email, role);
        shareDialogState.inviteEmail = '';
        shareDialogState.inviteRole = 'editor';
        shareDialogState.latestInviteUrl = result.inviteUrl || null;
        shareDialogState.isSubmitting = false;
        await refreshShareDialogState({
            preserveInviteUrl: true,
            notice: `Invitation sent to ${email}.`
        });
    } catch (error) {
        shareDialogState.isSubmitting = false;
        shareDialogState.error = (error as Error).message;
        renderShareDialog();
    }
}

async function handleTransferSubmit(form: HTMLFormElement): Promise<void> {
    const cloudPlugin = getCloudPlugin();
    if (!cloudPlugin) {
        return;
    }

    const formData = new FormData(form);
    const email = String(formData.get('email') || '').trim();
    const previousOwnerRole = String(
        formData.get('previousOwnerRole') || 'editor'
    ) as PreviousOwnerPolicy;
    if (!email) {
        shareDialogState.error =
            'Enter an email address to request an ownership transfer.';
        renderShareDialog();
        return;
    }

    if (
        shareDialogState.shareState?.ownershipTransfer &&
        !confirm(
            'A pending ownership transfer already exists. Creating a new transfer will cancel it. Continue?'
        )
    ) {
        return;
    }

    shareDialogState.transferEmail = email;
    shareDialogState.previousOwnerRole = previousOwnerRole;
    shareDialogState.isSubmitting = true;
    shareDialogState.error = null;
    shareDialogState.notice = null;
    renderShareDialog();

    try {
        const result = await cloudPlugin.createOwnershipTransfer(
            email,
            previousOwnerRole
        );
        shareDialogState.transferEmail = '';
        shareDialogState.previousOwnerRole = 'editor';
        shareDialogState.latestTransferUrl = result.transferUrl || null;
        shareDialogState.isSubmitting = false;
        await refreshShareDialogState({
            preserveInviteUrl: true,
            preserveTransferUrl: true,
            notice: `Ownership transfer requested for ${email}.`
        });
    } catch (error) {
        shareDialogState.isSubmitting = false;
        shareDialogState.error = (error as Error).message;
        renderShareDialog();
    }
}

async function handleCancelOwnershipTransfer(): Promise<void> {
    if (!confirm('Cancel the pending ownership transfer?')) {
        return;
    }

    const cloudPlugin = getCloudPlugin();
    if (!cloudPlugin) {
        return;
    }

    shareDialogState.isSubmitting = true;
    shareDialogState.error = null;
    renderShareDialog();
    try {
        await cloudPlugin.cancelOwnershipTransfer();
        shareDialogState.isSubmitting = false;
        await refreshShareDialogState({
            preserveInviteUrl: true,
            notice: 'Ownership transfer canceled.'
        });
    } catch (error) {
        shareDialogState.isSubmitting = false;
        shareDialogState.error = (error as Error).message;
        renderShareDialog();
    }
}

async function handleRevokeInvitation(invitationId: string): Promise<void> {
    if (!invitationId) {
        return;
    }
    if (!confirm('Revoke this pending invitation?')) {
        return;
    }

    const cloudPlugin = getCloudPlugin();
    if (!cloudPlugin) {
        return;
    }

    shareDialogState.isSubmitting = true;
    shareDialogState.error = null;
    renderShareDialog();
    try {
        await cloudPlugin.revokeInvitation(invitationId);
        shareDialogState.isSubmitting = false;
        await refreshShareDialogState({
            preserveInviteUrl: true,
            notice: 'Invitation revoked.'
        });
    } catch (error) {
        shareDialogState.isSubmitting = false;
        shareDialogState.error = (error as Error).message;
        renderShareDialog();
    }
}

async function handleMemberRoleSubmit(form: HTMLFormElement): Promise<void> {
    const cloudPlugin = getCloudPlugin();
    if (!cloudPlugin) {
        return;
    }

    const userId = form.dataset.userId || '';
    const roleSelect = form.querySelector('select[name="role"]');
    const role = (
        roleSelect instanceof HTMLSelectElement ? roleSelect.value : 'viewer'
    ) as ShareRole;

    if (!userId) {
        return;
    }

    shareDialogState.isSubmitting = true;
    shareDialogState.error = null;
    renderShareDialog();
    try {
        await cloudPlugin.updateMemberRole(userId, role);
        shareDialogState.isSubmitting = false;
        await refreshShareDialogState({
            preserveInviteUrl: true,
            notice: 'Member role updated.'
        });
    } catch (error) {
        shareDialogState.isSubmitting = false;
        shareDialogState.error = (error as Error).message;
        renderShareDialog();
    }
}

async function handleRemoveMember(userId: string): Promise<void> {
    if (!userId) {
        return;
    }
    if (!confirm('Remove this member from the shared font?')) {
        return;
    }

    const cloudPlugin = getCloudPlugin();
    if (!cloudPlugin) {
        return;
    }

    shareDialogState.isSubmitting = true;
    shareDialogState.error = null;
    renderShareDialog();
    try {
        await cloudPlugin.removeMember(userId);
        shareDialogState.isSubmitting = false;
        await refreshShareDialogState({
            preserveInviteUrl: true,
            notice: 'Member removed.'
        });
    } catch (error) {
        shareDialogState.isSubmitting = false;
        shareDialogState.error = (error as Error).message;
        renderShareDialog();
    }
}

/**
 * Initialize the title-bar share button.
 * Dialog markup is built here; chrome uses the shared info-popup /
 * dialog-button styles in css/ui/dialogs.css.
 */
export function initShareButton(): void {
    const shareButton = document.getElementById('share-btn');
    if (!shareButton) {
        console.error('[ShareButton]', 'Share button not found');
        return;
    }

    if (getCloudPlugin()?.isVisibleInUI() === false) {
        shareButton.hidden = true;
        shareButton.classList.remove('visible');
        return;
    }

    shareButton.addEventListener('click', (event: Event) => {
        event.preventDefault();
        event.stopPropagation();

        if (!isCloudShareAvailable()) {
            alert('Open a cloud font to review access.');
            return;
        }

        void openShareDialog();
    });

    console.log('[ShareButton]', 'Share button initialized');
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initShareButton);
} else {
    initShareButton();
}
