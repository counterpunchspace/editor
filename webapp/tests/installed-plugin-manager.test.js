const {
    comparePluginVersions,
    installedVersionFromFilename,
    pluginAction,
    revokedWheelPaths
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
        expect(
            pluginAction({
                plugin: { ...plugin, priceState: 'payment_method' },
                installedVersion: null,
                signedIn: true
            })
        ).toBe('payment-method');
        expect(
            pluginAction({
                plugin: { ...plugin, priceState: 'ready', grossCents: 595 },
                installedVersion: null,
                signedIn: true
            })
        ).toBe('buy');
    });

    test('selects a refunded wheel and leaves an owned wheel', () => {
        const paths = [
            '/Plugins/counterpunch_harakat-0.1.18-py3-none-any.whl',
            '/Plugins/example_plugin-1.0.0-py3-none-any.whl'
        ];
        expect(
            revokedWheelPaths(
                { revoked: ['counterpunch-harakat'], blocked: [] },
                paths
            )
        ).toEqual([paths[0]]);
        expect(revokedWheelPaths({ revoked: [], blocked: [] }, paths)).toEqual(
            []
        );
    });
});
