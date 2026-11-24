/**
 * CloudAdapter outbox — pending LIVE_UPDATE packets, WAL restore, ACK retirement.
 * Transport (WebSocket / sync-request) stays in cloud-adapter.ts.
 */
import {
    collaborationMessageKey,
    type CollaborationMessageEnvelope
} from './collaboration-message';
import {
    CloudDurableWal,
    walUpdateBytes,
    type CloudWalRecord
} from './cloud-durable-wal';
import { allocateClientTransactionId } from './generated/collab-protocol-durability-contract';
import { pushCollabIntegrityEvent } from './cloud-collab-integrity-debug';
import {
    EnvelopeTooLargeError,
    fitEnvelopeForWire
} from './cloud-envelope-budget';
import type { PatchSyncEngine } from './patch-sync-engine';

export type CloudOutboundUpdatePacket = {
    update: Uint8Array;
    collaborationMessage?: CollaborationMessageEnvelope;
    clientTransactionId?: string;
};

export function getCloudClientTransactionId(
    collaborationMessage?: CollaborationMessageEnvelope | null
): string {
    return (
        (collaborationMessage &&
            collaborationMessageKey(collaborationMessage)) ||
        allocateClientTransactionId('live')
    );
}

export type CloudOutboxHost = {
    documentId: string;
    assetId: string;
    wal: CloudDurableWal;
    getPendingPackets(): CloudOutboundUpdatePacket[];
    setPendingPackets(packets: CloudOutboundUpdatePacket[]): void;
    noteTransferActivity(activity: 'sending' | 'receiving'): void;
    emitPendingSyncCountChange(): void;
    noteServerError(error: { message: string }): void;
    getCachedAssetRole(assetId: string): string | null | undefined;
    accessRevoked: boolean;
    hasSynced: boolean;
    isBrowserOffline(): boolean;
    getWebSocket(): WebSocket | null;
    getBridge(): PatchSyncEngine | null;
    clientId: string | null;
    nextSeq(): number;
    peekSeq(): number;
    armOutboundAckTimeout(): void;
    recordOutboundAckSent(seq: number, clientTransactionIds: string[]): void;
    enqueuePendingDurabilityMessages(
        messages: CollaborationMessageEnvelope[]
    ): void;
    /** True while this transaction is sent and not acknowledged yet. */
    isInFlight?(clientTransactionId: string): boolean;
    /** Stop this document's queue for good and mark the document broken. */
    haltOutbound(error: Error): void;
};

/** A packet reached the outbox without the envelope its WAL row needs. */
export class MissingEnvelopeError extends Error {
    constructor(documentId: string) {
        super(
            `Cloud outbox refused an update for ${documentId} without a collaboration envelope`
        );
        this.name = 'MissingEnvelopeError';
    }
}

/** This window may not send edits to the room any more. */
export class CloudReadOnlyError extends Error {
    constructor(documentId: string) {
        super(
            `Cloud asset is read-only; the edit to ${documentId} cannot be sent. Reload the editor.`
        );
        this.name = 'CloudReadOnlyError';
    }
}

/**
 * Append one packet to the document’s ordered queue. Its place is fixed
 * now, in arrival order; the flush sends only a prefix of the queue, so a
 * packet whose WAL row is still being written holds back every later one.
 * A packet already queued (same transaction) keeps its first place.
 */
export function enqueueOutboundPacket(
    host: CloudOutboxHost,
    update: Uint8Array,
    rawCollaborationMessage?: CollaborationMessageEnvelope | null
): void {
    if (!update.length) {
        return;
    }
    if (!rawCollaborationMessage) {
        throw new MissingEnvelopeError(host.documentId);
    }
    // An envelope no lossless step fits is never dropped: the packet keeps
    // its place with the envelope as it came, the queue halts on it and the
    // document is marked broken.
    let tooLarge: EnvelopeTooLargeError | null = null;
    let collaborationMessage: CollaborationMessageEnvelope;
    try {
        collaborationMessage = fitEnvelopeForWire(rawCollaborationMessage, {
            documentId: host.documentId
        });
    } catch (error) {
        if (!(error instanceof EnvelopeTooLargeError)) {
            throw error;
        }
        tooLarge = error;
        collaborationMessage = rawCollaborationMessage;
    }
    if (
        host.accessRevoked ||
        host.getCachedAssetRole(host.assetId) === 'viewer'
    ) {
        host.noteServerError({ message: 'Cloud asset is read-only' });
        throw new CloudReadOnlyError(host.documentId);
    }

    const clientTransactionId =
        getCloudClientTransactionId(collaborationMessage);
    const pending = host.getPendingPackets();
    if (
        pending.some(
            (packet) => packet.clientTransactionId === clientTransactionId
        ) ||
        host.isInFlight?.(clientTransactionId) === true
    ) {
        return;
    }
    const packet: CloudOutboundUpdatePacket = {
        update,
        collaborationMessage,
        clientTransactionId
    };
    pending.push(packet);
    host.setPendingPackets(pending);
    pushCollabIntegrityEvent('enqueue-outbound', {
        documentId: host.documentId,
        bytes: update.length,
        hasTx: true,
        pending: pending.length
    });
    host.enqueuePendingDurabilityMessages([collaborationMessage]);
    host.emitPendingSyncCountChange();
    host.noteTransferActivity('sending');
    if (tooLarge) {
        host.haltOutbound(tooLarge);
        throw tooLarge;
    }
}

/**
 * The longest prefix of the queue that may be sent now: every packet in it
 * has its WAL row and is not held in a burst. Sending stops at the first
 * packet that is not ready; a later packet never goes out ahead of it.
 */
export function sendableOutboxPrefix(
    wal: CloudDurableWal,
    assetId: string,
    documentId: string,
    packets: CloudOutboundUpdatePacket[]
): CloudOutboundUpdatePacket[] {
    const walTransactionIds = wal.transactionIdsFor(documentId);
    const prefix: CloudOutboundUpdatePacket[] = [];
    for (const packet of packets) {
        const id = packet.clientTransactionId;
        if (!id || !packet.collaborationMessage) {
            throw new MissingEnvelopeError(documentId);
        }
        if (
            !walTransactionIds.has(id) ||
            wal.isHeldStaged({
                assetId,
                documentId,
                clientTransactionId: id
            })
        ) {
            break;
        }
        prefix.push(packet);
    }
    return prefix;
}

export function walRecordsReadyToRestore(
    wal: CloudDurableWal,
    assetId: string,
    documentId: string
): CloudWalRecord[] {
    return wal
        .recordsFor(documentId)
        .filter(
            (record) =>
                record.assetId === assetId &&
                !!record.clientTransactionId &&
                walUpdateBytes(record).byteLength > 0 &&
                !!record.collaborationMessage &&
                !wal.isHeldStaged(record)
        );
}
