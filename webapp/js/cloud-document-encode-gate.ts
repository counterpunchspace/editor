/**
 * Gate for bytes that stand for a whole document: seeds, linked-window
 * snapshots and catch-ups, Save As. They must never carry a hole.
 */
import * as Y from 'yjs';
import {
    assertNoPendingState,
    BrokenDocumentError,
    getBrokenDocuments
} from './yjs-update-integrity';

/**
 * Throws while the document is marked broken, or when the encoded state
 * holds changes Yjs could not place (they would be passed on as if the
 * document were complete).
 */
export function assertEncodableDocumentState(
    bytes: Uint8Array,
    documentId: string
): void {
    const broken = getBrokenDocuments().find(
        (entry) => entry.documentId === documentId
    );
    if (broken) {
        throw new BrokenDocumentError(documentId, new Error(broken.error));
    }
    if (!bytes.byteLength) {
        return;
    }
    const probe = new Y.Doc();
    try {
        Y.applyUpdate(probe, bytes);
        assertNoPendingState(probe, documentId);
    } finally {
        probe.destroy();
    }
}

/** The same gate for every shard of a seed (Save As, room move). */
export function assertEncodableDocumentSet(
    shards: ReadonlyArray<{ documentId: string; bytes: Uint8Array }>
): void {
    for (const shard of shards) {
        assertEncodableDocumentState(shard.bytes, shard.documentId);
    }
}
