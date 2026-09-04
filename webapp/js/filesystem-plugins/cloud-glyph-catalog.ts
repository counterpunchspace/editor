function generateStableId(): string {
    if (
        typeof crypto !== 'undefined' &&
        typeof crypto.randomUUID === 'function'
    ) {
        return crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const CLOUD_PLUGIN_OWNED_KEY = 'com.counterpunch.cloud';
export const CORE_GLYPH_CATALOG_KEY = 'glyphCatalog';
export const CORE_CODEPOINT_INDEX_KEY = 'codepointIndex';

export type GlyphCatalogEntry = {
    glyphId: string;
    name: string;
    codepoints: number[];
    productionName?: string;
    latestGlyphRevision: string;
    exported?: boolean;
    deleted?: boolean;
    generation: number;
};

export type CloudOwnedFontData = {
    glyphCatalog: Record<string, GlyphCatalogEntry>;
    codepointIndex: Record<string, string[]>;
};

export type CatalogChangePath = Array<string | number>;

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
}

function codepointIndexFromUnknown(value: unknown): Record<string, string[]> {
    const record = asRecord(value);
    if (!record) {
        return {};
    }
    const index: Record<string, string[]> = {};
    for (const [codepoint, members] of Object.entries(record)) {
        if (Array.isArray(members)) {
            index[codepoint] = members.map(String);
            continue;
        }
        const nested = asRecord(members);
        if (nested) {
            index[codepoint] = Object.keys(nested).filter(
                (glyphId) => nested[glyphId]
            );
        }
    }
    return index;
}

function codepointsFromUnknown(value: unknown): number[] {
    if (Array.isArray(value)) {
        return value.flatMap((entry) => {
            if (typeof entry === 'number' && Number.isFinite(entry)) {
                return [entry];
            }
            if (typeof entry === 'string' && Number.isFinite(Number(entry))) {
                return [Number(entry)];
            }
            return [];
        });
    }
    const record = asRecord(value);
    if (!record) {
        return [];
    }
    return Object.keys(record)
        .filter((key) => record[key])
        .map(Number)
        .filter((codepoint) => Number.isFinite(codepoint));
}

function catalogEntriesFromUnknown(
    value: unknown
): Record<string, GlyphCatalogEntry> | null {
    const record = asRecord(value);
    if (!record) {
        return null;
    }
    const entries: Record<string, GlyphCatalogEntry> = {};
    for (const [glyphId, entry] of Object.entries(record)) {
        const nested = asRecord(entry);
        if (!nested) {
            continue;
        }
        const id =
            typeof nested.glyphId === 'string' && nested.glyphId
                ? nested.glyphId
                : glyphId;
        entries[id] = {
            glyphId: id,
            name: typeof nested.name === 'string' ? nested.name : '',
            codepoints: codepointsFromUnknown(nested.codepoints),
            productionName:
                typeof nested.productionName === 'string'
                    ? nested.productionName
                    : undefined,
            latestGlyphRevision: String(nested.latestGlyphRevision || '0'),
            exported: nested.exported !== false,
            deleted: nested.deleted === true,
            generation: Number.isInteger(nested.generation)
                ? Number(nested.generation)
                : 0
        };
    }
    return entries;
}

export function ensureImmutableGlyphId(glyph: Record<string, unknown>): string {
    if (typeof glyph.id === 'string' && glyph.id.length > 0) {
        return glyph.id;
    }
    const id = generateStableId();
    glyph.id = id;
    return id;
}

/** Assign a stable id on every glyph in the live font JSON. */
export function stampImmutableGlyphIds(
    fontJson: Record<string, unknown>
): void {
    for (const glyph of listGlyphRecords(fontJson)) {
        ensureImmutableGlyphId(glyph);
    }
}

export function listGlyphRecords(
    fontJson: Record<string, unknown>
): Record<string, unknown>[] {
    if (Array.isArray(fontJson.glyphs)) {
        return fontJson.glyphs as Record<string, unknown>[];
    }
    if (fontJson.glyphs && typeof fontJson.glyphs === 'object') {
        return Object.values(fontJson.glyphs as Record<string, unknown>).filter(
            (glyph): glyph is Record<string, unknown> =>
                !!glyph && typeof glyph === 'object' && !Array.isArray(glyph)
        );
    }
    return [];
}

function writeOwnedToCoreJson(
    fontJson: Record<string, unknown>,
    owned: CloudOwnedFontData
): void {
    fontJson[CORE_GLYPH_CATALOG_KEY] = owned.glyphCatalog;
    fontJson[CORE_CODEPOINT_INDEX_KEY] = owned.codepointIndex;
    const formatSpecific = asRecord(fontJson.format_specific);
    if (formatSpecific && CLOUD_PLUGIN_OWNED_KEY in formatSpecific) {
        delete formatSpecific[CLOUD_PLUGIN_OWNED_KEY];
        if (Object.keys(formatSpecific).length === 0) {
            delete fontJson.format_specific;
        }
    }
}

export function applyCloudOwnedData(
    fontJson: Record<string, unknown>
): CloudOwnedFontData {
    const previous = catalogFromCoreJson(fontJson);
    const { entries, codepointIndex } = buildLeanGlyphCatalog(fontJson);
    const liveIds = new Set(Object.keys(entries));
    if (previous) {
        for (const [glyphId, entry] of Object.entries(previous.glyphCatalog)) {
            if (liveIds.has(glyphId)) {
                entries[glyphId] = {
                    ...entries[glyphId],
                    generation: entry.generation || 0
                };
                continue;
            }
            entries[glyphId] = tombstoneCatalogEntry(entry);
        }
    }
    const owned: CloudOwnedFontData = {
        glyphCatalog: entries,
        codepointIndex
    };
    writeOwnedToCoreJson(fontJson, owned);
    return owned;
}

export function patchCloudOwnedGlyph(
    fontJson: Record<string, unknown>,
    glyphName: string
): CloudOwnedFontData {
    const existing = catalogFromCoreJson(fontJson);
    if (!existing) {
        return applyCloudOwnedData(fontJson);
    }
    const glyphCatalog = { ...existing.glyphCatalog };
    const codepointIndex = { ...existing.codepointIndex };
    const glyph = listGlyphRecords(fontJson).find(
        (entry) => String(entry.name || '') === glyphName
    );
    if (!glyph) {
        return applyCloudOwnedData(fontJson);
    }
    const glyphId = ensureImmutableGlyphId(glyph);
    const previous = glyphCatalog[glyphId];
    for (const codepoint of Array.isArray(previous?.codepoints)
        ? previous.codepoints
        : []) {
        const key = String(codepoint);
        const members = Array.isArray(codepointIndex[key])
            ? codepointIndex[key].filter((id) => id !== glyphId)
            : [];
        if (members.length) codepointIndex[key] = members;
        else delete codepointIndex[key];
    }
    const entry: GlyphCatalogEntry = {
        glyphId,
        name: String(glyph.name || ''),
        codepoints: Array.isArray(glyph.codepoints)
            ? glyph.codepoints.filter(
                  (value): value is number =>
                      typeof value === 'number' && Number.isFinite(value)
              )
            : [],
        productionName:
            typeof glyph.production_name === 'string'
                ? glyph.production_name
                : undefined,
        latestGlyphRevision: String(glyph.latestGlyphRevision || '0'),
        exported: glyph.exported !== false,
        deleted: glyph.deleted === true,
        generation: previous?.deleted
            ? (previous.generation || 0) + 1
            : previous?.generation || 0
    };
    glyphCatalog[glyphId] = entry;
    for (const codepoint of entry.codepoints) {
        const key = String(codepoint);
        const members = Array.isArray(codepointIndex[key])
            ? [...codepointIndex[key]]
            : [];
        if (!members.includes(glyphId)) members.push(glyphId);
        codepointIndex[key] = members;
    }
    const owned = { glyphCatalog, codepointIndex };
    writeOwnedToCoreJson(fontJson, owned);
    return owned;
}

export function buildLeanGlyphCatalog(fontJson: Record<string, unknown>): {
    entries: Record<string, GlyphCatalogEntry>;
    codepointIndex: Record<string, string[]>;
} {
    const entries: Record<string, GlyphCatalogEntry> = {};
    const codepointIndex: Record<string, string[]> = {};
    for (const glyph of listGlyphRecords(fontJson)) {
        const glyphId = ensureImmutableGlyphId(glyph);
        const name = String(glyph.name || '');
        const codepoints = Array.isArray(glyph.codepoints)
            ? glyph.codepoints.filter(
                  (value): value is number =>
                      typeof value === 'number' && Number.isFinite(value)
              )
            : [];
        const productionName =
            typeof glyph.production_name === 'string'
                ? glyph.production_name
                : undefined;
        entries[glyphId] = {
            glyphId,
            name,
            codepoints,
            productionName,
            latestGlyphRevision: String(glyph.latestGlyphRevision || '0'),
            exported: glyph.exported !== false,
            deleted: glyph.deleted === true,
            generation: 0
        };
        for (const codepoint of codepoints) {
            const key = String(codepoint);
            if (!codepointIndex[key]) {
                codepointIndex[key] = [];
            }
            if (!codepointIndex[key].includes(glyphId)) {
                codepointIndex[key].push(glyphId);
            }
        }
    }
    return { entries, codepointIndex };
}

/** Read lean catalog/cmap from core-root maps, with a legacy format_specific fallback. */
export function catalogFromCoreJson(
    coreJson: Record<string, unknown>
): CloudOwnedFontData | null {
    const topCatalog = catalogEntriesFromUnknown(
        coreJson[CORE_GLYPH_CATALOG_KEY]
    );
    if (topCatalog && Object.keys(topCatalog).length) {
        return {
            glyphCatalog: topCatalog,
            codepointIndex: codepointIndexFromUnknown(
                coreJson[CORE_CODEPOINT_INDEX_KEY]
            )
        };
    }
    const formatSpecific = asRecord(coreJson.format_specific);
    const owned = asRecord(formatSpecific?.[CLOUD_PLUGIN_OWNED_KEY]);
    const nestedCatalog = catalogEntriesFromUnknown(owned?.glyphCatalog);
    if (!nestedCatalog) {
        return null;
    }
    return {
        glyphCatalog: nestedCatalog,
        codepointIndex: codepointIndexFromUnknown(owned?.codepointIndex)
    };
}

export function stripOwnedFontData<T>(fontJson: T): T {
    const record = asRecord(fontJson as unknown);
    if (!record) {
        return fontJson;
    }
    const cloned = JSON.parse(JSON.stringify(record)) as Record<
        string,
        unknown
    >;
    delete cloned[CORE_GLYPH_CATALOG_KEY];
    delete cloned[CORE_CODEPOINT_INDEX_KEY];
    const formatSpecific = asRecord(cloned.format_specific);
    if (formatSpecific && CLOUD_PLUGIN_OWNED_KEY in formatSpecific) {
        delete formatSpecific[CLOUD_PLUGIN_OWNED_KEY];
        if (Object.keys(formatSpecific).length === 0) {
            delete cloned.format_specific;
        } else {
            cloned.format_specific = formatSpecific;
        }
    }
    for (const glyph of listGlyphRecords(cloned)) {
        delete glyph.id;
    }
    return cloned as T;
}

export function catalogNeedsUpdate(path: CatalogChangePath): boolean {
    if (path[0] !== 'glyphs') {
        return path[0] === 'glyphOrder';
    }
    if (path.length <= 2) {
        return true;
    }
    const field = path[2];
    return (
        field === 'name' ||
        field === 'codepoints' ||
        field === 'production_name' ||
        field === 'exported' ||
        field === 'id'
    );
}

export function tombstoneCatalogEntry(
    entry: GlyphCatalogEntry
): GlyphCatalogEntry {
    return {
        glyphId: entry.glyphId,
        name: entry.name,
        codepoints: [],
        productionName: entry.productionName,
        latestGlyphRevision: entry.latestGlyphRevision,
        exported: false,
        deleted: true,
        generation: entry.deleted
            ? entry.generation || 0
            : (entry.generation || 0) + 1
    };
}

export function liveCatalogGlyphIds(
    catalog: Record<string, GlyphCatalogEntry>
): string[] {
    return Object.values(catalog)
        .filter((entry) => entry.glyphId && entry.deleted !== true)
        .map((entry) => entry.glyphId);
}

export function isCatalogTombstone(
    catalog: Record<string, GlyphCatalogEntry> | undefined,
    glyphId: string
): boolean {
    return catalog?.[glyphId]?.deleted === true;
}

export function catalogAcceptsGlyphWrite(
    catalog: Record<string, GlyphCatalogEntry> | undefined,
    glyphId: string,
    generation?: number
): boolean {
    const entry = catalog?.[glyphId];
    if (!entry || entry.deleted === true) {
        return false;
    }
    if (generation == null) {
        return true;
    }
    return (entry.generation || 0) === generation;
}
