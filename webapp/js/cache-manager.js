// Cache Management Utilities
// Simple utilities for cache inspection (no automatic clearing)

(function () {
    'use strict';

    class CacheManager {
        constructor() {
            console.log('[CacheManager]', 'Cache Manager loaded');
        }

        async clearServiceWorkers() {
            if ('serviceWorker' in navigator) {
                try {
                    const registrations =
                        await navigator.serviceWorker.getRegistrations();

                    if (registrations.length === 0) {
                        console.log(
                            '[CacheManager]',
                            'No service workers to clear'
                        );
                        return { success: true, count: 0 };
                    }

                    console.log(
                        '[CacheManager]',
                        `Found ${registrations.length} service worker(s)`
                    );

                    for (const registration of registrations) {
                        await registration.unregister();
                        console.log(
                            '[CacheManager]',
                            '✅ Unregistered service worker:',
                            registration.scope
                        );
                    }

                    return {
                        success: true,
                        count: registrations.length,
                        message: `Cleared ${registrations.length} service worker(s)`
                    };
                } catch (error) {
                    console.error(
                        '[CacheManager]',
                        'Failed to clear service workers:',
                        error
                    );
                    return {
                        success: false,
                        error: error.message
                    };
                }
            } else {
                return {
                    success: false,
                    message: 'Service workers not supported'
                };
            }
        }

        async clearCaches() {
            if ('caches' in window) {
                try {
                    const cacheNames = await caches.keys();

                    if (cacheNames.length === 0) {
                        console.log('[CacheManager]', 'No caches to clear');
                        return { success: true, count: 0 };
                    }

                    console.log(
                        '[CacheManager]',
                        `Found ${cacheNames.length} cache(s):`,
                        cacheNames
                    );

                    for (const cacheName of cacheNames) {
                        await caches.delete(cacheName);
                        console.log(
                            '[CacheManager]',
                            '✅ Deleted cache:',
                            cacheName
                        );
                    }

                    return {
                        success: true,
                        count: cacheNames.length,
                        message: `Cleared ${cacheNames.length} cache(s)`
                    };
                } catch (error) {
                    console.error(
                        '[CacheManager]',
                        'Failed to clear caches:',
                        error
                    );
                    return {
                        success: false,
                        error: error.message
                    };
                }
            } else {
                return {
                    success: false,
                    message: 'Cache API not supported'
                };
            }
        }

        async clearIndexedDB() {
            return new Promise((resolve) => {
                // Pyodide uses IndexedDB for package caching
                const databases = ['pyodide', 'pyodide-packages'];
                let cleared = 0;
                let failed = 0;

                databases.forEach((dbName) => {
                    const request = indexedDB.deleteDatabase(dbName);

                    request.onsuccess = () => {
                        console.log(
                            '[CacheManager]',
                            `✅ Deleted IndexedDB: ${dbName}`
                        );
                        cleared++;
                        if (cleared + failed === databases.length) {
                            resolve({
                                success: true,
                                count: cleared,
                                message: `Cleared ${cleared} IndexedDB(s)`
                            });
                        }
                    };

                    request.onerror = () => {
                        console.log(
                            '[CacheManager]',
                            `⚠️ Could not delete IndexedDB: ${dbName}`
                        );
                        failed++;
                        if (cleared + failed === databases.length) {
                            resolve({
                                success: cleared > 0,
                                count: cleared,
                                message: `Cleared ${cleared} IndexedDB(s), ${failed} failed`
                            });
                        }
                    };

                    request.onblocked = () => {
                        console.log(
                            '[CacheManager]',
                            `⚠️ IndexedDB deletion blocked: ${dbName}`
                        );
                        failed++;
                        if (cleared + failed === databases.length) {
                            resolve({
                                success: cleared > 0,
                                count: cleared,
                                message: `Cleared ${cleared} IndexedDB(s), ${failed} blocked`
                            });
                        }
                    };
                });
            });
        }

        async clearAll() {
            console.log('[CacheManager]', '🗑️ Clearing all caches...');

            const results = {
                serviceWorkers: await this.clearServiceWorkers(),
                caches: await this.clearCaches(),
                indexedDB: await this.clearIndexedDB()
            };

            console.log('[CacheManager]', 'Cache clearing results:', results);

            // Show summary
            const messages = [];
            if (results.serviceWorkers.count > 0) {
                messages.push(results.serviceWorkers.message);
            }
            if (results.caches.count > 0) {
                messages.push(results.caches.message);
            }
            if (results.indexedDB.count > 0) {
                messages.push(results.indexedDB.message);
            }

            if (messages.length === 0) {
                console.log('[CacheManager]', '✅ No caches found to clear');
            } else {
                console.log(
                    '[CacheManager]',
                    '✅ Cache clearing complete:',
                    messages.join(', ')
                );
            }

            return results;
        }

        async clearAndReload() {
            console.log(
                '[CacheManager]',
                '🔄 Clearing all caches and reloading...'
            );
            await this.clearAll();

            // Wait a moment for cleanup to complete
            setTimeout(() => {
                console.log('[CacheManager]', '🔄 Reloading page...');
                window.location.reload(true); // Force reload from server
            }, 500);
        }

        getCacheStats() {
            const stats = {
                serviceWorkerSupported: 'serviceWorker' in navigator,
                cacheApiSupported: 'caches' in window,
                indexedDBSupported: 'indexedDB' in window,
                crossOriginIsolated:
                    typeof crossOriginIsolated !== 'undefined'
                        ? crossOriginIsolated
                        : false,
                sharedArrayBufferSupported:
                    typeof SharedArrayBuffer !== 'undefined'
            };

            console.log('[CacheManager]', 'Storage Statistics:');
            console.table(stats);
            return stats;
        }
    }

    // Export to window (for manual use only)
    window.cacheManager = new CacheManager();

    // Simple console helper
    window.cacheStats = () => window.cacheManager.getCacheStats();

    // No automatic clearing - keep it simple
    console.log(
        '[CacheManager]',
        `%c� Cache Info Available %c
  
To check cache support:
  cacheStats()
  
Manual cache access:
  window.cacheManager.clearServiceWorkers()
  window.cacheManager.clearCaches()
  window.cacheManager.clearIndexedDB()
`,
        'color: #0ff; font-weight: bold;',
        'color: #999;'
    );

    // Track memory across reloads
    function trackMemoryAcrossReloads() {
        const reloadCount =
            parseInt(sessionStorage.getItem('reloadCount') || '0') + 1;
        sessionStorage.setItem('reloadCount', reloadCount.toString());

        if (performance.memory) {
            const currentMemory = {
                used: performance.memory.usedJSHeapSize,
                total: performance.memory.totalJSHeapSize,
                limit: performance.memory.jsHeapSizeLimit,
                reloadCount: reloadCount,
                timestamp: Date.now()
            };

            const lastMemory = JSON.parse(
                sessionStorage.getItem('lastMemory') || 'null'
            );
            sessionStorage.setItem('lastMemory', JSON.stringify(currentMemory));

            if (lastMemory) {
                const usedMB = (currentMemory.used / 1048576).toFixed(2);
                const lastUsedMB = (lastMemory.used / 1048576).toFixed(2);
                const delta = (
                    (currentMemory.used - lastMemory.used) /
                    1048576
                ).toFixed(2);
                const deltaPercent = (
                    ((currentMemory.used - lastMemory.used) / lastMemory.used) *
                    100
                ).toFixed(1);

                console.log(
                    '[CacheManager]',
                    `%c📊 Memory Tracking (Reload #${reloadCount})`,
                    'color: #ff0; font-weight: bold;'
                );
                console.log('[CacheManager]', `   Current: ${usedMB} MB`);
                console.log('[CacheManager]', `   Previous: ${lastUsedMB} MB`);

                if (delta > 0) {
                    console.log(
                        '[CacheManager]',
                        `   %cΔ +${delta} MB (+${deltaPercent}%) 📈 INCREASE`,
                        'color: #f00; font-weight: bold;'
                    );
                } else {
                    console.log(
                        '[CacheManager]',
                        `   %cΔ ${delta} MB (${deltaPercent}%) 📉 DECREASE`,
                        'color: #0f0; font-weight: bold;'
                    );
                }

                // Warn if memory keeps growing
                if (reloadCount > 2 && delta > 10) {
                    console.warn(
                        '[CacheManager]',
                        `%c⚠️ MEMORY LEAK DETECTED: Memory grew by ${delta}MB after reload!`,
                        'color: #f00; font-size: 14px; font-weight: bold;'
                    );
                    console.warn('[CacheManager]', 'Possible causes:');
                    console.warn(
                        '[CacheManager]',
                        '  1. Service worker maintaining state'
                    );
                    console.warn(
                        '[CacheManager]',
                        '  2. Browser not fully garbage collecting'
                    );
                    console.warn(
                        '[CacheManager]',
                        '  3. IndexedDB or LocalStorage growth'
                    );
                    console.warn('[CacheManager]', '');
                    console.warn(
                        '[CacheManager]',
                        'Try: Close all tabs and restart browser completely'
                    );
                }
            } else {
                const usedMB = (currentMemory.used / 1048576).toFixed(2);
                console.log(
                    '[CacheManager]',
                    `%c📊 Memory Tracking (First Load)`,
                    'color: #0ff; font-weight: bold;'
                );
                console.log('[CacheManager]', `   Initial: ${usedMB} MB`);
            }
        }
    }

    // Auto-clear service worker caches on page load
    async function forceServiceWorkerReset() {
        if ('serviceWorker' in navigator) {
            try {
                // Get the COI service worker
                const registrations =
                    await navigator.serviceWorker.getRegistrations();

                for (const registration of registrations) {
                    // Send deregister message to the service worker
                    // This triggers the worker's built-in cleanup
                    if (registration.active) {
                        registration.active.postMessage({ type: 'deregister' });
                        console.log(
                            '[CacheManager]',
                            '📨 Sent deregister message to service worker'
                        );
                    }

                    // Force unregister
                    await registration.unregister();
                    console.log(
                        '[CacheManager]',
                        '✅ Force unregistered service worker'
                    );
                }

                // Wait a moment for cleanup
                await new Promise((resolve) => setTimeout(resolve, 100));

                return { success: true, reset: true };
            } catch (error) {
                console.warn(
                    '[CacheManager]',
                    '⚠️ Failed to reset service worker:',
                    error
                );
                return { success: false, error: error.message };
            }
        }
        return { success: false, message: 'Service workers not supported' };
    }

    async function autoClearOnLoad() {
        console.log(
            '[CacheManager]',
            '🧹 Auto-clearing service worker caches on page load...'
        );

        // Track memory first
        trackMemoryAcrossReloads();

        // Check reload count
        const reloadCount = parseInt(
            sessionStorage.getItem('reloadCount') || '0'
        );

        try {
            // FORCE reset the service worker completely
            // This is the key to preventing memory accumulation
            await forceServiceWorkerReset();

            // Clear remaining caches
            const cacheResult = await window.cacheManager.clearCaches();

            if (cacheResult.count > 0) {
                console.log(
                    '[CacheManager]',
                    `✅ Cleared ${cacheResult.count} cache(s) on page load`
                );
            } else {
                console.log(
                    '[CacheManager]',
                    '✅ Service worker reset, no additional caches to clear'
                );
            }

            // Important: The COI service worker will re-register itself
            // This is intentional - we want a FRESH instance each time
            console.log(
                '[CacheManager]',
                '🔄 Service worker will re-register with clean state'
            );

            // Show workaround if memory keeps growing
            if (reloadCount > 3) {
                console.log('[CacheManager]', '');
                console.log(
                    '[CacheManager]',
                    '%c💡 Memory Still Growing? Try These:',
                    'color: #ff0; font-weight: bold;'
                );
                console.log(
                    '[CacheManager]',
                    '%c1. Run: openCleanTab() then close this tab',
                    'color: #ff0;'
                );
                console.log(
                    '[CacheManager]',
                    '%c2. Close ALL tabs and reopen in new tab',
                    'color: #ff0;'
                );
                console.log(
                    '[CacheManager]',
                    '%c3. Close browser completely and restart',
                    'color: #ff0;'
                );
                console.log('[CacheManager]', '');
                console.log(
                    '[CacheManager]',
                    '%c⚠️  Service worker memory persists across reloads in same tab',
                    'color: #f80; font-style: italic;'
                );
                console.log(
                    '[CacheManager]',
                    '%c   This is a browser limitation, not a bug in the app',
                    'color: #f80; font-style: italic;'
                );
            }
        } catch (error) {
            console.warn(
                '[CacheManager]',
                '⚠️ Failed to auto-clear caches:',
                error
            );
        }
    }

    // Run auto-clear when page loads
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoClearOnLoad);
    } else {
        // Document already loaded
        autoClearOnLoad();
    }

    // Log helpful info
    console.log(
        '[CacheManager]',
        `
%c💡 Cache & Memory Management %c

Manual access:
  window.cacheManager.clearServiceWorkers()
  window.cacheManager.clearCaches()
  window.cacheManager.clearIndexedDB()

%c✨ Auto-features enabled:
   • Service worker FORCE RESET on every reload
   • Memory growth tracked across reloads
   
%c⚠️  If memory still grows, try: hardReset()
`,
        'color: #0ff; font-weight: bold; font-size: 14px;',
        'color: #0f0; font-style: italic;',
        'color: #ff0; font-style: italic;'
    );
})();
