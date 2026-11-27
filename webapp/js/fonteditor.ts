// FontEditor initialization
// Decouples pure-JS app startup from Pyodide so Python loads lazily on first need.

const {
    markFontEditorReady,
    markFontEditorReadyFailed
} = require('./editor-startup-ready.js');
import { whenLoadingScreenFree } from './font-windows/loading-hold';
import { fontDestinationPluginManager } from './font-destination-plugin-manager';
import { discoverCompileFilters } from './compile-filter-host';
import { getFocusViewId } from './window-ui-state';
import { notifyLoadingOverlayHiding } from './welcome-screen';
import { runHostPythonAsync } from './skills/host-python';
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

let pyodideReadyPromise: Promise<unknown> | null = null;
let pyodideEnvironmentInitialized = false;
let storedPluginRestorePromise: Promise<void> | null = null;

async function restoreStoredPythonPlugins(): Promise<void> {
    try {
        const { revokeBeforeReinstall, startPluginRevocationWatch } =
            await import('./installed-plugin-manager');
        await revokeBeforeReinstall();
        startPluginRevocationWatch();
    } catch (error) {
        console.warn(
            '[FontEditor]',
            'Could not check refunded plugins before restore:',
            error
        );
    }
    try {
        await fontDestinationPluginManager.reinstallStoredPlugins();
        const { refreshPluginUpdateCount } =
            await import('./installed-plugin-manager');
        void refreshPluginUpdateCount();
    } catch (error) {
        console.warn(
            '[FontEditor]',
            'Failed to restore stored Font Destination plugins:',
            error
        );
    }
}

async function discoverPythonPlugins(): Promise<void> {
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
    if (window.glyphOverviewFilterManager?.discoverPythonPlugins) {
        try {
            await window.glyphOverviewFilterManager.discoverPythonPlugins();
        } catch (error) {
            console.error(
                '[FontEditor]',
                'Failed to discover Python glyph filter plugins:',
                error
            );
        }
    }
    try {
        await discoverCompileFilters();
    } catch (error) {
        console.error(
            '[FontEditor]',
            'Failed to discover compile filter plugins:',
            error
        );
    }
}

/**
 * Scan and load stored third-party wheels immediately when Settings Folder
 * access is granted or renewed after Pyodide has already started.
 */
export async function restoreStoredPythonPluginsOnFolderAccess(): Promise<void> {
    if (storedPluginRestorePromise) {
        return storedPluginRestorePromise;
    }
    const run = (async () => {
        if (!pyodideEnvironmentInitialized) {
            await ensurePyodideReady();
        }
        await restoreStoredPythonPlugins();
        try {
            await runHostPythonAsync(
                'import builtins\nif hasattr(builtins, "_cp_skills"): delattr(builtins, "_cp_skills")'
            );
        } catch {
            // Non-fatal; skills will still resolve on next call if not cached.
        }
        await discoverPythonPlugins();
    })();
    storedPluginRestorePromise = run.finally(() => {
        if (storedPluginRestorePromise === run) {
            storedPluginRestorePromise = null;
        }
    });
    return storedPluginRestorePromise;
}

function checkCrossOriginIsolation(): boolean {
    if (typeof SharedArrayBuffer !== 'undefined') {
        return true;
    }

    const alreadyReloaded =
        window.sessionStorage.getItem('coiReloadedBySelf') === 'true';

    const isIOS =
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
        /iPad|iPhone|iPod/.test(navigator.platform);

    if (isIOS) {
        console.warn(
            '[FontEditor]',
            '[COI] iOS detected - SharedArrayBuffer not supported on iOS (all browsers). Some features may be limited.'
        );
        return true;
    }

    if (!alreadyReloaded) {
        console.log(
            '[FontEditor]',
            '[COI] SharedArrayBuffer not available - reloading to enable service worker headers...'
        );
        if (window.updateLoadingStatus) {
            window.updateLoadingStatus('Enabling cross-origin isolation...');
        }
        setTimeout(() => {
            window.sessionStorage.setItem('coiReloadedBySelf', 'true');
            window.location.reload();
        }, 500);
        return false;
    }

    console.error(
        '[FontEditor]',
        '[COI] SharedArrayBuffer still unavailable after reload. Browser may not support it.'
    );
    return true;
}

function hideStartupOverlay(): void {
    const shouldWaitForUnsupportedBrowserContinue = () => {
        const extendedWindow = window as ExtendedWindow;
        return (
            extendedWindow.__unsupportedBrowserWarningRequired === true &&
            extendedWindow.__unsupportedBrowserWarningAcknowledged !== true
        );
    };

    const hideLoadingOverlayNow = () => {
        const loadingOverlay = document.getElementById('loading-overlay');
        const loadingLogo = document.querySelector('.loading-logo');

        if (loadingLogo) {
            (loadingLogo as HTMLElement).classList.add('fade-out');
        }

        if (loadingOverlay) {
            loadingOverlay.classList.add('hidden');
        }
        notifyLoadingOverlayHiding();
    };

    const hideLoadingOverlay = () =>
        whenLoadingScreenFree(hideLoadingOverlayNow);

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

    setTimeout(() => {
        const extendedWindow = window as ExtendedWindow;
        if (extendedWindow.WarpSpeedAnimation) {
            let callbackFired = false;

            extendedWindow.WarpSpeedAnimation.requestStop(() => {
                if (!callbackFired) {
                    callbackFired = true;
                    hideLoadingOverlayWhenAllowed();
                }
            });

            setTimeout(() => {
                if (!callbackFired) {
                    console.warn(
                        '[FontEditor]',
                        'Animation drain timeout, forcing overlay hide'
                    );
                    callbackFired = true;
                    hideLoadingOverlayWhenAllowed();
                }
            }, 5000);
        } else {
            hideLoadingOverlayWhenAllowed();
        }
    }, 200);
}

/**
 * Lazily load Pyodide, boot wheels (excluding Hyperglot), fonteditor.py,
 * stored third-party wheels, and Python plugins on first Python need.
 */
export function ensurePyodideReady(): Promise<unknown> {
    if (pyodideEnvironmentInitialized && window.pyodide) {
        return Promise.resolve(window.pyodide);
    }
    if (pyodideReadyPromise) {
        return pyodideReadyPromise;
    }

    pyodideReadyPromise = (async () => {
        const initSpanId = timelineSpanStart('python.initFontEditor');
        try {
            if (!window.pyodide) {
                if (typeof window.__startPyodideLoad === 'function') {
                    window.__startPyodideLoad();
                }
                if (window.__pyodideLoadPromise) {
                    await window.__pyodideLoadPromise;
                } else {
                    const started = performance.now();
                    while (!window.pyodide) {
                        if (performance.now() - started > 30_000) {
                            throw new Error('Timed out waiting for Pyodide.');
                        }
                        await new Promise((resolve) => setTimeout(resolve, 50));
                    }
                }
            }

            // Ensure execution wrapper & lazy package loader attach immediately.
            window.dispatchEvent(new CustomEvent('pyodideLoaded'));

            // micropip and all bundled wheels load in one parallel loadPackage call.
            // Large static data files (Hyperglot, Arabic) are stored gzipped inside
            // their wheels so MEMFS stays <0.5 MB with all wheels loaded at boot.
            const wheelsSpanId = timelineSpanStart('python.installWheels');
            const manifestResponse = await fetch('./wheels/wheels.json');
            const manifest = (await manifestResponse.json()) as WheelsManifest;
            const wheelUrls = manifest.wheels.map((wheelFile) =>
                new URL(
                    `./wheels/${wheelFile}`,
                    window.location.href
                ).toString()
            );
            console.log('[FontEditor]', 'Found wheel files:', manifest.wheels);
            await window.pyodide.loadPackage(['micropip', ...wheelUrls]);
            timelineSpanEnd(wheelsSpanId);

            // Load the fonteditor Python module without triggering user-edit snapshots.
            const fonteditorModuleSpanId = timelineSpanStart(
                'python.loadFonteditorModule'
            );
            const fonteditorModule = await fetch(
                './py/fonteditor.py?rev=glyph-filter-batch-1'
            );
            const fonteditorCode = await fonteditorModule.text();
            await runHostPythonAsync(fonteditorCode);
            timelineSpanEnd(fonteditorModuleSpanId);
            console.log('[FontEditor]', 'fonteditor.py module loaded');

            // Stored third-party wheels are restored only when their Disk permission persists.
            const restorePluginsSpanId = timelineSpanStart(
                'python.restorePlugins'
            );
            await restoreStoredPythonPlugins();
            timelineSpanEnd(restorePluginsSpanId);

            pyodideEnvironmentInitialized = true;
            timelineSpanEnd(initSpanId);
            timelineMark('python.initFontEditor.ready');

            await discoverPythonPlugins();
            if (
                document.getElementById('console-container') &&
                typeof window.initPyodideConsole === 'function'
            ) {
                void window.initPyodideConsole();
            }

            // Reclaim temporary import/wheel-install objects from CPython heap.
            try {
                await runHostPythonAsync('import gc; gc.collect()');
            } catch {
                // Non-fatal cleanup.
            }

            return window.pyodide;
        } catch (error) {
            timelineSpanEnd(initSpanId);
            timelineMark('python.initFontEditor.failed');
            pyodideReadyPromise = null;
            throw error;
        }
    })();

    return pyodideReadyPromise;
}

/**
 * Pure-JS app startup: runs immediately on DOMContentLoaded without loading Pyodide.
 */
async function initAppStartup(): Promise<boolean> {
    try {
        if (!checkCrossOriginIsolation()) {
            return false;
        }

        const exampleFontsSpanId = timelineSpanStart('python.loadExampleFonts');
        if (window.loadExampleFonts) {
            try {
                await window.loadExampleFonts();
            } catch (error) {
                console.error(
                    '[FontEditor]',
                    'Failed to load example fonts:',
                    error
                );
            }
        }
        timelineSpanEnd(exampleFontsSpanId);

        if (window.updateLoadingStatus) {
            window.updateLoadingStatus('READY', true);
        }

        const lastActiveView = getFocusViewId() || 'view-editor';
        if (window.focusView) {
            window.focusView(lastActiveView);
        }

        hideStartupOverlay();
        markFontEditorReady();

        // Discover built-in JS glyph filters immediately (no Pyodide required).
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

        // Eagerly initialize Pyodide so all Python features, console, skills,
        // and plugins are ready immediately at startup.
        void ensurePyodideReady().catch((error) => {
            console.error(
                '[FontEditor]',
                'Pyodide startup initialization failed:',
                error
            );
        });

        return true;
    } catch (error) {
        console.error('[FontEditor]', 'Error during app startup:', error);
        markFontEditorReadyFailed(error);
        hideStartupOverlay();
        return false;
    }
}

async function initFontEditor(): Promise<boolean> {
    try {
        await ensurePyodideReady();
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[FontEditor]', 'Error initializing FontEditor:', error);
        if (window.term) {
            window.term.error('Failed to initialize FontEditor: ' + message);
        }
        return false;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    void initAppStartup();
});

window.addEventListener('settingsFolderAccessChanged', (event: Event) => {
    const detail = (
        event as CustomEvent<{
            hasSettingsFolderAccess?: boolean;
        }>
    ).detail;
    if (!detail?.hasSettingsFolderAccess) {
        return;
    }
    void restoreStoredPythonPluginsOnFolderAccess().catch((error) => {
        console.warn(
            '[FontEditor]',
            'Failed to restore stored Python plugins after folder access change:',
            error
        );
    });
});

window.ensurePyodideReady = ensurePyodideReady;
window.initFontEditor = initFontEditor;
