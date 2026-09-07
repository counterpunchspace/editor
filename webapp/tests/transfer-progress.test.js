/**
 * @jest-environment jsdom
 */

const {
    TransferCancelledError,
    isTransferCancelled,
    runWithTransferProgress
} = require('../js/ui/transfer-progress.ts');

describe('transfer progress dialog', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    test('shows a message and determinate progress, then closes', async () => {
        const result = await runWithTransferProgress({
            kind: 'load',
            message: 'Loading font…',
            total: 4,
            work: async (session) => {
                expect(
                    document.querySelector('.transfer-progress-overlay')
                ).toBeTruthy();
                session.update({ completed: 2 });
                const bar = document.querySelector('.transfer-progress-bar');
                expect(bar.value).toBe(2);
                expect(bar.max).toBe(4);
                expect(
                    document.querySelector('.transfer-progress-message')
                        .textContent
                ).toContain('2 of 4');
                return 'ok';
            }
        });
        expect(result).toBe('ok');
        expect(document.querySelector('.transfer-progress-overlay')).toBeNull();
    });

    test('cancel button aborts work and rejects as cancelled', async () => {
        const started = runWithTransferProgress({
            kind: 'seed',
            message: 'Uploading font to cloud…',
            total: 10,
            work: (session) =>
                new Promise((resolve, reject) => {
                    session.signal.addEventListener('abort', () => {
                        reject(session.signal.reason);
                    });
                })
        });
        await Promise.resolve();
        const cancel = document.querySelector('[data-action="cancel"]');
        expect(cancel).toBeTruthy();
        cancel.click();
        await expect(started).rejects.toBeInstanceOf(TransferCancelledError);
        expect(isTransferCancelled(new TransferCancelledError())).toBe(true);
        expect(document.querySelector('.transfer-progress-overlay')).toBeNull();
    });
});
