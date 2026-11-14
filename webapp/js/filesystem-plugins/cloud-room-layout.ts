/**
 * Room layout 2: bulk font-wide data leaves font-core.
 *
 *   features      `font.features`, same structure, root map `features`
 *   catalog:<n>   the glyph catalog, glyphId → entry, root map `catalog`
 *   kerning:<n>   kerning pairs of every master, root map `kerning`,
 *                 key `<masterId>|<l|r>|<first>:<second>` → value
 *
 * The bucket counts are fixed per asset and stored in font-core's `layout`
 * map, so every window routes a key to the same room. They are chosen with
 * room to double before a bucket reaches its budget; re-bucketing is part of
 * a room rebase. See strategy/CLOUD_COLLABORATION_ARCHITECTURE.md.
 */

import * as Y from 'yjs';
import { fromYType } from '../change-bridge-ydoc';
import { flattenKerningMap } from '../delete-glyphs-preflight';

export const FONT_FEATURES_DOCUMENT_ID = 'features';
export const CATALOG_DOCUMENT_PREFIX = 'catalog:';
export const KERNING_DOCUMENT_PREFIX = 'kerning:';
/** Same cap as collab's MAX_LAYOUT_BUCKETS. */
export const MAX_LAYOUT_BUCKETS = 1024;
export const LAYOUT_MAP_KEY = 'layout';
export const ROOM_LAYOUT_VERSION = 2;
export const FEATURES_ROOT_KEY = 'features';
export const CATALOG_ROOT_KEY = 'catalog';
export const KERNING_ROOT_KEY = 'kerning';

/** Target fill when a layout is chosen: half the budget per bucket. */
export const CATALOG_GLYPHS_PER_BUCKET = 2000;
export const KERNING_PAIRS_PER_BUCKET = 20000;

export type RoomLayout = {
    version: number;
    catalogBuckets: number;
    kerningBuckets: number;
};

export type LayoutDocumentKind =
    | 'core'
    | 'deps'
    | 'features'
    | 'catalog'
    | 'kerning'
    | 'glyph';

const BUCKET_RE = /^(0|[1-9][0-9]{0,3})$/;

function bucketIndexOf(documentId: string, prefix: string): number | null {
    if (!documentId.startsWith(prefix)) {
        return null;
    }
    const rest = documentId.slice(prefix.length);
    if (!BUCKET_RE.test(rest)) {
        return null;
    }
    const index = Number(rest);
    return index < MAX_LAYOUT_BUCKETS ? index : null;
}

export function catalogDocumentId(bucket: number): string {
    return `${CATALOG_DOCUMENT_PREFIX}${bucket}`;
}

export function kerningDocumentId(bucket: number): string {
    return `${KERNING_DOCUMENT_PREFIX}${bucket}`;
}

export function catalogBucketOfDocument(documentId: string): number | null {
    return bucketIndexOf(documentId, CATALOG_DOCUMENT_PREFIX);
}

export function kerningBucketOfDocument(documentId: string): number | null {
    return bucketIndexOf(documentId, KERNING_DOCUMENT_PREFIX);
}

export function layoutDocumentKind(
    documentId: string | null | undefined
): LayoutDocumentKind | null {
    const id = String(documentId || '');
    if (id === 'font-core') return 'core';
    if (id === 'font-deps') return 'deps';
    if (id === FONT_FEATURES_DOCUMENT_ID) return 'features';
    if (catalogBucketOfDocument(id) !== null) return 'catalog';
    if (kerningBucketOfDocument(id) !== null) return 'kerning';
    if (id.startsWith('glyph:') && id.length > 'glyph:'.length) return 'glyph';
    return null;
}

/** Features, catalog and kerning rooms: asset-level, but not core or deps. */
export function isLayoutDocumentId(documentId: string | null | undefined) {
    const kind = layoutDocumentKind(documentId);
    return kind === 'features' || kind === 'catalog' || kind === 'kerning';
}

/** FNV-1a over UTF-8; the same in every window and in Rust. */
export function layoutHash(key: string): number {
    let hash = 0x811c9dc5;
    const bytes = new TextEncoder().encode(key);
    for (const byte of bytes) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

export function bucketFor(key: string, buckets: number): number {
    const count = Math.max(1, Math.floor(buckets) || 1);
    return count === 1 ? 0 : layoutHash(key) % count;
}

export function chooseRoomLayout(counts: {
    glyphs: number;
    kerningPairs: number;
}): RoomLayout {
    const clamp = (value: number) =>
        Math.min(MAX_LAYOUT_BUCKETS, Math.max(1, Math.ceil(value)));
    return {
        version: ROOM_LAYOUT_VERSION,
        catalogBuckets: clamp(
            Math.max(0, counts.glyphs) / CATALOG_GLYPHS_PER_BUCKET
        ),
        kerningBuckets: clamp(
            Math.max(0, counts.kerningPairs) / KERNING_PAIRS_PER_BUCKET
        )
    };
}

/** A layout read from font-core, or null when the asset is still layout 1. */
export function parseRoomLayout(value: unknown): RoomLayout | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const raw = value as Record<string, unknown>;
    const version = Number(raw.version);
    const catalogBuckets = Number(raw.catalogBuckets);
    const kerningBuckets = Number(raw.kerningBuckets);
    const valid = (n: number) =>
        Number.isInteger(n) && n >= 1 && n <= MAX_LAYOUT_BUCKETS;
    if (
        version !== ROOM_LAYOUT_VERSION ||
        !valid(catalogBuckets) ||
        !valid(kerningBuckets)
    ) {
        return null;
    }
    return { version, catalogBuckets, kerningBuckets };
}

export function layoutDocumentIds(layout: RoomLayout): string[] {
    return [
        FONT_FEATURES_DOCUMENT_ID,
        ...Array.from({ length: layout.catalogBuckets }, (_, i) =>
            catalogDocumentId(i)
        ),
        ...Array.from({ length: layout.kerningBuckets }, (_, i) =>
            kerningDocumentId(i)
        )
    ];
}

export type KerningDirection = 'l' | 'r';

export function kerningFieldDirection(field: string): KerningDirection | null {
    if (field === 'kerning') return 'l';
    if (field === 'kerning_rtl') return 'r';
    return null;
}

export function kerningFieldForDirection(direction: KerningDirection): string {
    return direction === 'l' ? 'kerning' : 'kerning_rtl';
}

/** First side of a flat pair key `first:second` (sides may be `@group`). */
export function kerningPairFirstSide(pair: string): string {
    const index = pair.indexOf(':');
    return index < 0 ? pair : pair.slice(0, index);
}

export function kerningKey(
    masterId: string,
    direction: KerningDirection,
    pair: string
): string {
    return `${masterId}|${direction}|${pair}`;
}

export function parseKerningKey(
    key: string
): { masterId: string; direction: KerningDirection; pair: string } | null {
    const first = key.indexOf('|');
    if (first <= 0) return null;
    const second = key.indexOf('|', first + 1);
    if (second < 0) return null;
    const direction = key.slice(first + 1, second);
    if (direction !== 'l' && direction !== 'r') return null;
    const pair = key.slice(second + 1);
    if (!pair) return null;
    return { masterId: key.slice(0, first), direction, pair };
}

export function kerningBucketFor(pair: string, buckets: number): number {
    return bucketFor(kerningPairFirstSide(pair), buckets);
}

export function catalogBucketFor(glyphId: string, buckets: number): number {
    return bucketFor(glyphId, buckets);
}

/** The layout stored in a font-core document, or null for layout 1. */
export function readRoomLayoutFromCoreDoc(coreDoc: Y.Doc): RoomLayout | null {
    return parseRoomLayout(coreDoc.getMap(LAYOUT_MAP_KEY).toJSON());
}

/**
 * Put features, the catalog and master kerning from the layout rooms back
 * into a font JSON assembled from font-core. Rooms that were not loaded
 * leave their part as it is.
 */
export function mergeLayoutDocumentsIntoFontJson(
    fontJson: Record<string, unknown>,
    layoutDocs: Map<string, Y.Doc>
): Record<string, unknown> {
    const features = layoutDocs.get(FONT_FEATURES_DOCUMENT_ID);
    if (features) {
        fontJson.features = fromYType(features.getMap(FEATURES_ROOT_KEY));
    }
    const catalog: Record<string, unknown> = {};
    let hasCatalog = false;
    const kerning = new Map<string, Record<KerningDirection, Record<string, unknown>>>();
    let hasKerning = false;
    for (const [documentId, doc] of layoutDocs) {
        const kind = layoutDocumentKind(documentId);
        if (kind === 'catalog') {
            hasCatalog = true;
            Object.assign(
                catalog,
                fromYType(doc.getMap(CATALOG_ROOT_KEY)) as Record<string, unknown>
            );
        } else if (kind === 'kerning') {
            hasKerning = true;
            doc.getMap(KERNING_ROOT_KEY).forEach((value, key) => {
                const parsed = parseKerningKey(key);
                if (!parsed) return;
                if (!kerning.has(parsed.masterId)) {
                    kerning.set(parsed.masterId, { l: {}, r: {} });
                }
                kerning.get(parsed.masterId)![parsed.direction][parsed.pair] = value;
            });
        }
    }
    if (hasCatalog) {
        fontJson.glyphCatalog = catalog;
    }
    if (hasKerning && Array.isArray(fontJson.masters)) {
        for (const master of fontJson.masters as Array<Record<string, unknown>>) {
            if (!master || typeof master !== 'object') continue;
            const pairs = kerning.get(String(master.id ?? ''));
            master.kerning = pairs?.l ?? {};
            master.kerning_rtl = pairs?.r ?? {};
        }
    }
    return fontJson;
}

/** Glyph and kerning pair counts that choose a new asset's layout. */
export function roomLayoutCounts(fontJson: Record<string, unknown>): {
    glyphs: number;
    kerningPairs: number;
} {
    const glyphs = Array.isArray(fontJson.glyphs) ? fontJson.glyphs.length : 0;
    let kerningPairs = 0;
    for (const master of Array.isArray(fontJson.masters) ? fontJson.masters : []) {
        const record = (master ?? {}) as Record<string, unknown>;
        for (const field of ['kerning', 'kerning_rtl']) {
            kerningPairs += Object.keys(flattenKerningMap(record[field])).length;
        }
    }
    return { glyphs, kerningPairs };
}
