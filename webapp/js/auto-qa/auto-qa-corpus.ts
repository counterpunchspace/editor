import { Logger } from '../logger';

const console = new Logger('AutoQa');

export const QA_CORPUS_URL = '/data/qa-corpus.json.gz';
export const QA_CORPUS_READY_EVENT = 'counterpunch:qa-corpus-ready';

export type QaIdentityRow = {
    n: number;
    n_mark_system?: number;
    k_has_any_component: number;
    k_has_any_anchor: number;
    components: Record<string, number>;
    anchors: Record<string, number>;
};

export type QaCorpusTable = {
    version: number;
    mark_anchor_names: string[];
    identities: Record<string, QaIdentityRow>;
};

/**
 * Loads the bundled Auto QA identity table once. Matching stays in-process;
 * this is counts JSON, not a neural net.
 */
export class QaCorpusIndex {
    private table: QaCorpusTable | null = null;
    private markAnchorNames = new Set<string>();
    private readyPromise: Promise<void> | null = null;

    isReady(): boolean {
        return this.table !== null;
    }

    getTable(): QaCorpusTable | null {
        return this.table;
    }

    isMarkAnchorName(name: string): boolean {
        return this.markAnchorNames.has(name);
    }

    async ensureReady(): Promise<void> {
        if (this.isReady()) {
            return;
        }
        if (!this.readyPromise) {
            this.readyPromise = this.load().catch((error) => {
                this.readyPromise = null;
                throw error;
            });
        }
        return this.readyPromise;
    }

    getIdentity(identity: string): QaIdentityRow | undefined {
        return this.table?.identities[identity];
    }

    /** Test helper: replace the table with an in-memory corpus. */
    loadTableForTests(table: QaCorpusTable): void {
        this.applyTable(table);
        this.readyPromise = Promise.resolve();
    }

    /** Test helper: clear so ensureReady() reloads. */
    resetForTests(): void {
        this.table = null;
        this.markAnchorNames = new Set();
        this.readyPromise = null;
    }

    private async load(): Promise<void> {
        const response = await fetch(QA_CORPUS_URL);
        if (!response.ok) {
            throw new Error(
                `Unable to load Auto QA corpus (${response.status}).`
            );
        }
        const table = JSON.parse(
            await decompressGzipResponse(response)
        ) as QaCorpusTable;
        this.applyTable(table);
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new Event(QA_CORPUS_READY_EVENT));
        }
        console.log(
            `Loaded Auto QA corpus (${Object.keys(table.identities || {}).length} identities).`
        );
    }

    private applyTable(table: QaCorpusTable): void {
        this.table = {
            version: table.version || 1,
            mark_anchor_names: Array.isArray(table.mark_anchor_names)
                ? table.mark_anchor_names
                : [],
            identities: table.identities || {}
        };
        this.markAnchorNames = new Set(this.table.mark_anchor_names);
    }
}

async function decompressGzipResponse(response: Response): Promise<string> {
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('Gzip DecompressionStream is not available.');
    }
    if (!response.body) {
        throw new Error('Auto QA corpus response has no body.');
    }
    const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
}

export const qaCorpusIndex = new QaCorpusIndex();
(globalThis as { qaCorpusIndex?: QaCorpusIndex }).qaCorpusIndex = qaCorpusIndex;

if (typeof window !== 'undefined' && typeof fetch === 'function') {
    void qaCorpusIndex
        .ensureReady()
        .catch((error) =>
            console.warn('Auto QA corpus will be retried when opened.', error)
        );
}
