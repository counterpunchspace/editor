/**
 * Save Button Management
 * Handles the save button state and save functionality
 */

class SaveButton {
    constructor() {
        this.button = $('#save-font-btn');
        this.isSaving = false;

        // Bind event handlers
        this.button.on('click', () => this.handleSave());

        // Global keyboard shortcut
        $(document).on('keydown', (e) => {
            // Cmd+S (Mac) or Ctrl+S (Windows/Linux)
            // BUT NOT Cmd+Shift+S (that's for focusing script editor)
            if ((e.metaKey || e.ctrlKey) && e.key === 's' && !e.shiftKey) {
                e.preventDefault();
                this.handleSave();
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
            beforeSave: (fontId, filename) => {
                console.log(
                    '[SaveButton]',
                    `🔵 beforeSave callback: ${filename}`
                );
            },

            afterSave: (fontId, filename, duration) => {
                const callbackStart = performance.now();
                const fname = filename.split('/').pop();
                console.log(
                    '[SaveButton]',
                    `🟢 afterSave callback: ${fname} (Python reported: ${duration.toFixed(2)}s)`
                );

                // Hide dirty indicator immediately (font was just saved, so it's clean)
                // No need to check via Python - we know it's clean!
                if (window.fontDropdown && window.fontDropdown.dirtyIndicator) {
                    window.fontDropdown.dirtyIndicator.classList.remove(
                        'visible'
                    );
                }

                // Play done sound
                if (window.playSound) {
                    window.playSound('done');
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

            onError: (fontId, filename, error) => {
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
     * Handle save action
     */
    async handleSave() {
        if (this.isSaving || this.button.prop('disabled')) {
            return;
        }

        const saveStartTime = performance.now();
        console.log('[SaveButton]', '🔵 Save button clicked');

        this.isSaving = true;
        this.button.prop('disabled', true).text('Saving...');

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
        }
    }

    /**
     * Update button state based on current font
     */
    updateButtonState() {
        const hasFontOpen =
            window.fontManager && window.fontManager.currentFont;

        if (this.isSaving) {
            this.button.prop('disabled', true).text('Saving...');
        } else if (!hasFontOpen) {
            this.button.prop('disabled', true).text('Save');
        } else {
            this.button.prop('disabled', false).text('Save');
        }
    }

    /**
     * Show success feedback
     */
    showSuccess() {
        this.button.text('Saved!');
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
        this.button.text('Save Failed');
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
