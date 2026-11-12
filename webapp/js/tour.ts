/**
 * Interactive app tour. Starts with an intro modal after the first-launch
 * folder prompt, then spotlight slides. Every slide can be ended, stepped
 * back from, or (action slides) restarted; each rebuilds its `stage`.
 */

import { hideAll as hideAllTippies } from 'tippy.js';
import { Logger } from './logger';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';
import { showUnsavedChangesDialog } from './ui/confirm-dialog';
import {
    getTourSlideByIndex,
    TOUR_FUSTAT_PATH,
    TOUR_SLIDE_ORDER
} from './tour-slides';
import {
    beginTourSlideRestore,
    getCurrentTourSlide,
    hideTourSpotlight,
    isTourSlideIdle,
    showTourSlide,
    transitionTourSlide,
    type TourNavigation
} from './tour-spotlight';
import {
    captureTourGlyphSnapshot,
    captureTourViewport,
    isTourStageIntact,
    restoreTourGlyphSnapshot,
    restoreTourStage,
    restoreTourViewport,
    type TourGlyphSnapshot,
    type TourViewport
} from './tour-stage';
import { resetTourDrawingSession } from './tour-drawing';

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

/** Let a wrong-glyph or wrong-mode state settle before restoring the step. */
const STAGE_WATCHDOG_DELAY_MS = 400;

type TourHost = {
    introShownThisLoad: boolean;
    introOverlay: HTMLElement | null;
    launchChip: HTMLElement | null;
    escapeBinding: ModalEscapeBinding | null;
    starting: boolean;
    slideIndex: number;
    /** Bumped by every navigation and by ending the tour. */
    navToken: number;
    /** Drawing glyph as it was when each slide was first reached. */
    snapshots: Array<TourGlyphSnapshot | null>;
    /** Canvas zoom and pan once each slide was first shown. */
    viewports: Array<TourViewport | null>;
    /** Font the snapshots belong to. */
    snapshotFont: unknown;
    watchdogTimer: number;
    unbindWatchdog: (() => void) | null;
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
            slideIndex: 0,
            navToken: 0,
            snapshots: [],
            viewports: [],
            snapshotFont: null,
            watchdogTimer: 0,
            unbindWatchdog: null
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

function markTourStarted(): void {
    try {
        localStorage.setItem(STARTED_STORAGE_KEY, 'true');
    } catch {
        // Ignore localStorage access failures.
    }
    updateTourLaunchButton();
}

function endTourSession(): void {
    const host = getHost();
    host.navToken += 1;
    host.unbindWatchdog?.();
    host.unbindWatchdog = null;
    window.clearTimeout(host.watchdogTimer);
    resetTourDrawingSession();
    hideTourSpotlight();
}

export function completeTour(): void {
    try {
        localStorage.setItem(COMPLETED_STORAGE_KEY, 'true');
        localStorage.setItem(LAUNCH_BUTTON_DISMISSED_STORAGE_KEY, 'true');
    } catch {
        // Ignore localStorage access failures.
    }
    endTourSession();
    updateTourLaunchButton();
}

/** Ends the tour where it is. Title bar and Help menu can start it again. */
export function cancelTour(): void {
    endTourSession();
    skipTour();
    console.log('Cancelled tour at', TOUR_SLIDE_ORDER[getHost().slideIndex]);
}

function navigationFor(index: number): TourNavigation {
    return {
        onContinue: onTourContinue,
        onBack: index > 0 ? () => void goToTourSlide(index - 1) : undefined,
        onRestart: () => void goToTourSlide(index),
        onCancel: cancelTour
    };
}

function rememberSlideSnapshot(index: number): void {
    const host = getHost();
    if (host.snapshots[index] === undefined) {
        host.snapshots[index] = captureTourGlyphSnapshot();
    }
}

function rememberSlideViewport(index: number): void {
    const host = getHost();
    if (host.slideIndex === index && host.viewports[index] === undefined) {
        host.viewports[index] = captureTourViewport();
    }
}

/**
 * Viewport a slide is restored to. Every component slide uses the one
 * Component Glyphs fitted, so going back does not zoom out to the text.
 */
function savedViewportFor(index: number): TourViewport | null {
    const host = getHost();
    const slide = getTourSlideByIndex(index);
    if (slide?.stage.kind === 'edieresis') {
        for (let i = index - 1; i >= 0; i--) {
            if (getTourSlideByIndex(i)?.stage.kind !== 'edieresis') {
                return host.viewports[i] ?? null;
            }
        }
    }
    return host.viewports[index] ?? null;
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
    // Going forward again after Back replays the slide from here.
    host.snapshots.length = nextIndex;
    host.viewports.length = nextIndex;
    rememberSlideSnapshot(nextIndex);
    void transitionTourSlide(nextSlide, navigationFor(nextIndex)).then(() =>
        rememberSlideViewport(nextIndex)
    );
}

/**
 * Back (`index` = current - 1) and Restart step (`index` = current):
 * rebuild that slide’s stage and outlines, then show it.
 */
async function goToTourSlide(index: number): Promise<void> {
    const host = getHost();
    const slide = getTourSlideByIndex(index);
    if (!slide) {
        return;
    }
    const token = ++host.navToken;
    window.clearTimeout(host.watchdogTimer);
    try {
        await beginTourSlideRestore();
        if (token !== host.navToken) {
            return;
        }
        host.slideIndex = index;
        await restoreTourStage(slide.stage, host.snapshots[index] ?? null);
        if (token !== host.navToken) {
            return;
        }
        const viewport = savedViewportFor(index);
        if (viewport) {
            restoreTourViewport(viewport);
        }
        await showTourSlide(slide, navigationFor(index));
        rememberSlideViewport(index);
        console.log('Tour moved to', slide.id);
    } catch (error) {
        console.error('Failed to restore tour slide', slide.id, error);
        if (token === host.navToken) {
            await showTourSlide(slide, navigationFor(index));
        }
    }
}

function checkTourStage(): void {
    const host = getHost();
    host.watchdogTimer = 0;
    const slide = getCurrentTourSlide();
    if (!slide || !isTourSlideIdle() || isTourStageIntact(slide.stage)) {
        return;
    }
    console.log('Tour left the stage of', slide.id, '- restoring');
    void goToTourSlide(host.slideIndex);
}

/** Restores the step when the user ends up in a state it cannot continue from. */
function bindTourStageWatchdog(): void {
    const host = getHost();
    if (host.unbindWatchdog) {
        return;
    }
    const schedule = () => {
        window.clearTimeout(host.watchdogTimer);
        host.watchdogTimer = window.setTimeout(
            checkTourStage,
            STAGE_WATCHDOG_DELAY_MS
        );
    };
    const events = [
        'editorModeChanged',
        'glyphStackChanged',
        'glyphCanvasRendered'
    ];
    for (const type of events) {
        window.addEventListener(type, schedule);
    }
    host.unbindWatchdog = () => {
        for (const type of events) {
            window.removeEventListener(type, schedule);
        }
    };
}

/** A restarted tour starts from the outlines the first run found. */
function resetTourSnapshots(): void {
    const host = getHost();
    const font = window.fontManager?.currentFont ?? null;
    const pristine = host.snapshots[0];
    host.viewports = [];
    if (font && host.snapshotFont === font && pristine) {
        restoreTourGlyphSnapshot(pristine);
        host.snapshots = [pristine];
        return;
    }
    host.snapshotFont = font;
    host.snapshots = [captureTourGlyphSnapshot()];
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
        endTourSession();
        // An open menu would float above the spotlight, unreachable.
        hideAllTippies({ duration: 0 });
        host.slideIndex = 0;
        resetTourSnapshots();
        const slide = getTourSlideByIndex(0);
        if (!slide) {
            console.error('Tour has no slides');
            return;
        }
        await restoreTourStage(slide.stage, null);
        await showTourSlide(slide, navigationFor(0));
        rememberSlideViewport(0);
        bindTourStageWatchdog();
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
