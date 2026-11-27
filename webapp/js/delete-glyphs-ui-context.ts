/**
 * Update live editor UI after glyphs are deleted.
 *
 * Text buffer contents are left intact so typed/encoded characters whose
 * glyphs were deleted continue to shape as .notdef. If glyph-edit mode is
 * focused on a deleted glyph, exit back to text mode.
 */

import { parseGlyphStackSegment } from './rename-glyphs-ui-context';

/** True when any glyph_stack segment names a deleted glyph. */
export function glyphStackReferencesDeletedGlyph(
    stack: string,
    deletedNames: ReadonlySet<string>
): boolean {
    if (!stack || deletedNames.size === 0) {
        return false;
    }
    return stack.split('>').some((segment) => {
        const parsed = parseGlyphStackSegment(segment);
        return !!parsed && deletedNames.has(parsed.glyphName);
    });
}

export function applyGlyphDeleteUiContext(
    deletedNames: ReadonlySet<string>,
    _codepointsByDeletedName: ReadonlyMap<string, readonly number[]>
): void {
    if (deletedNames.size === 0) {
        return;
    }

    const canvas = window.glyphCanvas;
    const outlineEditor = canvas?.outlineEditor;
    const editingDeletedGlyph =
        !!outlineEditor?.active &&
        (deletedNames.has(outlineEditor.currentGlyphName || '') ||
            glyphStackReferencesDeletedGlyph(
                outlineEditor.glyphStack || '',
                deletedNames
            ));

    if (
        editingDeletedGlyph &&
        typeof canvas?.exitGlyphEditMode === 'function'
    ) {
        canvas.exitGlyphEditMode();
    }

    // Keep the text buffer unchanged so missing glyphs render as .notdef.
    const textRun = canvas?.textRunEditor;
    if (textRun) {
        textRun.shapeText?.();
        textRun.call?.('textchanged');
    }

    if (!outlineEditor) {
        return;
    }

    if (
        glyphStackReferencesDeletedGlyph(
            outlineEditor.glyphStack || '',
            deletedNames
        )
    ) {
        outlineEditor.glyphStack = '';
        if (window.stateManager) {
            window.stateManager.editor_glyph_stack = '';
        }
        window.dispatchEvent(
            new CustomEvent('glyphStackChanged', {
                detail: { glyphStack: '' }
            })
        );
    }

    if (typeof canvas?.doUIUpdateAsync === 'function') {
        void canvas.doUIUpdateAsync();
    } else {
        canvas?.doUIUpdate?.();
    }
}
