// FontEditor initialization
// Loads and initializes Python packages for font editing

async function initFontEditor() {
    'use strict';

    try {
        // Ensure pyodide is available
        if (!window.pyodide) {
            console.error(
                '[FontEditor]',
                "Pyodide not available. Make sure it's loaded first."
            );
            return false;
        }

        // Check if SharedArrayBuffer is available (needed for WASM threading)
        if (typeof SharedArrayBuffer === 'undefined') {
            // Check if we already tried reloading
            const alreadyReloaded =
                window.sessionStorage.getItem('coiReloadedBySelf') === 'true';

            // Detect iOS (including all browsers on iOS which use WebKit)
            const isIOS =
                /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                (navigator.platform === 'MacIntel' &&
                    navigator.maxTouchPoints > 1) ||
                /iPad|iPhone|iPod/.test(navigator.platform);

            if (isIOS) {
                console.warn(
                    '[FontEditor]',
                    '[COI] iOS detected - SharedArrayBuffer not supported on iOS (all browsers). Some features may be limited.'
                );
                // Don't reload on iOS, just continue without SAB
            } else if (!alreadyReloaded) {
                console.log(
                    '[FontEditor]',
                    '[COI] SharedArrayBuffer not available - reloading to enable service worker headers...'
                );
                if (window.updateLoadingStatus) {
                    window.updateLoadingStatus(
                        'Enabling cross-origin isolation...'
                    );
                }
                // Wait a moment for status to show, then reload
                setTimeout(() => {
                    window.sessionStorage.setItem('coiReloadedBySelf', 'true');
                    window.location.reload();
                }, 500);
                return false;
            } else {
                console.error(
                    '[FontEditor]',
                    '[COI] SharedArrayBuffer still unavailable after reload. Browser may not support it.'
                );
                // Already reloaded once, don't try again (prevents infinite loop)
            }
        }

        console.log('[FontEditor]', 'Initializing FontEditor...');
        if (window.updateLoadingStatus) {
            window.updateLoadingStatus('Initializing Python environment...');
        }

        // First load micropip package
        await window.pyodide.loadPackage('micropip');
        console.log('[FontEditor]', 'micropip loaded successfully');
        if (window.updateLoadingStatus) {
            window.updateLoadingStatus('Loading package manager...');
        }

        // Fetch the list of wheel files from the manifest
        const manifestResponse = await fetch('./wheels/wheels.json');
        const manifest = await manifestResponse.json();
        const wheelFiles = manifest.wheels;
        console.log('[FontEditor]', 'Found wheel files:', wheelFiles);

        // Install context package from local wheels
        await window.pyodide.runPythonAsync(`
            import micropip
        `);

        // Install each wheel file
        for (const wheelFile of wheelFiles) {
            console.log('[FontEditor]', `Installing wheel: ${wheelFile}`);
            if (window.updateLoadingStatus) {
                window.updateLoadingStatus(
                    `Installing ${wheelFile.split('-')[0]}...`
                );
            }
            const wheelUrl = `./wheels/${wheelFile}`;
            await window.pyodide.runPythonAsync(`
                await micropip.install("${wheelUrl}")
            `);
        }

        // Load the fonteditor Python module
        if (window.updateLoadingStatus) {
            window.updateLoadingStatus('Loading font editor...');
        }
        const fonteditorModule = await fetch('./py/fonteditor.py');
        const fonteditorCode = await fonteditorModule.text();
        await window.pyodide.runPython(fonteditorCode);
        console.log('[FontEditor]', 'fonteditor.py module loaded');

        console.log('[FontEditor]', 'FontEditor initialized successfully');

        // Discover canvas plugins
        if (window.updateLoadingStatus) {
            window.updateLoadingStatus('Loading canvas plugins...');
        }
        if (window.canvasPluginManager) {
            try {
                await window.canvasPluginManager.discoverPlugins();
            } catch (error) {
                console.error(
                    '[FontEditor]',
                    'Failed to discover canvas plugins:',
                    error
                );
                // Continue anyway - plugins are optional
            }
        }

        // Discover glyph filter plugins
        if (window.updateLoadingStatus) {
            window.updateLoadingStatus('Loading glyph filter plugins...');
        }
        if (window.glyphOverviewFilterManager) {
            try {
                await window.glyphOverviewFilterManager.discoverPlugins();
            } catch (error) {
                console.error(
                    '[FontEditor]',
                    'Failed to discover glyph filter plugins:',
                    error
                );
                // Continue anyway - plugins are optional
            }
        }

        // Load example fonts into /user folder
        if (window.loadExampleFonts) {
            try {
                await window.loadExampleFonts();
            } catch (error) {
                console.error(
                    '[FontEditor]',
                    'Failed to load example fonts:',
                    error
                );
                // Continue anyway - this is not critical
            }
        }

        if (window.updateLoadingStatus) {
            window.updateLoadingStatus('READY', true);
        }

        // Restore the last active view right away, before animation ends
        const lastActiveView = localStorage.getItem('last_active_view');
        if (lastActiveView && window.focusView) {
            window.focusView(lastActiveView);
        }

        // Hide loading overlay with animation
        const hideLoadingOverlay = () => {
            const loadingOverlay = document.getElementById('loading-overlay');
            const loadingLogo = document.querySelector('.loading-logo');

            // Fade logo color back to red before hiding overlay
            if (loadingLogo) {
                loadingLogo.classList.add('fade-out');
            }

            if (loadingOverlay) {
                loadingOverlay.classList.add('hidden');
            }
        };

        // Wait briefly after "Ready" appears before starting fadeout
        setTimeout(() => {
            // Request animation to stop (it will drain particles first, then trigger fade)
            if (window.WarpSpeedAnimation) {
                let callbackFired = false;

                window.WarpSpeedAnimation.requestStop(() => {
                    if (!callbackFired) {
                        callbackFired = true;
                        hideLoadingOverlay();
                    }
                });

                // Fallback timeout in case animation callback doesn't fire (e.g., particles stuck)
                setTimeout(() => {
                    if (!callbackFired) {
                        console.warn(
                            '[FontEditor]',
                            'Animation drain timeout, forcing overlay hide'
                        );
                        callbackFired = true;
                        hideLoadingOverlay();
                    }
                }, 5000); // 5 second timeout
            } else {
                // Fallback if animation not available
                hideLoadingOverlay();
            }
        }, 200); // Wait 200ms after "Ready" appears

        return true;
    } catch (error) {
        console.error('[FontEditor]', 'Error initializing FontEditor:', error);
        if (window.term) {
            window.term.error(
                'Failed to initialize FontEditor: ' + error.message
            );
        }

        // Hide loading overlay even on error
        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay) {
            loadingOverlay.classList.add('hidden');
        }

        return false;
    }
}

// Initialize FontEditor when Pyodide is ready
document.addEventListener('DOMContentLoaded', () => {
    // Safety timeout - hide loading screen after 30 seconds no matter what
    setTimeout(() => {
        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay && !loadingOverlay.classList.contains('hidden')) {
            console.error(
                '[FontEditor]',
                'Loading timeout - forcing overlay hide after 30 seconds'
            );
            loadingOverlay.classList.add('hidden');
        }
    }, 30000);

    // Wait for pyodide to be available
    const checkPyodide = () => {
        if (window.pyodide) {
            // Wait a bit more to ensure pyodide is fully initialized
            setTimeout(() => {
                initFontEditor();
            }, 1000);
        } else {
            // Check again in 500ms
            setTimeout(checkPyodide, 500);
        }
    };

    checkPyodide();
});

// Export for manual initialization if needed
window.initFontEditor = initFontEditor;
