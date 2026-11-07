/**
 * Settings Folder setup / renewal dialog.
 * Prompts for the Settings Folder after welcome, and keeps a toolbar Link
 * Folder control until it is granted. Fonts on disk need no folder: they are
 * opened with the system file pickers from the launcher.
 */

import tippy, { type Instance as TippyInstance } from 'tippy.js';
import { Logger } from './logger';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';
import { getTheme } from './tippy-utils';
import { isFileSystemAccessSupported } from './file-system-adapter';
import { settingsFolder } from './settings-folder';

const console = new Logger('FolderPermissions');

export type FolderAccessState = 'missing' | 'needsRenewal' | 'ready';

export type FolderStatus = {
    state: FolderAccessState;
    name: string | null;
};

export type FolderSetupStatus = {
    settings: FolderStatus;
};

const SETTINGS_INFO_HTML = `
    <p>The Settings Folder is app-wide, not per font. Counterpunch creates three subfolders automatically if they are missing:</p>
    <ul>
        <li><strong>Scripts</strong> — reusable Python opened from the Script Editor and Tools → Run Python Script</li>
        <li><strong>Filters</strong> — glyph overview user filters</li>
        <li><strong>Plugins</strong> — installed plugin wheels such as Font Destinations</li>
    </ul>
    <p>A dedicated folder named Counterpunch is a good choice. Keep it separate from your font sources.</p>
`;

export type FolderSetupKind = 'settings';

export const FOLDER_KIND_ICON: Record<FolderSetupKind, string> = {
    settings: 'folder_managed'
};

const FOLDER_KIND_CALLOUT_TITLE: Record<FolderSetupKind, string> = {
    settings: 'Settings Folder Required'
};

const FOLDER_KIND_CALLOUT_MESSAGE: Record<FolderSetupKind, string> = {
    settings:
        'Link a Settings Folder so Counterpunch can store filters, scripts, and plugins on disk.'
};

export const LINK_FOLDERS_BUTTON_LABEL = 'Link Folder';

export const FOLDER_ACCESS_UNAVAILABLE_COPY = {
    title: 'Folder Access Unavailable',
    intro: 'This browser cannot link folders on disk. Use <strong>Chrome/Chromium, Safari, or Edge</strong>. Counterpunch needs the File System Access pickers. Brave turns that API off by default, and Firefox does not provide it, so fonts on disk and the Settings Folder are unavailable here. Browser storage still works.'
};

type FolderPermissionsHost = {
    listenersBound: boolean;
    autoPrompted: boolean;
    autoPromptSettled: boolean;
    autoPromptAwaitingClose: boolean;
    opening: boolean;
    dialogOverlay: HTMLElement | null;
    linkFolderButton: HTMLButtonElement | null;
    escapeBinding: ModalEscapeBinding | null;
};

function getHost(): FolderPermissionsHost {
    const holder = window as Window & {
        __folderPermissionsHost?: FolderPermissionsHost;
    };
    if (!holder.__folderPermissionsHost) {
        holder.__folderPermissionsHost = {
            listenersBound: false,
            autoPrompted: false,
            autoPromptSettled: false,
            autoPromptAwaitingClose: false,
            opening: false,
            dialogOverlay: null,
            linkFolderButton: null,
            escapeBinding: null
        };
    }
    return holder.__folderPermissionsHost;
}

let cachedStatus: FolderSetupStatus | null = null;
let infoTippyInstances: TippyInstance[] = [];

export function classifyFolderAccess(
    hasHandle: boolean,
    permission: PermissionState | null
): FolderAccessState {
    if (!hasHandle) {
        return 'missing';
    }
    if (permission === 'granted') {
        return 'ready';
    }
    return 'needsRenewal';
}

export function isFolderSetupComplete(status: FolderSetupStatus): boolean {
    return status.settings.state === 'ready';
}

export function isFolderSetupCompleteSync(): boolean {
    return !!cachedStatus && isFolderSetupComplete(cachedStatus);
}

export function isSettingsFolderReadySync(): boolean {
    if (cachedStatus) {
        return cachedStatus.settings.state === 'ready';
    }
    return settingsFolder.hasFolder();
}

function isAutomatedSession(): boolean {
    return !!window.isTestMode?.();
}

export async function refreshFolderSetupStatus(): Promise<FolderSetupStatus> {
    await settingsFolder.initialize();
    cachedStatus = {
        settings: {
            state: await settingsFolder.getAccessState(),
            name: settingsFolder.getFolderName()
        }
    };
    updateLinkFolderButton();
    /**
     * Settings Folder access snapshot after a status refresh.
     */
    window.dispatchEvent(
        new CustomEvent('folderSetupStatusChanged', { detail: cachedStatus })
    );
    return cachedStatus;
}

function destroyInfoTippys(): void {
    for (const instance of infoTippyInstances) {
        instance.destroy();
    }
    infoTippyInstances = [];
}

function bindFolderDialogEscape(overlay: HTMLElement): void {
    const host = getHost();
    host.escapeBinding?.release();
    host.escapeBinding = bindModalEscape(closeDialog, {
        isOpen: () => overlay.isConnected
    });
}

function settleFolderPermissionsAutoPrompt(): void {
    const host = getHost();
    if (host.autoPromptSettled) {
        return;
    }
    host.autoPromptSettled = true;
    host.autoPromptAwaitingClose = false;
    /**
     * First-launch folder prompt finished (shown and closed, or skipped because
     * setup is complete or File System Access is unavailable).
     */
    window.dispatchEvent(new CustomEvent('folderPermissionsAutoPromptSettled'));
}

function closeDialog(): void {
    const host = getHost();
    const shouldSettleAutoPrompt = host.autoPromptAwaitingClose;
    host.escapeBinding?.release();
    host.escapeBinding = null;
    destroyInfoTippys();
    host.dialogOverlay?.remove();
    host.dialogOverlay = null;
    void refreshFolderSetupStatus();
    /**
     * Folder permissions dialog was closed (Continue, Skip, Escape, or overlay).
     */
    window.dispatchEvent(new CustomEvent('folderPermissionsDialogClosed'));
    if (shouldSettleAutoPrompt) {
        settleFolderPermissionsAutoPrompt();
    }
}

function bindInfoButton(
    button: Element | null,
    content: string,
    overlay: HTMLElement
): void {
    if (!(button instanceof HTMLElement)) {
        return;
    }
    infoTippyInstances.push(
        tippy(button, {
            content: `<div class="info-popup-content">${content}</div>`,
            allowHTML: true,
            interactive: true,
            trigger: 'click',
            theme: getTheme(),
            appendTo: overlay,
            maxWidth: 360,
            placement: 'right'
        })
    );
}

function folderPathLabel(status: FolderStatus): string {
    if (status.state === 'ready' && status.name) {
        return status.name;
    }
    if (status.state === 'needsRenewal' && status.name) {
        return status.name;
    }
    return 'No folder selected yet';
}

function renderFolderSection(
    kind: FolderSetupKind,
    title: string,
    bodyHtml: string,
    status: FolderStatus,
    pickerAvailable: boolean
): string {
    const actionDisabled = pickerAvailable ? '' : ' disabled';
    const action =
        status.state === 'needsRenewal'
            ? `<button type="button" class="dialog-button dialog-button-primary" data-folder-action="renew" data-folder-kind="${kind}"${actionDisabled}>Restore Access</button>`
            : `<button type="button" class="dialog-button dialog-button-primary" data-folder-action="select" data-folder-kind="${kind}"${actionDisabled}>Select Folder</button>`;
    const stateNote =
        status.state === 'needsRenewal'
            ? '<p class="folder-permissions-status-note folder-permissions-renewal-message">Access expired — restore it to keep using this folder.</p>'
            : status.state === 'ready'
              ? '<p class="folder-permissions-status-note">Access granted.</p>'
              : '';

    return `
        <section class="folder-permissions-section">
            <div class="folder-permissions-section-header">
                <span class="material-symbols-outlined folder-permissions-section-icon" aria-hidden="true">${FOLDER_KIND_ICON[kind]}</span>
                <h4>${title}</h4>
                <button type="button" class="confirm-dialog-info-btn material-symbols-outlined" data-folder-info="${kind}" aria-label="About ${title}">info</button>
            </div>
            <div class="folder-permissions-section-body">${bodyHtml}</div>
            <div class="folder-permissions-folder-row">
                ${action}
                <span class="folder-permissions-path" title="${folderPathLabel(status)}">${folderPathLabel(status)}</span>
            </div>
            ${stateNote}
        </section>
    `;
}

export function getFolderPermissionsDialogCopy(
    status: FolderSetupStatus,
    pickerAvailable: boolean
): {
    title: string;
    intro: string;
} {
    if (!pickerAvailable) {
        return FOLDER_ACCESS_UNAVAILABLE_COPY;
    }
    if (status.settings.state === 'needsRenewal') {
        return {
            title: 'Restore Folder Access',
            intro: 'The browser has withdrawn write access to the Settings Folder you already linked. Restore access so Counterpunch can keep reading and writing those files. This confirms the existing folder; it does not pick a new one.'
        };
    }
    return {
        title: 'Link Settings Folder',
        intro: 'Since this app runs inside a browser, you need to grant access to a folder for your settings.'
    };
}

async function paintDialog(): Promise<void> {
    const host = getHost();
    if (!host.dialogOverlay) {
        return;
    }
    const status = await refreshFolderSetupStatus();
    const pickerAvailable = isFileSystemAccessSupported();
    const copy = getFolderPermissionsDialogCopy(status, pickerAvailable);
    const complete = isFolderSetupComplete(status);
    const title = host.dialogOverlay.querySelector('#folder-permissions-title');
    const content = host.dialogOverlay.querySelector(
        '.folder-permissions-content'
    );
    const continueBtn = host.dialogOverlay.querySelector(
        '[data-action="continue"]'
    ) as HTMLButtonElement | null;

    if (title) {
        title.textContent = copy.title;
    }
    if (content) {
        const introClass = pickerAvailable
            ? status.settings.state === 'needsRenewal'
                ? 'folder-permissions-renewal-message'
                : ''
            : 'folder-permissions-unavailable';
        content.innerHTML = `
            <p class="${introClass}">${copy.intro}</p>
            ${renderFolderSection(
                'settings',
                'Settings Folder',
                '<p>The app stores your glyph filters, Python scripts, and downloaded plugins in this folder.</p>',
                status.settings,
                pickerAvailable
            )}
        `;
    }
    if (continueBtn) {
        continueBtn.disabled = !complete;
    }

    destroyInfoTippys();
    bindInfoButton(
        host.dialogOverlay.querySelector('[data-folder-info="settings"]'),
        SETTINGS_INFO_HTML,
        host.dialogOverlay
    );
}

function concealOverlayForNativePicker(): () => void {
    const overlay = getHost().dialogOverlay;
    if (!overlay) {
        return () => undefined;
    }
    overlay.classList.add('is-native-picker-open');
    overlay.setAttribute('aria-hidden', 'true');
    return () => {
        overlay.classList.remove('is-native-picker-open');
        overlay.removeAttribute('aria-hidden');
    };
}

async function handleFolderAction(action: 'select' | 'renew'): Promise<void> {
    if (!isFileSystemAccessSupported()) {
        await paintDialog();
        return;
    }
    const restoreOverlay = concealOverlayForNativePicker();
    try {
        if (action === 'select') {
            await settingsFolder.selectFolder();
        } else {
            await settingsFolder.renewPermission();
        }
    } catch (error) {
        console.error('Folder action failed:', error);
    } finally {
        restoreOverlay();
    }
    await paintDialog();
}

export async function openFolderPermissionsDialog(): Promise<void> {
    const host = getHost();
    if (host.opening) {
        return;
    }
    const existingOverlay = document
        .querySelector('.folder-permissions-dialog')
        ?.closest('.info-popup-overlay');
    if (existingOverlay instanceof HTMLElement) {
        host.dialogOverlay = existingOverlay;
        bindFolderDialogEscape(existingOverlay);
        await paintDialog();
        return;
    }
    if (host.dialogOverlay) {
        bindFolderDialogEscape(host.dialogOverlay);
        await paintDialog();
        return;
    }
    host.opening = true;

    const overlay = document.createElement('div');
    overlay.className = 'info-popup-overlay folder-permissions-overlay';
    overlay.style.display = 'flex';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'folder-permissions-title');
    overlay.innerHTML = `
        <div class="info-popup confirm-dialog folder-permissions-dialog">
            <div class="info-popup-header">
                <h3 id="folder-permissions-title">Link Settings Folder</h3>
                <button type="button" class="info-popup-close confirm-dialog-close-btn" aria-label="Skip">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="info-popup-content confirm-dialog-content folder-permissions-content"></div>
            <div class="confirm-dialog-actions folder-permissions-actions">
                <button type="button" class="dialog-button" data-action="skip">Skip</button>
                <button type="button" class="dialog-button dialog-button-primary" data-action="continue" disabled>Continue</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    host.dialogOverlay = overlay;
    bindFolderDialogEscape(overlay);

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            closeDialog();
        }
    });
    overlay
        .querySelector('.confirm-dialog-close-btn')
        ?.addEventListener('click', closeDialog);
    overlay
        .querySelector('[data-action="skip"]')
        ?.addEventListener('click', closeDialog);
    overlay
        .querySelector('[data-action="continue"]')
        ?.addEventListener('click', () => {
            if (cachedStatus && isFolderSetupComplete(cachedStatus)) {
                closeDialog();
            }
        });
    overlay.addEventListener('click', (event) => {
        const target = (event.target as Element | null)?.closest(
            '[data-folder-action]'
        ) as HTMLElement | null;
        if (!target) {
            return;
        }
        const kind = target.dataset.folderKind;
        const action = target.dataset.folderAction;
        if (
            kind === 'settings' &&
            (action === 'select' || action === 'renew')
        ) {
            event.preventDefault();
            void handleFolderAction(action);
        }
    });

    try {
        await paintDialog();
    } finally {
        host.opening = false;
    }
}

function ensureLinkFolderButton(): HTMLButtonElement | null {
    const host = getHost();
    const existing = document.getElementById('link-folder-btn');
    if (existing instanceof HTMLButtonElement) {
        host.linkFolderButton = existing;
        return existing;
    }
    if (host.linkFolderButton) {
        return host.linkFolderButton;
    }
    const toolbarRight = document.querySelector('.toolbar-right');
    const settingsBtn = document.getElementById('settings-btn');
    const tourChip = document.getElementById('tour-launch-chip');
    if (!toolbarRight || !settingsBtn) {
        return null;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'link-folder-btn';
    button.className = 'toolbar-link-folder-btn';
    button.textContent = LINK_FOLDERS_BUTTON_LABEL;
    button.title = 'Link or restore the Settings Folder';
    button.hidden = true;
    button.addEventListener('click', () => {
        void openFolderPermissionsDialog();
    });
    toolbarRight.insertBefore(button, tourChip || settingsBtn);
    host.linkFolderButton = button;
    return button;
}

function updateLinkFolderButton(): void {
    const button = ensureLinkFolderButton();
    if (!button) {
        return;
    }
    const show = !!cachedStatus && !isFolderSetupComplete(cachedStatus);
    button.hidden = !show;
}

function folderKindIconElement(
    kind: FolderSetupKind,
    className: string
): HTMLSpanElement {
    const icon = document.createElement('span');
    icon.className = `material-symbols-outlined ${className}`;
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = FOLDER_KIND_ICON[kind];
    return icon;
}

export function createFolderSetupCallout(
    message?: string,
    kind: FolderSetupKind = 'settings'
): HTMLElement {
    const callout = document.createElement('div');
    callout.className = 'folder-setup-callout';
    const heading = document.createElement('div');
    heading.className = 'folder-setup-callout-heading';
    const title = document.createElement('h2');
    title.textContent = FOLDER_KIND_CALLOUT_TITLE[kind];
    heading.append(
        folderKindIconElement(kind, 'folder-setup-callout-icon'),
        title
    );
    const text = document.createElement('p');
    text.textContent = message || FOLDER_KIND_CALLOUT_MESSAGE[kind];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toolbar-link-folder-btn';
    button.textContent = LINK_FOLDERS_BUTTON_LABEL;
    button.addEventListener('click', () => {
        void openFolderPermissionsDialog();
    });
    callout.append(heading, text, button);
    return callout;
}

export function getFolderSetupCalloutHtml(
    kind: FolderSetupKind = 'settings'
): string {
    return `
        <div class="folder-setup-callout">
            <div class="folder-setup-callout-heading">
                <span class="material-symbols-outlined folder-setup-callout-icon" aria-hidden="true">${FOLDER_KIND_ICON[kind]}</span>
                <h2>${FOLDER_KIND_CALLOUT_TITLE[kind]}</h2>
            </div>
            <p>${FOLDER_KIND_CALLOUT_MESSAGE[kind]}</p>
            <button type="button" class="toolbar-link-folder-btn" data-action="link-folder">${LINK_FOLDERS_BUTTON_LABEL}</button>
        </div>
    `;
}

export async function maybeShowFolderPermissionsDialog(): Promise<void> {
    const host = getHost();
    if (isAutomatedSession() || host.autoPrompted) {
        await refreshFolderSetupStatus();
        if (!host.autoPrompted) {
            host.autoPrompted = true;
            settleFolderPermissionsAutoPrompt();
        }
        return;
    }
    host.autoPrompted = true;
    await refreshFolderSetupStatus();
    if (
        !isFileSystemAccessSupported() ||
        !cachedStatus ||
        isFolderSetupComplete(cachedStatus)
    ) {
        settleFolderPermissionsAutoPrompt();
        return;
    }
    host.autoPromptAwaitingClose = true;
    await openFolderPermissionsDialog();
}

function bindStatusListeners(): void {
    const host = getHost();
    if (host.listenersBound) {
        return;
    }
    host.listenersBound = true;
    window.addEventListener('welcomeScreenSettled', () => {
        void maybeShowFolderPermissionsDialog();
    });
    window.addEventListener('settingsFolderAccessChanged', () => {
        void refreshFolderSetupStatus();
    });
}

bindStatusListeners();
