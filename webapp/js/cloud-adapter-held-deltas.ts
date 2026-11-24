/**
 * Deltas for a document this window has not loaded wait for its full load.
 *
 * A delta names only what changed. Applied to a document this window does
 * not hold, it would make one that lacks everything else (its name, its
 * drawings’ widths), or land in another document. It is never applied
 * early and never dropped: it waits, in arrival order per document, until
 * the document’s full load completes, and then applies in that order.
 */
import {
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID
} from './filesystem-plugins/cloud-document-set';

type DocumentInstanceSource = {
    getDocumentInstance?: (documentId: string) => object | null | undefined;
};

/**
 * True when `documentId` is loaded in this window. Font-core and font-deps
 * always are. An engine without `getDocumentInstance` cannot tell, so every
 * document counts as loaded and the engine’s own refusal applies.
 */
export function documentIsLoaded(bridge: unknown, documentId: string): boolean {
    if (
        documentId === FONT_CORE_DOCUMENT_ID ||
        documentId === FONT_DEPS_DOCUMENT_ID
    ) {
        return true;
    }
    const source = bridge as DocumentInstanceSource | null | undefined;
    if (typeof source?.getDocumentInstance !== 'function') {
        return true;
    }
    return !!source.getDocumentInstance(documentId);
}

type DocumentLoadedSource = {
    onDocumentLoaded?: (
        listener: (documentId: string) => void
    ) => (() => void) | void;
    offDocumentLoaded?: (listener: (documentId: string) => void) => void;
};

/**
 * Call `listener` each time the engine finishes loading a document, so
 * held deltas apply right then instead of waiting for the next packet.
 * An engine without the event gets no subscription; held deltas still
 * apply on the next packet, catch-up or snapshot. Returns the unsubscribe.
 */
export function subscribeDocumentLoaded(
    bridge: unknown,
    listener: (documentId: string) => void
): () => void {
    const source = bridge as DocumentLoadedSource | null | undefined;
    if (typeof source?.onDocumentLoaded !== 'function') {
        return () => {};
    }
    const unsubscribe = source.onDocumentLoaded(listener);
    return () => {
        if (typeof unsubscribe === 'function') {
            unsubscribe();
        } else {
            source.offDocumentLoaded?.(listener);
        }
    };
}

/** Per document, the deltas that wait for its full load, in arrival order. */
export class HeldDocumentDeltas<T> {
    private readonly _held = new Map<string, T[]>();

    hold(documentId: string, item: T): void {
        const queue = this._held.get(documentId);
        if (queue) {
            queue.push(item);
        } else {
            this._held.set(documentId, [item]);
        }
    }

    has(documentId: string): boolean {
        return this._held.has(documentId);
    }

    count(documentId: string): number {
        return this._held.get(documentId)?.length ?? 0;
    }

    documentIds(): string[] {
        return [...this._held.keys()];
    }

    /** Remove and return this document’s held deltas, oldest first. */
    take(documentId: string): T[] {
        const queue = this._held.get(documentId) ?? [];
        this._held.delete(documentId);
        return queue;
    }
}
