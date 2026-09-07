/**
 * General transfer-progress dialog (seed/load). Not CloudPlugin chrome.
 *
 * Callers run long I/O inside `work` and must await `yieldToUi` (or rely on
 * shard I/O helpers that already yield) so Cancel and Escape stay responsive.
 */

import { bindModalEscape } from './modal-escape';
import { throwIfAborted, yieldToUi } from '../yield-to-ui';

export class TransferCancelledError extends Error {
    readonly name = 'TransferCancelledError';

    constructor(message = 'Transfer cancelled') {
        super(message);
    }
}

export function isTransferCancelled(error: unknown): boolean {
    if (error instanceof TransferCancelledError) {
        return true;
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
        return true;
    }
    if (error instanceof Error && error.name === 'AbortError') {
        return true;
    }
    return false;
}

export type TransferProgressKind = 'seed' | 'load';

export type TransferProgressUpdate = {
    message?: string;
    completed?: number;
    total?: number;
    bytesCompleted?: number;
    bytesTotal?: number;
};

export type TransferProgressSession = {
    readonly kind: TransferProgressKind;
    readonly signal: AbortSignal;
    update: (patch: TransferProgressUpdate) => void;
    get completed(): number;
    get total(): number;
};

export type RunWithTransferProgressOptions<T> = {
    kind: TransferProgressKind;
    title?: string;
    message: string;
    total?: number;
    bytesTotal?: number;
    work: (session: TransferProgressSession) => Promise<T>;
};

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function defaultTitle(kind: TransferProgressKind): string {
    return kind === 'seed' ? 'Saving' : 'Opening';
}

function cancellingMessage(kind: TransferProgressKind): string {
    return kind === 'seed'
        ? 'Cancelling upload and removing shards that already landed…'
        : 'Cancelling download…';
}

function formatStatus(
    message: string,
    completed: number,
    total: number
): string {
    if (total > 0) {
        return `${message} ${completed} of ${total}`;
    }
    return message;
}

export async function runWithTransferProgress<T>(
    options: RunWithTransferProgressOptions<T>
): Promise<T> {
    const controller = new AbortController();
    let completed = 0;
    let total = Math.max(0, options.total ?? 0);
    let bytesCompleted = 0;
    let bytesTotal = Math.max(0, options.bytesTotal ?? 0);
    let message = options.message;
    let closed = false;
    let cancelling = false;

    const overlay = document.createElement('div');
    overlay.className = 'info-popup-overlay transfer-progress-overlay';
    overlay.style.display = 'flex';
    overlay.style.zIndex = '10003';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'transfer-progress-title');

    const title = options.title || defaultTitle(options.kind);
    overlay.innerHTML = `
            <div class="info-popup confirm-dialog transfer-progress-dialog">
                <div class="info-popup-header">
                    <h3 id="transfer-progress-title">${escapeHtml(title)}</h3>
                </div>
                <div class="info-popup-content confirm-dialog-content">
                    <p class="transfer-progress-message" aria-live="polite"></p>
                    <progress class="transfer-progress-bar" max="1" value="0"></progress>
                    <div class="confirm-dialog-actions">
                        <button type="button" class="dialog-button" data-action="cancel">Cancel</button>
                    </div>
                </div>
            </div>
        `;

    const messageEl = overlay.querySelector(
        '.transfer-progress-message'
    ) as HTMLParagraphElement;
    const barEl = overlay.querySelector(
        '.transfer-progress-bar'
    ) as HTMLProgressElement;
    const cancelBtn = overlay.querySelector(
        '[data-action="cancel"]'
    ) as HTMLButtonElement;

    function paint(): void {
        const status = formatStatus(message, completed, total);
        messageEl.textContent = status;
        if (total > 0) {
            barEl.max = total;
            barEl.value = Math.min(completed, total);
            barEl.removeAttribute('aria-valuetext');
        } else {
            barEl.removeAttribute('value');
            barEl.max = 1;
        }
        barEl.setAttribute('aria-valuenow', String(completed));
        barEl.setAttribute('aria-valuemax', String(total || 1));
        barEl.setAttribute('aria-label', status);
        if (bytesTotal > 0) {
            barEl.setAttribute('data-bytes', `${bytesCompleted}/${bytesTotal}`);
        }
    }

    function closeOverlay(): void {
        if (closed) {
            return;
        }
        closed = true;
        escapeBinding?.release();
        escapeBinding = null;
        overlay.remove();
    }

    function requestCancel(): void {
        if (cancelling || closed) {
            return;
        }
        cancelling = true;
        message = cancellingMessage(options.kind);
        cancelBtn.disabled = true;
        paint();
        controller.abort(new TransferCancelledError());
    }

    let escapeBinding: ReturnType<typeof bindModalEscape> | null = null;
    document.body.appendChild(overlay);
    paint();
    escapeBinding = bindModalEscape(requestCancel, {
        isOpen: () => overlay.isConnected && !closed
    });
    cancelBtn.addEventListener('click', () => {
        requestCancel();
    });
    queueMicrotask(() => {
        cancelBtn.focus();
    });

    const session: TransferProgressSession = {
        kind: options.kind,
        signal: controller.signal,
        update(patch) {
            if (cancelling || closed) {
                return;
            }
            if (typeof patch.message === 'string' && patch.message) {
                message = patch.message;
            }
            if (
                typeof patch.completed === 'number' &&
                Number.isFinite(patch.completed)
            ) {
                completed = Math.max(0, patch.completed);
            }
            if (
                typeof patch.total === 'number' &&
                Number.isFinite(patch.total)
            ) {
                total = Math.max(0, patch.total);
            }
            if (
                typeof patch.bytesCompleted === 'number' &&
                Number.isFinite(patch.bytesCompleted)
            ) {
                bytesCompleted = Math.max(0, patch.bytesCompleted);
            }
            if (
                typeof patch.bytesTotal === 'number' &&
                Number.isFinite(patch.bytesTotal)
            ) {
                bytesTotal = Math.max(0, patch.bytesTotal);
            }
            paint();
        },
        get completed() {
            return completed;
        },
        get total() {
            return total;
        }
    };

    try {
        const result = await options.work(session);
        throwIfAborted(controller.signal);
        return result;
    } catch (error) {
        if (controller.signal.aborted || isTransferCancelled(error)) {
            throw error instanceof TransferCancelledError
                ? error
                : new TransferCancelledError();
        }
        throw error;
    } finally {
        closeOverlay();
    }
}

export { yieldToUi, throwIfAborted };
