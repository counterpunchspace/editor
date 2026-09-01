import { normalizeGlyphRenames } from './change-log';

export type ApplyYjsUpdateLayerTarget = {
    glyphName: string;
    layerId: string;
};

/** Soft cap for sparse layer patches. Larger structural floods fall back. */
export const APPLY_YJS_UPDATE_MAX_LAYER_TARGETS = 512;

/**
 * Sanitize layer targets for worker → WASM applyYjsUpdate metadata.
 * Kept beside the metadata builder so Jest can cover rename forwarding
 * without loading the WASM worker module.
 */
export function sanitizeApplyYjsUpdateLayerTargets(
    layerTargets: unknown,
    maxTargets = APPLY_YJS_UPDATE_MAX_LAYER_TARGETS
): ApplyYjsUpdateLayerTarget[] {
    if (!Array.isArray(layerTargets)) {
        throw new Error('applyYjsUpdate requires an array of layer targets');
    }

    if (layerTargets.length > maxTargets) {
        throw new Error(
            `applyYjsUpdate received ${layerTargets.length} targets; max ${maxTargets}`
        );
    }

    return layerTargets.map((target, index) => {
        const glyphName =
            typeof target?.glyphName === 'string'
                ? target.glyphName.trim()
                : '';
        const layerId =
            typeof target?.layerId === 'string' ? target.layerId.trim() : '';

        if (!glyphName) {
            throw new Error(
                `applyYjsUpdate target ${index} must include a non-empty glyphName`
            );
        }
        if (!layerId) {
            throw new Error(
                `applyYjsUpdate target ${index} must include a non-empty layerId`
            );
        }

        return { glyphName, layerId };
    });
}

function collectGlyphNamesFromLayerTargets(layerTargets: unknown[]): string[] {
    const names = new Set<string>();
    for (const target of layerTargets) {
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
 * When `layerTargets` exceeds the sparse-patch cap (e.g. add-master creating
 * a layer on every glyph), fall back to whole-glyph Y.Doc snapshots instead
 * of throwing. Throwing quarantines the worker mirror and leaves live
 * interpolation on a stale master/axis topology.
 */
export function buildApplyYjsUpdateMetadataJson(options: {
    changedGlyphs?: unknown;
    nonGlyphChangeHints?: unknown;
    layerTargets?: unknown;
    glyphRenames?: unknown;
    invalidateLayoutClosure?: unknown;
    documentId?: unknown;
}): string {
    const rawLayerTargets = Array.isArray(options.layerTargets)
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

    let sanitizedLayerTargets: ApplyYjsUpdateLayerTarget[];
    let changedGlyphs = rawChangedGlyphs;
    let nonGlyphChangeHints = rawHints.filter(
        (hint): hint is string => typeof hint === 'string' && hint.length > 0
    );

    if (rawLayerTargets.length > APPLY_YJS_UPDATE_MAX_LAYER_TARGETS) {
        // Structural flood: prefer whole-glyph snapshots from the applied
        // Y.Doc over thousands of sparse layer patches.
        const glyphNames = new Set(changedGlyphs);
        for (const name of collectGlyphNamesFromLayerTargets(rawLayerTargets)) {
            glyphNames.add(name);
        }
        changedGlyphs = [...glyphNames];
        sanitizedLayerTargets = [];
        // Masters/axes almost always change alongside such floods (add/remove
        // master). Ensure Rust refreshes both even if the change-log omitted a
        // hint — otherwise FONT_CACHE keeps a stale avar map and live
        // interpolation past the old endpoint explodes.
        nonGlyphChangeHints = ensureNonGlyphHints(nonGlyphChangeHints, [
            'masters',
            'top-level:axes'
        ]);
    } else {
        sanitizedLayerTargets =
            sanitizeApplyYjsUpdateLayerTargets(rawLayerTargets);
    }

    const glyphRenames = glyphRenamesForApplyYjsUpdateMetadata(
        options.glyphRenames
    );
    return JSON.stringify({
        changedGlyphs,
        nonGlyphChangeHints,
        layerTargets: sanitizedLayerTargets,
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
