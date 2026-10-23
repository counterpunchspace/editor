const fs = require('fs');
const path = require('path');

function parseHeadersFile(filePath) {
    const rules = [];
    let current = null;
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }
        if (line.startsWith(' ') || line.startsWith('\t')) {
            const separator = trimmed.indexOf(':');
            if (!current || separator === -1) {
                throw new Error(`Header line outside a rule: ${line}`);
            }
            current.headers.push(trimmed.slice(0, separator).trim());
            continue;
        }
        current = { pattern: trimmed, headers: [] };
        rules.push(current);
    }
    return rules;
}

function ruleMatches(pattern, requestPath) {
    const expression = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
    return new RegExp(`^${expression}$`).test(requestPath);
}

describe('webpack dev server config', () => {
    test('disables the client overlay for worker-safe bundles', () => {
        const config = require('../webpack.config.js');

        expect(config.devServer?.client?.overlay).toBe(false);
    });
});

describe('Pages isolation headers', () => {
    test('copies _headers as a file so Pages applies it', () => {
        const config = require('../webpack.config.js');
        const copyPlugin = config.plugins.find(
            (plugin) => plugin.constructor.name === 'CopyPlugin'
        );
        const pattern = copyPlugin.patterns.find(
            (entry) => entry.from === '_headers'
        );

        expect(pattern).toMatchObject({
            to: '_headers',
            toType: 'file'
        });
    });

    test('does not repeat a header on any one path', () => {
        const rules = parseHeadersFile(path.resolve(__dirname, '../_headers'));
        const probes = [
            '/index.html',
            '/js/fontc-worker.js',
            '/wasm-dist/babelfont_fontc_web_bg.wasm'
        ];

        for (const requestPath of probes) {
            const names = rules
                .filter((rule) => ruleMatches(rule.pattern, requestPath))
                .flatMap((rule) => rule.headers);
            expect(new Set(names).size).toBe(names.length);
        }
        expect(rules.some((rule) => rule.pattern === '/*')).toBe(true);
    });
});
