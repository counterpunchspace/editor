const fs = require('fs');
const path = require('path');

const manifest = JSON.parse(
    fs.readFileSync(
        path.join(__dirname, '../examples/examples-manifest.json'),
        'utf8'
    )
);

function load(testMode) {
    jest.resetModules();
    window.isTestMode = () => testMode;
    global.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => manifest
    }));
    return require('../js/example-fonts');
}

describe('example fonts', () => {
    afterEach(() => {
        delete window.isTestMode;
        delete global.fetch;
    });

    test('the sample font, and folders holding it, are example fonts', async () => {
        const { loadExampleManifest, isExampleFontPath } = load(false);
        const entries = await loadExampleManifest();
        expect(entries.map((entry) => entry.destination)).toEqual([
            '/user/Fustat.glyphs'
        ]);

        expect(isExampleFontPath('/user/Fustat.glyphs')).toBe(true);
        expect(isExampleFontPath('/user')).toBe(true);
        expect(isExampleFontPath('/user/Mine.glyphs')).toBe(false);
        // Fixtures are only examples in test mode.
        expect(isExampleFontPath('/user/bbox.glyphs')).toBe(false);
    });

    test('in test mode, files inside example packages are protected too', async () => {
        const { loadExampleManifest, isExampleFontPath } = load(true);
        await loadExampleManifest();
        expect(
            isExampleFontPath(
                '/user/YanoneKaffeesatz.glyphspackage/glyphs/a.glyph'
            )
        ).toBe(true);
        expect(isExampleFontPath('/user/bbox.glyphs')).toBe(true);
    });
});
