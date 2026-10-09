const fs = require('fs');
const path = require('path');

const SW_PATH = path.resolve(__dirname, '../coi-serviceworker.js');
const CSS_DIR = path.resolve(__dirname, '../css');
const JS_DIR = path.resolve(__dirname, '../build/js');
const WEBPACK_CONFIG_PATH = path.resolve(__dirname, '../webpack.config.js');
const JS_SOURCE_DIR = path.resolve(__dirname, '../js');
const PY_DIR = path.resolve(__dirname, '../py');
const DATA_DIR = path.resolve(__dirname, '../data');
const WHEELS_DIR = path.resolve(__dirname, '../wheels');

function parsePrecacheAssets(fileContent) {
    const match = fileContent.match(
        /const PRECACHE_ASSETS\s*=\s*\[([^\]]*?)\];/s
    );
    if (!match)
        throw new Error('Could not find PRECACHE_ASSETS in service worker');
    const items = [];
    const re = /['"]([^'"]+)['"]\s*,?\s*(?:\/\/.*)?$/gm;
    let m;
    while ((m = re.exec(match[1])) !== null) {
        items.push(m[1]);
    }
    return items;
}

function scanFiles(dir, prefix) {
    const files = [];
    function walk(d, relPrefix) {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) {
                walk(full, `${relPrefix}${entry.name}/`);
            } else if (entry.isFile()) {
                files.push(`${relPrefix}${entry.name}`);
            }
        }
    }
    walk(dir, prefix);
    return files.sort();
}

/**
 * Expected webpack JS outputs: entry names + webpackChunkName async chunks.
 * Prefer this over scanning build/js/, which can contain stale leftovers from
 * long-running webpack-dev-server sessions that still hold removed entries.
 */
function expectedWebpackJsBundles() {
    const webpackConfig = require(WEBPACK_CONFIG_PATH);
    const entryBundles = Object.keys(webpackConfig.entry || {}).map(
        (name) => `./js/${name}.js`
    );

    const chunkNames = new Set();
    function walkSource(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walkSource(full);
                continue;
            }
            if (!entry.isFile() || !/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
                continue;
            }
            const source = fs.readFileSync(full, 'utf8');
            const re = /webpackChunkName:\s*["']([^"']+)["']/g;
            let match;
            while ((match = re.exec(source)) !== null) {
                chunkNames.add(match[1]);
            }
        }
    }
    walkSource(JS_SOURCE_DIR);

    return [
        ...entryBundles,
        ...[...chunkNames].map((name) => `./js/${name}.js`)
    ].sort();
}

describe('COI ServiceWorker PRECACHE_ASSETS', () => {
    let precacheAssets;
    let expectedJsBundles;

    beforeAll(() => {
        const swContent = fs.readFileSync(SW_PATH, 'utf-8');
        precacheAssets = parsePrecacheAssets(swContent);
        expectedJsBundles = expectedWebpackJsBundles();
    });

    test('includes every CSS file in the css/ directory', () => {
        const cssFiles = scanFiles(CSS_DIR, './css/').filter((f) =>
            f.endsWith('.css')
        );
        const missing = cssFiles.filter((f) => !precacheAssets.includes(f));
        if (missing.length) {
            console.log(
                'Missing from PRECACHE_ASSETS:\n' +
                    missing.map((f) => "    '" + f + "',").join('\n')
            );
        }
        expect(missing).toEqual([]);
    });

    test('includes every webpack JS entry and async chunk', () => {
        const missing = expectedJsBundles.filter(
            (f) => !precacheAssets.includes(f)
        );
        if (missing.length) {
            console.log(
                'Missing from PRECACHE_ASSETS:\n' +
                    missing.map((f) => "    '" + f + "',").join('\n')
            );
        }
        expect(missing).toEqual([]);
    });

    test('no orphaned CSS entries in PRECACHE_ASSETS', () => {
        const cssFiles = scanFiles(CSS_DIR, './css/').filter((f) =>
            f.endsWith('.css')
        );
        const precacheCss = precacheAssets.filter(
            (f) => f.startsWith('./css/') && f.endsWith('.css')
        );
        const orphaned = precacheCss.filter((f) => !cssFiles.includes(f));
        if (orphaned.length) {
            console.log(
                'Orphaned in PRECACHE_ASSETS (file no longer exists):\n' +
                    orphaned.map((f) => "    '" + f + "',").join('\n')
            );
        }
        expect(orphaned).toEqual([]);
    });

    test('no orphaned JS entries in PRECACHE_ASSETS', () => {
        const precacheJs = precacheAssets.filter(
            (f) => f.startsWith('./js/') && f.endsWith('.js')
        );
        const orphaned = precacheJs.filter(
            (f) => !expectedJsBundles.includes(f)
        );
        if (orphaned.length) {
            console.log(
                'Orphaned in PRECACHE_ASSETS (not a current webpack output):\n' +
                    orphaned.map((f) => "    '" + f + "',").join('\n')
            );
        }
        expect(orphaned).toEqual([]);
    });

    test('expected webpack JS bundles exist in build/js when present', () => {
        if (!fs.existsSync(JS_DIR)) {
            return;
        }
        const missingOnDisk = expectedJsBundles.filter(
            (f) => !fs.existsSync(path.join(JS_DIR, path.basename(f)))
        );
        expect(missingOnDisk).toEqual([]);
    });

    test('includes every runtime Python file in py/', () => {
        const pyFiles = scanFiles(PY_DIR, './py/').filter(
            (f) => f.endsWith('.py') && !f.includes('/debug_')
        );
        const missing = pyFiles.filter((f) => !precacheAssets.includes(f));
        if (missing.length) {
            console.log(
                'Missing from PRECACHE_ASSETS:\n' +
                    missing.map((f) => "    '" + f + "',").join('\n')
            );
        }
        expect(missing).toEqual([]);
    });

    test('includes glyph-data catalog and every shipped wheel', () => {
        const required = ['./data/glyph-data.json.gz'];
        if (fs.existsSync(DATA_DIR)) {
            required.push(
                ...scanFiles(DATA_DIR, './data/').filter((f) =>
                    f.endsWith('.json.gz')
                )
            );
        }
        if (fs.existsSync(WHEELS_DIR)) {
            required.push(...scanFiles(WHEELS_DIR, './wheels/'));
        }
        const missing = [...new Set(required)].filter(
            (f) => !precacheAssets.includes(f)
        );
        if (missing.length) {
            console.log(
                'Missing from PRECACHE_ASSETS:\n' +
                    missing.map((f) => "    '" + f + "',").join('\n')
            );
        }
        expect(missing).toEqual([]);
    });

    test('no orphaned Python entries in PRECACHE_ASSETS', () => {
        const pyFiles = fs.existsSync(PY_DIR)
            ? scanFiles(PY_DIR, './py/').filter((f) => f.endsWith('.py'))
            : [];
        const precachePy = precacheAssets.filter(
            (f) => f.startsWith('./py/') && f.endsWith('.py')
        );
        const orphaned = precachePy.filter((f) => !pyFiles.includes(f));
        expect(orphaned).toEqual([]);
    });

    test('replacement install calls skipWaiting so a waiting worker can activate', () => {
        const swContent = fs.readFileSync(SW_PATH, 'utf-8');
        const installBlock = swContent.match(
            /self\.addEventListener\(\s*'install'[\s\S]*?self\.addEventListener\(\s*'activate'/
        );
        expect(installBlock).not.toBeNull();
        expect(installBlock[0]).toMatch(/skipWaiting\s*\(/);
        expect(swContent).toMatch(/['"]SKIP_WAITING['"]/);
        expect(swContent).toMatch(/includeUncontrolled:\s*true/);
    });

    test('skips COI reload when a service worker is already controlling', () => {
        const swContent = fs.readFileSync(SW_PATH, 'utf-8');
        expect(swContent).toMatch(
            /Service worker activated while already controlling - skipping reload/
        );
        const activateReload = swContent.match(
            /Case 2: SW is still installing[\s\S]*?registration\.installing\.addEventListener/
        );
        expect(activateReload).not.toBeNull();
        expect(swContent).toMatch(
            /if \(navigator\.serviceWorker\.controller\)/
        );
        expect(swContent).toMatch(
            /SharedArrayBuffer already available - skipping reload/
        );
        expect(swContent).toMatch(/Browser is offline - skipping reload/);
    });
});
