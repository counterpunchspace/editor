/**
 * Save Button Management
 * Handles the save button state and save functionality
 */

import {
    beginLoadingCursor,
    endLoadingCursor,
    withLoadingCursor
} from './loading-cursor';
import { isTourKeyEventAllowed } from './tour-spotlight';
import { savesInPlace } from './font-windows/font-formats';
import { showNotice } from './font-windows/dialogs';

declare const $: any;

class SaveButton {
    isSaving: boolean;
    saveEnabled: boolean;

    constructor() {
        this.isSaving = false;
        this.saveEnabled = true;

        // Global keyboard shortcut
        $(document).on('keydown', (e: KeyboardEvent) => {
            // Cmd+S (Mac) or Ctrl+S (Windows/Linux)
            // Cmd+Shift+S is reserved for font Save As
            if ((e.metaKey || e.ctrlKey) && e.key === 's' && !e.shiftKey) {
                if (!isTourKeyEventAllowed(e)) {
                    e.preventDefault();
                    return;
                }
                e.preventDefault();
                void this.handleSave();
            }
        });

        // Register UI callbacks with Python backend
        this.registerCallbacks();
    }

    /**
     * Register callback functions that Python can call via js module
     */
    registerCallbacks() {
        // Create JavaScript functions that Python can call via js._fontSaveCallbacks
        window._fontSaveCallbacks = {
            beforeSave: (fontId: string, filename: string) => {
                console.log(
                    '[SaveButton]',
                    `🔵 beforeSave callback: ${filename}`
                );
            },

            afterSave: (fontId: string, filename: string, duration: number) => {
                const callbackStart = performance.now();
                const fname = filename.split('/').pop();
                console.log(
                    '[SaveButton]',
                    `🟢 afterSave callback: ${fname} (Python reported: ${duration.toFixed(2)}s)`
                );

                // Update dirty indicator (font was just saved, so it's clean)
                if (window.fontManager) {
                    window.fontManager.updateDirtyIndicator();
                }

                // Update save button state
                this.isSaving = false;
                this.showSuccess();

                const callbackDuration = performance.now() - callbackStart;
                console.log(
                    '[SaveButton]',
                    `⏱️ afterSave callback completed in ${callbackDuration.toFixed(0)}ms`
                );
            },

            onError: (fontId: string, filename: string, error: string) => {
                console.error('[SaveButton]', `❌ Save failed: ${error}`);
                this.isSaving = false;
                this.showError();
            }
        };

        console.log(
            '[SaveButton]',
            'Save callbacks registered (Python will call via js module)'
        );
    }

    /**
     * The main window of this linked window's font, while it can be reached.
     * Linked windows are opened from it with window.open, so they share its
     * objects and can call into it directly.
     */
    private reachableMainWindow(): Window | null {
        if (!window.windowRole?.isLinkedWindow?.()) return null;
        const path = window.fontManager?.currentFont?.path;
        let candidate: Window | null = window.opener;
        // A linked window may have been opened from another linked window.
        for (let hops = 0; candidate && hops < 8; hops += 1) {
            try {
                if (
                    candidate.windowRole?.isMainWindow?.() &&
                    candidate.fontManager?.currentFont?.path === path
                ) {
                    return candidate;
                }
                candidate = candidate.opener;
            } catch {
                return null;
            }
        }
        return null;
    }

    /**
     * Handle save action
     */
    async handleSave() {
        if (!this.saveEnabled) {
            return;
        }

        // A linked window shows its main window's font. The main window holds
        // the file, its folder layout and the access to it, so it saves.
        const main = this.reachableMainWindow();
        if (main?.saveButton) {
            // The main window shows its own busy cursor; so does this one.
            await withLoadingCursor(async () => {
                await main.saveButton?.handleSave();
            });
            const own = window.fontManager?.currentFont;
            if (own && !main.fontManager?.currentFont?.hasUnsavedChanges) {
                own.hasUnsavedChanges = false;
                own.folderSaveTracker.reset();
                await window.fontManager?.updateDirtyIndicator();
            }
            this.updateButtonState();
            return;
        }

        // A font with no file yet, or one whose format opens but doesn't
        // save (.vfj, .sfd, .ttf), goes to Save As. Cloud and GitHub own the
        // font's storage, so they save in place without a file handle.
        const currentFont = window.fontManager?.currentFont;
        const pluginId = currentFont?.sourcePlugin.getId();
        const ownsStorage = pluginId === 'cloud' || pluginId === 'github';
        if (
            currentFont &&
            !ownsStorage &&
            (!currentFont.fileHandle || !savesInPlace(currentFont.path))
        ) {
            if (!this.hasFontOpen()) return;
            await window.saveFontAs?.();
            return;
        }

        if (!this.canSave()) {
            return;
        }

        const saveStartTime = performance.now();
        console.log('[SaveButton]', '🔵 Save button clicked');

        this.isSaving = true;
        beginLoadingCursor();

        try {
            // Get current font
            const currentFont = window.fontManager?.currentFont;
            if (!currentFont) {
                throw new Error('No font loaded');
            }

            const pluginId = currentFont.sourcePlugin.getId();
            console.log(
                '[SaveButton]',
                `${currentFont.sourcePlugin.getIcon()} Saving to ${pluginId}...`
            );
            const saveOperationStart = performance.now();

            // Sync JSON from object model first
            currentFont.syncJsonFromModel();

            // Save via plugin
            await currentFont.save();

            // Update dirty indicator
            if (window.fontManager) {
                await window.fontManager.updateDirtyIndicator();
            }

            const duration = (performance.now() - saveOperationStart) / 1000;
            console.log(
                '[SaveButton]',
                `✅ Save completed in ${duration.toFixed(2)}s`
            );

            // Trigger callbacks
            if (window._fontSaveCallbacks) {
                window._fontSaveCallbacks.afterSave?.(
                    window.fontManager.currentFontId,
                    currentFont.path,
                    duration
                );
            }

            // Success - callbacks have already handled UI updates
            // Note: isSaving is set to false by afterSave callback
            const totalDuration = performance.now() - saveStartTime;
            console.log(
                '[SaveButton]',
                `⏱️ Total save duration: ${totalDuration.toFixed(0)}ms`
            );
        } catch (error) {
            console.error('[SaveButton]', 'Error saving font:', error);
            // Only show error if callbacks haven't already handled it
            // (callbacks might have been called even if we got an error here)
            if (this.isSaving) {
                this.isSaving = false;
                this.showError();
            }
            // Say why: the button alone only flashes.
            showNotice(
                `Couldn’t save: ${error instanceof Error ? error.message : String(error)}`
            );
        } finally {
            endLoadingCursor();
        }
    }

    /**
     * Update button state based on current font
     */
    updateButtonState() {
        window.dispatchEvent(new CustomEvent('fontSaveStateChanged'));
    }

    hasFontOpen(): boolean {
        return !!window.fontManager?.currentFont;
    }

    isDirty(): boolean {
        return !!window.fontManager?.hasUnsyncedChanges?.(
            window.fontManager?.currentFont
        );
    }

    canSave(): boolean {
        return (
            this.saveEnabled &&
            !this.isSaving &&
            this.hasFontOpen() &&
            this.isDirty()
        );
    }

    canSaveAs(): boolean {
        return this.saveEnabled && !this.isSaving && this.hasFontOpen();
    }

    /**
     * Show success feedback
     */
    showSuccess() {
        this.updateButtonState();
        setTimeout(() => {
            if (!this.isSaving) {
                this.updateButtonState();
            }
        }, 1500);
    }

    /**
     * Show error feedback
     */
    showError() {
        this.updateButtonState();
        setTimeout(() => {
            if (!this.isSaving) {
                this.updateButtonState();
            }
        }, 2000);
    }
}

// Initialize save button when DOM is ready
$(document).ready(() => {
    window.saveButton = new SaveButton();
});
