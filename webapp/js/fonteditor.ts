// FontEditor initialization
// Loads and initializes Python packages for font editing

const {
    markFontEditorReady,
    markFontEditorReadyFailed
} = require('./editor-startup-ready.js');
import { fontDestinationPluginManager } from './font-destination-plugin-manager';
import { getFocusViewId } from './window-ui-state';
import { notifyLoadingOverlayHiding } from './welcome-screen';
import {
    timelineMark,
    timelineSpanEnd,
    timelineSpanStart
} from './perf-timeline';

type WheelsManifest = {
    wheels: string[];
};

type ExtendedWindow = Window & {
    __unsupportedBrowserWarningRequired?: boolean;
    __unsupportedBrowserWarningAcknowledged?: boolean;
    WarpSpeedAnimation?: {
        requestStop: (onDone: () => void) => void;
    };
};

async function initFontEditor() {
    'use strict';

    let initSpanId: string | null = null;

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
        initSpanId = timelineSpanStart('python.initFontEditor');
        if (window.updateLoadingStatus) {
            window.updateLoadingStatus('Initializing Python environment...');
        }

        // First load micropip package
        const micropipSpanId = timelineSpanStart('python.loadMicropip');
        await window.pyodide.loadPackage('micropip');
        timelineSpanEnd(micropipSpanId);
        console.log('[FontEditor]', 'micropip loaded successfully');
        if (window.updateLoadingStatus) {
            window.updateLoadingStatus('Loading package manager...');
        }

        // Fetch the list of wheel files from the manifest
        const wheelsSpanId = timelineSpanStart('python.installWheels');
        const manifestResponse = await fetch('./wheels/wheels.json');
        const manifest = (await manifestResponse.json()) as WheelsManifest;
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
        timelineSpanEnd(wheelsSpanId);

        // Load the fonteditor Python module
        const fonteditorModuleSpanId = timelineSpanStart(
            'python.loadFonteditorModule'
        );
        if (window.updateLoadingStatus) {
            window.updateLoadingStatus('Loading font editor...');
        }
        const fonteditorModule = await fetch(
            './py/fonteditor.py?rev=glyph-filter-batch-1'
        );
        const fonteditorCode = await fonteditorModule.text();
        await window.pyodide.runPythonAsync(fonteditorCode);
        timelineSpanEnd(fonteditorModuleSpanId);
        console.log('[FontEditor]', 'fonteditor.py module loaded');

        // Stored third-party wheels are restored only when their Disk permission persists.
        try {
            await fontDestinationPluginManager.reinstallStoredPlugins();
        } catch (error) {
            console.warn(
                '[FontEditor]',
                'Failed to restore stored Font Destination plugins:',
                error
            );
        }

        console.log('[FontEditor]', 'FontEditor initialized successfully');

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

        // Restore the last active view (Editing View by default)
        const lastActiveView = getFocusViewId() || 'view-editor';
        if (window.focusView) {
            window.focusView(lastActiveView);
        }

        const shouldWaitForUnsupportedBrowserContinue = () => {
            const extendedWindow = window as ExtendedWindow;
            return (
                extendedWindow.__unsupportedBrowserWarningRequired === true &&
                extendedWindow.__unsupportedBrowserWarningAcknowledged !== true
            );
        };

        // Hide loading overlay with animation
        const hideLoadingOverlay = () => {
            const loadingOverlay = document.getElementById('loading-overlay');
            const loadingLogo = document.querySelector('.loading-logo');

            // Fade logo color back to red before hiding overlay
            if (loadingLogo) {
                (loadingLogo as HTMLElement).classList.add('fade-out');
            }

            if (loadingOverlay) {
                loadingOverlay.classList.add('hidden');
            }
            notifyLoadingOverlayHiding();
        };

        const hideLoadingOverlayWhenAllowed = () => {
            if (!shouldWaitForUnsupportedBrowserContinue()) {
                hideLoadingOverlay();
                return;
            }

            window.addEventListener(
                'unsupportedBrowserContinue',
                () => {
                    hideLoadingOverlay();
                },
                { once: true }
            );
        };

        // Wait briefly after "Ready" appears before starting fadeout
        setTimeout(() => {
            // Request animation to stop (it will drain particles first, then trigger fade)
            const extendedWindow = window as ExtendedWindow;
            if (extendedWindow.WarpSpeedAnimation) {
                let callbackFired = false;

                extendedWindow.WarpSpeedAnimation.requestStop(() => {
                    if (!callbackFired) {
                        callbackFired = true;
                        hideLoadingOverlayWhenAllowed();
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
                        hideLoadingOverlayWhenAllowed();
                    }
                }, 5000); // 5 second timeout
            } else {
                // Fallback if animation not available
                hideLoadingOverlayWhenAllowed();
            }
        }, 200); // Wait 200ms after "Ready" appears

        markFontEditorReady();
        if (initSpanId) {
            timelineSpanEnd(initSpanId);
        }
        timelineMark('python.initFontEditor.ready');

        if (window.canvasPluginManager) {
            try {
                await window.canvasPluginManager.discoverPlugins();
            } catch (error) {
                console.error(
                    '[FontEditor]',
                    'Failed to discover canvas plugins:',
                    error
                );
            }
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
            }
        }

        return true;
    } catch (error) {
        if (initSpanId) {
            timelineSpanEnd(initSpanId);
        }
        timelineMark('python.initFontEditor.failed');
        const message = error instanceof Error ? error.message : String(error);
        console.error('[FontEditor]', 'Error initializing FontEditor:', error);
        markFontEditorReadyFailed(error);
        if (window.term) {
            window.term.error('Failed to initialize FontEditor: ' + message);
        }

        // Hide loading overlay even on error (unless waiting for unsupported-browser acknowledgment)
        const extendedWindow = window as ExtendedWindow;
        if (
            extendedWindow.__unsupportedBrowserWarningRequired !== true ||
            extendedWindow.__unsupportedBrowserWarningAcknowledged === true
        ) {
            const loadingOverlay = document.getElementById('loading-overlay');
            if (loadingOverlay) {
                loadingOverlay.classList.add('hidden');
            }
            notifyLoadingOverlayHiding();
        }

        return false;
    }
}

// Initialize FontEditor when Pyodide is ready
document.addEventListener('DOMContentLoaded', () => {
    timelineMark('python.waitForPyodide.started');
    const waitThenInit = async () => {
        if (!window.pyodide) {
            if (window.__pyodideLoadPromise) {
                await window.__pyodideLoadPromise;
            } else {
                while (!window.pyodide) {
                    timelineMark('python.waitForPyodide.pollMiss');
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
            }
        }
        timelineMark('python.waitForPyodide.available');
        await initFontEditor();
    };
    void waitThenInit();
});

// Export for manual initialization if needed
window.initFontEditor = initFontEditor;
