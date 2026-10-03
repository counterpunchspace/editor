/**
 * Confirm Dialog — reusable save/discard/cancel dialog
 *
 * Uses the shared .info-popup-overlay + .info-popup pattern and .dialog-button
 * styles from css/ui/dialogs.css.
 */

import { bindModalEscape } from './modal-escape';

export type ConfirmChoice = 'save' | 'discard' | 'cancel';

type UnsavedChangesDialogOptions = {
    subjectType: string;
    subjectName: string;
};

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Two-choice confirm. Escape, close, and the backdrop cancel.
 */
export function showProceedDialog(
    title: string,
    message: string
): Promise<boolean> {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'info-popup-overlay';
        overlay.style.display = 'flex';
        overlay.style.zIndex = '10002';

        overlay.innerHTML = `
            <div class="info-popup confirm-dialog">
                <div class="info-popup-header">
                    <h3>${escapeHtml(title)}</h3>
                    <button type="button" class="info-popup-close confirm-dialog-close-btn" aria-label="Cancel">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
                <div class="info-popup-content confirm-dialog-content">
                    <p>${escapeHtml(message)}</p>
                    <div class="confirm-dialog-actions">
                        <button type="button" class="dialog-button" data-action="cancel">Cancel</button>
                        <button type="button" class="dialog-button dialog-button-primary" data-action="proceed">Proceed</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        let escapeBinding: ReturnType<typeof bindModalEscape> | null = null;

        function finish(proceed: boolean) {
            escapeBinding?.release();
            escapeBinding = null;
            overlay.remove();
            resolve(proceed);
        }

        escapeBinding = bindModalEscape(() => finish(false), {
            isOpen: () => overlay.isConnected
        });

        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                finish(false);
            }
        });
        overlay
            .querySelector('.confirm-dialog-close-btn')
            ?.addEventListener('click', () => finish(false));
        overlay.querySelectorAll('[data-action]').forEach((button) => {
            button.addEventListener('click', () => {
                finish((button as HTMLElement).dataset.action === 'proceed');
            });
        });
    });
}

export function showNamedUnsavedChangesDialog({
    subjectType,
    subjectName
}: UnsavedChangesDialogOptions): Promise<ConfirmChoice> {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'info-popup-overlay';
        overlay.style.display = 'flex';
        overlay.style.zIndex = '10002';

        const escapedType = escapeHtml(subjectType);
        const escapedName = escapeHtml(subjectName);

        overlay.innerHTML = `
            <div class="info-popup confirm-dialog">
                <div class="info-popup-header">
                    <h3>Unsaved Changes</h3>
                    <button type="button" class="info-popup-close confirm-dialog-close-btn" aria-label="Cancel">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
                <div class="info-popup-content confirm-dialog-content">
                    <p>${escapedType} <strong>${escapedName}</strong> has unsaved changes. What do you want to do?</p>
                    <div class="confirm-dialog-actions">
                        <button type="button" class="dialog-button dialog-button-danger" data-action="discard">Don't Save</button>
                        <button type="button" class="dialog-button" data-action="cancel">Cancel</button>
                        <button type="button" class="dialog-button dialog-button-primary" data-action="save">Save</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        let escapeBinding: ReturnType<typeof bindModalEscape> | null = null;

        function cleanup() {
            escapeBinding?.release();
            escapeBinding = null;
            overlay.remove();
        }

        function handleChoice(choice: ConfirmChoice) {
            cleanup();
            resolve(choice);
        }

        escapeBinding = bindModalEscape(() => handleChoice('cancel'), {
            isOpen: () => overlay.isConnected
        });

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                handleChoice('cancel');
            }
        });

        overlay
            .querySelector('.confirm-dialog-close-btn')
            ?.addEventListener('click', () => {
                handleChoice('cancel');
            });

        overlay.querySelectorAll('[data-action]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const action = (btn as HTMLElement).dataset
                    .action as ConfirmChoice;
                handleChoice(action);
            });
        });

        queueMicrotask(() => {
            const saveBtn = overlay.querySelector(
                '[data-action="save"]'
            ) as HTMLElement;
            saveBtn?.focus();
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
