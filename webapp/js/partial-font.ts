/**
 * A cloud font opened with “Load outlines later” holds only the glyphs that
 * were loaded. Writing it to a new file would leave every other glyph out,
 * so Save As is refused for it.
 */

export const PARTIAL_FONT_SAVE_AS_MESSAGE =
    'Save As isn’t available while a cloud font is open with “Load outlines later”: the copy would miss every glyph that isn’t loaded. Open the font again without “Load outlines later” to save a copy.';

/** True while the open font holds only some of its glyphs. */
export function isPartiallyLoadedFont(): boolean {
    return !!window.patchSyncEngine?.hasSparseWorkingSet?.();
}
