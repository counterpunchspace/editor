/**
 * Interactive app tour. Starts with an intro modal after the first-launch
 * folder prompt, then spotlight slides (added later).
 */

import { Logger } from './logger';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';
import { showUnsavedChangesDialog } from './ui/confirm-dialog';
import {
    getTourSlideByIndex,
    selectTourMasterByName,
    TOUR_FUSTAT_PATH,
    TOUR_REGULAR_MASTER_NAME,
    TOUR_SAMPLE_TEXT,
    TOUR_SLIDE_ORDER
} from './tour-slides';
import {
    hideTourSpotlight,
    showTourSlide,
    transitionTourSlide,
    wait
} from './tour-spotlight';

const console = new Logger('Tour');

export const TOUR_LAUNCH_BUTTON_LABEL = 'Take a Tour';

/**
 * Set when the user skips the tour intro. Shows the title-bar launch chip
 * until that chip is dismissed.
 */
const SKIPPED_STORAGE_KEY = 'tourSkipped';

/**
 * Set when the user starts the tour from the intro. Prevents the intro from
 * auto-opening again on later launches.
 */
const STARTED_STORAGE_KEY = 'tourStarted';

/**
 * Set when the user dismisses the title-bar Take a Tour chip.
 */
const LAUNCH_BUTTON_DISMISSED_STORAGE_KEY = 'tourLaunchButtonDismissed';

/**
 * Set when the user finishes the tour. Permanently hides the title-bar
 * Take a Tour chip.
 */
const COMPLETED_STORAGE_KEY = 'tourCompleted';

type TourHost = {
    introShownThisLoad: boolean;
    introOverlay: HTMLElement | null;
    launchChip: HTMLElement | null;
    escapeBinding: ModalEscapeBinding | null;
    starting: boolean;
    slideIndex: number;
};

function getHost(): TourHost {
    const holder = window as Window & { __tourHost?: TourHost };
    if (!holder.__tourHost) {
        holder.__tourHost = {
            introShownThisLoad: false,
            introOverlay: null,
            launchChip: null,
            escapeBinding: null,
            starting: false,
            slideIndex: 0
        };
    }
    return holder.__tourHost;
}

function isAutomatedSession(): boolean {
    return !!window.isTestMode?.();
}

export function hasSkippedTour(): boolean {
    try {
        return localStorage.getItem(SKIPPED_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

export function hasStartedTour(): boolean {
    try {
        return localStorage.getItem(STARTED_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

export function hasDismissedTourLaunchButton(): boolean {
    try {
        return (
            localStorage.getItem(LAUNCH_BUTTON_DISMISSED_STORAGE_KEY) === 'true'
        );
    } catch {
        return false;
    }
}

export function hasCompletedTour(): boolean {
    try {
        return localStorage.getItem(COMPLETED_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

function shouldAutoOfferIntro(): boolean {
    return (
        !isAutomatedSession() &&
        !hasSkippedTour() &&
        !hasStartedTour() &&
        !hasCompletedTour() &&
        !getHost().introShownThisLoad
    );
}

export function skipTour(): void {
    try {
        localStorage.setItem(SKIPPED_STORAGE_KEY, 'true');
    } catch {
        // Ignore localStorage access failures.
    }
    updateTourLaunchButton();
}

export function dismissTourLaunchButton(): void {
    try {
        localStorage.setItem(LAUNCH_BUTTON_DISMISSED_STORAGE_KEY, 'true');
    } catch {
        // Ignore localStorage access failures.
    }
    updateTourLaunchButton();
}

function closeTourIntro(): void {
    const host = getHost();
    host.escapeBinding?.release();
    host.escapeBinding = null;
    host.introOverlay?.remove();
    host.introOverlay = null;
}

function skipAndCloseIntro(): void {
    skipTour();
    closeTourIntro();
    console.log('Skipped tour');
}

function isMemoryFustatOpen(): boolean {
    const font = window.fontManager?.currentFont;
    if (!font?.path || font.sourcePlugin?.getId?.() !== 'memory') {
        return false;
    }
    return /(^|\/)Fustat\.glyphs$/.test(font.path);
}

async function confirmUnsavedChangesForTour(): Promise<boolean> {
    const fontManager = window.fontManager;
    const currentFont = fontManager?.currentFont;
    if (!currentFont || !fontManager?.hasUnsyncedChanges?.(currentFont)) {
        return true;
    }

    const choice = await showUnsavedChangesDialog(
        currentFont.name || 'Untitled'
    );
    if (choice === 'cancel') {
        return false;
    }
    if (choice === 'save') {
        if (!currentFont.fileHandle && !currentFont.isCloudBacked()) {
            await window.saveFontAs?.();
        } else {
            await window.saveButton?.handleSave?.();
        }
    }
    return true;
}

function waitForFontInteractiveReady(path: string): Promise<void> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            window.removeEventListener('fontInteractiveReady', onReady);
            window.clearTimeout(timeoutId);
            resolve();
        };
        const onReady = (event: Event) => {
            const detail = (event as CustomEvent<{ path?: string | null }>)
                .detail;
            const filename = path.split('/').pop() || path;
            if (detail?.path && !String(detail.path).includes(filename)) {
                return;
            }
            finish();
        };
        const timeoutId = window.setTimeout(finish, 20000);
        window.addEventListener('fontInteractiveReady', onReady);
    });
}

async function openFustatForTour(): Promise<boolean> {
    if (isMemoryFustatOpen()) {
        return true;
    }

    const allowed = await confirmUnsavedChangesForTour();
    if (!allowed) {
        return false;
    }

    const memoryPlugin = window.pluginRegistry?.get?.('memory');
    if (!memoryPlugin) {
        console.error('Memory plugin is not available');
        return false;
    }

    const ready = waitForFontInteractiveReady(TOUR_FUSTAT_PATH);
    await window.openFont?.(TOUR_FUSTAT_PATH, undefined, {
        sourcePluginOverride: memoryPlugin
    });
    await ready;
    return true;
}

function viewAnimationDelayMs(): number {
    const animation = window.VIEW_SETTINGS?.animation;
    if (animation?.enabled && typeof animation.duration === 'number') {
        return animation.duration + 40;
    }
    return 0;
}

function waitForNextAnimationFrame(): Promise<void> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => resolve());
    });
}

async function maximizeEditorView(): Promise<void> {
    window.focusView?.('view-editor');
    await wait(viewAnimationDelayMs());
    window.resizeView?.('view-editor');
    await wait(viewAnimationDelayMs());
    window.resizeView?.('view-editor');
    await wait(viewAnimationDelayMs());
}

/** Same settle + fit as font load after the sample text is set. */
async function fitTourSampleTextViewport(): Promise<void> {
    await waitForTourSampleCompiledGlyphs();
    await waitForNextAnimationFrame();
    await waitForNextAnimationFrame();
    await window.glyphCanvas?.applyInitialViewportFit?.();
}

function tourSampleTextHasCompiledGlyphs(): boolean {
    const textRun = window.glyphCanvas?.textRunEditor;
    const glyphs = textRun?.shapedGlyphs || [];
    if (glyphs.length === 0) {
        return false;
    }
    const names = textRun?.glyphNameBuffer;
    if (Array.isArray(names) && names.length === glyphs.length) {
        return names.every((name) => !!name && name !== '.notdef');
    }
    return glyphs.every((glyph) => (glyph.g ?? 0) !== 0);
}

async function waitForTourSampleCompiledGlyphs(): Promise<void> {
    if (tourSampleTextHasCompiledGlyphs()) {
        return;
    }
    const started = Date.now();
    await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            window.removeEventListener('glyphCanvasRendered', onPulse);
            window.clearInterval(intervalId);
            resolve();
        };
        const onPulse = () => {
            if (
                tourSampleTextHasCompiledGlyphs() ||
                Date.now() - started >= 8000
            ) {
                finish();
            }
        };
        const intervalId = window.setInterval(onPulse, 50);
        window.addEventListener('glyphCanvasRendered', onPulse);
    });
}

async function resetReachableOpenTypeFeatures(): Promise<void> {
    const manager = window.glyphCanvas?.featuresManager;
    if (typeof manager?.setEnabledFeatures === 'function') {
        try {
            await manager.setEnabledFeatures([]);
            return;
        } catch {
            // Features UI may not be ready; fall through to button clicks.
        }
    }

    const buttons = document.querySelectorAll<HTMLButtonElement>(
        'button[data-feature-tag]'
    );
    for (const button of buttons) {
        if (button.disabled || !button.classList.contains('enabled')) {
            continue;
        }
        button.click();
    }
}

async function prepareEditorForFirstSlide(): Promise<void> {
    await maximizeEditorView();
    const canvas = window.glyphCanvas;
    if (canvas?.outlineEditor?.active) {
        canvas.exitGlyphEditMode();
    }
    await selectTourMasterByName(TOUR_REGULAR_MASTER_NAME);
    canvas?.outlineEditor?.setGuidelinesVisible?.(false);
    await resetReachableOpenTypeFeatures();
    canvas?.textRunEditor?.setTextBuffer(TOUR_SAMPLE_TEXT);
    await fitTourSampleTextViewport();
}

function markTourStarted(): void {
    try {
        localStorage.setItem(STARTED_STORAGE_KEY, 'true');
    } catch {
        // Ignore localStorage access failures.
    }
    updateTourLaunchButton();
}

export function completeTour(): void {
    try {
        localStorage.setItem(COMPLETED_STORAGE_KEY, 'true');
        localStorage.setItem(LAUNCH_BUTTON_DISMISSED_STORAGE_KEY, 'true');
    } catch {
        // Ignore localStorage access failures.
    }
    hideTourSpotlight();
    updateTourLaunchButton();
}

function onTourContinue(): void {
    const host = getHost();
    const nextIndex = host.slideIndex + 1;
    const nextSlide = getTourSlideByIndex(nextIndex);
    if (!nextSlide) {
        completeTour();
        console.log('Completed tour');
        return;
    }
    host.slideIndex = nextIndex;
    void transitionTourSlide(nextSlide, onTourContinue);
}

async function presentCurrentSlide(): Promise<void> {
    const host = getHost();
    const slide = getTourSlideByIndex(host.slideIndex);
    if (!slide) {
        console.error('Tour slide missing at', host.slideIndex);
        return;
    }
    await showTourSlide(slide, onTourContinue);
}

/**
 * Begins the spotlight tour after opening the sample font.
 */
export async function startTour(): Promise<void> {
    const host = getHost();
    if (host.starting) {
        return;
    }
    host.starting = true;
    try {
        const opened = await openFustatForTour();
        if (!opened) {
            return;
        }
        markTourStarted();
        closeTourIntro();
        host.slideIndex = 0;
        await prepareEditorForFirstSlide();
        await presentCurrentSlide();
        console.log(
            'Started tour',
            TOUR_SLIDE_ORDER[host.slideIndex] || '(empty)'
        );
    } catch (error) {
        console.error('Failed to start tour', error);
    } finally {
        host.starting = false;
    }
}

function takeTourFromIntro(): void {
    void startTour();
}

export function openTourIntro(): void {
    const host = getHost();
    if (host.introOverlay?.isConnected) {
        return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'info-popup-overlay tour-intro-overlay';
    overlay.style.display = 'flex';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'tour-intro-title');
    overlay.innerHTML = `
        <div class="info-popup confirm-dialog">
            <div class="info-popup-header">
                <h3 id="tour-intro-title">Take a Tour</h3>
                <button type="button" class="info-popup-close confirm-dialog-close-btn" aria-label="Skip">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="info-popup-content confirm-dialog-content">
                <p>Ready to create? Take a short 5-minute tour of the app and learn how to edit fonts.</p>
            </div>
            <div class="confirm-dialog-actions tour-intro-actions">
                <button type="button" class="dialog-button" data-action="skip">Skip</button>
                <button type="button" class="dialog-button dialog-button-primary" data-action="start">${TOUR_LAUNCH_BUTTON_LABEL}</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    host.introOverlay = overlay;
    host.introShownThisLoad = true;

    host.escapeBinding?.release();
    host.escapeBinding = bindModalEscape(skipAndCloseIntro, {
        isOpen: () => overlay.isConnected
    });

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            skipAndCloseIntro();
        }
    });
    overlay
        .querySelector('.confirm-dialog-close-btn')
        ?.addEventListener('click', skipAndCloseIntro);
    overlay
        .querySelector('[data-action="skip"]')
        ?.addEventListener('click', skipAndCloseIntro);
    overlay
        .querySelector('[data-action="start"]')
        ?.addEventListener('click', takeTourFromIntro);

    queueMicrotask(() => {
        const startBtn = overlay.querySelector(
            '[data-action="start"]'
        ) as HTMLElement | null;
        startBtn?.focus();
    });
}

export function maybeShowTourIntro(): void {
    if (!shouldAutoOfferIntro()) {
        updateTourLaunchButton();
        return;
    }
    openTourIntro();
}

function ensureTourLaunchButton(): HTMLElement | null {
    const host = getHost();
    const existing = document.getElementById('tour-launch-chip');
    if (existing instanceof HTMLElement) {
        host.launchChip = existing;
        return existing;
    }
    if (host.launchChip) {
        return host.launchChip;
    }

    const toolbarRight = document.querySelector('.toolbar-right');
    const settingsBtn = document.getElementById('settings-btn');
    if (!toolbarRight || !settingsBtn) {
        return null;
    }

    const chip = document.createElement('div');
    chip.id = 'tour-launch-chip';
    chip.className = 'toolbar-tour-launch';
    chip.hidden = true;

    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.className = 'toolbar-tour-launch-btn';
    startBtn.textContent = TOUR_LAUNCH_BUTTON_LABEL;
    startBtn.title = TOUR_LAUNCH_BUTTON_LABEL;
    startBtn.addEventListener('click', () => {
        openTourIntro();
    });

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'toolbar-tour-launch-dismiss';
    dismissBtn.setAttribute('aria-label', 'Dismiss Take a Tour');
    dismissBtn.innerHTML =
        '<span class="material-symbols-outlined" aria-hidden="true">close</span>';
    dismissBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        dismissTourLaunchButton();
    });

    chip.append(startBtn, dismissBtn);
    toolbarRight.insertBefore(chip, settingsBtn);
    host.launchChip = chip;
    return chip;
}

export function updateTourLaunchButton(): void {
    const chip = ensureTourLaunchButton();
    if (!chip) {
        return;
    }
    const show =
        hasSkippedTour() &&
        !hasDismissedTourLaunchButton() &&
        !hasCompletedTour();
    chip.hidden = !show;
}

function bindTourListeners(): void {
    const holder = window as Window & {
        __onFolderPermissionsAutoPromptSettled?: () => void;
        __tourFolderPromptListenerBound?: boolean;
    };
    holder.__onFolderPermissionsAutoPromptSettled = () => {
        maybeShowTourIntro();
    };
    if (holder.__tourFolderPromptListenerBound) {
        return;
    }
    holder.__tourFolderPromptListenerBound = true;
    window.addEventListener('folderPermissionsAutoPromptSettled', () => {
        holder.__onFolderPermissionsAutoPromptSettled?.();
    });
}

bindTourListeners();
updateTourLaunchButton();
