// Shared cloud fonts allow offline edits only for a short while. A window
// that stays disconnected longer than the limit stops taking edits, and
// when it reconnects it reloads instead of merging. Edits made before the
// limit wait in the device outbox and are sent after the reload.
//
// Timers don't run while a computer sleeps, so the reconnect also checks
// the elapsed time itself.

export interface OfflineEditLimitOptions {
    limitMs: number;
    /** Editing just paused. */
    onPause: () => void;
    /** The connection came back after editing had paused. */
    onReconnectAfterPause: () => void;
    now?: () => number;
    setTimer?: (run: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

export class OfflineEditLimit {
    private readonly _options: OfflineEditLimitOptions;
    private _wasConnected = false;
    private _disconnectedSince: number | null = null;
    private _timer: unknown = null;
    private _paused = false;

    constructor(options: OfflineEditLimitOptions) {
        this._options = options;
    }

    get paused(): boolean {
        return this._paused;
    }

    /** Time since the connection dropped, or null while connected. */
    get disconnectedForMs(): number | null {
        return this._disconnectedSince === null
            ? null
            : this._now() - this._disconnectedSince;
    }

    noteStatus(status: string): void {
        if (status === 'connected') {
            const pausedNow =
                this._paused ||
                (this._disconnectedSince !== null &&
                    this._now() - this._disconnectedSince >=
                        this._options.limitMs);
            this._wasConnected = true;
            this._disconnectedSince = null;
            this._stopTimer();
            if (pausedNow) {
                this._paused = true;
                this._options.onReconnectAfterPause();
            }
            return;
        }
        // Opening a font isn't a disconnect: count only after a connection.
        if (!this._wasConnected || this._disconnectedSince !== null) return;
        this._disconnectedSince = this._now();
        this._timer = (this._options.setTimer ?? defaultSetTimer)(
            () => this._pause(),
            this._options.limitMs
        );
    }

    /** Forget everything, for example when another font opens. */
    reset(): void {
        this._stopTimer();
        this._wasConnected = false;
        this._disconnectedSince = null;
        this._paused = false;
    }

    private _pause(): void {
        this._timer = null;
        if (this._paused || this._disconnectedSince === null) return;
        this._paused = true;
        this._options.onPause();
    }

    private _stopTimer(): void {
        if (this._timer !== null) {
            (this._options.clearTimer ?? defaultClearTimer)(this._timer);
            this._timer = null;
        }
    }

    private _now(): number {
        return (this._options.now ?? Date.now)();
    }
}

function defaultSetTimer(run: () => void, ms: number): unknown {
    return setTimeout(run, ms);
}

function defaultClearTimer(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
}

/** How long a shared font stays editable without a connection. */
export const OFFLINE_EDIT_LIMIT_MS = 5 * 60 * 1000;
