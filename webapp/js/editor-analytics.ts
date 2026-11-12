/**
 * A few cookie-free usage events from the live editor, through the
 * website's Plausible proxy, so the campaign funnel shows what happens
 * between opening the editor and signing up (website docs/CAMPAIGNS.md).
 * Plausible counts without cookies or identifiers, and nothing is stored on
 * the device. Only editor.counterpunch.space reports; every other host,
 * local and test runs included, stays silent.
 */

import { getCampaignTags } from './campaign-tags';
import { resolveWebsiteURL } from './website-url';

const LIVE_HOST = 'editor.counterpunch.space';
const PLAUSIBLE_SITE = 'counterpunch.space';

export function trackEditorEvent(
    name: string,
    props: Record<string, string> = {}
): void {
    if (window.location.hostname !== LIVE_HOST) return;
    const tags = getCampaignTags();
    const query = new URLSearchParams(tags).toString();
    // The tags in the address let Plausible credit a new visit to the
    // campaign, as on the website.
    const url = `https://${LIVE_HOST}${window.location.pathname}${query ? `?${query}` : ''}`;
    void fetch(`${resolveWebsiteURL()}/api/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        keepalive: true,
        body: JSON.stringify({
            name,
            url,
            domain: PLAUSIBLE_SITE,
            props: { ...tags, ...props }
        })
    }).catch(() => {});
}
