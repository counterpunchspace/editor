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
import { encodeLiveUpdateFrame } from './cloud-adapter-frames';
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
};

export function enqueueOutboundPacket(
    host: CloudOutboxHost,
    update: Uint8Array,
    collaborationMessage?: CollaborationMessageEnvelope | null
): void {
    if (!update.length) {
        return;
    }
    if (
        host.accessRevoked ||
        host.getCachedAssetRole(host.assetId) === 'viewer'
    ) {
        host.noteServerError({ message: 'Cloud asset is read-only' });
        return;
    }

    const clientTransactionId = collaborationMessage
        ? getCloudClientTransactionId(collaborationMessage)
        : null;
    const packet: CloudOutboundUpdatePacket = {
        update,
        ...(collaborationMessage ? { collaborationMessage } : undefined),
        ...(clientTransactionId ? { clientTransactionId } : undefined)
    };

    const pending = host.getPendingPackets();
    pending.push(packet);
    host.setPendingPackets(pending);
    pushCollabIntegrityEvent('enqueue-outbound', {
        documentId: host.documentId,
        bytes: update.length,
        hasTx: Boolean(clientTransactionId),
        pending: pending.length
    });
    if (collaborationMessage) {
        host.enqueuePendingDurabilityMessages([collaborationMessage]);
        if (packet.clientTransactionId) {
            host.emitPendingSyncCountChange();
        }
    }
    host.noteTransferActivity('sending');
}

export function buildLiveUpdateBinaryFrame(
    host: CloudOutboxHost,
    packet: CloudOutboundUpdatePacket
): Uint8Array {
    const seq = host.nextSeq();
    const clientTransactionId =
        packet.clientTransactionId ||
        (packet.collaborationMessage
            ? getCloudClientTransactionId(packet.collaborationMessage)
            : null);
    const payload = encodeLiveUpdateFrame({
        clientId: host.clientId || '',
        seq,
        update: packet.update,
        clientTransactionId,
        collaborationMessages: packet.collaborationMessage
            ? [packet.collaborationMessage]
            : null
    });
    if (clientTransactionId) {
        host.recordOutboundAckSent(seq, [clientTransactionId]);
    }
    return payload;
}

export function filterSendableOutboxPackets(
    host: CloudOutboxHost,
    packets: CloudOutboundUpdatePacket[]
): CloudOutboundUpdatePacket[] {
    return packets.filter((packet) => {
        if (!packet.clientTransactionId) {
            return true;
        }
        return host.wal
            .recordsFor(host.documentId)
            .some(
                (record) =>
                    record.clientTransactionId === packet.clientTransactionId
            );
    });
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
                !!record.collaborationMessage
        );
}
