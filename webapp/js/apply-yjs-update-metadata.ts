import { normalizeGlyphRenames } from './change-log';

export type ApplyYjsUpdateDrawingTarget = {
    glyphName: string;
    layerId: string;
};

/** Soft cap for sparse drawing patches. Larger structural floods fall back. */
export const APPLY_YJS_UPDATE_MAX_DRAWING_TARGETS = 512;

/**
 * Sanitize drawing targets for worker → WASM applyYjsUpdate metadata.
 * Kept beside the metadata builder so Jest can cover rename forwarding
 * without loading the WASM worker module.
 */
export function sanitizeApplyYjsUpdateDrawingTargets(
    drawingTargets: unknown,
    maxTargets = APPLY_YJS_UPDATE_MAX_DRAWING_TARGETS
): ApplyYjsUpdateDrawingTarget[] {
    if (!Array.isArray(drawingTargets)) {
        throw new Error('applyYjsUpdate requires an array of drawing targets');
    }

    if (drawingTargets.length > maxTargets) {
        throw new Error(
            `applyYjsUpdate received ${drawingTargets.length} targets; max ${maxTargets}`
        );
    }

    return drawingTargets.map((target, index) => {
        const glyphName =
            typeof target?.glyphName === 'string'
                ? target.glyphName.trim()
                : '';
        const drawingId =
            typeof target?.layerId === 'string' ? target.layerId.trim() : '';

        if (!glyphName) {
            throw new Error(
                `applyYjsUpdate target ${index} must include a non-empty glyphName`
            );
        }
        if (!drawingId) {
            throw new Error(
                `applyYjsUpdate target ${index} must include a non-empty layerId`
            );
        }

        return { glyphName, layerId: drawingId };
    });
}

function collectGlyphNamesFromDrawingTargets(
    drawingTargets: unknown[]
): string[] {
    const names = new Set<string>();
    for (const target of drawingTargets) {
        const glyphName =
            typeof (target as { glyphName?: unknown })?.glyphName === 'string'
                ? (target as { glyphName: string }).glyphName.trim()
                : '';
        if (glyphName) {
            names.add(glyphName);
        }
    }
    return [...names];
}

function ensureNonGlyphHints(hints: unknown[], required: string[]): string[] {
    const next = hints.filter(
        (hint): hint is string => typeof hint === 'string' && hint.length > 0
    );
    for (const hint of required) {
        if (!next.includes(hint)) {
            next.push(hint);
        }
    }
    return next;
}

/**
 * Build the JSON metadata payload for `apply_yjs_update`.
 * Pure helper so Jest can assert rename identity records are forwarded.
 *
 * When `layerTargets` exceeds the sparse-patch cap (e.g. adding a station creates
 * a drawing on every glyph), fall back to whole-glyph Y.Doc snapshots instead
 * of throwing. Throwing quarantines the worker mirror and leaves live
 * interpolation on a stale station/axis topology.
 */
export function buildApplyYjsUpdateMetadataJson(options: {
    changedGlyphs?: unknown;
    nonGlyphChangeHints?: unknown;
    layerTargets?: unknown;
    glyphRenames?: unknown;
    invalidateLayoutClosure?: unknown;
    documentId?: unknown;
}): string {
    const rawDrawingTargets = Array.isArray(options.layerTargets)
        ? options.layerTargets
        : [];
    const rawChangedGlyphs = Array.isArray(options.changedGlyphs)
        ? options.changedGlyphs.filter(
              (name): name is string =>
                  typeof name === 'string' && name.length > 0
          )
        : [];
    const rawHints = Array.isArray(options.nonGlyphChangeHints)
        ? options.nonGlyphChangeHints
        : [];

    let sanitizedDrawingTargets: ApplyYjsUpdateDrawingTarget[];
    let changedGlyphs = rawChangedGlyphs;
    let nonGlyphChangeHints = rawHints.filter(
        (hint): hint is string => typeof hint === 'string' && hint.length > 0
    );

    if (rawDrawingTargets.length > APPLY_YJS_UPDATE_MAX_DRAWING_TARGETS) {
        // Structural flood: prefer whole-glyph snapshots from the applied
        // Y.Doc over thousands of sparse drawing patches.
        const glyphNames = new Set(changedGlyphs);
        for (const name of collectGlyphNamesFromDrawingTargets(
            rawDrawingTargets
        )) {
            glyphNames.add(name);
        }
        changedGlyphs = [...glyphNames];
        sanitizedDrawingTargets = [];
        // Stations/axes almost always change alongside such floods (add/remove
        // station). Ensure Rust refreshes both even if the change-log omitted a
        // hint — otherwise FONT_CACHE keeps a stale avar map and live
        // interpolation past the old endpoint explodes.
        nonGlyphChangeHints = ensureNonGlyphHints(nonGlyphChangeHints, [
            'masters',
            'top-level:axes'
        ]);
    } else {
        sanitizedDrawingTargets =
            sanitizeApplyYjsUpdateDrawingTargets(rawDrawingTargets);
    }

    const glyphRenames = glyphRenamesForApplyYjsUpdateMetadata(
        options.glyphRenames
    );
    return JSON.stringify({
        changedGlyphs,
        nonGlyphChangeHints,
        layerTargets: sanitizedDrawingTargets,
        ...(glyphRenames.length ? { glyphRenames } : {}),
        invalidateLayoutClosure: options.invalidateLayoutClosure === true,
        ...(typeof options.documentId === 'string' && options.documentId
            ? { documentId: options.documentId }
            : {})
    });
}

/** Normalize glyphRenames for metadata once forwarding is enabled. */
export function glyphRenamesForApplyYjsUpdateMetadata(
    glyphRenames: unknown
): ReturnType<typeof normalizeGlyphRenames> {
    return normalizeGlyphRenames(
        Array.isArray(glyphRenames) ? glyphRenames : []
    );
}
