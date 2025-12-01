const CACHE_NAME = 'contxt-font-editor-v4';
const CDN_CACHE_NAME = 'contxt-cdn-cache-v1';
const OFFLINE_URL = '/index.html';

// Cross-Origin Isolation (COI) for SharedArrayBuffer support
let coepCredentialless = false;

// Assets to cache on install
const PRECACHE_ASSETS = [
    '/',
    '/index.html',
    '/manifest.json',

    // CSS
    '/css/style.css',

    // JavaScript files
    '/js/ai-assistant.js',
    '/js/auto-compile-manager.js',
    '/js/bidi-js.js',
    '/js/cache-manager.js',
    '/js/compile-button.js',
    '/js/file-browser.js',
    '/js/font-compilation.js',
    '/js/font-dropdown.js',
    '/js/fontc-compile-worker.js',
    '/js/fontc-worker.js',
    '/js/fonteditor.js',
    '/js/glyph-canvas.js',
    '/js/keyboard-navigation.js',
    '/js/loading-animation.js',
    '/js/matplotlib-handler.js',
    '/js/memory-monitor.js',
    '/js/pyodide-official-console.js',
    '/js/python-execution-wrapper.js',
    '/js/python-ui-sync.js',
    '/js/resizer.js',
    '/js/save-button.js',
    '/js/script-editor.js',
    '/js/settings.js',
    '/js/sound-preloader.js',
    '/js/theme-switcher.js',
    '/js/view-settings.js',

    // Python files
    '/py/fonteditor.py',

    // WASM files (critical for font compilation)
    '/wasm-dist/babelfont_fontc_web.js',
    '/wasm-dist/babelfont_fontc_web_bg.wasm',
    '/wasm-dist/babelfont_fontc_web_bg.wasm.d.ts',
    '/wasm-dist/babelfont_fontc_web.d.ts',
    '/wasm-dist/fontc_web.js',
    '/wasm-dist/fontc_web_bg.wasm',
    '/wasm-dist/fontc_web_bg.wasm.d.ts',
    '/wasm-dist/fontc_web.d.ts',    // Sound assets
    '/assets/sounds/attention.wav',
    '/assets/sounds/done.wav',
    '/assets/sounds/error.wav',
    '/assets/sounds/incoming_message.wav',
    '/assets/sounds/message_sent.wav',

    // Icons
    '/assets/icons/icon-72x72.png',
    '/assets/icons/icon-96x96.png',
    '/assets/icons/icon-128x128.png',
    '/assets/icons/icon-144x144.png',
    '/assets/icons/icon-152x152.png',
    '/assets/icons/icon-192x192.png',
    '/assets/icons/icon-384x384.png',
    '/assets/icons/icon-512x512.png',
    '/assets/icons/icon.svg',

    // Service worker helpers
    '/coi-serviceworker.js'
];

// External CDN resources to cache (large libraries)
const CDN_RESOURCES = [
    // Pyodide (Python runtime) - ~300MB total, cached on demand
    'https://cdn.jsdelivr.net/pyodide/v0.28.3/full/pyodide.js',

    // jQuery and Terminal
    'https://cdn.jsdelivr.net/npm/jquery',
    'https://cdn.jsdelivr.net/npm/jquery.terminal@2.35.2/js/jquery.terminal.min.js',
    'https://cdn.jsdelivr.net/npm/jquery.terminal@2.35.2/js/unix_formatting.min.js',
    'https://cdn.jsdelivr.net/npm/jquery.terminal@2.35.2/css/jquery.terminal.min.css',

    // OpenType.js
    'https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/dist/opentype.min.js',

    // HarfBuzz.js
    'https://cdn.jsdelivr.net/npm/harfbuzzjs@0.4.13/hb.js',
    'https://cdn.jsdelivr.net/npm/harfbuzzjs@0.4.13/hbjs.js',

    // Google Fonts CSS (font files themselves will be cached on demand)
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

// Install event - cache essential assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[Service Worker] Precaching app shell');
            return cache.addAll(PRECACHE_ASSETS.map(url => new Request(url, { cache: 'reload' })));
        }).catch((error) => {
            console.error('[Service Worker] Precaching failed:', error);
        })
    );
    self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME && cacheName !== CDN_CACHE_NAME) {
                        console.log('[Service Worker] Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// Helper function to determine if URL is a CDN resource
function isCDNResource(url) {
    return url.includes('cdn.jsdelivr.net') ||
        url.includes('fonts.googleapis.com') ||
        url.includes('fonts.gstatic.com');
}

// Helper function to add COOP/COEP headers to response
function addCOIHeaders(response) {
    const newHeaders = new Headers(response.headers);
    newHeaders.set("Cross-Origin-Embedder-Policy",
        coepCredentialless ? "credentialless" : "require-corp"
    );
    if (!coepCredentialless) {
        newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
    }
    newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
    });
}

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
    const r = event.request;
    const requestURL = r.url;

    // Skip certain cache modes that cause issues
    if (r.cache === "only-if-cached" && r.mode !== "same-origin") {
        return;
    }

    // Handle CDN resources with stale-while-revalidate strategy
    if (isCDNResource(requestURL)) {
        const request = (coepCredentialless && r.mode === "no-cors")
            ? new Request(r, { credentials: "omit" })
            : r;

        event.respondWith(
            caches.open(CDN_CACHE_NAME).then((cache) => {
                return cache.match(request).then((cachedResponse) => {
                    const fetchPromise = fetch(request).then((networkResponse) => {
                        if (networkResponse.status === 0) {
                            return networkResponse;
                        }

                        // Cache successful responses
                        if (networkResponse && networkResponse.status === 200) {
                            cache.put(request, networkResponse.clone());
                        }
                        return networkResponse;
                    }).catch(() => {
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

    // Handle local resources
    if (!event.request.url.startsWith(self.location.origin)) {
        return;
    }

    const request = (coepCredentialless && r.mode === "no-cors")
        ? new Request(r, { credentials: "omit" })
        : r;

    event.respondWith(
        caches.match(request).then((cachedResponse) => {
            if (cachedResponse) {
                // Add COI headers to cached response
                return addCOIHeaders(cachedResponse);
            }

            return fetch(request).then((response) => {
                if (response.status === 0) {
                    return response;
                }

                // Don't cache non-successful responses
                if (!response || response.status !== 200 || response.type !== 'basic') {
                    return addCOIHeaders(response);
                }

                // Clone the response as it can only be consumed once
                const responseToCache = response.clone();

                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(request, responseToCache);
                });

                // Add COI headers to the response
                return addCOIHeaders(response);
            }).catch((error) => {
                console.log('[Service Worker] Fetch failed, returning offline page:', error);
                // Return offline page for navigation requests
                if (request.mode === 'navigate') {
                    return caches.match(OFFLINE_URL).then((offlineResponse) => {
                        return offlineResponse ? addCOIHeaders(offlineResponse) : null;
                    });
                }
            });
        })
    );
});

// Handle messages from clients
self.addEventListener('message', (event) => {
    if (!event.data) {
        return;
    }

    if (event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    } else if (event.data.type === 'deregister') {
        // Handle COI service worker deregistration
        self.registration
            .unregister()
            .then(() => {
                return self.clients.matchAll();
            })
            .then(clients => {
                clients.forEach((client) => client.navigate(client.url));
            });
    } else if (event.data.type === 'coepCredentialless') {
        coepCredentialless = event.data.value;
    }
});
