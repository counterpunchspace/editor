// The font-window side of the launcher: every editor window shows one font,
// is named after that font's document key, and is linked to the launcher and
// the other font windows (see window-registry.ts).

import { Logger } from '../logger';
import {
    getDiskDocument,
    touchRecentFont,
    type DiskDocument,
    type RecentSource
} from './document-store';
import {
    accessHandleOf,
    diskDocumentIdFromPath,
    diskDocumentKey,
    documentFromHandle,
    ensureDocumentAccess,
    grantFolderFor,
    type FolderGrantRequest
} from './disk-documents';
import { queryPermission } from './file-access';
import { escapeHtml, icon, reportError } from './dialogs';
import { announcePendingOpens, type PendingOpen } from './pending-opens';
import { fontFormatOf } from './font-formats';
import {
    holdWindowLock,
    initWindowRegistry,
    LAUNCHER_WINDOW_NAME,
    launcherWindow,
    focusWindow,
    notifyWindowChanged,
    otherWindowsOpen,
    setWindowDocument
} from './window-registry';
import type { DiskPlugin } from '../filesystem-plugins/plugins/disk-plugin';
import { pluginRegistry } from '../filesystem-plugins/registry';

const console = new Logger('FontWindows');

type LaunchParamsLike = { files?: FileSystemHandle[]; targetURL?: string };
type LaunchQueueLike = {
    setConsumer(consumer: (params: LaunchParamsLike) => void): void;
};

/** The document key the URL asks for: `?file=` or a new font (`?new=`). */
export function documentKeyFromUrl(search = location.search): string | null {
    const params = new URLSearchParams(search);
    const file = params.get('file');
    if (file) return file;
    const draft = params.get('new');
    return draft ? `new:///${draft}` : null;
}

/** Same-font view windows (Window → Open In New Window) are not font windows. */
const isFontViewWindow = () => window.windowRole?.isLinkedWindow?.() === true;

/** Register this editor window; call once at startup. */
export function initFontWindow(): void {
    if (isFontViewWindow()) return;
    initWindowRegistry({ role: 'font', documentKey: documentKeyFromUrl() });
}

function sourceOfKey(key: string): RecentSource | null {
    const scheme = key.split(':')[0];
    return scheme === 'disk' || scheme === 'memory' || scheme === 'cloud'
        ? scheme
        : null;
}

/**
 * The window's font got its identity: it was opened or saved under a file
 * URI. Rename the window after it, remember it as recent, tell the others.
 */
export function noteDocumentIdentity(fileUri: string): void {
    if (isFontViewWindow()) return;
    setWindowDocument(fileUri);
    // A saved new font is no longer new.
    const params = new URLSearchParams(location.search);
    if (params.has('new')) {
        params.delete('new');
        history.replaceState(
            history.state,
            '',
            `${location.pathname}?${params}`
        );
    }
    const source = sourceOfKey(fileUri);
    if (source) {
        const name =
            source === 'cloud'
                ? (window.fontManager?.currentFont?.name ?? 'Cloud font')
                : decodeURIComponent(fileUri.split('/').pop() || fileUri);
        void touchRecentFont({ key: fileUri, source, name }).catch((error) =>
            console.warn('Could not remember recent font', error)
        );
    }
    notifyWindowChanged();
}

/** Open the launcher, or bring it forward. Call from a click or shortcut. */
export function goToLauncher(): void {
    const existing = launcherWindow();
    if (existing) {
        focusWindow(LAUNCHER_WINDOW_NAME, existing);
        return;
    }
    // The launcher's real URL, never a blank window: a blank window is
    // outside the installed app's scope and would open as a browser tab.
    const win = window.open('launcher.html', LAUNCHER_WINDOW_NAME);
    if (!win) {
        alert('Your browser blocked the launcher window.');
    }
}

// --- The loading screen while a font waits for the user -------------------

function loadingContent(): HTMLElement | null {
    return document.querySelector('#loading-overlay .loading-content');
}

function showStartupCard(html: string): HTMLElement | null {
    const host = loadingContent();
    if (!host) return null;
    host.querySelector('.font-window-startup-card')?.remove();
    const status = document.getElementById('loading-status');
    if (status) status.style.display = 'none';
    const card = document.createElement('div');
    card.className = 'font-window-startup-card';
    card.innerHTML = html;
    host.append(card);
    return card;
}

function clearStartupCard(): void {
    loadingContent()?.querySelector('.font-window-startup-card')?.remove();
    const status = document.getElementById('loading-status');
    if (status) status.style.display = '';
}

/** Tell the user a font can't open, with the way back to the launcher. */
export function showFontUnavailable(title: string, message: string): void {
    const card = showStartupCard(`
        ${icon('error')}
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
        <button type="button" class="dialog-button dialog-button-primary" data-launcher>Open the launcher</button>`);
    card?.querySelector('[data-launcher]')?.addEventListener(
        'click',
        goToLauncher
    );
}

// --- Opening a font from this computer --------------------------------------

function diskPlugin(): DiskPlugin | null {
    const plugin = pluginRegistry.get('disk');
    return plugin && plugin.getId() === 'disk' ? (plugin as DiskPlugin) : null;
}

type OpenFontFn = (
    path: string,
    fileHandle?: FileSystemFileHandle,
    options?: { sourcePluginOverride?: DiskPlugin }
) => Promise<void>;

async function openAttachedDocument(doc: DiskDocument, openFont: OpenFontFn) {
    const plugin = diskPlugin();
    if (!plugin) throw new Error('Disk access is not available.');
    plugin.attachDocument(doc);
    await openFont(`/${doc.name}`, undefined, { sourcePluginOverride: plugin });
}

/**
 * Open the disk document `?file=disk:///<id>/<name>` names. If the browser
 * forgot its access (after a restart, unless the app is installed), ask for
 * it with a button: the request needs a click.
 */
export async function openDiskDocumentFromUrl(
    path: string,
    openFont: OpenFontFn
): Promise<void> {
    const id = diskDocumentIdFromPath(path);
    const doc = id ? await getDiskDocument(id) : null;
    if (!doc) {
        showFontUnavailable(
            'Font not found',
            'This font is no longer in Counterpunch’s list. Open it again from the launcher.'
        );
        return;
    }
    if (
        (await queryPermission(accessHandleOf(doc), 'readwrite')) === 'granted'
    ) {
        await openAttachedDocument(doc, openFont);
        return;
    }
    await new Promise<void>((resolve) => {
        const what =
            doc.parent && doc.format === 'designspace'
                ? `the folder containing ${doc.name}`
                : doc.name;
        const card = showStartupCard(`
            ${icon('lock_open_right')}
            <h2>Allow access to ${escapeHtml(what)}</h2>
            <p>Browsers forget file access when they restart. Installed as an app, Counterpunch keeps it. Until then, it asks once per session.</p>
            <button type="button" class="dialog-button dialog-button-primary" data-allow>Allow access</button>`);
        card?.querySelector('[data-allow]')?.addEventListener(
            'click',
            async () => {
                try {
                    if (!(await ensureDocumentAccess(doc, 'readwrite'))) return;
                    clearStartupCard();
                    await openAttachedDocument(doc, openFont);
                    resolve();
                } catch (error) {
                    reportError(error);
                }
            }
        );
    });
}

/** The folder step for a font the file manager handed to this window. */
function showFolderStep(
    request: FolderGrantRequest,
    openFont: OpenFontFn
): Promise<void> {
    return new Promise((resolve) => {
        const card = showStartupCard(`
            ${icon('folder_open')}
            <h2>One more step to open ${escapeHtml(request.handle.name)}</h2>
            <p>Counterpunch needs access to the folder it’s in. Choose that folder in the next window and confirm without selecting anything.</p>
            <button type="button" class="dialog-button dialog-button-primary" data-grant>Choose folder…</button>`);
        card?.querySelector('[data-grant]')?.addEventListener(
            'click',
            async () => {
                try {
                    const doc = await grantFolderFor(request);
                    clearStartupCard();
                    openThisWindowAs(diskDocumentKey(doc));
                    await openAttachedDocument(doc, openFont);
                    resolve();
                } catch (error) {
                    reportError(error);
                }
            }
        );
    });
}

function openThisWindowAs(key: string): void {
    const params = new URLSearchParams(location.search);
    params.delete('launch');
    params.set('file', key);
    history.replaceState(history.state, '', `${location.pathname}?${params}`);
    setWindowDocument(key);
}

async function pendingItemsFor(
    handles: FileSystemHandle[]
): Promise<PendingOpen[]> {
    const items: PendingOpen[] = [];
    for (const handle of handles) {
        try {
            const result = await documentFromHandle(handle);
            if (result.doc) {
                items.push({
                    key: diskDocumentKey(result.doc),
                    name: result.doc.name,
                    format: result.doc.format,
                    via: 'file-manager'
                });
            } else {
                items.push({
                    key: `folder:${crypto.randomUUID()}`,
                    name: handle.name,
                    format: result.needsFolder.format,
                    handle,
                    needsFolder: true,
                    via: 'file-manager'
                });
            }
        } catch (error) {
            console.warn('Skipped launched file', handle.name, error);
        }
    }
    return items;
}

/**
 * Fonts the file manager opened (Open With, a drop on the app icon) arrive
 * in a fresh window. If Counterpunch is already running, that window can't
 * be reached by the others: it hands its fonts over and closes, and every
 * window asks for a click. Otherwise it opens the first font itself.
 */
async function handleLaunchedFiles(
    files: FileSystemHandle[],
    openFont: OpenFontFn
): Promise<void> {
    await navigator.locks.request('counterpunch-launch', async () => {
        if (await otherWindowsOpen()) {
            const items = await pendingItemsFor(files);
            if (!items.length) {
                showFontUnavailable(
                    `Counterpunch can’t open ${files.map((f) => f.name).join(', ')}`,
                    'It opens .glyphs, .glyphspackage, .ufo, .designspace, .babelfont, .vfj and .sfd files.'
                );
                return;
            }
            announcePendingOpens(items, { show: false });
            showStartupCard(`${icon('open_in_new')}<h2>Opening…</h2>`);
            setTimeout(() => {
                window.close();
                // Only shown if closing was refused.
                showStartupCard(`
                    ${icon('open_in_new')}
                    <h2>Continue in Counterpunch</h2>
                    <p>Confirm opening the font in your other Counterpunch window. You can close this one.</p>`);
            }, 150);
            return;
        }
        // Nothing else is open: this becomes the first window.
        await holdWindowLock();
        const [first, ...rest] = files;
        try {
            const result = await documentFromHandle(first);
            if (result.doc) {
                openThisWindowAs(diskDocumentKey(result.doc));
                await openAttachedDocument(result.doc, openFont);
            } else {
                await showFolderStep(result.needsFolder, openFont);
            }
        } catch (error) {
            showFontUnavailable(
                `Couldn’t open ${first.name}`,
                error instanceof Error ? error.message : String(error)
            );
        }
        if (rest.length) announcePendingOpens(await pendingItemsFor(rest));
    });
}

let launchHandled = false;

/** Whether this window was started by the file manager with fonts. */
export const isLaunchWindow = () =>
    new URLSearchParams(location.search).has('launch');

/**
 * Receive fonts from the file manager. Call once at startup, before the
 * startup font logic runs; it resolves when a launch was handled.
 */
export function listenForLaunchedFiles(openFont: OpenFontFn): Promise<boolean> {
    const queue = (window as unknown as { launchQueue?: LaunchQueueLike })
        .launchQueue;
    if (!queue) return Promise.resolve(false);
    return new Promise((resolve) => {
        queue.setConsumer((params) => {
            const files = (params.files ?? []).filter((file) =>
                fontFormatOf(file.name)
            );
            if (!launchHandled && isLaunchWindow()) {
                launchHandled = true;
                void handleLaunchedFiles(
                    files.length ? files : (params.files ?? []),
                    openFont
                )
                    .catch(reportError)
                    .finally(() => resolve(true));
                return;
            }
            if (files.length) {
                void pendingItemsFor(files).then((items) =>
                    announcePendingOpens(items)
                );
            }
        });
        // A window that wasn't launched with files doesn't wait.
        if (!isLaunchWindow()) resolve(false);
    });
}

// --- Handing a font over to a linked window --------------------------------
//
// The launcher reopens a font from an unreachable window (one the browser
// restored, or one opened by hand) so it becomes linked. The new window asks
// the old one to step aside. A font with unsaved changes stays where it is.

type HandoverMessage =
    | { type: 'request'; key: string; instance: string }
    | { type: 'reply'; key: string; to: string; ok: boolean };

const handover = new BroadcastChannel('counterpunch-handover');

handover.addEventListener(
    'message',
    ({ data }: MessageEvent<HandoverMessage>) => {
        const api = window.counterpunchWindows;
        if (data?.type !== 'request' || !api || data.key !== api.documentKey)
            return;
        if (data.instance === api.instance) return;
        const dirty =
            window.fontManager?.currentFont?.hasUnsavedChanges === true;
        handover.postMessage({
            type: 'reply',
            key: data.key,
            to: data.instance,
            ok: !dirty
        } satisfies HandoverMessage);
        if (!dirty) {
            markHandingOver();
            window.close();
        }
    }
);

let handingOver = false;
const markHandingOver = () => {
    handingOver = true;
};
/** True while this window closes because another took its font over. */
export const isHandingOver = () => handingOver;

/**
 * In a window opened with `?takeover=1`: ask the font's old window to close.
 * Resolves false when it has unsaved changes and stays.
 */
export function takeOverFromOtherWindow(key: string): Promise<boolean> {
    const api = window.counterpunchWindows;
    if (!api) return Promise.resolve(true);
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            handover.removeEventListener('message', onReply);
            resolve(true); // nobody answered: it's gone
        }, 1200);
        function onReply({ data }: MessageEvent<HandoverMessage>) {
            if (
                data?.type !== 'reply' ||
                data.key !== key ||
                data.to !== api?.instance
            ) {
                return;
            }
            clearTimeout(timer);
            handover.removeEventListener('message', onReply);
            resolve(data.ok);
        }
        handover.addEventListener('message', onReply);
        handover.postMessage({
            type: 'request',
            key,
            instance: api.instance
        } satisfies HandoverMessage);
    });
}
