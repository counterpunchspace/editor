// Auto-Compile Manager
// Automatically recompiles the font when data changes (using DIRTY_COMPILE flag)
// and there's been 1 second of inactivity to avoid race conditions

(function () {
    'use strict';

    const AUTO_COMPILE_DELAY = 500; // 1 second of inactivity before compiling
    let compileTimeout = null;
    let isEnabled = true;
    let isChecking = false; // Prevent recursive checks

    /**
     * Schedule a compilation after the inactivity delay.
     * If already scheduled, reset the timer (debouncing).
     */
    function scheduleCompilation() {
        if (!isEnabled) {
            return;
        }

        // Clear any existing timeout (debouncing)
        if (compileTimeout) {
            clearTimeout(compileTimeout);
        }

        // Schedule new compilation
        compileTimeout = setTimeout(async () => {
            compileTimeout = null;
            await triggerCompilation();
        }, AUTO_COMPILE_DELAY);
    }

    /**
     * Check if font needs compilation and trigger it.
     */
    async function triggerCompilation() {
        if (isChecking) {
            return;
        }

        isChecking = true;
        try {
            if (!window.pyodide || !window.compileFontButton) {
                return;
            }

            // Check if current font is dirty for compilation
            // Use _originalRunPythonAsync to bypass the execution wrapper
            // and prevent infinite loop
            const runPython = window.pyodide._originalRunPythonAsync || window.pyodide.runPythonAsync;

            const isDirtyJson = await runPython.call(window.pyodide, `
import json
try:
    from context import DIRTY_COMPILE
    current_font = CurrentFont()
    
    # Handle case where no font is loaded
    if current_font is None:
        result = {"dirty": False, "no_font": True}
    else:
        # Ensure DIRTY_COMPILE context exists in font's dirty flags
        # (workaround for fonts loaded before DIRTY_COMPILE was added)
        if DIRTY_COMPILE not in current_font._dirty_flags:
            current_font._dirty_flags[DIRTY_COMPILE] = False
        
        result = {"dirty": current_font.is_dirty(DIRTY_COMPILE)}
except Exception as e:
    import traceback
    result = {"dirty": False, "error": str(e), "traceback": traceback.format_exc()}
json.dumps(result)
            `);

            const result = JSON.parse(isDirtyJson);

            if (result.error) {
                console.error('❌ Error checking DIRTY_COMPILE status:', result.error);
                if (result.traceback) {
                    console.error('Traceback:', result.traceback);
                }
                return;
            }

            if (result.no_font) {
                return;
            }

            if (result.dirty) {

                // Show message in terminal if available
                if (window.term) {
                    window.term.echo('[[;cyan;]🔄 Auto-compiling font after data change...]');
                }

                // Trigger compilation
                if (window.compileFontButton && window.compileFontButton.compile) {
                    await window.compileFontButton.compile();

                    // Mark font as clean for compilation after successful compile
                    // Use recursive=True to mark all children clean too
                    await runPython.call(window.pyodide, `
from context import DIRTY_COMPILE
current_font = CurrentFont()
if current_font:
    current_font.mark_clean(DIRTY_COMPILE, recursive=True)
                    `);
                }
            }
        } catch (error) {
            console.error('❌ Error in auto-compilation:', error);
        } finally {
            isChecking = false;
        }
    }

    /**
     * Called when Python execution completes to check if compilation is needed.
     */
    function checkAndSchedule() {
        scheduleCompilation();
    }

    /**
     * Enable or disable auto-compilation.
     */
    function setEnabled(enabled) {
        isEnabled = enabled;
        if (!enabled && compileTimeout) {
            clearTimeout(compileTimeout);
            compileTimeout = null;
        }
        console.log(`Auto-compilation ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Manual test function to check dirty state without waiting.
     */
    async function testDirtyCheck() {
        console.log('🧪 Manual dirty check test...');

        if (!window.pyodide) {
            console.error('❌ Pyodide not loaded');
            return;
        }

        const runPython = window.pyodide._originalRunPythonAsync || window.pyodide.runPythonAsync;

        try {
            const isDirtyJson = await runPython.call(window.pyodide, `
import json
from context import DIRTY_COMPILE
current_font = CurrentFont()
if current_font is None:
    result = {"error": "No font loaded", "font_name": None, "dirty": False}
else:
    # Get font name safely
    try:
        font_name = current_font.names.familyName.get_default() if current_font.names else str(current_font)
    except:
        font_name = "Unknown"
    
    result = {
        "dirty": current_font.is_dirty(DIRTY_COMPILE),
        "font_name": font_name
    }
json.dumps(result)
            `);

            const result = JSON.parse(isDirtyJson);
            if (result.error) {
                console.warn('⚠️', result.error);
            } else {
                console.log('Font:', result.font_name);
                console.log('DIRTY_COMPILE:', result.dirty);
            }
            return result;
        } catch (error) {
            console.error('❌ Error checking dirty state:', error);
            return null;
        }
    }

    /**
     * Force trigger a compilation check immediately (for testing).
     */
    async function forceTrigger() {
        console.log('🧪 Force triggering auto-compile check...');
        await triggerCompilation();
    }

    // Export API
    window.autoCompileManager = {
        checkAndSchedule,
        setEnabled,
        scheduleCompilation,
        testDirtyCheck,
        forceTrigger,
        getStatus: () => ({ isEnabled, hasPendingCompile: !!compileTimeout }),
    };

    console.log('✅ Auto-compile manager initialized');
})();
