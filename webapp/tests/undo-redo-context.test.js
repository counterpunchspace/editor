import {
    getUndoRedoContext,
    resetUndoRedoContextStickyState
} from '../js/undo-redo-context';

describe('getUndoRedoContext', () => {
    const originalGlyphCanvas = window.glyphCanvas;
    const originalFontInfoManager = window.fontInfoManager;
    let fontInfoView;
    let overviewView;
    let editorView;
    let featuresTab;

    beforeEach(() => {
        resetUndoRedoContextStickyState();

        fontInfoView = document.createElement('div');
        fontInfoView.id = 'view-fontinfo';
        document.body.appendChild(fontInfoView);

        overviewView = document.createElement('div');
        overviewView.id = 'view-overview';
        document.body.appendChild(overviewView);

        editorView = document.createElement('div');
        editorView.id = 'view-editor';
        document.body.appendChild(editorView);

        featuresTab = document.createElement('div');
        featuresTab.id = 'fontinfo-features-content';
        featuresTab.style.display = 'none';
        document.body.appendChild(featuresTab);

        window.fontInfoManager = {
            getHistoryScopeTarget: jest.fn(() => null)
        };
    });

    afterEach(() => {
        window.glyphCanvas = originalGlyphCanvas;
        window.fontInfoManager = originalFontInfoManager;
        resetUndoRedoContextStickyState();
        fontInfoView?.remove();
        overviewView?.remove();
        editorView?.remove();
        featuresTab?.remove();
    });

    function setOutlineEditorActive() {
        window.glyphCanvas = {
            outlineEditor: {
                active: true,
                selectedDrawingId: 'layer-1',
                parseGlyphStack: jest.fn(() => [
                    { glyphName: 'a' },
                    { glyphName: 'a.alt' }
                ])
            }
        };
    }

    test('uses canvas surface when the glyph editor is focused', () => {
        editorView.classList.add('focused');
        setOutlineEditorActive();

        expect(getUndoRedoContext()).toEqual({
            rootGlyphName: 'a',
            undoGlyphName: 'a.alt',
            undoDrawingId: 'layer-1',
            historyTargetKey: null,
            surface: 'canvas'
        });
    });

    test('uses canvas surface for Editing View text mode', () => {
        editorView.classList.add('focused');
        window.glyphCanvas = {
            outlineEditor: {
                active: false,
                selectedDrawingId: null,
                parseGlyphStack: jest.fn(() => []),
                currentGlyphName: 'a'
            },
            getCurrentGlyphName: jest.fn(() => 'a')
        };

        expect(getUndoRedoContext()).toEqual({
            rootGlyphName: 'a',
            undoGlyphName: 'a',
            undoDrawingId: null,
            historyTargetKey: null,
            surface: 'canvas'
        });
    });

    test('uses font scope when Font Info view is focused on a non-feature tab', () => {
        fontInfoView.classList.add('focused');
        setOutlineEditorActive();

        expect(getUndoRedoContext()).toEqual({
            rootGlyphName: 'a',
            undoGlyphName: undefined,
            undoDrawingId: null,
            historyTargetKey: null,
            surface: 'font'
        });
    });

    test('uses feature scope when Font Info features tab is focused with a target', () => {
        fontInfoView.classList.add('focused');
        featuresTab.style.display = 'block';
        setOutlineEditorActive();
        window.fontInfoManager.getHistoryScopeTarget = jest.fn(() => ({
            type: 'feature',
            key: 'feature:kern',
            label: 'kern'
        }));

        expect(getUndoRedoContext()).toEqual({
            rootGlyphName: 'a',
            undoGlyphName: undefined,
            undoDrawingId: null,
            historyTargetKey: 'feature:kern',
            surface: 'feature'
        });
    });

    test('uses overview surface when glyph overview is focused', () => {
        overviewView.classList.add('focused');
        window.glyphCanvas = {
            outlineEditor: {
                active: false,
                selectedDrawingId: null,
                parseGlyphStack: jest.fn(() => [])
            }
        };

        expect(getUndoRedoContext()).toEqual({
            rootGlyphName: undefined,
            undoGlyphName: undefined,
            undoDrawingId: null,
            historyTargetKey: null,
            surface: 'overview'
        });
    });

    test('keeps the last main-view surface when History is focused', () => {
        overviewView.classList.add('focused');
        setOutlineEditorActive();
        expect(getUndoRedoContext().surface).toBe('overview');

        overviewView.classList.remove('focused');
        // Simulate activating History (no main editing view focused).
        expect(getUndoRedoContext()).toEqual({
            rootGlyphName: 'a',
            undoGlyphName: undefined,
            undoDrawingId: null,
            historyTargetKey: null,
            surface: 'overview'
        });
    });

    test('uses automation surface when Scripts, Konsole, or Assistant is focused', () => {
        const scriptsView = document.createElement('div');
        scriptsView.id = 'view-scripts';
        document.body.appendChild(scriptsView);

        const consoleView = document.createElement('div');
        consoleView.id = 'view-console';
        document.body.appendChild(consoleView);

        const assistantView = document.createElement('div');
        assistantView.id = 'view-assistant';
        document.body.appendChild(assistantView);

        overviewView.classList.add('focused');
        setOutlineEditorActive();
        expect(getUndoRedoContext().surface).toBe('overview');
        overviewView.classList.remove('focused');

        scriptsView.classList.add('focused');
        expect(getUndoRedoContext()).toEqual({
            rootGlyphName: 'a',
            undoGlyphName: undefined,
            undoDrawingId: null,
            historyTargetKey: null,
            surface: 'automation'
        });

        scriptsView.classList.remove('focused');
        consoleView.classList.add('focused');
        expect(getUndoRedoContext().surface).toBe('automation');

        consoleView.classList.remove('focused');
        assistantView.classList.add('focused');
        expect(getUndoRedoContext().surface).toBe('automation');

        // Leaving automation for History restores the sticky main surface.
        assistantView.classList.remove('focused');
        expect(getUndoRedoContext().surface).toBe('overview');

        scriptsView.remove();
        consoleView.remove();
        assistantView.remove();
    });

    test('does not invent canvas context before any main view is focused', () => {
        setOutlineEditorActive();

        expect(getUndoRedoContext()).toEqual({
            rootGlyphName: 'a',
            undoGlyphName: undefined,
            undoDrawingId: null,
            historyTargetKey: null,
            surface: 'font'
        });
    });
});
