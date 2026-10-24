const fs = require('fs');
const path = require('path');
const {
    precacheUrlsFromAssets,
    cdnUrlsFromHtml,
    computeBuildId,
    injectManifest
} = require('../scripts/precache-manifest');

const SW_PATH = path.resolve(__dirname, '../coi-serviceworker.js');
const INDEX_PATH = path.resolve(__dirname, '../index.html');

function readWorkerSource() {
    return fs.readFileSync(SW_PATH, 'utf-8');
}

describe('precache manifest', () => {
    test('lists shipped files with the shell first and skips build-only files', () => {
        const urls = precacheUrlsFromAssets([
            'index.html',
            'js/bootstrap.js',
            'js/bootstrap.js.map',
            'js/bootstrap.js.LICENSE.txt',
            'js/482.3f9a1c.js',
            'ded5c720768338babd75.wasm',
            'coi-serviceworker.js',
            'css/style.css',
            'handbook/manifest.json',
            'handbook/python/01-intro.md',
            'examples/examples-manifest.json',
            'examples/Fustat.glyphs',
            'assets/screenshots/browser.png',
            'assets/icons/README.md',
            'assets/fonts/Inter.woff2',
            'wasm-dist/babelfont_fontc_web_bg.wasm',
            '_headers',
            'build-info.json',
            'worktree-config.json'
        ]);
        expect(urls).toEqual([
            './',
            './assets/fonts/Inter.woff2',
            './coi-serviceworker.js',
            './css/style.css',
            './ded5c720768338babd75.wasm',
            './examples/examples-manifest.json',
            './handbook/manifest.json',
            './handbook/python/01-intro.md',
            './js/482.3f9a1c.js',
            './js/bootstrap.js'
        ]);
    });

    test('collects every CDN URL from index.html plus the Pyodide core files', () => {
        const html = fs
            .readFileSync(INDEX_PATH, 'utf-8')
            .replace(
                /<%= htmlWebpackPlugin\.options\.cdnBase %>/g,
                'https://cdn.jsdelivr.net'
            );
        const urls = cdnUrlsFromHtml(html);
        const scriptSrcs = [
            ...html.matchAll(
                /(?:src|href)="(https:\/\/cdn\.jsdelivr\.net\/[^"]+)"/g
            )
        ].map((match) => match[1]);

        expect(scriptSrcs.length).toBeGreaterThan(0);
        for (const src of scriptSrcs) {
            expect(urls).toContain(src);
        }
        const pyodideScript = scriptSrcs.find((src) =>
            /\/pyodide\/[^/]+\/full\/pyodide\.js$/.test(src)
        );
        expect(pyodideScript).toBeDefined();
        const base = pyodideScript.replace(/pyodide\.js$/, '');
        expect(urls).toEqual(
            expect.arrayContaining([
                base + 'pyodide.asm.mjs',
                base + 'pyodide.asm.wasm',
                base + 'python_stdlib.zip',
                base + 'pyodide-lock.json'
            ])
        );
        expect(new Set(urls).size).toBe(urls.length);
    });

    test('build id follows file contents but ignores the worker itself', () => {
        const assets = [
            { name: 'js/bootstrap.js', content: Buffer.from('a') },
            { name: 'coi-serviceworker.js', content: Buffer.from('x') }
        ];
        const id = computeBuildId(assets);
        expect(id).toMatch(/^[0-9a-f]{16}$/);
        expect(
            computeBuildId([
                assets[0],
                { name: 'coi-serviceworker.js', content: Buffer.from('y') }
            ])
        ).toBe(id);
        expect(
            computeBuildId([
                { name: 'js/bootstrap.js', content: Buffer.from('b') },
                assets[1]
            ])
        ).not.toBe(id);
    });

    test('injects into both source and minified worker text', () => {
        const manifest = {
            precacheUrls: ['./', './js/bootstrap.js'],
            cdnUrls: [
                'https://cdn.jsdelivr.net/npm/marked@11.1.1/marked.min.js'
            ],
            buildId: '0123456789abcdef'
        };
        const injected = injectManifest(readWorkerSource(), manifest);
        expect(injected).toContain(
            `const PRECACHE_ASSETS = ${JSON.stringify(manifest.precacheUrls)};`
        );
        expect(injected).toContain(
            `const CDN_PRECACHE = ${JSON.stringify(manifest.cdnUrls)};`
        );
        expect(injected).toContain(`const BUILD_ID = "0123456789abcdef";`);

        const minified =
            'const VERSION="v1",BUILD_ID="__BUILD_ID__",PRECACHE_ASSETS="__PRECACHE_ASSETS__",CDN_PRECACHE="__CDN_PRECACHE__";';
        expect(injectManifest(minified, manifest)).toBe(
            `const VERSION="v1",BUILD_ID="0123456789abcdef",PRECACHE_ASSETS=${JSON.stringify(manifest.precacheUrls)},CDN_PRECACHE=${JSON.stringify(manifest.cdnUrls)};`
        );
        expect(() => injectManifest('const VERSION = "v1";', manifest)).toThrow(
            /__PRECACHE_ASSETS__/
        );
    });
});

describe('COI service worker fetch routing', () => {
    test('leaves build-info.json to the network before any cache lookup', () => {
        const swContent = readWorkerSource();
        const fetchListener = swContent.match(
            /self\.addEventListener\('fetch'[\s\S]*?event\.respondWith\(handleAsset\(request\)\);/
        );
        expect(fetchListener).not.toBeNull();
        const buildInfoBypass = fetchListener[0].indexOf(
            'requestUrl.pathname === buildInfoUrl'
        );
        expect(buildInfoBypass).toBeGreaterThan(-1);
        expect(buildInfoBypass).toBeLessThan(
            fetchListener[0].indexOf('handleNavigation(request)')
        );
        expect(swContent).toMatch(
            /const buildInfoUrl = new URL\('\.\/build-info\.json', self\.location\.href\)\.href;/
        );
    });
});

describe('COI service worker lifecycle', () => {
    test('a new worker waits for SKIP_WAITING instead of activating on install', () => {
        const swContent = readWorkerSource();
        const installBlock = swContent.match(
            /self\.addEventListener\(\s*'install'[\s\S]*?self\.addEventListener\(\s*'activate'/
        );
        expect(installBlock).not.toBeNull();
        expect(installBlock[0]).not.toMatch(/skipWaiting\s*\(/);
        expect(swContent).toMatch(
            /ev\.data\.type === 'SKIP_WAITING'\) \{\s*self\.skipWaiting\(\);/
        );
        expect(swContent).toMatch(/includeUncontrolled:\s*true/);
    });

    test('skips COI reload when a service worker is already controlling', () => {
        const swContent = readWorkerSource();
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
