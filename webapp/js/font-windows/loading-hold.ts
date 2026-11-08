// The loading screen stays up while a font window waits for the user (to
// allow access, choose a folder, or read why a font can't open). Whatever
// hides the loading screen asks `whenLoadingScreenFree` first.

let holds = 0;
let waiting: Array<() => void> = [];

/** Keep the loading screen up until the returned function is called. */
export function holdLoadingScreen(): () => void {
    holds++;
    // Shown again if it was already on its way out.
    const overlay = document.getElementById('loading-overlay');
    if (overlay?.classList.contains('hidden')) {
        overlay.classList.remove('hidden');
        document.querySelector('.loading-logo')?.classList.remove('fade-out');
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        holds--;
        if (holds > 0) return;
        const run = waiting;
        waiting = [];
        run.forEach((hide) => hide());
    };
}

/** Run `hide` now, or once nothing holds the loading screen. */
export function whenLoadingScreenFree(hide: () => void): void {
    if (holds === 0) {
        hide();
        return;
    }
    waiting.push(hide);
}

export const isLoadingScreenHeld = () => holds > 0;
