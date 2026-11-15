// Shared cloud fonts allow offline edits only for a short while.
//
// A few seconds after the connection drops, the window says it is offline
// (level `offline`): editing goes on, and edits wait in the device outbox.
// A short delay keeps quick reconnects, such as the token renewal every 15
// minutes, from flashing a message. After the limit, editing pauses (level
// `paused`), and when the connection returns the window reloads instead of
// merging. Edits made before the pause are sent after the reload.
//
// Timers don't run while a computer sleeps, so the reconnect also checks
// the elapsed time itself.

/** How long a shared font stays editable without a connection. */
export const OFFLINE_EDIT_LIMIT_MS = 5 * 60 * 1000;

/** How long a drop lasts before the window says it is offline. */
export const OFFLINE_NOTICE_DELAY_MS = 5 * 1000;

export type OfflineLevel = 'none' | 'offline' | 'paused';

export interface OfflineEditLimitOptions {
    limitMs: number;
    noticeDelayMs?: number;
    /** Editing just paused. */
    onPause?: () => void;
    /** The connection came back after editing had paused. */
    onReconnectAfterPause: () => void;
    /** The level shown to the user changed. */
    onLevelChange?: (level: OfflineLevel) => void;
    now?: () => number;
    setTimer?: (run: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

export class OfflineEditLimit {
    private readonly _options: OfflineEditLimitOptions;
    private _wasConnected = false;
    private _disconnectedSince: number | null = null;
    private _pauseTimer: unknown = null;
    private _noticeTimer: unknown = null;
    private _level: OfflineLevel = 'none';

    constructor(options: OfflineEditLimitOptions) {
        this._options = options;
    }

    get paused(): boolean {
        return this._level === 'paused';
    }

    get level(): OfflineLevel {
        return this._level;
    }

    /** Time since the connection dropped, or null while connected. */
    get disconnectedForMs(): number | null {
        return this._disconnectedSince === null
            ? null
            : this._now() - this._disconnectedSince;
    }

    noteStatus(status: string): void {
        if (status === 'connected') {
            this._noteConnected();
            return;
        }
        this._noteDisconnected();
    }

    /**
     * The browser reported that the computer went offline. The socket may
     * take a while to notice, so this starts the clock at once.
     */
    noteBrowserOffline(): void {
        this._noteDisconnected();
    }

    /** Forget everything, for example when another font opens. */
    reset(): void {
        this._stopTimers();
        this._wasConnected = false;
        this._disconnectedSince = null;
        this._setLevel('none');
    }

    private _noteConnected(): void {
        const pausedNow =
            this._level === 'paused' ||
            (this._disconnectedSince !== null &&
                this._now() - this._disconnectedSince >= this._options.limitMs);
        this._wasConnected = true;
        this._disconnectedSince = null;
        this._stopTimers();
        if (pausedNow) {
            this._setLevel('paused');
            this._options.onReconnectAfterPause();
            return;
        }
        this._setLevel('none');
    }

    private _noteDisconnected(): void {
        // Opening a font isn't a disconnect: count only after a connection.
        if (!this._wasConnected || this._disconnectedSince !== null) return;
        this._disconnectedSince = this._now();
        const setTimer = this._options.setTimer ?? defaultSetTimer;
        this._noticeTimer = setTimer(
            () => this._showOffline(),
            this._options.noticeDelayMs ?? OFFLINE_NOTICE_DELAY_MS
        );
        this._pauseTimer = setTimer(() => this._pause(), this._options.limitMs);
    }

    private _showOffline(): void {
        this._noticeTimer = null;
        if (this._disconnectedSince === null || this._level !== 'none') {
            return;
        }
        this._setLevel('offline');
    }

    private _pause(): void {
        this._pauseTimer = null;
        if (this._level === 'paused' || this._disconnectedSince === null) {
            return;
        }
        this._setLevel('paused');
        this._options.onPause?.();
    }

    private _setLevel(level: OfflineLevel): void {
        if (this._level === level) return;
        this._level = level;
        this._options.onLevelChange?.(level);
    }

    private _stopTimers(): void {
        const clearTimer = this._options.clearTimer ?? defaultClearTimer;
        if (this._pauseTimer !== null) {
            clearTimer(this._pauseTimer);
            this._pauseTimer = null;
        }
        if (this._noticeTimer !== null) {
            clearTimer(this._noticeTimer);
            this._noticeTimer = null;
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
