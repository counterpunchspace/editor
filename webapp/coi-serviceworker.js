/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
// Enhanced with PWA caching for offline support
let coepCredentialless = false;

// VERSION and DISPLAY_VERSION are rewritten by release and CI scripts.
const VERSION = 'v0.3';
const DISPLAY_VERSION = 'v0.3';
// Filled in at build time by PrecacheManifestPlugin (webpack.config.js).
const BUILD_ID = '__BUILD_ID__';
const PRECACHE_ASSETS = '__PRECACHE_ASSETS__';
const CDN_PRECACHE = '__CDN_PRECACHE__';

const CACHE_PREFIX = 'counterpunch-';
const APP_CACHE_PREFIX = CACHE_PREFIX + 'pwa-';
const CACHE_NAME = APP_CACHE_PREFIX + VERSION + '-' + BUILD_ID;
// CDN URLs are version-pinned, so their cache survives app updates.
const CDN_CACHE_NAME = CACHE_PREFIX + 'cdn-v1';
// Records which app caches belong to the active and the outgoing build.
const STATE_CACHE_NAME = CACHE_PREFIX + 'sw-state';
const SHELL_URL = './';

function isCDNResource(url) {
    return url.includes('cdn.jsdelivr.net');
}

function applyIsolationHeaders(sourceResponse) {
    const newHeaders = new Headers(sourceResponse.headers);
    newHeaders.set(
        'Cross-Origin-Embedder-Policy',
        coepCredentialless ? 'credentialless' : 'require-corp'
    );
    if (!coepCredentialless) {
        newHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');
    }
    newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
    return new Response(sourceResponse.body, {
        status: sourceResponse.status,
        statusText: sourceResponse.statusText,
        headers: newHeaders
    });
}

function isDocumentPath(pathname) {
    const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
    return (
        lastSegment === '' ||
        lastSegment.endsWith('.html') ||
        !lastSegment.includes('.')
    );
}

// Cloudflare Pages answers unknown paths with index.html and status 200.
function isHtmlFallback(url, response) {
    const contentType = response.headers.get('Content-Type') || '';
    return contentType.includes('text/html') && !isDocumentPath(url.pathname);
}

if (typeof window === 'undefined') {
    const precacheUrls = new Set(
        PRECACHE_ASSETS.map((url) => new URL(url, self.location.href).href)
    );
    const shellUrl = new URL(SHELL_URL, self.location.href).href;

    async function precacheApp() {
        const cache = await caches.open(CACHE_NAME);
        try {
            await Promise.all(
                PRECACHE_ASSETS.map(async (url) => {
                    const response = await fetch(
                        new Request(url, { cache: 'reload' })
                    );
                    const absolute = new URL(url, self.location.href);
                    // Pages redirects /name.html to /name; a redirected
                    // response cannot answer a navigation, so store a copy.
                    const redirectAllowed =
                        isDocumentPath(absolute.pathname) &&
                        new URL(response.url).origin === self.location.origin;
                    if (
                        !response.ok ||
                        (response.redirected && !redirectAllowed) ||
                        isHtmlFallback(absolute, response)
                    ) {
                        throw new Error(
                            url +
                                ' returned ' +
                                response.status +
                                (response.redirected ? ' (redirected)' : '')
                        );
                    }
                    await cache.put(
                        url,
                        response.redirected
                            ? new Response(await response.blob(), {
                                  status: response.status,
                                  statusText: response.statusText,
                                  headers: response.headers
                              })
                            : response
                    );
                })
            );
        } catch (error) {
            await caches.delete(CACHE_NAME);
            throw error;
        }
        console.log(
            '[SW] App shell cached: ' + PRECACHE_ASSETS.length + ' files'
        );
    }

    // Best effort: a third-party CDN outage must not block app updates.
    async function precacheCdn() {
        const cache = await caches.open(CDN_CACHE_NAME);
        await Promise.all(
            CDN_PRECACHE.map(async (url) => {
                if (await cache.match(url)) {
                    return;
                }
                try {
                    const response = await fetch(url, { mode: 'cors' });
                    if (response.ok) {
                        await cache.put(url, response);
                    } else {
                        console.warn(
                            '[SW] CDN precache failed (' +
                                response.status +
                                '):',
                            url
                        );
                    }
                } catch (error) {
                    console.warn(
                        '[SW] CDN precache failed:',
                        url,
                        error.message
                    );
                }
            })
        );
    }

    const stateUrl = new URL('./__sw-state', self.location.href).href;
    let previousCacheName;

    async function readState() {
        const cache = await caches.open(STATE_CACHE_NAME);
        const response = await cache.match(stateUrl);
        return response ? response.json() : null;
    }

    async function writeState(state) {
        const cache = await caches.open(STATE_CACHE_NAME);
        await cache.put(
            stateUrl,
            new Response(JSON.stringify(state), {
                headers: { 'Content-Type': 'application/json' }
            })
        );
    }

    async function previousAppCacheName() {
        if (previousCacheName === undefined) {
            const state = await readState();
            previousCacheName = (state && state.previous) || null;
        }
        return previousCacheName;
    }

    // The build that was active until now. Workers from before the state
    // record existed are recognised by their newest app cache.
    async function outgoingAppCacheName(state) {
        if (state && state.active) {
            return state.active === CACHE_NAME ? state.previous : state.active;
        }
        const names = await caches.keys();
        return names
            .filter(
                (name) =>
                    name.startsWith(APP_CACHE_PREFIX) && name !== CACHE_NAME
            )
            .pop();
    }

    // The new worker waits until a client sends SKIP_WAITING (Preferences →
    // Update) or every tab of the old build has closed.
    self.addEventListener('install', (event) => {
        console.log('[SW] Installing ' + VERSION + ' (' + BUILD_ID + ')');
        event.waitUntil(
            precacheApp()
                .then(precacheCdn)
                .then(() => self.clients.matchAll())
                .then((clients) => {
                    clients.forEach((client) => {
                        client.postMessage({ type: 'OFFLINE_READY' });
                    });
                })
        );
    });

    self.addEventListener('activate', (event) => {
        event.waitUntil(
            (async () => {
                // Keep the outgoing build's cache so tabs still running it
                // can load their own hashed lazy files.
                const previous =
                    (await outgoingAppCacheName(await readState())) || null;
                await writeState({ active: CACHE_NAME, previous });
                previousCacheName = previous;
                const names = await caches.keys();
                await Promise.all(
                    names
                        .filter(
                            (name) =>
                                name.startsWith(CACHE_PREFIX) &&
                                name !== CACHE_NAME &&
                                name !== CDN_CACHE_NAME &&
                                name !== STATE_CACHE_NAME &&
                                name !== previous
                        )
                        .map((name) => {
                            console.log('[SW] Deleting old cache:', name);
                            return caches.delete(name);
                        })
                );
                await self.clients.claim();
                const clients = await self.clients.matchAll({
                    includeUncontrolled: true,
                    type: 'window'
                });
                clients.forEach((client) => {
                    client.postMessage({
                        type: 'SW_UPDATED',
                        cacheName: CACHE_NAME,
                        version: VERSION,
                        displayVersion: DISPLAY_VERSION
                    });
                });
            })()
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
        } else if (ev.data.type === 'SKIP_WAITING') {
            self.skipWaiting();
        } else if (ev.data.type === 'GET_VERSION' && ev.ports[0]) {
            ev.ports[0].postMessage({
                version: VERSION,
                displayVersion: DISPLAY_VERSION
            });
        }
    });

    async function handleCdnRequest(request) {
        const cache = await caches.open(CDN_CACHE_NAME);
        const cached = await cache.match(request);
        if (cached) {
            return cached;
        }
        const response = await fetch(request);
        if (response.status === 200) {
            await cache.put(request, response.clone());
        }
        return response;
    }

    async function handleNavigation(request) {
        const cache = await caches.open(CACHE_NAME);
        const url = new URL(request.url);
        url.search = '';
        url.hash = '';
        const documentUrl = precacheUrls.has(url.href + '.html')
            ? url.href + '.html'
            : url.href;
        const precachedDocument =
            documentUrl !== shellUrl && precacheUrls.has(documentUrl)
                ? await cache.match(documentUrl)
                : undefined;
        const cached = precachedDocument || (await cache.match(shellUrl));
        if (cached) {
            return applyIsolationHeaders(cached);
        }
        return applyIsolationHeaders(await fetch(request));
    }

    async function matchPreviousBuild(url) {
        const previous = await previousAppCacheName();
        if (!previous) {
            return undefined;
        }
        const cache = await caches.open(previous);
        return cache.match(url);
    }

    async function handleAsset(request) {
        const url = new URL(request.url);
        const cache = await caches.open(CACHE_NAME);
        const cacheable = !url.search && !request.headers.has('Range');

        if (cacheable) {
            const cached = await cache.match(url.href);
            if (cached) {
                return applyIsolationHeaders(cached);
            }
        }
        if (cacheable && precacheUrls.has(url.href)) {
            console.warn('[SW] Precached file missing from cache:', url.href);
        }

        let response;
        try {
            // Revalidate instead of trusting the 4 h HTTP cache, which can
            // hold an older build's copy of an unhashed file.
            response = await fetch(
                request.cache === 'default' && request.mode !== 'navigate'
                    ? new Request(request, { cache: 'no-cache' })
                    : request
            );
        } catch (error) {
            const previous = cacheable
                ? await matchPreviousBuild(url.href)
                : undefined;
            if (previous) {
                return applyIsolationHeaders(previous);
            }
            throw error;
        }

        if (response.status === 0) {
            return response;
        }
        if (response.status === 404 || isHtmlFallback(url, response)) {
            const previous = cacheable
                ? await matchPreviousBuild(url.href)
                : undefined;
            if (previous) {
                return applyIsolationHeaders(previous);
            }
            if (isHtmlFallback(url, response)) {
                return new Response('Not found', {
                    status: 404,
                    statusText: 'Not Found'
                });
            }
            return applyIsolationHeaders(response);
        }
        if (cacheable && response.status === 200) {
            await cache.put(url.href, response.clone());
        }
        return applyIsolationHeaders(response);
    }

    self.addEventListener('fetch', function (event) {
        const r = event.request;
        if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') {
            return;
        }
        if (r.method !== 'GET') {
            return;
        }

        const request =
            coepCredentialless && r.mode === 'no-cors'
                ? new Request(r, {
                      credentials: 'omit'
                  })
                : r;

        if (isCDNResource(request.url)) {
            event.respondWith(handleCdnRequest(request));
            return;
        }
        if (new URL(request.url).origin !== self.location.origin) {
            return;
        }
        if (
            request.mode === 'navigate' &&
            isDocumentPath(new URL(request.url).pathname)
        ) {
            event.respondWith(handleNavigation(request));
            return;
        }
        event.respondWith(handleAsset(request));
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

        // The reload exists only to gain cross-origin isolation. Pages
        // sends those headers from _headers, so SharedArrayBuffer is live and a
        // reload is a no-op that, while the browser is offline, becomes
        // Chrome's network error page and drops the open font.
        const reloadForCoiBootstrap = () => {
            if (typeof SharedArrayBuffer !== 'undefined') {
                console.log(
                    '[COI] SharedArrayBuffer already available - skipping reload'
                );
                return;
            }
            if (navigator.onLine === false) {
                console.log('[COI] Browser is offline - skipping reload');
                return;
            }
            window.sessionStorage.setItem('coiReloadedBySelf', 'true');
            window.location.reload();
        };

        console.log('[COI] Registering service worker...');
        navigator.serviceWorker
            .register(window.document.currentScript.src, {
                scope: scope,
                // Bypass the HTTP cache when checking for SW updates so
                // registration.update() (focus + 10-min interval) actually
                // sees a newly deployed coi-serviceworker.js instead of the
                // stale max-age=14400 (4h) cached copy. Without this, focus
                // never detects updates; only a cache-busting reload does.
                updateViaCache: 'none'
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
                        reloadForCoiBootstrap();
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
                                if (e.target.state !== 'activated') {
                                    return;
                                }
                                // A later cache/install (e.g. precache updates)
                                // must not reload a document that already has
                                // isolation. Only the first COI bootstrap
                                // needs a reload, when there is no controller.
                                if (navigator.serviceWorker.controller) {
                                    console.log(
                                        '[COI] Service worker activated while already controlling - skipping reload'
                                    );
                                    return;
                                }
                                if (
                                    !window.sessionStorage.getItem(
                                        'coiReloadedBySelf'
                                    )
                                ) {
                                    console.log(
                                        '[COI] Service worker activated - reloading...'
                                    );
                                    reloadForCoiBootstrap();
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
