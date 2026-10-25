const {
    rewriteTextBufferForGlyphRenames,
    rewriteGlyphStackForGlyphRenames,
    applyGlyphRenameUiContext
} = require('../js/rename-glyphs-ui-context');

describe('rename glyphs UI context', () => {
    test('rewrites explicit glyph tokens and keeps encoded characters', () => {
        const renames = new Map([
            ['a', 'aaa'],
            ['fi', 'f_i'],
            ['fathatan-ar', 'fathaTanween-ar']
        ]);

        expect(rewriteTextBufferForGlyphRenames('Hamburge', renames)).toBe(
            'Hamburge'
        );
        expect(rewriteTextBufferForGlyphRenames('/a /fi def', renames)).toBe(
            '/aaa /f_i def'
        );
        expect(rewriteTextBufferForGlyphRenames('/a/fi', renames)).toBe(
            '/aaa/f_i'
        );
        expect(rewriteTextBufferForGlyphRenames('0//10', renames)).toBe(
            '0//10'
        );
        // A mark stays a shaped character so GPOS still attaches it.
        expect(
            rewriteTextBufferForGlyphRenames('\u0628\u0627\u064B', renames)
        ).toBe('\u0628\u0627\u064B');
        expect(
            rewriteTextBufferForGlyphRenames('\u{1F600}/fathatan-ar', renames)
        ).toBe('\u{1F600}/fathaTanween-ar');
    });

    test('rewrites glyph names inside glyph_stack segments', () => {
        const renames = new Map([
            ['a', 'aaa'],
            ['acutecomb', 'acute']
        ]);
        expect(
            rewriteGlyphStackForGlyphRenames(
                'a@layer-1>0:acutecomb@layer-2',
                renames
            )
        ).toBe('aaa@layer-1>0:acute@layer-2');
        expect(rewriteGlyphStackForGlyphRenames('b@layer-1', renames)).toBe(
            'b@layer-1'
        );
    });

    test('applyGlyphRenameUiContext updates text buffer and glyph stack', () => {
        const previousCanvas = window.glyphCanvas;
        const previousStateManager = window.stateManager;
        const setTextBuffer = jest.fn();
        const shapeText = jest.fn();
        const onGlyphSelected = jest.fn();
        const doUIUpdate = jest.fn();
        const stackEvents = [];
        const onStack = (event) => stackEvents.push(event.detail.glyphStack);
        window.addEventListener('glyphStackChanged', onStack);

        window.stateManager = { editor_glyph_stack: 'a@layer-1' };
        window.glyphCanvas = {
            textRunEditor: {
                textBuffer: 'a/fi',
                setTextBuffer,
                shapeText
            },
            outlineEditor: {
                glyphStack: 'a@layer-1>0:fi@layer-2',
                currentGlyphName: 'fi',
                parseGlyphStack: jest.fn(() => [
                    { glyphName: 'aaa', layerId: 'layer-1' },
                    { glyphName: 'f_i', layerId: 'layer-2' }
                ]),
                onGlyphSelected
            },
            doUIUpdate
        };

        try {
            applyGlyphRenameUiContext(
                new Map([
                    ['a', 'aaa'],
                    ['fi', 'f_i']
                ])
            );

            expect(setTextBuffer).toHaveBeenCalledWith('a/f_i');
            expect(window.glyphCanvas.outlineEditor.glyphStack).toBe(
                'aaa@layer-1>0:f_i@layer-2'
            );
            expect(window.glyphCanvas.outlineEditor.currentGlyphName).toBe(
                'f_i'
            );
            expect(window.stateManager.editor_glyph_stack).toBe(
                'aaa@layer-1>0:f_i@layer-2'
            );
            expect(stackEvents).toEqual(['aaa@layer-1>0:f_i@layer-2']);
            expect(onGlyphSelected).toHaveBeenCalled();
            expect(doUIUpdate).toHaveBeenCalled();
        } finally {
            window.removeEventListener('glyphStackChanged', onStack);
            window.glyphCanvas = previousCanvas;
            window.stateManager = previousStateManager;
        }
    });
});
