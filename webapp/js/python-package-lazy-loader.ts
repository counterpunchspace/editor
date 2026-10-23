// Python Package Lazy Loader
// Automatically installs matplotlib, numpy, and pandas on-demand when imported

(function () {
    'use strict';

    // Track which packages have been installed in this session
    const installedPackages = new Set<string>();

    // Packages that should be lazy-loaded
    const lazyPackages = {
        matplotlib: 'matplotlib',
        numpy: 'numpy',
        pandas: 'pandas'
    };

    // Currently installing packages (to prevent duplicate installs)
    const installingPackages = new Set<string>();

    /**
     * Check if code imports any lazy-loadable packages
     * @param {string} code - Python code to scan
     * @returns {string[]} - Array of package names that need to be installed
     */
    function detectRequiredPackages(code: string): string[] {
        const required: string[] = [];

        for (const [packageName, pipName] of Object.entries(lazyPackages)) {
            // Skip if already installed or currently installing
            if (
                installedPackages.has(packageName) ||
                installingPackages.has(packageName)
            ) {
                continue;
            }

            // Check for various import patterns:
            // import matplotlib
            // from matplotlib import ...
            // import matplotlib.pyplot as plt
            const importPatterns = [
                new RegExp(`^\\s*import\\s+${packageName}(?:\\s|$|\\.)`, 'm'),
                new RegExp(`^\\s*from\\s+${packageName}(?:\\s|\\.)`, 'm')
            ];

            if (importPatterns.some((pattern) => pattern.test(code))) {
                required.push(pipName);
            }
        }

        return required;
    }

    /**
     * Install required packages
     * @param {string[]} packages - Array of package names to install
     */
    async function installPackages(packages: string[]): Promise<void> {
        if (packages.length === 0) {
            return;
        }

        // Mark as installing
        packages.forEach((pkg) => installingPackages.add(pkg));

        console.log(
            '[LazyLoader]',
            `Installing packages on-demand: ${packages.join(', ')}`
        );

        // Show status update if available
        if (window.updateLoadingStatus) {
            window.updateLoadingStatus(`Installing ${packages.join(', ')}...`);
        }

        try {
            // Install packages sequentially
            for (const pkg of packages) {
                console.log('[LazyLoader]', `Installing ${pkg}...`);
                await window.pyodide._originalRunPythonAsync(`
                    import micropip
                    await micropip.install('${pkg}')
                `);
                installedPackages.add(pkg);
                console.log('[LazyLoader]', `✅ ${pkg} installed successfully`);
            }

            // Mirror installs into glyph filter worker runtime (if available)
            if (window.glyphOverviewFilterManager?.syncWorkerPackages) {
                try {
                    await window.glyphOverviewFilterManager.syncWorkerPackages(
                        packages
                    );
                    console.log(
                        '[LazyLoader]',
                        `✅ Synced packages to glyph filter worker: ${packages.join(', ')}`
                    );
                } catch (syncError) {
                    console.warn(
                        '[LazyLoader]',
                        'Failed to sync packages to glyph filter worker:',
                        syncError
                    );
                }
            }

            // Apply matplotlib patch if matplotlib was installed
            if (packages.includes('matplotlib')) {
                console.log(
                    '[LazyLoader]',
                    '🎨 Matplotlib detected, applying auto-cleanup patch...'
                );
                try {
                    const patchResponse = await fetch(
                        './py/matplotlib_patch.py'
                    );
                    const patchCode = await patchResponse.text();
                    await window.pyodide._originalRunPythonAsync(patchCode);
                    console.log(
                        '[LazyLoader]',
                        '✅ Applied matplotlib auto-cleanup patch'
                    );
                    // Also print to Python console so it's visible
                    await window.pyodide._originalRunPythonAsync(
                        `print("[LazyLoader] ✅ Matplotlib auto-cleanup patch applied")`
                    );
                } catch (error) {
                    const message =
                        error instanceof Error ? error.message : String(error);
                    console.error(
                        '[LazyLoader]',
                        '❌ Failed to apply matplotlib patch:',
                        error
                    );
                    // Print error to Python console
                    await window.pyodide._originalRunPythonAsync(
                        `print("[LazyLoader] ❌ Failed to apply matplotlib patch: ${message}")`
                    );
                }
            }
        } catch (error) {
            console.error(
                '[LazyLoader]',
                'Package installation failed:',
                error
            );
            throw error;
        } finally {
            // Remove from installing set
            packages.forEach((pkg) => installingPackages.delete(pkg));

            // Clear status if available
            if (window.updateLoadingStatus) {
                window.updateLoadingStatus('');
            }
        }
    }

    /**
     * Hook into Python execution to install packages as needed
     */
    function setupLazyLoader(): void {
        if (!window.pyodide) {
            console.log('[LazyLoader]', 'Waiting for Pyodide...');
            setTimeout(setupLazyLoader, 500);
            return;
        }

        console.log('[LazyLoader]', '🔧 Installing lazy package loader...');

        // Save existing hook
        const existingBeforeHook = window.beforePythonExecution;

        // Install our hook
        window.beforePythonExecution = async function (code?: string) {
            const hookStartTime = performance.now();
            let historyContext: Window['pythonExecutionHistoryContext'] | void;

            // Call existing hook first. Its context belongs to this run.
            if (typeof existingBeforeHook === 'function') {
                const existingHookStart = performance.now();
                historyContext = await existingBeforeHook(code);
                const existingHookDuration =
                    performance.now() - existingHookStart;
                if (existingHookDuration > 10) {
                    console.log(
                        '[LazyLoader]',
                        `⏱️ Existing hook took ${existingHookDuration.toFixed(1)}ms`
                    );
                }
            }

            // Only check if we have code to analyze
            if (!code || typeof code !== 'string') {
                return historyContext;
            }

            // Detect and install required packages
            const detectionStart = performance.now();
            const required = detectRequiredPackages(code);
            const detectionDuration = performance.now() - detectionStart;

            console.log(
                '[LazyLoader]',
                `📦 Package detection: ${detectionDuration.toFixed(1)}ms, found: [${required.join(', ') || 'none'}], installed: [${[...installedPackages].join(', ') || 'none'}]`
            );

            if (required.length > 0) {
                const installStart = performance.now();
                await installPackages(required);
                const installDuration = performance.now() - installStart;
                console.log(
                    '[LazyLoader]',
                    `⏱️ Package installation took ${installDuration.toFixed(1)}ms`
                );
            }

            const totalDuration = performance.now() - hookStartTime;
            if (totalDuration > 10) {
                console.log(
                    '[LazyLoader]',
                    `⏱️ Total beforePythonExecution hook: ${totalDuration.toFixed(1)}ms`
                );
            }
            return historyContext;
        };

        console.log(
            '[LazyLoader]',
            '✅ Lazy package loader installed successfully'
        );
    }

    // Start initialization when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupLazyLoader);
    } else {
        setupLazyLoader();
    }
})();
