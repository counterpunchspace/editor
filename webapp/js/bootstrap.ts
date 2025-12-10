import './loading-animation.js';
import './tab-lifecycle.js';

import './ai-assistant.js';
import './auto-compile-manager';
import './cache-manager.js';
import './compile-button.ts';
import './example-loader.js';
import './file-browser';
import './font-manager';
import './fonteditor.js';
import './glyph-canvas';
import './keyboard-navigation.js';
import './matplotlib-handler.js';
import './memory-monitor.js';
import './pyodide-official-console.js';
import './python-execution-wrapper.js';
import './python-ui-sync.js';
import './resizer.js';
import './save-button.js';
import './script-editor.js';
import './sound-preloader.js';
import './theme-switcher.js';
import './view-settings.js';

// Import and initialize font compilation explicitly
import { fontCompilation } from './font-compilation';

// Initialize font compilation system early
(async () => {
    console.log('[Bootstrap] Initializing font compilation system...');
    // Wait for service worker if it's being used (production)
    if ('serviceWorker' in navigator) {
        try {
            // Wait with timeout in case SW is loading
            await Promise.race([
                navigator.serviceWorker.ready,
                new Promise(resolve => setTimeout(resolve, 2000))
            ]);
            console.log('[Bootstrap] Service worker ready');
        } catch (e) {
            console.log('[Bootstrap] No service worker (development mode)');
        }
    }
    await fontCompilation.initialize();
    console.log('[Bootstrap] Font compilation system ready');
})();
