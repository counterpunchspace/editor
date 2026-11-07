// Fonts that need a click before they can open: opened from the file manager
// while Counterpunch is running, or dropped where the browser refused a new
// window.
//
// A window the file manager opens can't be reached by the others, so it hands
// its fonts over and closes. Every Counterpunch window then shows the same
// confirmation in the middle of the screen; a click in any of them opens the
// font from that window, which links it to all the others. A click anywhere
// resolves it everywhere.

import { grantFolderFor } from './disk-documents';
import { fontFormatKind, type FontFormatKey } from './font-formats';
import { documentOpenState, holdsWindowLock } from './window-registry';
import { escapeHtml, FILE_MANAGER, icon, reportError } from './dialogs';
import { bindModalEscape, type ModalEscapeBinding } from '../ui/modal-escape';
import { openDiskDocumentWindow, openFontWindow } from './open-documents';

export type PendingOpen = {
    key: string;
    name: string;
    format: FontFormatKey | null;
    /** A package or .designspace that needs its folder granted first. */
    handle?: FileSystemHandle;
    needsFolder?: boolean;
    via: 'file-manager' | 'drop';
};

type PendingMessage =
    | { type: 'add'; item: PendingOpen }
    | { type: 'remove'; key: string }
    | { type: 'sync'; items: PendingOpen[] }
    | { type: 'sync-request' };

const channel = new BroadcastChannel('counterpunch-pending-opens');
const pending = new Map<string, PendingOpen>();
let overlay: HTMLElement | null = null;
let lastHtml = '';
let escape: ModalEscapeBinding | null = null;

/**
 * List fonts for confirmation in every window. The window the file manager
 * opened passes `show: false`: it is about to close and can't tell which
 * fonts are open elsewhere, so it must not show a second, different copy.
 */
export function announcePendingOpens(
    items: PendingOpen[],
    options: { show?: boolean } = {}
): void {
    for (const item of items) {
        pending.set(item.key, item);
        channel.postMessage({ type: 'add', item } satisfies PendingMessage);
    }
    if (options.show !== false) render();
}

function resolvePending(key: string): void {
    pending.delete(key);
    channel.postMessage({ type: 'remove', key } satisfies PendingMessage);
    render();
}

function dismissAll(): void {
    for (const key of [...pending.keys()]) resolvePending(key);
}

function isPendingMessage(data: unknown): data is PendingMessage {
    const type = (data as { type?: unknown } | null)?.type;
    return (
        type === 'add' ||
        type === 'remove' ||
        type === 'sync' ||
        type === 'sync-request'
    );
}

channel.onmessage = ({ data }) => {
    if (!isPendingMessage(data)) return;
    switch (data.type) {
        case 'add':
            pending.set(data.item.key, data.item);
            tryToComeForward(data.item);
            break;
        case 'remove':
            pending.delete(data.key);
            break;
        case 'sync':
            data.items.forEach((item) => pending.set(item.key, item));
            break;
        case 'sync-request':
            if (pending.size) {
                channel.postMessage({
                    type: 'sync',
                    items: [...pending.values()]
                } satisfies PendingMessage);
            }
            return;
    }
    scheduleRender();
};
// A window that opens while a confirmation is showing joins in.
channel.postMessage({ type: 'sync-request' } satisfies PendingMessage);

// Re-check "already open" when windows come and go, but only update a dialog
// that is showing: creating one here would skip the grace period below.
addEventListener('focus', () => {
    if (overlay) render();
});

type ItemState = 'here' | 'open' | 'folder' | 'new';

function stateOf(item: PendingOpen): ItemState {
    if (item.needsFolder) return 'folder';
    if (item.key === window.counterpunchWindows?.documentKey) return 'here';
    return documentOpenState(item.key) ? 'open' : 'new';
}

// Fonts dropped together arrive one message at a time; wait briefly before
// showing the dialog. Already-open fonts wait longer, so their window can try
// to come forward first.
let firstShowTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRender(): void {
    if (overlay) return render();
    if (firstShowTimer) clearTimeout(firstShowTimer);
    const onlyOpenFonts = [...pending.values()].every((item) =>
        ['open', 'here'].includes(stateOf(item))
    );
    firstShowTimer = setTimeout(render, onlyOpenFonts ? 400 : 150);
}

// The font is open in this window: try to come to the front by ourselves.
// Browsers may refuse without a click, so check that it worked; if it did,
// withdraw the confirmation everywhere.
function tryToComeForward(item: PendingOpen): void {
    if (item.key !== window.counterpunchWindows?.documentKey) return;
    window.focus();
    setTimeout(() => {
        if (document.hasFocus() && pending.has(item.key))
            resolvePending(item.key);
    }, 250);
}

async function act(item: PendingOpen): Promise<void> {
    try {
        if (item.needsFolder && item.handle && item.format) {
            openDiskDocumentWindow(
                await grantFolderFor({
                    handle: item.handle,
                    format: item.format
                })
            );
        } else if (stateOf(item) !== 'here') {
            openFontWindow(item);
        }
        resolvePending(item.key);
    } catch (error) {
        reportError(error);
    }
}

function render(): void {
    const items = [...pending.values()];
    // Only real Counterpunch windows ask: the window that hands fonts over
    // never takes the window lock.
    if (!items.length || !holdsWindowLock()) return close();

    const states = items.map(stateOf);
    const allOpen = states.every((s) => s === 'open' || s === 'here');
    const fromDrop = items.every((item) => item.via === 'drop');
    const names = items.map((item) => `“${item.name}”`);
    const title = allOpen
        ? items.length === 1
            ? `${names[0]} is already open`
            : 'These fonts are already open'
        : items.length === 1
          ? `Open ${names[0]}?`
          : `Open ${items.length} fonts?`;
    const why = allOpen
        ? fromDrop
            ? 'It’s already open. Click Show to switch to its window instead of opening it twice.'
            : `You opened it from ${FILE_MANAGER}, but Counterpunch already has it open. Click Show to switch to that window instead of opening it twice.`
        : fromDrop
          ? 'Browsers only let a page open a new window right after a click, and dropping a file doesn’t count. Please confirm here.'
          : `You opened this from ${FILE_MANAGER} while Counterpunch is running. To keep your fonts connected, Counterpunch opens every font from one of its own windows. That way you can switch between them in the launcher, and scripts can reach all of them with <code>OtherFonts()</code>. Browsers only let a page open a window after a click, so please confirm here.`;

    const rows = items
        .map((item, index) => {
            const state = states[index];
            const kind =
                item.format && fontFormatKind(item.format) === 'package'
                    ? 'deployed_code'
                    : 'description';
            const note = {
                open: 'Already open',
                here: 'Already open in this window',
                folder: 'Needs access to its folder',
                new: ''
            }[state];
            const label = {
                open: 'Show',
                here: 'OK',
                folder: 'Choose folder…',
                new: 'Open'
            }[state];
            return `<div class="font-window-pending-row">${icon(kind)}<span class="name">${escapeHtml(item.name)}${note ? `<small>${note}</small>` : ''}</span><button type="button" class="dialog-button dialog-button-primary" data-act="${escapeHtml(item.key)}">${label}</button></div>`;
        })
        .join('');

    const html = `
        <div class="font-window-pending-head"><img src="assets/favicon/icon.svg" alt=""><h3 id="font-window-pending-title">${escapeHtml(title)}</h3></div>
        <p class="font-window-pending-why" id="font-window-pending-why">${why}</p>
        <div class="font-window-pending-list">${rows}</div>
        <div class="font-window-dialog-actions"><span class="font-window-hint">Shown in every Counterpunch window</span><button type="button" class="dialog-button" data-dismiss>Not now</button></div>`;

    // Build the dialog once; afterwards only swap its contents when they
    // change, so the pop-in animation never plays twice.
    if (overlay) {
        if (html !== lastHtml) {
            (
                overlay.querySelector('.font-window-dialog') as HTMLElement
            ).innerHTML = html;
        }
        lastHtml = html;
        return;
    }
    lastHtml = html;
    overlay = document.createElement('div');
    overlay.className =
        'info-popup-overlay font-window-dialog-overlay font-window-pending';
    overlay.innerHTML = `<div class="info-popup font-window-dialog" role="alertdialog" aria-modal="true" aria-labelledby="font-window-pending-title" aria-describedby="font-window-pending-why">${html}</div>`;
    overlay.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        const button = target.closest<HTMLElement>('[data-act]');
        if (button) {
            const item = pending.get(button.dataset.act ?? '');
            if (item) void act(item);
        } else if (target.closest('[data-dismiss]')) {
            dismissAll();
        }
    });
    escape = bindModalEscape(dismissAll, { isOpen: () => overlay !== null });
    document.body.append(overlay);
    overlay.querySelector<HTMLElement>('[data-act]')?.focus();
}

function close(): void {
    if (!overlay) return;
    const leaving = overlay;
    overlay = null;
    escape?.release();
    escape = null;
    leaving.classList.add('closing');
    setTimeout(() => leaving.remove(), 200);
}
