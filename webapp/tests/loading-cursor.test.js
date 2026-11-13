// The busy cursor: the mouse pointer shows `progress` while work runs.

const { withLoadingCursor } = require('../js/loading-cursor');

const busy = () =>
    document.documentElement.classList.contains('loading-cursor');

describe('the busy cursor', () => {
    test('shows while work runs and goes when it ends', async () => {
        let during = false;
        await withLoadingCursor(async () => {
            during = busy();
        });
        expect(during).toBe(true);
        expect(busy()).toBe(false);
        expect(
            document.getElementById('loading-cursor-style').textContent
        ).toContain('cursor: progress !important');
    });

    test('goes when the work fails', async () => {
        await expect(
            withLoadingCursor(async () => {
                throw new Error('Couldn’t save');
            })
        ).rejects.toThrow('Couldn’t save');
        expect(busy()).toBe(false);
    });

    test('nested work keeps it until the outer work ends', async () => {
        let afterInner = false;
        await withLoadingCursor(async () => {
            await withLoadingCursor(async () => {});
            afterInner = busy();
        });
        expect(afterInner).toBe(true);
        expect(busy()).toBe(false);
    });
});
