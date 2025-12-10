// Auto-Compile Manager
// Automatically recompiles the font when data changes (using DIRTY_COMPILE flag)
// and there's been 1 second of inactivity to avoid race conditions
import APP_SETTINGS from './settings';
import fontManager from './font-manager';

(function () {
    'use strict';

    const AUTO_COMPILE_DELAY = APP_SETTINGS?.COMPILE_DEBOUNCE_DELAY || 500; // Use setting or fallback to 500ms
    let compileTimeout: NodeJS.Timeout | null = null;
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
        if (fontManager.currentFont?.dirty) {
            // Show message in terminal if available
            if (window.term) {
                window.term.echo(
                    '[[;cyan;]🔄 Auto-recompiling editing font after data change...]'
                );
            }

            // Trigger recompilation of editing font via font manager
            // Pass the pre-fetched JSON to avoid redundant serialization
            if (fontManager && fontManager.isReady()) {
                await fontManager.recompileEditingFont();
            }
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
    function setEnabled(enabled: boolean) {
        isEnabled = enabled;
        if (!enabled && compileTimeout) {
            clearTimeout(compileTimeout);
            compileTimeout = null;
        }
        console.log(
            '[AutoCompile]',
            `Auto-compilation ${enabled ? 'enabled' : 'disabled'}`
        );
    }

    /**
     * Manual test function to check dirty state without waiting.
     */
    async function testDirtyCheck() {
        return fontManager.currentFont?.dirty;
    }

    /**
     * Force trigger a compilation check immediately (for testing).
     */
    async function forceTrigger() {
        console.log(
            '[AutoCompile]',
            '🧪 Force triggering auto-compile check...'
        );
        await triggerCompilation();
    }

    // Export API
    window.autoCompileManager = {
        checkAndSchedule,
        setEnabled,
        scheduleCompilation,
        testDirtyCheck,
        forceTrigger,
        getStatus: () => ({ isEnabled, hasPendingCompile: !!compileTimeout })
    };

    console.log('[AutoCompile]', '✅ Auto-compile manager initialized');
})();
