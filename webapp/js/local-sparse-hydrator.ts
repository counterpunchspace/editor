/**
 * Local Sparse / Streaming Font Open & On-Demand Glyph Hydration.
 *
 * When a large local font (e.g. CJK with 12k–15k+ glyphs) is opened,
 * `fontc-worker` parses the source once into `FONT_CACHE` and returns only
 * `coreFontJson` + `glyphCatalog` (with `component_deps` and `metrics_deps`).
 * Only the active working set is hydrated into `babelfontData` +
 * `PatchSyncEngine`; remaining glyphs are hydrated transparently on demand
 * from `fontc-worker` in milliseconds.
 */

import { Logger } from './logger';
import { fontCompilation, type OpenFontSparseResult } from './font-compilation';
import type { GlyphCatalogEntry } from './filesystem-plugins/cloud-glyph-catalog';
import {
    type FontDepEdgeKind,
    type FontDepsIndex
} from './filesystem-plugins/cloud-font-deps';
import { glyphDocumentId } from './filesystem-plugins/cloud-document-set';

type FontDepsRelation = FontDepEdgeKind;

const console = new Logger('LocalSparseHydrator');

/**
 * Fonts with at least this many glyphs stay sparse after `openFontSparse`;
 * smaller fonts hydrate all glyphs in one initial batch so small test fonts
 * stay 100% resident immediately.
 */
export const LOCAL_SPARSE_GLYPH_THRESHOLD = 500;

const HYDRATE_BATCH_SIZE = 256;

export type LocalSparseBootstrapPayload = {
    coreData: Record<string, unknown>;
    glyphOrder: string[];
    glyphCatalog: Record<string, GlyphCatalogEntry>;
    codepointIndex: Record<string, string[]>;
    glyphIdByName: Map<string, string>;
    glyphNameById: Map<string, string>;
    fontDeps: FontDepsIndex;
    forwardDepsByName: Map<string, Set<string>>;
    reverseDepsByName: Map<string, Set<string>>;
    isSparse: boolean;
};

/**
 * Drop malformed components that have a missing or empty `reference` (e.g. in
 * real-world `.glyphs` files like `IBM Plex Sans KR.glyphs`) so Y.Doc geometry
 * normalization never aborts opening or hydrating the font.
 */
export function sanitizeGlyphEmptyReferenceComponents(
    glyph: Record<string, unknown>
): Record<string, unknown> {
    const layers = glyph.layers;
    if (!Array.isArray(layers)) {
        return glyph;
    }
    for (const rawLayer of layers) {
        if (!rawLayer || typeof rawLayer !== 'object') {
            continue;
        }
        const layer = rawLayer as Record<string, unknown>;
        if (!Array.isArray(layer.shapes)) {
            continue;
        }
        let dropped = 0;
        const filtered: unknown[] = [];
        for (const rawShape of layer.shapes) {
            if (!rawShape || typeof rawShape !== 'object') {
                filtered.push(rawShape);
                continue;
            }
            const shape = rawShape as Record<string, unknown>;
            const innerComponent =
                shape.Component && typeof shape.Component === 'object'
                    ? (shape.Component as Record<string, unknown>)
                    : null;
            if (innerComponent) {
                if (
                    typeof innerComponent.reference !== 'string' ||
                    !innerComponent.reference.trim()
                ) {
                    dropped += 1;
                    continue;
                }
                filtered.push(rawShape);
                continue;
            }
            const isPath =
                Array.isArray(shape.nodes) ||
                (shape.Path && typeof shape.Path === 'object');
            if (!isPath && 'reference' in shape) {
                if (
                    typeof shape.reference !== 'string' ||
                    !shape.reference.trim()
                ) {
                    dropped += 1;
                    continue;
                }
            }
            filtered.push(rawShape);
        }
        if (dropped > 0) {
            layer.shapes = filtered;
        }
    }
    return glyph;
}

function generateLocalGlyphId(index: number): string {
    if (
        typeof crypto !== 'undefined' &&
        typeof crypto.randomUUID === 'function'
    ) {
        return crypto.randomUUID();
    }
    return `local-glyph-${index}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Build the compact core data, glyphCatalog, codepointIndex, and fontDeps
 * dependency graph directly from `openFontSparse`'s catalog payload.
 */
export function buildLocalSparseBootstrap(
    sparseResult: OpenFontSparseResult
): LocalSparseBootstrapPayload {
    const coreData = JSON.parse(sparseResult.coreFontJson) as Record<
        string,
        unknown
    >;
    const glyphOrder = sparseResult.glyphOrder.length
        ? [...sparseResult.glyphOrder]
        : sparseResult.glyphCatalog.map((entry) => entry.name);

    const glyphIdByName = new Map<string, string>();
    const glyphNameById = new Map<string, string>();
    const glyphCatalog: Record<string, GlyphCatalogEntry> = {};
    const codepointIndex: Record<string, string[]> = {};

    for (let i = 0; i < sparseResult.glyphCatalog.length; i++) {
        const entry = sparseResult.glyphCatalog[i]!;
        const glyphId = generateLocalGlyphId(i);
        glyphIdByName.set(entry.name, glyphId);
        glyphNameById.set(glyphId, entry.name);
        const codepoints = Array.isArray(entry.codepoints)
            ? entry.codepoints.filter(
                  (cp): cp is number =>
                      typeof cp === 'number' && Number.isFinite(cp)
              )
            : [];
        for (const cp of codepoints) {
            const key = String(cp);
            const list = codepointIndex[key] ?? [];
            list.push(glyphId);
            codepointIndex[key] = list;
        }
        glyphCatalog[glyphId] = {
            glyphId,
            name: entry.name,
            codepoints,
            ...(entry.production_name
                ? { productionName: entry.production_name }
                : undefined),
            latestGlyphRevision: '',
            exported: entry.exported !== false,
            generation: 0
        };
    }

    const edges: Record<string, Record<string, FontDepsRelation>> = {};
    const sourceRevision: Record<string, string> = {};
    const forwardDepsByName = new Map<string, Set<string>>();
    const reverseDepsByName = new Map<string, Set<string>>();

    const addEdge = (
        sourceId: string,
        targetId: string,
        relation: 'component' | 'metrics-key'
    ) => {
        const row = edges[sourceId] ?? {};
        const prev = row[targetId];
        row[targetId] = prev && prev !== relation ? 'both' : relation;
        edges[sourceId] = row;
    };

    const addNameEdge = (
        map: Map<string, Set<string>>,
        from: string,
        to: string
    ) => {
        let set = map.get(from);
        if (!set) {
            set = new Set();
            map.set(from, set);
        }
        set.add(to);
    };

    for (const entry of sparseResult.glyphCatalog) {
        const dependentId = glyphIdByName.get(entry.name);
        if (!dependentId) continue;
        const compIds: string[] = [];
        for (const depName of entry.component_deps ?? []) {
            const sourceId = glyphIdByName.get(depName);
            if (!sourceId || sourceId === dependentId) continue;
            compIds.push(sourceId);
            addEdge(sourceId, dependentId, 'component');
            addNameEdge(forwardDepsByName, entry.name, depName);
            addNameEdge(reverseDepsByName, depName, entry.name);
        }
        if (compIds.length) {
            glyphCatalog[dependentId]!.componentIds = compIds;
        }
        for (const depName of entry.metrics_deps ?? []) {
            const sourceId = glyphIdByName.get(depName);
            if (!sourceId || sourceId === dependentId) continue;
            addEdge(sourceId, dependentId, 'metrics-key');
            addNameEdge(forwardDepsByName, entry.name, depName);
            addNameEdge(reverseDepsByName, depName, entry.name);
        }
    }

    coreData.glyphs = [];
    coreData.glyphOrder = glyphOrder;
    coreData.glyphCatalog = glyphCatalog;
    coreData.codepointIndex = codepointIndex;

    const isSparse =
        sparseResult.glyphCatalog.length >= LOCAL_SPARSE_GLYPH_THRESHOLD;

    return {
        coreData,
        glyphOrder,
        glyphCatalog,
        codepointIndex,
        glyphIdByName,
        glyphNameById,
        fontDeps: { edges, sourceRevision },
        forwardDepsByName,
        reverseDepsByName,
        isSparse
    };
}

/**
 * Compute initial working-set glyph names for a local sparse open:
 * `.notdef` + glyphs mapped from the initial text + transitive forward
 * component/metrics prerequisites (and reverse dependents for edited seeds).
 */
export function computeLocalWorkingSetNames(
    bootstrap: LocalSparseBootstrapPayload,
    seedNames: Iterable<string>,
    text?: string,
    includeReverse = false
): string[] {
    const result = new Set<string>();
    const queue: string[] = [];
    const enqueue = (name: string | undefined | null) => {
        if (!name || result.has(name) || !bootstrap.glyphIdByName.has(name)) {
            return;
        }
        result.add(name);
        queue.push(name);
    };

    if (bootstrap.glyphIdByName.has('.notdef')) {
        enqueue('.notdef');
    }
    for (const name of seedNames) {
        enqueue(name);
    }
    if (text) {
        for (const ch of text) {
            const cp = ch.codePointAt(0);
            if (cp === undefined) continue;
            const ids = bootstrap.codepointIndex[String(cp)];
            if (!ids) continue;
            for (const id of ids) {
                enqueue(bootstrap.glyphNameById.get(id));
            }
        }
    }
    // Ensure at least a handful of glyphs are hydrated if text mapped to none.
    if (result.size <= 1 && bootstrap.glyphOrder.length > 0) {
        for (const name of bootstrap.glyphOrder.slice(0, 16)) {
            enqueue(name);
        }
    }

    // Phase 1 (optional): reverse-dependent closure from seeds ONLY.
    // Never bounce from forward-discovered prerequisites back into reverse
    // dependents — doing so floods the entire connected component of a font's
    // component/metrics graph (e.g. a -> Aacute -> acutecomb -> every accented glyph).
    if (includeReverse) {
        const reverseQueue = [...queue];
        while (reverseQueue.length > 0) {
            const current = reverseQueue.pop()!;
            const reverse = bootstrap.reverseDepsByName.get(current);
            if (reverse) {
                for (const dep of reverse) {
                    if (
                        !dep ||
                        result.has(dep) ||
                        !bootstrap.glyphIdByName.has(dep)
                    ) {
                        continue;
                    }
                    result.add(dep);
                    reverseQueue.push(dep);
                    queue.push(dep);
                }
            }
        }
    }

    // Phase 2: forward prerequisite closure (components + metrics keys) from
    // seeds (and any Phase 1 reverse dependents).
    while (queue.length > 0) {
        const current = queue.pop()!;
        const forward = bootstrap.forwardDepsByName.get(current);
        if (forward) {
            for (const dep of forward) {
                enqueue(dep);
            }
        }
    }

    return [...result];
}

export class LocalSparseHydrator {
    private bootstrap: LocalSparseBootstrapPayload;
    private queue: Promise<void> = Promise.resolve();
    private allHydrated = false;

    constructor(bootstrap: LocalSparseBootstrapPayload) {
        this.bootstrap = bootstrap;
        this.allHydrated = !bootstrap.isSparse;
    }

    isActive(): boolean {
        return !this.allHydrated;
    }

    getBootstrap(): LocalSparseBootstrapPayload {
        return this.bootstrap;
    }

    async ensureHydrated(input: {
        text?: string;
        glyphNames?: string[];
        purpose?: 'ui' | 'compile';
    }): Promise<string[]> {
        if (this.allHydrated) {
            return [];
        }
        let hydratedNames: string[] = [];
        const work = this.queue.then(async () => {
            if (this.allHydrated) {
                return;
            }
            const includeReverse = input.purpose !== 'compile';
            const closureNames = computeLocalWorkingSetNames(
                this.bootstrap,
                input.glyphNames ?? [],
                input.text,
                includeReverse
            );
            const bridge = window.patchSyncEngine;
            const missing = closureNames.filter((name) => {
                const glyphId = this.bootstrap.glyphIdByName.get(name);
                if (!glyphId) return false;
                return !bridge?.hasResidentGlyphDocument?.(
                    glyphDocumentId(glyphId)
                );
            });
            if (!missing.length) {
                return;
            }
            await this.hydrateMissingNames(missing);
            hydratedNames = missing;
        });
        this.queue = work.catch(() => undefined);
        await work;
        return hydratedNames;
    }

    async hydrateAll(): Promise<void> {
        if (this.allHydrated) {
            return;
        }
        const work = this.queue.then(async () => {
            if (this.allHydrated) {
                return;
            }
            const bridge = window.patchSyncEngine;
            const missing: string[] = [];
            for (const [name, glyphId] of this.bootstrap.glyphIdByName) {
                if (
                    !bridge?.hasResidentGlyphDocument?.(
                        glyphDocumentId(glyphId)
                    )
                ) {
                    missing.push(name);
                }
            }
            if (missing.length) {
                await this.hydrateMissingNames(missing);
            }
            this.allHydrated = true;
        });
        this.queue = work.catch(() => undefined);
        await work;
    }

    private async hydrateMissingNames(missing: string[]): Promise<void> {
        const bridge = window.patchSyncEngine;
        if (!bridge) {
            return;
        }
        for (
            let offset = 0;
            offset < missing.length;
            offset += HYDRATE_BATCH_SIZE
        ) {
            const batchNames = missing.slice(
                offset,
                offset + HYDRATE_BATCH_SIZE
            );
            const rawGlyphs =
                await fontCompilation.requestGlyphsJsonBatch(batchNames);
            if (!rawGlyphs.length) {
                continue;
            }
            const items: Array<{
                glyphId: string;
                glyphName: string;
                glyphJson: Record<string, unknown>;
            }> = [];
            for (const rawGlyph of rawGlyphs) {
                const name =
                    typeof rawGlyph.name === 'string' ? rawGlyph.name : '';
                const glyphId = this.bootstrap.glyphIdByName.get(name);
                if (!name || !glyphId) continue;
                sanitizeGlyphEmptyReferenceComponents(rawGlyph);
                rawGlyph.id = glyphId;
                items.push({
                    glyphId,
                    glyphName: name,
                    glyphJson: rawGlyph
                });
            }
            if (!items.length) {
                continue;
            }
            const encodedShards = bridge.hydrateLocalGlyphsFromWorker(items);
            if (encodedShards.length) {
                await fontCompilation.replaceWorkerDocuments(encodedShards, {
                    preserveLocalFont: true
                });
            }
        }
        console.log(`Hydrated ${missing.length} local sparse glyphs on demand`);
    }
}
