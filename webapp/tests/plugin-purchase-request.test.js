const {
    requestPluginPurchase
} = require('../js/font-destination-plugin-ui.ts');

function jsonResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    };
}

describe('plugin purchase request', () => {
    afterEach(() => {
        delete global.fetch;
    });

    test('a dropped purchase response is paid when the store already recorded it', async () => {
        global.fetch = jest
            .fn()
            .mockResolvedValueOnce(jsonResponse({ status: 'none' }))
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValueOnce(
                jsonResponse({
                    status: 'paid',
                    invoicePdf: 'https://example.test/invoice.pdf'
                })
            );

        await expect(
            requestPluginPurchase('counterpunch-harakat', 1190)
        ).resolves.toEqual({
            outcome: 'paid',
            invoicePdf: 'https://example.test/invoice.pdf',
            hostedInvoiceUrl: undefined
        });
        expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    test('a failed purchase fetch is unreachable when the purchase was not recorded', async () => {
        global.fetch = jest
            .fn()
            .mockResolvedValueOnce(jsonResponse({ status: 'none' }))
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockRejectedValueOnce(new TypeError('Failed to fetch'));

        await expect(
            requestPluginPurchase('counterpunch-harakat', 1190)
        ).resolves.toEqual({ outcome: 'unreachable' });
    });

    test('an already paid plugin is not charged again', async () => {
        global.fetch = jest.fn().mockResolvedValueOnce(
            jsonResponse({
                status: 'paid',
                invoicePdf: 'https://example.test/invoice.pdf'
            })
        );

        await expect(
            requestPluginPurchase('counterpunch-harakat', 1190)
        ).resolves.toEqual({
            outcome: 'paid',
            invoicePdf: 'https://example.test/invoice.pdf',
            hostedInvoiceUrl: undefined
        });
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(global.fetch.mock.calls[0][1]).toEqual({
            credentials: 'include'
        });
    });
});
