/**
 * Preference: scroll the glyph overview when the editing glyph stack changes.
 * Default on — toggle via Editing View → View menu.
 */

import {
    isOverviewFollowEnabled,
    setOverviewFollowEnabled
} from './window-ui-state';

export { isOverviewFollowEnabled as isOverviewFollowStackScrollEnabled };

export function setOverviewFollowStackScrollEnabled(enabled: boolean): void {
    setOverviewFollowEnabled(enabled);
    window.dispatchEvent(
        new CustomEvent('overviewFollowStackScrollChanged', {
            detail: { enabled }
        })
    );
}

export function toggleOverviewFollowStackScrollEnabled(): boolean {
    const next = !isOverviewFollowEnabled();
    setOverviewFollowStackScrollEnabled(next);
    return next;
}
