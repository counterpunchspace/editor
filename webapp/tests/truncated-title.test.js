const { syncTruncatedTitle } = require('../js/ui/truncated-title');

function label(text, scrollWidth, clientWidth) {
    const element = document.createElement('span');
    element.textContent = text;
    Object.defineProperty(element, 'scrollWidth', { value: scrollWidth });
    Object.defineProperty(element, 'clientWidth', { value: clientWidth });
    return element;
}

describe('syncTruncatedTitle', () => {
    test('shows the full text while it is cut off', () => {
        const element = label('Spaces & Controls', 120, 80);
        syncTruncatedTitle(element);
        expect(element.title).toBe('Spaces & Controls');
    });

    test('drops the tooltip when the text fits', () => {
        const element = label('Marks', 40, 80);
        element.title = 'Marks';
        syncTruncatedTitle(element);
        expect(element.hasAttribute('title')).toBe(false);
    });
});
