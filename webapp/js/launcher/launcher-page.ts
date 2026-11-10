// The launcher (launcher.html): start a new font, open fonts from this
// computer, the cloud or browser storage, and see which are open. Every font
// opens in its own window, linked to this one (see font-windows/).

import '../auth-manager';
import { Logger } from '../logger';
import { getCloudRequestHeaders } from '../cloud-website-api';
import { deleteCloudAssetUntilComplete } from '../cloud-delete-asset';
import {
    fetchExampleFiles,
    isExampleFontPath,
    loadExampleManifest
} from '../example-fonts';
import {
    allDiskDocuments,
    allRecentFonts,
    deleteDiskDocument,
    removeRecentFont,
    type DiskDocument,
    type RecentFont
} from '../font-windows/document-store';
import {
    diskDocumentKey,
    documentFromHandle,
    folderChain,
    pickFontFile,
    pickFontFolder
} from '../font-windows/disk-documents';
import { fontFormatKind, fontFormatOf } from '../font-windows/font-formats';
import { isAbortError, supportsFileAccess } from '../font-windows/file-access';
import {
    documentOpenState,
    fontWindowName,
    focusWindow,
    fontWindows,
    initWindowRegistry,
    onWindowsChange
} from '../font-windows/window-registry';
import {
    askForFolder,
    newFontKey,
    openDiskDocumentWindow,
    openFontWindow,
    openHandles,
    showFolderFonts,
    type OpenableFont
} from '../font-windows/open-documents';
import {
    escapeHtml,
    icon,
    openDialog,
    reportError,
    showNotice
} from '../font-windows/dialogs';
import '../font-windows/pending-opens';
import {
    activateUpdate,
    onNewVersionActive,
    waitingUpdate
} from '../app-update';

const console = new Logger('Launcher');

const SAMPLE_FONT_KEY = 'memory:///user/Fustat.glyphs';
const ROWS_SHOWN = 5;

document.title = 'Counterpunch';
initWindowRegistry({ role: 'launcher' });

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T;

const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '');
const kbd = (key: string) => `<kbd>${isMac ? '⌘' : 'Ctrl+'}${key}</kbd>`;

$('launcher-version').textContent = process.env.EDITOR_VERSION
    ? `v${process.env.EDITOR_VERSION}`
    : '';

// --- Start ------------------------------------------------------------------

$('launcher-new-font').innerHTML =
    `${icon('note_add')}<span><b>New font</b></span>`;
$('launcher-sample-font').innerHTML =
    `${icon('auto_awesome')}<span><b>Open sample font</b><small>Fustat, from browser storage</small></span>`;
$('launcher-open').innerHTML =
    `${icon('folder_open')}<span><b>Open…</b><small>From this computer</small></span>${kbd('O')}`;
$('launcher-drop-zone').innerHTML =
    `${icon('place_item')}<span class="launcher-drop-title">Drop a font here to open it</span><span class="launcher-drop-sub">Opens straight from your disk; saving writes back to the same file. Nothing is uploaded.</span>`;

if (!supportsFileAccess) {
    $('launcher-unsupported').hidden = false;
    $<HTMLButtonElement>('launcher-open').disabled = true;
    $('launcher-drop-zone').hidden = true;
    $('launcher-folder-route').hidden = true;
}

$('launcher-new-font').addEventListener('click', () => {
    openFontWindow({ key: newFontKey(), name: 'Untitled' });
});

$('launcher-sample-font').addEventListener('click', () => {
    openFontWindow({
        key: SAMPLE_FONT_KEY,
        name: 'Fustat.glyphs',
        format: 'glyphs'
    });
});

// One Open button, plus a quiet folder link below it. .ufo and
// .glyphspackage are folders on Windows, Linux and Macs without Glyphs, and
// the file picker can't select folders. After a cancelled file picker
// (likely: the .ufo couldn't be selected), the link lights up.
function flashFolderRoute(): void {
    const route = $('launcher-folder-route');
    route.classList.remove('flash');
    void route.offsetWidth; // restart the animation
    route.classList.add('flash');
}

$('launcher-open').addEventListener('click', async () => {
    try {
        const result = await documentFromHandle(await pickFontFile());
        if (result.needsFolder) askForFolder(result.needsFolder);
        else openDiskDocumentWindow(result.doc);
        void refresh();
    } catch (error) {
        if (isAbortError(error)) flashFolderRoute();
        reportError(error);
    }
});

$('launcher-open-folder').addEventListener('click', async () => {
    try {
        const pick = await pickFontFolder();
        if (pick.doc) openDiskDocumentWindow(pick.doc);
        else showFolderFonts(pick.folder, pick.fonts);
        void refresh();
    } catch (error) {
        reportError(error);
    }
});

addEventListener('keydown', (event) => {
    if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'o' &&
        supportsFileAccess
    ) {
        event.preventDefault();
        $('launcher-open').click();
    }
});

// Drop anywhere on the launcher.
let dragDepth = 0;
addEventListener('dragenter', (event) => {
    if (!supportsFileAccess || !event.dataTransfer?.types.includes('Files'))
        return;
    dragDepth += 1;
    document.body.classList.add('dragging');
});
addEventListener('dragleave', () => {
    dragDepth -= 1;
    if (dragDepth <= 0) {
        dragDepth = 0;
        document.body.classList.remove('dragging');
    }
});
addEventListener('dragover', (event) => event.preventDefault());
addEventListener('drop', async (event) => {
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    if (!supportsFileAccess || !event.dataTransfer) return;
    // Ask for every handle before the first await: the list is cleared after.
    const pending = [...event.dataTransfer.items]
        .filter((item) => item.kind === 'file')
        .map((item) =>
            (
                item as DataTransferItem & {
                    getAsFileSystemHandle(): Promise<FileSystemHandle | null>;
                }
            ).getAsFileSystemHandle()
        );
    const handles = (await Promise.all(pending)).filter(
        (handle): handle is FileSystemHandle => !!handle
    );
    await openHandles(handles);
    void refresh();
});

// --- Appearance -------------------------------------------------------------

/** Shared with the editor's theme switcher. Values: `auto` | `light` | `dark`. */
const THEME_KEY = 'preferredTheme';
type ThemePreference = 'auto' | 'light' | 'dark';

function themePreference(): ThemePreference {
    try {
        const stored = localStorage.getItem(THEME_KEY);
        return stored === 'light' || stored === 'dark' ? stored : 'auto';
    } catch {
        return 'auto';
    }
}

const prefersLight = matchMedia('(prefers-color-scheme: light)');
function applyTheme(): void {
    const preference = themePreference();
    const light =
        preference === 'light' ||
        (preference === 'auto' && prefersLight.matches);
    document.documentElement.toggleAttribute('data-theme', light);
    if (light) document.documentElement.setAttribute('data-theme', 'light');
}
prefersLight.addEventListener('change', applyTheme);
addEventListener('storage', (event) => {
    if (event.key === THEME_KEY) applyTheme();
});

$('launcher-theme').addEventListener('click', (event) => {
    event.stopPropagation();
    const button = event.currentTarget as HTMLElement;
    document.querySelector('.launcher-menu')?.remove();
    const current = themePreference();
    const menu = document.createElement('div');
    menu.className = 'launcher-menu';
    menu.setAttribute('role', 'menu');
    const choices: [ThemePreference, string, string][] = [
        ['auto', 'Match system', 'contrast'],
        ['light', 'Light', 'light_mode'],
        ['dark', 'Dark', 'dark_mode']
    ];
    menu.innerHTML = choices
        .map(
            ([value, label, symbol]) =>
                `<button type="button" class="launcher-menu-item" role="menuitemradio" aria-checked="${value === current}" data-theme-choice="${value}">${icon(symbol)}<span>${label}</span>${value === current ? icon('check') : '<span></span>'}</button>`
        )
        .join('');
    const rect = button.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.right = `${Math.max(8, innerWidth - rect.right)}px`;
    document.body.append(menu);
    menu.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const close = () => {
        menu.remove();
        removeEventListener('click', close);
        removeEventListener('keydown', onKey);
    };
    const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            close();
            button.focus();
        }
    };
    menu.addEventListener('click', (e) => {
        const choice = (e.target as HTMLElement).closest<HTMLElement>(
            '[data-theme-choice]'
        );
        if (!choice) return;
        try {
            localStorage.setItem(
                THEME_KEY,
                choice.dataset.themeChoice ?? 'auto'
            );
        } catch {
            // Storage may be unavailable; the choice applies to this page only.
        }
        applyTheme();
        close();
    });
    setTimeout(() => addEventListener('click', close));
    addEventListener('keydown', onKey);
});

// --- Recent fonts -----------------------------------------------------------

// Fonts on this computer can only be taken off the list; browser-storage
// fonts and cloud fonts the user owns can be deleted.
type RowAction = 'forget' | 'delete';

type Row = OpenableFont & {
    icon: string;
    lastOpened: number | null;
    where?: string[];
    action?: RowAction;
};

type CloudAsset = {
    id: string;
    name: string;
    updatedAt: number;
    role?: string;
};

let diskDocs: DiskDocument[] = [];
let recents = new Map<string, RecentFont>();
const chains = new Map<string, string[]>();
let browserFonts: string[] = [];
let cloudAssets: CloudAsset[] | null = null;
const expanded = new Set<string>();
// “Load outlines later” for cloud fonts: open sparse, downloading glyph
// outlines as they are typed or opened (`sparse=true`). Off each time, like
// the old file dialog checkbox.
let cloudLoadOutlinesLater = false;

function timeAgo(time: number | null): string {
    if (!time) return '';
    const minutes = Math.round((Date.now() - time) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return days === 1 ? 'yesterday' : `${days} days ago`;
    return new Date(time).toLocaleDateString();
}

const rowIcon = (name: string) => {
    const format = fontFormatOf(name);
    return format && fontFormatKind(format) === 'package'
        ? 'deployed_code'
        : 'description';
};

// "in Fonts › Grotesk › sources": the start truncates first, so the font's
// own folder stays visible.
function whereHtml(chain: string[] | undefined): string {
    if (!chain?.length) return '';
    const full = `in ${chain.join(' › ')}`;
    if (chain.length === 1) {
        return `<span class="where" title="${escapeHtml(full)}"><span class="where-tail">${escapeHtml(full)}</span></span>`;
    }
    const head = `in ${chain.slice(0, -1).join(' › ')}`;
    return `<span class="where" title="${escapeHtml(full)}"><span class="where-head">${escapeHtml(head)}</span><span class="where-tail">&nbsp;› ${escapeHtml(chain[chain.length - 1])}</span></span>`;
}

function rowHtml(row: Row): string {
    const state = documentOpenState(row.key);
    let meta = escapeHtml(timeAgo(row.lastOpened));
    if (state) {
        const title =
            state === 'unlinked'
                ? ' title="Moves the font into a window linked with this launcher"'
                : '';
        meta = `<span class="launcher-open-badge">Open</span><button type="button" class="dialog-button" data-jump="${escapeHtml(row.key)}"${title}>${icon('jump_to_element')}Jump to</button>`;
    }
    let action = '';
    if (row.action === 'forget' && !state) {
        action = `<button type="button" class="launcher-icon-button remove" data-remove="${escapeHtml(row.key)}" aria-label="Remove from list" title="Remove from list">${icon('close')}</button>`;
    } else if (row.action === 'delete' && !state) {
        action = `<button type="button" class="launcher-icon-button remove" data-delete="${escapeHtml(row.key)}" aria-label="Delete…" title="Delete…">${icon('delete')}</button>`;
    }
    return `<div class="launcher-row" role="button" tabindex="0" data-open="${escapeHtml(row.key)}">${icon(row.icon)}<span class="name-line"><span class="name">${escapeHtml(row.name)}</span>${whereHtml(row.where)}</span><span class="meta">${meta}${action}</span></div>`;
}

function unsavedRows(): Row[] {
    const rows: Row[] = [];
    for (const win of fontWindows()) {
        try {
            const key = win.counterpunchWindows?.documentKey;
            if (!key?.startsWith('new:///')) continue;
            rows.push({
                key,
                name: win.fontManager?.currentFont?.name || 'Untitled',
                icon: 'note_add',
                lastOpened: null
            });
        } catch {
            // The window closed while we looked.
        }
    }
    return rows;
}

function diskRows(): Row[] {
    return diskDocs
        .map((doc) => {
            const key = diskDocumentKey(doc);
            return {
                key,
                name: doc.name,
                format: doc.format,
                icon: rowIcon(doc.name),
                lastOpened: recents.get(key)?.lastOpened ?? doc.addedAt,
                where: chains.get(doc.id),
                action: 'forget' as const
            };
        })
        .sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0));
}

function browserRows(): Row[] {
    return browserFonts
        .map((name) => {
            const key = `memory:///user/${name}`;
            return {
                key,
                name,
                format: fontFormatOf(name),
                icon: rowIcon(name),
                lastOpened: recents.get(key)?.lastOpened ?? null,
                action:
                    examplesKnown && !isExampleFontPath(`/user/${name}`)
                        ? ('delete' as const)
                        : undefined
            };
        })
        .sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0));
}

function cloudRows(): Row[] {
    return (cloudAssets ?? [])
        .map((asset) => {
            const key = `cloud:///${asset.id}`;
            return {
                key,
                name: asset.name,
                icon: 'cloud',
                lastOpened: recents.get(key)?.lastOpened ?? asset.updatedAt,
                // Only the owner can delete; the server refuses everyone else.
                action: asset.role === 'owner' ? ('delete' as const) : undefined
            };
        })
        .sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0));
}

function listHtml(group: string, rows: Row[], empty: string): string {
    if (!rows.length) return `<div class="launcher-empty">${empty}</div>`;
    const limit = expanded.has(group) ? rows.length : ROWS_SHOWN;
    let html = rows.slice(0, limit).map(rowHtml).join('');
    if (rows.length > limit) {
        html += `<button type="button" class="launcher-link launcher-show-all" data-expand="${group}">Show all ${rows.length}</button>`;
    }
    return html;
}

function groupHtml(
    title: string,
    symbol: string,
    body: string,
    sub = '',
    trailing = ''
): string {
    return `<div class="launcher-group"><div class="launcher-group-title">${icon(symbol)}${title}${sub ? `<span class="sub">${escapeHtml(sub)}</span>` : ''}${trailing}</div>${body}</div>`;
}

let rowsByKey = new Map<string, Row>();

function render(): void {
    const unsaved = unsavedRows();
    const disk = diskRows();
    const browser = browserRows();
    const cloud = cloudRows();
    rowsByKey = new Map(
        [...unsaved, ...disk, ...browser, ...cloud].map((row) => [row.key, row])
    );

    const open = fontWindows().length;
    $('launcher-open-count').textContent = open ? `${open} open` : '';

    const auth = window.authManager;
    const signedIn = auth?.isAuthenticated?.() === true;
    $('launcher-account').innerHTML =
        signedIn && auth.user?.email
            ? `${icon('account_circle')}${escapeHtml(auth.user.email)}`
            : '';

    let html = '';
    if (unsaved.length) {
        html += groupHtml(
            'Unsaved',
            'note_add',
            unsaved.map(rowHtml).join(''),
            'gone when you close the window without saving'
        );
    }
    if (supportsFileAccess) {
        html += groupHtml(
            'This computer',
            'computer',
            listHtml(
                'disk',
                disk,
                'Fonts you open from this computer show up here.'
            )
        );
    }
    const cloudBody = !signedIn
        ? `<div class="launcher-callout"><span>Collaborate on fonts and open them anywhere.</span><button type="button" class="dialog-button" data-cloud-login>Log in</button></div>`
        : cloudAssets === null
          ? `<div class="launcher-empty">Loading…</div>`
          : listHtml(
                'cloud',
                cloud,
                'No cloud fonts yet. Save a font to the cloud with File → Save As.'
            );
    const cloudOptions =
        signedIn && cloud.length
            ? `<label class="launcher-cloud-sparse" title="Download glyph outlines only as you type or open them"><input type="checkbox" data-cloud-sparse${cloudLoadOutlinesLater ? ' checked' : ''}>Load outlines later</label>`
            : '';
    html += groupHtml('Cloud', 'cloud', cloudBody, '', cloudOptions);
    html += groupHtml(
        'Browser storage',
        'web',
        listHtml('browser', browser, 'No fonts in browser storage yet.')
    );
    $('launcher-recents').innerHTML = html;
}

$('launcher-recents').addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-cloud-login]')) {
        await window.authManager?.signIn?.({
            reason: 'Log in to see your cloud fonts.'
        });
        void refreshCloud();
        return;
    }
    const expand = target.closest<HTMLElement>('[data-expand]');
    if (expand) {
        expanded.add(expand.dataset.expand ?? '');
        render();
        return;
    }
    const remove = target.closest<HTMLElement>('[data-remove]');
    if (remove) {
        const key = remove.dataset.remove ?? '';
        const doc = diskDocs.find((d) => diskDocumentKey(d) === key);
        if (doc) await deleteDiskDocument(doc.id);
        await removeRecentFont(key);
        void refresh();
        return;
    }
    const del = target.closest<HTMLElement>('[data-delete]');
    if (del) {
        const row = rowsByKey.get(del.dataset.delete ?? '');
        if (row) confirmDelete(row);
        return;
    }
    const jump = target.closest<HTMLElement>('[data-jump]');
    const row = jump ?? target.closest<HTMLElement>('[data-open]');
    const key = jump?.dataset.jump ?? row?.dataset.open;
    if (!key) return;
    if (documentOpenState(key) === 'linked') {
        focusWindow(fontWindowName(key));
        return;
    }
    const font = rowsByKey.get(key);
    if (font) openFontWindow(font, { sparse: cloudLoadOutlinesLater });
});

const CLOUD_PREFIX = 'cloud:///';
const BROWSER_PREFIX = 'memory:///user/';

function confirmDelete(row: Row): void {
    const cloud = row.key.startsWith(CLOUD_PREFIX);
    const dialog = openDialog({ title: `Delete “${row.name}”?` });
    dialog.body.innerHTML = `
        <p>${
            cloud
                ? 'This deletes the font from the cloud, for you and everyone you shared it with.'
                : 'This deletes the font from this browser’s storage.'
        } It can’t be undone.</p>
        <div class="font-window-dialog-actions">
            <button type="button" class="dialog-button" data-close>Cancel</button>
            <button type="button" class="dialog-button dialog-button-danger" data-confirm-delete>Delete</button>
        </div>`;
    const button = dialog.body.querySelector<HTMLButtonElement>(
        '[data-confirm-delete]'
    );
    button?.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = 'Deleting…';
        try {
            await deleteFont(row);
            dialog.close();
        } catch (error) {
            dialog.close();
            reportError(error);
        }
    });
    // Take focus from the row's trash button, so Enter confirms instead of
    // opening the dialog again.
    button?.focus();
}

async function deleteFont(row: Row): Promise<void> {
    // The font may have been opened since the list was drawn.
    if (documentOpenState(row.key)) {
        throw new Error(`Close “${row.name}” before deleting it.`);
    }
    if (row.key.startsWith(CLOUD_PREFIX)) {
        const auth = window.authManager;
        if (!auth?.websiteURL) throw new Error('Log in to delete cloud fonts.');
        await deleteCloudAssetUntilComplete({
            websiteBaseUrl: auth.websiteURL,
            assetId: row.key.slice(CLOUD_PREFIX.length)
        });
        await removeRecentFont(row.key);
        await refreshCloud();
        return;
    }
    if (row.key.startsWith(BROWSER_PREFIX)) {
        if (isExampleFontPath(row.key.slice('memory://'.length))) {
            throw new Error(`“${row.name}” is an example font.`);
        }
        const root = await navigator.storage.getDirectory();
        const user = await root.getDirectoryHandle('user');
        // Packages (.ufo, .glyphspackage) are folders.
        await user.removeEntry(row.key.slice(BROWSER_PREFIX.length), {
            recursive: true
        });
        await removeRecentFont(row.key);
        await refresh();
    }
}

$('launcher-recents').addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement;
    if (target.matches('[data-cloud-sparse]')) {
        cloudLoadOutlinesLater = target.checked;
    }
});

$('launcher-recents').addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    if (
        (event.key === 'Enter' || event.key === ' ') &&
        target.matches('.launcher-row')
    ) {
        event.preventDefault();
        target.click();
    }
});

async function readBrowserFonts(): Promise<string[]> {
    try {
        const root = await navigator.storage.getDirectory();
        const user = await root.getDirectoryHandle('user');
        const names: string[] = [];
        for await (const name of (
            user as FileSystemDirectoryHandle & {
                keys(): AsyncIterable<string>;
            }
        ).keys()) {
            if (fontFormatOf(name)) names.push(name);
        }
        return names;
    } catch {
        return []; // nothing saved in browser storage yet
    }
}

// The sample font opens from browser storage, so the launcher writes any
// missing example font there too (font windows rewrite them on every start).
// Browser-storage fonts get no delete button until the examples are known.
let examplesKnown = false;

async function seedExampleFonts(): Promise<void> {
    try {
        const entries = await loadExampleManifest().finally(() => {
            examplesKnown = true;
            render();
        });
        if (!entries) return;
        const root = await navigator.storage.getDirectory();
        const missing = [];
        for (const entry of entries) {
            if (!(await opfsEntryExists(root, entry.destination))) {
                missing.push(entry);
            }
        }
        for (const file of await fetchExampleFiles(missing)) {
            await writeOpfsFile(root, file.name, file);
        }
    } catch (error) {
        console.warn('Could not write the example fonts', error);
    }
}

async function opfsEntryExists(
    root: FileSystemDirectoryHandle,
    path: string
): Promise<boolean> {
    const parts = path.split('/').filter(Boolean);
    let dir = root;
    try {
        for (const part of parts.slice(0, -1)) {
            dir = await dir.getDirectoryHandle(part);
        }
        const name = parts[parts.length - 1];
        await dir.getFileHandle(name).catch(() => dir.getDirectoryHandle(name));
        return true;
    } catch {
        return false;
    }
}

async function writeOpfsFile(
    root: FileSystemDirectoryHandle,
    path: string,
    data: Blob
): Promise<void> {
    const parts = path.split('/').filter(Boolean);
    let dir = root;
    for (const part of parts.slice(0, -1)) {
        dir = await dir.getDirectoryHandle(part, { create: true });
    }
    const file = await dir.getFileHandle(parts[parts.length - 1], {
        create: true
    });
    const writable = await file.createWritable();
    await writable.write(data);
    await writable.close();
}

async function refreshCloud(): Promise<void> {
    const auth = window.authManager;
    if (!auth?.isAuthenticated?.()) {
        cloudAssets = null;
        render();
        return;
    }
    try {
        const response = await fetch(`${auth.websiteURL}/api/cloud/assets`, {
            credentials: 'include',
            headers: getCloudRequestHeaders()
        });
        const data = response.ok
            ? ((await response.json()) as { assets?: CloudAsset[] })
            : {};
        cloudAssets = data.assets ?? [];
    } catch (error) {
        console.warn('Could not list cloud fonts', error);
        cloudAssets = [];
    }
    render();
}

async function refresh(): Promise<void> {
    const [docs, recent, browser] = await Promise.all([
        allDiskDocuments(),
        allRecentFonts(),
        readBrowserFonts()
    ]);
    await Promise.all(
        docs.map(async (doc) =>
            chains.set(doc.id, await folderChain(doc).catch(() => []))
        )
    );
    diskDocs = docs;
    recents = new Map(recent.map((font) => [font.key, font]));
    browserFonts = browser;
    render();
}

// Other windows save and rename fonts: re-read whenever a window reports a
// change, comes or goes, or the launcher gets focus. "… ago" labels tick.
onWindowsChange(() => void refresh());
addEventListener('focus', () => void refresh());
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) render();
});
setInterval(render, 60_000);
addEventListener('authStateChanged', () => void refreshCloud());

void seedExampleFonts().then(refresh);
void window.authManager
    ?.checkAuthStatus?.()
    .catch(() => null)
    .finally(() => void refreshCloud());

// --- Updates ------------------------------------------------------------------
//
// The launcher stays open, so it keeps itself current: it reloads as soon as a
// new version takes over (it holds no unsaved work), looks for updates like the
// font windows do, and offers to update when one is ready.

onNewVersionActive(() => location.reload());

const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const UPDATE_CHECK_THROTTLE_MS = 60 * 1000;
let lastUpdateCheck = 0;
let updateOffered = false;

async function offerWaitingUpdate(): Promise<void> {
    const worker = await waitingUpdate();
    if (!worker || updateOffered) return;
    updateOffered = true;
    showNotice('A new version of Counterpunch is ready.', {
        label: 'Update',
        run: () => activateUpdate(worker)
    });
}

async function checkForUpdate(): Promise<void> {
    const now = Date.now();
    if (now - lastUpdateCheck < UPDATE_CHECK_THROTTLE_MS) return;
    lastUpdateCheck = now;
    try {
        const registration = await navigator.serviceWorker?.getRegistration();
        if (!registration || !navigator.serviceWorker.controller) return;
        registration.addEventListener('updatefound', () => {
            const installing = registration.installing;
            installing?.addEventListener('statechange', () => {
                if (installing.state === 'installed') void offerWaitingUpdate();
            });
        });
        await registration.update();
        await offerWaitingUpdate();
    } catch (error) {
        console.warn('Update check failed', error);
    }
}

if (!window.isTestMode?.() && !window.isDevelopment?.()) {
    void checkForUpdate();
    addEventListener('focus', () => void checkForUpdate());
    setInterval(() => {
        lastUpdateCheck = 0;
        void checkForUpdate();
    }, UPDATE_CHECK_INTERVAL_MS);
}
