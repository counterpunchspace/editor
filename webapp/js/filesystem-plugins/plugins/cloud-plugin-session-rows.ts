/**
 * Outbox rows written while a reconnect briefly leaves no cloud session.
 *
 * The engine hands every cloud packet to the plugin to write its device
 * outbox row. Between one session going and the next attaching there is no
 * write-ahead log to take it. The row is then kept here, in memory and in
 * order, and written into the next session of the same font before any
 * later row; the engine is told it is not durable yet (like a storage
 * failure), never that the document is broken. A row the next session
 * refuses outright (not a storage failure) is a real refusal.
 */
import { recordCollabTrace } from '../../collab-trace';
import { CloudWalPersistError } from '../../cloud-durable-wal';

type KeptRow<S> = {
    assetId: string | null;
    documentId: string;
    write: (session: S) => Promise<unknown>;
};

type HeldRow<S> = KeptRow<S> & {
    /** Settles the promise `keepRowUntilSession` returned for this row. */
    settle: (outcome: { value: unknown } | { error: unknown }) => void;
};

type KeptRowsState<S> = {
    rows: HeldRow<S>[];
    /** Rows a flush took out of `rows` and has not written yet. */
    writing: HeldRow<S>[];
    flush: Promise<void>;
};

const states = new WeakMap<object, KeptRowsState<unknown>>();

function stateFor<S>(owner: object): KeptRowsState<S> {
    let state = states.get(owner) as KeptRowsState<S> | undefined;
    if (!state) {
        state = { rows: [], writing: [], flush: Promise.resolve() };
        states.set(owner, state as KeptRowsState<unknown>);
    }
    return state;
}

/**
 * Rows `owner` keeps until a session of `assetId` is back, including those
 * a flush is writing into a session right now: a new row must go behind
 * them, never straight into the session past them.
 */
export function keptSessionRowCount(
    owner: object,
    assetId?: string | null
): number {
    const state = states.get(owner);
    const rows = state ? [...state.writing, ...state.rows] : [];
    if (assetId === undefined) {
        return rows.length;
    }
    return rows.filter((row) => row.assetId === null || row.assetId === assetId)
        .length;
}

/** Resolves once kept rows handed to a session are written (or refused). */
export function keptSessionRowsWritten(owner: object): Promise<void> {
    return states.get(owner)?.flush ?? Promise.resolve();
}

/**
 * Keep a row until a session of `assetId` is back. The returned promise
 * settles once the row is written into a session: with what its `write`
 * resolved, or rejected with what it threw (a storage failure or a
 * refusal). It stays pending while no session takes the row. Callers that
 * do not need it may ignore it; it never raises an unhandled rejection.
 */
export function keepRowUntilSession<S>(
    owner: object,
    row: KeptRow<S>
): Promise<unknown> {
    const state = stateFor<S>(owner);
    let settle: HeldRow<S>['settle'] = () => {};
    const written = new Promise<unknown>((resolve, reject) => {
        settle = (outcome) => {
            if ('error' in outcome) {
                reject(outcome.error);
            } else {
                resolve(outcome.value);
            }
        };
    });
    written.catch(() => undefined);
    state.rows.push({ ...row, settle });
    recordCollabTrace('outbox-row-awaits-session', [], {
        document: row.documentId,
        asset: row.assetId,
        kept: state.rows.length
    });
    return written;
}

/**
 * Write the kept rows of `assetId` into `session`, in the order they were
 * made. Rows of another font stay kept. `isCurrent` false stops the walk
 * (the session went again); the rest stay kept, in order.
 */
export function writeKeptRowsIntoSession<S>(
    owner: object,
    session: S,
    assetId: string,
    options: {
        isCurrent: () => boolean;
        refused: (documentId: string, error: Error) => void;
    }
): Promise<void> {
    const state = stateFor<S>(owner);
    state.flush = state.flush.then(async () => {
        let written = 0;
        // Rows kept while this runs (a linked window's relay) join in order.
        for (;;) {
            const mine = state.rows.filter(
                (row) => row.assetId === null || row.assetId === assetId
            );
            if (!mine.length) {
                break;
            }
            state.rows = state.rows.filter((row) => !mine.includes(row));
            state.writing = [...mine];
            let stopped = false;
            for (let index = 0; index < mine.length; index += 1) {
                if (!options.isCurrent()) {
                    state.rows = [...mine.slice(index), ...state.rows];
                    state.writing = [];
                    stopped = true;
                    break;
                }
                const row = mine[index];
                try {
                    // A session refuses a row by throwing; `false` is a row
                    // with nothing to write or one kept in the WAL's memory.
                    const value = await row.write(session);
                    state.writing = state.writing.filter(
                        (held) => held !== row
                    );
                    written += 1;
                    row.settle({ value });
                } catch (error) {
                    state.writing = state.writing.filter(
                        (held) => held !== row
                    );
                    row.settle({ error });
                    // A storage failure keeps the row in the session's WAL
                    // memory; anything else is the session refusing it.
                    if (error instanceof CloudWalPersistError) {
                        written += 1;
                        continue;
                    }
                    try {
                        options.refused(
                            row.documentId,
                            error instanceof Error
                                ? error
                                : new Error(String(error))
                        );
                    } catch (reportError) {
                        // Reporting must not stop the rows behind it.
                        console.error(
                            'Cloud outbox: reporting a refused kept row failed:',
                            reportError
                        );
                    }
                }
            }
            if (stopped) {
                break;
            }
        }
        if (written) {
            recordCollabTrace('outbox-rows-written-after-session', [], {
                asset: assetId,
                written,
                kept: state.rows.length
            });
        }
    });
    return state.flush;
}
