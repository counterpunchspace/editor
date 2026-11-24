import type { Babelfont } from './babelfont';
import {
    ensureStableIds,
    Font,
    generateStableId,
    withSuppressedModelRecording
} from './babelfont-model';
import { timelineSpanEnd, timelineSpanStart } from './perf-timeline';

type JsonRecord = Record<string, unknown>;

/**
 * No serialized copy: one JSON string of a whole large font (17,000 CJK
 * glyphs) goes over the engine's string length limit. Serialize the model on
 * demand instead.
 */
export type CanonicalImportedFont = {
    fontData: Babelfont.Font;
    fontModel: Font;
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

/**
 * Read imported drawings in the representation used at runtime: their
 * `shapes` list and their tagged `master` field.
 */
function normalizeImportedDrawings(fontData: Babelfont.Font): void {
    const fontRecord = fontData as unknown as JsonRecord;
    const stations = asJsonRecordArray(fontRecord.masters);
    const knownStationIds = new Set(
        stations.flatMap((station) =>
            typeof station.id === 'string' ? [station.id] : []
        )
    );

    for (const glyph of asJsonRecordArray(fontRecord.glyphs)) {
        for (const drawing of asJsonRecordArray(glyph.layers)) {
            // Babelfont leaves an empty list out (`skip_serializing_if =
            // "Vec::is_empty"`): a drawing without shapes, such as a
            // space's, comes in without `shapes`. This reads that encoding;
            // a whole drawing always carries its list.
            if (drawing.shapes === undefined) {
                drawing.shapes = [];
            }
            // Babelfont's layer id is optional: a drawing read without one
            // gets a new id here, before anything stores it, as every
            // drawing must carry its own.
            if (typeof drawing.id !== 'string' || !drawing.id) {
                drawing.id = generateStableId();
            }
            const drawingId =
                typeof drawing.id === 'string' ? drawing.id : null;
            const stationValue = drawing.master;

            const namesItsStation =
                drawing.is_background !== true &&
                drawingId !== null &&
                knownStationIds.has(drawingId);
            if (stationValue === undefined) {
                if (namesItsStation) {
                    drawing.master = {
                        type: 'DefaultForMaster',
                        master: drawingId
                    };
                } else {
                    // Babelfont leaves `master` out for its default,
                    // FreeFloating (`skip_serializing_if = "is_default"`):
                    // a UFO `public.background` layer from a designspace,
                    // and the free layers of other formats, come in so.
                    // This reads that encoding; it fills nothing in.
                    drawing.master = { type: 'FreeFloating' };
                }
                continue;
            }

            if (!stationValue) {
                // A present but empty link (null, '') is not Babelfont's
                // encoding of anything; it stays as it is and the Y.Doc
                // write gate refuses it, unless the drawing is its station's
                // own drawing.
                if (namesItsStation) {
                    drawing.master = {
                        type: 'DefaultForMaster',
                        master: drawingId
                    };
                }
                continue;
            }

            if (typeof stationValue === 'string') {
                drawing.master = {
                    type: 'DefaultForMaster',
                    master: stationValue
                };
                continue;
            }

            const stationRecord = asJsonRecord(stationValue);
            if (
                !stationRecord ||
                Object.prototype.hasOwnProperty.call(stationRecord, 'type')
            ) {
                continue;
            }

            const stationId =
                typeof stationRecord.master === 'string'
                    ? stationRecord.master
                    : typeof stationRecord.DefaultForMaster === 'string'
                      ? stationRecord.DefaultForMaster
                      : typeof stationRecord.default_for_master === 'string'
                        ? stationRecord.default_for_master
                        : null;
            if (stationId) {
                drawing.master = {
                    type: 'DefaultForMaster',
                    master: stationId
                };
                continue;
            }

            const associatedStationId =
                typeof stationRecord.associated_with_master === 'string'
                    ? stationRecord.associated_with_master
                    : typeof stationRecord.AssociatedWithMaster === 'string'
                      ? stationRecord.AssociatedWithMaster
                      : null;
            if (associatedStationId) {
                drawing.master = {
                    type: 'AssociatedWithMaster',
                    master: associatedStationId
                };
                continue;
            }

            if (
                Object.prototype.hasOwnProperty.call(
                    stationRecord,
                    'FreeFloating'
                ) ||
                Object.keys(stationRecord).length === 0
            ) {
                drawing.master = { type: 'FreeFloating' };
            }
        }
    }
}

/**
 * Build the single canonical runtime representation for external source data.
 * Both initial open and hot reload must enter through this function.
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
    const stationsSpan = timelineSpanStart(
        'font.canonicalize.normalizeLayerMasters'
    );
    normalizeImportedDrawings(fontData);
    timelineSpanEnd(stationsSpan);

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

    return { fontData, fontModel };
}

/**
 * Canonicalize glyphs re-read from their own source files, with the font's
 * stations as context: stable ids, tagged drawing `master` fields and model defaults, as
 * a whole import gives them. Metrics keys are not recomputed; as on a whole reload, the
 * files on disk are taken as they are.
 */
export function canonicalizeImportedGlyphs(
    glyphs: Babelfont.Glyph[],
    stations: Babelfont.Master[]
): Babelfont.Glyph[] {
    const fontData = {
        masters: stations,
        glyphs: JSON.parse(JSON.stringify(glyphs))
    } as unknown as Babelfont.Font;
    ensureStableIds(fontData as unknown as JsonRecord);
    normalizeImportedDrawings(fontData);
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
