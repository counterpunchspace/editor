/**
 * Collaborator cascades, shown before their documents arrive.
 *
 * When a collaborator edits a glyph that is live in this window (its room
 * socket is open here), the edit arrives at once. The layers it recomposes
 * in other glyphs (automatically aligned composites, metrics-key widths)
 * live in their own glyph documents. Those reach this window later, by HTTP
 * catch-up after the sender has uploaded them, so composites lagged behind
 * the base glyph.
 *
 * This window therefore recomposes those layers itself, with the same
 * cascade the sender ran, as a preview: in its model without recording a
 * change, and in its worker as a preview overlay for the compile. Nothing
 * is written to the documents or sent anywhere. The stored layers stay the
 * authority:
 *
 * - When a catch-up (or a live packet) brings a previewed layer, the
 *   documents replace the preview. If the base glyph has moved on in the
 *   meantime, the layer is recomposed again from the current base.
 * - A preview whose stored layer never arrives is reverted to the documents
 *   after `REMOTE_CASCADE_PREVIEW_MAX_MS`.
 */
import type { RecompositionEditKind } from './recomposition-closure';
import { deriveEditKindsFromChangeLogEntries } from './recomposition-closure';
import {
    deriveGlyphNameFromPath,
    deriveLayerIdFromPath,
    getPathSegments
} from './change-log';
import { Logger } from './logger';

const console = new Logger('RemoteCascadePreview');

export type CascadeLayerTarget = { glyphName: string; layerId: string };

export type CascadeSource = CascadeLayerTarget & {
    editKinds: Set<RecompositionEditKind>;
};

export type CascadeEntry = {
    path: string;
    oldValue?: unknown;
    newValue?: unknown;
    replayOldValue?: unknown;
    replayNewValue?: unknown;
    compileEditType?: string | null;
};

export type RemoteCascadePreviewHost = {
    /** This window is in a drag or burst of its own; it keeps its own state. */
    isBusyLocally(): boolean;
    /**
     * Recompose what depends on these source layers, in the model and
     * without recording. Returns the dependent layers whose stored data
     * this window now shows ahead of its documents.
     */
    recompose(sources: CascadeSource[]): CascadeLayerTarget[];
    /** Stage these layers in the worker overlay; true when staged. */
    stageOverlay(targets: CascadeLayerTarget[]): Promise<boolean>;
    /** Compile with the overlay; the text repaints when it lands. */
    requestCompile(): void;
    /** Redraw what shows these glyphs from the model. */
    repaint(glyphNames: string[]): void;
    /** Put the model layers back to what the documents hold, and recompile. */
    revert(targets: CascadeLayerTarget[]): void;
};

export type RemoteCascadeClock = {
    now(): number;
    setTimer(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
    clearTimer(handle: ReturnType<typeof setTimeout>): void;
    queue(callback: () => void): void;
};

const realClock: RemoteCascadeClock = {
    now: () =>
        typeof performance !== 'undefined' ? performance.now() : Date.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle),
    queue: (callback) => queueMicrotask(callback)
};

/**
 * How long a preview may stay ahead of the documents. It matches the
 * longest time a sender holds a core stamp for its uploads, after which the
 * stored layers are normally here.
 */
export const REMOTE_CASCADE_PREVIEW_MAX_MS = 10_000;

/** A revert waits this long while the window is busy with its own edit. */
export const REMOTE_CASCADE_BUSY_RETRY_MS = 500;

function targetKey(target: CascadeLayerTarget): string {
    return `${target.glyphName}\u0000${target.layerId}`;
}

/** The glyph and layer an entry path writes; layer null for glyph-wide paths. */
function entryTarget(
    path: string
): { glyphName: string; layerId: string | null } | null {
    const glyphName = deriveGlyphNameFromPath(path);
    if (!glyphName) {
        return null;
    }
    return { glyphName, layerId: deriveLayerIdFromPath(path) };
}

/** True for a path that replaces the whole glyph (and so all its layers). */
function isGlyphRootPath(path: string): boolean {
    const segments = getPathSegments(path);
    return segments[0] === 'glyphs' && segments.length <= 2;
}

export class RemoteCascadePreview {
    private sources = new Map<
        string,
        { source: CascadeSource; expiresAt: number }
    >();
    private pending = new Map<
        string,
        { target: CascadeLayerTarget; expiresAt: number }
    >();
    private refreshQueued = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private timerDueAt = Number.POSITIVE_INFINITY;
    private destroyed = false;

    constructor(
        private readonly host: RemoteCascadePreviewHost,
        private readonly clock: RemoteCascadeClock = realClock
    ) {}

    /** Layers this window shows ahead of its documents. */
    get pendingTargets(): CascadeLayerTarget[] {
        return [...this.pending.values()].map((entry) => entry.target);
    }

    /**
     * A collaborator’s live edit of a glyph arrived (by its room socket, or
     * relayed from the main window). Its layers become cascade sources.
     */
    noteCollaboratorEdit(entries: CascadeEntry[]): void {
        if (this.destroyed || !entries.length) {
            return;
        }
        this.noteStoredChange(entries);
        const editKinds = deriveEditKindsFromChangeLogEntries(entries);
        if (!editKinds.size) {
            return;
        }
        const expiresAt = this.clock.now() + REMOTE_CASCADE_PREVIEW_MAX_MS;
        let added = false;
        for (const entry of entries) {
            const target = entryTarget(String(entry.path || ''));
            if (!target?.layerId) {
                continue;
            }
            const source: CascadeSource = {
                glyphName: target.glyphName,
                layerId: target.layerId,
                editKinds: new Set(editKinds)
            };
            const key = targetKey(source);
            const existing = this.sources.get(key);
            if (existing) {
                for (const kind of editKinds) {
                    existing.source.editKinds.add(kind);
                }
                existing.expiresAt = expiresAt;
            } else {
                this.sources.set(key, { source, expiresAt });
            }
            added = true;
        }
        if (added) {
            this.queueRefresh();
        }
    }

    /**
     * The documents changed from outside (a catch-up, or any remote
     * packet). Previewed layers they now hold are theirs again.
     */
    noteStoredChange(entries: CascadeEntry[]): void {
        if (this.destroyed || !this.pending.size) {
            return;
        }
        for (const entry of entries) {
            const path = String(entry.path || '');
            const target = entryTarget(path);
            if (!target) {
                continue;
            }
            for (const [key, pendingEntry] of this.pending) {
                if (
                    pendingEntry.target.glyphName === target.glyphName &&
                    (target.layerId === pendingEntry.target.layerId ||
                        isGlyphRootPath(path))
                ) {
                    this.pending.delete(key);
                }
            }
        }
        // Recompose again from the current base, since a newer edit may still
        // be ahead of what just arrived. Previews that stay are restaged:
        // any update the worker takes drops its overlay.
        this.queueRefresh();
    }

    destroy(): void {
        this.destroyed = true;
        this.sources.clear();
        this.pending.clear();
        this.clearTimer();
    }

    private queueRefresh(): void {
        if (this.refreshQueued || this.destroyed) {
            return;
        }
        this.refreshQueued = true;
        this.clock.queue(() => {
            this.refreshQueued = false;
            this.refresh();
        });
    }

    private refresh(): void {
        if (this.destroyed) {
            return;
        }
        const now = this.clock.now();
        for (const [key, entry] of this.sources) {
            if (entry.expiresAt <= now) {
                this.sources.delete(key);
            }
        }
        if (this.host.isBusyLocally()) {
            // The window’s own drag owns the model and the overlay; its
            // commit, and the catch-ups, bring the stored layers.
            this.armTimer();
            return;
        }
        let changed: CascadeLayerTarget[] = [];
        if (this.sources.size) {
            try {
                changed = this.host.recompose(
                    [...this.sources.values()].map((entry) => entry.source)
                );
            } catch (error) {
                console.warn(
                    'Could not recompose the collaborator’s edit:',
                    error
                );
                changed = [];
            }
        }
        const expiresAt = now + REMOTE_CASCADE_PREVIEW_MAX_MS;
        for (const target of changed) {
            this.pending.set(targetKey(target), { target, expiresAt });
        }
        this.armTimer();
        if (!this.pending.size) {
            return;
        }
        const targets = this.pendingTargets;
        this.host.repaint([...new Set(targets.map((t) => t.glyphName))]);
        void this.host
            .stageOverlay(targets)
            .then((staged) => {
                if (staged && !this.destroyed && this.pending.size) {
                    this.host.requestCompile();
                }
            })
            .catch((error) => {
                console.warn(
                    'Could not stage the collaborator’s cascade:',
                    error
                );
            });
    }

    private armTimer(): void {
        let dueAt = Number.POSITIVE_INFINITY;
        for (const entry of this.pending.values()) {
            dueAt = Math.min(dueAt, entry.expiresAt);
        }
        if (dueAt === this.timerDueAt && this.timer !== null) {
            return;
        }
        this.clearTimer();
        if (!Number.isFinite(dueAt)) {
            return;
        }
        this.timerDueAt = dueAt;
        this.timer = this.clock.setTimer(
            () => {
                this.timer = null;
                this.timerDueAt = Number.POSITIVE_INFINITY;
                this.expire();
            },
            Math.max(0, dueAt - this.clock.now())
        );
    }

    private clearTimer(): void {
        if (this.timer !== null) {
            this.clock.clearTimer(this.timer);
            this.timer = null;
        }
        this.timerDueAt = Number.POSITIVE_INFINITY;
    }

    private expire(): void {
        if (this.destroyed) {
            return;
        }
        const now = this.clock.now();
        const expired: CascadeLayerTarget[] = [];
        for (const [key, entry] of this.pending) {
            if (entry.expiresAt <= now) {
                expired.push(entry.target);
            }
        }
        if (!expired.length) {
            this.armTimer();
            return;
        }
        if (this.host.isBusyLocally()) {
            this.clearTimer();
            this.timerDueAt = now + REMOTE_CASCADE_BUSY_RETRY_MS;
            this.timer = this.clock.setTimer(() => {
                this.timer = null;
                this.timerDueAt = Number.POSITIVE_INFINITY;
                this.expire();
            }, REMOTE_CASCADE_BUSY_RETRY_MS);
            return;
        }
        for (const target of expired) {
            this.pending.delete(targetKey(target));
        }
        try {
            this.host.revert(expired);
        } catch (error) {
            console.warn('Could not revert the collaborator’s cascade:', error);
        }
        this.armTimer();
    }
}
