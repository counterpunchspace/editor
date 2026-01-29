import './wasm-init'; // Initialize WASM module
import './tab-lifecycle.js';
import './mcp-transport';
import './critical-error-handler';

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
    const urlParams = new URLSearchParams(window.location.search);
    const fileParam = urlParams.get('file');
    const legacyPath = urlParams.get('path');

    let fontPath: string | null = null;

    // Try new file URI format first
    if (fileParam) {
        // parseFileUri will be available after file-browser.ts loads
        // For bootstrap, parse inline to avoid dependency
        const match = fileParam.match(/^([^:]+):\/\/\/(.*)$/);
        if (match) {
            fontPath = '/' + match[2];
        }
    } else if (legacyPath) {
        // Fall back to legacy format
        fontPath = legacyPath;
    }

    if (fontPath) {
        const loadingContent = document.querySelector(
            '.loading-content'
        ) as HTMLElement;
        const statusElement = document.getElementById('loading-status');
        const loadingOverlay = document.getElementById('loading-overlay');

        // Hide logo, icon, and status label
        if (loadingContent) {
            loadingContent.style.display = 'none';
        }
        if (statusElement) {
            statusElement.style.display = 'none';
        }

        // Create and show simple loading message
        const filename = fontPath.split('/').pop() || fontPath;
        const fontLoadingLabel = document.createElement('div');
        fontLoadingLabel.textContent = `Opening ${filename}`;
        fontLoadingLabel.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-family: 'Inter', sans-serif;
            font-size: 24px;
            color: var(--text-primary);
            text-align: center;
            z-index: 999999;
        `;
        if (loadingOverlay) {
            loadingOverlay.appendChild(fontLoadingLabel);
        }
    }
};

// Initialize on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', handleURLFontOpen);
} else {
    handleURLFontOpen();
}

import './auth-manager.js'; // Authentication with fonteditorwebsite
import './ai-assistant.js';
import './auto-compile-manager';
import './cache-manager.js';
import './canvas-plugin-manager';
import './editor-plugins-ui.js';
import './example-loader.js';
import './file-browser';
import './font-interpolation';
import './font-manager';
import './fonteditor.js';
import './state-sync'; // URL state synchronization
import './state-restore'; // URL state restoration
import './glyph-canvas';
import './keyboard-navigation.js';
import './matplotlib-handler.js';
import './memory-monitor.js';
import './python-utils.js';
import './pyodide-official-console.js';
import './python-execution-wrapper.js';
import './python-package-lazy-loader.js';
import './python-ui-sync.js';
import './python-post-execution';
import './resizer.js';
import './save-button.js';
import './script-editor.js';
import './share-button';
import './sound-preloader.js';
import './theme-switcher.js';
import './view-settings.js';
