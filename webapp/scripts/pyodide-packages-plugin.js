'use strict';

// Ships the Pyodide packages the editor uses with the app, so Python starts
// and the on-demand packages install without a CDN.
//
// The wheels are downloaded once at build time from the Pyodide release,
// checked against the sha256 in pyodide-lock.json, and cached under
// node_modules/.cache. The build then emits them next to the Pyodide core
// together with a rewritten pyodide-lock.json: bundled packages point at
// the local files, every other package keeps its address in the official
// Pyodide release (only reached if a script installs such a package).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sources, Compilation } = require('webpack');

const PLUGIN_NAME = 'PyodidePackagesPlugin';

/** Loaded on every start; next to the core so it is precached. */
const BOOT_PACKAGES = ['micropip'];
/** Installed when a script imports them (python-package-lazy-loader.ts). */
const ON_DEMAND_PACKAGES = ['numpy', 'pandas', 'matplotlib'];
/** Folder under the Pyodide core for on-demand packages (not precached). */
const ON_DEMAND_DIR = 'packages';

function releaseUrl(version) {
    return `https://cdn.jsdelivr.net/pyodide/v${version}/full/`;
}

/** The packages and everything they depend on, from the lock file. */
function withDependencies(lockPackages, names) {
    const result = new Set();
    const visit = (name) => {
        if (result.has(name)) {
            return;
        }
        const entry = lockPackages[name];
        if (!entry) {
            throw new Error(
                `${PLUGIN_NAME}: no "${name}" in pyodide-lock.json`
            );
        }
        result.add(name);
        for (const dependency of entry.depends || []) {
            visit(dependency);
        }
    };
    names.forEach(visit);
    return result;
}

/** Bundled package name → path relative to the Pyodide core folder. */
function bundledPackagePaths(lock) {
    const boot = withDependencies(lock.packages, BOOT_PACKAGES);
    const onDemand = withDependencies(lock.packages, ON_DEMAND_PACKAGES);
    const paths = new Map();
    for (const name of boot) {
        paths.set(name, lock.packages[name].file_name);
    }
    for (const name of onDemand) {
        if (!paths.has(name)) {
            paths.set(
                name,
                `${ON_DEMAND_DIR}/${lock.packages[name].file_name}`
            );
        }
    }
    return paths;
}

/** pyodide-lock.json with bundled packages local and the rest absolute. */
function rewriteLock(lock, version, paths) {
    const packages = {};
    for (const [name, entry] of Object.entries(lock.packages)) {
        packages[name] = {
            ...entry,
            file_name: paths.has(name)
                ? paths.get(name)
                : releaseUrl(version) + entry.file_name
        };
    }
    return { ...lock, packages };
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function download(url, attempts = 4) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return Buffer.from(await response.arrayBuffer());
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
        }
    }
    throw new Error(
        `${PLUGIN_NAME}: downloading ${url} failed: ${lastError?.cause?.message || lastError?.message}`
    );
}

async function readOrDownload(cacheDir, version, entry) {
    const cachePath = path.join(cacheDir, entry.file_name);
    if (fs.existsSync(cachePath)) {
        const cached = fs.readFileSync(cachePath);
        if (sha256(cached) === entry.sha256) {
            return cached;
        }
    }
    const url = releaseUrl(version) + entry.file_name;
    const buffer = await download(url);
    if (sha256(buffer) !== entry.sha256) {
        throw new Error(
            `${PLUGIN_NAME}: ${entry.file_name} does not match the sha256 in pyodide-lock.json`
        );
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachePath, buffer);
    return buffer;
}

class PyodidePackagesPlugin {
    /**
     * @param {{ pyodideDir: string, version: string, outputDir: string,
     *   cacheDir: string }} options
     */
    constructor(options) {
        this.options = options;
        this.loaded = null;
    }

    async load() {
        if (!this.loaded) {
            this.loaded = (async () => {
                const { pyodideDir, version, cacheDir } = this.options;
                const lock = JSON.parse(
                    fs.readFileSync(
                        path.join(pyodideDir, 'pyodide-lock.json'),
                        'utf8'
                    )
                );
                const paths = bundledPackagePaths(lock);
                const files = await Promise.all(
                    [...paths].map(async ([name, relativePath]) => ({
                        relativePath,
                        buffer: await readOrDownload(
                            cacheDir,
                            version,
                            lock.packages[name]
                        )
                    }))
                );
                const rewrittenLock = JSON.stringify(
                    rewriteLock(lock, version, paths)
                );
                return { files, rewrittenLock };
            })();
            this.loaded.catch(() => {
                this.loaded = null;
            });
        }
        return this.loaded;
    }

    apply(compiler) {
        compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
            compilation.hooks.processAssets.tapPromise(
                {
                    name: PLUGIN_NAME,
                    stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL
                },
                async () => {
                    const { outputDir } = this.options;
                    const { files, rewrittenLock } = await this.load();
                    for (const { relativePath, buffer } of files) {
                        compilation.emitAsset(
                            `${outputDir}/${relativePath}`,
                            new sources.RawSource(buffer),
                            { minimized: true }
                        );
                    }
                    compilation.emitAsset(
                        `${outputDir}/pyodide-lock.json`,
                        new sources.RawSource(rewrittenLock),
                        { minimized: true }
                    );
                }
            );
        });
    }
}

module.exports = {
    PyodidePackagesPlugin,
    bundledPackagePaths,
    rewriteLock,
    BOOT_PACKAGES,
    ON_DEMAND_PACKAGES
};
