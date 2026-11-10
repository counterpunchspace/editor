/**
 * Live previews for linked windows.
 *
 * While a drag or a key burst is going on, the editing window stages its
 * changed layers in its own worker and keeps the Yjs document untouched until
 * the gesture commits. Linked windows would see nothing before that. The
 * sender therefore also posts those layers, throttled, and a linked window
 * stages them the same way: its model layers (without recording a change),
 * its worker overlay, a live compile, a repaint. The commit that follows is
 * an ordinary Yjs update that replaces all of it. Collaborators in other
 * browsers get no previews, only the commit.
 */
import type { Babelfont } from './babelfont';
import { Logger } from './logger';

const console = new Logger('LinkedLivePreview');

export type LivePreviewLayerRecord = {
    glyphName: string;
    layerId: string;
    layerData: Babelfont.Layer;
};

export type LivePreviewCompile = {
    changeSource: string;
    editType: string | null;
};

export type LivePreviewPayload = {
    /** Compile-facing layers for the worker overlay (recomposed dependents too). */
    overlay: LivePreviewLayerRecord[];
    /** Logical layers for the model; automatic layers recompose on their own. */
    model: LivePreviewLayerRecord[];
    compile: LivePreviewCompile | null;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type LivePreviewClock = {
    now(): number;
    setTimer(callback: () => void, ms: number): TimerHandle;
    clearTimer(handle: TimerHandle): void;
};

const realClock: LivePreviewClock = {
    now: () =>
        typeof performance !== 'undefined' ? performance.now() : Date.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle)
};

/**
 * The newest payload goes out at once when the last send is old enough,
 * otherwise after the interval. Older payloads are dropped: a preview is
 * only ever the latest state.
 */
export class LivePreviewThrottle<T> {
    private pending: T | null = null;
    private timer: TimerHandle | null = null;
    private lastSentAt = Number.NEGATIVE_INFINITY;

    constructor(
        private readonly send: (payload: T) => void,
        private readonly intervalMs: number,
        private readonly clock: LivePreviewClock = realClock
    ) {}

    push(payload: T): void {
        const now = this.clock.now();
        const wait = this.lastSentAt + this.intervalMs - now;
        if (wait <= 0 && this.timer === null) {
            this.emit(payload);
            return;
        }
        this.pending = payload;
        if (this.timer === null) {
            this.timer = this.clock.setTimer(
                () => {
                    this.timer = null;
                    const latest = this.pending;
                    this.pending = null;
                    if (latest !== null) {
                        this.emit(latest);
                    }
                },
                Math.max(0, wait)
            );
        }
    }

    /** Send what is waiting now; true when something was sent. */
    flush(): boolean {
        if (this.timer !== null) {
            this.clock.clearTimer(this.timer);
            this.timer = null;
        }
        const latest = this.pending;
        this.pending = null;
        if (latest === null) {
            return false;
        }
        this.emit(latest);
        return true;
    }

    cancel(): void {
        if (this.timer !== null) {
            this.clock.clearTimer(this.timer);
            this.timer = null;
        }
        this.pending = null;
    }

    private emit(payload: T): void {
        this.lastSentAt = this.clock.now();
        this.send(payload);
    }
}

export type LinkedPreviewHost = {
    /** This window is in a drag or burst of its own; it keeps its own state. */
    isBusyLocally(): boolean;
    applyModelLayers(records: LivePreviewLayerRecord[]): void;
    /** Put the model layers back to what the document holds. */
    revertModelLayers(
        targets: Array<{ glyphName: string; layerId: string }>
    ): void;
    stageOverlay(records: LivePreviewLayerRecord[]): Promise<boolean>;
    requestCompile(compile: LivePreviewCompile): void;
    repaint(glyphNames: string[]): void | Promise<void>;
    clearOverlay(): void;
    recompile(): void;
};

/**
 * A preview with no news for this long is dropped. Only a sender that
 * vanished without saying so gets here: a drag may pause for a while, and
 * every normal end is a commit, `live-preview-end` or `window-closing`.
 */
export const LINKED_PREVIEW_STALE_MS = 30000;

export class LinkedLivePreviewReceiver {
    private active: {
        previewId: string;
        targets: Array<{ glyphName: string; layerId: string }>;
    } | null = null;
    private staleTimer: TimerHandle | null = null;
    private running = false;
    private queued: { previewId: string; payload: LivePreviewPayload } | null =
        null;

    constructor(
        private readonly host: LinkedPreviewHost,
        private readonly clock: LivePreviewClock = realClock
    ) {}

    get isPreviewing(): boolean {
        return this.active !== null;
    }

    /** Latest wins: a payload that arrives while one is staging replaces the queued one. */
    receive(previewId: string, payload: LivePreviewPayload): void {
        this.queued = { previewId, payload };
        this.armStaleTimer();
        if (!this.running) {
            void this.drain();
        }
    }

    /** The sender is done. Revert unless its commit has already landed. */
    end(previewId: string): void {
        if (this.queued && this.queued.previewId === previewId) {
            this.queued = null;
        }
        if (!this.active || this.active.previewId !== previewId) {
            return;
        }
        this.revert();
    }

    /** The sending window closed: what it previewed goes back. */
    endFromWindow(windowId: string): void {
        const prefix = `${windowId}:`;
        if (this.queued?.previewId.startsWith(prefix)) {
            this.queued = null;
        }
        if (this.active?.previewId.startsWith(prefix)) {
            this.revert();
        }
    }

    /**
     * A committed update arrived. When it covers the previewed layers it is
     * the authority and nothing needs reverting; an unrelated commit (another
     * glyph, a collaborator) leaves the preview in place.
     */
    settle(touchedLayerIds: Set<string>): void {
        if (
            this.active &&
            !this.active.targets.some((target) =>
                touchedLayerIds.has(target.layerId)
            )
        ) {
            return;
        }
        this.active = null;
        this.queued = null;
        this.clearStaleTimer();
    }

    destroy(): void {
        this.active = null;
        this.queued = null;
        this.clearStaleTimer();
    }

    private async drain(): Promise<void> {
        this.running = true;
        try {
            while (this.queued) {
                const { previewId, payload } = this.queued;
                this.queued = null;
                await this.apply(previewId, payload);
            }
        } finally {
            this.running = false;
        }
    }

    private async apply(
        previewId: string,
        payload: LivePreviewPayload
    ): Promise<void> {
        if (this.host.isBusyLocally()) {
            return;
        }
        const targets = new Map<
            string,
            { glyphName: string; layerId: string }
        >();
        // Layers an earlier tick previewed stay to be reverted, even when
        // this tick no longer covers them.
        for (const target of this.active?.targets ?? []) {
            targets.set(`${target.glyphName}\u0000${target.layerId}`, target);
        }
        for (const record of [...payload.model, ...payload.overlay]) {
            targets.set(`${record.glyphName}\u0000${record.layerId}`, {
                glyphName: record.glyphName,
                layerId: record.layerId
            });
        }
        this.active = {
            previewId,
            targets: [...targets.values()]
        };
        try {
            if (payload.model.length) {
                this.host.applyModelLayers(payload.model);
                // Show the layers at once: the glyph open in the editor is
                // drawn from the model and need not wait for the worker.
                await this.host.repaint([
                    ...new Set(
                        [...targets.values()].map((target) => target.glyphName)
                    )
                ]);
                if (!this.active || this.active.previewId !== previewId) {
                    return;
                }
            }
            const staged = payload.overlay.length
                ? await this.host.stageOverlay(payload.overlay)
                : true;
            if (!this.active || this.active.previewId !== previewId) {
                // A commit settled the preview while it staged.
                return;
            }
            // The compile that follows repaints the text.
            if (staged && payload.compile) {
                this.host.requestCompile(payload.compile);
            } else if (!payload.model.length) {
                await this.host.repaint([
                    ...new Set(
                        [...targets.values()].map((target) => target.glyphName)
                    )
                ]);
            }
        } catch (error) {
            console.warn('Could not follow the live preview:', error);
        }
    }

    private revert(): void {
        const active = this.active;
        this.active = null;
        this.queued = null;
        this.clearStaleTimer();
        if (!active) {
            return;
        }
        try {
            this.host.revertModelLayers(active.targets);
            this.host.clearOverlay();
            this.host.recompile();
            void this.host.repaint([
                ...new Set(active.targets.map((target) => target.glyphName))
            ]);
        } catch (error) {
            console.warn('Could not undo the live preview:', error);
        }
    }

    private armStaleTimer(): void {
        this.clearStaleTimer();
        this.staleTimer = this.clock.setTimer(() => {
            this.staleTimer = null;
            this.revert();
        }, LINKED_PREVIEW_STALE_MS);
    }

    private clearStaleTimer(): void {
        if (this.staleTimer !== null) {
            this.clock.clearTimer(this.staleTimer);
            this.staleTimer = null;
        }
    }
}
