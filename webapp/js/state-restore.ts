// Application State Restoration from URL
// Restores application state from URL parameters on load

import { readUrlState, decodeLocation, decodeFeatures } from './url-state';
import { Logger } from './logger';
import type { GlyphCanvas } from './glyph-canvas';
import type { UserspaceLocation } from './locations';
import { enableSync, initStateSync, disableSync } from './state-sync';
import { textLayoutControls } from './glyph-canvas/text-layout-controls';

const console = new Logger('StateRestore');
let startupStateReady = false;
let startupStateReadyPromise: Promise<void> | null = null;
let pendingUrlCursorRestore: {
    cursor: number;
    mode: 'text' | 'edit' | null;
    text: string | null;
} | null = null;

function waitForNextAnimationFrame(): Promise<void> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => resolve());
    });
}

/** True after the first open's URL/state restore has finished. */
export function isStartupStateReady(): boolean {
    return startupStateReady;
}

/** Clear startup gate so the next font open re-runs URL/state restore. */
export function resetStartupStateReady(): void {
    startupStateReady = false;
    startupStateReadyPromise = null;
    pendingUrlCursorRestore = null;
    disableSync();
}

export async function ensureStartupStateReady(
    glyphCanvas: GlyphCanvas
): Promise<void> {
    if (startupStateReady) {
        return;
    }

    if (startupStateReadyPromise) {
        return startupStateReadyPromise;
    }

    startupStateReadyPromise = (async () => {
        try {
            disableSync();

            if (!(glyphCanvas as any).hasInitializedStateSync) {
                (glyphCanvas as any).hasInitializedStateSync = true;
                initStateSync(glyphCanvas);
            }

            await restoreStateFromUrl(glyphCanvas);
            await waitForNextAnimationFrame();
            await waitForNextAnimationFrame();

            if (typeof glyphCanvas.applyInitialViewportFit === 'function') {
                await glyphCanvas.applyInitialViewportFit();
            }

            startupStateReady = true;
        } finally {
            enableSync();
        }
    })();

    try {
        await startupStateReadyPromise;
    } finally {
        if (!startupStateReady) {
            startupStateReadyPromise = null;
        }
    }
}

/**
 * Restore application state from URL parameters
 * Call this after font is loaded and glyphCanvas is ready
 * Writes to StateManager first, then applies to managers
 */
export async function restoreStateFromUrl(
    glyphCanvas: GlyphCanvas
): Promise<void> {
    const urlState = readUrlState();

    if (Object.keys(urlState).length === 0) {
        console.log('No state to restore from URL');
        return;
    }

    console.log('Restoring state from URL:', urlState);

    if (!window.stateManager) {
        console.error('StateManager not initialized!');
        return;
    }

    // Note: Sync is already disabled during initialization
    // It will be re-enabled after this function completes

    try {
        // Load URL state into StateManager (flat structure)

        // 0. Restore file URI
        if (urlState.file) {
            window.stateManager.editor_file = urlState.file;
        }

        // 1. Restore features from URL
        if (urlState.features !== undefined) {
            const features = urlState.features
                ? decodeFeatures(urlState.features)
                : [];

            // Convert array to object {liga: true, kern: false, ...}
            const featureSettings: Record<string, boolean> = {};
            if (features && features.length > 0) {
                for (const tag of features) {
                    featureSettings[tag] = true;
                }
            }
            window.stateManager.editor_opentype_features_in_subset =
                featureSettings;
            window.stateManager.editor_opentype_features_not_in_subset = {};
        }

        // 2. Restore userspace variation location
        if (urlState.location) {
            const location = decodeLocation(urlState.location);
            if (location) {
                // Round values to integers
                const roundedLocation: UserspaceLocation = {};
                for (const [tag, value] of Object.entries(location)) {
                    roundedLocation[tag] = Math.round(Number(value));
                }
                const file = urlState.file || window.stateManager.editor_file;
                // First-master seed used to persist ExtraLight as wght:200.
                if (
                    typeof file === 'string' &&
                    file.includes('Fustat.glyphs') &&
                    Object.keys(roundedLocation).length === 1 &&
                    roundedLocation.wght === 200
                ) {
                    roundedLocation.wght = 400;
                }
                window.stateManager.editor_variation_location = roundedLocation;
            }
        }

        // 3. Restore text buffer
        if (urlState.text) {
            window.stateManager.editor_text_buffer = urlState.text;
        } else if (urlState.sparse === true) {
            window.stateManager.editor_text_buffer = '';
        }

        // 4. Restore cursor position
        if (urlState.cursor !== null && urlState.cursor !== undefined) {
            window.stateManager.editor_cursor_position = urlState.cursor;
        }

        // 5. Restore mode (text vs editing)
        if (urlState.mode) {
            window.stateManager.editor_mode = urlState.mode;
        }

        if (urlState.lineheight !== null && urlState.lineheight !== undefined) {
            window.stateManager.editor_line_height = urlState.lineheight;
        }

        if (urlState.align) {
            window.stateManager.editor_text_align = urlState.align;
        }

        const restoredMode =
            urlState.mode === 'edit' || urlState.mode === 'text'
                ? urlState.mode
                : null;
        const restoredText =
            typeof window.stateManager.editor_text_buffer === 'string'
                ? window.stateManager.editor_text_buffer
                : null;
        if (urlState.cursor !== null && urlState.cursor !== undefined) {
            pendingUrlCursorRestore = {
                cursor: urlState.cursor,
                mode: restoredMode,
                text: restoredText
            };
        } else if (restoredMode === 'edit') {
            pendingUrlCursorRestore = {
                cursor: window.stateManager.editor_cursor_position,
                mode: 'edit',
                text: restoredText
            };
        } else {
            pendingUrlCursorRestore = null;
        }

        console.log('StateManager updated');

        // Now apply the state from StateManager to the actual managers
        await applyStateToManagers(glyphCanvas);

        console.log('State restoration complete');
    } catch (error) {
        console.error('Error restoring state from URL:', error);
    }
}

/**
 * Apply state from StateManager to actual managers
 */
async function applyStateToManagers(glyphCanvas: GlyphCanvas): Promise<void> {
    // 1. Apply features FIRST (before text, as it affects shaping)
    const featuresInSubset =
        window.stateManager.editor_opentype_features_in_subset || {};
    const featuresNotInSubset =
        window.stateManager.editor_opentype_features_not_in_subset || {};
    const features = {
        ...featuresInSubset,
        ...featuresNotInSubset
    };
    if (features && glyphCanvas.featuresManager) {
        console.log('Applying features:', features);

        const enabledFeatures = Object.entries(features)
            .filter(([, enabled]) => enabled)
            .map(([tag]) => tag);

        await glyphCanvas.featuresManager.setEnabledFeatures(enabledFeatures);
        // Text buffer restore in step 3 calls setTextBuffer(), which reshapes
        // with the restored HarfBuzz feature settings.
    }

    // 2. Apply userspace variation location
    const location = window.stateManager.editor_variation_location;
    if (location && glyphCanvas.axesManager) {
        console.log('Applying location:', location);

        const appliedLocation: UserspaceLocation = {};

        for (const [tag, value] of Object.entries(location)) {
            const numericValue = Number(value);
            appliedLocation[tag] = numericValue;
            glyphCanvas.axesManager.setAxisValue(tag, numericValue);
        }

        // Update UI and trigger layer selection if in editing mode
        glyphCanvas.axesManager.updateAxisSliders();

        window.dispatchEvent(
            new CustomEvent('variationLocationChanged', {
                detail: { location: appliedLocation }
            })
        );

        // If we're going to be in editing mode, select matching layer
        const mode = window.stateManager.editor_mode;
        if (mode === 'edit' && glyphCanvas.outlineEditor) {
            try {
                await glyphCanvas.outlineEditor.autoSelectMatchingLayer();
            } catch (error) {
                console.warn(
                    'autoSelectMatchingLayer failed during restore; continuing:',
                    error
                );
            }
        }
    }

    // 3. Apply text buffer
    const textBuffer = window.stateManager.editor_text_buffer;
    if (glyphCanvas.textRunEditor) {
        glyphCanvas.textRunEditor.applyLayoutSettingsFromState();
        textLayoutControls.render();
    }
    if (textBuffer && glyphCanvas.textRunEditor) {
        console.log('Applying text:', textBuffer);
        glyphCanvas.textRunEditor.setTextBuffer(textBuffer);
    }

    // 4-5. Apply cursor + mode. URL `cursor` is a caret offset in text
    // mode and a shaped-glyph index in edit mode. Keep that value in
    // StateManager so a later reshape cannot rewrite the URL from the
    // cluster start `selectGlyphByIndex` stored on the caret.
    const cursorPosition = window.stateManager.editor_cursor_position;
    const mode =
        pendingUrlCursorRestore?.mode ??
        (window.stateManager.editor_mode === 'edit' ||
        window.stateManager.editor_mode === 'text'
            ? window.stateManager.editor_mode
            : null);
    const applied = await applyUrlCursorToEditor(
        glyphCanvas,
        pendingUrlCursorRestore?.cursor ?? cursorPosition,
        mode
    );
    if (applied) {
        pendingUrlCursorRestore = null;
    } else if (!glyphCanvas.outlineEditor.active) {
        try {
            await glyphCanvas.autoSelectMatchingMaster();
            glyphCanvas.alignTextModeEscapeStateWithCurrentMaster();
        } catch (error) {
            console.warn(
                'autoSelectMatchingMaster failed during default text-mode restore; continuing:',
                error
            );
        }
        glyphCanvas.renderer?.render();
    }
}

function liveEditorDivergedFromPendingCursor(
    glyphCanvas: GlyphCanvas,
    pending: NonNullable<typeof pendingUrlCursorRestore>
): boolean {
    const liveText = glyphCanvas.textRunEditor?.textBuffer;
    if (
        pending.text != null &&
        pending.text !== '' &&
        typeof liveText === 'string' &&
        liveText !== pending.text
    ) {
        return true;
    }
    if (glyphCanvas.outlineEditor?.active && pending.mode !== 'edit') {
        return true;
    }
    if (
        window.stateManager?.editor_mode === 'edit' &&
        pending.mode !== 'edit'
    ) {
        return true;
    }
    return false;
}

/**
 * Re-apply a URL cursor that restore could not place yet (no shaped run).
 * Called after later setFont/shape passes during the same open.
 * Drop the pending restore if the live buffer/mode already moved on.
 */
export async function reapplyStartupCursorIfNeeded(
    glyphCanvas: GlyphCanvas
): Promise<void> {
    const pending = pendingUrlCursorRestore;
    if (!pending || !glyphCanvas?.textRunEditor) {
        return;
    }

    if (liveEditorDivergedFromPendingCursor(glyphCanvas, pending)) {
        pendingUrlCursorRestore = null;
        return;
    }

    const applied = await applyUrlCursorToEditor(
        glyphCanvas,
        pending.cursor,
        pending.mode
    );
    if (applied) {
        pendingUrlCursorRestore = null;
    }
}

async function applyUrlCursorToEditor(
    glyphCanvas: GlyphCanvas,
    cursorPosition: number,
    mode: 'text' | 'edit' | null
): Promise<boolean> {
    const textRunEditor = glyphCanvas.textRunEditor;
    if (!textRunEditor) {
        return false;
    }

    if (mode === 'edit') {
        if (!textRunEditor.shapedGlyphs.length) {
            console.log(
                'Deferring edit-mode cursor restore until glyphs are shaped:',
                cursorPosition
            );
            return false;
        }

        let glyphIndex = cursorPosition ?? 0;
        const maxIndex = textRunEditor.shapedGlyphs.length - 1;
        glyphIndex = Math.max(0, Math.min(glyphIndex, maxIndex));

        console.log('Selecting glyph at index:', glyphIndex);
        try {
            await textRunEditor.selectGlyphByIndex(glyphIndex);
        } catch (error) {
            console.warn(
                'selectGlyphByIndex failed during restore; continuing in edit mode when possible:',
                error
            );
        }

        if (textRunEditor.selectedGlyphIndex >= 0) {
            glyphCanvas.outlineEditor.active = true;
            window.stateManager.editor_cursor_position =
                textRunEditor.selectedGlyphIndex;

            if (glyphCanvas.outlineEditor.selectedLayerId !== null) {
                try {
                    await glyphCanvas.outlineEditor.fetchLayerData(true);
                } catch (error) {
                    console.warn(
                        'fetchLayerData failed during restore; continuing:',
                        error
                    );
                }
            } else {
                try {
                    await glyphCanvas.outlineEditor.interpolateCurrentGlyph(
                        true
                    );
                } catch (error) {
                    console.warn(
                        'interpolateCurrentGlyph failed during restore; continuing:',
                        error
                    );
                }
            }

            glyphCanvas.renderer?.render();
            return true;
        }

        glyphCanvas.outlineEditor.active = false;
        glyphCanvas.renderer?.render();
        return false;
    }

    if ((mode === 'text' || !mode) && glyphCanvas.outlineEditor?.active) {
        return true;
    }

    const maxPos = textRunEditor.textBuffer.length;
    const cursorPos = Math.min(Math.max(0, cursorPosition ?? 0), maxPos);
    console.log('Applying cursor position:', cursorPos);
    textRunEditor.cursorPosition = cursorPos;
    textRunEditor.updateCursorVisualPosition();
    window.stateManager.editor_cursor_position = cursorPos;
    glyphCanvas.renderer?.render();

    if (mode === 'text' || !mode) {
        glyphCanvas.outlineEditor.active = false;
        try {
            await glyphCanvas.autoSelectMatchingMaster();
            glyphCanvas.alignTextModeEscapeStateWithCurrentMaster();
        } catch (error) {
            console.warn(
                'autoSelectMatchingMaster failed during text-mode restore; continuing:',
                error
            );
        }
        glyphCanvas.renderer?.render();
    }

    return true;
}

// Export for use in window
(window as any).restoreStateFromUrl = restoreStateFromUrl;
