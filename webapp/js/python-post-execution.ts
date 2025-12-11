/**
 * Python Post-Execution Hooks
 *
 * Sets up hooks that run after Python code execution to trigger font recompilation.
 * The dirty flag is set automatically by the object model setters when data is modified.
 */

console.log(
    '[PythonPostExec]',
    '🔧 Module loaded, setting up post-execution hooks...'
);

// Wait for required globals to be available
function setupHooks() {
    console.log(
        '[PythonPostExec]',
        'setupHooks called, checking for autoCompileManager:',
        !!window.autoCompileManager
    );

    if (!window.autoCompileManager) {
        console.log('[PythonPostExec]', 'Waiting for autoCompileManager...');
        setTimeout(setupHooks, 500);
        return;
    }

    console.log(
        '[PythonPostExec]',
        '✅ autoCompileManager found, installing afterPythonExecution hook...'
    );

    // Save any existing hook so we can call it too (chaining)
    const existingHook = window.afterPythonExecution;
    console.log(
        '[PythonPostExec]',
        '   Existing hook:',
        typeof existingHook === 'function' ? 'found' : 'none'
    );

    /**
     * Hook that runs after every Python code execution
     * Triggers font recompilation
     */
    window.afterPythonExecution = function () {
        // Call the existing hook first (if any)
        if (typeof existingHook === 'function') {
            existingHook();
        }

        // Sync changes from object model back to JSON string (for compilation)
        // The babelfontData object is already modified in place by the object model,
        // we only need to update the JSON string for the compiler
        if (window.fontManager?.currentFont) {
            window.fontManager.currentFont.syncJsonFromModel();

            // Refresh canvas to pick up changes if in edit mode
            // After syncJsonFromModel, nodes arrays have been converted to strings,
            // so we need to refetch layer data to get fresh parsed arrays
            if (window.glyphCanvas?.outlineEditor) {
                // Refetch layer data to get fresh normalizer wrappers
                window.glyphCanvas.outlineEditor.fetchLayerData().then(() => {
                    window.glyphCanvas!.render();
                });
            }
        }

        // Trigger font recompilation via auto-compile manager
        // The dirty flag is already set by the object model setters when data was modified
        if (window.autoCompileManager) {
            window.autoCompileManager.scheduleCompilation();
        }
    };

    console.log(
        '[PythonPostExec]',
        '✅ Post-execution hooks installed successfully'
    );
    console.log(
        '[PythonPostExec]',
        'window.afterPythonExecution is now:',
        typeof window.afterPythonExecution
    );
}

// Start setup when DOM is ready
console.log('[PythonPostExec]', 'Document ready state:', document.readyState);
if (document.readyState === 'loading') {
    console.log('[PythonPostExec]', 'Adding DOMContentLoaded listener...');
    document.addEventListener('DOMContentLoaded', setupHooks);
} else {
    console.log(
        '[PythonPostExec]',
        'DOM already ready, calling setupHooks immediately...'
    );
    setupHooks();
}

console.log('[PythonPostExec]', '📦 Module initialization complete');

// Immediately invoke setup to ensure this code runs
// (prevents webpack from tree-shaking this module)
(function () {
    console.log('[PythonPostExec]', '🚀 IIFE executing...');
})();
