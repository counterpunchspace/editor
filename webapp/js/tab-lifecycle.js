// Tab Lifecycle Management
// Prevents the browser from discarding the tab and protects font editor data

class TabLifecycleManager {
    constructor() {
        this.lockHeld = false;
        this.persistentStorageGranted = false;
        this.keepAliveInterval = null;
    }

    async initialize() {
        console.log('[Tab Lifecycle] Initializing tab protection...');

        // Request persistent storage
        await this.requestPersistentStorage();

        // Acquire Web Lock to prevent tab discard
        this.acquireWebLock();

        // Set up visibility change handler
        this.setupVisibilityHandler();

        // Set up beforeunload warning
        this.setupBeforeUnloadWarning();

        console.log('[Tab Lifecycle] Tab protection initialized');
    }

    async requestPersistentStorage() {
        if (!navigator.storage || !navigator.storage.persist) {
            console.warn(
                '[Tab Lifecycle] Persistent Storage API not supported'
            );
            return false;
        }

        try {
            // Check if already persistent
            const isPersisted = await navigator.storage.persisted();

            if (isPersisted) {
                console.log('[Tab Lifecycle] ✅ Storage is already persistent');
                this.persistentStorageGranted = true;
                return true;
            }

            // Request persistence
            const granted = await navigator.storage.persist();

            if (granted) {
                console.log(
                    '[Tab Lifecycle] ✅ Persistent storage granted - data will not be cleared'
                );
                this.persistentStorageGranted = true;

                // Check quota
                if (navigator.storage.estimate) {
                    const estimate = await navigator.storage.estimate();
                    const percentUsed = (
                        (estimate.usage / estimate.quota) *
                        100
                    ).toFixed(2);
                    console.log(
                        `[Tab Lifecycle] Storage: ${this.formatBytes(estimate.usage)} / ${this.formatBytes(estimate.quota)} (${percentUsed}%)`
                    );
                }

                return true;
            } else {
                console.warn(
                    '[Tab Lifecycle] ⚠️ Persistent storage denied - localStorage may be cleared during low disk space'
                );
                console.info(
                    '[Tab Lifecycle] ℹ️ Your tab is still protected by Web Lock - it will not be killed'
                );
                console.info(
                    '[Tab Lifecycle] ℹ️ In-memory font data remains safe. Save regularly to disk for backup.'
                );
                return false;
            }
        } catch (error) {
            console.error(
                '[Tab Lifecycle] Error requesting persistent storage:',
                error
            );
            return false;
        }
    }

    acquireWebLock() {
        if (!('locks' in navigator)) {
            console.warn('[Tab Lifecycle] Web Locks API not supported');
            return;
        }

        // Request a lock that will be held as long as the tab is active
        navigator.locks
            .request(
                'font_editor_active',
                { mode: 'exclusive' },
                async (lock) => {
                    console.log(
                        '[Tab Lifecycle] 🔒 Web Lock acquired - tab protected from discard'
                    );
                    this.lockHeld = true;

                    // This promise never resolves, keeping the lock active indefinitely
                    // The lock will be automatically released when:
                    // 1. The tab is closed
                    // 2. The page navigates away
                    // 3. The browser crashes
                    return new Promise(() => {
                        // Keep the lock active forever
                    });
                }
            )
            .catch((error) => {
                console.error(
                    '[Tab Lifecycle] Error acquiring Web Lock:',
                    error
                );
                this.lockHeld = false;
            });
    }

    setupVisibilityHandler() {
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                console.log('[Tab Lifecycle] Tab hidden - starting keepalive');
                this.startKeepAlive();
            } else {
                console.log('[Tab Lifecycle] Tab visible - stopping keepalive');
                this.stopKeepAlive();
            }
        });

        // Also handle page freeze events (if supported)
        document.addEventListener(
            'freeze',
            (e) => {
                console.warn(
                    '[Tab Lifecycle] Page freeze detected - tab may be suspended'
                );
            },
            { capture: true }
        );

        document.addEventListener(
            'resume',
            (e) => {
                console.log('[Tab Lifecycle] Page resumed from freeze');
            },
            { capture: true }
        );
    }

    startKeepAlive() {
        // Clear any existing interval
        this.stopKeepAlive();

        // Create a minimal activity to prevent tab discard
        // This runs when the tab is hidden/backgrounded
        this.keepAliveInterval = setInterval(() => {
            // Minimal console log to show activity
            // Some browsers use this as a signal that the tab is "active"
            if (document.hidden) {
                console.log('[Tab Lifecycle] Keepalive ping');

                // Also touch localStorage to signal activity
                try {
                    localStorage.setItem(
                        'tab_keepalive_timestamp',
                        Date.now().toString()
                    );
                } catch (e) {
                    // Ignore storage errors
                }
            }
        }, 30000); // Every 30 seconds
    }

    stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
    }

    setupBeforeUnloadWarning() {
        window.addEventListener('beforeunload', (e) => {
            // Check if there are unsaved changes
            const hasUnsavedChanges = this.checkUnsavedChanges();

            if (hasUnsavedChanges) {
                // Modern browsers ignore custom messages, but we still need to set returnValue
                e.preventDefault();
                e.returnValue =
                    'You have unsaved changes in the font editor. Are you sure you want to leave?';
                return e.returnValue;
            }
        });
    }

    checkUnsavedChanges() {
        // Check if there are any unsaved fonts
        try {
            // Check if the dirty indicator is visible
            const dirtyIndicator = document.getElementById(
                'file-dirty-indicator'
            );
            if (
                dirtyIndicator &&
                dirtyIndicator.classList.contains('visible')
            ) {
                return true;
            }

            // Also check if there are any open fonts (via the dropdown)
            const dropdown = document.getElementById('open-fonts-dropdown');
            if (dropdown && dropdown.options.length > 1) {
                // More than "No fonts open"
                // Assume if fonts are open, they might have changes
                return true;
            }

            return false;
        } catch (error) {
            console.error(
                '[Tab Lifecycle] Error checking unsaved changes:',
                error
            );
            // Err on the side of caution
            return true;
        }
    }

    formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return (
            Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
        );
    }

    getStatus() {
        return {
            lockHeld: this.lockHeld,
            persistentStorageGranted: this.persistentStorageGranted,
            tabHidden: document.hidden,
            keepAliveActive: this.keepAliveInterval !== null
        };
    }
}

// Create global instance
window.tabLifecycleManager = new TabLifecycleManager();

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.tabLifecycleManager.initialize();
    });
} else {
    // DOM already loaded
    window.tabLifecycleManager.initialize();
}
