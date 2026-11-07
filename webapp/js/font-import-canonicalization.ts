import type { Babelfont } from './babelfont';
import {
    ensureStableIds,
    Font,
    withSuppressedModelRecording
} from './babelfont-model';
import { timelineSpanEnd, timelineSpanStart } from './perf-timeline';

type JsonRecord = Record<string, unknown>;

export type CanonicalImportedFont = {
    fontData: Babelfont.Font;
    fontModel: Font;
    babelfontJson: string;
};

/** Return a JSON record only for values that can safely receive source normalization. */
function asJsonRecord(value: unknown): JsonRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as JsonRecord)
        : null;
}

/** Return the record members of a JSON array while ignoring malformed source entries. */
function asJsonRecordArray(value: unknown): JsonRecord[] {
    return Array.isArray(value)
        ? value.flatMap((item) => {
              const record = asJsonRecord(item);
              return record ? [record] : [];
          })
        : [];
}

/** Normalize imported layer master syntax to the tagged representation used at runtime. */
function normalizeImportedLayerMasters(fontData: Babelfont.Font): void {
    const fontRecord = fontData as unknown as JsonRecord;
    const masters = asJsonRecordArray(fontRecord.masters);
    const knownMasterIds = new Set(
        masters.flatMap((master) =>
            typeof master.id === 'string' ? [master.id] : []
        )
    );

    for (const glyph of asJsonRecordArray(fontRecord.glyphs)) {
        for (const layer of asJsonRecordArray(glyph.layers)) {
            const layerId = typeof layer.id === 'string' ? layer.id : null;
            const masterValue = layer.master;

            if (!masterValue) {
                if (
                    layer.is_background !== true &&
                    layerId &&
                    knownMasterIds.has(layerId)
                ) {
                    layer.master = {
                        type: 'DefaultForMaster',
                        master: layerId
                    };
                }
                continue;
            }

            if (typeof masterValue === 'string') {
                layer.master = {
                    type: 'DefaultForMaster',
                    master: masterValue
                };
                continue;
            }

            const masterRecord = asJsonRecord(masterValue);
            if (
                !masterRecord ||
                Object.prototype.hasOwnProperty.call(masterRecord, 'type')
            ) {
                continue;
            }

            const masterId =
                typeof masterRecord.master === 'string'
                    ? masterRecord.master
                    : typeof masterRecord.DefaultForMaster === 'string'
                      ? masterRecord.DefaultForMaster
                      : typeof masterRecord.default_for_master === 'string'
                        ? masterRecord.default_for_master
                        : null;
            if (masterId) {
                layer.master = {
                    type: 'DefaultForMaster',
                    master: masterId
                };
                continue;
            }

            const associatedMasterId =
                typeof masterRecord.associated_with_master === 'string'
                    ? masterRecord.associated_with_master
                    : typeof masterRecord.AssociatedWithMaster === 'string'
                      ? masterRecord.AssociatedWithMaster
                      : null;
            if (associatedMasterId) {
                layer.master = {
                    type: 'AssociatedWithMaster',
                    master: associatedMasterId
                };
                continue;
            }

            if (
                Object.prototype.hasOwnProperty.call(
                    masterRecord,
                    'FreeFloating'
                ) ||
                Object.keys(masterRecord).length === 0
            ) {
                layer.master = { type: 'FreeFloating' };
            }
        }
    }
}

/**
 * Build the single canonical runtime and serialized representation for external
 * source data. Both initial open and hot reload must enter through this function.
 */
export function canonicalizeImportedFontData(
    sourceFontData: Babelfont.Font,
    options?: { clone?: boolean }
): CanonicalImportedFont {
    const fontData = (
        options?.clone === false
            ? sourceFontData
            : JSON.parse(JSON.stringify(sourceFontData))
    ) as Babelfont.Font;
    const fontRecord = fontData as unknown as JsonRecord;
    fontRecord.glyphs = Array.isArray(fontRecord.glyphs)
        ? fontRecord.glyphs
        : [];
    fontRecord.masters = Array.isArray(fontRecord.masters)
        ? fontRecord.masters
        : [];
    fontRecord.axes = Array.isArray(fontRecord.axes) ? fontRecord.axes : [];
    const stableIdsSpan = timelineSpanStart(
        'font.canonicalize.ensureStableIds'
    );
    ensureStableIds(fontRecord);
    timelineSpanEnd(stableIdsSpan);
    const mastersSpan = timelineSpanStart(
        'font.canonicalize.normalizeLayerMasters'
    );
    normalizeImportedLayerMasters(fontData);
    timelineSpanEnd(mastersSpan);

    const fromDataSpan = timelineSpanStart('font.canonicalize.fromData');
    const fontModel = Font.fromData(fontData);
    timelineSpanEnd(fromDataSpan);
    const metricsSpan = timelineSpanStart(
        'font.canonicalize.recomputeMetricsKeys'
    );
    withSuppressedModelRecording(() => {
        fontModel.recomputeMetricsKeys();
    });
    timelineSpanEnd(metricsSpan);

    const jsonSpan = timelineSpanStart('font.canonicalize.toJSONString');
    const babelfontJson = fontModel.toJSONString({ compileFacing: false });
    timelineSpanEnd(jsonSpan);

    return {
        fontData,
        fontModel,
        babelfontJson
    };
}

/**
 * Canonicalize glyphs re-read from their own source files, with the font's
 * masters as context: stable ids, tagged layer masters and model defaults, as
 * a whole import gives them. Metrics keys are not recomputed; as on a whole reload, the
 * files on disk are taken as they are.
 */
export function canonicalizeImportedGlyphs(
    glyphs: Babelfont.Glyph[],
    masters: Babelfont.Master[]
): Babelfont.Glyph[] {
    const fontData = {
        masters,
        glyphs: JSON.parse(JSON.stringify(glyphs))
    } as unknown as Babelfont.Font;
    ensureStableIds(fontData as unknown as JsonRecord);
    normalizeImportedLayerMasters(fontData);
    // Building the model fills in the defaults a whole import gets too.
    Font.fromData(fontData);
    return fontData.glyphs;
}

/** Parse source JSON and return the canonical representation used by every import path. */
export function canonicalizeImportedFontJson(
    sourceBabelfontJson: string
): CanonicalImportedFont {
    return canonicalizeImportedFontData(
        JSON.parse(sourceBabelfontJson) as Babelfont.Font,
        { clone: false }
    );
}
