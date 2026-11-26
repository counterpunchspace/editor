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

type SparseGlyphDataExtras = Partial<
    Pick<
        GlyphData,
        | 'decomposition'
        | 'decimal'
        | 'digit'
        | 'numeric'
        | 'unicode_1_name'
        | 'iso_comment'
        | 'uppercase'
        | 'lowercase'
        | 'titlecase'
        | 'script_extensions'
        | 'name_aliases'
    >
>;

/**
 * Loads the build-time Glyph Data JSON once and keeps a compact columnar
 * JavaScript search index for Add Glyphs and Glyph.glyphData lookups.
 */
export class GlyphDataIndex {
    private count = 0;
    private codepoints = new Int32Array(0);
    private glyphNames: string[] = [];
    private unicodeNamesBlob = '';
    private unicodeNameOffsets = new Uint32Array(0);
    private categoryTable: string[] = [''];
    private categoryIds = new Uint8Array(0);
    private scriptTable: string[] = [''];
    private scriptIds = new Uint8Array(0);
    private blockTable: string[] = [''];
    private blockIds = new Uint16Array(0);
    private ageTable: string[] = [''];
    private ageIds = new Uint8Array(0);
    private bidiTable: string[] = [''];
    private bidiIds = new Uint8Array(0);
    private combiningTable: string[] = [''];
    private combiningIds = new Uint8Array(0);
    private mirroredTable: string[] = [''];
    private mirroredIds = new Uint8Array(0);
    private joiningTypeTable: string[] = [''];
    private joiningTypeIds = new Uint8Array(0);
    private joiningGroupTable: string[] = [''];
    private joiningGroupIds = new Uint8Array(0);
    private sparseExtrasBlob = '';
    private sparseExtraStarts = new Int32Array(0);
    private sparseExtraLengths = new Uint16Array(0);
    private byCodepoint = new Map<number, number>();
    private byName = new Map<string, number>();
    private scriptBySuffix: Map<string, string> | null = null;
    private readyPromise: Promise<void> | null = null;

    isReady(): boolean {
        return this.count > 0;
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
        const index = this.byCodepoint.get(codepoints[0]!);
        return index === undefined ? undefined : this.materialize(index);
    }

    getGlyphDataForName(name: string): GlyphDataSearchResult | undefined {
        const index = this.byName.get(name);
        return index === undefined ? undefined : this.materialize(index);
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
            for (let i = 0; i < this.count; i++) {
                const script = this.scriptTable[this.scriptIds[i]!] || '';
                if (!script || script === 'Common' || script === 'Inherited') {
                    continue;
                }
                const baseName = this.glyphNames[i]!.split('.', 1)[0] || '';
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
            const end = Math.min(limit, this.count);
            const results: GlyphDataSearchResult[] = new Array(end);
            for (let i = 0; i < end; i++) {
                results[i] = this.materialize(i);
            }
            return results;
        }

        const hex = codepointQuery(normalized);
        const queryWords = normalized.split(/\s+/).filter(Boolean);
        const suffixSegment = normalized.startsWith('-')
            ? normalized
            : undefined;
        const querySingleCodepoint =
            Array.from(query).length === 1 ? query.codePointAt(0) : undefined;
        const results: Array<{ index: number; score: number }> = [];
        for (let i = 0; i < this.count; i++) {
            const cp = this.codepoints[i]!;
            const codepoint = cp.toString(16).toLowerCase();
            const name = this.glyphNames[i]!.toLowerCase();
            const unicodeName = this.unicodeNamesBlob
                .slice(
                    this.unicodeNameOffsets[i]!,
                    this.unicodeNameOffsets[i + 1]!
                )
                .toLowerCase();
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
                (querySingleCodepoint !== undefined &&
                    cp === querySingleCodepoint &&
                    characterForCodepoint(cp) === query)
            ) {
                score = 1;
            }
            if (score) {
                results.push({ index: i, score });
            }
        }

        return results
            .sort(
                (left, right) =>
                    right.score - left.score ||
                    this.glyphNames[left.index]!.localeCompare(
                        this.glyphNames[right.index]!
                    ) ||
                    this.codepoints[left.index]! - this.codepoints[right.index]!
            )
            .slice(0, limit)
            .map(({ index }) => this.materialize(index));
    }

    /** Test helper: replace the index with an in-memory catalog. */
    loadRecordsForTests(records: GlyphData[]): void {
        this.applyRecords(records);
        this.readyPromise = Promise.resolve();
    }

    /** Test helper: clear the index so ensureReady() reloads. */
    resetForTests(): void {
        this.count = 0;
        this.codepoints = new Int32Array(0);
        this.glyphNames = [];
        this.unicodeNamesBlob = '';
        this.unicodeNameOffsets = new Uint32Array(0);
        this.categoryTable = [''];
        this.categoryIds = new Uint8Array(0);
        this.scriptTable = [''];
        this.scriptIds = new Uint8Array(0);
        this.blockTable = [''];
        this.blockIds = new Uint16Array(0);
        this.ageTable = [''];
        this.ageIds = new Uint8Array(0);
        this.bidiTable = [''];
        this.bidiIds = new Uint8Array(0);
        this.combiningTable = [''];
        this.combiningIds = new Uint8Array(0);
        this.mirroredTable = [''];
        this.mirroredIds = new Uint8Array(0);
        this.joiningTypeTable = [''];
        this.joiningTypeIds = new Uint8Array(0);
        this.joiningGroupTable = [''];
        this.joiningGroupIds = new Uint8Array(0);
        this.sparseExtrasBlob = '';
        this.sparseExtraStarts = new Int32Array(0);
        this.sparseExtraLengths = new Uint16Array(0);
        this.byCodepoint = new Map();
        this.byName = new Map();
        this.scriptBySuffix = null;
        this.readyPromise = null;
    }

    private materialize(index: number): GlyphDataSearchResult {
        const codepoint = this.codepoints[index]!;
        const generalCategory = this.categoryTable[this.categoryIds[index]!]!;
        const record: GlyphDataSearchResult = {
            codepoint,
            glyph_name: this.glyphNames[index]!,
            name: this.unicodeNamesBlob.slice(
                this.unicodeNameOffsets[index]!,
                this.unicodeNameOffsets[index + 1]!
            ),
            general_category: generalCategory,
            script: this.scriptTable[this.scriptIds[index]!]!,
            character: characterForCodepoint(codepoint)
        };
        const block = this.blockTable[this.blockIds[index]!];
        if (block) record.block = block;
        const age = this.ageTable[this.ageIds[index]!];
        if (age) record.age = age;
        const bidiClass = this.bidiTable[this.bidiIds[index]!];
        if (bidiClass) record.bidi_class = bidiClass;
        const combiningClass = this.combiningTable[this.combiningIds[index]!];
        if (combiningClass) record.combining_class = combiningClass;
        const mirrored = this.mirroredTable[this.mirroredIds[index]!];
        if (mirrored) record.mirrored = mirrored;
        const joiningType = this.joiningTypeTable[this.joiningTypeIds[index]!];
        if (joiningType) record.joining_type = joiningType;
        const joiningGroup =
            this.joiningGroupTable[this.joiningGroupIds[index]!];
        if (joiningGroup) record.joining_group = joiningGroup;
        const extraLen = this.sparseExtraLengths[index]!;
        if (extraLen > 0) {
            const extraStart = this.sparseExtraStarts[index]!;
            Object.assign(
                record,
                JSON.parse(
                    this.sparseExtrasBlob.slice(
                        extraStart,
                        extraStart + extraLen
                    )
                ) as SparseGlyphDataExtras
            );
        }
        return record;
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
        console.log(`Loaded ${this.count} Glyph Data records.`);
    }

    private applyRecords(records: GlyphData[]): void {
        const n = records.length;
        const codepoints = new Int32Array(n);
        const glyphNames: string[] = new Array(n);
        const unicodeNameParts: string[] = new Array(n);
        const unicodeNameOffsets = new Uint32Array(n + 1);
        let unicodeNameCursor = 0;

        const makeInterner = () => {
            const table: string[] = [''];
            const map = new Map<string, number>([['', 0]]);
            const intern = (value: string | undefined): number => {
                const normalized = value || '';
                let id = map.get(normalized);
                if (id === undefined) {
                    id = table.length;
                    table.push(normalized);
                    map.set(normalized, id);
                }
                return id;
            };
            return { table, intern };
        };

        const cat = makeInterner();
        const script = makeInterner();
        const block = makeInterner();
        const age = makeInterner();
        const bidi = makeInterner();
        const combining = makeInterner();
        const mirrored = makeInterner();
        const joiningType = makeInterner();
        const joiningGroup = makeInterner();

        const categoryIds = new Uint8Array(n);
        const scriptIds = new Uint8Array(n);
        const blockIds = new Uint16Array(n);
        const ageIds = new Uint8Array(n);
        const bidiIds = new Uint8Array(n);
        const combiningIds = new Uint8Array(n);
        const mirroredIds = new Uint8Array(n);
        const joiningTypeIds = new Uint8Array(n);
        const joiningGroupIds = new Uint8Array(n);
        const sparseExtraParts: string[] = [];
        const sparseExtraStarts = new Int32Array(n);
        const sparseExtraLengths = new Uint16Array(n);
        let sparseExtraCursor = 0;
        const byCodepoint = new Map<number, number>();
        const byName = new Map<string, number>();

        for (let i = 0; i < n; i++) {
            const record = records[i]!;
            codepoints[i] = record.codepoint;
            glyphNames[i] = record.glyph_name;
            const uname = record.name || '';
            unicodeNameParts[i] = uname;
            unicodeNameOffsets[i] = unicodeNameCursor;
            unicodeNameCursor += uname.length;
            categoryIds[i] = cat.intern(
                record.general_category || record.category
            );
            scriptIds[i] = script.intern(record.script);
            blockIds[i] = block.intern(record.block);
            ageIds[i] = age.intern(record.age);
            bidiIds[i] = bidi.intern(record.bidi_class);
            combiningIds[i] = combining.intern(record.combining_class);
            mirroredIds[i] = mirrored.intern(record.mirrored);
            joiningTypeIds[i] = joiningType.intern(record.joining_type);
            joiningGroupIds[i] = joiningGroup.intern(record.joining_group);

            const extra: SparseGlyphDataExtras = {};
            let hasExtra = false;
            if (record.decomposition) {
                extra.decomposition = record.decomposition;
                hasExtra = true;
            }
            if (record.decimal) {
                extra.decimal = record.decimal;
                hasExtra = true;
            }
            if (record.digit) {
                extra.digit = record.digit;
                hasExtra = true;
            }
            if (record.numeric) {
                extra.numeric = record.numeric;
                hasExtra = true;
            }
            if (record.unicode_1_name) {
                extra.unicode_1_name = record.unicode_1_name;
                hasExtra = true;
            }
            if (record.iso_comment) {
                extra.iso_comment = record.iso_comment;
                hasExtra = true;
            }
            if (record.uppercase) {
                extra.uppercase = record.uppercase;
                hasExtra = true;
            }
            if (record.lowercase) {
                extra.lowercase = record.lowercase;
                hasExtra = true;
            }
            if (record.titlecase) {
                extra.titlecase = record.titlecase;
                hasExtra = true;
            }
            if (
                Array.isArray(record.script_extensions)
                    ? record.script_extensions.length > 0
                    : Boolean(record.script_extensions)
            ) {
                extra.script_extensions = record.script_extensions;
                hasExtra = true;
            }
            if (record.name_aliases && record.name_aliases.length > 0) {
                extra.name_aliases = record.name_aliases;
                hasExtra = true;
            }
            if (hasExtra) {
                const json = JSON.stringify(extra);
                sparseExtraParts.push(json);
                sparseExtraStarts[i] = sparseExtraCursor;
                sparseExtraLengths[i] = json.length;
                sparseExtraCursor += json.length;
            }

            byCodepoint.set(record.codepoint, i);
            byName.set(record.glyph_name, i);
        }
        unicodeNameOffsets[n] = unicodeNameCursor;

        this.count = n;
        this.codepoints = codepoints;
        this.glyphNames = glyphNames;
        this.unicodeNamesBlob = unicodeNameParts.join('');
        this.unicodeNameOffsets = unicodeNameOffsets;
        this.categoryTable = cat.table;
        this.categoryIds = categoryIds;
        this.scriptTable = script.table;
        this.scriptIds = scriptIds;
        this.blockTable = block.table;
        this.blockIds = blockIds;
        this.ageTable = age.table;
        this.ageIds = ageIds;
        this.bidiTable = bidi.table;
        this.bidiIds = bidiIds;
        this.combiningTable = combining.table;
        this.combiningIds = combiningIds;
        this.mirroredTable = mirrored.table;
        this.mirroredIds = mirroredIds;
        this.joiningTypeTable = joiningType.table;
        this.joiningTypeIds = joiningTypeIds;
        this.joiningGroupTable = joiningGroup.table;
        this.joiningGroupIds = joiningGroupIds;
        this.sparseExtrasBlob = sparseExtraParts.join('');
        this.sparseExtraStarts = sparseExtraStarts;
        this.sparseExtraLengths = sparseExtraLengths;
        this.byCodepoint = byCodepoint;
        this.byName = byName;
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

// Static catalog — warm eagerly at boot in compact columnar form (no Pyodide).
// Skip in Jest where `fetch` is unset unless a test mocks it.
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
