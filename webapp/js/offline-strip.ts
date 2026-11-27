// The strip under the bottom panels that says a cloud font is offline.
// It takes room from the window instead of covering it, because editing
// goes on while it shows. Two levels: amber while offline edits still work,
// red once editing has paused (see offline-edit-limit.ts).

import type { OfflineLevel } from './filesystem-plugins/offline-edit-limit';
import { mountModalOverlay } from './ui/confirm-dialog';

export const OFFLINE_STRIP_ID = 'offline-strip';
export const OFFLINE_LEVEL_EVENT = 'cloudOfflineLevelChanged';
export const OFFLINE_STRIP_OPEN_CLASS = 'offline-strip-open';

export const OFFLINE_STRIP_MESSAGES: Record<
    Exclude<OfflineLevel, 'none'>,
    { icon: string; title: string; text: string }
> = {
    offline: {
        icon: 'cloud_off',
        title: 'You’re offline.',
        text: 'You can keep editing for 5 minutes. Your edits are sent when you reconnect.'
    },
    paused: {
        icon: 'edit_off',
        title: 'Editing is paused.',
        text: 'You’ve been offline for over 5 minutes. Your edits are sent when you reconnect.'
    }
};

export const OFFLINE_STRIP_LINK_LABEL = 'What if others edit too?';

const DOCS_PAGE = 'files/cloud-fonts';
const DOCS_HEADING = 'working-offline';

function stripElement(): HTMLElement {
    let strip = document.getElementById(OFFLINE_STRIP_ID);
    if (strip) return strip;
    strip = document.createElement('div');
    strip.id = OFFLINE_STRIP_ID;
    strip.className = 'offline-strip';
    strip.setAttribute('role', 'status');
    strip.setAttribute('aria-live', 'polite');
    const shell = document.getElementById('app-shell');
    if (shell?.parentNode) {
        shell.parentNode.insertBefore(strip, shell.nextSibling);
    } else {
        document.body.append(strip);
    }
    return strip;
}

/** Show the strip for a level, or slide it away for `none`. */
export function renderOfflineStrip(level: OfflineLevel): void {
    if (level === 'none') {
        document.body.classList.remove(OFFLINE_STRIP_OPEN_CLASS);
        const strip = document.getElementById(OFFLINE_STRIP_ID);
        if (strip) strip.dataset.level = 'none';
        return;
    }
    const message = OFFLINE_STRIP_MESSAGES[level];
    const strip = stripElement();
    strip.dataset.level = level;
    strip.replaceChildren();

    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined offline-strip-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = message.icon;

    const title = document.createElement('b');
    title.className = 'offline-strip-title';
    title.textContent = message.title;

    const text = document.createElement('span');
    text.className = 'offline-strip-text';
    text.textContent = message.text;

    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'offline-strip-link';
    link.textContent = OFFLINE_STRIP_LINK_LABEL;
    link.addEventListener('click', () => openOfflineMergeDialog());

    strip.append(icon, title, text, link);
    document.body.classList.add(OFFLINE_STRIP_OPEN_CLASS);
}

/** Explains, for beginners, how offline edits meet everyone else’s. */
export function openOfflineMergeDialog(): HTMLElement {
    document.querySelector('.offline-merge-dialog-overlay')?.remove();
    const { overlay, close } = mountModalOverlay({
        closeSelector: '.info-popup-close',
        onDismiss: () => {},
        innerHTML: `
        <div class="info-popup offline-merge-dialog" role="dialog" aria-labelledby="offline-merge-dialog-title">
            <div class="info-popup-header">
                <h3 id="offline-merge-dialog-title">When you reconnect</h3>
                <button type="button" class="info-popup-close" aria-label="Close">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="info-popup-content">
                <p>While you’re offline, your edits are saved in this browser. When you reconnect, they’re sent to the cloud and combined with what others changed in the meantime.</p>
                <p><b>Changes to different things are all kept.</b> If you moved a point in one glyph and someone else kerned a pair, both changes stay.</p>
                <p><b>If you both changed the same thing, only one change is kept.</b> That can be the same point, the same width, the same kerning pair or the same feature. The same goes for the shape of a glyph: if you both added or deleted points or contours in the same drawing, only one of your versions of that drawing is kept.</p>
                <p><b>Which change is kept is decided at random</b>, not by who edited last. Everyone ends up with the same result.</p>
                <p>To avoid surprises, agree on who works on which glyphs. That’s also why editing pauses after 5 minutes offline: the longer you work apart, the more your changes can overlap.</p>
                <div class="dialog-actions">
                    <button type="button" class="dialog-button" data-action="docs">Learn more</button>
                    <button type="button" class="dialog-button dialog-button-primary" data-action="close">OK</button>
                </div>
            </div>
        </div>
    `
    });
    overlay.classList.add('offline-merge-dialog-overlay');
    overlay
        .querySelector('[data-action="close"]')
        ?.addEventListener('click', close);
    overlay
        .querySelector('[data-action="docs"]')
        ?.addEventListener('click', () => {
            close();
            void window.openDocs?.(DOCS_PAGE, DOCS_HEADING);
        });
    (
        overlay.querySelector('[data-action="close"]') as HTMLElement | null
    )?.focus({ preventScroll: true });
    return overlay;
}

export function initOfflineStrip(): void {
    window.addEventListener(OFFLINE_LEVEL_EVENT, (event) => {
        const level = (event as CustomEvent<{ level?: OfflineLevel }>).detail
            ?.level;
        renderOfflineStrip(
            level === 'offline' || level === 'paused' ? level : 'none'
        );
    });
}
