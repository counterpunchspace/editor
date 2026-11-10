/**
 * Handles a stream of pointer samples without starving the rest of the app.
 *
 * The browser serves pointer input and frame callbacks before everything
 * else. When each pointer move costs most of a frame (a drag that recomposes
 * layers and repaints), a fast pointer keeps the main thread busy with input
 * alone: worker results, messages from other windows and timers wait until
 * the pointer stops. A drag then shows no compiled text, and linked windows
 * get nothing, exactly while it matters.
 *
 * The pump keeps only the latest sample and leaves the thread free for at
 * least as long as the work took before it handles the next one. Samples
 * that arrive in that rest are handled from a timer, which queues behind
 * the waiting work instead of jumping ahead of it.
 */
export interface LatestSamplePumpOptions {
    /** Rest after a run, as a share of how long the run took. */
    restRatio?: number;
    /** Runs shorter than this need no rest. */
    minWorkMs?: number;
    /** The rest is never longer than this, however slow a run was. */
    maxRestMs?: number;
    now?: () => number;
}

export class LatestSamplePump<T> {
    private pending: { sample: T } | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private notBefore = Number.NEGATIVE_INFINITY;
    private running = false;
    private readonly restRatio: number;
    private readonly minWorkMs: number;
    private readonly maxRestMs: number;
    private readonly now: () => number;

    constructor(
        private readonly handle: (sample: T) => void,
        options: LatestSamplePumpOptions = {}
    ) {
        this.restRatio = options.restRatio ?? 1;
        this.minWorkMs = options.minWorkMs ?? 2;
        this.maxRestMs = options.maxRestMs ?? 50;
        this.now = options.now ?? (() => performance.now());
    }

    /** Handle `sample` now when the thread has rested, otherwise soon. */
    push(sample: T): void {
        this.pending = { sample };
        if (this.running || this.timer !== null) {
            return;
        }
        const wait = this.notBefore - this.now();
        if (wait <= 0) {
            this.run();
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            this.run();
        }, wait);
    }

    /**
     * Handle a waiting sample now. Call before anything that must see the
     * latest pointer position: mouse up, mouse down, leaving the canvas.
     */
    flush(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (!this.running) {
            this.run();
        }
    }

    /** Drop a waiting sample. */
    cancel(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.pending = null;
    }

    private run(): void {
        const pending = this.pending;
        if (!pending) {
            return;
        }
        this.pending = null;
        this.running = true;
        const startedAt = this.now();
        try {
            this.handle(pending.sample);
        } finally {
            this.running = false;
            const endedAt = this.now();
            const worked = endedAt - startedAt;
            this.notBefore =
                worked < this.minWorkMs
                    ? endedAt
                    : endedAt +
                      Math.min(this.maxRestMs, worked * this.restRatio);
            // A sample pushed from inside the handler waits its turn.
            if (this.pending && this.timer === null) {
                this.timer = setTimeout(
                    () => {
                        this.timer = null;
                        this.run();
                    },
                    Math.max(0, this.notBefore - endedAt)
                );
            }
        }
    }
}
