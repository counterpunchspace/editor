jest.mock('tippy.js', () => ({
    __esModule: true,
    default: jest.fn()
}));
jest.mock('tippy.js/dist/tippy.css', () => ({}), { virtual: true });

describe('assistantErrorMessage', () => {
    let assistantErrorMessage;

    beforeAll(() => {
        ({ assistantErrorMessage } = require('../js/ai-assistant'));
    });

    test('uses a string error as-is', () => {
        expect(
            assistantErrorMessage({ error: 'Insufficient credits' }, 402)
        ).toBe('Insufficient credits');
    });

    test('reads the message from an OpenRouter-style error object', () => {
        const body = {
            error: { message: 'Missing Authentication header', code: 401 }
        };
        expect(assistantErrorMessage(body, 401)).toBe(
            'Missing Authentication header'
        );
    });

    test('falls back to a top-level message', () => {
        expect(
            assistantErrorMessage(
                { error: 'Internal server error', message: 'boom' },
                500
            )
        ).toBe('Internal server error');
        expect(assistantErrorMessage({ message: 'boom' }, 500)).toBe('boom');
    });

    test('never returns [object Object]', () => {
        expect(assistantErrorMessage({ error: { code: 500 } }, 500)).toBe(
            'Request failed (HTTP 500)'
        );
        expect(assistantErrorMessage(null)).toBe('Request failed');
        expect(
            assistantErrorMessage({ type: 'error' }, undefined, 'Stream error')
        ).toBe('Stream error');
    });
});
