// Small dialogs and notices shared by the launcher and font windows.
// Dialogs use the editor's `.info-popup` structure with the
// `font-window-dialog` look (css/ui/font-windows.css).

import { bindModalEscape } from '../ui/modal-escape';

export function escapeHtml(value: unknown): string {
    return String(value ?? '').replace(
        /[&<>"']/g,
        (c) =>
            ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            })[c] ?? c
    );
}

export const icon = (name: string) =>
    `<span class="material-symbols-outlined" aria-hidden="true">${name}</span>`;

export type FontWindowDialog = {
    root: HTMLElement;
    body: HTMLElement;
    close: () => void;
};

/** Open a centred dialog. `body` is filled by the caller. */
export function openDialog(options: {
    title: string;
    className?: string;
    overlayClassName?: string;
    /** False: only the dialog's own buttons close it (no ×, Escape or backdrop). */
    dismissable?: boolean;
    onClose?: () => void;
}): FontWindowDialog {
    const dismissable = options.dismissable !== false;
    const overlay = document.createElement('div');
    overlay.className = `info-popup-overlay font-window-dialog-overlay ${options.overlayClassName ?? ''}`;
    overlay.innerHTML = `
        <div class="info-popup font-window-dialog ${options.className ?? ''}" role="dialog" aria-modal="true">
            <div class="font-window-dialog-head">
                <h3>${escapeHtml(options.title)}</h3>
                ${dismissable ? `<button class="info-popup-close" type="button" data-close aria-label="Close">${icon('close')}</button>` : ''}
            </div>
            <div class="font-window-dialog-body"></div>
        </div>`;
    const body = overlay.querySelector(
        '.font-window-dialog-body'
    ) as HTMLElement;
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        escape?.release();
        overlay.remove();
        options.onClose?.();
    };
    const escape = dismissable
        ? bindModalEscape(close, { isOpen: () => !closed })
        : null;
    overlay.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        if (target.closest('[data-close]')) close();
        else if (target === overlay && dismissable) close();
    });
    document.body.append(overlay);
    return { root: overlay, body, close };
}

let noticeHost: HTMLElement | null = null;

/**
 * A short message at the bottom of the window, with an optional action. A
 * persistent notice can't be dismissed; it stays until its action is taken.
 */
export function showNotice(
    message: string,
    action?: { label: string; run: () => void; persistent?: boolean }
): void {
    noticeHost ??= Object.assign(document.createElement('div'), {
        className: 'font-window-notices'
    });
    if (!noticeHost.isConnected) document.body.append(noticeHost);
    const notice = document.createElement('div');
    notice.className = 'font-window-notice';
    notice.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = message;
    notice.append(text);
    if (action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dialog-button';
        button.textContent = action.label;
        button.addEventListener('click', () => {
            notice.remove();
            action.run();
        });
        notice.append(button);
    }
    if (!action?.persistent) {
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'info-popup-close';
        dismiss.setAttribute('aria-label', 'Dismiss');
        dismiss.innerHTML = icon('close');
        dismiss.addEventListener('click', () => notice.remove());
        notice.append(dismiss);
    }
    noticeHost.append(notice);
    if (!action) setTimeout(() => notice.remove(), 7000);
}

/** Report an error to the user; a cancelled picker is not an error. */
export function reportError(error: unknown): void {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    console.error(error);
    showNotice(error instanceof Error ? error.message : String(error));
}

// Platform wording for the file manager and the folder picker's button.
const platformName = (
    (navigator as Navigator & { userAgentData?: { platform?: string } })
        .userAgentData?.platform ||
    navigator.platform ||
    ''
).toLowerCase();
export const OS = platformName.includes('mac')
    ? 'mac'
    : platformName.includes('win')
      ? 'windows'
      : 'linux';
export const FILE_MANAGER = {
    mac: 'Finder',
    windows: 'File Explorer',
    linux: 'your file manager'
}[OS];
export const FOLDER_PICKER_BUTTON = OS === 'mac' ? 'Open' : 'Select Folder';
