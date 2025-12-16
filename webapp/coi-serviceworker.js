/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
// Enhanced with PWA caching for offline support
let coepCredentialless = false;

// PWA Cache configuration
const VERSION = 'v0.1.2-p.3';
const CACHE_NAME = 'contxt-pwa-' + VERSION;
const CDN_CACHE_NAME = 'contxt-cdn-cache-' + VERSION;
const OFFLINE_URL = '/index.html';

// Assets to cache on install
const PRECACHE_ASSETS = [
    './',
    './index.html',
    './manifest.json',

    // CSS
    './css/style.css',

    // JavaScript bundles (webpack output)
    './js/bootstrap.js',
    './js/fontc-worker.js',
    './js/node_modules_idb-keyval_dist_index_js.js',

    // Python files
    './py/fonteditor.py',
    './py/generate_api_docs.py',

    // WASM files (critical for font compilation)
    './wasm-dist/babelfont_fontc_web.js',
    './wasm-dist/babelfont_fontc_web_bg.wasm',
    './wasm-dist/babelfont_fontc_web_bg.wasm.d.ts',
    './wasm-dist/babelfont_fontc_web.d.ts',

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
        console.log('[ServiceWorker]', '[SW] Installing...');
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
                    console.log('[ServiceWorker]', '[SW] ✅ App shell cached');
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
                    console.error(
                        '[ServiceWorker]',
                        '[SW] ❌ Cache failed:',
                        error
                    );
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
                .then(() => {
                    // Notify all clients that a new version is available
                    console.log('[SW] 🔄 Notifying clients of update');
                    return self.clients.matchAll().then((clients) => {
                        clients.forEach((client) => {
                            client.postMessage({
                                type: 'SW_UPDATED',
                                cacheName: CACHE_NAME,
                                version: VERSION
                            });
                        });
                    });
                })
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
                        console.log(
                            '[ServiceWorker]',
                            '[SW] Fetch failed, using cache:',
                            error
                        );
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
        const coepDegrading = reloadedBySelf == 'coepdegrade';

        console.log(
            '[COI] Script executing, reloadedBySelf flag:',
            reloadedBySelf
        );

        // Check if SharedArrayBuffer is available
        const hasSAB = typeof SharedArrayBuffer !== 'undefined';

        console.log('[COI] SharedArrayBuffer available:', hasSAB);
        console.log(
            '[COI] Service worker controller:',
            navigator.serviceWorker.controller ? 'Active' : 'None'
        );

        // If already reloaded once but still no SAB, clear flag and try again
        if (reloadedBySelf == 'true' && !hasSAB) {
            console.warn(
                '[COI] Previously reloaded but SharedArrayBuffer still unavailable. Clearing flag to retry.'
            );
            window.sessionStorage.removeItem('coiReloadedBySelf');
            // Don't return - continue to register SW
        } else if (reloadedBySelf == 'true' && hasSAB) {
            // Already reloaded and working - nothing to do
            console.log(
                '[COI] ✅ Service worker active, SharedArrayBuffer available'
            );
            return;
        }

        const coepCredentialless = !coepDegrading && window.credentialless;

        // Calculate scope - ensure it ends with /
        let scope = window.location.pathname.replace(/\/[^\/]*$/, '');
        if (!scope.endsWith('/')) {
            scope += '/';
        }

        console.log('[COI] Registering service worker...');
        navigator.serviceWorker
            .register(window.document.currentScript.src, {
                scope: scope
            })
            .then(
                (registration) => {
                    console.log('[COI] Service worker registered successfully');
                    console.log(
                        '[COI] - Active:',
                        registration.active ? 'Yes' : 'No'
                    );
                    console.log(
                        '[COI] - Installing:',
                        registration.installing ? 'Yes' : 'No'
                    );
                    console.log(
                        '[COI] - Waiting:',
                        registration.waiting ? 'Yes' : 'No'
                    );
                    console.log(
                        '[COI] - Controller:',
                        navigator.serviceWorker.controller ? 'Yes' : 'No'
                    );

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

                    // Reload page when service worker is ready
                    // Case 1: SW already active but not controlling yet
                    if (
                        registration.active &&
                        !navigator.serviceWorker.controller
                    ) {
                        console.log(
                            '[COI] Service worker active but not controlling - reloading...'
                        );
                        window.sessionStorage.setItem(
                            'coiReloadedBySelf',
                            'true'
                        );
                        window.location.reload();
                        return;
                    }

                    // Case 2: SW is still installing - wait for activation
                    if (registration.installing) {
                        console.log(
                            '[COI] Service worker installing - waiting for activation...'
                        );
                        registration.installing.addEventListener(
                            'statechange',
                            function stateChangeListener(e) {
                                console.log(
                                    '[COI] Service worker state changed to:',
                                    e.target.state
                                );
                                if (e.target.state === 'activated') {
                                    // Check flag again - might have been set by another listener
                                    if (
                                        !window.sessionStorage.getItem(
                                            'coiReloadedBySelf'
                                        )
                                    ) {
                                        console.log(
                                            '[COI] Service worker activated - reloading...'
                                        );
                                        window.sessionStorage.setItem(
                                            'coiReloadedBySelf',
                                            'true'
                                        );
                                        window.location.reload();
                                    }
                                }
                            }
                        );
                    }
                },
                (err) => {
                    console.error(
                        '[COI] ❌ Service Worker registration failed:',
                        err
                    );
                    // Clear flag so user can try again
                    window.sessionStorage.removeItem('coiReloadedBySelf');
                }
            );
    })();
}
