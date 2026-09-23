/**
 * Convert to Counterpunch — migrate implicit Glyphs alignments that match
 * Counterpunch's composition engine, without moving components that do not.
 */

import { Logger } from './logger';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';

const console = new Logger('ConvertToCounterpunch');

export function formatConvertToCounterpunchNotificationBody(
    convertedCount: number,
    compositeCount: number
): string {
    const glyphWord = compositeCount === 1 ? 'glyph' : 'glyphs';
    return `Converted ${convertedCount} of ${compositeCount} composite ${glyphWord} to automatic.`;
}

async function runConvertToCounterpunch(): Promise<void> {
    const fontModel = window.currentFontModel;
    if (!fontModel) {
        return;
    }

    window.patchSyncEngine?.beginTransaction('Convert to Counterpunch', null, {
        compileChangeSource: 'model-edit',
        compileEditType: null
    });
    let convertedCount = 0;
    let compositeCount = 0;
    try {
        const result = fontModel.convertMatchingManualComponentsToAutomatic();
        convertedCount = result.convertedGlyphNames.size;
        compositeCount = result.compositeGlyphCount;
        console.log(
            formatConvertToCounterpunchNotificationBody(
                convertedCount,
                compositeCount
            )
        );
    } finally {
        window.patchSyncEngine?.endTransaction();
    }

    void window.glyphCanvas?.outlineEditor?.fetchLayerData?.(true);
    window.glyphCanvas?.updatePropertyPanel?.();
    window.glyphCanvas?.render?.();

    await window.showSystemNotification('Convert to Counterpunch', {
        body: formatConvertToCounterpunchNotificationBody(
            convertedCount,
            compositeCount
        ),
        tag: 'convert-to-counterpunch'
    });
}

export function openConvertToCounterpunchDialog(): void {
    if (!window.fontManager?.currentFont || !window.currentFontModel) {
        return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'info-popup-overlay';
    overlay.style.display = 'flex';
    overlay.style.zIndex = '10002';

    overlay.innerHTML = `
        <div class="info-popup confirm-dialog">
            <div class="info-popup-header">
                <h3>Convert to Counterpunch</h3>
                <button type="button" class="info-popup-close confirm-dialog-close-btn" aria-label="Cancel">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="info-popup-content confirm-dialog-content">
                <p>Glyphs.app usually does not store whether components are automatically aligned. Convert turns a glyph automatic only when the composition engine can place every component — by anchors, as an unattached-letter ligature (including kerning), or as a single non-mark component — and the result matches the existing positions and layer width on every layer. Components that would move, or layers whose advance would change (for example a tabular figure whose width was set by hand), stay manual.</p>
                <div class="confirm-dialog-actions">
                    <button type="button" class="dialog-button" data-action="cancel">Cancel</button>
                    <button type="button" class="dialog-button dialog-button-primary" data-action="convert">Convert</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    let escapeBinding: ModalEscapeBinding | null = null;

    function cleanup() {
        escapeBinding?.release();
        escapeBinding = null;
        overlay.remove();
    }

    function cancel() {
        cleanup();
    }

    function convert() {
        cleanup();
        void runConvertToCounterpunch();
    }

    escapeBinding = bindModalEscape(cancel, {
        isOpen: () => overlay.isConnected
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            cancel();
        }
    });

    overlay
        .querySelector('.confirm-dialog-close-btn')
        ?.addEventListener('click', cancel);

    overlay.querySelectorAll('[data-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const action = (btn as HTMLElement).dataset.action;
            if (action === 'convert') {
                convert();
                return;
            }
            cancel();
        });
    });

    queueMicrotask(() => {
        const convertBtn = overlay.querySelector(
            '[data-action="convert"]'
        ) as HTMLElement | null;
        convertBtn?.focus();
    });
}
