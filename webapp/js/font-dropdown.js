// Font Dropdown Management
// Synchronizes the open fonts dropdown with Python's __open_fonts list

class FontDropdownManager {
    constructor() {
        this.dropdown = document.getElementById('open-fonts-dropdown');
        this.dirtyIndicator = document.getElementById('file-dirty-indicator');
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Handle dropdown selection changes
        this.dropdown.addEventListener('change', (e) => {
            const selectedFontId = e.target.value;
            if (selectedFontId) {
                this.setCurrentFont(selectedFontId);
            }
        });
    }

    async updateDropdown() {
        if (!window.pyodide) {
            console.warn('Pyodide not yet loaded');
            return;
        }

        try {
            // Get the list of open fonts from Python using GetOpenFonts()
            const fontsJson = await window.pyodide.runPythonAsync(`
import json
fonts_list = GetOpenFonts()
json.dumps(fonts_list)
            `);

            const fonts = JSON.parse(fontsJson);

            // Clear existing options
            this.dropdown.innerHTML = '';

            if (fonts.length === 0) {
                // No fonts open
                const option = document.createElement('option');
                option.value = '';
                option.textContent = 'No fonts open';
                this.dropdown.appendChild(option);
                this.dropdown.disabled = true;
            } else {
                // Add font options
                this.dropdown.disabled = false;
                fonts.forEach((fontInfo) => {
                    const option = document.createElement('option');
                    option.value = fontInfo.id;
                    option.textContent = fontInfo.name;
                    option.title = fontInfo.path; // Show path on hover

                    // Select the current font
                    if (fontInfo.is_current) {
                        option.selected = true;
                    }

                    this.dropdown.appendChild(option);
                });
            }
        } catch (error) {
            console.error('Error updating font dropdown:', error);
        }
    }

    async setCurrentFont(fontId) {
        if (!window.pyodide) {
            console.warn('Pyodide not yet loaded');
            return;
        }

        try {
            // Set the current font using SetCurrentFont()
            const success = await window.pyodide.runPythonAsync(`
SetCurrentFont("${fontId}")
            `);

            if (success) {
                console.log(`Set current font to ID: ${fontId}`);
                // Update dirty indicator for newly selected font
                await this.updateDirtyIndicator();

                // Dispatch fontLoaded event
                window.dispatchEvent(
                    new CustomEvent('fontLoaded', {
                        detail: { fontId }
                    })
                );
            } else {
                console.error(`Failed to set current font to ID: ${fontId}`);
            }
        } catch (error) {
            console.error('Error setting current font:', error);
        }
    }

    async updateDirtyIndicator() {
        if (!window.pyodide || !this.dirtyIndicator) {
            return;
        }

        try {
            // Check if current font is dirty for file saving
            // Use _originalRunPythonAsync to bypass the execution wrapper
            // and prevent infinite loop with afterPythonExecution()
            const runPython =
                window.pyodide._originalRunPythonAsync ||
                window.pyodide.runPythonAsync;

            const isDirtyJson = await runPython.call(
                window.pyodide,
                `
import json
try:
    from context import DIRTY_FILE_SAVING
    current_font = CurrentFont()
    result = {"dirty": current_font.is_dirty(DIRTY_FILE_SAVING) if current_font else False}
except Exception as e:
    result = {"dirty": False, "error": str(e)}
json.dumps(result)
            `
            );

            // Check if we got valid JSON
            if (!isDirtyJson || isDirtyJson === 'undefined') {
                console.warn('No valid response from dirty check');
                this.dirtyIndicator.classList.remove('visible');
                return;
            }

            const result = JSON.parse(isDirtyJson);
            const isDirty = result.dirty;

            // Simply show or hide based on dirty state
            if (isDirty) {
                this.dirtyIndicator.classList.add('visible');
            } else {
                this.dirtyIndicator.classList.remove('visible');
            }

            if (result.error) {
                console.warn('Error checking dirty status:', result.error);
            }
        } catch (error) {
            console.error('Error updating dirty indicator:', error);
            // Hide indicator on error to avoid confusion
            this.dirtyIndicator.classList.remove('visible');
        }
    }

    // Method to be called when a font is opened
    async onFontOpened() {
        // Set flag to skip dirty checks during font loading
        if (window.setFontLoadingState) {
            window.setFontLoadingState(true);
        }

        try {
            await this.updateDropdown();

            // Update save button state
            if (window.saveButton) {
                window.saveButton.updateButtonState();
            }

            // Update compile button state
            if (window.compileFontButton) {
                window.compileFontButton.updateState();
            }
        } finally {
            // Re-enable dirty checks after font loading completes
            if (window.setFontLoadingState) {
                window.setFontLoadingState(false);
            }
        }
    }

    // Method to be called when a font is closed
    async onFontClosed() {
        await this.updateDropdown();

        // Update save button state
        if (window.saveButton) {
            window.saveButton.updateButtonState();
        }

        // Update compile button state
        if (window.compileFontButton) {
            window.compileFontButton.updateState();
        }
    }
}

// Initialize the font dropdown manager when page loads
document.addEventListener('DOMContentLoaded', () => {
    window.fontDropdownManager = new FontDropdownManager();

    // Initial check after a delay to populate dropdown
    const checkForUpdates = async () => {
        if (window.pyodide && window.fontDropdownManager) {
            await window.fontDropdownManager.updateDropdown();
        }
    };

    setTimeout(checkForUpdates, 2000);

    // Note: Dropdown updates are now triggered explicitly by calling
    // window.fontDropdownManager.updateDropdown() after font operations
    // (e.g., after OpenFont(), CloseFont(), etc.)
    // This avoids unnecessary polling and the infinite loop issue
});
