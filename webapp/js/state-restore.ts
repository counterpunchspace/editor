// Application State Restoration from URL
// Restores application state from URL parameters on load

import { readUrlState, decodeLocation, decodeFeatures } from './url-state';
import { Logger } from './logger';
import type { GlyphCanvas } from './glyph-canvas';

const console = new Logger('StateRestore', true);

/**
 * Restore application state from URL parameters
 * Call this after font is loaded and glyphCanvas is ready
 */
export async function restoreStateFromUrl(
    glyphCanvas: GlyphCanvas
): Promise<void> {
    const state = readUrlState();

    if (Object.keys(state).length === 0) {
        console.log('No state to restore from URL');
        return;
    }

    console.log('Restoring state from URL:', state);

    // Temporarily disable sync to avoid circular updates
    if ((window as any).disableSync) {
        (window as any).disableSync();
    }

    try {
        // 1. Restore features FIRST (before text, as it affects shaping)
        if (state.features !== undefined) {
            const features = state.features
                ? decodeFeatures(state.features)
                : [];
            if (features && glyphCanvas.featuresManager) {
                console.log('Restoring features:', features);

                // Turn off all features first
                for (const tag in glyphCanvas.featuresManager.featureSettings) {
                    glyphCanvas.featuresManager.featureSettings[tag] = false;
                }

                // Enable only the features from URL
                if (features.length > 0) {
                    for (const tag of features) {
                        glyphCanvas.featuresManager.featureSettings[tag] = true;
                    }
                }

                // Update UI
                glyphCanvas.featuresManager.updateFeaturesUI?.();

                // Trigger recompilation
                if (window.fontManager && window.fontManager.isReady()) {
                    const activeFeatures = Object.entries(
                        glyphCanvas.featuresManager.featureSettings
                    )
                        .filter(([tag, enabled]) => enabled)
                        .map(([tag, _]) => tag);

                    await window.fontManager.compileEditingFont(
                        glyphCanvas.textRunEditor!.textBuffer,
                        activeFeatures
                    );
                }
            }
        }

        // 2. Restore designspace location
        if (state.location) {
            const location = decodeLocation(state.location);
            if (location && glyphCanvas.axesManager) {
                console.log('Restoring location:', location);

                for (const [tag, value] of Object.entries(location)) {
                    glyphCanvas.axesManager.setAxisValue(tag, value);
                }

                // This will trigger layer update
                await glyphCanvas.axesManager.call('axisChanged');
            }
        }

        // 3. Restore text buffer
        if (state.text && glyphCanvas.textRunEditor) {
            console.log('Restoring text:', state.text);
            glyphCanvas.textRunEditor.setTextBuffer(state.text);
        }

        // 4. Restore cursor position
        if (
            state.cursor !== null &&
            state.cursor !== undefined &&
            glyphCanvas.textRunEditor
        ) {
            console.log('Restoring cursor position:', state.cursor);

            const maxPos = glyphCanvas.textRunEditor.textBuffer.length;
            const cursorPos = Math.min(state.cursor, maxPos);

            glyphCanvas.textRunEditor.cursorPosition = cursorPos;
            glyphCanvas.textRunEditor.updateCursorVisualPosition();

            // Trigger render to show cursor at restored position
            glyphCanvas.renderer?.render();
        }

        // 5. Restore mode (text vs editing)
        if (state.mode) {
            console.log('Restoring mode:', state.mode);

            if (state.mode === 'edit') {
                // Enter editing mode
                // Use cursor position to select the glyph (cursor in edit mode = glyph index)
                let glyphIndex = state.cursor ?? 0;

                // Ensure glyph index is within bounds
                const maxIndex =
                    glyphCanvas.textRunEditor!.shapedGlyphs.length - 1;
                glyphIndex = Math.max(0, Math.min(glyphIndex, maxIndex));

                console.log('Selecting glyph at index:', glyphIndex);
                await glyphCanvas.textRunEditor!.selectGlyphByIndex(glyphIndex);

                // Activate editing mode
                if (glyphCanvas.textRunEditor!.selectedGlyphIndex >= 0) {
                    glyphCanvas.outlineEditor.active = true;
                    glyphCanvas.renderer?.render();
                }
            } else {
                // Ensure we're in text mode
                glyphCanvas.outlineEditor.active = false;
                glyphCanvas.renderer?.render();
            }
        }

        console.log('State restoration complete');
    } catch (error) {
        console.error('Error restoring state from URL:', error);
    } finally {
        // Re-enable sync
        if ((window as any).enableSync) {
            (window as any).enableSync();
        }
    }
}

// Export for use in window
(window as any).restoreStateFromUrl = restoreStateFromUrl;
