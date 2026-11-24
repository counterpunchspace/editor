/**
 * A failed compile worker packet is shown once: when it fails
 * (trackWorkerForward), not again by the committed-change refresh that
 * awaits the same packet.
 */

const {
    logRefreshFailure,
    trackWorkerForward
} = require('../js/change-bridge-init');
const { fullFontCompilation } = require('../js/font-compilation');
const { sidebarErrorDisplay } = require('../js/sidebar-error-display');

describe('a failed worker forward is reported once', () => {
    let originalShowError;
    let showError;
    let originalConsoleError;

    beforeEach(() => {
        originalShowError = sidebarErrorDisplay.showError;
        showError = jest.fn();
        sidebarErrorDisplay.showError = showError;
        originalConsoleError = console.error;
        console.error = jest.fn();
        jest.spyOn(
            fullFontCompilation,
            'setWorkerCacheDocumentReady'
        ).mockImplementation(() => {});
    });

    afterEach(() => {
        sidebarErrorDisplay.showError = originalShowError;
        console.error = originalConsoleError;
        jest.restoreAllMocks();
    });

    test('the refresh awaiting the forward does not show it again', async () => {
        const failure = new Error('worker refused the packet');
        const tracked = trackWorkerForward(
            Promise.reject(failure),
            'Failed to forward a Yjs update to the compile worker'
        );
        // The refresh still sees the rejection, so it stops.
        await expect(tracked).rejects.toBe(failure);
        await tracked.catch(logRefreshFailure);

        expect(showError).toHaveBeenCalledTimes(1);
        expect(showError.mock.calls[0][0]).toBe(failure);
        expect(
            fullFontCompilation.setWorkerCacheDocumentReady
        ).toHaveBeenCalledWith(false);
    });

    test('a rejection that is not an object is reported once too', async () => {
        const tracked = trackWorkerForward(
            Promise.reject('worker gone'),
            'Failed to forward a Yjs update to the compile worker'
        );
        let seen;
        await tracked.catch((error) => {
            seen = error;
            logRefreshFailure(error);
        });
        expect(seen).toBeInstanceOf(Error);
        expect(seen.message).toBe('worker gone');
        expect(showError).toHaveBeenCalledTimes(1);
    });

    test('a refresh failure of its own is still shown', () => {
        const failure = new Error('compile failed');
        logRefreshFailure(failure);
        expect(showError).toHaveBeenCalledTimes(1);
        expect(showError.mock.calls[0][0]).toBe(failure);
    });

    test('a forward that succeeds reports nothing', async () => {
        await trackWorkerForward(Promise.resolve(true), 'unused');
        expect(showError).not.toHaveBeenCalled();
    });
});
