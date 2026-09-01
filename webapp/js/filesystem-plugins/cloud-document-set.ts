import * as Y from 'yjs';
import {
    applyCloudOwnedData,
    ensureImmutableGlyphId,
    listGlyphRecords,
    type CloudOwnedFontData
} from './cloud-glyph-catalog';
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
            this.depsDoc.getMap('deps').set('edges', owned.fontDeps);
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
        core.glyphs = glyphs;
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
