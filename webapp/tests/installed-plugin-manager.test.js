const {
    comparePluginVersions,
    installedVersionFromFilename,
    pluginAction
} = require('../js/installed-plugin-manager.ts');

describe('installed plugin manager', () => {
    test('parses an installed wheel version from its filename', () => {
        expect(
            installedVersionFromFilename('example-plugin', [
                '/Plugins/example_plugin-1.2.3-py3-none-any.whl'
            ])
        ).toBe('1.2.3');
    });

    test('offers update only when the catalog version is newer', () => {
        const plugin = {
            package: 'example-plugin',
            kind: 'free',
            name: 'Example',
            description: '',
            priceCents: 0,
            currency: 'eur',
            version: '1.2.0',
            filename: 'example_plugin-1.2.0-py3-none-any.whl',
            sha256: 'abc',
            releaseNotes: null,
            purchased: false,
            types: [
                { type: 'canvas', contract: 'canvas:v1', pluginId: 'example' }
            ]
        };
        expect(
            pluginAction({ plugin, installedVersion: '1.1.0', signedIn: true })
        ).toBe('update');
        expect(comparePluginVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    });

    test('asks a signed-out user to sign in before buying', () => {
        const plugin = {
            package: 'paid-plugin',
            kind: 'commercial',
            name: 'Paid',
            description: '',
            priceCents: 500,
            currency: 'eur',
            version: '1.0.0',
            filename: null,
            sha256: null,
            releaseNotes: null,
            purchased: false,
            types: [{ type: 'canvas', contract: 'canvas:v1', pluginId: 'paid' }]
        };
        expect(
            pluginAction({ plugin, installedVersion: null, signedIn: false })
        ).toBe('sign-in');
    });
});
