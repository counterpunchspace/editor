// Auto-Compile Manager
// Automatically recompiles the font when data changes (using DIRTY_COMPILE flag)
// Uses continuous loop for instant compilation during editing
import fontManager from './font-manager';

(function () {
    'use strict';

    let isEnabled = true;
    let isCompiling = false; // Prevent overlapping compilations
    let loopRunning = false;
    let animationFrameId: number | null = null;
    let initialCheckTimeoutId: number | null = null;
    let isStartupBlocked = false;
    let triggerQueued = false;
    let failedCompileRequestVersion: number | null = null;

    function getCurrentCompileRequestVersion() {
        return fontManager.currentFont?.compileRequestVersion ?? null;
    }

    function isCurrentRequestFailureLatched() {
        return (
            failedCompileRequestVersion !== null &&
            failedCompileRequestVersion === getCurrentCompileRequestVersion()
        );
    }

    function queueImmediateTrigger() {
        if (triggerQueued) {
            return;
        }

        triggerQueued = true;
        window.setTimeout(() => {
            triggerQueued = false;
            triggerCompilation().catch((err) => {
                console.error('Compilation error:', err);
                isCompiling = false;
            });
        }, 0);
    }

    /**
     * Continuous check loop using requestAnimationFrame
     * Runs every frame to detect changes and compile immediately
     */
    function checkLoop() {
        if (!isEnabled) {
            loopRunning = false;
            return;
        }

        if (isStartupBlocked) {
            animationFrameId = requestAnimationFrame(checkLoop);
            return;
        }

        // Check if font needs recompilation and we're not already compiling
        if (
            fontManager.currentFont?.needsRecompile &&
            !isCompiling &&
            !isCurrentRequestFailureLatched()
        ) {
            // Trigger compilation immediately (non-blocking)
            triggerCompilation().catch((err) => {
                console.error('Compilation error:', err);
                isCompiling = false; // Reset flag on error
            });
            // Continue loop to check again after compilation
            animationFrameId = requestAnimationFrame(checkLoop);
        } else if (isCompiling) {
            // Still compiling, keep checking
            animationFrameId = requestAnimationFrame(checkLoop);
        } else {
            // Nothing to do - stop the loop to save CPU
            loopRunning = false;
            animationFrameId = null;
        }
    }

    /**
     * Start the continuous check loop
     */
    function startLoop() {
        if (loopRunning) {
            return; // Already running
        }
        loopRunning = true;
        if (initialCheckTimeoutId !== null) {
            clearTimeout(initialCheckTimeoutId);
        }
        initialCheckTimeoutId = window.setTimeout(() => {
            initialCheckTimeoutId = null;
            checkLoop();
        }, 0);
    }

    /**
     * Stop the continuous check loop
     */
    function stopLoop() {
        if (initialCheckTimeoutId !== null) {
            clearTimeout(initialCheckTimeoutId);
            initialCheckTimeoutId = null;
        }
        if (animationFrameId !== null) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        loopRunning = false;
    }

    /**
     * Check if font needs compilation and trigger it.
     * Keeps compiling in a loop while data changes during compilation,
     * ensuring only one compilation is in flight at a time.
     */
    async function triggerCompilation() {
        if (isCompiling) {
            return;
        }

        if (isStartupBlocked) {
            return;
        }

        if (
            fontManager.currentFont?.needsRecompile &&
            !isCurrentRequestFailureLatched()
        ) {
            isCompiling = true;

            try {
                // Keep compiling in a loop while data changes during compilation
                let needsRecompile = true;

                while (
                    needsRecompile &&
                    fontManager.currentFont?.needsRecompile
                ) {
                    // Trigger recompilation - returns true if data changed and needs another compile
                    // The initial editing compile is the operation that makes
                    // the manager ready. Requiring an existing result here
                    // turns a transient startup failure into a permanent one.
                    if (fontManager?.currentFont) {
                        try {
                            needsRecompile =
                                await fontManager.recompileEditingFont();
                            failedCompileRequestVersion = null;
                        } catch (err) {
                            failedCompileRequestVersion =
                                getCurrentCompileRequestVersion();
                            if (fontManager.currentFont) {
                                fontManager.currentFont.needsRecompile = false;
                            }
                            console.error('Compilation error:', err);
                            needsRecompile = false;
                        }
                    } else {
                        needsRecompile = false;
                    }
                }
            } finally {
                isCompiling = false;
            }
        }
    }

    /**
     * Called when data changes to trigger compilation check.
     * Now just ensures the loop is running.
     */
    function checkAndSchedule() {
        if (!loopRunning) {
            startLoop();
        }
        queueImmediateTrigger();
    }

    /**
     * Enable or disable auto-compilation.
     */
    function setEnabled(enabled: boolean) {
        isEnabled = enabled;
        if (!enabled) {
            stopLoop();
        } else if (enabled && !loopRunning) {
            startLoop();
        }
    }

    function setStartupBlocked(blocked: boolean) {
        isStartupBlocked = blocked;
        if (!blocked && isEnabled && !loopRunning) {
            startLoop();
        }
    }

    /**
     * Manual test function to check compile-pending state without waiting.
     */
    async function testDirtyCheck() {
        return fontManager.currentFont?.needsRecompile;
    }

    /**
     * Force trigger a compilation check immediately (for testing).
     */
    async function forceTrigger() {
        await triggerCompilation();
    }

    // Export API
    window.autoCompileManager = {
        checkAndSchedule,
        setEnabled,
        setStartupBlocked,
        scheduleCompilation: checkAndSchedule, // Alias for compatibility
        testDirtyCheck,
        forceTrigger,
        getStatus: () => ({
            isEnabled,
            isCompiling,
            loopRunning,
            isStartupBlocked
        })
    };

    // Start the loop immediately
    startLoop();
})();
