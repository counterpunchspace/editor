describe('babelfont-model worker-safe imports', () => {
    test('imports without window or document for glyph filter worker use', () => {
        const originalWindow = global.window;
        const originalDocument = global.document;

        delete global.window;
        delete global.document;

        try {
            expect(() => {
                jest.isolateModules(() => {
                    require('../js/babelfont-model');
                });
            }).not.toThrow();
        } finally {
            if (typeof originalWindow === 'undefined') {
                delete global.window;
            } else {
                global.window = originalWindow;
            }

            if (typeof originalDocument === 'undefined') {
                delete global.document;
            } else {
                global.document = originalDocument;
            }
        }
    });
});
