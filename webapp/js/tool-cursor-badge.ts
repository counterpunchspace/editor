import {
    POINTER_BADGE_ICONS,
    type EditToolPointerBadge
} from './glyph-canvas/edit-tools';
import { Logger } from './logger';

const console = new Logger('ToolCursorBadge');

const BADGE_OFFSET_PX = 18;
const canUseDom =
    typeof window !== 'undefined' && typeof document !== 'undefined';

let badgeElement: HTMLDivElement | null = null;
let badgeIconElement: HTMLSpanElement | null = null;
let pointerTrackingInitialized = false;
let lastPointerX: number | null = null;
let lastPointerY: number | null = null;
let activeBadge: EditToolPointerBadge | null = null;

function getBadgePosition(): { x: number; y: number } {
    if (!canUseDom) {
        return { x: 0, y: 0 };
    }

    const fallbackX = Math.round(window.innerWidth / 2);
    const fallbackY = Math.round(window.innerHeight / 2);
    const x = lastPointerX ?? fallbackX;
    const y = lastPointerY ?? fallbackY;

    return {
        x: Math.max(0, Math.min(window.innerWidth - 1, x + BADGE_OFFSET_PX)),
        y: Math.max(0, Math.min(window.innerHeight - 1, y + BADGE_OFFSET_PX))
    };
}

function updateBadgePosition(): void {
    if (!badgeElement || !activeBadge) {
        return;
    }

    const { x, y } = getBadgePosition();
    badgeElement.style.left = `${x}px`;
    badgeElement.style.top = `${y}px`;
}

function initializePointerTracking(): void {
    if (!canUseDom || pointerTrackingInitialized) {
        return;
    }

    pointerTrackingInitialized = true;
    window.addEventListener('mousemove', (event: MouseEvent) => {
        lastPointerX = event.clientX;
        lastPointerY = event.clientY;
        updateBadgePosition();
    });
}

function getOrCreateBadgeElement(): HTMLDivElement {
    if (!canUseDom) {
        throw new Error('Tool cursor badge requires browser DOM access.');
    }

    if (badgeElement) {
        return badgeElement;
    }

    const badge = document.createElement('div');
    badge.id = 'tool-cursor-badge';
    badge.setAttribute('aria-hidden', 'true');
    badge.className = 'tool-cursor-badge';
    badge.style.display = 'none';

    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined tool-cursor-badge-icon';
    badge.appendChild(icon);

    badgeIconElement = icon;
    badgeElement = badge;
    return badge;
}

function showBadge(kind: EditToolPointerBadge): void {
    if (!canUseDom) {
        return;
    }

    const body = document.body;
    if (!body) {
        return;
    }

    initializePointerTracking();
    const badge = getOrCreateBadgeElement();
    if (!badge.isConnected) {
        body.appendChild(badge);
    }

    if (badgeIconElement) {
        badgeIconElement.textContent = POINTER_BADGE_ICONS[kind];
    }

    activeBadge = kind;
    updateBadgePosition();
    badge.style.display = 'flex';
}

function hideBadge(): void {
    activeBadge = null;
    if (badgeElement) {
        badgeElement.style.display = 'none';
    }
}

export function setToolCursorBadge(kind: EditToolPointerBadge | null): void {
    if (!canUseDom) {
        return;
    }

    if (!kind) {
        hideBadge();
        return;
    }

    if (activeBadge === kind) {
        updateBadgePosition();
        return;
    }

    showBadge(kind);
    console.log('Tool cursor badge:', kind);
}

export function clearToolCursorBadge(): void {
    hideBadge();
}

if (canUseDom) {
    initializePointerTracking();
}
