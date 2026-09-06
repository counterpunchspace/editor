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
    componentIds?: string[];
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

function stringIdsFromUnknown(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
        if (typeof entry !== 'string' || !entry || seen.has(entry)) {
            continue;
        }
        seen.add(entry);
        ids.push(entry);
    }
    return ids;
}

function collectGlyphComponentNames(glyph: Record<string, unknown>): string[] {
    const refs: string[] = [];
    const visitShape = (shape: unknown) => {
        const shapeRecord = asRecord(shape);
        if (!shapeRecord) {
            return;
        }
        const nested = asRecord(shapeRecord.Component);
        const data = asRecord(shapeRecord.data);
        const reference =
            (typeof shapeRecord.reference === 'string' &&
                shapeRecord.reference) ||
            (typeof nested?.reference === 'string' && nested.reference) ||
            (typeof data?.reference === 'string' && data.reference) ||
            '';
        if (reference) {
            refs.push(reference);
        }
        const nestedShapes = Array.isArray(shapeRecord.shapes)
            ? shapeRecord.shapes
            : [];
        for (const child of nestedShapes) {
            visitShape(child);
        }
    };
    const layers = Array.isArray(glyph.layers) ? glyph.layers : [];
    for (const layer of layers) {
        const layerRecord = asRecord(layer);
        if (!layerRecord) {
            continue;
        }
        const shapes = Array.isArray(layerRecord.shapes)
            ? layerRecord.shapes
            : [];
        for (const shape of shapes) {
            visitShape(shape);
        }
    }
    return refs;
}

function componentIdsForGlyph(
    glyph: Record<string, unknown>,
    idByName: Map<string, string>
): string[] | undefined {
    const sourceId = ensureImmutableGlyphId(glyph);
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const name of collectGlyphComponentNames(glyph)) {
        const id = idByName.get(name);
        if (!id || id === sourceId || seen.has(id)) {
            continue;
        }
        seen.add(id);
        ids.push(id);
    }
    return ids.length ? ids : undefined;
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
        const componentIds = stringIdsFromUnknown(nested.componentIds);
        if (componentIds.length) {
            entries[id].componentIds = componentIds;
        }
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
    const bodyIds = new Set(
        listGlyphRecords(fontJson)
            .map((glyph) => ensureImmutableGlyphId(glyph))
            .filter(Boolean)
    );
    let nextIndex = codepointIndex;
    if (previous) {
        const previousLiveIds = liveCatalogGlyphIds(previous.glyphCatalog);
        const sparseRebuild = previousLiveIds.some((id) => !bodyIds.has(id));
        if (sparseRebuild) {
            nextIndex = { ...previous.codepointIndex };
            for (const [codepoint, members] of Object.entries(codepointIndex)) {
                nextIndex[codepoint] = members;
            }
        }
        for (const [glyphId, entry] of Object.entries(previous.glyphCatalog)) {
            if (entries[glyphId]) {
                const rebuilt = entries[glyphId];
                entries[glyphId] = {
                    ...rebuilt,
                    generation: entry.generation || 0,
                    ...(rebuilt.componentIds?.length
                        ? {}
                        : Array.isArray(entry.componentIds) &&
                            entry.componentIds.length
                          ? { componentIds: entry.componentIds }
                          : {})
                };
                continue;
            }
            if (sparseRebuild && entry.deleted !== true) {
                entries[glyphId] = entry;
                continue;
            }
            entries[glyphId] = tombstoneCatalogEntry(entry);
        }
    }
    const owned: CloudOwnedFontData = {
        glyphCatalog: entries,
        codepointIndex: nextIndex
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
    const idByName = new Map<string, string>();
    for (const existing of Object.values(glyphCatalog)) {
        if (existing.name && existing.deleted !== true) {
            idByName.set(existing.name, existing.glyphId);
        }
    }
    idByName.set(entry.name, glyphId);
    const componentIds = componentIdsForGlyph(glyph, idByName);
    if (componentIds) {
        entry.componentIds = componentIds;
    }
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
    const idByName = new Map<string, string>();
    for (const entry of Object.values(entries)) {
        if (entry.name && entry.deleted !== true) {
            idByName.set(entry.name, entry.glyphId);
        }
    }
    for (const glyph of listGlyphRecords(fontJson)) {
        const glyphId = ensureImmutableGlyphId(glyph);
        const entry = entries[glyphId];
        if (!entry || entry.deleted === true) {
            continue;
        }
        const componentIds = componentIdsForGlyph(glyph, idByName);
        if (componentIds) {
            entry.componentIds = componentIds;
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
    if (
        field === 'name' ||
        field === 'codepoints' ||
        field === 'production_name' ||
        field === 'exported' ||
        field === 'id'
    ) {
        return true;
    }
    return isComponentReferencePath(path);
}

function isComponentReferencePath(path: CatalogChangePath): boolean {
    const changedField = String(path[path.length - 1] ?? '');
    if (changedField === 'reference') {
        return true;
    }
    const shapesAt = path.lastIndexOf('shapes');
    return (
        shapesAt >= 0 &&
        path.length === shapesAt + 2 &&
        /^\d+$/.test(String(path[shapesAt + 1] ?? ''))
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

export type OverviewGlyphRecord = {
    id: string;
    name: string;
    glyphId?: string;
    codepoints: number[];
    hydrated: boolean;
};

/**
 * All-Glyphs membership for overview tiles. Catalog + glyphOrder is the
 * universe; Font.glyphs only marks which bodies are resident.
 */
/** Map live catalog glyph names to assigned Unicode codepoints. */
export function catalogCodepointsByGlyphName(
    fontJson?: Record<string, unknown> | null
): Map<string, number[]> {
    const map = new Map<string, number[]>();
    const owned = fontJson ? catalogFromCoreJson(fontJson) : null;
    if (!owned) {
        return map;
    }
    for (const entry of Object.values(owned.glyphCatalog)) {
        if (entry.deleted === true || !entry.name) {
            continue;
        }
        if (Array.isArray(entry.codepoints) && entry.codepoints.length) {
            map.set(entry.name, entry.codepoints);
        }
    }
    return map;
}

export function listOverviewGlyphRecords(options: {
    fontJson?: Record<string, unknown> | null;
    hydratedGlyphs?: Array<{ name?: string; codepoints?: number[] }>;
}): OverviewGlyphRecord[] {
    const hydratedGlyphs = options.hydratedGlyphs || [];
    const hydratedByName = new Map<
        string,
        { name: string; codepoints: number[] }
    >();
    for (const glyph of hydratedGlyphs) {
        const name = typeof glyph?.name === 'string' ? glyph.name : '';
        if (!name) {
            continue;
        }
        hydratedByName.set(name, {
            name,
            codepoints: Array.isArray(glyph.codepoints) ? glyph.codepoints : []
        });
    }
    const owned = options.fontJson
        ? catalogFromCoreJson(options.fontJson)
        : null;
    if (!owned) {
        return [...hydratedByName.values()].map((glyph) => ({
            id: glyph.name,
            name: glyph.name,
            codepoints: glyph.codepoints,
            hydrated: true
        }));
    }

    const liveEntries = Object.values(owned.glyphCatalog).filter(
        (entry) => entry.glyphId && entry.deleted !== true && entry.name
    );
    const byName = new Map(liveEntries.map((entry) => [entry.name, entry]));
    const order = Array.isArray(options.fontJson?.glyphOrder)
        ? options.fontJson.glyphOrder.map(String)
        : [];
    const seen = new Set<string>();
    const records: OverviewGlyphRecord[] = [];
    const pushEntry = (entry: GlyphCatalogEntry) => {
        if (seen.has(entry.name)) {
            return;
        }
        seen.add(entry.name);
        records.push({
            id: entry.name,
            name: entry.name,
            glyphId: entry.glyphId,
            codepoints: Array.isArray(entry.codepoints) ? entry.codepoints : [],
            hydrated: hydratedByName.has(entry.name)
        });
    };
    for (const name of order) {
        const entry = byName.get(name);
        if (entry) {
            pushEntry(entry);
        }
    }
    for (const entry of liveEntries) {
        pushEntry(entry);
    }
    return records;
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
