/**
 * `?tour=1` (the website’s “Take the tour” link) starts the tour as soon as
 * the font is ready, without the welcome modal, the Settings Folder prompt
 * or the tour intro. None of them is marked as seen, so a later normal
 * start offers them as usual.
 */

import { formatUrl } from './url-state';

const TOUR_LINK_PARAM = 'tour';

let launchedFromLink: boolean | null = null;

/** True for this page load when it was opened with `?tour=1`. */
export function isTourLinkLaunch(): boolean {
    if (launchedFromLink === null) {
        launchedFromLink =
            new URLSearchParams(window.location.search).get(TOUR_LINK_PARAM) ===
            '1';
    }
    return launchedFromLink;
}

/** Drop `tour` from the address, so a reload does not start it again. */
export function clearTourLinkParam(): void {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(TOUR_LINK_PARAM)) {
        return;
    }
    url.searchParams.delete(TOUR_LINK_PARAM);
    window.history.replaceState(window.history.state, '', formatUrl(url));
}
