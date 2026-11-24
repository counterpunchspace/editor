// Shows the user why an edit was refused.
//
// A read-only font refuses every local write with `ReadOnlyFontError`
// (patch-sync-engine.ts). Typing into a read-only font refuses each
// keystroke, so its reason is shown once per font and reason, not once per
// refused edit. Other refusals (a station edit the font worker refused) are
// shown each time: each one is a separate action the user took.

import { reportError, showNotice } from '../font-windows/dialogs';

type ReadOnlyRefusal = Error & { name: 'ReadOnlyFontError'; reason: string };

/** The engine's `ReadOnlyFontError`, recognised without importing the engine. */
export function isReadOnlyFontError(error: unknown): error is ReadOnlyRefusal {
    return (
        error instanceof Error &&
        error.name === 'ReadOnlyFontError' &&
        typeof (error as { reason?: unknown }).reason === 'string'
    );
}

let shownFor: { engine: unknown; reason: string } | null = null;

function currentEngine(): unknown {
    return typeof window !== 'undefined'
        ? ((window as { patchSyncEngine?: unknown }).patchSyncEngine ?? null)
        : null;
}

/**
 * If `error` is a read-only refusal, show its reason unless it was already
 * shown for this font, and return true. Returns false for any other error.
 */
export function noticeReadOnlyRefusal(error: unknown): boolean {
    if (!isReadOnlyFontError(error)) {
        return false;
    }
    const engine = currentEngine();
    if (
        shownFor &&
        shownFor.engine === engine &&
        shownFor.reason === error.reason
    ) {
        return true;
    }
    shownFor = { engine, reason: error.reason };
    showNotice(error.message);
    return true;
}

/**
 * Show a refused edit to the user: a read-only refusal once (see
 * {@link noticeReadOnlyRefusal}), anything else with its own message.
 */
export function reportRefusedEdit(error: unknown): void {
    if (noticeReadOnlyRefusal(error)) {
        console.warn(error);
        return;
    }
    reportError(error);
}

let installed = false;

/**
 * Show read-only refusals that no caller caught, such as an edit refused
 * inside a keyboard or pointer handler. Other uncaught errors are left to
 * the existing error reporting. Safe to call more than once.
 */
export function installReadOnlyRefusalNotices(): void {
    if (installed || typeof window === 'undefined') {
        return;
    }
    installed = true;
    window.addEventListener('error', (event) => {
        noticeReadOnlyRefusal(event.error);
    });
    window.addEventListener('unhandledrejection', (event) => {
        noticeReadOnlyRefusal(event.reason);
    });
}

/** Test hook: forget which read-only reasons were shown. */
export function resetReadOnlyRefusalNoticesForTests(): void {
    shownFor = null;
}
