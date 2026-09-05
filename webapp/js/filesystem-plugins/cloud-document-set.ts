import * as Y from 'yjs';
import {
    applyCloudOwnedData,
    catalogFromCoreJson,
    ensureImmutableGlyphId,
    isCatalogTombstone,
    liveCatalogGlyphIds,
    listGlyphRecords,
    type CloudOwnedFontData
} from './cloud-glyph-catalog';
import {
    buildFontDepsForGlyph,
    buildFontDepsIndex,
    glyphIdsForSparseHydration,
    patchSourceEdges,
    readFontDepsIndex,
    writeFontDepsYMap
} from './cloud-font-deps';
import { evaluateShardSizes, type ShardSizeGate } from './cloud-shard-limits';
import {
    fillGlyphYMap,
    fromYType,
    jsonToCoreFontMap,
    yDocToJson
} from '../change-bridge-ydoc';

export const FONT_CORE_DOCUMENT_ID = 'font-core';
export const FONT_DEPS_DOCUMENT_ID = 'font-deps';
export const GLYPH_REVISIONS_KEY = 'glyphRevisions';
export const GLYPH_SYNC_MAP_KEY = 'sync';
export const GLYPH_SYNC_REVISION_KEY = 'revision';
export const GLYPH_SYNC_GENERATION_KEY = 'generation';

export function glyphDocumentId(glyphId: string): string {
    return `glyph:${glyphId}`;
}

export function glyphIdFromDocumentId(documentId: string): string | null {
    if (!documentId.startsWith('glyph:')) {
        return null;
    }
    const glyphId = documentId.slice('glyph:'.length);
    return glyphId || null;
}

export function glyphIdsFromRevisionEntries(
    entries: Array<{ path?: string | Array<string | number> | null }>
): string[] {
    const ids = new Set<string>();
    for (const entry of entries) {
        const raw = entry.path;
        const segments = Array.isArray(raw)
            ? raw.map(String)
            : typeof raw === 'string'
              ? raw.split('.')
              : [];
        if (segments[0] === GLYPH_REVISIONS_KEY && segments[1]) {
            ids.add(String(segments[1]));
        }
    }
    return [...ids];
}

export function isGlyphRevisionPath(path: string | undefined | null): boolean {
    if (!path) {
        return false;
    }
    return (
        path === GLYPH_REVISIONS_KEY ||
        path.startsWith(`${GLYPH_REVISIONS_KEY}.`)
    );
}

export function areGlyphRevisionOnlyEntries(
    entries: Array<{ path?: string | null }>
): boolean {
    return (
        entries.length > 0 &&
        entries.every((entry) => isGlyphRevisionPath(entry.path))
    );
}

export function shardRoomId(assetId: string, documentId: string): string {
    return `${assetId}:${documentId}`;
}

export type SparseGlyphHydrationFetch = (
    documentIds: string[]
) => Promise<Map<string, Uint8Array>>;

/**
 * Hydrate a sparse glyph subset to a fixed point. Stale deps projections
 * are repaired from loaded glyph bodies; newly discovered prerequisites
 * are fetched on later passes. Catalog size bounds the loop.
 */
export async function hydrateSparseGlyphsToFixedPoint(options: {
    documentSet: CloudDocumentSet;
    catalogIds: string[];
    seedIds: string[];
    layoutIds?: string[];
    catalog: Array<{ glyphId: string; name: string }>;
    fetchGlyphs: SparseGlyphHydrationFetch;
}): Promise<{
    loadedIds: string[];
    fetchPasses: string[][];
    glyphBytes: Map<string, Uint8Array>;
}> {
    const {
        documentSet,
        catalogIds,
        seedIds,
        layoutIds,
        catalog,
        fetchGlyphs
    } = options;
    const liveCatalogIds = liveCatalogGlyphIds(
        catalogFromCoreJson(documentSet.assembleFontJson())?.glyphCatalog ||
            Object.fromEntries(
                catalogIds.map((glyphId) => [
                    glyphId,
                    {
                        glyphId,
                        name: '',
                        codepoints: [],
                        latestGlyphRevision: '0',
                        generation: 0
                    }
                ])
            )
    );
    const glyphBytes = new Map<string, Uint8Array>();
    const loadedIds = new Set<string>();
    const fetchPasses: string[][] = [];
    let hydrateIds = glyphIdsForSparseHydration({
        catalogIds: liveCatalogIds,
        seedIds,
        layoutIds,
        edges: readFontDepsIndex(documentSet.depsDoc.getMap('deps')).edges
    });

    for (
        let pass = 0;
        pass <= Math.max(liveCatalogIds.length, catalogIds.length, 1);
        pass++
    ) {
        const missing = hydrateIds.filter((id) => !loadedIds.has(id));
        if (!missing.length) {
            break;
        }
        fetchPasses.push(missing.slice());
        const fetched = await fetchGlyphs(missing.map(glyphDocumentId));
        for (const [documentId, bytes] of fetched) {
            documentSet.applyRemoteUpdate(documentId, bytes);
            glyphBytes.set(documentId, bytes);
            const glyphId = documentId.slice('glyph:'.length);
            loadedIds.add(glyphId);
        }
        const loadedGlyphs = new Map(
            listGlyphRecords(documentSet.assembleFontJson()).map((glyph) => [
                String(glyph.id || ''),
                glyph
            ])
        );
        const depsMap = documentSet.depsDoc.getMap('deps');
        const sourceRevisions = depsMap.get('sourceRevision');
        for (const glyphId of loadedIds) {
            const glyph = loadedGlyphs.get(glyphId);
            const revision = documentSet.glyphDocs
                .get(glyphId)
                ?.getMap(GLYPH_SYNC_MAP_KEY)
                .get(GLYPH_SYNC_REVISION_KEY);
            const projected =
                sourceRevisions instanceof Y.Map
                    ? sourceRevisions.get(glyphId)
                    : undefined;
            if (
                glyph &&
                typeof revision === 'string' &&
                revision !== projected &&
                !isCatalogTombstone(
                    catalogFromCoreJson(documentSet.assembleFontJson())
                        ?.glyphCatalog,
                    glyphId
                )
            ) {
                patchSourceEdges(
                    depsMap,
                    glyphId,
                    buildFontDepsForGlyph(glyph, catalog),
                    revision
                );
            }
        }
        hydrateIds = glyphIdsForSparseHydration({
            catalogIds: liveCatalogIds,
            seedIds,
            layoutIds,
            edges: readFontDepsIndex(depsMap).edges
        });
    }

    return {
        loadedIds: [...loadedIds],
        fetchPasses,
        glyphBytes
    };
}

export type PublishedManifestRevisions = {
    coreRevision: string;
    depsRevision: string;
};

export async function hydrateCoreDepsToPublishedPair(options: {
    fetchCoreDeps: () => Promise<{
        core: Uint8Array | null;
        deps: Uint8Array | null;
    }>;
    hash: (bytes: Uint8Array) => Promise<string>;
    expected: PublishedManifestRevisions;
    maxAttempts?: number;
}): Promise<{
    core: Uint8Array;
    deps: Uint8Array | null;
    attempts: number;
}> {
    const maxAttempts = options.maxAttempts ?? 3;
    let lastCore: Uint8Array | null = null;
    let lastDeps: Uint8Array | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const fetched = await options.fetchCoreDeps();
        lastCore = fetched.core;
        lastDeps = fetched.deps;
        if (!fetched.core?.byteLength) {
            continue;
        }
        const coreRevision = await options.hash(fetched.core);
        const depsRevision = fetched.deps?.byteLength
            ? await options.hash(fetched.deps)
            : options.expected.depsRevision;
        if (
            coreRevision === options.expected.coreRevision &&
            depsRevision === options.expected.depsRevision
        ) {
            return {
                core: fetched.core,
                deps: fetched.deps,
                attempts: attempt
            };
        }
    }
    if (!lastCore?.byteLength) {
        throw new Error('core/deps hydrate failed: empty core shard');
    }
    return { core: lastCore, deps: lastDeps, attempts: maxAttempts };
}

export type EncodedShard = {
    documentId: string;
    bytes: Uint8Array;
};

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export class CloudDocumentSet {
    readonly coreDoc: Y.Doc;
    readonly depsDoc: Y.Doc;
    readonly glyphDocs = new Map<string, Y.Doc>();
    private lastEncoded = new Map<string, number>();
    private pendingUpdateBytes = new Map<string, number>();

    constructor() {
        this.coreDoc = new Y.Doc({ gc: true });
        this.depsDoc = new Y.Doc({ gc: true });
    }

    initFromFontJson(fontJson: Record<string, unknown>): CloudOwnedFontData {
        const working = cloneJson(fontJson);
        const owned = applyCloudOwnedData(working);
        const glyphs = listGlyphRecords(working);
        this.coreDoc.transact(() => {
            const fontMap = this.coreDoc.getMap('font');
            fontMap.forEach((_value, key) => fontMap.delete(key));
            jsonToCoreFontMap(working, fontMap);
        });

        this.depsDoc.transact(() => {
            writeFontDepsYMap(
                this.depsDoc.getMap('deps'),
                buildFontDepsIndex(working)
            );
        });

        for (const doc of this.glyphDocs.values()) {
            doc.destroy();
        }
        this.glyphDocs.clear();

        for (const glyph of glyphs) {
            const glyphId = ensureImmutableGlyphId(glyph);
            const glyphDoc = new Y.Doc({ gc: true });
            glyphDoc.transact(() => {
                const glyphMap = glyphDoc.getMap('glyph');
                fillGlyphYMap(glyph, glyphMap);
            });
            this.glyphDocs.set(glyphId, glyphDoc);
        }

        this.lastEncoded.clear();
        this.pendingUpdateBytes.clear();
        return owned;
    }

    encodeDocument(documentId: string): Uint8Array {
        const doc = this.getDoc(documentId);
        if (!doc) {
            return new Uint8Array();
        }
        const bytes = Y.encodeStateAsUpdate(doc);
        this.lastEncoded.set(documentId, bytes.byteLength);
        this.pendingUpdateBytes.set(documentId, 0);
        return bytes;
    }

    encodeDirtyShards(dirtyIds: Iterable<string>): EncodedShard[] {
        const encoded: EncodedShard[] = [];
        for (const documentId of dirtyIds) {
            encoded.push({
                documentId,
                bytes: this.encodeDocument(documentId)
            });
        }
        return encoded;
    }

    encodeAll(): EncodedShard[] {
        return [
            {
                documentId: FONT_CORE_DOCUMENT_ID,
                bytes: this.encodeDocument(FONT_CORE_DOCUMENT_ID)
            },
            {
                documentId: FONT_DEPS_DOCUMENT_ID,
                bytes: this.encodeDocument(FONT_DEPS_DOCUMENT_ID)
            },
            ...[...this.glyphDocs.keys()].map((glyphId) => ({
                documentId: glyphDocumentId(glyphId),
                bytes: this.encodeDocument(glyphDocumentId(glyphId))
            }))
        ];
    }

    notePendingUpdate(documentId: string, byteLength: number): void {
        const current = this.pendingUpdateBytes.get(documentId) || 0;
        this.pendingUpdateBytes.set(documentId, current + byteLength);
    }

    evaluateSizes(encoded?: EncodedShard[]): ShardSizeGate {
        const shards =
            encoded ||
            [...this.lastEncoded.entries()].map(([documentId, byteLength]) => ({
                documentId,
                byteLength:
                    byteLength + (this.pendingUpdateBytes.get(documentId) || 0)
            }));
        return evaluateShardSizes(
            shards.map((shard) => ({
                documentId: shard.documentId,
                byteLength:
                    shard instanceof Object &&
                    'bytes' in shard &&
                    shard.bytes instanceof Uint8Array
                        ? shard.bytes.byteLength
                        : Number(
                              (shard as { byteLength?: number }).byteLength || 0
                          )
            }))
        );
    }

    assembleFontJson(): Record<string, unknown> {
        const core = yDocToJson(this.coreDoc.getMap('font'));
        const glyphs: Record<string, unknown>[] = [];
        for (const [glyphId, glyphDoc] of this.glyphDocs) {
            const glyphMap = glyphDoc.getMap('glyph');
            const glyphJson = fromYType(glyphMap) as Record<string, unknown>;
            if (typeof glyphJson.id !== 'string') {
                glyphJson.id = glyphId;
            }
            glyphs.push(glyphJson);
        }
        if (glyphs.length > 0 || !Array.isArray(core.glyphs)) {
            core.glyphs = glyphs;
        }
        return core;
    }

    applyRemoteUpdate(documentId: string, update: Uint8Array): void {
        const doc = this.getDoc(documentId);
        if (!doc || !update.byteLength) {
            return;
        }
        Y.applyUpdate(doc, update);
    }

    destroy(): void {
        this.coreDoc.destroy();
        this.depsDoc.destroy();
        for (const doc of this.glyphDocs.values()) {
            doc.destroy();
        }
        this.glyphDocs.clear();
    }

    private getDoc(documentId: string): Y.Doc | null {
        if (documentId === FONT_CORE_DOCUMENT_ID) {
            return this.coreDoc;
        }
        if (documentId === FONT_DEPS_DOCUMENT_ID) {
            return this.depsDoc;
        }
        if (documentId.startsWith('glyph:')) {
            const glyphId = documentId.slice('glyph:'.length);
            let doc = this.glyphDocs.get(glyphId);
            if (!doc) {
                doc = new Y.Doc({ gc: false });
                this.glyphDocs.set(glyphId, doc);
            }
            return doc;
        }
        let doc = this.glyphDocs.get(documentId);
        if (!doc) {
            doc = new Y.Doc({ gc: false });
            this.glyphDocs.set(documentId, doc);
        }
        return doc;
    }
}

export function routePathToDocumentId(
    path: Array<string | number>,
    glyphIdByName?: Map<string, string>
): string {
    if (path[0] === 'glyphs' && path.length >= 2) {
        const key = String(path[1]);
        const glyphId = glyphIdByName?.get(key) || key;
        return glyphDocumentId(glyphId);
    }
    if (path[0] === 'fontDeps' || path[0] === 'deps') {
        return FONT_DEPS_DOCUMENT_ID;
    }
    return FONT_CORE_DOCUMENT_ID;
}
