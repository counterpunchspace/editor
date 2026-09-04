import * as Y from 'yjs';
import {
    catalogFromCoreJson,
    liveCatalogGlyphIds
} from './cloud-glyph-catalog';
import {
    CloudDocumentSet,
    GLYPH_REVISIONS_KEY,
    GLYPH_SYNC_MAP_KEY,
    GLYPH_SYNC_REVISION_KEY,
    glyphDocumentId
} from './cloud-document-set';
import { readFontDepsIndex } from './cloud-font-deps';
import { yDocToJson } from '../change-bridge-ydoc';

export async function hashShardBytes(bytes: Uint8Array): Promise<string> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle?.digest) {
        throw new Error('SHA-256 is unavailable in this environment');
    }
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const digest = await subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0')
    ).join('');
}

export function documentSetFromWholeFontUpdate(
    update: Uint8Array
): CloudDocumentSet {
    const doc = new Y.Doc({ gc: true });
    Y.applyUpdate(doc, update);
    const json = yDocToJson(doc.getMap('font')) as Record<string, unknown>;
    doc.destroy();
    const documentSet = new CloudDocumentSet();
    documentSet.initFromFontJson(json);
    return documentSet;
}

export function revisionCoverageFromDocumentSet(
    documentSet: CloudDocumentSet
): {
    liveGlyphIds: string[];
    coreRevisions: Record<string, string>;
    depsRevisions: Record<string, string>;
    glyphSyncRevisions: Record<string, string>;
    ok: boolean;
    missing: string[];
    mismatched: string[];
} {
    const catalog =
        catalogFromCoreJson(documentSet.assembleFontJson())?.glyphCatalog || {};
    const liveGlyphIds = liveCatalogGlyphIds(catalog);
    const coreRevisions: Record<string, string> = {};
    const coreMap = documentSet.coreDoc.getMap(GLYPH_REVISIONS_KEY);
    coreMap.forEach((value, glyphId) => {
        if (typeof value === 'string' && value) {
            coreRevisions[glyphId] = value;
        }
    });
    const depsRevisions = readFontDepsIndex(
        documentSet.depsDoc.getMap('deps')
    ).sourceRevision;
    const glyphSyncRevisions: Record<string, string> = {};
    for (const [glyphId, doc] of documentSet.glyphDocs) {
        const revision = doc
            .getMap(GLYPH_SYNC_MAP_KEY)
            .get(GLYPH_SYNC_REVISION_KEY);
        if (typeof revision === 'string' && revision) {
            glyphSyncRevisions[glyphId] = revision;
        }
    }
    const missing: string[] = [];
    const mismatched: string[] = [];
    for (const glyphId of liveGlyphIds) {
        const core = coreRevisions[glyphId];
        const glyph = glyphSyncRevisions[glyphId];
        const deps = depsRevisions[glyphId];
        if (!core || !glyph) {
            missing.push(glyphId);
            continue;
        }
        if (core !== glyph || (deps && deps !== glyph)) {
            mismatched.push(glyphId);
        }
    }
    return {
        liveGlyphIds,
        coreRevisions,
        depsRevisions,
        glyphSyncRevisions,
        ok: missing.length === 0 && mismatched.length === 0,
        missing,
        mismatched
    };
}

export function ensureMigrationRevisionTokens(
    documentSet: CloudDocumentSet
): void {
    const catalog =
        catalogFromCoreJson(documentSet.assembleFontJson())?.glyphCatalog || {};
    const liveGlyphIds = liveCatalogGlyphIds(catalog);
    documentSet.coreDoc.transact(() => {
        const revisions = documentSet.coreDoc.getMap(GLYPH_REVISIONS_KEY);
        for (const glyphId of liveGlyphIds) {
            const existing = revisions.get(glyphId);
            const token =
                typeof existing === 'string' && existing
                    ? existing
                    : `migrate:${glyphId}:1`;
            revisions.set(glyphId, token);
            const glyphDoc = documentSet.glyphDocs.get(glyphId);
            glyphDoc?.transact(() => {
                glyphDoc
                    .getMap(GLYPH_SYNC_MAP_KEY)
                    .set(GLYPH_SYNC_REVISION_KEY, token);
            });
            const depsMap = documentSet.depsDoc.getMap('deps');
            const sourceRevision = depsMap.get('sourceRevision');
            if (sourceRevision instanceof Y.Map) {
                sourceRevision.set(glyphId, token);
            }
        }
    });
}

export function orphanShardIdsFromCatalog(
    catalog: Record<string, { deleted?: boolean; glyphId: string }>,
    previouslyPublishedShardIds: string[]
): string[] {
    const live = new Set(
        liveCatalogGlyphIds(
            catalog as Parameters<typeof liveCatalogGlyphIds>[0]
        ).map(glyphDocumentId)
    );
    return previouslyPublishedShardIds.filter((shardId) => {
        if (!shardId.startsWith('glyph:')) {
            return false;
        }
        return !live.has(shardId);
    });
}
