import './wasm-init'; // Initialize WASM module
// import './loading-animation.js';  // Removed - animation disabled
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
    if (statusElement) {
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
