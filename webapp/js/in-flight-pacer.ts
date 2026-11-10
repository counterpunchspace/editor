/**
 * Paces writes that each start an expensive round trip (a commit, a worker
 * update and a compile). Only one write is in flight: until `settle()`
 * reports that its result has landed, newer values replace each other and
 * the latest one is written next. Writes are also kept `minGapMs` apart,
 * and a write that never settles is released after `maxWaitMs`.
 *
 * Without this, a held key or a drag queues commits faster than they
 * compile; every compile is superseded before it lands and nothing renders
 * until the gesture stops.
 */
export interface InFlightPacerOptions {
    minGapMs: number;
    maxWaitMs: number;
    now?: () => number;
}

interface PendingWrite<T> {
    key: string;
    value: T;
}

export class InFlightPacer<T> {
    private inFlight = false;
    private pending: PendingWrite<T> | null = null;
    private lastWriteAt = Number.NEGATIVE_INFINITY;
    private gapTimer: ReturnType<typeof setTimeout> | null = null;
    private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly now: () => number;

    constructor(
        private readonly write: (value: T, key: string) => void,
        private readonly options: InFlightPacerOptions
    ) {
        this.now = options.now ?? (() => performance.now());
    }

    /**
     * Ask for `value` to be written under `key`. A pending value with
     * another key (another kerning pair, say) is written first, so no
     * value is applied to the wrong target.
     */
    push(key: string, value: T): void {
        if (this.pending && this.pending.key !== key) {
            const other = this.pending;
            this.pending = null;
            this.writeNow(other);
        }
        this.pending = { key, value };
        this.drain();
    }

    /** The value waiting to be written under `key`, if there is one. */
    pendingValue(key: string): T | undefined {
        return this.pending?.key === key ? this.pending.value : undefined;
    }

    get busy(): boolean {
        return this.inFlight || this.pending !== null;
    }

    /** The result of the write in flight has landed. */
    settle(): void {
        if (!this.inFlight) {
            return;
        }
        this.inFlight = false;
        this.clearMaxWaitTimer();
        this.drain();
    }

    /** Write a pending value now, e.g. when a drag ends. */
    flush(): void {
        this.clearGapTimer();
        const pending = this.pending;
        this.pending = null;
        if (pending) {
            this.writeNow(pending);
        }
    }

    /** Drop the pending value and stop the timers. */
    cancel(): void {
        this.pending = null;
        this.inFlight = false;
        this.clearGapTimer();
        this.clearMaxWaitTimer();
    }

    private drain(): void {
        if (this.inFlight || this.gapTimer || !this.pending) {
            return;
        }
        const wait = this.options.minGapMs - (this.now() - this.lastWriteAt);
        if (wait > 0) {
            this.gapTimer = setTimeout(() => {
                this.gapTimer = null;
                this.drain();
            }, wait);
            return;
        }
        const pending = this.pending;
        this.pending = null;
        this.writeNow(pending);
    }

    private writeNow(pending: PendingWrite<T>): void {
        this.inFlight = true;
        this.lastWriteAt = this.now();
        this.clearMaxWaitTimer();
        this.maxWaitTimer = setTimeout(() => {
            this.maxWaitTimer = null;
            this.settle();
        }, this.options.maxWaitMs);
        this.write(pending.value, pending.key);
    }

    private clearGapTimer(): void {
        if (this.gapTimer) {
            clearTimeout(this.gapTimer);
            this.gapTimer = null;
        }
    }

    private clearMaxWaitTimer(): void {
        if (this.maxWaitTimer) {
            clearTimeout(this.maxWaitTimer);
            this.maxWaitTimer = null;
        }
    }
}
