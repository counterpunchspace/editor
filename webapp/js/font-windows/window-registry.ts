// Links the launcher and every font window to each other.
//
// Windows opened from each other with window.open (same origin) share one
// agent cluster: they can hold references to each other's `window` and read
// each other's objects synchronously. Each window keeps name → WindowProxy for
// every other Counterpunch window and hands that map to windows it opens.
//
// - A new window adopts its opener's peers and registers itself with them.
// - A reloaded window keeps its name and WindowProxy, so the others hand it
//   their references again when it says hello on the BroadcastChannel.
// - Windows opened some other way (the file manager, a typed URL) can't be
//   reached; they appear through the BroadcastChannel as "unlinked".
//
// Same-font view windows (Window → Open In New Window, `?linked=`) are not
// part of this: they belong to their font's main window.
//
// Only windows of the same build link. After an update, a window that still
// runs the old version is treated like an unreachable one until it reloads,
// so no code calls into a window of another version.

import { Logger } from '../logger';
import { APP_BUILD } from '../app-update';

const console = new Logger('FontWindows');

export const LAUNCHER_WINDOW_NAME = 'cp-launcher';
const FONT_WINDOW_PREFIX = 'cp-font:';
const CHANNEL_NAME = 'counterpunch-windows';
const WINDOWS_LOCK = 'counterpunch-windows';

export type CounterpunchWindowRole = 'launcher' | 'font';

/** What a window says about itself on the BroadcastChannel. */
export type WindowAnnouncement = {
    name: string;
    instance: string;
    role: CounterpunchWindowRole | null;
    documentKey: string | null;
    title: string;
    /** The window's build (`APP_BUILD`). */
    build: string;
};

type ChannelMessage = WindowAnnouncement & {
    type: 'hello' | 'here' | 'changed' | 'bye';
};

/** The part of a window other Counterpunch windows call into. */
export type CounterpunchWindowApi = {
    instance: string;
    build: string;
    role: CounterpunchWindowRole | null;
    documentKey: string | null;
    peers: Map<string, Window>;
    register(win: Window): void;
    peerChanged(): void;
    peerLeaving(): void;
};

export const fontWindowName = (documentKey: string) =>
    `${FONT_WINDOW_PREFIX}${documentKey}`;

export const documentKeyOfWindowName = (name: string): string | null =>
    name.startsWith(FONT_WINDOW_PREFIX)
        ? name.slice(FONT_WINDOW_PREFIX.length)
        : null;

const isCounterpunchWindowName = (name: string) =>
    name === LAUNCHER_WINDOW_NAME || name.startsWith(FONT_WINDOW_PREFIX);

const peers = new Map<string, Window>();
const unlinked = new Map<string, WindowAnnouncement>();
const listeners = new Set<() => void>();
const channel = new BroadcastChannel(CHANNEL_NAME);

const api: CounterpunchWindowApi = {
    // Names repeat across unrelated groups of windows (two launchers are both
    // "cp-launcher"), so each page load also carries its own id.
    instance: crypto.randomUUID(),
    build: APP_BUILD,
    role: null,
    documentKey: null,
    peers,
    register: (win) => adopt(win),
    peerChanged: () => {
        prune();
        emitChange();
    },
    peerLeaving: () => {
        // Let a reload finish: the same window then says hello again.
        setTimeout(() => api.peerChanged(), 300);
    }
};
window.counterpunchWindows = api;

function apiOf(win: Window | null | undefined): CounterpunchWindowApi | null {
    try {
        return win?.counterpunchWindows ?? null;
    } catch {
        return null; // closed, navigated away, or not reachable
    }
}

/** True while `win` is open and still the window `name` refers to. */
export function isAlive(win: Window | undefined, name: string): boolean {
    try {
        return !!win && !win.closed && win.name === name;
    } catch {
        return false;
    }
}

export function onWindowsChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

let changeScheduled = false;
function emitChange(): void {
    if (changeScheduled) return;
    changeScheduled = true;
    setTimeout(() => {
        changeScheduled = false;
        for (const listener of listeners) {
            try {
                listener();
            } catch (error) {
                console.error('Window change listener failed', error);
            }
        }
    }, 0);
}

/** Whether `win` runs this build. A window still loading counts as yes. */
function sameBuild(win: Window): boolean {
    const theirs = apiOf(win);
    return !theirs || theirs.build === api.build;
}

/** Keep a window of another version as unreachable, not as a peer. */
function setAside(name: string, win: Window): void {
    const theirs = apiOf(win);
    if (!theirs) return;
    let title = '';
    try {
        title = win.document.title;
    } catch {
        // Not readable; the title is only informational.
    }
    unlinked.set(name, {
        name,
        instance: theirs.instance,
        role: theirs.role,
        documentKey: theirs.documentKey,
        title,
        build: theirs.build
    });
}

function prune(): void {
    let changed = false;
    for (const [name, win] of peers) {
        if (!isAlive(win, name)) {
            peers.delete(name);
            changed = true;
        } else if (!sameBuild(win)) {
            peers.delete(name);
            setAside(name, win);
            changed = true;
        }
    }
    if (changed) emitChange();
}

function add(name: string, win: Window): boolean {
    if (!isCounterpunchWindowName(name) || name === window.name) return false;
    if (!sameBuild(win)) {
        setAside(name, win);
        return false;
    }
    unlinked.delete(name);
    if (peers.get(name) === win) return false;
    peers.set(name, win);
    return true;
}

function adopt(win: Window | null): void {
    const theirs = apiOf(win);
    if (!win || !theirs) return;
    let changed = false;
    try {
        if (add(win.name, win)) changed = true;
        // A window of another version can't vouch for its peers either.
        if (theirs.build !== api.build) {
            emitChange();
            return;
        }
        for (const [name, other] of theirs.peers) {
            if (isAlive(other, name) && add(name, other)) changed = true;
        }
    } catch {
        // The window went away while we read it.
    }
    if (changed) emitChange();
}

function tellPeers(action: (peer: CounterpunchWindowApi) => void): void {
    for (const [, win] of peers) {
        const peer = apiOf(win);
        if (!peer) continue;
        try {
            action(peer);
        } catch {
            // The window went away in the meantime.
        }
    }
}

function announcement(): WindowAnnouncement {
    return {
        name: window.name,
        instance: api.instance,
        role: api.role,
        documentKey: api.documentKey,
        title: document.title,
        build: api.build
    };
}

function isSameWindow(
    win: Window | undefined,
    data: WindowAnnouncement
): boolean {
    return isAlive(win, data.name) && apiOf(win)?.instance === data.instance;
}

function isChannelMessage(data: unknown): data is ChannelMessage {
    const message = data as Partial<ChannelMessage> | null;
    return (
        !!message &&
        typeof message.name === 'string' &&
        typeof message.instance === 'string' &&
        ['hello', 'here', 'changed', 'bye'].includes(String(message.type))
    );
}

channel.onmessage = ({ data }) => {
    if (!isChannelMessage(data) || data.instance === api.instance) return;
    if (data.type === 'bye') {
        unlinked.delete(data.name);
        setTimeout(prune, 300);
        emitChange();
        return;
    }
    prune();
    const win = peers.get(data.name);
    if (isSameWindow(win, data)) {
        // A linked window reloaded: hand it our references again.
        if (data.type === 'hello') apiOf(win)?.register(window);
        emitChange();
        return;
    }
    unlinked.set(data.name, {
        name: data.name,
        instance: data.instance,
        role: data.role,
        documentKey: data.documentKey,
        title: data.title,
        build: data.build
    });
    emitChange();
    if (data.type === 'hello' && api.role) {
        channel.postMessage({ type: 'here', ...announcement() });
    }
};

// Every launcher and font window holds this shared lock while it's open, so a
// window the file manager opens can tell whether Counterpunch is running.
let lockHeld: Promise<void> | null = null;
export function holdWindowLock(): Promise<void> {
    lockHeld ??= new Promise<void>((granted) => {
        void navigator.locks.request(WINDOWS_LOCK, { mode: 'shared' }, () => {
            granted();
            return new Promise<void>(() => {}); // held until the window closes
        });
    });
    return lockHeld;
}

/** True in launcher and font windows, false in a window that only hands over. */
export const holdsWindowLock = () => lockHeld !== null;

export async function otherWindowsOpen(): Promise<boolean> {
    const { held = [] } = await navigator.locks.query();
    return held.some((lock) => lock.name === WINDOWS_LOCK);
}

/** Make this window a launcher or font window and link it to the others. */
export function initWindowRegistry(options: {
    role: CounterpunchWindowRole;
    documentKey?: string | null;
}): void {
    void holdWindowLock();
    api.role = options.role;
    api.documentKey = options.documentKey ?? null;
    window.name =
        options.role === 'launcher'
            ? LAUNCHER_WINDOW_NAME
            : fontWindowName(api.documentKey ?? api.instance);
    adopt(window.opener);
    tellPeers((peer) => peer.register(window));
    channel.postMessage({ type: 'hello', ...announcement() });

    addEventListener('pagehide', () => {
        tellPeers((peer) => peer.peerLeaving());
        channel.postMessage({ type: 'bye', ...announcement() });
    });
    const refresh = () => {
        prune();
        emitChange();
    };
    addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    emitChange();
}

/** Tell the other windows that this window's font or title changed. */
export function notifyWindowChanged(): void {
    tellPeers((peer) => peer.peerChanged());
    channel.postMessage({ type: 'changed', ...announcement() });
}

/** This window now shows another document (after Save As). */
export function setWindowDocument(documentKey: string): void {
    if (api.role !== 'font' || api.documentKey === documentKey) return;
    channel.postMessage({ type: 'bye', ...announcement() });
    api.documentKey = documentKey;
    window.name = fontWindowName(documentKey);
    tellPeers((peer) => {
        peer.register(window);
        peer.peerChanged();
    });
    channel.postMessage({ type: 'hello', ...announcement() });
}

const FOCUS_FRAGMENT = '#cp-focus-';
let focusCounter = 0;

/**
 * Bring another window to the front. Must run inside a click handler.
 *
 * Chrome ignores `win.focus()` for other tabs and windows, but switches to a
 * window that `window.open` navigates. Changing only the fragment of its
 * current URL is a same-document navigation: no reload, no lost state.
 */
export function focusWindow(
    name: string,
    win: Window | undefined = peers.get(name)
): boolean {
    if (!win || !isAlive(win, name)) return false;
    let url: string;
    try {
        url = `${win.location.pathname}${win.location.search}${FOCUS_FRAGMENT}${++focusCounter}`;
    } catch {
        win.focus();
        return true;
    }
    window.open(url, name);
    return true;
}

// Drop the fragment another window used to bring this one forward.
function clearFocusFragment(): void {
    if (location.hash.startsWith(FOCUS_FRAGMENT)) {
        history.replaceState(
            history.state,
            '',
            location.pathname + location.search
        );
    }
}
addEventListener('hashchange', clearFocusFragment);
clearFocusFragment();

export type OpenState = 'linked' | 'unlinked' | null;

/** Whether a document is open in another window, and whether we can reach it. */
export function documentOpenState(documentKey: string): OpenState {
    const name = fontWindowName(documentKey);
    prune();
    if (isAlive(peers.get(name), name)) return 'linked';
    if (unlinked.has(name)) return 'unlinked';
    return null;
}

export function launcherWindow(): Window | null {
    prune();
    const win = peers.get(LAUNCHER_WINDOW_NAME);
    return win && isAlive(win, LAUNCHER_WINDOW_NAME) ? win : null;
}

/** The other font windows, as live references. */
export function fontWindows(): Window[] {
    prune();
    return [...peers.entries()]
        .filter(([name]) => name.startsWith(FONT_WINDOW_PREFIX))
        .map(([, win]) => win);
}

/** Font windows that announced themselves but can't be reached from here. */
export function unlinkedFontWindows(): WindowAnnouncement[] {
    return [...unlinked.values()].filter((info) => info.role === 'font');
}

/** Remember a window this one just opened, before it registers itself. */
export function rememberOpenedWindow(name: string, win: Window): void {
    if (add(name, win)) emitChange();
}
