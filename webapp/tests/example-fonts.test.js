const fs = require('fs');
const path = require('path');

jest.mock('../js/file-system-adapter', () => ({ OPFSAdapter: class {} }));

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
    const fonts = require('../js/example-fonts');
    const {
        MemoryPlugin
    } = require('../js/filesystem-plugins/plugins/memory-plugin');
    return { ...fonts, plugin: new MemoryPlugin() };
}

const target = (p, isDir = false) => ({
    path: p,
    name: p.split('/').pop(),
    isDir
});

describe('example fonts', () => {
    afterEach(() => {
        delete window.isTestMode;
        delete global.fetch;
    });

    test('the sample font, and folders holding it, cannot be deleted or renamed', async () => {
        const { loadExampleManifest, isExampleFontPath, plugin } = load(false);
        const entries = await loadExampleManifest();
        expect(entries.map((entry) => entry.destination)).toEqual([
            '/user/Fustat.glyphs'
        ]);

        expect(isExampleFontPath('/user/Fustat.glyphs')).toBe(true);
        expect(isExampleFontPath('/user')).toBe(true);
        expect(isExampleFontPath('/user/Mine.glyphs')).toBe(false);
        // Fixtures are only examples in test mode.
        expect(isExampleFontPath('/user/bbox.glyphs')).toBe(false);

        for (const action of ['delete', 'rename']) {
            expect(
                plugin.supportsFileContextAction(
                    action,
                    target('/user/Fustat.glyphs')
                )
            ).toBe(false);
            expect(
                plugin.supportsFileContextAction(action, target('/user', true))
            ).toBe(false);
            expect(
                plugin.supportsFileContextAction(
                    action,
                    target('/user/Mine.glyphs')
                )
            ).toBe(true);
        }
        expect(
            plugin.supportsFileContextAction(
                'open',
                target('/user/Fustat.glyphs')
            )
        ).toBe(true);
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
