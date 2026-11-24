/**
 * Unsent rows from the write-ahead log go back into a document only on top
 * of the state they were made on.
 *
 * After a reload a window’s unsent edit can build on its own earlier edit
 * that the room already acknowledged (and so left the log). The document
 * then needs the room’s state first; applied before it, the row has a gap
 * the integrity gate refuses. Such a row is never dropped and never marks
 * the document broken: it waits, in log order per document, until the
 * document’s state is loaded from the room, and then applies. A row whose
 * changes the document already holds is skipped. Only a row that still
 * does not fit once the room’s complete state is in is a real gap.
 */
import * as Y from 'yjs';
import { ClockGapError, assertUpdateIntegrates } from './yjs-update-integrity';

export type UnsentRowVerdict =
    /** Every change it carries is in the document already. */
    | 'integrated'
    /** It fits on top of what the document holds now. */
    | 'applicable'
    /** The document is not loaded, or lacks a change the row builds on. */
    | 'waiting';

type DocumentInstanceSource = {
    getDocumentInstance?: (documentId: string) => unknown;
};

/** The Y.Doc that holds `documentId` in `bridge`, or null. */
export function documentInstanceOf(
    bridge: unknown,
    documentId: string
): Y.Doc | null {
    const source = bridge as DocumentInstanceSource | null;
    if (!source || typeof source.getDocumentInstance !== 'function') {
        return null;
    }
    const doc = source.getDocumentInstance(documentId);
    return doc instanceof Y.Doc ? doc : null;
}

/**
 * True when the row carries at least one change and the document holds all
 * of them. A row of deletions alone is never counted as held: deleting
 * twice is harmless, so it simply applies again.
 */
export function unsentRowIsIntegrated(doc: Y.Doc, update: Uint8Array): boolean {
    if (!update?.byteLength) {
        return true;
    }
    // Where each client's changes in the row end. Y's own
    // `encodeStateVectorFromUpdate` leaves out clients whose changes in
    // the update do not start at clock 0, which is every delta.
    const rowState = new Map<number, number>();
    for (const struct of Y.decodeUpdate(update).structs) {
        if (struct instanceof Y.Skip) {
            continue;
        }
        const end = struct.id.clock + struct.length;
        if (end > (rowState.get(struct.id.client) ?? 0)) {
            rowState.set(struct.id.client, end);
        }
    }
    if (rowState.size === 0) {
        return false;
    }
    const docState = Y.decodeStateVector(Y.encodeStateVector(doc));
    for (const [client, clock] of rowState) {
        if ((docState.get(client) ?? 0) < clock) {
            return false;
        }
    }
    return true;
}

/**
 * Where an unsent row stands against the document. `gap` is the refusal a
 * waiting row would meet now; it is a real gap only once the document holds
 * the room’s complete state.
 */
export function classifyUnsentRow(
    doc: Y.Doc | null,
    update: Uint8Array,
    documentId: string
): { verdict: UnsentRowVerdict; gap?: ClockGapError } {
    if (!doc) {
        return { verdict: 'waiting' };
    }
    if (unsentRowIsIntegrated(doc, update)) {
        return { verdict: 'integrated' };
    }
    try {
        assertUpdateIntegrates(doc, update, documentId);
    } catch (error) {
        if (error instanceof ClockGapError) {
            return { verdict: 'waiting', gap: error };
        }
        throw error;
    }
    return { verdict: 'applicable' };
}

export type UnsentRowsResult<T> = {
    /** Rows applied now, in order. */
    applied: T[];
    /** Rows skipped because the document holds them already. */
    skipped: T[];
    /** The first row that did not fit and every row after it, in order. */
    waiting: T[];
    /** Why the first waiting row did not fit (absent: document not loaded). */
    gap?: ClockGapError;
};

/**
 * Apply `rows` in order while each fits. The first row that does not fit
 * stops the walk: it and every later row of the document wait, so no row
 * ever overtakes an earlier one.
 */
export function applyUnsentRowsInOrder<T>(
    rows: readonly T[],
    options: {
        documentId: string;
        doc: () => Y.Doc | null;
        /**
         * False when the engine cannot show its documents: every row then
         * applies in order and the engine's own gate decides.
         */
        inspectable?: boolean;
        update: (row: T) => Uint8Array;
        apply: (row: T) => void;
    }
): UnsentRowsResult<T> {
    const result: UnsentRowsResult<T> = {
        applied: [],
        skipped: [],
        waiting: []
    };
    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const update = options.update(row);
        if (!update?.byteLength) {
            result.skipped.push(row);
            continue;
        }
        if (options.inspectable === false) {
            options.apply(row);
            result.applied.push(row);
            continue;
        }
        const { verdict, gap } = classifyUnsentRow(
            options.doc(),
            update,
            options.documentId
        );
        if (verdict === 'integrated') {
            result.skipped.push(row);
            continue;
        }
        if (verdict === 'waiting') {
            result.waiting = rows.slice(index);
            result.gap = gap;
            return result;
        }
        options.apply(row);
        result.applied.push(row);
    }
    return result;
}
