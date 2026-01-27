// Application State Synchronization
// Monitors application state changes and syncs with URL

import { updateUrlState, encodeLocation, encodeFeatures } from './url-state';
import { Logger } from './logger';
import type { GlyphCanvas } from './glyph-canvas';
import type fontManager from './font-manager';

const console = new Logger('StateSync', true);

let isInitialized = false;
let syncEnabled = true; // Can be disabled temporarily during restoration

/**
 * Disable URL synchronization temporarily (e.g., during state restoration)
 */
export function disableSync() {
    syncEnabled = false;
    console.log('URL sync disabled');
}

/**
 * Re-enable URL synchronization
 */
export function enableSync() {
    syncEnabled = true;
    console.log('URL sync enabled');
}

/**
 * Initialize state synchronization
 * Call this after glyphCanvas and fontManager are initialized
 */
export function initStateSync(glyphCanvas: GlyphCanvas) {
    if (isInitialized) {
        console.warn('State sync already initialized');
        return;
    }

    isInitialized = true;
    console.log('Initializing state synchronization...');

    // Monitor text buffer changes
    if (glyphCanvas.textRunEditor) {
        glyphCanvas.textRunEditor.on('textchanged', () => {
            if (!syncEnabled) return;

            const text = glyphCanvas.textRunEditor!.textBuffer;
            // Only sync if text is not too long (avoid huge URLs)
            if (text && text.length < 200) {
                updateUrlState({ text: encodeURIComponent(text) });
            }
        });

        // Monitor cursor position changes
        glyphCanvas.textRunEditor.on('cursormoved', () => {
            if (!syncEnabled) return;

            const cursor = glyphCanvas.textRunEditor!.cursorPosition;
            updateUrlState({ cursor });
        });
    }

    // Monitor glyph selection in editing mode
    window.addEventListener('editorModeChanged', ((e: CustomEvent) => {
        if (!syncEnabled) return;

        // When in editing mode, sync the selected glyph index as cursor
        if (e.detail.mode === 'edit' && glyphCanvas.textRunEditor) {
            const cursor = glyphCanvas.textRunEditor.selectedGlyphIndex;
            if (cursor >= 0) {
                updateUrlState({ cursor });
            }
        }
    }) as EventListener);

    // Monitor axis/location changes
    if (glyphCanvas.axesManager) {
        glyphCanvas.axesManager.on('axisChanged', () => {
            if (!syncEnabled) return;

            const location = glyphCanvas.axesManager!.variationSettings;
            if (Object.keys(location).length > 0) {
                updateUrlState({ location: encodeLocation(location) });
            } else {
                updateUrlState({ location: null });
            }
        });
    }

    // Monitor feature changes
    if (glyphCanvas.featuresManager) {
        glyphCanvas.featuresManager.on('change', () => {
            if (!syncEnabled) return;

            // Get active features from featureSettings
            const activeFeatures = Object.entries(
                glyphCanvas.featuresManager!.featureSettings
            )
                .filter(([tag, enabled]) => enabled)
                .map(([tag, _]) => tag);

            if (activeFeatures.length > 0) {
                updateUrlState({ features: encodeFeatures(activeFeatures) });
            } else {
                updateUrlState({ features: null });
            }
        });
    }

    // Monitor mode changes by listening to custom event
    window.addEventListener('editorModeChanged', ((e: CustomEvent) => {
        if (!syncEnabled) return;

        const mode = e.detail.mode as 'text' | 'edit';
        console.log('Mode changed to:', mode);
        updateUrlState({ mode });
    }) as EventListener);

    console.log('State synchronization initialized');
}

// Export for use in window
(window as any).initStateSync = initStateSync;
(window as any).disableSync = disableSync;
(window as any).enableSync = enableSync;
