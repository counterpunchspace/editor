let loadingCursorCount = 0;
let loadingCursorSpinner: HTMLDivElement | null = null;
let spinnerAnimation: Animation | null = null;
let pointerTrackingInitialized = false;
let lastPointerX: number | null = null;
let lastPointerY: number | null = null;

const SPINNER_OFFSET_PX = 18;
const BUSY_CLASS = 'loading-cursor';
const POINTER_STORAGE_KEY = 'loadingCursorLastPointer';
const canUseLoadingCursorDom =
    typeof window !== 'undefined' && typeof document !== 'undefined';

function restoreStoredPointerPosition(): void {
    if (!canUseLoadingCursorDom || typeof sessionStorage === 'undefined') {
        return;
    }

    try {
        const raw = sessionStorage.getItem(POINTER_STORAGE_KEY);
        if (!raw) {
            return;
        }

        const parsed = JSON.parse(raw) as { x?: number; y?: number };
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
            lastPointerX = parsed.x;
            lastPointerY = parsed.y;
        }
    } catch {
        // Ignore storage parsing/access errors
    }
}

function persistPointerPosition(): void {
    if (!canUseLoadingCursorDom || typeof sessionStorage === 'undefined') {
        return;
    }

    if (lastPointerX === null || lastPointerY === null) {
        return;
    }

    try {
        sessionStorage.setItem(
            POINTER_STORAGE_KEY,
            JSON.stringify({ x: lastPointerX, y: lastPointerY })
        );
    } catch {
        // Ignore storage write/access errors
    }
}

function getSpinnerPosition(): { x: number; y: number } {
    if (!canUseLoadingCursorDom) {
        return { x: 0, y: 0 };
    }

    const fallbackX = Math.round(window.innerWidth / 2);
    const fallbackY = Math.round(window.innerHeight / 2);
    const x = lastPointerX ?? fallbackX;
    const y = lastPointerY ?? fallbackY;

    return {
        x: Math.max(0, Math.min(window.innerWidth - 1, x + SPINNER_OFFSET_PX)),
        y: Math.max(0, Math.min(window.innerHeight - 1, y + SPINNER_OFFSET_PX))
    };
}

function updateSpinnerPosition(): void {
    if (!loadingCursorSpinner || loadingCursorCount === 0) {
        return;
    }

    const { x, y } = getSpinnerPosition();
    loadingCursorSpinner.style.left = `${x}px`;
    loadingCursorSpinner.style.top = `${y}px`;
}

function initializePointerTracking(): void {
    if (!canUseLoadingCursorDom) {
        return;
    }

    if (pointerTrackingInitialized) {
        return;
    }

    pointerTrackingInitialized = true;
    restoreStoredPointerPosition();

    window.addEventListener('mousemove', (event: MouseEvent) => {
        lastPointerX = event.clientX;
        lastPointerY = event.clientY;
        persistPointerPosition();
        updateSpinnerPosition();
    });
}

function getOrCreateLoadingCursorSpinner(): HTMLDivElement {
    if (!canUseLoadingCursorDom) {
        throw new Error('Loading cursor spinner requires browser DOM access.');
    }

    if (loadingCursorSpinner) {
        return loadingCursorSpinner;
    }

    const spinner = document.createElement('div');
    spinner.id = 'loading-cursor-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    spinner.style.position = 'fixed';
    spinner.style.width = '12px';
    spinner.style.height = '12px';
    spinner.style.border = '2px solid var(--text-primary)';
    spinner.style.borderTopColor = 'transparent';
    spinner.style.borderRadius = '50%';
    spinner.style.background = 'transparent';
    spinner.style.pointerEvents = 'none';
    spinner.style.zIndex = '2147483647';
    spinner.style.display = 'none';

    loadingCursorSpinner = spinner;
    return spinner;
}

function showCursorSpinner(body: HTMLElement): void {
    const spinner = getOrCreateLoadingCursorSpinner();
    if (!spinner.isConnected) {
        body.appendChild(spinner);
    }

    updateSpinnerPosition();
    spinner.style.display = 'block';

    if (typeof spinner.animate !== 'function') {
        return;
    }

    if (!spinnerAnimation) {
        spinnerAnimation = spinner.animate(
            [
                { transform: 'translate(-50%, -50%) rotate(0deg)' },
                { transform: 'translate(-50%, -50%) rotate(360deg)' }
            ],
            {
                duration: 700,
                iterations: Infinity,
                easing: 'linear'
            }
        );
    } else {
        spinnerAnimation.play();
    }
}

function hideCursorSpinner(): void {
    if (loadingCursorSpinner) {
        loadingCursorSpinner.style.display = 'none';
    }

    if (spinnerAnimation) {
        spinnerAnimation.pause();
    }
}

/**
 * The mouse pointer itself shows the system's busy cursor, everywhere,
 * over elements that set their own cursor too (the canvas does, inline).
 */
function ensureBusyCursorStyle(): void {
    if (document.getElementById('loading-cursor-style')) return;
    const style = document.createElement('style');
    style.id = 'loading-cursor-style';
    style.textContent = `html.${BUSY_CLASS}, html.${BUSY_CLASS} * { cursor: progress !important; }`;
    document.head.append(style);
}

function applyLoadingCursor(): void {
    if (!canUseLoadingCursorDom) {
        return;
    }

    ensureBusyCursorStyle();
    document.documentElement.classList.add(BUSY_CLASS);

    const body = document.body;

    if (!body) {
        return;
    }

    showCursorSpinner(body);
}

function clearLoadingCursor(): void {
    if (!canUseLoadingCursorDom) {
        return;
    }

    document.documentElement.classList.remove(BUSY_CLASS);
    hideCursorSpinner();
}

/** Show the busy cursor while `work` runs, however it ends. */
export async function withLoadingCursor<T>(work: () => Promise<T>): Promise<T> {
    beginLoadingCursor();
    try {
        return await work();
    } finally {
        endLoadingCursor();
    }
}

export function beginLoadingCursor(): void {
    if (!canUseLoadingCursorDom) {
        return;
    }

    loadingCursorCount += 1;

    if (loadingCursorCount === 1) {
        applyLoadingCursor();
    }
}

export function endLoadingCursor(): void {
    if (!canUseLoadingCursorDom) {
        return;
    }

    if (loadingCursorCount > 0) {
        loadingCursorCount -= 1;
    }

    if (loadingCursorCount === 0) {
        clearLoadingCursor();
    }
}

if (canUseLoadingCursorDom) {
    initializePointerTracking();
}
