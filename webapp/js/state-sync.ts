// Application State Synchronization
// Monitors application state changes and syncs with StateManager (which syncs to URL)

import { Logger } from './logger';
import type { GlyphCanvas } from './glyph-canvas';
import { userspaceLocationsEqual, type UserspaceLocation } from './locations';

const console = new Logger('StateSync');

let isInitialized = false;

/**
 * URL `cursor` is the caret index in text mode and the selected glyph
 * index in edit mode. Reshape always emits `cursormoved` even when the
 * caret cluster changed as a side effect of `selectGlyphByIndex`.
 */
export function getUrlCursorFromEditor(glyphCanvas: GlyphCanvas): number {
    const textRunEditor = glyphCanvas.textRunEditor;
    if (!textRunEditor) {
        return Number(window.stateManager?.editor_cursor_position ?? 0);
    }

    if (
        glyphCanvas.outlineEditor?.active &&
        textRunEditor.selectedGlyphIndex >= 0
    ) {
        return textRunEditor.selectedGlyphIndex;
    }

    return textRunEditor.cursorPosition;
}

function syncEditorCursorToState(glyphCanvas: GlyphCanvas): void {
    if (!window.stateManager?.isUrlSyncEnabled()) {
        return;
    }

    const cursor = getUrlCursorFromEditor(glyphCanvas);
    window.stateManager.editor_cursor_position = cursor;
    window.stateManager.recordEvent('cursor_moved', 'TextRunEditor', {
        cursor
    });
}

/**
 * Disable URL synchronization temporarily (e.g., during state restoration)
 */
export function disableSync() {
    window.stateManager?.disableUrlSync();
    console.log('URL sync disabled');
}

/**
 * Re-enable URL synchronization
 */
export function enableSync() {
    window.stateManager?.enableUrlSync();

    // Align axes ↔ StateManager without clobbering a URL-restored location.
    // A concurrent setFont can stomp axes back to the font default between
    // restoreStateFromUrl and enableSync; prefer StateManager when it already
    // holds a restored location and push that onto axes.
    const axesManager = window.glyphCanvas?.axesManager;
    if (axesManager && window.stateManager) {
        const existing = window.stateManager.editor_variation_location;
        const hasExisting = !!existing && Object.keys(existing).length > 0;

        if (hasExisting) {
            // URL sync is on again, so writing the reconciled location back
            // also drops unknown axes and out-of-range values from the URL.
            const location = axesManager.reconcileLocation(existing);
            if (!userspaceLocationsEqual(location, existing)) {
                window.stateManager.editor_variation_location = location;
            }
            for (const [tag, value] of Object.entries(location)) {
                axesManager.setAxisValue(tag, Number(value));
            }
            axesManager.updateAxisSliders();
        } else {
            const location = axesManager.variationSettings || {};
            const roundedLocation: UserspaceLocation = {};
            for (const [tag, value] of Object.entries(location)) {
                roundedLocation[tag] = Math.round(Number(value));
            }
            window.stateManager.editor_variation_location = roundedLocation;
        }
    }

    // Same race as axes: updateFeaturesUI can fill default-off states after
    // URL restore wrote enabled tags into StateManager. Push those tags back
    // onto FeaturesManager and reshape so `?features=` survives reload.
    const featuresManager = window.glyphCanvas?.featuresManager;
    if (featuresManager && window.stateManager) {
        const restored =
            window.stateManager.editor_opentype_features_in_subset || {};
        const enabledTags = Object.entries(restored)
            .filter(([, enabled]) => enabled)
            .map(([tag]) => tag);

        if (enabledTags.length > 0) {
            let needsReshape = false;
            for (const tag of enabledTags) {
                if (featuresManager.featureSettings[tag] !== true) {
                    featuresManager.featureSettings[tag] = true;
                    needsReshape = true;
                }
            }
            featuresManager.syncFeatureButtonEnabledClasses();
            featuresManager.updateFeatureResetButton();
            // Do not reshape over a live outline session that started after
            // restore (tests and users can enter edit before this compile
            // finishes). Feature tags are already on FeaturesManager.
            if (needsReshape && !window.glyphCanvas?.outlineEditor?.active) {
                featuresManager.call('change');
            }
        }
    }

    console.log('URL sync enabled');
}

/**
 * Check if URL synchronization is enabled
 */
export function isSyncEnabled(): boolean {
    return window.stateManager?.isUrlSyncEnabled() || false;
}

/**
 * Initialize state synchronization
 * Call this after glyphCanvas and fontManager are initialized
 * Bridges between legacy managers and new StateManager
 */
export function initStateSync(glyphCanvas: GlyphCanvas) {
    if (isInitialized) {
        console.warn('State sync already initialized');
        return;
    }

    isInitialized = true;
    console.log('Initializing state synchronization...');

    if (!window.stateManager) {
        console.error('StateManager not initialized!');
        return;
    }

    const syncHarfBuzzGlyphState = () => {
        const textRunEditor = glyphCanvas.textRunEditor;
        if (!textRunEditor) {
            return;
        }

        const glyphBuffer = textRunEditor.shapedGlyphs || [];

        // Compact per-field strings for low-noise runtime inspection and
        // test snapshot diffing. Each is a single space-separated line.
        const nameBuffer = Array.isArray(textRunEditor.glyphNameBuffer)
            ? textRunEditor.glyphNameBuffer
            : [];
        window.stateManager.editor_harfbuzz_glyph_names = nameBuffer.join(' ');

        const gids: string[] = [];
        const dxs: string[] = [];
        const dys: string[] = [];
        const axs: string[] = [];
        const ays: string[] = [];
        const cls: string[] = [];
        for (const g of glyphBuffer) {
            gids.push(String(g.g ?? ''));
            dxs.push(String(g.dx ?? ''));
            dys.push(String(g.dy ?? ''));
            axs.push(String(g.ax ?? ''));
            ays.push(String(g.ay ?? ''));
            cls.push(String(g.cl ?? ''));
        }
        window.stateManager.editor_harfbuzz_gids = gids.join(' ');
        window.stateManager.editor_harfbuzz_dx = dxs.join(' ');
        window.stateManager.editor_harfbuzz_dy = dys.join(' ');
        window.stateManager.editor_harfbuzz_ax = axs.join(' ');
        window.stateManager.editor_harfbuzz_ay = ays.join(' ');
        window.stateManager.editor_harfbuzz_cl = cls.join(' ');
    };

    // Monitor text buffer changes
    if (glyphCanvas.textRunEditor) {
        glyphCanvas.textRunEditor.on('render', () => {
            syncHarfBuzzGlyphState();
        });

        glyphCanvas.textRunEditor.on('textchanged', () => {
            if (!window.stateManager.isUrlSyncEnabled()) return;

            const text = glyphCanvas.textRunEditor!.textBuffer;
            // Update StateManager, which will sync to URL
            window.stateManager.editor_text_buffer = text;
            window.stateManager.recordEvent('text_changed', 'TextRunEditor', {
                length: text.length
            });
        });

        // Monitor cursor position changes
        glyphCanvas.textRunEditor.on('cursormoved', () => {
            syncEditorCursorToState(glyphCanvas);
        });

        syncHarfBuzzGlyphState();
    }

    // Monitor glyph selection in editing mode
    window.addEventListener('editorModeChanged', ((e: CustomEvent) => {
        if (!window.stateManager.isUrlSyncEnabled()) return;

        // When in editing mode, sync the selected glyph index as cursor
        if (e.detail.mode === 'edit' && glyphCanvas.textRunEditor) {
            const cursor = glyphCanvas.textRunEditor.selectedGlyphIndex;
            if (cursor >= 0) {
                window.stateManager.editor_cursor_position = cursor;
                window.stateManager.recordEvent(
                    'glyph_selected_in_edit_mode',
                    'TextRunEditor',
                    { cursor }
                );
            }
            return;
        }

        if (e.detail.mode === 'text' && glyphCanvas.textRunEditor) {
            syncEditorCursorToState(glyphCanvas);
        }
    }) as EventListener);

    // Monitor glyph stack changes from outline editor navigation
    window.addEventListener('glyphStackChanged', ((e: CustomEvent) => {
        if (!window.stateManager.isUrlSyncEnabled()) return;
        const glyphStack = e.detail?.glyphStack || '';
        window.stateManager.editor_glyph_stack = glyphStack;
        window.stateManager.recordEvent(
            'glyph_stack_changed',
            'OutlineEditor',
            {
                depth: glyphStack ? glyphStack.split('>').length - 1 : 0
            }
        );
    }) as EventListener);

    // Monitor axis/location changes
    if (glyphCanvas.axesManager) {
        const syncVariationLocation = (
            eventType:
                'variation_location_initialized' | 'variation_location_changed'
        ) => {
            const location = glyphCanvas.axesManager!.variationSettings || {};
            const roundedLocation: UserspaceLocation = {};
            for (const [tag, value] of Object.entries(location)) {
                roundedLocation[tag] = Math.round(Number(value));
            }

            window.stateManager.editor_variation_location = roundedLocation;

            // Notify glyph overview and other listeners about location change
            window.dispatchEvent(
                new CustomEvent('variationLocationChanged', {
                    detail: { location: roundedLocation }
                })
            );

            // Only record events when URL sync is active.
            if (!window.stateManager.isUrlSyncEnabled()) return;

            window.stateManager.recordEvent(eventType, 'AxesManager', {
                axisCount: Object.keys(roundedLocation).length
            });
        };

        const syncAnimationFlags = () => {
            window.stateManager.editor_isAnimating =
                !!glyphCanvas.axesManager!.isAnimating;
            window.stateManager.editor_isInterpolating =
                !!glyphCanvas.outlineEditor?.isInterpolating;
        };

        glyphCanvas.axesManager.on('sliderMouseDown', () => {
            if (!window.stateManager.isUrlSyncEnabled()) return;
            syncAnimationFlags();
        });

        glyphCanvas.axesManager.on('animationInProgress', () => {
            if (!window.stateManager.isUrlSyncEnabled()) return;
            syncAnimationFlags();
        });

        glyphCanvas.axesManager.on('sliderMouseUp', () => {
            if (!window.stateManager.isUrlSyncEnabled()) return;
            syncAnimationFlags();
            syncVariationLocation('variation_location_changed');
        });

        // Listen to animation complete - this fires when sliders finish moving
        glyphCanvas.axesManager.on('animationComplete', () => {
            syncVariationLocation('variation_location_changed');

            if (!window.stateManager.isUrlSyncEnabled()) return;

            syncAnimationFlags();
        });

        glyphCanvas.axesManager.on('textFieldAnimationComplete', () => {
            if (!window.stateManager.isUrlSyncEnabled()) return;
            syncAnimationFlags();
            syncVariationLocation('variation_location_changed');
        });

        glyphCanvas.axesManager.on('updated', () => {
            syncVariationLocation('variation_location_initialized');
        });

        // Capture current defaults at startup/font load even before any user axis interaction.
        syncVariationLocation('variation_location_initialized');
    }

    // Monitor feature changes
    if (glyphCanvas.featuresManager) {
        const syncOpenTypeFeaturesState = (
            eventType:
                'opentype_features_changed' | 'opentype_features_initialized'
        ) => {
            if (!window.stateManager.isUrlSyncEnabled()) return;

            // Clone to avoid sharing mutable references with FeaturesManager.
            // This ensures StateManager change detection/history works reliably.
            const featureSettings = {
                ...glyphCanvas.featuresManager!.featureSettings
            };
            const availabilityBySubset = {
                ...glyphCanvas.featuresManager!
                    .featureAvailabilityInEditingSubset
            };

            const featuresInSubset: Record<string, boolean> = {};
            const featuresNotInSubset: Record<string, boolean> = {};

            for (const [tag, enabled] of Object.entries(featureSettings)) {
                // Match sidebar button logic: available unless explicitly false.
                const isInSubset = availabilityBySubset[tag] !== false;
                if (isInSubset) {
                    featuresInSubset[tag] = enabled;
                } else {
                    featuresNotInSubset[tag] = enabled;
                }
            }

            window.stateManager.editor_opentype_features_in_subset =
                featuresInSubset;
            window.stateManager.editor_opentype_features_not_in_subset =
                featuresNotInSubset;

            const enabledInSubsetCount =
                Object.values(featuresInSubset).filter(Boolean).length;
            const enabledNotInSubsetCount =
                Object.values(featuresNotInSubset).filter(Boolean).length;
            window.stateManager.recordEvent(eventType, 'FeaturesManager', {
                enabledInSubsetCount,
                enabledNotInSubsetCount,
                inSubsetCount: Object.keys(featuresInSubset).length,
                notInSubsetCount: Object.keys(featuresNotInSubset).length
            });
        };

        glyphCanvas.featuresManager.on('change', () => {
            syncOpenTypeFeaturesState('opentype_features_changed');
        });

        // Capture initial/default-on state when features are (re)built.
        glyphCanvas.featuresManager.on('updated', () => {
            syncOpenTypeFeaturesState('opentype_features_initialized');
        });
    }

    // Monitor mode changes by listening to custom event
    window.addEventListener('editorModeChanged', ((e: CustomEvent) => {
        if (!window.stateManager.isUrlSyncEnabled()) return;

        const mode = e.detail.mode as 'text' | 'edit';
        console.log('Mode changed to:', mode);
        window.stateManager.editor_mode = mode;
        window.stateManager.recordEvent(
            'editor_mode_changed',
            'OutlineEditor',
            {
                mode
            }
        );
    }) as EventListener);

    console.log('State synchronization initialized');
}

// Export for use in window
(window as any).initStateSync = initStateSync;
(window as any).disableSync = disableSync;
(window as any).enableSync = enableSync;
