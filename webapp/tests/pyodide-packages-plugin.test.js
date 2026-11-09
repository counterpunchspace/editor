const fs = require('fs');
const path = require('path');
const {
    bundledPackagePaths,
    rewriteLock
} = require('../scripts/pyodide-packages-plugin');

const PYODIDE_DIR = path.dirname(require.resolve('pyodide/package.json'));
const lock = JSON.parse(
    fs.readFileSync(path.join(PYODIDE_DIR, 'pyodide-lock.json'), 'utf8')
);
const version = JSON.parse(
    fs.readFileSync(path.join(PYODIDE_DIR, 'package.json'), 'utf8')
).version;

describe('bundled Pyodide packages', () => {
    const paths = bundledPackagePaths(lock);

    test('ship micropip next to the core and on-demand packages with their dependencies', () => {
        expect(paths.get('micropip')).toBe(lock.packages.micropip.file_name);
        for (const name of ['numpy', 'pandas', 'matplotlib']) {
            expect(paths.get(name)).toBe(
                `packages/${lock.packages[name].file_name}`
            );
            for (const dependency of lock.packages[name].depends) {
                expect(paths.has(dependency)).toBe(true);
            }
        }
    });

    test('the lock points bundled packages at local files and the rest at the Pyodide release', () => {
        const rewritten = rewriteLock(lock, version, paths);
        expect(rewritten.packages.numpy.file_name).toBe(paths.get('numpy'));
        expect(rewritten.packages.numpy.sha256).toBe(
            lock.packages.numpy.sha256
        );
        const external = Object.keys(lock.packages).find(
            (name) => !paths.has(name)
        );
        expect(rewritten.packages[external].file_name).toBe(
            `https://cdn.jsdelivr.net/pyodide/v${version}/full/${lock.packages[external].file_name}`
        );
        expect(Object.keys(rewritten.packages)).toEqual(
            Object.keys(lock.packages)
        );
    });
});
