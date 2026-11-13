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
import {
    escapeHtml,
    icon,
    openDialog,
    reportError,
    type FontWindowDialog
} from './dialogs';
import { holdLoadingScreen } from './loading-hold';
import { announcePendingOpens, type PendingOpen } from './pending-opens';
import {
    FONT_FORMATS,
    fontFormatKind,
    fontFormatOf,
    openableExtensionsText,
    type FontFormatKey
} from './font-formats';
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
    return scheme === 'disk' ||
        scheme === 'memory' ||
        scheme === 'cloud' ||
        scheme === 'github'
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

// --- Dialogs while a font window waits for the user ----------------------
//
// They sit above the loading screen, which stays up until they close: the
// editor underneath has no font to show yet.

type StartupAction = {
    label: string;
    primary?: boolean;
    /** Runs on click; the dialog stays open until the caller closes it. */
    run: (button: HTMLButtonElement) => void | Promise<void>;
};

let startupDialog: { dialog: FontWindowDialog; release: () => void } | null =
    null;

function showStartupDialog(options: {
    title: string;
    message?: string;
    font?: { name: string; format: FontFormatKey | null };
    actions?: StartupAction[];
}): FontWindowDialog {
    closeStartupDialog();
    const release = holdLoadingScreen();
    const dialog = openDialog({
        title: options.title,
        className: 'font-window-startup',
        overlayClassName: 'font-window-startup-overlay',
        dismissable: false
    });
    const { font } = options;
    const fontRow = font
        ? `<div class="font-window-pending-row">${icon(font.format && fontFormatKind(font.format) === 'package' ? 'deployed_code' : 'description')}<span class="name">${escapeHtml(font.name)}</span><small>${escapeHtml(font.format ? FONT_FORMATS[font.format].label : '')}</small></div>`
        : '';
    const actions = options.actions ?? [];
    dialog.body.innerHTML = `
        ${fontRow}
        ${options.message ? `<p>${escapeHtml(options.message)}</p>` : ''}
        ${
            actions.length
                ? `<div class="font-window-dialog-actions">${actions
                      .map(
                          (action, index) =>
                              `<button type="button" class="dialog-button${action.primary ? ' dialog-button-primary' : ''}" data-action="${index}">${escapeHtml(action.label)}</button>`
                      )
                      .join('')}</div>`
                : ''
        }`;
    dialog.body
        .querySelectorAll<HTMLButtonElement>('[data-action]')
        .forEach((button) => {
            const action = actions[Number(button.dataset.action)];
            button.addEventListener('click', async () => {
                button.disabled = true;
                try {
                    await action.run(button);
                } catch (error) {
                    reportError(error);
                } finally {
                    button.disabled = false;
                }
            });
        });
    (
        dialog.body.querySelector('.dialog-button-primary') as HTMLElement
    )?.focus();
    startupDialog = { dialog, release };
    return dialog;
}

function closeStartupDialog(): void {
    if (!startupDialog) return;
    const { dialog, release } = startupDialog;
    startupDialog = null;
    dialog.close();
    release();
}

const launcherAction: StartupAction = {
    label: 'Open the launcher',
    run: goToLauncher
};

/** Tell the user a font can't open, with the way back to the launcher. */
export function showFontUnavailable(title: string, message: string): void {
    showStartupDialog({
        title,
        message,
        actions: [{ ...launcherAction, primary: true }]
    });
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
    // Keep the loading screen up until the font is open, not just until
    // access is granted.
    const release = holdLoadingScreen();
    try {
        await new Promise<void>((resolve) => {
            const folder = !!doc.parent && doc.format === 'designspace';
            showStartupDialog({
                title: folder
                    ? 'Allow access to the font’s folder'
                    : `Allow access to ${doc.name}`,
                font: { name: doc.name, format: doc.format },
                message: `Browsers forget file access when they restart. Installed as an app, Counterpunch keeps it. Until then, it asks once per session${folder ? ' for the folder containing the font' : ''}.`,
                actions: [
                    launcherAction,
                    {
                        label: 'Allow access',
                        primary: true,
                        run: async () => {
                            if (!(await ensureDocumentAccess(doc, 'readwrite')))
                                return;
                            closeStartupDialog();
                            resolve();
                        }
                    }
                ]
            });
        });
        await openAttachedDocument(doc, openFont);
    } finally {
        release();
    }
}

/** The folder step for a font the file manager handed to this window. */
function showFolderStep(
    request: FolderGrantRequest,
    openFont: OpenFontFn
): Promise<void> {
    return new Promise((resolve) => {
        showStartupDialog({
            title: `One more step to open ${request.handle.name}`,
            font: {
                name: request.handle.name,
                format: fontFormatOf(request.handle.name)
            },
            message:
                'Counterpunch needs access to the folder it’s in. Choose that folder in the next window and confirm without selecting anything.',
            actions: [
                {
                    label: 'Choose folder…',
                    primary: true,
                    run: async () => {
                        const doc = await grantFolderFor(request);
                        closeStartupDialog();
                        openThisWindowAs(diskDocumentKey(doc));
                        await openAttachedDocument(doc, openFont);
                        resolve();
                    }
                }
            ]
        });
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
                    `It opens ${openableExtensionsText()} files.`
                );
                return;
            }
            announcePendingOpens(items, { show: false });
            showStartupDialog({ title: 'Opening…' });
            setTimeout(() => {
                window.close();
                // Only shown if closing was refused.
                showStartupDialog({
                    title: 'Continue in Counterpunch',
                    message:
                        'Confirm opening the font in your other Counterpunch window. You can close this one.'
                });
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
