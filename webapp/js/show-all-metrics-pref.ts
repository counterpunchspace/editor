/**
 * Preference: draw OS/2 / hhea / typo metric lines in edit mode.
 * Default false — opt in via Editing View → View menu → Show All Metrics.
 */

import {
    isShowAllMetricsEnabled,
    setShowAllMetricsEnabled as writeShowAllMetrics
} from './window-ui-state';

export { isShowAllMetricsEnabled };

export function setShowAllMetricsEnabled(enabled: boolean): void {
    writeShowAllMetrics(enabled);
    window.dispatchEvent(
        new CustomEvent('showAllMetricsChanged', {
            detail: { enabled }
        })
    );
}

export function toggleShowAllMetricsEnabled(): boolean {
    const next = !isShowAllMetricsEnabled();
    setShowAllMetricsEnabled(next);
    return next;
}
