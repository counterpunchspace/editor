import type { HistoryUndoSurface } from './change-log';

export type UndoRedoContext = {
    rootGlyphName: string | undefined;
    undoGlyphName: string | undefined;
    undoDrawingId: string | null;
    historyTargetKey: string | null;
    surface: HistoryUndoSurface;
};

/** Last undo surface from a main editing view (editor / overview / font info). */
let lastMainUndoContext: UndoRedoContext | null = null;

/** Test helper — clears sticky main-view undo context. */
export function resetUndoRedoContextStickyState(): void {
    lastMainUndoContext = null;
}

export function isViewFocused(viewIdOrSelector: string): boolean {
    const id = viewIdOrSelector.startsWith('#')
        ? viewIdOrSelector.slice(1)
        : viewIdOrSelector;
    return (
        (
            document.getElementById(id) ?? document.querySelector(`#${id}`)
        )?.classList.contains('focused') ?? false
    );
}

function isFontInfoViewFocused(): boolean {
    return isViewFocused('#view-fontinfo');
}

function isOverviewViewFocused(): boolean {
    return isViewFocused('#view-overview');
}

function isEditorViewFocused(): boolean {
    return isViewFocused('#view-editor');
}

/** Scripts, Konsole, and Assistant own the automation undo surface. */
export function isAutomationUndoViewFocused(): boolean {
    return (
        isViewFocused('#view-scripts') ||
        isViewFocused('#view-console') ||
        isViewFocused('#view-assistant')
    );
}

function isFontInfoFeaturesTabVisible(): boolean {
    const featuresTab = document.getElementById('fontinfo-features-content');
    if (!featuresTab) {
        return false;
    }

    return featuresTab.style.display !== 'none';
}

function rememberMainUndoContext(context: UndoRedoContext): UndoRedoContext {
    lastMainUndoContext = context;
    return context;
}

function buildCanvasContext(
    rootGlyphName: string | undefined,
    undoGlyphName: string | undefined,
    undoDrawingId: string | null
): UndoRedoContext {
    return {
        rootGlyphName,
        undoGlyphName,
        undoDrawingId,
        historyTargetKey: null,
        surface: 'canvas'
    };
}

function buildFontContext(rootGlyphName: string | undefined): UndoRedoContext {
    return {
        rootGlyphName,
        undoGlyphName: undefined,
        undoDrawingId: null,
        historyTargetKey: null,
        surface: 'font'
    };
}

function buildOverviewContext(
    rootGlyphName: string | undefined
): UndoRedoContext {
    return {
        rootGlyphName,
        undoGlyphName: undefined,
        undoDrawingId: null,
        historyTargetKey: null,
        surface: 'overview'
    };
}

function buildFeatureContext(
    rootGlyphName: string | undefined,
    historyTargetKey: string | null
): UndoRedoContext {
    return {
        rootGlyphName,
        undoGlyphName: undefined,
        undoDrawingId: null,
        historyTargetKey,
        surface: 'feature'
    };
}

function buildAutomationContext(
    rootGlyphName: string | undefined
): UndoRedoContext {
    return {
        rootGlyphName,
        undoGlyphName: undefined,
        undoDrawingId: null,
        historyTargetKey: null,
        surface: 'automation'
    };
}

/**
 * Undo / History reachability follows the focused editing surface.
 *
 * Main surfaces: glyph editor, overview, Font Info.
 * Automation surface: Scripts, Konsole, Assistant (Python / AI font edits).
 * Auxiliary panels such as History do not switch the surface — they keep the
 * last main-view context (not the automation surface).
 */
export function getUndoRedoContext(): UndoRedoContext {
    const oe = window.glyphCanvas?.outlineEditor;
    const parsedStack = oe?.active ? oe.parseGlyphStack() : [];
    const currentGlyphName =
        oe?.currentGlyphName ?? window.glyphCanvas?.getCurrentGlyphName?.();
    const rootGlyphName = parsedStack[0]?.glyphName ?? currentGlyphName;
    const fallbackUndoGlyphName =
        parsedStack[parsedStack.length - 1]?.glyphName ?? currentGlyphName;
    const fallbackUndoDrawingId = oe?.selectedDrawingId ?? null;

    const fontInfoFocused = isFontInfoViewFocused();
    const overviewFocused = isOverviewViewFocused();
    const editorFocused = isEditorViewFocused();
    const automationFocused = isAutomationUndoViewFocused();
    const featuresTabVisible = isFontInfoFeaturesTabVisible();
    const mainViewFocused = fontInfoFocused || overviewFocused || editorFocused;

    if (fontInfoFocused && featuresTabVisible) {
        const featureTarget =
            window.fontInfoManager?.getHistoryScopeTarget?.() ?? null;
        if (featureTarget?.key) {
            return rememberMainUndoContext(
                buildFeatureContext(rootGlyphName, featureTarget.key)
            );
        }
        return rememberMainUndoContext(buildFontContext(rootGlyphName));
    }

    if (fontInfoFocused) {
        return rememberMainUndoContext(buildFontContext(rootGlyphName));
    }

    if (overviewFocused) {
        return rememberMainUndoContext(buildOverviewContext(rootGlyphName));
    }

    if (
        editorFocused &&
        oe?.active &&
        fallbackUndoGlyphName &&
        fallbackUndoDrawingId
    ) {
        return rememberMainUndoContext(
            buildCanvasContext(
                rootGlyphName,
                fallbackUndoGlyphName,
                fallbackUndoDrawingId
            )
        );
    }

    if (editorFocused) {
        // Text mode (or editor without a selected drawing): Editing View /
        // canvas surface. Kerning and other editor-owned font edits join
        // via undoSurfaceAffinity; drawing-origin edits for the caret glyph
        // remain reachable without inventing a fake drawing id.
        return rememberMainUndoContext(
            buildCanvasContext(
                rootGlyphName,
                fallbackUndoGlyphName,
                fallbackUndoDrawingId
            )
        );
    }

    // Scripts / Konsole / Assistant: undo Python- and Assistant-sourced edits
    // regardless of derived font/glyph/drawing scope. Do not sticky this as the
    // main-view context — History keeps the last Editor/Overview/Font Info.
    if (automationFocused) {
        return buildAutomationContext(rootGlyphName);
    }

    // History and other auxiliary panels: keep last main editing surface.
    if (!mainViewFocused && lastMainUndoContext) {
        return lastMainUndoContext;
    }

    // Cold start with no main view focused yet.
    return buildFontContext(rootGlyphName);
}

window.getUndoRedoContext = getUndoRedoContext;
