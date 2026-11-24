/**
 * Integrity gates for Yjs updates crossing a border (network, linked window,
 * worker, write-ahead log, checkpoint).
 *
 * Yjs applies an update’s deletions to items the receiver already has even
 * while the update’s own new items wait for an earlier update that never
 * arrived. A drawing then loses every plain value the missing update had
 * replaced (its width first of all) while the drawing itself stays. These
 * gates refuse such an update before anything is applied, and record the
 * document as broken. Nothing is repaired and no state is requested from
 * anyone: a refused update is a sender or transport bug to fix.
 */

import * as Y from 'yjs';
import { pushCollabIntegrityEvent } from './cloud-collab-integrity-debug';

export class ClockGapError extends Error {
    readonly documentId: string;
    readonly client: number;
    readonly need: number;
    readonly have: number;
    readonly reason: string;

    constructor(
        documentId: string,
        reason: string,
        client: number,
        need: number,
        have: number
    ) {
        super(
            `Refused an update for “${documentId}”: ${reason} (client ${client} needs clock ${need}, this copy has ${have}). An earlier update from that client never arrived.`
        );
        this.name = 'ClockGapError';
        this.documentId = documentId;
        this.reason = reason;
        this.client = client;
        this.need = need;
        this.have = have;
    }
}

export class BrokenDocumentError extends Error {
    readonly documentId: string;

    constructor(documentId: string, cause: Error) {
        super(
            `“${documentId}” is incomplete after a refused update and can’t be edited until the font is reloaded. ${cause.message}`
        );
        this.name = 'BrokenDocumentError';
        this.documentId = documentId;
    }
}

/**
 * An unsent edit restored from the write-ahead log reached a document whose
 * state from the room is not loaded here yet. Nothing is applied and the
 * document is not marked broken: this is a waiting state, not a gap. The
 * caller keeps the row and restores it once the document’s state is in.
 */
export class DocumentStateNotLoadedError extends Error {
    readonly documentId: string;

    constructor(documentId: string) {
        super(
            `An unsent edit for “${documentId}” can’t be restored yet: this window hasn’t loaded that document’s state from the room. The edit is kept and restored once the state is in.`
        );
        this.name = 'DocumentStateNotLoadedError';
        this.documentId = documentId;
    }
}

type BrokenRecord = { documentId: string; error: Error };

/**
 * Broken records of one engine, keyed by document id. A document that is
 * marked while this window does not hold it, or that is unloaded and loaded
 * again, stays broken: whatever loads under that id later is refused. The
 * owner clears the scope when it is destroyed, so a font reload (a new
 * engine) starts clean.
 */
export type BrokenDocumentScope = {
    readonly records: Map<string, BrokenRecord>;
};

// Keyed by the document object, so a destroyed document drops its record.
const brokenDocuments = new Map<Y.Doc, BrokenRecord>();
const brokenScopes = new Set<BrokenDocumentScope>();
const brokenListeners = new Set<(documentId: string, error: Error) => void>();

export function createBrokenDocumentScope(): BrokenDocumentScope {
    const scope: BrokenDocumentScope = { records: new Map() };
    brokenScopes.add(scope);
    return scope;
}

/** Forget every record in `scope` (its owner is gone or reloads the font). */
export function clearBrokenDocumentScope(scope: BrokenDocumentScope): void {
    scope.records.clear();
    brokenScopes.delete(scope);
}

/**
 * Record `documentId` as broken. `doc` is the document this window holds
 * for it, or null when it holds none; `scope` keeps the record by id so it
 * outlives that document object.
 */
export function markDocumentBroken(
    doc: Y.Doc | null,
    documentId: string,
    error: Error,
    scope?: BrokenDocumentScope
): void {
    const existing =
        (doc && brokenDocuments.get(doc)) || scope?.records.get(documentId);
    const record = existing ?? { documentId, error };
    if (doc && !brokenDocuments.has(doc)) {
        brokenDocuments.set(doc, record);
        doc.once('destroy', () => brokenDocuments.delete(doc));
    }
    if (scope && !scope.records.has(documentId)) {
        scope.records.set(documentId, record);
    }
    if (existing) {
        return;
    }
    pushCollabIntegrityEvent('document-broken', {
        documentId,
        error: error.message
    });
    console.error(`[Integrity] ${error.message}`);
    for (const listener of brokenListeners) {
        listener(documentId, error);
    }
}

export function isDocumentBroken(doc: Y.Doc): boolean {
    return brokenDocuments.has(doc);
}

export function isDocumentIdBroken(
    scope: BrokenDocumentScope,
    documentId: string
): boolean {
    return scope.records.has(documentId);
}

export function getBrokenDocuments(): Array<{
    documentId: string;
    error: string;
}> {
    const records = new Set<BrokenRecord>(brokenDocuments.values());
    for (const scope of brokenScopes) {
        for (const record of scope.records.values()) {
            records.add(record);
        }
    }
    return [...records].map(({ documentId, error }) => ({
        documentId,
        error: error.message
    }));
}

export function onDocumentBroken(
    listener: (documentId: string, error: Error) => void
): () => void {
    brokenListeners.add(listener);
    return () => brokenListeners.delete(listener);
}

/**
 * Throws when an edit or apply would touch a document that tripped a gate,
 * by its object or, with `scope`, by its id.
 */
export function assertDocumentWritable(
    doc: Y.Doc | null,
    documentId: string,
    scope?: BrokenDocumentScope
): void {
    const record =
        (doc && brokenDocuments.get(doc)) || scope?.records.get(documentId);
    if (record) {
        throw new BrokenDocumentError(documentId, record.error);
    }
}

// Struct kinds are told apart with `instanceof`, never by class name: the
// bundle is minified, so Yjs’s `Item` and `Skip` carry mangled names there.
type DecodedStruct = Y.Item | Y.GC | Y.Skip;

function isItemId(value: unknown): value is { client: number; clock: number } {
    return (
        !!value &&
        typeof value === 'object' &&
        typeof (value as { client?: unknown }).client === 'number' &&
        typeof (value as { clock?: unknown }).clock === 'number'
    );
}

/**
 * Throws a ClockGapError unless `update` integrates into `doc` completely:
 * every client’s structs start at or below what the doc has, nothing in it
 * is a gap, every item’s origin, right origin and parent item is known or
 * inside the update, and every deleted range is known. Applying an update
 * that passes leaves nothing pending. Run before Y.applyUpdate.
 */
export function assertUpdateIntegrates(
    doc: Y.Doc,
    update: Uint8Array,
    documentId: string
): void {
    if (!update?.byteLength) {
        return;
    }
    assertNoPendingState(doc, documentId);
    const decoded = Y.decodeUpdate(update) as {
        structs: DecodedStruct[];
        ds: { clients: Map<number, Array<{ clock: number; len: number }>> };
    };
    const next = new Map<number, number>(
        Y.decodeStateVector(Y.encodeStateVector(doc))
    );
    const byClient = new Map<number, DecodedStruct[]>();
    for (const struct of decoded.structs) {
        // A struct of no known kind (say from a second copy of Yjs, whose
        // classes `instanceof` does not see) is refused: skipping it would
        // let its origin and parent go unchecked.
        if (
            !(struct instanceof Y.Item) &&
            !(struct instanceof Y.GC) &&
            !(struct instanceof Y.Skip)
        ) {
            throw new Error(
                `Refused an update for “${documentId}”: it holds a change of a kind this window can’t check.`
            );
        }
        const list = byClient.get(struct.id.client);
        if (list) list.push(struct);
        else byClient.set(struct.id.client, [struct]);
    }
    for (const [client, list] of byClient) {
        list.sort((a, b) => a.id.clock - b.id.clock);
        const have = next.get(client) ?? 0;
        if (list[0].id.clock > have) {
            throw new ClockGapError(
                documentId,
                'it starts after the last change this copy has',
                client,
                list[0].id.clock,
                have
            );
        }
        let reach = have;
        for (const struct of list) {
            if (struct instanceof Y.Skip || struct.id.clock > reach) {
                throw new ClockGapError(
                    documentId,
                    'it has a hole',
                    client,
                    struct.id.clock,
                    reach
                );
            }
            reach = Math.max(reach, struct.id.clock + struct.length);
        }
        next.set(client, reach);
    }
    const known = (id: { client: number; clock: number }) =>
        id.clock < (next.get(id.client) ?? 0);
    for (const struct of decoded.structs) {
        if (!(struct instanceof Y.Item)) continue;
        for (const dependency of [
            struct.origin,
            struct.rightOrigin,
            isItemId(struct.parent) ? struct.parent : null
        ]) {
            if (dependency && !known(dependency)) {
                throw new ClockGapError(
                    documentId,
                    'a change it builds on is missing',
                    dependency.client,
                    dependency.clock + 1,
                    next.get(dependency.client) ?? 0
                );
            }
        }
    }
    for (const [client, ranges] of decoded.ds.clients) {
        const have = next.get(client) ?? 0;
        for (const range of ranges) {
            if (range.clock + range.len > have) {
                throw new ClockGapError(
                    documentId,
                    'it deletes something this copy never received',
                    client,
                    range.clock + range.len,
                    have
                );
            }
        }
    }
}

/** Throws when Yjs holds structs or deletions it could not integrate. */
export function assertNoPendingState(doc: Y.Doc, documentId: string): void {
    const store = doc.store as {
        pendingStructs: { missing: Map<number, number> } | null;
        pendingDs: Uint8Array | null;
    };
    if (store.pendingStructs) {
        const [client, clock] = [...store.pendingStructs.missing][0] ?? [0, 0];
        throw new ClockGapError(
            documentId,
            'this copy holds changes it could not place',
            client,
            clock,
            Y.getState(doc.store, client)
        );
    }
    if (store.pendingDs) {
        throw new ClockGapError(
            documentId,
            'this copy holds deletions it could not place',
            0,
            0,
            0
        );
    }
}

/**
 * Apply `update` to `doc` behind both gates. On a refusal nothing is
 * applied, the document is marked broken and the error is rethrown.
 */
export function applyUpdateWithIntegrity(
    doc: Y.Doc,
    update: Uint8Array,
    documentId: string,
    origin?: unknown,
    scope?: BrokenDocumentScope
): void {
    assertDocumentWritable(doc, documentId, scope);
    try {
        assertUpdateIntegrates(doc, update, documentId);
        Y.applyUpdate(doc, update, origin);
        assertNoPendingState(doc, documentId);
    } catch (error) {
        if (error instanceof ClockGapError) {
            markDocumentBroken(doc, documentId, error, scope);
        }
        throw error;
    }
}

/**
 * Throws unless `update` is a glyph document’s complete state: it fits an
 * empty document and carries the glyph’s name. A state that fits an empty
 * document can still be a delta (a client’s first edit to a root map starts
 * at clock 0), and a glyph made from a delta would lack its name and its
 * drawings’ widths.
 */
export function assertCompleteGlyphState(
    update: Uint8Array,
    documentId: string
): void {
    const probe = new Y.Doc({ gc: false });
    try {
        assertUpdateIntegrates(probe, update, documentId);
        Y.applyUpdate(probe, update);
        assertNoPendingState(probe, documentId);
        const name = probe.getMap('glyph').get('name');
        if (typeof name !== 'string' || !name) {
            const [client = 0] = Y.decodeStateVector(
                Y.encodeStateVectorFromUpdate(update)
            ).keys();
            throw new ClockGapError(
                documentId,
                'a delta for a glyph this window does not hold; only its complete state can make it',
                client,
                0,
                0
            );
        }
    } finally {
        probe.destroy();
    }
}

/**
 * True when `update` can make `documentId` from nothing: a glyph’s complete
 * state, or for any other document a state that fits an empty document.
 * Nothing is applied and nothing is marked broken.
 */
export function isCompleteDocumentState(
    update: Uint8Array,
    documentId: string
): boolean {
    try {
        if (documentId.startsWith('glyph:')) {
            assertCompleteGlyphState(update, documentId);
        } else {
            const probe = new Y.Doc({ gc: false });
            try {
                assertUpdateIntegrates(probe, update, documentId);
            } finally {
                probe.destroy();
            }
        }
        return true;
    } catch {
        // Not a complete state (or not decodable at all): the packet waits
        // for the document's full load, and applying it then reports any
        // decode error.
        return false;
    }
}

if (typeof window !== 'undefined') {
    (
        window as Window & {
            __collabBrokenDocuments?: typeof getBrokenDocuments;
        }
    ).__collabBrokenDocuments = getBrokenDocuments;
}
