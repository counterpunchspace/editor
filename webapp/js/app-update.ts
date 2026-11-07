// Moving every open Counterpunch window to a new version together.
//
// A new version installs in the background and waits. Once it takes over
// (Update in Preferences or in the launcher), every window learns about it
// here. Windows that hold no unsaved work reload into the new version; the
// others keep their work and offer a reload. Linked windows only link with
// windows of the same build (font-windows/window-registry.ts), so a window
// that is still on the old version never mixes with the new ones.

/** This window's build. Linked windows must share it. */
export const APP_BUILD = `${process.env.EDITOR_VERSION ?? ''}+${process.env.BUILD_HASH_FULL ?? ''}`;

let applying = false;

/** This window asked for the update and reloads by itself. */
export function markApplyingUpdate(): void {
    applying = true;
}

export const isApplyingUpdate = () => applying;

/**
 * Whether a window reloads once a new version has taken over.
 * - The window that asked for the update reloads by itself.
 * - A window with unsaved work keeps it and asks instead.
 * - A same-font view window follows its main window.
 */
export function shouldReloadForUpdate(state: {
    applying: boolean;
    hasUnsavedWork: boolean;
    isView?: boolean;
    mainHasUnsavedWork?: boolean;
}): boolean {
    if (state.applying) return false;
    if (state.isView) return !state.mainHasUnsavedWork;
    return !state.hasUnsavedWork;
}

/**
 * Call `handler` once when a newer version takes over this page. The very
 * first install of the service worker is not an update.
 */
export function onNewVersionActive(handler: () => void): void {
    const sw =
        typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    if (!sw?.controller) return;
    let fired = false;
    const fire = () => {
        if (fired) return;
        fired = true;
        handler();
    };
    sw.addEventListener('message', (event: MessageEvent) => {
        if ((event.data as { type?: unknown } | null)?.type === 'SW_UPDATED')
            fire();
    });
    sw.addEventListener('controllerchange', fire);
}

/** A downloaded update that waits to take over, if any. */
export async function waitingUpdate(): Promise<ServiceWorker | null> {
    const sw = navigator.serviceWorker;
    if (!sw?.controller) return null;
    const registration = await sw.getRegistration();
    return registration?.waiting ?? null;
}

/** Let the waiting update take over; every window then follows. */
export function activateUpdate(worker: ServiceWorker): void {
    markApplyingUpdate();
    worker.postMessage({ type: 'SKIP_WAITING' });
}
