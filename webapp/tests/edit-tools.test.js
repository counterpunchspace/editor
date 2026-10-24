const {
    resolveHighlightedEditTool,
    resolvePointerBadge,
    resolvePointerBadgeTool,
    chooseDefaultStickyEditTool,
    ensureStickyEditToolAvailable,
    shortcutKeyToStickyEditTool
} = require('../js/glyph-canvas/edit-tools.ts');

describe('edit-tools helpers', () => {
    test('text mode always highlights the text tool', () => {
        expect(
            resolveHighlightedEditTool({
                isEditMode: false,
                stickyTool: 'select',
                cmdKeyPressed: true,
                altKeyPressed: true,
                hasAddPointPreview: true,
                hoveringStraightSegment: true
            })
        ).toBe('text');
    });

    test('maps Cmd/Alt modifiers onto toolbar highlights', () => {
        expect(
            resolveHighlightedEditTool({
                isEditMode: true,
                stickyTool: 'select',
                cmdKeyPressed: true,
                altKeyPressed: false,
                hasAddPointPreview: false,
                hoveringStraightSegment: false
            })
        ).toBe('pen');

        expect(
            resolveHighlightedEditTool({
                isEditMode: true,
                stickyTool: 'select',
                cmdKeyPressed: true,
                altKeyPressed: false,
                hasAddPointPreview: true,
                hoveringStraightSegment: false
            })
        ).toBe('insert');

        expect(
            resolveHighlightedEditTool({
                isEditMode: true,
                stickyTool: 'select',
                cmdKeyPressed: false,
                altKeyPressed: true,
                hasAddPointPreview: false,
                hoveringStraightSegment: true
            })
        ).toBe('convert');

        expect(
            resolveHighlightedEditTool({
                isEditMode: true,
                stickyTool: 'select',
                cmdKeyPressed: false,
                altKeyPressed: true,
                hasAddPointPreview: false,
                hoveringStraightSegment: false
            })
        ).toBe('select');

        expect(
            resolveHighlightedEditTool({
                isEditMode: true,
                stickyTool: 'convert',
                cmdKeyPressed: false,
                altKeyPressed: true,
                hasAddPointPreview: false,
                hoveringStraightSegment: false
            })
        ).toBe('convert');
    });

    test('restores sticky tool when modifiers are released', () => {
        expect(
            resolveHighlightedEditTool({
                isEditMode: true,
                stickyTool: 'select',
                cmdKeyPressed: false,
                altKeyPressed: false,
                hasAddPointPreview: false,
                hoveringStraightSegment: false
            })
        ).toBe('select');
    });

    test('pointer badges follow insert/convert/cut highlights', () => {
        expect(resolvePointerBadgeTool('insert')).toBe('insert');
        expect(resolvePointerBadgeTool('convert')).toBe('convert');
        expect(resolvePointerBadgeTool('cut')).toBe('cut');
        expect(resolvePointerBadgeTool('pen')).toBeNull();
        expect(resolvePointerBadgeTool('text')).toBeNull();
    });

    test('Cmd hover over a cuttable node shows the cut badge without highlighting Cut', () => {
        expect(
            resolveHighlightedEditTool({
                isEditMode: true,
                stickyTool: 'select',
                cmdKeyPressed: true,
                altKeyPressed: false,
                hasAddPointPreview: false,
                hoveringStraightSegment: false
            })
        ).toBe('pen');

        const idleHover = {
            hoveringOnCurveNode: false,
            hoveringCurveSegment: false,
            hoveringCommandContinueEndpoint: false
        };

        expect(
            resolvePointerBadge({
                highlightedTool: 'pen',
                cmdKeyPressed: true,
                altKeyPressed: false,
                hoveringCuttableNode: true,
                hoveringSlideableSmoothNode: false,
                ...idleHover
            })
        ).toBe('cut');

        expect(
            resolvePointerBadge({
                highlightedTool: 'pen',
                cmdKeyPressed: true,
                altKeyPressed: false,
                hoveringCuttableNode: false,
                hoveringSlideableSmoothNode: true,
                ...idleHover
            })
        ).toBeNull();

        expect(
            resolvePointerBadge({
                highlightedTool: 'select',
                cmdKeyPressed: true,
                altKeyPressed: true,
                hoveringCuttableNode: true,
                hoveringSlideableSmoothNode: true,
                hoveringOnCurveNode: true,
                hoveringCurveSegment: false,
                hoveringCommandContinueEndpoint: false
            })
        ).toBe('slide');

        expect(
            resolvePointerBadge({
                highlightedTool: 'select',
                cmdKeyPressed: false,
                altKeyPressed: true,
                hoveringCuttableNode: false,
                hoveringSlideableSmoothNode: false,
                hoveringOnCurveNode: false,
                hoveringCurveSegment: true,
                hoveringCommandContinueEndpoint: false
            })
        ).toBe('blocked');

        expect(
            resolvePointerBadge({
                highlightedTool: 'select',
                cmdKeyPressed: true,
                altKeyPressed: false,
                hoveringCuttableNode: false,
                hoveringSlideableSmoothNode: false,
                hoveringOnCurveNode: true,
                hoveringCurveSegment: false,
                hoveringCommandContinueEndpoint: false
            })
        ).toBe('blocked');

        expect(
            resolvePointerBadge({
                highlightedTool: 'pen',
                cmdKeyPressed: true,
                altKeyPressed: false,
                hoveringCuttableNode: false,
                hoveringSlideableSmoothNode: false,
                hoveringOnCurveNode: true,
                hoveringCurveSegment: false,
                hoveringCommandContinueEndpoint: true
            })
        ).toBeNull();

        expect(
            resolvePointerBadge({
                highlightedTool: 'select',
                cmdKeyPressed: true,
                altKeyPressed: true,
                hoveringCuttableNode: true,
                hoveringSlideableSmoothNode: false,
                hoveringOnCurveNode: true,
                hoveringCurveSegment: false,
                hoveringCommandContinueEndpoint: false
            })
        ).toBe('blocked');
    });

    test('defaults to select even when the layer is empty', () => {
        expect(
            chooseDefaultStickyEditTool({
                text: true,
                select: true,
                pen: true,
                insert: false,
                convert: false,
                cut: false
            })
        ).toBe('select');

        expect(
            chooseDefaultStickyEditTool({
                text: true,
                select: false,
                pen: true,
                insert: false,
                convert: false,
                cut: false
            })
        ).toBe('select');

        expect(
            ensureStickyEditToolAvailable('insert', {
                text: true,
                select: true,
                pen: true,
                insert: false,
                convert: false,
                cut: false
            })
        ).toBe('select');

        expect(
            ensureStickyEditToolAvailable('cut', {
                text: true,
                select: true,
                pen: true,
                insert: false,
                convert: false,
                cut: false
            })
        ).toBe('select');
    });

    test('maps tool shortcut keys including I for insert', () => {
        expect(shortcutKeyToStickyEditTool('t')).toBe('text');
        expect(shortcutKeyToStickyEditTool('V')).toBe('select');
        expect(shortcutKeyToStickyEditTool('p')).toBe('pen');
        expect(shortcutKeyToStickyEditTool('i')).toBe('insert');
        expect(shortcutKeyToStickyEditTool('n')).toBeNull();
        expect(shortcutKeyToStickyEditTool('c')).toBe('convert');
        expect(shortcutKeyToStickyEditTool('x')).toBeNull();
        expect(shortcutKeyToStickyEditTool('k')).toBeNull();
    });
});
