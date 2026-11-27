/**
 * Confirm Dialog — reusable save/discard/cancel dialog and shared modal overlay
 * lifecycle helper.
 *
 * Uses the shared .info-popup-overlay + .info-popup pattern and .dialog-button
 * styles from css/ui/dialogs.css.
 */

import { escapeHtml } from './escape-html';
import { bindModalEscape, type ModalEscapeBinding } from './modal-escape';

export type ConfirmChoice = 'save' | 'discard' | 'cancel';

type UnsavedChangesDialogOptions = {
    subjectType: string;
    subjectName: string;
};

export type MountModalOverlayOptions = {
    innerHTML: string;
    zIndex?: string;
    attributes?: Record<string, string>;
    closeSelector?: string;
    focusSelector?: string;
    onDismiss: () => void;
    onCleanup?: () => void;
};

export type MountedModalOverlay = {
    overlay: HTMLDivElement;
    close: () => void;
};

/**
 * Mount a `.info-popup-overlay` modal, wiring Escape (`bindModalEscape`),
 * backdrop click, close button, and idempotent cleanup on every close path.
 */
export function mountModalOverlay(
    options: MountModalOverlayOptions
): MountedModalOverlay {
    const overlay = document.createElement('div');
    overlay.className = 'info-popup-overlay';
    overlay.style.display = 'flex';
    if (options.zIndex !== undefined) {
        overlay.style.zIndex = options.zIndex;
    }
    if (options.attributes) {
        for (const [key, value] of Object.entries(options.attributes)) {
            overlay.setAttribute(key, value);
        }
    }
    overlay.innerHTML = options.innerHTML;
    document.body.appendChild(overlay);

    let escapeBinding: ModalEscapeBinding | null = null;
    let closed = false;

    const close = () => {
        if (closed) {
            return;
        }
        closed = true;
        options.onCleanup?.();
        escapeBinding?.release();
        escapeBinding = null;
        overlay.remove();
    };

    const dismiss = () => {
        close();
        options.onDismiss();
    };

    escapeBinding = bindModalEscape(dismiss, {
        isOpen: () => overlay.isConnected
    });

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            dismiss();
        }
    });

    const closeSelector = options.closeSelector ?? '.confirm-dialog-close-btn';
    overlay.querySelector(closeSelector)?.addEventListener('click', dismiss);

    if (options.focusSelector) {
        const selector = options.focusSelector;
        queueMicrotask(() => {
            (overlay.querySelector(selector) as HTMLElement | null)?.focus();
        });
    }

    return { overlay, close };
}

function renderConfirmDialogHtml(
    title: string,
    bodyHtml: string,
    actionsHtml: string
): string {
    return `
        <div class="info-popup confirm-dialog">
            <div class="info-popup-header">
                <h3>${escapeHtml(title)}</h3>
                <button type="button" class="info-popup-close confirm-dialog-close-btn" aria-label="Cancel">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="info-popup-content confirm-dialog-content">
                ${bodyHtml}
                <div class="confirm-dialog-actions">${actionsHtml}</div>
            </div>
        </div>
    `;
}

/**
 * Two-choice confirm. Escape, close, and the backdrop cancel.
 */
export function showProceedDialog(
    title: string,
    message: string,
    options: {
        proceedLabel?: string;
        cancelLabel?: string;
        danger?: boolean;
    } = {}
): Promise<boolean> {
    const proceedClass = options.danger
        ? 'dialog-button dialog-button-danger'
        : 'dialog-button dialog-button-primary';
    return new Promise((resolve) => {
        const { overlay, close } = mountModalOverlay({
            zIndex: '10002',
            innerHTML: renderConfirmDialogHtml(
                title,
                `<p>${escapeHtml(message)}</p>`,
                `<button type="button" class="dialog-button" data-action="cancel">${escapeHtml(options.cancelLabel ?? 'Cancel')}</button>
                 <button type="button" class="${proceedClass}" data-action="proceed">${escapeHtml(options.proceedLabel ?? 'Proceed')}</button>`
            ),
            onDismiss: () => resolve(false)
        });

        overlay.querySelectorAll('[data-action]').forEach((button) => {
            button.addEventListener('click', () => {
                close();
                resolve((button as HTMLElement).dataset.action === 'proceed');
            });
        });
    });
}

export type DialogChoice = {
    id: string;
    label: string;
    style?: 'primary' | 'danger';
};

/**
 * Confirm with several named choices, shown left to right. Escape, close, and
 * the backdrop resolve with null.
 */
export function showChoiceDialog(
    title: string,
    message: string,
    choices: DialogChoice[]
): Promise<string | null> {
    return new Promise((resolve) => {
        const buttons = choices
            .map((choice) => {
                const style = choice.style
                    ? ` dialog-button-${choice.style}`
                    : '';
                return `<button type="button" class="dialog-button${style}" data-choice="${escapeHtml(choice.id)}">${escapeHtml(choice.label)}</button>`;
            })
            .join('');

        const { overlay, close } = mountModalOverlay({
            zIndex: '10002',
            innerHTML: renderConfirmDialogHtml(
                title,
                `<p>${escapeHtml(message)}</p>`,
                buttons
            ),
            onDismiss: () => resolve(null)
        });

        overlay.querySelectorAll('[data-choice]').forEach((button) => {
            button.addEventListener('click', () => {
                close();
                resolve((button as HTMLElement).dataset.choice ?? null);
            });
        });
    });
}

export function showNamedUnsavedChangesDialog({
    subjectType,
    subjectName
}: UnsavedChangesDialogOptions): Promise<ConfirmChoice> {
    return new Promise((resolve) => {
        const escapedType = escapeHtml(subjectType);
        const escapedName = escapeHtml(subjectName);

        const { overlay, close } = mountModalOverlay({
            zIndex: '10002',
            innerHTML: renderConfirmDialogHtml(
                'Unsaved Changes',
                `<p>${escapedType} <strong>${escapedName}</strong> has unsaved changes. What do you want to do?</p>`,
                `<button type="button" class="dialog-button dialog-button-danger" data-action="discard">Don't Save</button>
                 <button type="button" class="dialog-button" data-action="cancel">Cancel</button>
                 <button type="button" class="dialog-button dialog-button-primary" data-action="save">Save</button>`
            ),
            focusSelector: '[data-action="save"]',
            onDismiss: () => resolve('cancel')
        });

        overlay.querySelectorAll('[data-action]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const action = (btn as HTMLElement).dataset
                    .action as ConfirmChoice;
                close();
                resolve(action);
            });
        });
    });
}

/**
 * Show an "Unsaved Changes" dialog with three choices.
 *
 * @param fontName - The name of the font with unsaved changes
 * @returns A promise that resolves with the user's choice
 */
export function showUnsavedChangesDialog(
    fontName: string
): Promise<ConfirmChoice> {
    return showNamedUnsavedChangesDialog({
        subjectType: 'Font',
        subjectName: fontName
    });
}
