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
                console.log(`🔵 beforeSave callback: ${filename}`);
            },

            afterSave: (fontId, filename, duration) => {
                const callbackStart = performance.now();
                const fname = filename.split('/').pop();
                console.log(
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
                    `⏱️ afterSave callback completed in ${callbackDuration.toFixed(0)}ms`
                );
            },

            onError: (fontId, filename, error) => {
                console.error(`❌ Save failed: ${error}`);
                this.isSaving = false;
                this.showError();
            }
        };

        console.log(
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
        console.log('🔵 Save button clicked');

        this.isSaving = true;
        this.button.prop('disabled', true).text('Saving...');

        try {
            // Check if tracking is ready, and wait if needed
            const trackingCheckStart = performance.now();
            const trackingReady = await window.pyodide.runPythonAsync(`
IsTrackingReady()
            `);
            console.log(
                `⏱️ Tracking check: ${(performance.now() - trackingCheckStart).toFixed(0)}ms`
            );

            if (!trackingReady) {
                console.log('Waiting for dirty tracking to initialize...');
                this.button.text('Preparing...');

                // Wait for tracking init promise if available
                if (window._trackingInitPromise) {
                    await window._trackingInitPromise;
                    console.log('Tracking ready, proceeding with save');
                    this.button.text('Saving...');
                }
            }

            // Simply call font.save() - callbacks will handle everything else
            const pythonSaveStart = performance.now();
            console.log('🔵 Calling Python font.save()...');
            const result = await window.pyodide.runPythonAsync(`
# Get font and call save - this triggers all registered callbacks
font = CurrentFont()
if font:
    font.save()
    "success"  # Return a truthy value
else:
    None
            `);
            const pythonSaveDuration = performance.now() - pythonSaveStart;
            console.log(
                `⏱️ Python save returned: ${pythonSaveDuration.toFixed(0)}ms`
            );

            if (!result) {
                throw new Error('No font open or save failed');
            }

            // Success - callbacks have already handled UI updates
            // Note: isSaving is set to false by afterSave callback
            const totalDuration = performance.now() - saveStartTime;
            console.log(
                `⏱️ Total save duration: ${totalDuration.toFixed(0)}ms`
            );
        } catch (error) {
            console.error('Error saving font:', error);
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
        const dropdown = document.getElementById('open-fonts-dropdown');
        const hasFontOpen =
            dropdown &&
            dropdown.options.length > 0 &&
            dropdown.value !== '' &&
            dropdown.options[0].textContent !== 'No fonts open';

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
