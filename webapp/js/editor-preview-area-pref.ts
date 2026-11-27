/**
 * Preference: how much chrome Space preview hides, and which rectangle the
 * dotted viewport guide follows. Default small.
 */

import {
    getPreviewArea,
    parsePreviewArea,
    setPreviewAreaPreference,
    type PreviewArea
} from './window-ui-state';

export { getPreviewArea, parsePreviewArea, type PreviewArea };

export function setPreviewArea(area: PreviewArea): void {
    const next = parsePreviewArea(area);
    setPreviewAreaPreference(next);
    window.dispatchEvent(
        new CustomEvent('editorPreviewAreaChanged', {
            detail: { area: next }
        })
    );
}
