// The busy cursor: shows our own cursor spinner while work runs,
// without forcing the browser's system progress pointer.

const { withLoadingCursor } = require('../js/loading-cursor');

const busy = () =>
    document.documentElement.classList.contains('loading-cursor');

const spinnerDisplay = () =>
    document.getElementById('loading-cursor-spinner')?.style.display ?? null;

describe('the busy cursor', () => {
    test('shows while work runs and goes when it ends', async () => {
        let during = false;
        let displayDuring = null;
        await withLoadingCursor(async () => {
            during = busy();
            displayDuring = spinnerDisplay();
        });
        expect(during).toBe(true);
        expect(displayDuring).toBe('block');
        expect(busy()).toBe(false);
        expect(spinnerDisplay()).toBe('none');
        expect(document.getElementById('loading-cursor-style')).toBeNull();
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
