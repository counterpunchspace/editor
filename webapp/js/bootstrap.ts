import './wasm-init'; // Initialize WASM module
import './tab-lifecycle';
import './critical-error-handler';
import './state-manager'; // Initialize state manager early
import { Logger } from './logger';
import {
    timelineMark,
    timelineSpanEnd,
    timelineSpanStart
} from './perf-timeline';

const console = new Logger('Bootstrap');

timelineMark('app.bootstrap.moduleLoaded');

function summarizeStartupEvent(
    eventName: string,
    event: Event
): Record<string, unknown> {
    const detail = (event as CustomEvent<Record<string, unknown> | undefined>)
        .detail;

    if (!detail || typeof detail !== 'object') {
        return {};
    }

    if (eventName === 'fontLoaded') {
        return {
            path: detail.path ?? null,
            sourcePluginId:
                (
                    detail.sourcePlugin as { getId?: () => string } | undefined
                )?.getId?.() ??
                (detail.sourcePlugin as { id?: string } | undefined)?.id ??
                null
        };
    }

    if (eventName === 'fontOpenLifecycle') {
        return {
            openSessionId: detail.openSessionId ?? null,
            phase: detail.phase ?? null,
            reason: detail.reason ?? null,
            path: detail.path ?? null,
            sourcePluginId: detail.sourcePluginId ?? null,
            canvasReady: detail.canvasReady ?? null,
            startupFinalizeStarted: detail.startupFinalizeStarted ?? null
        };
    }

    if (eventName === 'editingFontCompiled') {
        return {
            changeVersion: detail.changeVersion ?? null,
            duration: detail.duration ?? null,
            error: detail.error ?? null
        };
    }

    return { ...detail };
}

function registerStartupEventLogging(): void {
    const startupEvents = [
        'unsupportedBrowserContinue',
        'pwaLaunchFilesPending',
        'fontLoaded',
        'fontOpenLifecycle',
        'fontModelReady',
        'canvasInitialReady',
        'editingFontCompiled',
        'fontReady'
    ];

    for (const eventName of startupEvents) {
        window.addEventListener(eventName, (event: Event) => {
            globalThis.console.log(
                `[StartupEvent] ${eventName}`,
                summarizeStartupEvent(eventName, event)
            );
        });
    }
}

registerStartupEventLogging();

window.EDITOR_VERSION = process.env.EDITOR_VERSION || null;
window.BUILD_HASH_FULL = process.env.BUILD_HASH_FULL || null;
window.BUILD_HASH_SHORT = process.env.BUILD_HASH_SHORT || null;
window.WORKTREE_NAME = '';

// Load worktree config at runtime (set by worktree/create for parallel worktrees)
fetch('worktree-config.json')
    .then((r) => r.json())
    .then((config) => {
        if (!config.name) return;
        window.WORKTREE_NAME = config.name;
        const el = document.getElementById('app-version');
        if (el) el.textContent = config.name;
        const title = document.title;
        if (title.indexOf('[' + config.name + ']') === -1) {
            document.title = title.replace(
                'Editor',
                'Editor [' + config.name + ']'
            );
        }
    })
    .catch(() => {
        /* No config — not a worktree */
    });

function registerPwaLaunchFileConsumer() {
    const launchQueue = (window as any).launchQueue;
    if (!launchQueue || typeof launchQueue.setConsumer !== 'function') {
        return;
    }

    launchQueue.setConsumer((launchParams: any) => {
        const launchedHandles = Array.isArray(launchParams?.files)
            ? launchParams.files.filter(
                  (handle: any) => handle?.kind === 'file'
              )
            : [];

        if (!launchedHandles.length) {
            return;
        }

        const pendingHandles = Array.isArray(
            (window as any).__pendingLaunchFileHandles
        )
            ? (window as any).__pendingLaunchFileHandles
            : [];

        (window as any).__pendingLaunchFileHandles = [
            ...pendingHandles,
            ...launchedHandles
        ];

        window.dispatchEvent(new CustomEvent('pwaLaunchFilesPending'));
    });
}

registerPwaLaunchFileConsumer();

function isSupportedBrowser(): boolean {
    const ua = navigator.userAgent;
    const navWithUAData = navigator as Navigator & {
        userAgentData?: {
            brands?: { brand: string; version: string }[];
        };
    };
    const brands = navWithUAData.userAgentData?.brands || [];

    const hasEdgeBrand = brands.some((entry) =>
        entry.brand.toLowerCase().includes('edge')
    );
    const hasChromiumBrand = brands.some((entry) => {
        const brand = entry.brand.toLowerCase();
        return brand.includes('chromium') || brand.includes('chrome');
    });

    const isEdgeUA = /Edg\//.test(ua);
    const isChromiumUA = /Chrome\//.test(ua) || /Chromium\//.test(ua);
    const isSafariUA =
        /Safari\//.test(ua) &&
        !/Chrome\//.test(ua) &&
        !/Chromium\//.test(ua) &&
        !/CriOS\//.test(ua) &&
        !/Edg\//.test(ua) &&
        !/OPR\//.test(ua) &&
        !/FxiOS\//.test(ua) &&
        !/Firefox\//.test(ua) &&
        !/Android/.test(ua);

    return (
        hasEdgeBrand ||
        hasChromiumBrand ||
        isEdgeUA ||
        isChromiumUA ||
        isSafariUA
    );
}

function getBrowserMatrixKey():
    'chrome' | 'edge' | 'safari' | 'firefox' | 'brave' | null {
    const ua = navigator.userAgent;
    const navWithUAData = navigator as Navigator & {
        userAgentData?: {
            brands?: { brand: string; version: string }[];
        };
        brave?: unknown;
    };
    const brands = navWithUAData.userAgentData?.brands || [];

    const hasBrand = (needle: string) =>
        brands.some((entry) => entry.brand.toLowerCase().includes(needle));

    const isBrave =
        hasBrand('brave') ||
        /Brave\//.test(ua) ||
        typeof navWithUAData.brave !== 'undefined';
    if (isBrave) {
        return 'brave';
    }

    if (hasBrand('edge') || /Edg\//.test(ua)) {
        return 'edge';
    }

    const isSafari =
        /Safari\//.test(ua) &&
        !/Chrome\//.test(ua) &&
        !/Chromium\//.test(ua) &&
        !/CriOS\//.test(ua) &&
        !/Edg\//.test(ua) &&
        !/OPR\//.test(ua) &&
        !/FxiOS\//.test(ua) &&
        !/Firefox\//.test(ua) &&
        !/Android/.test(ua);
    if (isSafari) {
        return 'safari';
    }

    if (hasBrand('firefox') || /Firefox\//.test(ua) || /FxiOS\//.test(ua)) {
        return 'firefox';
    }

    if (
        hasBrand('chromium') ||
        hasBrand('chrome') ||
        /Chrome\//.test(ua) ||
        /Chromium\//.test(ua) ||
        /CriOS\//.test(ua)
    ) {
        return 'chrome';
    }

    return null;
}

function showUnsupportedBrowserOverlay() {
    if (isSupportedBrowser()) {
        (window as any).__unsupportedBrowserWarningRequired = false;
        (window as any).__unsupportedBrowserWarningAcknowledged = true;
        return;
    }

    (window as any).__unsupportedBrowserWarningRequired = true;
    (window as any).__unsupportedBrowserWarningAcknowledged = false;

    const loadingOverlay = document.getElementById('loading-overlay');
    if (!loadingOverlay) {
        return;
    }

    if (document.getElementById('unsupported-browser-overlay')) {
        return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'unsupported-browser-overlay';
    overlay.className = 'unsupported-browser-overlay';
    const currentBrowser = getBrowserMatrixKey();
    const highlightClass = (key: string) =>
        currentBrowser === key ? ' current-browser' : '';
    const supportIcon = (supported: boolean) =>
        `<span class="material-symbols-outlined matrix-support-icon ${
            supported ? 'matrix-support-icon-yes' : 'matrix-support-icon-no'
        }" aria-label="${supported ? 'Supported' : 'Not supported'}">${supported ? 'check' : 'close'}</span>`;
    const noteForBrowser = (key: string) => {
        const notes: string[] = [];
        if (key === 'chrome') {
            notes.push(
                '<span class="browser-note-recommended">Recommended</span>'
            );
        }
        if (currentBrowser === key) {
            notes.push(
                '<span class="browser-note-current">← Your browser</span>'
            );
        }
        return notes.join(' ');
    };
    overlay.innerHTML = `
        <div class="unsupported-browser-panel" role="alert" aria-live="polite">
            <h2 class="unsupported-browser-title">Browser Compatibility Warning</h2>
            <p class="unsupported-browser-text">Counterpunch officially supports <strong>Chrome/Chromium</strong>, <strong>Edge</strong>, and <strong>Safari</strong>.</p>
            <p class="unsupported-browser-text"><strong>Chrome/Chromium</strong> is recommended because it is currently the only browser that supports hot-reloading of external files.</p>
            <div class="browser-feature-matrix-wrapper">
                <table class="browser-feature-matrix" aria-label="Browser feature support matrix">
                    <thead>
                        <tr>
                            <th>Browser</th>
                            <th>Native disk access</th>
                            <th>Hot reloading</th>
                            <th>Notes</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr class="${highlightClass('chrome')}">
                            <td>Chrome/Chromium</td>
                            <td class="matrix-support-cell">${supportIcon(true)}</td>
                            <td class="matrix-support-cell">${supportIcon(true)}</td>
                            <td class="matrix-note-cell">${noteForBrowser('chrome')}</td>
                        </tr>
                        <tr class="${highlightClass('edge')}">
                            <td>Edge</td>
                            <td class="matrix-support-cell">${supportIcon(true)}</td>
                            <td class="matrix-support-cell">${supportIcon(false)}</td>
                            <td class="matrix-note-cell">${noteForBrowser('edge')}</td>
                        </tr>
                        <tr class="${highlightClass('safari')}">
                            <td>Safari</td>
                            <td class="matrix-support-cell">${supportIcon(true)}</td>
                            <td class="matrix-support-cell">${supportIcon(false)}</td>
                            <td class="matrix-note-cell">${noteForBrowser('safari')}</td>
                        </tr>
                        <tr class="${highlightClass('firefox')}">
                            <td>Firefox</td>
                            <td class="matrix-support-cell">${supportIcon(false)}</td>
                            <td class="matrix-support-cell">${supportIcon(false)}</td>
                            <td class="matrix-note-cell">${noteForBrowser('firefox')}</td>
                        </tr>
                        <tr class="${highlightClass('brave')}">
                            <td>Brave</td>
                            <td class="matrix-support-cell">${supportIcon(false)}</td>
                            <td class="matrix-support-cell">${supportIcon(false)}</td>
                            <td class="matrix-note-cell">${noteForBrowser('brave')}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <p class="unsupported-browser-text"><strong>Firefox</strong> and <strong>Brave</strong> generally run, but they do not support native disk access and are not recommended. In these browsers, only Memory file access is available.</p>
            <button type="button" class="unsupported-browser-continue">Continue</button>
        </div>
    `;

    const continueButton = overlay.querySelector(
        '.unsupported-browser-continue'
    ) as HTMLButtonElement | null;
    continueButton?.addEventListener('click', () => {
        (window as any).__unsupportedBrowserWarningAcknowledged = true;
        overlay.remove();
        window.dispatchEvent(new CustomEvent('unsupportedBrowserContinue'));
    });

    loadingOverlay.appendChild(overlay);
    console.warn('Unsupported browser detected; warning overlay shown.');
}

// Utility function to update loading status (extracted from loading-animation.js)
window.updateLoadingStatus = function (
    message: string,
    isReady: boolean = false
) {
    const statusElement = document.getElementById('loading-status');
    if (statusElement) {
        statusElement.textContent = message;
        if (isReady) {
            statusElement.classList.add('ready');
        } else {
            statusElement.classList.remove('ready');
        }
    }
};

// Handle URL-based font opening special case
const handleURLFontOpen = () => {
    const urlOpenSpan = timelineSpanStart('app.urlFontOpen');
    const urlParams = new URLSearchParams(window.location.search);
    const fileParam = urlParams.get('file');
    const legacyPath = urlParams.get('path');

    let fontPath: string | null = null;

    // Try new file URI format first
    if (fileParam) {
        const legacyCloudPath =
            fileParam.startsWith('cloud://') &&
            !fileParam.startsWith('cloud:///')
                ? fileParam.slice('cloud://'.length)
                : null;

        // parseFileUri will be available after file-browser.ts loads.
        // For bootstrap, parse inline to avoid dependency.
        const match = fileParam.match(/^([^:]+):\/\/\/(.*)$/);
        if (legacyCloudPath) {
            fontPath = '/' + legacyCloudPath;
        } else if (match) {
            fontPath = '/' + match[2];
        }
    } else if (legacyPath) {
        // Fall back to legacy format
        fontPath = legacyPath;
    }

    if (fontPath) {
        timelineMark('app.urlFontOpen.fontPathDetected');
        const statusElement = document.getElementById('loading-status');
        if (statusElement) {
            statusElement.style.display = '';
            const filename = fontPath.split('/').pop() || fontPath;
            statusElement.textContent = `Opening ${filename}`;
        }
    }

    timelineSpanEnd(urlOpenSpan);
};

// Initialize on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', handleURLFontOpen);
} else {
    handleURLFontOpen();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        timelineMark('app.domContentLoaded');
    });
} else {
    timelineMark('app.domContentLoaded.alreadyReady');
}

if (document.readyState === 'loading') {
    document.addEventListener(
        'DOMContentLoaded',
        showUnsupportedBrowserOverlay
    );
} else {
    showUnsupportedBrowserOverlay();
}

// Disable default browser context menu in production.
// Custom Tippy menu targets opt in with data-has-context-menu so the native
// browser menu is suppressed while the app's own handler can still run.
// Text input elements remain exempt so copy/paste stays available.
const disableDefaultContextMenu = () => {
    if (window.isProduction && window.isProduction()) {
        document.addEventListener(
            'contextmenu',
            (e) => {
                const target = e.target as HTMLElement;

                // Suppress the browser menu on custom context-menu targets,
                // but do not stop propagation so app handlers can still open
                // their own Tippy menus.
                if (
                    target.closest(
                        '[data-has-context-menu="true"], .tippy-box, .plugin-menu-backdrop'
                    )
                ) {
                    e.preventDefault();
                    return;
                }

                // Allow on text input/textarea for copy/paste
                if (
                    target.tagName === 'INPUT' ||
                    target.tagName === 'TEXTAREA'
                ) {
                    return;
                }

                // Allow on contenteditable elements
                if (target.isContentEditable) {
                    return;
                }

                // Allow on Ace editor (has its own context menu)
                if (target.closest('.ace_editor')) {
                    return;
                }

                // Block default context menu everywhere else
                e.preventDefault();
            },
            true
        );
        console.log(
            '[Bootstrap]',
            'Default context menu disabled in production'
        );
    }
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', disableDefaultContextMenu);
} else {
    disableDefaultContextMenu();
}

import './auth-manager'; // Authentication with fonteditorwebsite
import { initLinkNavigationGuard } from './link-navigation';
initLinkNavigationGuard();
import './ai-assistant';
import './auto-compile-manager';
import './cache-manager';
import './window-role';
import './window-ui-state';
import './canvas-plugin-manager';
import './change-bridge-init'; // Yjs undo/redo & cross-window sync
import './editor-plugins-ui';
import './editor-stack-preview-menu';
import './editor-edit-tools-ui';
import './ui/title-bar-text-fields';
import './example-loader';
import './file-browser';
import './font-info'; // Font info view manager (Names/Features tabs)
import './font-interpolation';
import './font-manager';
import './fonteditor';
import './welcome-screen';
import './folder-permissions-dialog';
import './tour';
import './state-sync'; // URL state synchronization
import './state-restore'; // URL state restoration
import './glyph-canvas';
import './history-view';
import './view-settings';
import './keyboard-navigation';
import './matplotlib-handler';
import './memory-monitor';
import './editor-health-monitor';
import './python-utils';
import './system-notifications';
import './pyodide-official-console';
import './python-execution-wrapper';
import './python-package-lazy-loader';
import './python-ui-sync';
import './python-post-execution';
import './docs-viewer';
import './resizer';
import './save-button';
import './script-editor';
import './run-python-script-dialog';
import './share-button';
import './theme-switcher';
import './toolbar-menus';
import './update-manager';
import './window-buttons';
import './keyboard-shortcut-display';
import { initViewTitleButtons } from './view-title-buttons';
import { CloudPlugin } from './filesystem-plugins/plugins/cloud-plugin';
import { pluginRegistry } from './filesystem-plugins';

// Initialize view title buttons after DOM is ready and keyboard navigation is initialized
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        // Delay slightly to ensure keyboard-navigation.js has initialized
        setTimeout(() => {
            initViewTitleButtons();
        }, 100);
    });
} else {
    setTimeout(() => {
        initViewTitleButtons();
    }, 100);
}

// Cloud collaboration — exposed for console testing and file-browser cloud:// routing.
const _cloudPlugin = new CloudPlugin();
window.cloudPlugin = _cloudPlugin;
pluginRegistry.register(_cloudPlugin);

/**
 * Create a local dev cloud session and store it as the editor session cookie.
 */
async function bootstrapLocalCloudSession(
    email = 'local-dev@counterpunch.test'
) {
    const user = await window.authManager.bootstrapLocalCloudSession(email);
    const sessionToken = window.authManager.getSessionToken();

    if (!user || !sessionToken) {
        throw new Error('local cloud session bootstrap did not complete');
    }

    return {
        sessionToken,
        user: user as { id: string; email: string; name: string | null }
    };
}

// Dev helper for Phase 0/1 testing in the browser console:
//   window.cloudDebug.bootstrapLocalSession('dev@counterpunch.test')
//   window.cloudDebug.connectToRoom('my-asset-id')
//   window.cloudDebug.connectWithToken('my-asset-id', token, 'ws://localhost:8787/room/my-asset-id')
window.cloudDebug = {
    bootstrapLocalSession: (email?: string) =>
        bootstrapLocalCloudSession(email),
    connectToRoom: (assetId: string) => _cloudPlugin.connectToRoom(assetId),
    connectWithToken: (assetId: string, token: string, roomUrl: string) =>
        _cloudPlugin.connectToRoomWithToken(assetId, token, roomUrl),
    disconnectFromRoom: () => _cloudPlugin.disconnectFromRoom(),
    getStatus: () => _cloudPlugin.connectionStatus
};
