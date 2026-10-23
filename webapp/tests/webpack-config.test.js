describe('webpack dev server config', () => {
    test('disables the client overlay for worker-safe bundles', () => {
        const config = require('../webpack.config.js');

        expect(config.devServer?.client?.overlay).toBe(false);
    });
});
