/**
 * PWA update state and Preferences version UI.
 *
 * A new service worker installs in the background and then waits. The
 * Update button appears only once it is installed; clicking it sends
 * SKIP_WAITING and reloads on controllerchange. The inline script in
 * index.html also sets window.__pendingUpdate when another tab activated a
 * newer worker, so this tab offers a reload. Published service-worker and
 * GitHub versions only drive the "Downloading" and status text.
 */

import { Logger } from './logger';

const console = new Logger('UpdateManager');

const CHANGELOG_RELEASES_URL =
    'https://github.com/counterpunchspace/editor/releases/tag';

export const AUTO_CHECK_THROTTLE_MS = 60 * 1000;
export const AUTO_CHECK_INTERVAL_MS = 10 * 60 * 1000;
export const FOCUS_POLL_MS = 1000;
const APPLY_UPDATE_TIMEOUT_MS = 10 * 1000;
const WORKER_VERSION_TIMEOUT_MS = 2000;

let lastAutoCheckAt = 0;
let checkInFlight = false;
let scheduledChecksInitialized = false;
let preferencesUiInitialized = false;
let forceUpdateOffered = false;
let forceReinstallInFlight = false;
let updateDownloading = false;
let applyUpdateInFlight = false;
const trackedInstallingWorkers = new WeakSet<ServiceWorker>();

export type UpdateReadiness = 'ready' | 'downloading' | 'none';

const DOWNLOADING_STATUS = 'Downloading update…';

export const UPDATE_QUERY = 'update';
const UPDATE_RELOAD_MARKER = /^\d{13}$/;

export type PendingUpdate = {
    version: string;
    tag?: string;
    isPreview: boolean;
};

export type SwVersionInfo = {
    tag: string;
    displayVersion: string;
    isPreview: boolean;
};

export type GitHubRelease = {
    tag_name?: string;
    name?: string;
    prerelease?: boolean;
    draft?: boolean;
};

export function getPendingUpdate(): PendingUpdate | null {
    return window.__pendingUpdate ?? null;
}

export function clearPendingUpdate(): void {
    window.__pendingUpdate = null;
}

const VERSION_ASSIGN_RE = /\bVERSION\s*=\s*['"](v[^'"]+)['"]/;
const DISPLAY_VERSION_ASSIGN_RE = /\bDISPLAY_VERSION\s*=\s*['"]([^'"]+)['"]/;
const GITHUB_RELEASES_URL =
    'https://api.github.com/repos/counterpunchspace/editor/releases?per_page=15';

export function isPreviewReleaseId(
    tag: string,
    displayVersion: string = tag
): boolean {
    return (
        /preview|-pre\./.test(tag) ||
        /preview|-pre\./.test(displayVersion) ||
        /^\d+-build-\d+$/.test(displayVersion)
    );
}

export function parseSwVersions(text: string): SwVersionInfo | null {
    const versionMatch = text.match(VERSION_ASSIGN_RE);
    if (!versionMatch?.[1]) {
        return null;
    }
    const displayMatch = text.match(DISPLAY_VERSION_ASSIGN_RE);
    const tag = versionMatch[1];
    const displayVersion = displayMatch?.[1] || tag;
    return {
        tag,
        displayVersion,
        isPreview: isPreviewReleaseId(tag, displayVersion)
    };
}

/**
 * Only an installed, waiting worker can be applied. A newer published
 * version without one is still downloading (or not deployed yet), and
 * reloading then would serve the old build from cache again.
 */
export function updateReadiness(state: {
    hasWaitingWorker: boolean;
    hasInstallingWorker: boolean;
    publishedIsNewer: boolean;
}): UpdateReadiness {
    if (state.hasWaitingWorker) {
        return 'ready';
    }
    if (state.hasInstallingWorker || state.publishedIsNewer) {
        return 'downloading';
    }
    return 'none';
}

export function shouldShowForceUpdate(
    pending: PendingUpdate | null,
    offeredAfterManualCheck: boolean
): boolean {
    return !pending && offeredAfterManualCheck;
}

/**
 * `?update` (any value except a 13-digit reload marker) starts a force
 * reinstall. After caches are cleared the page reloads with
 * `?update=<Date.now()>`; that marker is stripped and must not reinstall.
 */
export function shouldForceReinstallFromUrl(
    search: string = typeof window !== 'undefined' ? window.location.search : ''
): boolean {
    const params = new URLSearchParams(
        search.startsWith('?') ? search.slice(1) : search
    );
    if (!params.has(UPDATE_QUERY)) {
        return false;
    }
    const value = params.get(UPDATE_QUERY) || '';
    return !UPDATE_RELOAD_MARKER.test(value);
}

export function isAppWindowActive(
    visibilityState: string = document.visibilityState,
    hasFocus: boolean = document.hasFocus()
): boolean {
    return visibilityState === 'visible' && hasFocus;
}

export function didAppWindowBecomeActive(
    wasActive: boolean,
    isActive: boolean
): boolean {
    return isActive && !wasActive;
}

export function hasAvailableUpdate(
    published: SwVersionInfo,
    runningDisplayVersion: string | null,
    runningTag: string | null = null
): boolean {
    const runningIds = [runningDisplayVersion, runningTag].filter(
        (value): value is string => !!value && value !== 'Unknown'
    );
    if (runningIds.length === 0) {
        return false;
    }
    return !runningIds.some(
        (id) => id === published.displayVersion || id === published.tag
    );
}

export function changelogUrlForUpdate(pending: PendingUpdate): string {
    const releaseTag = pending.tag || pending.version;
    return `${CHANGELOG_RELEASES_URL}/${releaseTag}`;
}

export function pendingUpdateFromSw(info: SwVersionInfo): PendingUpdate {
    return {
        version: info.displayVersion,
        tag: info.tag,
        isPreview: info.isPreview
    };
}

function getRunningDisplayVersion(): string {
    if (window.EDITOR_VERSION) {
        return window.EDITOR_VERSION;
    }
    const versionSpan = document.getElementById('app-version');
    const displayVersion = versionSpan?.dataset.displayVersion;
    if (displayVersion) {
        return displayVersion;
    }
    return versionSpan?.dataset.version || 'Unknown';
}

function getRunningTag(): string | null {
    const running = window.EDITOR_VERSION;
    if (running?.startsWith('v')) {
        return running;
    }
    return null;
}

function setPendingUpdate(pending: PendingUpdate): void {
    window.__pendingUpdate = pending;
    document.dispatchEvent(
        new CustomEvent('counterpunch:update-available', {
            detail: pending
        })
    );
}

function setHidden(element: HTMLElement | null, hidden: boolean): void {
    if (!element) {
        return;
    }
    element.hidden = hidden;
}

function refreshPreferencesVersionUi(): void {
    const versionEl = document.getElementById('settings-current-version');
    if (versionEl) {
        versionEl.textContent = getRunningDisplayVersion();
    }

    const pending = getPendingUpdate();
    const availableRow = document.getElementById('settings-update-available');
    const availableLabel = document.getElementById(
        'settings-update-available-label'
    );
    const changelogLink = document.getElementById(
        'settings-changelog-link'
    ) as HTMLAnchorElement | null;
    const checkBtn = document.getElementById(
        'settings-check-updates-btn'
    ) as HTMLButtonElement | null;
    const updateBtn = document.getElementById(
        'settings-apply-update-btn'
    ) as HTMLButtonElement | null;
    const forceBtn = document.getElementById(
        'settings-force-update-btn'
    ) as HTMLButtonElement | null;

    if (pending) {
        if (availableLabel) {
            availableLabel.textContent = `Update available: ${pending.version}`;
        }
        if (changelogLink) {
            changelogLink.href = changelogUrlForUpdate(pending);
        }
        setHidden(availableRow, false);
        setHidden(checkBtn, true);
        setHidden(updateBtn, false);
        setHidden(forceBtn, true);
    } else {
        setHidden(availableRow, true);
        setHidden(checkBtn, false);
        setHidden(updateBtn, true);
        setHidden(
            forceBtn,
            updateDownloading ||
                !shouldShowForceUpdate(pending, forceUpdateOffered)
        );
        const statusEl = document.getElementById('settings-update-status');
        if (statusEl && updateDownloading) {
            statusEl.textContent = DOWNLOADING_STATUS;
        }
    }
    if (updateBtn) {
        updateBtn.disabled = applyUpdateInFlight;
    }

    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) {
        settingsBtn.classList.toggle('has-update', !!pending);
    }
}

async function fetchPublishedSwVersion(): Promise<SwVersionInfo | null> {
    const response = await fetch(`coi-serviceworker.js?t=${Date.now()}`, {
        cache: 'no-store'
    });
    if (!response.ok) {
        throw new Error(`Could not fetch service worker (${response.status})`);
    }
    return parseSwVersions(await response.text());
}

function askWorkerVersion(
    worker: ServiceWorker
): Promise<SwVersionInfo | null> {
    return new Promise((resolve) => {
        const channel = new MessageChannel();
        const timeoutId = window.setTimeout(
            () => resolve(null),
            WORKER_VERSION_TIMEOUT_MS
        );
        channel.port1.onmessage = (event: MessageEvent) => {
            window.clearTimeout(timeoutId);
            const data: unknown = event.data;
            if (
                data &&
                typeof data === 'object' &&
                'version' in data &&
                typeof data.version === 'string'
            ) {
                const displayVersion =
                    'displayVersion' in data &&
                    typeof data.displayVersion === 'string'
                        ? data.displayVersion
                        : data.version;
                resolve({
                    tag: data.version,
                    displayVersion,
                    isPreview: isPreviewReleaseId(data.version, displayVersion)
                });
                return;
            }
            resolve(null);
        };
        worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
    });
}

function setUpdateDownloading(downloading: boolean): void {
    if (updateDownloading === downloading) {
        return;
    }
    updateDownloading = downloading;
    const statusEl = document.getElementById('settings-update-status');
    if (!downloading && statusEl?.textContent === DOWNLOADING_STATUS) {
        statusEl.textContent = '';
    }
    refreshPreferencesVersionUi();
}

async function markUpdateReady(worker: ServiceWorker): Promise<void> {
    setUpdateDownloading(false);
    const info =
        (await askWorkerVersion(worker)) ??
        (await fetchPublishedSwVersion().catch(() => null));
    setPendingUpdate(
        info
            ? pendingUpdateFromSw(info)
            : { version: 'new version', isPreview: prefersPreviewReleases() }
    );
}

function trackInstallingWorker(
    registration: ServiceWorkerRegistration,
    worker: ServiceWorker
): void {
    // The very first install has no controller to replace.
    if (!navigator.serviceWorker.controller) {
        return;
    }
    if (trackedInstallingWorkers.has(worker)) {
        return;
    }
    trackedInstallingWorkers.add(worker);
    setUpdateDownloading(true);
    worker.addEventListener('statechange', () => {
        if (worker.state === 'installed') {
            void markUpdateReady(registration.waiting ?? worker);
        } else if (worker.state === 'redundant') {
            setUpdateDownloading(!!registration.installing);
        }
    });
}

async function watchServiceWorkerRegistration(): Promise<void> {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) {
        return;
    }
    registration.addEventListener('updatefound', () => {
        if (registration.installing) {
            trackInstallingWorker(registration, registration.installing);
        }
    });
    if (registration.waiting && navigator.serviceWorker.controller) {
        await markUpdateReady(registration.waiting);
    } else if (registration.installing) {
        trackInstallingWorker(registration, registration.installing);
    }
}

function prefersPreviewReleases(): boolean {
    return window.location.hostname.includes('preview');
}

async function fetchPublishedGitHubVersion(): Promise<SwVersionInfo | null> {
    const response = await fetch(GITHUB_RELEASES_URL, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`Could not fetch GitHub releases (${response.status})`);
    }
    return pickLatestGitHubRelease(
        (await response.json()) as GitHubRelease[],
        prefersPreviewReleases()
    );
}

export function pickLatestGitHubRelease(
    releases: GitHubRelease[],
    preview: boolean
): SwVersionInfo | null {
    const release = releases.find((item) => {
        if (!item.tag_name || item.draft) {
            return false;
        }
        return preview ? !!item.prerelease : !item.prerelease;
    });
    if (!release?.tag_name) {
        return null;
    }
    const displayVersion = release.tag_name;
    return {
        tag: release.tag_name,
        displayVersion,
        isPreview:
            !!release.prerelease ||
            isPreviewReleaseId(release.tag_name, displayVersion)
    };
}

async function resolvePublishedVersion(): Promise<SwVersionInfo | null> {
    const runningDisplay = getRunningDisplayVersion();
    const runningTag = getRunningTag();
    const [fromSw, fromGitHub] = await Promise.all([
        fetchPublishedSwVersion().catch((error) => {
            console.warn(
                'Published service worker lookup failed:',
                error instanceof Error ? error.message : String(error)
            );
            return null;
        }),
        fetchPublishedGitHubVersion().catch((error) => {
            console.warn(
                'GitHub releases lookup failed:',
                error instanceof Error ? error.message : String(error)
            );
            return null;
        })
    ]);
    if (fromSw && hasAvailableUpdate(fromSw, runningDisplay, runningTag)) {
        return fromSw;
    }
    if (
        fromGitHub &&
        hasAvailableUpdate(fromGitHub, runningDisplay, runningTag)
    ) {
        return fromGitHub;
    }
    return fromSw || fromGitHub;
}

export function isAutoCheckThrottled(
    lastCheckAt: number,
    now: number = Date.now()
): boolean {
    return lastCheckAt > 0 && now - lastCheckAt < AUTO_CHECK_THROTTLE_MS;
}

function shouldSkipScheduledChecks(): boolean {
    if (typeof window === 'undefined') {
        return true;
    }
    if (window.isTestMode?.() || window.isDevelopment?.()) {
        return true;
    }
    return !navigator.serviceWorker;
}

function isDevBuild(displayVersion: string): boolean {
    return displayVersion.endsWith('-dev');
}

async function checkForUpdates(userInitiated = false): Promise<void> {
    if (checkInFlight && !userInitiated) {
        return;
    }
    checkInFlight = true;
    lastAutoCheckAt = Date.now();

    const statusEl = document.getElementById('settings-update-status');
    const checkBtn = document.getElementById(
        'settings-check-updates-btn'
    ) as HTMLButtonElement | null;
    const forceBtn = document.getElementById(
        'settings-force-update-btn'
    ) as HTMLButtonElement | null;
    if (userInitiated && statusEl) {
        statusEl.textContent = 'Checking for updates…';
    }
    if (userInitiated && checkBtn) {
        checkBtn.disabled = true;
    }
    if (userInitiated && forceBtn) {
        forceBtn.disabled = true;
    }

    try {
        const registration = navigator.serviceWorker
            ? await navigator.serviceWorker.getRegistration()
            : undefined;
        const updatePromise = (
            registration?.update() ?? Promise.resolve()
        ).catch((error) => {
            console.warn(
                'Service worker update() failed:',
                error instanceof Error ? error.message : String(error)
            );
        });
        const publishedPromise = resolvePublishedVersion();
        await Promise.race([
            updatePromise,
            new Promise<void>((resolve) => {
                window.setTimeout(resolve, 8000);
            })
        ]);
        const published = await publishedPromise;
        const runningDisplay = getRunningDisplayVersion();
        const runningTag = getRunningTag();
        const readiness = updateReadiness({
            hasWaitingWorker:
                !!registration?.waiting &&
                !!navigator.serviceWorker?.controller,
            hasInstallingWorker: !!registration?.installing,
            publishedIsNewer:
                !!published &&
                !isDevBuild(runningDisplay) &&
                hasAvailableUpdate(published, runningDisplay, runningTag)
        });

        if (readiness === 'ready' && registration?.waiting) {
            if (statusEl) {
                statusEl.textContent = '';
            }
            await markUpdateReady(registration.waiting);
            return;
        }

        if (readiness === 'downloading') {
            if (registration?.installing) {
                trackInstallingWorker(registration, registration.installing);
            } else if (userInitiated && statusEl && published) {
                statusEl.textContent = `${published.displayVersion} is being published. Check again in a few minutes.`;
            }
            return;
        }

        if (userInitiated && statusEl) {
            statusEl.textContent = getPendingUpdate()
                ? ''
                : 'You’re up to date.';
        }
        if (userInitiated && !getPendingUpdate()) {
            forceUpdateOffered = true;
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('Update check failed:', message);
        if (userInitiated && statusEl) {
            statusEl.textContent = 'Could not check for updates.';
        }
        if (userInitiated) {
            forceUpdateOffered = true;
        }
    } finally {
        checkInFlight = false;
        if (checkBtn) {
            checkBtn.disabled = false;
        }
        const forceBtn = document.getElementById(
            'settings-force-update-btn'
        ) as HTMLButtonElement | null;
        if (forceBtn) {
            forceBtn.disabled = forceReinstallInFlight;
        }
        refreshPreferencesVersionUi();
    }
}

function runScheduledUpdateCheck(bypassThrottle: boolean): void {
    if (checkInFlight) {
        return;
    }
    if (!bypassThrottle && isAutoCheckThrottled(lastAutoCheckAt)) {
        return;
    }
    void checkForUpdates(false);
}

function initScheduledUpdateChecks(): void {
    if (scheduledChecksInitialized || shouldSkipScheduledChecks()) {
        return;
    }
    scheduledChecksInitialized = true;

    void watchServiceWorkerRegistration().catch((error) => {
        console.warn(
            'Service worker registration watch failed:',
            error instanceof Error ? error.message : String(error)
        );
    });
    runScheduledUpdateCheck(false);

    // macOS and installed PWAs often skip window `focus` / visibilitychange on
    // Cmd+Tab. document.hasFocus() is the reliable signal (same as glyph-canvas);
    // poll so a missed event still produces an inactive → active edge.
    let appWindowWasActive = isAppWindowActive();
    const syncAppWindowAndCheck = () => {
        const active = isAppWindowActive();
        if (didAppWindowBecomeActive(appWindowWasActive, active)) {
            appWindowWasActive = active;
            runScheduledUpdateCheck(false);
            return;
        }
        appWindowWasActive = active;
    };

    window.addEventListener('focus', syncAppWindowAndCheck);
    window.addEventListener('blur', syncAppWindowAndCheck);
    window.addEventListener('pageshow', syncAppWindowAndCheck);
    window.addEventListener('pagehide', syncAppWindowAndCheck);
    document.addEventListener('visibilitychange', syncAppWindowAndCheck);
    document.addEventListener('freeze', syncAppWindowAndCheck);
    document.addEventListener('resume', syncAppWindowAndCheck);
    window.setInterval(syncAppWindowAndCheck, FOCUS_POLL_MS);

    window.setInterval(() => {
        runScheduledUpdateCheck(true);
    }, AUTO_CHECK_INTERVAL_MS);
}

async function applyPendingUpdate(): Promise<void> {
    const reload = () => {
        window.location.reload();
    };
    if (applyUpdateInFlight) {
        return;
    }
    const registration = navigator.serviceWorker
        ? await navigator.serviceWorker.getRegistration()
        : undefined;
    const waiting = registration?.waiting;
    // No waiting worker: another tab already activated the new build and
    // this tab is controlled by it, so a reload loads it.
    if (!waiting) {
        reload();
        return;
    }

    applyUpdateInFlight = true;
    refreshPreferencesVersionUi();
    const statusEl = document.getElementById('settings-update-status');
    if (statusEl) {
        statusEl.textContent = 'Updating…';
    }
    const previousController = navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', reload, {
        once: true
    });
    waiting.postMessage({ type: 'SKIP_WAITING' });
    window.setTimeout(() => {
        if (navigator.serviceWorker.controller !== previousController) {
            reload();
            return;
        }
        applyUpdateInFlight = false;
        if (statusEl) {
            statusEl.textContent =
                'The update has not activated yet. Try again in a moment.';
        }
        refreshPreferencesVersionUi();
    }, APPLY_UPDATE_TIMEOUT_MS);
}

function stripUpdateQuery(): void {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(UPDATE_QUERY)) {
        return;
    }
    url.searchParams.delete(UPDATE_QUERY);
    window.history.replaceState(window.history.state, '', url.toString());
}

/**
 * Drop the service worker and Cache Storage, then reload from the network.
 * Used when version comparison reports no update but the running shell may
 * still be a stale cached build.
 */
async function forceReinstallFromNetwork(): Promise<void> {
    if (forceReinstallInFlight) {
        return;
    }
    forceReinstallInFlight = true;

    const statusEl = document.getElementById('settings-update-status');
    const checkBtn = document.getElementById(
        'settings-check-updates-btn'
    ) as HTMLButtonElement | null;
    const forceBtn = document.getElementById(
        'settings-force-update-btn'
    ) as HTMLButtonElement | null;
    if (statusEl) {
        statusEl.textContent = 'Reinstalling from the network…';
    }
    if (checkBtn) {
        checkBtn.disabled = true;
    }
    if (forceBtn) {
        forceBtn.disabled = true;
    }

    try {
        if ('caches' in window) {
            const cacheNames = await caches.keys();
            await Promise.all(cacheNames.map((name) => caches.delete(name)));
        }
        if (navigator.serviceWorker) {
            const registration =
                await navigator.serviceWorker.getRegistration();
            if (registration?.waiting) {
                registration.waiting.postMessage({ type: 'SKIP_WAITING' });
            }
            await registration?.unregister();
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('Force update failed:', message);
    }

    const url = new URL(window.location.href);
    url.searchParams.set(UPDATE_QUERY, String(Date.now()));
    window.location.replace(url.toString());
}

export function initPreferencesVersionUi(): void {
    const skipUrlReinstall = !!window.isTestMode?.();
    if (!skipUrlReinstall && shouldForceReinstallFromUrl()) {
        void forceReinstallFromNetwork();
    } else {
        stripUpdateQuery();
    }
    refreshPreferencesVersionUi();
    initScheduledUpdateChecks();

    if (preferencesUiInitialized) {
        return;
    }
    preferencesUiInitialized = true;

    document
        .getElementById('settings-check-updates-btn')
        ?.addEventListener('click', () => {
            void checkForUpdates(true);
        });
    document
        .getElementById('settings-apply-update-btn')
        ?.addEventListener('click', () => {
            void applyPendingUpdate();
        });
    document
        .getElementById('settings-force-update-btn')
        ?.addEventListener('click', () => {
            void forceReinstallFromNetwork();
        });

    document.addEventListener('counterpunch:update-available', () => {
        const statusEl = document.getElementById('settings-update-status');
        if (statusEl && getPendingUpdate()) {
            statusEl.textContent = '';
        }
        refreshPreferencesVersionUi();
    });
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPreferencesVersionUi);
    } else {
        initPreferencesVersionUi();
    }
}
