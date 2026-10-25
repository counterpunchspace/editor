/**
 * Keeps outbound collaboration envelopes under the room's metadata cap.
 * The room rejects an oversized envelope and closes the socket, so every
 * envelope is fitted right before it is persisted or put on the wire. The
 * transaction key does not depend on the change list, so fitting never
 * changes a packet's identity.
 */
import type { CollaborationMessageEnvelope } from './collaboration-message';
import { pushCollabIntegrityEvent } from './cloud-collab-integrity-debug';
import { MAX_METADATA_BYTES } from './generated/collab-protocol-limits';
import {
    METADATA_BUDGET_MARGIN_BYTES,
    fitCollaborationMessagesToBudget,
    mergeCollaborationMessages
} from './generated/collab-protocol-metadata-budget';

export const OUTBOUND_METADATA_BUDGET_BYTES =
    MAX_METADATA_BYTES - METADATA_BUDGET_MARGIN_BYTES;

export function fitEnvelopeForWire(
    message: CollaborationMessageEnvelope,
    context?: { documentId?: string }
): CollaborationMessageEnvelope;
export function fitEnvelopeForWire(
    message: CollaborationMessageEnvelope | null | undefined,
    context?: { documentId?: string }
): CollaborationMessageEnvelope | null | undefined;
export function fitEnvelopeForWire(
    message: CollaborationMessageEnvelope | null | undefined,
    context: { documentId?: string } = {}
): CollaborationMessageEnvelope | null | undefined {
    if (!message) {
        return message;
    }
    const fit = fitCollaborationMessagesToBudget(
        [message],
        OUTBOUND_METADATA_BUDGET_BYTES
    );
    if (fit.messages[0] === message) {
        return message;
    }
    pushCollabIntegrityEvent('metadata-compacted', {
        documentId: context.documentId ?? null,
        bytesBefore: fit.bytesBefore,
        bytesAfter: fit.bytesAfter,
        level: fit.level,
        fits: fit.fits
    });
    return fit.messages[0] as CollaborationMessageEnvelope;
}

/** One envelope for a Yjs update that spans several history items. */
export function mergeEnvelopesForWire(
    messages: CollaborationMessageEnvelope[],
    context: { documentId?: string } = {}
): CollaborationMessageEnvelope | null {
    const merged = mergeCollaborationMessages(
        messages
    ) as CollaborationMessageEnvelope | null;
    return fitEnvelopeForWire(merged, context) ?? null;
}
