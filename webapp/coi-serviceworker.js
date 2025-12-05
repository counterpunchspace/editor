/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
// Enhanced with PWA caching for offline support
let coepCredentialless = false;

// PWA Cache configuration
const CACHE_NAME = 'contxt-pwa-v6';
const CDN_CACHE_NAME = 'contxt-cdn-cache-v6';
const OFFLINE_URL = '/index.html';

// Assets to cache on install
const PRECACHE_ASSETS = [
    './',
    './index.html',
    './manifest.json',

    // CSS
    './css/style.css',

    // JavaScript files
    './js/ai-assistant.js',
    './js/auto-compile-manager.js',
    './js/bidi-js.js',
    './js/cache-manager.js',
    './js/compile-button.js',
    './js/file-browser.js',
    './js/font-compilation.js',
    './js/font-dropdown.js',
    './js/font-manager.js',
    './js/fontc-worker.js',
    './js/fonteditor.js',
    './js/glyph-canvas.js',
    './js/keyboard-navigation.js',
    './js/loading-animation.js',
    './js/matplotlib-handler.js',
    './js/memory-monitor.js',
    './js/pyodide-official-console.js',
    './js/python-execution-wrapper.js',
    './js/python-ui-sync.js',
    './js/resizer.js',
    './js/save-button.js',
    './js/script-editor.js',
    './js/settings.js',
    './js/sound-preloader.js',
    './js/theme-switcher.js',
    './js/view-settings.js',

    // Python files
    './py/fonteditor.py',

    // WASM files (critical for font compilation)
    './wasm-dist/babelfont_fontc_web.js',
    './wasm-dist/babelfont_fontc_web_bg.wasm',
    './wasm-dist/babelfont_fontc_web_bg.wasm.d.ts',
    './wasm-dist/babelfont_fontc_web.d.ts',
    './wasm-dist/fontc_web.js',
    './wasm-dist/fontc_web_bg.wasm',
    './wasm-dist/fontc_web_bg.wasm.d.ts',
    './wasm-dist/fontc_web.d.ts',

    // Sound assets
    './assets/sounds/attention.wav',
    './assets/sounds/done.wav',
    './assets/sounds/error.wav',
    './assets/sounds/incoming_message.wav',
    './assets/sounds/message_sent.wav',

    // Icons
    './assets/icons/icon-72x72.png',
    './assets/icons/icon-96x96.png',
    './assets/icons/icon-128x128.png',
    './assets/icons/icon-144x144.png',
    './assets/icons/icon-152x152.png',
    './assets/icons/icon-192x192.png',
    './assets/icons/icon-384x384.png',
    './assets/icons/icon-512x512.png',
    './assets/icons/icon.svg',

    // Service worker itself
    './coi-serviceworker.js'
];

// CDN resources to precache for offline support
const CDN_PRECACHE = [
    // Critical CDN resources for offline functionality
    'https://cdn.jsdelivr.net/pyodide/v0.28.3/full/pyodide.js',
    'https://cdn.jsdelivr.net/npm/jquery',
    'https://cdn.jsdelivr.net/npm/jquery.terminal@2.35.2/js/jquery.terminal.min.js',
    'https://cdn.jsdelivr.net/npm/jquery.terminal@2.35.2/js/unix_formatting.min.js',
    'https://cdn.jsdelivr.net/npm/jquery.terminal@2.35.2/css/jquery.terminal.min.css',
    'https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/dist/opentype.min.js',
    'https://cdn.jsdelivr.net/npm/harfbuzzjs@0.4.13/hb.js',
    'https://cdn.jsdelivr.net/npm/harfbuzzjs@0.4.13/hbjs.js',
    'https://cdn.jsdelivr.net/npm/ace-builds@1.32.2/src-min-noconflict/ace.js',
    'https://cdn.jsdelivr.net/npm/ace-builds@1.32.2/src-min-noconflict/mode-python.js',
    'https://cdn.jsdelivr.net/npm/ace-builds@1.32.2/src-min-noconflict/theme-monokai.js',
    'https://cdn.jsdelivr.net/npm/diff@5.1.0/dist/diff.min.js',
    'https://cdn.jsdelivr.net/npm/diff2html@3.4.47/bundles/css/diff2html.min.css',
    'https://cdn.jsdelivr.net/npm/diff2html@3.4.47/bundles/js/diff2html-ui.min.js',
    'https://cdn.jsdelivr.net/npm/marked@11.1.1/marked.min.js',

    // Google Fonts CSS
    'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;700&display=swap',
    'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;700&display=swap',
    'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Devanagari:wght@400;700&display=swap',
    'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Hebrew:wght@400;700&display=swap',
    'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;700&display=swap',
    'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;700&display=swap',
    'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+JP:wght@400;700&display=swap',
    'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;1,100;1,200;1,300;1,400;1,500;1,600;1,700&family=IBM+Plex+Sans:ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;1,100;1,200;1,300;1,400;1,500;1,600;1,700&display=swap',
    'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200',
    'https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200'
];

// Helper function to check if URL is a CDN resource
function isCDNResource(url) {
    return (
        url.includes('cdn.jsdelivr.net') ||
        url.includes('fonts.googleapis.com') ||
        url.includes('fonts.gstatic.com')
    );
}

if (typeof window === 'undefined') {
    // Install event - cache essential assets
    self.addEventListener('install', (event) => {
        console.log('[SW] Installing...');
        event.waitUntil(
            // Cache local assets first (critical)
            caches
                .open(CACHE_NAME)
                .then((cache) => {
                    console.log(
                        '[SW] Caching app shell - ' +
                            PRECACHE_ASSETS.length +
                            ' files'
                    );
                    // Cache files individually to see which ones fail
                    return Promise.allSettled(
                        PRECACHE_ASSETS.map((url) =>
                            fetch(new Request(url, { cache: 'reload' }))
                                .then((response) => {
                                    if (response.ok) {
                                        return cache.put(url, response);
                                    } else {
                                        console.error(
                                            '[SW] ✗ Failed to fetch:',
                                            url,
                                            'Status:',
                                            response.status
                                        );
                                    }
                                })
                                .catch((error) => {
                                    console.error(
                                        '[SW] ✗ Error fetching:',
                                        url,
                                        error.message
                                    );
                                })
                        )
                    ).then((results) => {
                        const failed = results.filter(
                            (r) => r.status === 'rejected'
                        ).length;
                        console.log(
                            '[SW] App shell: ' +
                                (PRECACHE_ASSETS.length - failed) +
                                '/' +
                                PRECACHE_ASSETS.length +
                                ' cached'
                        );
                    });
                })
                .then(() => {
                    console.log('[SW] ✅ App shell cached');
                    // Cache CDN resources (non-blocking)
                    return caches.open(CDN_CACHE_NAME).then((cache) => {
                        console.log(
                            '[SW] Caching CDN resources for offline - ' +
                                CDN_PRECACHE.length +
                                ' files'
                        );
                        // Cache each CDN resource individually so one failure doesn't break all
                        return Promise.allSettled(
                            CDN_PRECACHE.map((url) =>
                                fetch(url, { mode: 'cors' })
                                    .then((response) => {
                                        if (response.ok) {
                                            console.log(
                                                '[SW] ✓ Cached:',
                                                url.substring(0, 60)
                                            );
                                            return cache.put(url, response);
                                        } else {
                                            console.warn(
                                                '[SW] ✗ Failed (status ' +
                                                    response.status +
                                                    '):',
                                                url
                                            );
                                        }
                                    })
                                    .catch((error) => {
                                        console.warn(
                                            '[SW] ✗ Failed to cache:',
                                            url.substring(0, 60),
                                            error.message
                                        );
                                    })
                            )
                        );
                    });
                })
                .then(() => {
                    console.log(
                        '[SW] ✅ All resources cached - app ready for offline use'
                    );
                    // Notify all clients that caching is complete
                    self.clients.matchAll().then((clients) => {
                        clients.forEach((client) => {
                            client.postMessage({ type: 'OFFLINE_READY' });
                        });
                    });
                    return self.skipWaiting();
                })
                .catch((error) => {
                    console.error('[SW] ❌ Cache failed:', error);
                    // Still skip waiting even if caching partially failed
                    return self.skipWaiting();
                })
        );
    });

    self.addEventListener('activate', (event) => {
        event.waitUntil(
            caches
                .keys()
                .then((cacheNames) => {
                    return Promise.all(
                        cacheNames.map((cacheName) => {
                            if (
                                cacheName !== CACHE_NAME &&
                                cacheName !== CDN_CACHE_NAME
                            ) {
                                console.log(
                                    '[SW] Deleting old cache:',
                                    cacheName
                                );
                                return caches.delete(cacheName);
                            }
                        })
                    );
                })
                .then(() => self.clients.claim())
        );
    });

    self.addEventListener('message', (ev) => {
        if (!ev.data) {
            return;
        } else if (ev.data.type === 'deregister') {
            self.registration
                .unregister()
                .then(() => {
                    return self.clients.matchAll();
                })
                .then((clients) => {
                    clients.forEach((client) => client.navigate(client.url));
                });
        } else if (ev.data.type === 'coepCredentialless') {
            coepCredentialless = ev.data.value;
        }
    });

    self.addEventListener('fetch', function (event) {
        const r = event.request;
        if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') {
            return;
        }

        const request =
            coepCredentialless && r.mode === 'no-cors'
                ? new Request(r, {
                      credentials: 'omit'
                  })
                : r;

        const requestURL = request.url;

        // Handle CDN resources with stale-while-revalidate strategy
        if (isCDNResource(requestURL)) {
            event.respondWith(
                caches.open(CDN_CACHE_NAME).then((cache) => {
                    return cache.match(request).then((cachedResponse) => {
                        const fetchPromise = fetch(request)
                            .then((response) => {
                                if (response.status === 0) {
                                    return response;
                                }

                                // Cache successful CDN responses
                                if (response && response.status === 200) {
                                    cache.put(request, response.clone());
                                }
                                return response;
                            })
                            .catch(() => {
                                // Network failed, return cached version if available
                                return cachedResponse;
                            });

                        // Return cached response immediately if available, fetch in background
                        return cachedResponse || fetchPromise;
                    });
                })
            );
            return;
        }

        // Handle local resources with COI headers
        event.respondWith(
            // Try cache first
            caches.match(request).then((cachedResponse) => {
                // Fetch from network with COI headers
                const fetchPromise = fetch(request)
                    .then((response) => {
                        if (response.status === 0) {
                            return response;
                        }

                        // Clone the response BEFORE reading the body
                        const responseToCache = response.clone();

                        const newHeaders = new Headers(response.headers);
                        newHeaders.set(
                            'Cross-Origin-Embedder-Policy',
                            coepCredentialless
                                ? 'credentialless'
                                : 'require-corp'
                        );
                        if (!coepCredentialless) {
                            newHeaders.set(
                                'Cross-Origin-Resource-Policy',
                                'cross-origin'
                            );
                        }
                        newHeaders.set(
                            'Cross-Origin-Opener-Policy',
                            'same-origin'
                        );

                        const modifiedResponse = new Response(response.body, {
                            status: response.status,
                            statusText: response.statusText,
                            headers: newHeaders
                        });

                        // Cache successful same-origin responses
                        if (
                            response.status === 200 &&
                            request.url.startsWith(self.location.origin)
                        ) {
                            caches.open(CACHE_NAME).then((cache) => {
                                cache.put(request, responseToCache);
                            });
                        }

                        return modifiedResponse;
                    })
                    .catch((error) => {
                        console.log('[SW] Fetch failed, using cache:', error);
                        // If fetch fails and we have cached version, return it with COI headers
                        if (cachedResponse) {
                            const newHeaders = new Headers(
                                cachedResponse.headers
                            );
                            newHeaders.set(
                                'Cross-Origin-Embedder-Policy',
                                'require-corp'
                            );
                            newHeaders.set(
                                'Cross-Origin-Resource-Policy',
                                'cross-origin'
                            );
                            newHeaders.set(
                                'Cross-Origin-Opener-Policy',
                                'same-origin'
                            );

                            return new Response(cachedResponse.body, {
                                status: cachedResponse.status,
                                statusText: cachedResponse.statusText,
                                headers: newHeaders
                            });
                        }
                        // Return offline page for navigation requests
                        if (request.mode === 'navigate') {
                            return caches
                                .match(OFFLINE_URL)
                                .then((offlineResponse) => {
                                    if (offlineResponse) {
                                        const newHeaders = new Headers(
                                            offlineResponse.headers
                                        );
                                        newHeaders.set(
                                            'Cross-Origin-Embedder-Policy',
                                            'require-corp'
                                        );
                                        newHeaders.set(
                                            'Cross-Origin-Opener-Policy',
                                            'same-origin'
                                        );
                                        return new Response(
                                            offlineResponse.body,
                                            {
                                                status: offlineResponse.status,
                                                statusText:
                                                    offlineResponse.statusText,
                                                headers: newHeaders
                                            }
                                        );
                                    }
                                });
                        }
                        throw error;
                    });

                // If we have cached response, return it with COI headers
                if (cachedResponse) {
                    const newHeaders = new Headers(cachedResponse.headers);
                    newHeaders.set(
                        'Cross-Origin-Embedder-Policy',
                        'require-corp'
                    );
                    newHeaders.set(
                        'Cross-Origin-Resource-Policy',
                        'cross-origin'
                    );
                    newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');

                    return new Response(cachedResponse.body, {
                        status: cachedResponse.status,
                        statusText: cachedResponse.statusText,
                        headers: newHeaders
                    });
                }

                // No cache, return fetch promise
                return fetchPromise;
            })
        );
    });
} else {
    (() => {
        const reloadedBySelf =
            window.sessionStorage.getItem('coiReloadedBySelf');
        window.sessionStorage.removeItem('coiReloadedBySelf');
        const coepDegrading = reloadedBySelf == 'coepdegrade';

        // Check if SharedArrayBuffer is available
        const hasSAB = typeof SharedArrayBuffer !== 'undefined';

        // Detect iOS (all browsers on iOS use WebKit and don't support SharedArrayBuffer)
        const isIOS =
            /iPad|iPhone|iPod/.test(navigator.userAgent) ||
            (navigator.platform === 'MacIntel' &&
                navigator.maxTouchPoints > 1) ||
            /iPad|iPhone|iPod/.test(navigator.platform);

        // If we already reloaded once but still no SAB, something is wrong - don't loop
        if (reloadedBySelf == 'true') {
            if (!hasSAB && !isIOS) {
                console.error(
                    '[COI] Service worker active but SharedArrayBuffer still unavailable. Check browser support.'
                );
            }
            return;
        }

        // If we have a controller but no SAB, reload immediately (page wasn't served through SW)
        // Skip reload on iOS where SAB is not supported
        if (navigator.serviceWorker.controller && !hasSAB && !isIOS) {
            console.log(
                '[COI] Service worker present but page not served through it - reloading...'
            );
            window.sessionStorage.setItem('coiReloadedBySelf', 'true');
            window.location.reload();
            return;
        }

        const coepCredentialless = !coepDegrading && window.credentialless;

        // Calculate scope - ensure it ends with /
        let scope = window.location.pathname.replace(/\/[^\/]*$/, '');
        if (!scope.endsWith('/')) {
            scope += '/';
        }

        navigator.serviceWorker
            .register(window.document.currentScript.src, {
                scope: scope
            })
            .then(
                (registration) => {
                    registration.active?.postMessage({
                        type: 'coepCredentialless',
                        value: coepCredentialless
                    });
                    if (registration.waiting) {
                        registration.waiting.postMessage({
                            type: 'coepCredentialless',
                            value: coepCredentialless
                        });
                    }
                    if (registration.installing) {
                        registration.installing.postMessage({
                            type: 'coepCredentialless',
                            value: coepCredentialless
                        });
                    }

                    // Reload page when service worker is ready (but only once)
                    if (
                        registration.active &&
                        !navigator.serviceWorker.controller
                    ) {
                        window.sessionStorage.setItem(
                            'coiReloadedBySelf',
                            'true'
                        );
                        console.log(
                            '[COI] Service worker registered but not controlling - reloading...'
                        );
                        window.location.reload();
                        return;
                    }

                    // Also handle the case where SW just activated
                    if (registration.installing) {
                        registration.installing.addEventListener(
                            'statechange',
                            (e) => {
                                if (
                                    e.target.state === 'activated' &&
                                    !navigator.serviceWorker.controller
                                ) {
                                    window.sessionStorage.setItem(
                                        'coiReloadedBySelf',
                                        'true'
                                    );
                                    console.log(
                                        '[COI] Service worker activated - reloading to enable control...'
                                    );
                                    window.location.reload();
                                }
                            }
                        );
                    }

                    // If service worker is controlling but SAB still missing, try one reload
                    // Skip on iOS where SAB is not supported
                    if (
                        navigator.serviceWorker.controller &&
                        !hasSAB &&
                        !isIOS
                    ) {
                        console.log(
                            '[COI] Service worker controlling but no SharedArrayBuffer - reloading...'
                        );
                        window.sessionStorage.setItem(
                            'coiReloadedBySelf',
                            'true'
                        );
                        window.location.reload();
                    }
                },
                (err) => {
                    console.error(
                        'COOP/COEP Service Worker failed to register:',
                        err
                    );
                }
            );
    })();
}
