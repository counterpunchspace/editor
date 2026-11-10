/**
 * Edit bursts: continuous gestures (key repeat, arrow-adjusted fields) are
 * one history item and one cloud send, however many ticks they make.
 *
 * - `EditBurstTracker` follows a burst per key: it opens with the first tick,
 *   stays open while ticks arrive less than the idle delay apart, and
 *   finalizes after that. It announces ticks and finalization for the
 *   history view.
 * - `CloudSendHold` keeps the cloud-bound copy of a burst’s packets back.
 *   Every local consumer (worker, UI, linked windows) still sees each tick at
 *   once. Packets that belong to no burst pass through, except when they
 *   follow one another faster than the minimum gap: that is the rate limit
 *   for every source that has not declared a burst.
 */
import type { ChangeLogEntry } from './change-log';
import type { CollaborationMessageEnvelope } from './collaboration-message';
import { Logger } from './logger';

const console = new Logger('EditBurst');

export const EDIT_BURST_EVENT = 'editBurst';

export type EditBurstPhase = 'tick' | 'finalized';

export type EditBurstEventDetail = {
    phase: EditBurstPhase;
    burstId: string;
    key: string;
    historyItemId: string | null;
    ticks: number;
    /** `remote`: the ticks come from a linked window, relayed by main. */
    origin: 'local' | 'remote';
};

export type EditBurst = {
    id: string;
    key: string;
    /** History item every commit of the burst shares; null when not shared. */
    historyItemId: string | null;
    ticks: number;
    startedAt: number;
    lastAt: number;
    origin: 'local' | 'remote';
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type EditBurstClock = {
    now(): number;
    setTimer(callback: () => void, ms: number): TimerHandle;
    clearTimer(handle: TimerHandle): void;
};

const realClock: EditBurstClock = {
    now: () =>
        typeof performance !== 'undefined' ? performance.now() : Date.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle)
};

export type EditBurstTrackerOptions = {
    idleMs: number;
    /** A burst this old finalizes even while ticks keep coming. */
    maxMs: number;
    createHistoryItemId?: () => string;
    clock?: EditBurstClock;
    dispatch?: (detail: EditBurstEventDetail) => void;
};

type FinalizeHandler = (burst: EditBurst) => void | Promise<void>;

export class EditBurstTracker {
    private readonly idleMs: number;
    private readonly maxMs: number;
    private readonly createHistoryItemId?: () => string;
    private readonly clock: EditBurstClock;
    private readonly dispatchDetail: (detail: EditBurstEventDetail) => void;
    private readonly bursts = new Map<string, EditBurst>();
    private readonly idleTimers = new Map<string, TimerHandle>();
    private readonly finalizeHandlers = new Set<FinalizeHandler>();
    private nextId = 1;

    constructor(options: EditBurstTrackerOptions) {
        this.idleMs = options.idleMs;
        this.maxMs = options.maxMs;
        this.createHistoryItemId = options.createHistoryItemId;
        this.clock = options.clock ?? realClock;
        this.dispatchDetail =
            options.dispatch ??
            ((detail) => {
                if (typeof window === 'undefined') {
                    return;
                }
                window.dispatchEvent(
                    new CustomEvent(EDIT_BURST_EVENT, { detail })
                );
            });
    }

    /** Count a tick of burst `key`, opening the burst when none is open. */
    tick(
        key: string,
        options: {
            shareHistory?: boolean;
            origin?: 'local' | 'remote';
            historyItemId?: string | null;
            /** Idle delay for this burst; a drag may pause longer than a key repeat. */
            idleMs?: number;
        } = {}
    ): EditBurst {
        const now = this.clock.now();
        let burst = this.bursts.get(key);
        if (burst && now - burst.startedAt >= this.maxMs) {
            void this.finalize(key);
            burst = undefined;
        }
        if (!burst) {
            // A relayed burst names the sender's history item; a local one
            // gets its own unless it keeps its commits' items.
            const historyItemId =
                options.historyItemId ??
                (options.shareHistory !== false
                    ? (this.createHistoryItemId?.() ?? null)
                    : null);
            burst = {
                id: `burst-${this.nextId++}`,
                key,
                historyItemId,
                ticks: 0,
                startedAt: now,
                lastAt: now,
                origin: options.origin ?? 'local'
            };
            this.bursts.set(key, burst);
        }
        burst.ticks += 1;
        burst.lastAt = now;
        this.armIdleTimer(key, options.idleMs ?? this.idleMs);
        this.dispatchDetail(this.detail('tick', burst));
        return burst;
    }

    get(key: string): EditBurst | null {
        return this.bursts.get(key) ?? null;
    }

    /**
     * Close burst `key`. Handlers run first (the engine flushes the cloud
     * hold there); `finalized` is announced once they have settled.
     */
    finalize(key: string): Promise<void> {
        const burst = this.bursts.get(key);
        if (!burst) {
            return Promise.resolve();
        }
        this.bursts.delete(key);
        const timer = this.idleTimers.get(key);
        if (timer !== undefined) {
            this.clock.clearTimer(timer);
            this.idleTimers.delete(key);
        }
        const pending: Array<void | Promise<void>> = [];
        for (const handler of this.finalizeHandlers) {
            try {
                pending.push(handler(burst));
            } catch (error) {
                console.warn('Burst finalize handler failed:', error);
            }
        }
        return Promise.allSettled(pending).then(() => {
            this.dispatchDetail(this.detail('finalized', burst));
        });
    }

    finalizeAll(): Promise<void> {
        return Promise.all(
            [...this.bursts.keys()].map((key) => this.finalize(key))
        ).then(() => undefined);
    }

    onFinalize(handler: FinalizeHandler): () => void {
        this.finalizeHandlers.add(handler);
        return () => this.finalizeHandlers.delete(handler);
    }

    destroy(): void {
        for (const timer of this.idleTimers.values()) {
            this.clock.clearTimer(timer);
        }
        this.idleTimers.clear();
        this.bursts.clear();
        this.finalizeHandlers.clear();
    }

    private armIdleTimer(key: string, idleMs: number): void {
        const previous = this.idleTimers.get(key);
        if (previous !== undefined) {
            this.clock.clearTimer(previous);
        }
        this.idleTimers.set(
            key,
            this.clock.setTimer(() => {
                this.idleTimers.delete(key);
                void this.finalize(key);
            }, idleMs)
        );
    }

    private detail(
        phase: EditBurstPhase,
        burst: EditBurst
    ): EditBurstEventDetail {
        return {
            phase,
            burstId: burst.id,
            key: burst.key,
            historyItemId: burst.historyItemId,
            ticks: burst.ticks,
            origin: burst.origin
        };
    }
}

/** A packet whose cloud send is held back. */
export type HeldCloudPacket = {
    /** `local`: this window’s commit. `relay`: a linked window’s packet main forwards. */
    kind: 'local' | 'relay';
    /** Burst key; null for a packet held only by the rate limit. */
    burstKey: string | null;
    documentId: string;
    update: Uint8Array;
    envelope: CollaborationMessageEnvelope | null;
    entries: ChangeLogEntry[];
};

export type CloudSendHoldOptions = {
    /** Receives everything held, in arrival order, once. */
    flush: (packets: HeldCloudPacket[]) => void;
    /** Packets closer together than this are rate limited. */
    minGapMs: number;
    /** A rate limited batch goes out this long after its first packet. */
    trailingMs: number;
    clock?: EditBurstClock;
};

export class CloudSendHold {
    private readonly flushPackets: (packets: HeldCloudPacket[]) => void;
    private readonly minGapMs: number;
    private readonly trailingMs: number;
    private readonly clock: EditBurstClock;
    private packets: HeldCloudPacket[] = [];
    private burstKeys = new Set<string>();
    private trailingTimer: TimerHandle | null = null;
    private lastSentAt = Number.NEGATIVE_INFINITY;
    private lastPassedCommitId = -1;

    constructor(options: CloudSendHoldOptions) {
        this.flushPackets = options.flush;
        this.minGapMs = options.minGapMs;
        this.trailingMs = options.trailingMs;
        this.clock = options.clock ?? realClock;
    }

    /**
     * `held`: the hold owns the packet and delivers it on flush.
     * `passthrough`: send it now, the caller does.
     */
    submit(
        packet: HeldCloudPacket,
        /** Packets of one commit share an id; the rate limit counts commits. */
        commitId: number
    ): 'held' | 'passthrough' {
        if (packet.burstKey) {
            this.packets.push(packet);
            this.burstKeys.add(packet.burstKey);
            return 'held';
        }
        if (this.packets.length > 0) {
            // Order: nothing overtakes what is held.
            this.packets.push(packet);
            if (this.burstKeys.size > 0) {
                this.flushAll();
            }
            return 'held';
        }
        if (commitId === this.lastPassedCommitId) {
            return 'passthrough';
        }
        const now = this.clock.now();
        if (now - this.lastSentAt < this.minGapMs) {
            this.packets.push(packet);
            this.trailingTimer = this.clock.setTimer(() => {
                this.trailingTimer = null;
                // A burst that started meanwhile keeps everything until it
                // ends, so it still goes out as one send.
                if (this.burstKeys.size === 0) {
                    this.flushAll();
                }
            }, this.trailingMs);
            return 'held';
        }
        this.lastSentAt = now;
        this.lastPassedCommitId = commitId;
        return 'passthrough';
    }

    /** A burst ended; its packets and everything queued behind them go out. */
    flushBurst(key: string): void {
        if (this.burstKeys.has(key)) {
            this.flushAll();
        }
    }

    flushAll(): void {
        if (this.trailingTimer !== null) {
            this.clock.clearTimer(this.trailingTimer);
            this.trailingTimer = null;
        }
        const packets = this.packets;
        if (packets.length === 0) {
            return;
        }
        this.packets = [];
        this.burstKeys.clear();
        this.lastSentAt = this.clock.now();
        this.flushPackets(packets);
    }

    hasPending(): boolean {
        return this.packets.length > 0;
    }

    destroy(): void {
        if (this.trailingTimer !== null) {
            this.clock.clearTimer(this.trailingTimer);
            this.trailingTimer = null;
        }
        this.packets = [];
        this.burstKeys.clear();
    }
}
