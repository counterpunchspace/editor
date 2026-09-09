/**
 * Session-wide text-buffer write tracking.
 *
 * Lives on `window` so webpack duplicate copies of textrun/font-manager
 * still share one counter. Once the user or a test writes the buffer,
 * font display_string and default URL/state restore must not clobber it
 * unless the URL explicitly includes `text=`.
 */

const WINDOW_KEY = '__counterpunchUserTextBufferWrites';

type WriteCountHost = {
    [WINDOW_KEY]?: number;
};

function writeCount(): number {
    if (typeof window === 'undefined') {
        return 0;
    }
    const value = (window as WriteCountHost)[WINDOW_KEY];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function markUserTextBufferWritten(): void {
    if (typeof window === 'undefined') {
        return;
    }
    (window as WriteCountHost)[WINDOW_KEY] = writeCount() + 1;
}

export function userTextBufferHasBeenWritten(): boolean {
    return writeCount() > 0;
}
