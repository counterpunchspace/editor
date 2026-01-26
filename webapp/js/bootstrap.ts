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

// Clear initial message and show "Bootstrapping..." after 2 seconds
const initBootstrappingMessage = () => {
    const statusElement = document.getElementById('loading-status');
    const loadingContent = document.querySelector(
        '.loading-content'
    ) as HTMLElement;
    const loadingOverlay = document.getElementById('loading-overlay');

    // Check if opening a font from URL params
    const urlParams = new URLSearchParams(window.location.search);
    const fontPath = urlParams.get('path');

    if (fontPath) {
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
    } else if (statusElement) {
        // Normal startup flow
        // Clear the initial message immediately
        statusElement.textContent = '';

        // Show "Bootstrapping..." after 2 seconds if no other message has been set
        setTimeout(() => {
            if (statusElement.textContent === '') {
                statusElement.textContent = 'Bootstrapping...';
            }
        }, 2000);
    }
};

// Initialize bootstrapping message when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBootstrappingMessage);
} else {
    initBootstrappingMessage();
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
import './glyph-canvas';
import './keyboard-navigation.js';
import './matplotlib-handler.js';
import './memory-monitor.js';
import './pyodide-official-console.js';
import './python-execution-wrapper.js';
import './python-package-lazy-loader.js';
import './python-ui-sync.js';
import './python-post-execution';
import './resizer.js';
import './save-button.js';
import './script-editor.js';
import './sound-preloader.js';
import './theme-switcher.js';
import './view-settings.js';
