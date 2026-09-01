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

export type GlyphCatalogEntry = {
    glyphId: string;
    name: string;
    codepoints: number[];
    productionName?: string;
    latestGlyphRevision: string;
    exported?: boolean;
    deleted?: boolean;
};

export type CloudOwnedFontData = {
    glyphCatalog: GlyphCatalogEntry[];
    codepointIndex: Record<string, string[]>;
    fontDeps: Record<string, string[]>;
};

export type CatalogChangePath = Array<string | number>;

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
}

function getFormatSpecific(
    target: Record<string, unknown>
): Record<string, unknown> {
    const existing = asRecord(target.format_specific);
    if (existing) {
        return existing;
    }
    const created: Record<string, unknown> = {};
    target.format_specific = created;
    return created;
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

function collectShapeReferences(glyph: Record<string, unknown>): string[] {
    const refs: string[] = [];
    const layers = Array.isArray(glyph.layers) ? glyph.layers : [];
    for (const layer of layers) {
        const layerRecord = asRecord(layer);
        if (!layerRecord) {
            continue;
        }
        const shapes = Array.isArray(layerRecord.shapes)
            ? layerRecord.shapes
            : Array.isArray(layerRecord.components)
              ? layerRecord.components
              : [];
        for (const shape of shapes) {
            const shapeRecord = asRecord(shape);
            if (!shapeRecord) {
                continue;
            }
            const nested = asRecord(shapeRecord.Component);
            const reference =
                (typeof shapeRecord.reference === 'string' &&
                    shapeRecord.reference) ||
                (typeof nested?.reference === 'string' && nested.reference) ||
                '';
            if (reference) {
                refs.push(reference);
            }
        }
    }
    return refs;
}

function collectMetricsKeyStrings(glyph: Record<string, unknown>): string[] {
    const keys: string[] = [];
    const pushKey = (value: unknown) => {
        if (typeof value === 'string' && value.trim()) {
            keys.push(value);
        }
    };
    const formatSpecific = asRecord(glyph.format_specific);
    if (formatSpecific) {
        for (const value of Object.values(formatSpecific)) {
            pushKey(value);
        }
    }
    const layers = Array.isArray(glyph.layers) ? glyph.layers : [];
    for (const layer of layers) {
        const layerRecord = asRecord(layer);
        if (!layerRecord) {
            continue;
        }
        pushKey(layerRecord.leftMetricsKey);
        pushKey(layerRecord.rightMetricsKey);
        const layerFormat = asRecord(layerRecord.format_specific);
        if (layerFormat) {
            for (const value of Object.values(layerFormat)) {
                pushKey(value);
            }
        }
    }
    return keys;
}

function namesReferencedInMetricsKeys(
    keys: string[],
    namesByLength: string[]
): string[] {
    const found = new Set<string>();
    for (const key of keys) {
        for (const name of namesByLength) {
            if (name && key.includes(name)) {
                found.add(name);
            }
        }
    }
    return [...found];
}

export function buildLeanGlyphCatalog(fontJson: Record<string, unknown>): {
    entries: GlyphCatalogEntry[];
    codepointIndex: Record<string, string[]>;
} {
    const entries: GlyphCatalogEntry[] = [];
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
        entries.push({
            glyphId,
            name,
            codepoints,
            productionName,
            latestGlyphRevision: String(glyph.latestGlyphRevision || '0'),
            exported: glyph.exported !== false,
            deleted: glyph.deleted === true
        });
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

export function buildFontDepsIndex(
    fontJson: Record<string, unknown>
): Record<string, string[]> {
    const glyphs = listGlyphRecords(fontJson);
    const idByName = new Map<string, string>();
    for (const glyph of glyphs) {
        idByName.set(String(glyph.name || ''), ensureImmutableGlyphId(glyph));
    }
    const namesByLength = [...idByName.keys()].sort(
        (left, right) => right.length - left.length
    );
    const deps: Record<string, string[]> = {};
    for (const glyph of glyphs) {
        const glyphId = ensureImmutableGlyphId(glyph);
        const referenced = new Set<string>();
        for (const name of collectShapeReferences(glyph)) {
            const id = idByName.get(name);
            if (id && id !== glyphId) {
                referenced.add(id);
            }
        }
        for (const name of namesReferencedInMetricsKeys(
            collectMetricsKeyStrings(glyph),
            namesByLength
        )) {
            const id = idByName.get(name);
            if (id && id !== glyphId) {
                referenced.add(id);
            }
        }
        deps[glyphId] = [...referenced];
    }
    return deps;
}

export function applyCloudOwnedData(
    fontJson: Record<string, unknown>
): CloudOwnedFontData {
    const { entries, codepointIndex } = buildLeanGlyphCatalog(fontJson);
    const fontDeps = buildFontDepsIndex(fontJson);
    const owned: CloudOwnedFontData = {
        glyphCatalog: entries,
        codepointIndex,
        fontDeps
    };
    const formatSpecific = getFormatSpecific(fontJson);
    formatSpecific[CLOUD_PLUGIN_OWNED_KEY] = owned;
    return owned;
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
        field === 'id' ||
        field === 'layers'
    );
}

export function depsNeedUpdate(path: CatalogChangePath): boolean {
    if (path[0] !== 'glyphs') {
        return false;
    }
    return (
        path.includes('reference') ||
        path.includes('components') ||
        path.includes('shapes') ||
        path.includes('leftMetricsKey') ||
        path.includes('rightMetricsKey') ||
        path.includes('format_specific')
    );
}
