import type { Font, Glyph } from '../babelfont-model';
import type { CompositionPlan } from './composition-planner';

type Bridge = {
    beginTransaction(
        label: string,
        historyTarget: null,
        metadata: { compileChangeSource: string; compileEditType: null }
    ): void;
    endTransaction(): void;
    setTransactionIntent?(key: string, value: unknown): void;
};

/** Apply a composition plan as one undoable transaction. The ccmp block is written by the feature generator. */
export function applyCompositionPlan(
    font: Font,
    plan: CompositionPlan,
    label: string
): void {
    const bridge = window.patchSyncEngine as Bridge | undefined;
    const run = () => {
        bridge?.setTransactionIntent?.('ccmp', {
            add: plan.ccmpAdd,
            remove: plan.ccmpRemove,
            components: plan.ccmpComponents
        });
        if (plan.arabicAdd || plan.arabicRemove) {
            bridge?.setTransactionIntent?.('arabic', {
                add: plan.arabicAdd || {},
                remove: plan.arabicRemove || []
            });
        }
        for (const glyph of plan.create) {
            if (font.findGlyph(glyph.name)) {
                continue;
            }
            const added = font.addGlyph(glyph.name, glyph.category);
            added.codepoints = glyph.codepoints;
            if (glyph.width === 0) {
                for (const layer of added.layers || []) {
                    layer.width = 0;
                }
            }
            placeAnchors(added, glyph.anchors);
        }
        for (const name of plan.clearShells) {
            clearGlyph(font.findGlyph(name));
        }
        for (const composite of plan.composites) {
            const glyph = font.findGlyph(composite.name);
            if (!glyph) {
                continue;
            }
            for (const layer of glyph.layers || []) {
                clearLayerShapes(layer);
                for (const component of composite.components) {
                    layer.addComponent(component);
                }
            }
        }
        if (plan.deletes?.length) {
            font.deleteGlyphs(plan.deletes);
        }
    };
    if (!bridge) {
        run();
        return;
    }
    bridge.beginTransaction(label, null, {
        compileChangeSource: 'model-edit',
        compileEditType: null
    });
    try {
        run();
    } finally {
        bridge.endTransaction();
    }
}

function placeAnchors(
    glyph: Glyph,
    anchors: Array<{ masterId: string; name: string; x: number; y: number }>
): void {
    for (const anchor of anchors) {
        const layer = (glyph.layers || []).find(
            (candidate) =>
                candidate.master?.master === anchor.masterId ||
                candidate.id === anchor.masterId
        );
        layer?.addAnchor(anchor.x, anchor.y, anchor.name);
    }
}

function clearGlyph(glyph: Glyph | undefined): void {
    if (!glyph) {
        return;
    }
    for (const layer of glyph.layers || []) {
        clearLayerShapes(layer);
    }
}

function clearLayerShapes(layer: {
    shapes?: unknown[];
    removeShape(index: number): void;
}): void {
    const shapes = layer.shapes;
    if (!shapes?.length) {
        return;
    }
    // Delete from the end. Two removals of index 0 share one Yjs path and
    // collapse into a single delete, which keeps every shape after the first.
    for (let index = shapes.length - 1; index >= 0; index -= 1) {
        layer.removeShape(index);
    }
}
