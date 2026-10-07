const { isMissingFileError } = require('../js/script-editor.ts');
const { missingFontUrlAction } = require('../js/file-browser.ts');

describe('startup console noise', () => {
    test('a missing settings script is not a watcher error', () => {
        const error = new Error('not found');
        error.name = 'NotFoundError';
        expect(isMissingFileError(error)).toBe(true);
        expect(isMissingFileError(new Error('disk full'))).toBe(false);
    });

    test('a missing memory URL font opens the default font instead of alerting', () => {
        expect(missingFontUrlAction('memory')).toBe('default-font');
        expect(missingFontUrlAction('disk')).toBe('alert');
    });
});
