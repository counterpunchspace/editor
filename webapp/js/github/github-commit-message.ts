// The commit message for one save, built from what the save changed.

import type { SaveSummary } from '../filesystem-plugins/filesystem-plugin';

/** More glyphs than this are counted instead of named. */
const MAX_NAMED_GLYPHS = 5;

function joinNames(names: string[]): string {
    if (names.length <= 1) return names.join('');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * “Edit A, B and aacute in Fustat”, “Edit 12 glyphs and font data in
 * Fustat”, or “Update Fustat” when the save wrote the whole font.
 */
export function commitMessage(summary: SaveSummary): string {
    const font = summary.fontName || 'the font';
    if (summary.glyphs === null) return `Update ${font}`;
    const parts: string[] = [];
    const glyphs = summary.glyphs;
    if (glyphs.length > MAX_NAMED_GLYPHS) {
        parts.push(`${glyphs.length} glyphs`);
    } else if (glyphs.length > 0) {
        parts.push(...glyphs);
    }
    if (summary.fontLevel) parts.push('font data');
    if (parts.length === 0) return `Update ${font}`;
    return `Edit ${joinNames(parts)} in ${font}`;
}
