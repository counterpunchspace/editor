/**
 * Rebuilds the app state a tour slide starts from (Back, Restart step, and
 * recovery when the user wanders off), and snapshots the glyph the drawing
 * exercises edit so earlier slides get their outlines back.
 */

import { Logger } from './logger';
import {
    selectTourMasterByName,
    TOUR_EDIERESIS_LETTER,
    TOUR_EXTRABOLD_MASTER_NAME,
    TOUR_INTERPOLATED_WGHT,
    TOUR_LETTER_L,
    TOUR_SAMPLE_TEXT,
    type TourStage
} from './tour-slides';
import {
    componentReferenceMatches,
    findShapedGlyphIndexForLetter,
    getTourComponentDepth,
    getTourEditRootGlyphName
} from './tour-components';
import { wait } from './tour-spotlight';

const console = new Logger('Tour');

const TOUR_EDIT_GLYPH = 'l.ss04';
const TOUR_COMPONENT_BASE_GLYPH = 'edieresis';
const EDIT_MODE_TIMEOUT_MS = 8000;

export type TourGlyphSnapshot = {
    glyphName: string;
    layers: Array<{ id: string; shapes: string }>;
};

/** Canvas zoom and pan, valid only at the canvas size it was taken at. */
export type TourViewport = {
    scale: number;
    panX: number;
    panY: number;
    width: number;
    height: number;
};

type SnapshotLayer = {
    id?: string;
    is_background?: boolean;
    shapes?: unknown[];
    toJSON?: () => { shapes?: unknown[] };
};

function viewAnimationDelayMs(): number {
    const animation = window.VIEW_SETTINGS?.animation;
    if (animation?.enabled && typeof animation.duration === 'number') {
        return animation.duration + 40;
    }
    return 0;
}

function waitForNextAnimationFrame(): Promise<void> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => resolve());
    });
}

async function waitFor(
    condition: () => boolean,
    timeoutMs: number
): Promise<boolean> {
    const started = Date.now();
    while (!condition()) {
        if (Date.now() - started >= timeoutMs) {
            return false;
        }
        await wait(50);
    }
    return true;
}

export async function maximizeEditorView(): Promise<void> {
    window.focusView?.('view-editor');
    await wait(viewAnimationDelayMs());
    window.resizeView?.('view-editor');
    await wait(viewAnimationDelayMs());
    window.resizeView?.('view-editor');
    await wait(viewAnimationDelayMs());
}

function tourSampleTextHasCompiledGlyphs(): boolean {
    const textRun = window.glyphCanvas?.textRunEditor;
    const glyphs = textRun?.shapedGlyphs || [];
    if (glyphs.length === 0) {
        return false;
    }
    const names = textRun?.glyphNameBuffer;
    if (Array.isArray(names) && names.length === glyphs.length) {
        return names.every((name) => !!name && name !== '.notdef');
    }
    return glyphs.every((glyph) => (glyph.g ?? 0) !== 0);
}

async function waitForTourSampleCompiledGlyphs(): Promise<void> {
    if (tourSampleTextHasCompiledGlyphs()) {
        return;
    }
    const started = Date.now();
    await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            window.removeEventListener('glyphCanvasRendered', onPulse);
            window.clearInterval(intervalId);
            resolve();
        };
        const onPulse = () => {
            if (
                tourSampleTextHasCompiledGlyphs() ||
                Date.now() - started >= 8000
            ) {
                finish();
            }
        };
        const intervalId = window.setInterval(onPulse, 50);
        window.addEventListener('glyphCanvasRendered', onPulse);
    });
}

/** Same settle + fit as font load after the sample text is set. */
async function fitTourSampleTextViewport(): Promise<void> {
    await waitForTourSampleCompiledGlyphs();
    await waitForNextAnimationFrame();
    await waitForNextAnimationFrame();
    await window.glyphCanvas?.applyInitialViewportFit?.();
}

async function setReachableOpenTypeFeatures(tags: string[]): Promise<void> {
    const manager = window.glyphCanvas?.featuresManager;
    if (typeof manager?.setEnabledFeatures === 'function') {
        try {
            await manager.setEnabledFeatures(tags);
            return;
        } catch {
            // Features UI may not be ready; fall through to button clicks.
        }
    }

    const buttons = document.querySelectorAll<HTMLButtonElement>(
        'button[data-feature-tag]'
    );
    for (const button of buttons) {
        const wanted = tags.includes(button.dataset.featureTag || '');
        if (
            button.disabled ||
            button.classList.contains('enabled') === wanted
        ) {
            continue;
        }
        button.click();
    }
}

function exitTourEditMode(): void {
    const canvas = window.glyphCanvas;
    if (canvas?.outlineEditor?.active) {
        canvas.exitGlyphEditMode();
    }
}

async function restoreTextStage(
    stage: Extract<TourStage, { kind: 'text' }>
): Promise<void> {
    await maximizeEditorView();
    exitTourEditMode();
    const canvas = window.glyphCanvas;
    if (stage.master) {
        await selectTourMasterByName(stage.master);
    } else if (typeof stage.wght === 'number') {
        await canvas?.animateToLocation?.({ wght: stage.wght }, 1);
    }
    canvas?.outlineEditor?.setGuidelinesVisible?.(false);
    await setReachableOpenTypeFeatures(stage.ss04 ? ['ss04'] : []);
    canvas?.textRunEditor?.setTextBuffer(TOUR_SAMPLE_TEXT);
    await fitTourSampleTextViewport();
}

/** Double-click equivalent: open the sample-text letter in Edit Mode. */
async function openTourLetter(
    letter: string,
    glyphName: string
): Promise<boolean> {
    const canvas = window.glyphCanvas;
    const index = findShapedGlyphIndexForLetter(letter);
    if (!canvas?.textRunEditor || index < 0) {
        console.warn('Tour letter not found in the sample text', letter);
        return false;
    }
    await canvas.textRunEditor.selectGlyphByIndex(index);
    return waitFor(
        () =>
            getTourEditRootGlyphName() === glyphName &&
            !!canvas.outlineEditor?.layerData,
        EDIT_MODE_TIMEOUT_MS
    );
}

function findPathIndex(): number {
    const shapes = window.glyphCanvas?.outlineEditor?.layerData?.shapes || [];
    return shapes.findIndex(
        (shape) => !!shape && typeof shape === 'object' && 'nodes' in shape
    );
}

async function restoreEditLStage(
    stage: Extract<TourStage, { kind: 'edit-l' }>,
    snapshot: TourGlyphSnapshot | null
): Promise<void> {
    await restoreTextStage(
        stage.layer === 'master'
            ? { kind: 'text', ss04: true, master: TOUR_EXTRABOLD_MASTER_NAME }
            : { kind: 'text', ss04: true, wght: TOUR_INTERPOLATED_WGHT }
    );
    if (snapshot) {
        restoreTourGlyphSnapshot(snapshot);
    }
    if (!(await openTourLetter(TOUR_LETTER_L, TOUR_EDIT_GLYPH))) {
        return;
    }
    const canvas = window.glyphCanvas;
    const editor = canvas?.outlineEditor;
    editor?.setActiveEditTool?.('select');
    canvas?.handleCmdZeroFit?.();
    await wait(200);
    if (stage.selectContour) {
        const pathIndex = findPathIndex();
        if (pathIndex >= 0) {
            editor?.selectAllNodesInContour?.(pathIndex);
        }
    }
}

async function restoreEdieresisStage(
    stage: Extract<TourStage, { kind: 'edieresis' }>,
    snapshot: TourGlyphSnapshot | null
): Promise<void> {
    await restoreTextStage({
        kind: 'text',
        ss04: true,
        master: TOUR_EXTRABOLD_MASTER_NAME
    });
    if (snapshot) {
        restoreTourGlyphSnapshot(snapshot);
    }
    if (
        !(await openTourLetter(
            TOUR_EDIERESIS_LETTER,
            TOUR_COMPONENT_BASE_GLYPH
        ))
    ) {
        return;
    }
    const editor = window.glyphCanvas?.outlineEditor;
    for (const [depth, reference] of stage.components.entries()) {
        const layer = editor?.getCurrentLayerDataFromStack?.();
        const shapes = layer?.shapes || [];
        const index = shapes.findIndex((shape) => {
            const ref =
                shape && typeof shape === 'object' && 'reference' in shape
                    ? shape.reference
                    : undefined;
            return componentReferenceMatches(
                typeof ref === 'string' ? ref : undefined,
                reference
            );
        });
        if (index < 0) {
            console.warn('Tour component not found', reference);
            return;
        }
        await editor?.enterComponentEditing(index);
        await waitFor(
            () => getTourComponentDepth() === depth + 1,
            EDIT_MODE_TIMEOUT_MS
        );
    }
}

async function restorePanelsStage(
    stage: Extract<TourStage, { kind: 'panels' }>
): Promise<void> {
    exitTourEditMode();
    await maximizeEditorView();
    if (!stage.focus) {
        return;
    }
    window.focusView?.(stage.focus);
    await wait(viewAnimationDelayMs());
    if (stage.enlarge) {
        window.resizeView?.(stage.focus);
        await wait(viewAnimationDelayMs());
    }
}

/**
 * Put the app back into the state `stage` describes. `snapshot` restores
 * the drawing glyph as it was when the slide was first reached.
 */
export async function restoreTourStage(
    stage: TourStage,
    snapshot: TourGlyphSnapshot | null
): Promise<void> {
    if (stage.kind === 'text') {
        if (snapshot) {
            restoreTourGlyphSnapshot(snapshot);
        }
        await restoreTextStage(stage);
        return;
    }
    if (stage.kind === 'edit-l') {
        await restoreEditLStage(stage, snapshot);
        return;
    }
    if (stage.kind === 'edieresis') {
        await restoreEdieresisStage(stage, snapshot);
        return;
    }
    if (snapshot) {
        restoreTourGlyphSnapshot(snapshot);
    }
    await restorePanelsStage(stage);
}

/**
 * False when the user has left the state the current slide needs, e.g.
 * double-clicked a neighboring glyph while drawing.
 */
export function isTourStageIntact(stage: TourStage): boolean {
    const editGlyph = getTourEditRootGlyphName();
    if (stage.kind === 'edit-l') {
        return editGlyph === TOUR_EDIT_GLYPH;
    }
    if (stage.kind === 'edieresis') {
        return editGlyph === TOUR_COMPONENT_BASE_GLYPH;
    }
    return editGlyph === null;
}

function getTourEditGlyphLayers(): SnapshotLayer[] {
    const font =
        window.currentFontModel || window.fontManager?.currentFont?.fontModel;
    const glyph = font?.findGlyph?.(TOUR_EDIT_GLYPH);
    const layers = glyph?.layers;
    if (!layers) {
        return [];
    }
    return Array.from(layers as Iterable<SnapshotLayer>);
}

/** Shape ids are left out: re-adding a shape gives it a new one. */
function serializeLayerShapes(layer: SnapshotLayer): string {
    const json = typeof layer.toJSON === 'function' ? layer.toJSON() : layer;
    const shapes = (json?.shapes || []).map((shape) => {
        if (!shape || typeof shape !== 'object') {
            return shape;
        }
        const { id: _id, ...rest } = shape as Record<string, unknown>;
        return rest;
    });
    return JSON.stringify(shapes);
}

/** Outlines of every master layer of the drawing glyph. */
export function captureTourGlyphSnapshot(): TourGlyphSnapshot | null {
    const layers = getTourEditGlyphLayers()
        .filter((layer) => !layer.is_background && layer.id)
        .map((layer) => ({
            id: layer.id as string,
            shapes: serializeLayerShapes(layer)
        }));
    if (layers.length === 0) {
        return null;
    }
    return { glyphName: TOUR_EDIT_GLYPH, layers };
}

/** Write changed layers back; untouched layers keep their history. */
export function restoreTourGlyphSnapshot(snapshot: TourGlyphSnapshot): void {
    const canvas = window.glyphCanvas;
    for (const layer of getTourEditGlyphLayers()) {
        const saved = snapshot.layers.find((entry) => entry.id === layer.id);
        if (!saved || serializeLayerShapes(layer) === saved.shapes) {
            continue;
        }
        const model = layer as SnapshotLayer & {
            removeShape?: (index: number) => void;
            addShape?: (shape: unknown) => unknown;
        };
        if (!model.removeShape || !model.addShape) {
            continue;
        }
        for (let index = (layer.shapes?.length ?? 0) - 1; index >= 0; index--) {
            model.removeShape(index);
        }
        for (const shape of JSON.parse(saved.shapes) as unknown[]) {
            model.addShape(shape);
        }
        if (canvas?.outlineEditor?.active) {
            canvas.outlineEditor.clearAllSelections?.();
            canvas.syncCurrentOutlineLayerDataFromModel?.(
                layer as Parameters<
                    typeof canvas.syncCurrentOutlineLayerDataFromModel
                >[0]
            );
            canvas.render?.();
        }
        console.log('Restored tour glyph layer', layer.id);
    }
}

export function captureTourViewport(): TourViewport | null {
    const canvas = window.glyphCanvas;
    const viewport = canvas?.viewportManager;
    if (!canvas?.canvas || !viewport) {
        return null;
    }
    return {
        scale: viewport.scale,
        panX: viewport.panX,
        panY: viewport.panY,
        width: canvas.canvas.width,
        height: canvas.canvas.height
    };
}

/** Puts zoom and pan back unless the canvas was resized since. */
export function restoreTourViewport(saved: TourViewport): void {
    const canvas = window.glyphCanvas;
    const viewport = canvas?.viewportManager;
    if (
        !canvas?.canvas ||
        !viewport ||
        canvas.canvas.width !== saved.width ||
        canvas.canvas.height !== saved.height
    ) {
        return;
    }
    viewport.scale = saved.scale;
    viewport.panX = saved.panX;
    viewport.panY = saved.panY;
    canvas.render();
}
