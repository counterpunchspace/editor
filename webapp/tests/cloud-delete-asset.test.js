jest.mock('../js/cloud-website-api', () => ({
    getCloudRequestHeaders: (extra = {}) => ({ ...extra })
}));

const { deleteCloudAssetUntilComplete } = require('../js/cloud-delete-asset');

const json = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
});

const base = {
    websiteBaseUrl: 'https://site.test',
    assetId: 'a/1',
    sleep: async () => {}
};

describe('deleteCloudAssetUntilComplete', () => {
    test('keeps polling past any fixed call count until the server says complete', async () => {
        let calls = 0;
        const fetchImpl = jest.fn(async () => {
            calls += 1;
            return json({ complete: calls >= 700 });
        });
        await deleteCloudAssetUntilComplete({ ...base, fetchImpl });
        expect(calls).toBe(700);
        expect(fetchImpl.mock.calls[0][0]).toBe(
            'https://site.test/api/cloud/assets/a%2F1'
        );
        expect(fetchImpl.mock.calls[0][1].method).toBe('DELETE');
    });

    test('throws on a server error', async () => {
        const fetchImpl = jest.fn(async () => json({ error: 'nope' }, 403));
        await expect(
            deleteCloudAssetUntilComplete({ ...base, fetchImpl })
        ).rejects.toThrow('nope');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    test('survives transient transport failures but not a run of them', async () => {
        let calls = 0;
        const flaky = jest.fn(async () => {
            calls += 1;
            if (calls <= 2) throw new Error('offline');
            return json({ complete: true });
        });
        await deleteCloudAssetUntilComplete({ ...base, fetchImpl: flaky });
        const dead = jest.fn(async () => {
            throw new Error('offline');
        });
        await expect(
            deleteCloudAssetUntilComplete({ ...base, fetchImpl: dead })
        ).rejects.toThrow('offline');
        expect(dead).toHaveBeenCalledTimes(5);
    });

    test('stops when the time budget is spent', async () => {
        let t = 0;
        const fetchImpl = jest.fn(async () => json({ complete: false }));
        await expect(
            deleteCloudAssetUntilComplete({
                ...base,
                fetchImpl,
                maxMs: 1000,
                now: () => (t += 100)
            })
        ).rejects.toThrow('still running');
    });
});
