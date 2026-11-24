/**
 * Keeps outbound collaboration envelopes under the room's metadata cap.
 * The room rejects an oversized envelope and closes the socket, so every
 * envelope is fitted right before it is persisted or put on the wire. The
 * transaction key does not depend on the change list, so fitting never
 * changes a packet's identity.
 *
 * Fitting is lossless (see the shared metadata-budget module): it describes
 * the same change more coarsely and, as its last step, widens to
 * `metadata.allGlyphsChanged`. An envelope that still does not fit is
 * refused with EnvelopeTooLargeError; it is never cut down.
 */
import type { CollaborationMessageEnvelope } from './collaboration-message';
import { pushCollabIntegrityEvent } from './cloud-collab-integrity-debug';
import { MAX_METADATA_BYTES } from './generated/collab-protocol-limits';
import {
    METADATA_BUDGET_MARGIN_BYTES,
    METADATA_FIT_LEVEL,
    fitCollaborationMessagesToBudget,
    mergeCollaborationMessages
} from './generated/collab-protocol-metadata-budget';

export const OUTBOUND_METADATA_BUDGET_BYTES =
    MAX_METADATA_BYTES - METADATA_BUDGET_MARGIN_BYTES;

/** An envelope that no lossless step brings under the room's cap. */
export class EnvelopeTooLargeError extends Error {
    readonly documentId: string | null;
    readonly bytes: number;
    readonly level: number;

    constructor(documentId: string | null, bytes: number, level: number) {
        super(
            `Collaboration envelope for ${documentId ?? 'an unknown document'} is ${bytes} bytes after every lossless step (level ${level}); the room accepts ${OUTBOUND_METADATA_BUDGET_BYTES}.`
        );
        this.name = 'EnvelopeTooLargeError';
        this.documentId = documentId;
        this.bytes = bytes;
        this.level = level;
    }
}

type FittedBody = {
    metadata: CollaborationMessageEnvelope['metadata'];
    label: CollaborationMessageEnvelope['label'];
    summary: CollaborationMessageEnvelope['summary'];
    /** null when the body already fits. */
    fitted: Pick<
        CollaborationMessageEnvelope,
        'changes' | 'metadata' | 'label' | 'summary'
    > | null;
    /** Set when no lossless step fits; every packet of the body is refused. */
    tooLarge: { bytes: number; level: number } | null;
};

/**
 * Packets of one multi-document commit share the envelope body and differ
 * only in their sequence. Measuring means serializing the whole body, so the
 * fit is cached by the shared change list instead of redone per packet.
 */
const fittedBodies = new WeakMap<object, FittedBody>();

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
    const cached = fittedBodies.get(message.changes);
    if (
        cached &&
        cached.metadata === message.metadata &&
        cached.label === message.label &&
        cached.summary === message.summary
    ) {
        if (cached.tooLarge) {
            throw new EnvelopeTooLargeError(
                context.documentId ?? null,
                cached.tooLarge.bytes,
                cached.tooLarge.level
            );
        }
        return cached.fitted ? { ...message, ...cached.fitted } : message;
    }
    const fit = fitCollaborationMessagesToBudget(
        [message],
        OUTBOUND_METADATA_BUDGET_BYTES
    );
    const fittedMessage = fit.messages[0] as CollaborationMessageEnvelope;
    // The generated module infers the level from its first assignment.
    const level: number = fit.level;
    fittedBodies.set(message.changes, {
        metadata: message.metadata,
        label: message.label,
        summary: message.summary,
        fitted:
            fittedMessage === message
                ? null
                : {
                      changes: fittedMessage.changes,
                      metadata: fittedMessage.metadata,
                      label: fittedMessage.label,
                      summary: fittedMessage.summary
                  },
        tooLarge: fit.fits ? null : { bytes: fit.bytesAfter, level }
    });
    if (!fit.fits) {
        throw new EnvelopeTooLargeError(
            context.documentId ?? null,
            fit.bytesAfter,
            level
        );
    }
    if (fittedMessage === message) {
        return message;
    }
    pushCollabIntegrityEvent('metadata-compacted', {
        documentId: context.documentId ?? null,
        bytesBefore: fit.bytesBefore,
        bytesAfter: fit.bytesAfter,
        level,
        allGlyphsChanged: level === METADATA_FIT_LEVEL.ALL_GLYPHS_IN_DOCUMENT
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
