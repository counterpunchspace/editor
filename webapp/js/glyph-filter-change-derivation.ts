/**
 * Derive filter-facing semantic events from committed change-bridge entries.
 *
 * The change bridge records dotted paths such as
 * `glyphs.A:layers.<id>:shapes.0.nodes.1.x` (colon separators protect glyph
 * names and layer IDs that themselves contain dots). This module maps those
 * paths onto the stable `GlyphFilterEventType` contract. It does **not** emit
 * `glyph.compatibility.changed`; that event is produced separately when
 * `Glyph.isCompatible` toggles (see GlyphOverviewFilterManager).
 */

import type {
    GlyphFilterChange,
    GlyphFilterEventType
} from './glyph-filter-events';
import { getPathSegments } from './change-log';

/** Minimal committed-entry shape needed for filter event derivation. */
export interface GlyphFilterCommittedEntry {
    path: string;
    op: string;
    oldValue?: unknown;
    newValue?: unknown;
}

export interface GlyphFilterEntryDerivation {
    /** Concrete filter events implied by this entry alone. */
    changes: GlyphFilterChange[];
    /**
     * Glyphs whose outline-compatibility boolean may have changed as a
     * result of this entry. The host rechecks `Glyph.isCompatible` and
     * emits `glyph.compatibility.changed` only on an actual toggle.
     */
    compatibilityCheckGlyphNames: string[];
    /** True when the font master list changed (may affect every glyph). */
    mastersChanged: boolean;
    /** Host-owned glyph identity changes; never exposed in EVENT_TYPES. */
    lifecycleChanges: GlyphFilterLifecycleChange[];
}

export type GlyphFilterLifecycleChange =
    | { kind: 'created'; glyphName: string }
    | { kind: 'deleted'; glyphName: string }
    | { kind: 'renamed'; glyphName: string; previousGlyphName: string };

const METRICS_KEY_SUFFIXES = [
    '.format_specific.metric_left',
    '.format_specific.metric_right',
    '.format_specific.com.schriftgestalt.Glyphs.metricLeft',
    '.format_specific.com.schriftgestalt.Glyphs.metricRight'
] as const;

/** First Unicode scalar from a codepoints value, if any. */
function firstCodepoint(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (Array.isArray(value) && typeof value[0] === 'number') {
        return value[0];
    }
    return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** True when a shape value looks like a component instance. */
export function isComponentShapeValue(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }
    if (typeof value.reference === 'string') {
        return true;
    }
    const wrapped = value.Component;
    return isRecord(wrapped) && typeof wrapped.reference === 'string';
}

/** True when a shape value looks like a path contour. */
export function isPathShapeValue(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }
    if (Array.isArray(value.nodes)) {
        return true;
    }
    const wrapped = value.Path;
    return isRecord(wrapped) && Array.isArray(wrapped.nodes);
}

function layerMetadata(
    glyphName: string,
    layerId: string | undefined
): Record<string, string | string[]> {
    if (!layerId) {
        return { glyphName };
    }
    return { glyphName, layerIds: [layerId] };
}

function pushUniqueChange(
    changes: GlyphFilterChange[],
    type: GlyphFilterEventType,
    metadata: Record<string, string | string[] | number | boolean | null>
): void {
    changes.push({ type, metadata });
}

function classifyShapesArrayContents(value: unknown): {
    hasPaths: boolean;
    hasComponents: boolean;
} {
    if (!Array.isArray(value)) {
        return { hasPaths: false, hasComponents: false };
    }
    let hasPaths = false;
    let hasComponents = false;
    for (const shape of value) {
        if (isComponentShapeValue(shape)) {
            hasComponents = true;
        } else if (isPathShapeValue(shape)) {
            hasPaths = true;
        }
    }
    return { hasPaths, hasComponents };
}

/**
 * Classify a committed entry under `glyphs.<name>.layers.<id>…`.
 * Returns semantic events for the touched subtree; never emits compatibility.
 */
function deriveLayerSubtreeChanges(
    glyphName: string,
    layerId: string | undefined,
    rest: string[],
    entry: GlyphFilterCommittedEntry
): {
    changes: GlyphFilterChange[];
    mayAffectCompatibility: boolean;
} {
    const changes: GlyphFilterChange[] = [];
    const meta = layerMetadata(glyphName, layerId);
    const field = rest[0];

    // Whole-layer write / structural layer add-remove.
    if (!field) {
        pushUniqueChange(changes, 'glyph.layers.changed', meta);
        const snapshots = [entry.oldValue, entry.newValue];
        let mayAffectCompatibility = true;
        for (const snapshot of snapshots) {
            if (!isRecord(snapshot)) {
                continue;
            }
            const shapeInfo = classifyShapesArrayContents(snapshot.shapes);
            if (shapeInfo.hasPaths) {
                pushUniqueChange(changes, 'glyph.paths.changed', meta);
            }
            if (shapeInfo.hasComponents) {
                pushUniqueChange(changes, 'glyph.components.changed', meta);
            }
            if (Array.isArray(snapshot.anchors) && snapshot.anchors.length) {
                pushUniqueChange(changes, 'glyph.anchors.changed', meta);
            }
            if (Array.isArray(snapshot.guides) && snapshot.guides.length) {
                pushUniqueChange(changes, 'glyph.guides.changed', meta);
            }
            if ('width' in snapshot) {
                pushUniqueChange(changes, 'glyph.metrics.changed', meta);
            }
            if ('location' in snapshot) {
                pushUniqueChange(changes, 'glyph.layer.location.changed', meta);
            }
        }
        // Layer membership always can affect the compatibility set.
        return { changes, mayAffectCompatibility };
    }

    if (field === 'location') {
        pushUniqueChange(changes, 'glyph.layer.location.changed', meta);
        return { changes, mayAffectCompatibility: false };
    }

    if (field === 'width') {
        pushUniqueChange(changes, 'glyph.metrics.changed', meta);
        return { changes, mayAffectCompatibility: false };
    }

    if (field === 'anchors') {
        pushUniqueChange(changes, 'glyph.anchors.changed', meta);
        // Fingerprints include anchor names, so compatibility may toggle.
        return { changes, mayAffectCompatibility: true };
    }

    if (field === 'guides') {
        pushUniqueChange(changes, 'glyph.guides.changed', meta);
        return { changes, mayAffectCompatibility: false };
    }

    if (field === 'format_specific') {
        const fullPath = entry.path;
        if (METRICS_KEY_SUFFIXES.some((suffix) => fullPath.endsWith(suffix))) {
            pushUniqueChange(changes, 'glyph.metrics-key.changed', meta);
        }
        return { changes, mayAffectCompatibility: false };
    }

    if (field === 'shapes') {
        return deriveShapesSubtreeChanges(
            glyphName,
            layerId,
            rest.slice(1),
            entry
        );
    }

    // Unknown layer field: treat as a structural layer change.
    pushUniqueChange(changes, 'glyph.layers.changed', meta);
    return { changes, mayAffectCompatibility: true };
}

/**
 * Classify edits under `…shapes…` into path vs component semantic events.
 */
function deriveShapesSubtreeChanges(
    glyphName: string,
    layerId: string | undefined,
    rest: string[],
    entry: GlyphFilterCommittedEntry
): {
    changes: GlyphFilterChange[];
    mayAffectCompatibility: boolean;
} {
    const changes: GlyphFilterChange[] = [];
    const meta = layerMetadata(glyphName, layerId);

    // Entire shapes array replaced.
    if (rest.length === 0) {
        const oldInfo = classifyShapesArrayContents(entry.oldValue);
        const newInfo = classifyShapesArrayContents(entry.newValue);
        if (oldInfo.hasPaths || newInfo.hasPaths) {
            pushUniqueChange(changes, 'glyph.paths.changed', meta);
        }
        if (oldInfo.hasComponents || newInfo.hasComponents) {
            pushUniqueChange(changes, 'glyph.components.changed', meta);
        }
        // Ambiguous empty→empty: still signal paths as the safer default for
        // outline-affecting shape-list churn when typed content is unknown.
        if (changes.length === 0) {
            pushUniqueChange(changes, 'glyph.paths.changed', meta);
        }
        return { changes, mayAffectCompatibility: true };
    }

    // Normalize wrapped Path/Component containers:
    //   shapes.0.transform
    //   shapes.0.Component.transform
    //   shapes.0.Path.nodes.0.x
    let shapeProperty = rest[1];
    if (shapeProperty === 'Component' || shapeProperty === 'Path') {
        shapeProperty = rest[2] || shapeProperty;
    }

    // shapes.<index> add/remove/replace without a deeper property.
    if (!shapeProperty) {
        const values = [entry.oldValue, entry.newValue];
        const touchedComponent = values.some(isComponentShapeValue);
        const touchedPath = values.some(isPathShapeValue);
        if (touchedComponent) {
            pushUniqueChange(changes, 'glyph.components.changed', meta);
        }
        if (touchedPath || (!touchedComponent && !touchedPath)) {
            // Untyped shape write still counts as path geometry churn when we
            // cannot prove it is a component.
            pushUniqueChange(changes, 'glyph.paths.changed', meta);
        }
        return { changes, mayAffectCompatibility: true };
    }

    if (shapeProperty === 'reference') {
        pushUniqueChange(changes, 'glyph.component.reference.changed', meta);
        return { changes, mayAffectCompatibility: true };
    }

    if (shapeProperty === 'transform') {
        pushUniqueChange(changes, 'glyph.component.transform.changed', meta);
        // Transforms are excluded from outline fingerprints.
        return { changes, mayAffectCompatibility: false };
    }

    if (shapeProperty === 'nodes' || shapeProperty === 'closed') {
        pushUniqueChange(changes, 'glyph.paths.changed', meta);
        return { changes, mayAffectCompatibility: true };
    }

    if (shapeProperty === 'format_specific') {
        pushUniqueChange(changes, 'glyph.paths.changed', meta);
        return { changes, mayAffectCompatibility: true };
    }

    // Bare wrapped-container write (shapes.0.Component / shapes.0.Path).
    if (shapeProperty === 'Component') {
        pushUniqueChange(changes, 'glyph.components.changed', meta);
        return { changes, mayAffectCompatibility: true };
    }
    if (shapeProperty === 'Path') {
        pushUniqueChange(changes, 'glyph.paths.changed', meta);
        return { changes, mayAffectCompatibility: true };
    }

    // Nested property on an existing shape: classify by old/new shape when
    // available, otherwise assume path geometry.
    if (
        isComponentShapeValue(entry.oldValue) ||
        isComponentShapeValue(entry.newValue)
    ) {
        pushUniqueChange(changes, 'glyph.components.changed', meta);
    } else {
        pushUniqueChange(changes, 'glyph.paths.changed', meta);
    }
    return { changes, mayAffectCompatibility: true };
}

/**
 * Map one committed change-log entry to filter events and compatibility hints.
 *
 * Committed paths use colon separators at glyph-name and layer-id boundaries
 * (`glyphs.A:layers.<id>:anchors.0`). Always parse with `getPathSegments` —
 * never `path.split('.')`, which breaks on those separators.
 */
export function deriveGlyphFilterChangesFromCommittedEntry(
    entry: GlyphFilterCommittedEntry,
    options?: {
        masterIds?: string[];
    }
): GlyphFilterEntryDerivation {
    const path = getPathSegments(entry.path);
    const changes: GlyphFilterChange[] = [];
    const compatibilityCheckGlyphNames: string[] = [];
    const lifecycleChanges: GlyphFilterLifecycleChange[] = [];
    let mastersChanged = false;

    if (path[0] === 'masters') {
        // Kerning lives on masters but cannot change outline compatibility;
        // treating it as a master change rechecked every glyph per kern edit.
        mastersChanged = path[2] !== 'kerning';
        return {
            changes,
            compatibilityCheckGlyphNames,
            mastersChanged,
            lifecycleChanges
        };
    }

    if (path[0] !== 'glyphs' || !path[1]) {
        return {
            changes,
            compatibilityCheckGlyphNames,
            mastersChanged,
            lifecycleChanges
        };
    }

    const glyphName = path[1];

    if (path.length === 2 && entry.op === 'add') {
        lifecycleChanges.push({ kind: 'created', glyphName });
        return {
            changes,
            compatibilityCheckGlyphNames,
            mastersChanged,
            lifecycleChanges
        };
    }

    if (path.length === 2 && entry.op === 'remove') {
        lifecycleChanges.push({ kind: 'deleted', glyphName });
        return {
            changes,
            compatibilityCheckGlyphNames,
            mastersChanged,
            lifecycleChanges
        };
    }

    const field = path[2];
    if (!field) {
        return {
            changes,
            compatibilityCheckGlyphNames,
            mastersChanged,
            lifecycleChanges
        };
    }

    if (field === 'name') {
        lifecycleChanges.push({
            kind: 'renamed',
            glyphName: String(entry.newValue || glyphName),
            previousGlyphName: String(entry.oldValue || glyphName)
        });
        return {
            changes,
            compatibilityCheckGlyphNames,
            mastersChanged,
            lifecycleChanges
        };
    }

    if (field === 'codepoints') {
        pushUniqueChange(changes, 'glyph.unicode.changed', {
            glyphName,
            unicode: firstCodepoint(entry.newValue),
            previousUnicode: firstCodepoint(entry.oldValue)
        });
        return {
            changes,
            compatibilityCheckGlyphNames,
            mastersChanged,
            lifecycleChanges
        };
    }

    if (field === 'category') {
        pushUniqueChange(changes, 'glyph.category.changed', { glyphName });
        return {
            changes,
            compatibilityCheckGlyphNames,
            mastersChanged,
            lifecycleChanges
        };
    }

    if (field === 'exported') {
        pushUniqueChange(changes, 'glyph.export.changed', { glyphName });
        return {
            changes,
            compatibilityCheckGlyphNames,
            mastersChanged,
            lifecycleChanges
        };
    }

    if (field === 'production_name') {
        pushUniqueChange(changes, 'glyph.production-name.changed', {
            glyphName
        });
        return {
            changes,
            compatibilityCheckGlyphNames,
            mastersChanged,
            lifecycleChanges
        };
    }

    if (field === 'format_specific') {
        if (
            METRICS_KEY_SUFFIXES.some((suffix) => entry.path.endsWith(suffix))
        ) {
            pushUniqueChange(changes, 'glyph.metrics-key.changed', {
                glyphName
            });
        }
        return {
            changes,
            compatibilityCheckGlyphNames,
            mastersChanged,
            lifecycleChanges
        };
    }

    if (field === 'layers') {
        const layerId = path[3];
        // glyphs.<name>.layers  (rare bulk write)
        if (!layerId) {
            pushUniqueChange(changes, 'glyph.layers.changed', { glyphName });
            compatibilityCheckGlyphNames.push(glyphName);
            return {
                changes,
                compatibilityCheckGlyphNames,
                mastersChanged,
                lifecycleChanges
            };
        }

        // glyphs.<name>.layers.<id> add/remove
        if (
            path.length === 4 &&
            (entry.op === 'add' || entry.op === 'remove')
        ) {
            pushUniqueChange(changes, 'glyph.layers.changed', {
                glyphName,
                layerIds: [layerId]
            });
            compatibilityCheckGlyphNames.push(glyphName);
            return {
                changes,
                compatibilityCheckGlyphNames,
                mastersChanged,
                lifecycleChanges
            };
        }

        const layerResult = deriveLayerSubtreeChanges(
            glyphName,
            layerId,
            path.slice(4),
            entry
        );
        changes.push(...layerResult.changes);
        if (layerResult.mayAffectCompatibility) {
            compatibilityCheckGlyphNames.push(glyphName);
        }
        return {
            changes,
            compatibilityCheckGlyphNames,
            mastersChanged,
            lifecycleChanges
        };
    }

    return {
        changes,
        compatibilityCheckGlyphNames,
        mastersChanged,
        lifecycleChanges
    };
}

/** Deduplicate filter changes by type + metadata identity. */
export function dedupeGlyphFilterChanges(
    changes: readonly GlyphFilterChange[]
): GlyphFilterChange[] {
    const deduplicated = new Map<string, GlyphFilterChange>();
    for (const change of changes) {
        deduplicated.set(
            `${change.type}:${JSON.stringify(change.metadata)}`,
            change
        );
    }
    return [...deduplicated.values()];
}
