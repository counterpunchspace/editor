// The marketplace security review reads developer-docs/PLUGIN_REVIEW_MAP.md
// to find its way through the editor. A stale path or symbol sends it to
// code that no longer exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const map = readFileSync(
    join(root, 'developer-docs/PLUGIN_REVIEW_MAP.md'),
    'utf8'
);
const contracts = JSON.parse(
    readFileSync(join(root, 'plugin-contracts/contracts.json'), 'utf8')
);

function section(title) {
    const start = map.indexOf(`## ${title}\n`);
    assert.ok(start >= 0, `missing section ${title}`);
    const rest = map.slice(start + title.length + 4);
    const end = rest.indexOf('\n## ');
    return end < 0 ? rest : rest.slice(0, end);
}

function rows(title) {
    const list = section(title)
        .split('\n')
        .filter((line) => line.startsWith('| `'))
        .map((line) =>
            line
                .slice(1, -1)
                .split('|')
                .map((cell) =>
                    [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1])
                )
        );
    assert.ok(list.length > 0, `section ${title} has no rows`);
    return list;
}

function assertSymbols(path, symbols) {
    const text = readFileSync(join(root, path), 'utf8');
    for (const symbol of symbols) {
        assert.match(
            text,
            new RegExp(`\\b${symbol}\\b`),
            `${symbol} not found in ${path}`
        );
    }
}

test('every listed spec exists', () => {
    for (const [[path]] of rows('Specs')) {
        assert.ok(existsSync(join(root, path)), `${path} is missing`);
    }
});

test('install paths and symbols exist', () => {
    for (const [[path], symbols] of rows('Install and load')) {
        assert.ok(existsSync(join(root, path)), `${path} is missing`);
        assertSymbols(path, symbols);
    }
});

test('host call sites match the contracts', () => {
    const groups = new Map(
        contracts.types.map((entry) => [entry.type, entry.group])
    );
    const mapped = new Set();
    for (const [[type], [group], [path], symbols] of rows('Host call sites')) {
        assert.equal(groups.get(type), group, `${type} has the wrong group`);
        assert.ok(existsSync(join(root, path)), `${path} is missing`);
        assertSymbols(path, symbols);
        mapped.add(type);
    }
    for (const type of groups.keys()) {
        assert.ok(mapped.has(type), `plugin type ${type} has no host row`);
    }
});

test('Python API paths and symbols exist', () => {
    for (const [[path], symbols] of rows('Python API')) {
        assert.ok(existsSync(join(root, path)), `${path} is missing`);
        assertSymbols(path, symbols);
    }
});

test('settings registry exists', () => {
    assertSymbols('webapp/js/plugin-settings/plugin-settings-registry.ts', [
        'PluginSettingsRegistry'
    ]);
});
