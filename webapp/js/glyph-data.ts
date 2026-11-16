import { Logger } from './logger';

const console = new Logger('GlyphData');

const GLYPH_DATA_URL = '/data/glyph-data.json.gz';

/** Hex digits from a codepoint query, without the leading zeros in `U+08A8`. */
export function codepointQuery(normalized: string): string {
    const hex = normalized.replace(/^(?:u\+|0x)/, '');
    if (!/^[0-9a-f]+$/.test(hex)) {
        return hex;
    }
    return hex.replace(/^0+/, '') || '0';
}

/** Readable names of Unicode general categories. */
export const GENERAL_CATEGORY_LABELS: Record<string, string> = {
    Lu: 'Uppercase Letter',
    Ll: 'Lowercase Letter',
    Lt: 'Titlecase Letter',
    Lm: 'Modifier Letter',
    Lo: 'Other Letter',
    Mn: 'Nonspacing Mark',
    Mc: 'Spacing Mark',
    Me: 'Enclosing Mark',
    Nd: 'Decimal Number',
    Nl: 'Letter Number',
    No: 'Other Number',
    Pc: 'Connector Punctuation',
    Pd: 'Dash Punctuation',
    Ps: 'Open Punctuation',
    Pe: 'Close Punctuation',
    Pi: 'Initial Punctuation',
    Pf: 'Final Punctuation',
    Po: 'Other Punctuation',
    Sm: 'Math Symbol',
    Sc: 'Currency Symbol',
    Sk: 'Modifier Symbol',
    So: 'Other Symbol',
    Zs: 'Space Separator',
    Zl: 'Line Separator',
    Zp: 'Paragraph Separator',
    Cc: 'Control',
    Cf: 'Format Control',
    Cs: 'Surrogate',
    Co: 'Private Use',
    Cn: 'Unassigned'
};

export interface GlyphData {
    codepoint: number;
    glyph_name: string;
    name: string;
    general_category: string;
    category?: string;
    script: string;
    script_extensions?: string | string[];
    block?: string;
    age?: string;
    joining_type?: string;
    joining_group?: string;
    decomposition?: string;
    combining_class?: string;
    bidi_class?: string;
    decimal?: string;
    digit?: string;
    numeric?: string;
    mirrored?: string;
    unicode_1_name?: string;
    iso_comment?: string;
    uppercase?: string;
    lowercase?: string;
    titlecase?: string;
    name_aliases?: Array<[string, string] | string[]>;
}

export interface GlyphDataSearchResult extends GlyphData {
    character: string;
}

/**
 * Loads the build-time Glyph Data JSON once and keeps a JavaScript search
 * index for Add Glyphs and Glyph.glyphData lookups.
 */
export class GlyphDataIndex {
    private records: GlyphDataSearchResult[] = [];
    private byCodepoint = new Map<number, GlyphDataSearchResult>();
    private byName = new Map<string, GlyphDataSearchResult>();
    private scriptBySuffix: Map<string, string> | null = null;
    private readyPromise: Promise<void> | null = null;

    isReady(): boolean {
        return this.records.length > 0;
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

    getGlyphDataForUnicode(
        codepoints: readonly number[] | undefined
    ): GlyphDataSearchResult | undefined {
        if (!codepoints || codepoints.length !== 1) {
            return undefined;
        }
        return this.byCodepoint.get(codepoints[0]!);
    }

    getGlyphDataForName(name: string): GlyphDataSearchResult | undefined {
        return this.byName.get(name);
    }

    /**
     * The writing script a glyph name suffix such as `ar` in `alef-ar`
     * stands for, learned from the catalog's own glyph names: a suffix
     * counts when at least 90% of its catalog glyphs share one writing
     * script other than Common or Inherited.
     */
    scriptForNameSuffix(suffix: string): string | undefined {
        if (!this.scriptBySuffix) {
            const counts = new Map<string, Map<string, number>>();
            for (const record of this.records) {
                const script = record.script;
                if (!script || script === 'Common' || script === 'Inherited') {
                    continue;
                }
                const baseName = record.glyph_name.split('.', 1)[0] || '';
                const dash = baseName.lastIndexOf('-');
                if (dash <= 0) continue;
                const key = baseName.slice(dash + 1);
                const perScript = counts.get(key) ?? new Map<string, number>();
                perScript.set(script, (perScript.get(script) ?? 0) + 1);
                counts.set(key, perScript);
            }
            this.scriptBySuffix = new Map();
            for (const [key, perScript] of counts) {
                let total = 0;
                let best = '';
                let bestCount = 0;
                for (const [script, count] of perScript) {
                    total += count;
                    if (count > bestCount) {
                        best = script;
                        bestCount = count;
                    }
                }
                if (bestCount >= total * 0.9) {
                    this.scriptBySuffix.set(key, best);
                }
            }
        }
        return this.scriptBySuffix.get(suffix);
    }

    search(query: string, limit = 150): GlyphDataSearchResult[] {
        const normalized = query.trim().toLowerCase();
        if (!normalized) {
            return this.records.slice(0, limit);
        }

        const hex = codepointQuery(normalized);
        const queryWords = normalized.split(/\s+/).filter(Boolean);
        const suffixSegment = normalized.startsWith('-')
            ? normalized
            : undefined;
        const results: Array<{ record: GlyphDataSearchResult; score: number }> =
            [];
        for (const record of this.records) {
            const codepoint = record.codepoint.toString(16).toLowerCase();
            const name = record.glyph_name.toLowerCase();
            const unicodeName = record.name.toLowerCase();
            let score = 0;
            if (name === normalized || codepoint === hex) {
                score = 4;
            } else if (
                suffixSegment &&
                (name.endsWith(suffixSegment) ||
                    name.includes(`${suffixSegment}.`))
            ) {
                score = 3;
            } else if (
                name.startsWith(normalized) ||
                codepoint.startsWith(hex)
            ) {
                score = 3;
            } else if (
                queryWords.every((queryWord) =>
                    unicodeName
                        .split(/\s+/)
                        .some((word) => word.startsWith(queryWord))
                )
            ) {
                score = 2;
            } else if (
                name.includes(normalized) ||
                unicodeName.includes(normalized) ||
                record.character === query
            ) {
                score = 1;
            }
            if (score) {
                results.push({ record, score });
            }
        }

        return results
            .sort(
                (left, right) =>
                    right.score - left.score ||
                    left.record.glyph_name.localeCompare(
                        right.record.glyph_name
                    ) ||
                    left.record.codepoint - right.record.codepoint
            )
            .slice(0, limit)
            .map(({ record }) => record);
    }

    /** Test helper: replace the index with an in-memory catalog. */
    loadRecordsForTests(records: GlyphData[]): void {
        this.applyRecords(records);
        this.readyPromise = Promise.resolve();
    }

    /** Test helper: clear the index so ensureReady() reloads. */
    resetForTests(): void {
        this.records = [];
        this.byCodepoint = new Map();
        this.byName = new Map();
        this.scriptBySuffix = null;
        this.readyPromise = null;
    }

    private async load(): Promise<void> {
        const response = await fetch(GLYPH_DATA_URL);
        if (!response.ok) {
            throw new Error(
                `Unable to load Glyph Data catalog (${response.status}).`
            );
        }
        const records = JSON.parse(
            await decompressGzipResponse(response)
        ) as GlyphData[];
        this.applyRecords(records);
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new Event('counterpunch:glyph-data-ready'));
        }
        console.log(`Loaded ${this.records.length} Glyph Data records.`);
    }

    private applyRecords(records: GlyphData[]): void {
        this.records = records.map((record) => ({
            ...record,
            general_category: record.general_category || record.category || '',
            character: characterForCodepoint(record.codepoint)
        }));
        this.byCodepoint = new Map(
            this.records.map((record) => [record.codepoint, record])
        );
        this.byName = new Map(
            this.records.map((record) => [record.glyph_name, record])
        );
        this.scriptBySuffix = null;
    }
}

function characterForCodepoint(codepoint: number): string {
    return codepoint >= 0x20 && codepoint !== 0x7f && codepoint <= 0x10ffff
        ? String.fromCodePoint(codepoint)
        : '';
}

async function decompressGzipResponse(response: Response): Promise<string> {
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('Gzip DecompressionStream is not available.');
    }
    if (!response.body) {
        throw new Error('Glyph Data response has no body.');
    }
    const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
}

// Bootstrap and the rebuild-composition chunk each evaluate this module.
// Reuse the first index so a second copy does not replace a loaded catalog
// with an empty one and report "no recipe".
const glyphDataHolder = globalThis as { glyphDataIndex?: GlyphDataIndex };
const createdGlyphDataIndex = !glyphDataHolder.glyphDataIndex;
if (createdGlyphDataIndex) {
    glyphDataHolder.glyphDataIndex = new GlyphDataIndex();
}
export const glyphDataIndex = glyphDataHolder.glyphDataIndex!;

// Static catalog — safe to warm during boot (no Pyodide). Skip in Jest
// where `fetch` is unset unless a test mocks it. Only the first copy starts
// the fetch; later copies share that index.
if (
    createdGlyphDataIndex &&
    typeof window !== 'undefined' &&
    typeof fetch === 'function'
) {
    void glyphDataIndex
        .ensureReady()
        .catch((error) =>
            console.warn('Glyph Data will be retried when opened.', error)
        );
}
