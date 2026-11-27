/**
 * Large cloud edits: one outbound packet sent as several room transactions.
 *
 * The room refuses a transaction over MAX_YJS_PACKET_BYTES (its validator and
 * compactor budget). An edit whose Yjs update is larger is split with
 * `splitYjsUpdate` and sent one part at a time, each a normal live update
 * with its own transaction id, so the room journals, acknowledges and
 * deduplicates every part like any other write.
 *
 * Every part carries an envelope, because peers refuse live updates without
 * one. The parts before the last carry a copy of the edit’s envelope marked
 * with `part`; the last carries the edit’s own envelope and transaction id,
 * so the outbox row is retired only when the whole edit is in the room.
 * Receivers hold marked parts and apply them merged with the last one
 * (`CloudPartedInboundBuffer`), so the edit lands as one change; the room
 * keeps marked envelopes out of its mutation history.
 */
import * as Y from 'yjs';
import {
    collaborationMessageKey,
    type CloudEnvelopePart,
    type CollaborationMessageEnvelope
} from './collaboration-message';
import { MAX_YJS_PACKET_BYTES } from './generated/collab-protocol-limits';
import { splitYjsUpdate } from './cloud-update-split';

export type CloudOutboundWirePart = {
    update: Uint8Array;
    collaborationMessage?: CollaborationMessageEnvelope;
    clientTransactionId?: string;
    /** Zero-based position and count of the parts of this edit. */
    index: number;
    total: number;
};

/** True when the update is too large for one room transaction. */
export function needsOutboundParts(update: Uint8Array): boolean {
    return update.byteLength >= MAX_YJS_PACKET_BYTES;
}

function partEnvelope(
    envelope: CollaborationMessageEnvelope,
    part: CloudEnvelopePart
): CollaborationMessageEnvelope {
    return {
        ...envelope,
        transactionId: `${envelope.transactionId}#part-${part.index + 1}/${part.total}`,
        // Receivers that hold parts read the change from the last part;
        // replay snapshots would only make these envelopes larger.
        changes: envelope.changes.map((change) => {
            const copy = { ...change };
            delete copy.replayOldValue;
            delete copy.replayNewValue;
            return copy;
        }),
        part
    };
}

/**
 * The room transactions for one outbound packet: the packet itself when it
 * fits, otherwise its parts. Null when the update cannot be split into parts
 * that fit (one value in it alone exceeds the limit).
 */
export function planOutboundParts(packet: {
    update: Uint8Array;
    collaborationMessage?: CollaborationMessageEnvelope | null;
    clientTransactionId?: string | null;
}): CloudOutboundWirePart[] | null {
    const envelope = packet.collaborationMessage || undefined;
    const baseTransactionId =
        packet.clientTransactionId ||
        (envelope ? collaborationMessageKey(envelope) : undefined);
    if (!needsOutboundParts(packet.update)) {
        return [
            {
                update: packet.update,
                collaborationMessage: envelope,
                clientTransactionId: baseTransactionId,
                index: 0,
                total: 1
            }
        ];
    }
    const updates = splitYjsUpdate(packet.update);
    if (!updates) {
        return null;
    }
    const total = updates.length;
    const of = envelope ? collaborationMessageKey(envelope) : baseTransactionId;
    return updates.map((update, index) => {
        if (index === total - 1) {
            return {
                update,
                collaborationMessage: envelope,
                clientTransactionId: baseTransactionId,
                index,
                total
            };
        }
        const marked =
            envelope && of
                ? partEnvelope(envelope, { of, index, total })
                : undefined;
        return {
            update,
            collaborationMessage: marked,
            clientTransactionId: marked
                ? collaborationMessageKey(marked)
                : baseTransactionId
                  ? `${baseTransactionId}#part-${index + 1}/${total}`
                  : undefined,
            index,
            total
        };
    });
}

/** How long a receiver holds parts whose last part has not arrived. */
export const PARTED_INBOUND_HOLD_MS = 10 * 60_000;

type HeldEdit = { updates: Uint8Array[]; firstAt: number };

/**
 * Receiver side: holds the leading parts of a large edit and releases them
 * merged with its last part, so peers apply the edit once, with its real
 * envelope. Parts whose last part never comes are released after
 * PARTED_INBOUND_HOLD_MS for the caller to apply as room state.
 */
export class CloudPartedInboundBuffer {
    private _held = new Map<string, HeldEdit>();

    get size(): number {
        return this._held.size;
    }

    accept(
        update: Uint8Array,
        envelopes: CollaborationMessageEnvelope[] | undefined,
        now = Date.now()
    ):
        | { kind: 'hold' }
        | {
              kind: 'apply';
              update: Uint8Array;
              envelopes: CollaborationMessageEnvelope[] | undefined;
          } {
        const leadingKey = CloudPartedInboundBuffer.leadingPartKey(envelopes);
        if (leadingKey !== null) {
            const held = this._held.get(leadingKey) || {
                updates: [],
                firstAt: now
            };
            held.updates.push(update);
            this._held.set(leadingKey, held);
            return { kind: 'hold' };
        }
        const lastKey = CloudPartedInboundBuffer.lastPartKey(envelopes);
        if (lastKey !== null) {
            const held = this._held.get(lastKey);
            if (held) {
                this._held.delete(lastKey);
                return {
                    kind: 'apply',
                    update: Y.mergeUpdates([...held.updates, update]),
                    envelopes
                };
            }
        }
        return { kind: 'apply', update, envelopes };
    }

    /**
     * The key of the edit a leading part belongs to, or null when the row is
     * not a leading part.
     */
    static leadingPartKey(
        envelopes: CollaborationMessageEnvelope[] | undefined
    ): string | null {
        const envelope = envelopes?.length === 1 ? envelopes[0] : null;
        const part = envelope?.part;
        if (
            part &&
            typeof part.of === 'string' &&
            Number.isInteger(part.index) &&
            Number.isInteger(part.total) &&
            part.index < part.total - 1
        ) {
            return part.of;
        }
        return null;
    }

    /** The key a last part (an envelope with no part marker) would release. */
    static lastPartKey(
        envelopes: CollaborationMessageEnvelope[] | undefined
    ): string | null {
        const envelope = envelopes?.length === 1 ? envelopes[0] : null;
        return envelope && !envelope.part
            ? collaborationMessageKey(envelope)
            : null;
    }

    /** Whether this row continues or completes every edit now held. */
    continuesHeld(
        envelopes: CollaborationMessageEnvelope[] | undefined
    ): boolean {
        if (!this._held.size) {
            return true;
        }
        const key =
            CloudPartedInboundBuffer.leadingPartKey(envelopes) ??
            CloudPartedInboundBuffer.lastPartKey(envelopes);
        return key !== null && this._held.size === 1 && this._held.has(key);
    }

    /**
     * Every held edit, merged in the order it was held, and empties the
     * buffer. Null when nothing is held.
     */
    takeAll(): Uint8Array | null {
        if (!this._held.size) {
            return null;
        }
        const updates: Uint8Array[] = [];
        for (const held of this._held.values()) {
            updates.push(...held.updates);
        }
        this._held.clear();
        return Y.mergeUpdates(updates);
    }

    /** Forget every held part (their rows are replayed by the room). */
    clear(): void {
        this._held.clear();
    }

    /** Merged updates of edits held longer than `holdMs`. */
    takeExpired(
        now = Date.now(),
        holdMs = PARTED_INBOUND_HOLD_MS
    ): Uint8Array[] {
        const expired: Uint8Array[] = [];
        for (const [key, held] of this._held) {
            if (now - held.firstAt >= holdMs) {
                this._held.delete(key);
                expired.push(Y.mergeUpdates(held.updates));
            }
        }
        return expired;
    }
}
