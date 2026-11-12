/**
 * Campaign tags (utm_*) that the website adds to its editor links. They are
 * never stored on the device: they stay in the address, so reloads keep
 * them, and windows without them ask the window that opened them. The
 * sign-in code request sends them, so an account created here is credited
 * to the ad or post that brought the visitor (website
 * utils/campaign-attribution.js).
 */

import { trackEditorEvent } from './editor-analytics';

const CAMPAIGN_KEYS = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_content',
    'utm_term'
];
const MAX_TAG_LENGTH = 150;
// launcher → font window → linked window, with room to spare.
const MAX_OPENER_HOPS = 4;

export type CampaignTags = Record<string, string>;

function tagsInAddress(): CampaignTags {
    const params = new URLSearchParams(window.location.search);
    const found: CampaignTags = {};
    for (const key of CAMPAIGN_KEYS) {
        const value = params.get(key);
        if (value) found[key] = value.slice(0, MAX_TAG_LENGTH);
    }
    return found;
}

function campaignTagsFrom(hops: number): CampaignTags {
    const own = tagsInAddress();
    if (Object.keys(own).length || hops <= 0) return own;
    try {
        // window.opener is typed `any` in lib.dom; narrow it to a window.
        const opener: Window | null = window.opener;
        return opener?.campaignTags?.get(hops - 1) ?? {};
    } catch {
        // An opener on another origin can't be read.
        return {};
    }
}

export function getCampaignTags(): CampaignTags {
    return campaignTagsFrom(MAX_OPENER_HOPS);
}

/**
 * A website address with this visit's campaign tags, marked as coming from
 * the editor, so the website's statistics keep the campaign without asking
 * for consent again.
 */
export function withCampaignTags(url: string): string {
    trackWebsiteLink(url);
    const tags = getCampaignTags();
    if (!Object.keys(tags).length) return url;
    let target: URL;
    try {
        target = new URL(url);
    } catch {
        return url;
    }
    for (const [key, value] of Object.entries(tags)) {
        target.searchParams.set(key, value);
    }
    target.searchParams.set('cp_from', 'editor');
    return target.toString();
}

function trackWebsiteLink(url: string): void {
    let path = url;
    try {
        path = new URL(url).pathname;
    } catch {
        // Keep the address as given.
    }
    trackEditorEvent('Website link opened', { to: path });
}

/** The tags as a query string, for this origin's own pages. */
export function campaignQuery(): string {
    const tags = getCampaignTags();
    return Object.keys(tags).length
        ? `?${new URLSearchParams(tags).toString()}`
        : '';
}

window.campaignTags = { get: (hops = 0) => campaignTagsFrom(hops) };
