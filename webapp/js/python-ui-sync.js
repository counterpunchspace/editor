// Python-UI Synchronization Hooks
// These functions control when UI updates are paused/resumed during Python execution

// Flag to skip dirty checks during font loading operations
let isLoadingFont = false;

// Debounce timer for dirty indicator updates
let dirtyCheckTimeout = null;

/**
 * Called before any Python code execution begins.
 * Use this to pause UI updates and dirty tracking to avoid unnecessary redraws
 * while Python code is modifying font data.
 */
function beforePythonExecution() {
    console.log('🔒 UI updates paused (Python execution starting)');
    // TODO: Pause outline editor canvas redraws
    // TODO: Disable dirty glyph tracking
}

/**
 * Called after Python code execution completes (success or failure).
 * Use this to resume UI updates and check for dirty glyphs that need redrawing.
 */
function afterPythonExecution() {
    console.log('🔓 UI updates resumed (Python execution finished)');
    // TODO: Resume outline editor canvas redraws
    // TODO: Check for dirty glyphs and redraw if current glyph was modified
    // TODO: Call get_and_clear_dirty_glyphs() and update UI accordingly

    // Skip dirty checks if we're loading a font or if dropdown manager not ready
    if (isLoadingFont || !window.fontDropdownManager) {
        console.log(
            '⏭️ Skipping dirty checks (loading font or dropdown not ready)'
        );
        return;
    }

    // Debounce dirty indicator updates to avoid excessive calls
    if (dirtyCheckTimeout) {
        clearTimeout(dirtyCheckTimeout);
    }
    dirtyCheckTimeout = setTimeout(() => {
        if (window.fontDropdownManager) {
            window.fontDropdownManager.updateDirtyIndicator();
        }
    }, 100); // Wait 100ms after last execution before checking

    // Check if font needs recompilation and schedule auto-compile
    if (window.autoCompileManager) {
        window.autoCompileManager.checkAndSchedule();
    }
}

// Make functions globally available
window.beforePythonExecution = beforePythonExecution;
window.afterPythonExecution = afterPythonExecution;

// Expose flag control for font loading operations
window.setFontLoadingState = function (loading) {
    isLoadingFont = loading;
    if (!loading) {
        // After font loading completes, check dirty state once
        if (dirtyCheckTimeout) {
            clearTimeout(dirtyCheckTimeout);
        }
        dirtyCheckTimeout = setTimeout(() => {
            if (window.fontDropdownManager) {
                window.fontDropdownManager.updateDirtyIndicator();
            }
        }, 200);
    }
};
