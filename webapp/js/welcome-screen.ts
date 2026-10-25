/**
 * Versioned welcome modal shown once after the loading overlay fades.
 * Bump WELCOME_VERSION when the copy changes so dismissed users see it again.
 */

import { Logger } from './logger';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';

const console = new Logger('WelcomeScreen');

export const WELCOME_VERSION = 2;

/**
 * Version of the welcome screen last dismissed by the user.
 * Unset until the current WELCOME_VERSION is dismissed.
 */
const STORAGE_KEY = 'welcomeDismissedVersion';

const LOADING_OVERLAY_FADE_FALLBACK_MS = 1200;

let overlayHideNotified = false;
let welcomeShownThisLoad = false;

function isAutomatedSession(): boolean {
    // Only `?test=true`. Do not use navigator.webdriver / window.isTest():
    // the local Chrome session used with DevTools is often webdriver-flagged.
    return !!window.isTestMode?.();
}

export function hasDismissedCurrentWelcome(): boolean {
    try {
        return Number(localStorage.getItem(STORAGE_KEY)) === WELCOME_VERSION;
    } catch {
        return false;
    }
}

export function dismissCurrentWelcome(): void {
    try {
        localStorage.setItem(STORAGE_KEY, String(WELCOME_VERSION));
    } catch {
        // Ignore localStorage access failures.
    }
}

function shouldOfferWelcome(): boolean {
    return (
        !isAutomatedSession() &&
        !welcomeShownThisLoad &&
        !hasDismissedCurrentWelcome()
    );
}

function showWelcomeModal(): void {
    if (welcomeShownThisLoad) {
        return;
    }
    welcomeShownThisLoad = true;

    const overlay = document.createElement('div');
    overlay.className = 'info-popup-overlay';
    overlay.style.display = 'flex';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'welcome-screen-title');

    overlay.innerHTML = `
        <div class="info-popup confirm-dialog">
            <div class="info-popup-header">
                <h3 id="welcome-screen-title">Welcome</h3>
                <button type="button" class="info-popup-close confirm-dialog-close-btn" aria-label="Dismiss">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="info-popup-content confirm-dialog-content">
                <p>This font editor is in <strong>early beta</strong>. The main features are in place, but some still need finishing, and the interface and workflows still need polish. See <a href="https://github.com/counterpunchspace/editor#feature-overview" target="_blank" rel="noopener noreferrer">this overview</a> for details.</p>
                <p>Help to improve the experience by <a href="https://github.com/counterpunchspace/editor/issues" target="_blank" rel="noopener noreferrer">reporting bugs or requesting features</a> or <a href="https://github.com/counterpunchspace/editor/discussions" target="_blank" rel="noopener noreferrer">discuss issues</a>.</p>
                <p>Create awesome fonts!</p>
                <div class="confirm-dialog-actions">
                    <button type="button" class="dialog-button dialog-button-primary" data-action="dismiss">Got it</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    let escapeBinding: ModalEscapeBinding | null = null;

    function close(): void {
        escapeBinding?.release();
        escapeBinding = null;
        overlay.remove();
        dismissCurrentWelcome();
        console.log('Dismissed welcome version', WELCOME_VERSION);
        dispatchWelcomeScreenSettled();
    }

    escapeBinding = bindModalEscape(close, {
        isOpen: () => overlay.isConnected
    });

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            close();
        }
    });

    overlay
        .querySelector('.confirm-dialog-close-btn')
        ?.addEventListener('click', close);

    overlay
        .querySelector('[data-action="dismiss"]')
        ?.addEventListener('click', close);

    queueMicrotask(() => {
        const dismissBtn = overlay.querySelector(
            '[data-action="dismiss"]'
        ) as HTMLElement | null;
        dismissBtn?.focus();
    });
}

/**
 * Fired after the welcome modal is dismissed, or skipped, once the loading
 * overlay fade has finished.
 */
function dispatchWelcomeScreenSettled(): void {
    window.dispatchEvent(new CustomEvent('welcomeScreenSettled'));
}

/**
 * Arm the welcome modal after the loading overlay starts hiding.
 * Waits for the opacity fade (with a timeout fallback). Idempotent per page load.
 */
export function notifyLoadingOverlayHiding(): void {
    if (overlayHideNotified) {
        return;
    }
    overlayHideNotified = true;
    let fadeCallbackDone = false;

    const loadingOverlay = document.getElementById('loading-overlay');
    const openOnce = () => {
        if (fadeCallbackDone) {
            return;
        }
        fadeCallbackDone = true;
        if (shouldOfferWelcome()) {
            showWelcomeModal();
            return;
        }
        dispatchWelcomeScreenSettled();
    };

    if (
        !loadingOverlay ||
        window.getComputedStyle(loadingOverlay).opacity === '0'
    ) {
        openOnce();
        return;
    }

    const onEnd = (event: TransitionEvent) => {
        if (event.target !== loadingOverlay) {
            return;
        }
        if (event.propertyName && event.propertyName !== 'opacity') {
            return;
        }
        loadingOverlay.removeEventListener('transitionend', onEnd);
        openOnce();
    };

    loadingOverlay.addEventListener('transitionend', onEnd);
    window.setTimeout(() => {
        loadingOverlay.removeEventListener('transitionend', onEnd);
        openOnce();
    }, LOADING_OVERLAY_FADE_FALLBACK_MS);
}
