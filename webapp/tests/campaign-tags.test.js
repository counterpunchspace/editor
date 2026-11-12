/**
 * Campaign tags from website links: read from the address (so reloads keep
 * them), or from the windows that opened this one, and carried back to the
 * website.
 */

jest.mock('../js/editor-analytics', () => ({ trackEditorEvent: jest.fn() }));

function load() {
    let mod;
    jest.isolateModules(() => {
        mod = require('../js/campaign-tags');
    });
    return mod;
}

function setOpener(value) {
    Object.defineProperty(window, 'opener', { configurable: true, value });
}

describe('campaign tags', () => {
    const opener = window.opener;

    afterEach(() => {
        window.history.replaceState(null, '', '/');
        setOpener(opener);
        delete window.campaignTags;
    });

    it('reads the tags from the address and leaves it as it is', () => {
        const address =
            '/index.html?file=memory:///user/Fustat.glyphs&text=h%C3%ABllo%20x&utm_source=instagram&utm_medium=paid&utm_campaign=reels&utm_content=reel-03';
        window.history.replaceState(null, '', address);
        const { getCampaignTags, campaignQuery } = load();
        expect(getCampaignTags()).toEqual({
            utm_source: 'instagram',
            utm_medium: 'paid',
            utm_campaign: 'reels',
            utm_content: 'reel-03'
        });
        expect(window.location.pathname + window.location.search).toBe(address);
        expect(campaignQuery()).toBe(
            '?utm_source=instagram&utm_medium=paid&utm_campaign=reels&utm_content=reel-03'
        );
    });

    it('follows openers up to the window that has the tags', () => {
        const launcher = {
            campaignTags: {
                get: () => ({ utm_campaign: 'reels', utm_source: 'tiktok' })
            }
        };
        // A linked window: its opener is a font window without tags of its
        // own, whose opener is the launcher.
        const fontWindow = {
            campaignTags: {
                get: (hops) => (hops > 0 ? launcher.campaignTags.get() : {})
            }
        };
        setOpener(fontWindow);
        const { getCampaignTags } = load();
        expect(getCampaignTags()).toEqual({
            utm_campaign: 'reels',
            utm_source: 'tiktok'
        });
    });

    it('marks website links as coming from the editor, and leaves them alone without a campaign', () => {
        window.history.replaceState(null, '', '/launcher.html');
        let mod = load();
        expect(mod.withCampaignTags('https://counterpunch.space/account')).toBe(
            'https://counterpunch.space/account'
        );

        window.history.replaceState(
            null,
            '',
            '/launcher.html?utm_campaign=reels&utm_content=reel-03'
        );
        mod = load();
        expect(
            mod.withCampaignTags(
                'https://counterpunch.space/account/payment?return=editor'
            )
        ).toBe(
            'https://counterpunch.space/account/payment?return=editor&utm_campaign=reels&utm_content=reel-03&cp_from=editor'
        );
        expect(mod.withCampaignTags('/account')).toBe('/account');
    });
});
