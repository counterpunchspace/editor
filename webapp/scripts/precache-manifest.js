'use strict';

const crypto = require('crypto');

const SERVICE_WORKER_ASSET = 'coi-serviceworker.js';
const SHELL_ASSET = 'index.html';
const SHELL_URL = './';
// Must always come from the network: the cutover reads it to see what is live.
const BUILD_INFO_ASSET = 'build-info.json';

const EXCLUDED_ASSET_PATTERNS = [
    /\.map$/,
    /\.LICENSE\.txt$/,
    /^_headers(\/|$)/,
    /^build-info\.json$/,
    /^worktree-config\.json$/,
    /^debug-sw\.html$/,
    /^wasm-dist\//,
    /(^|\/)__pycache__\//,
    /^py\/debug_/,
    /^css\/tokens\.json$/,
    /(^|\/)\.DS_Store$/,
    /^assets\/screenshots\//,
    // Version-pinned; precached into the cache that survives app updates.
    /^pyodide\//,
    /^vendor\//,
    /(^|\/)README\.md$/,
    // Example sources are large and only opened on demand; the runtime
    // handler caches the ones a user opens.
    /^examples\/(?!examples-manifest\.json$)/
];

// Third-party files under vendor/<package>@<version>/ (vendor-libraries.js).
const VENDOR_URL_RE = /\bvendor\/[^/"'\s<>)]+@[^/"'\s<>)]+\/[^"'\s<>)]+/g;
const PINNED_ASSET_RE = /^pyodide\/v[^/]+\/[^/]+$/;

/** Same-origin files under a version-pinned path (the Pyodide core). */
function pinnedUrlsFromAssets(assetNames) {
    return assetNames
        .filter((name) => PINNED_ASSET_RE.test(name) && !/\.map$/.test(name))
        .map((name) => `./${name}`)
        .sort();
}

function isPrecachedAsset(name) {
    return !EXCLUDED_ASSET_PATTERNS.some((pattern) => pattern.test(name));
}

function precacheUrlsFromAssets(assetNames) {
    const urls = assetNames
        .filter((name) => name !== SHELL_ASSET && isPrecachedAsset(name))
        .map((name) => `./${name}`)
        .sort();
    return [SHELL_URL, ...urls];
}

/** The vendored files the page loads, precached with the Pyodide core. */
function vendorUrlsFromHtml(html) {
    return [...new Set(html.match(VENDOR_URL_RE) || [])]
        .map((url) => `./${url}`)
        .sort();
}

/**
 * Hash of every precached file's bytes. The worker script is excluded
 * because the id is written into it.
 */
function computeBuildId(assets) {
    const hash = crypto.createHash('sha256');
    for (const { name, content } of [...assets].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    )) {
        if (name === SERVICE_WORKER_ASSET) {
            continue;
        }
        hash.update(name);
        hash.update('\0');
        hash.update(content);
        hash.update('\0');
    }
    return hash.digest('hex').slice(0, 16);
}

function replacePlaceholder(source, placeholder, value) {
    const pattern = new RegExp(`(['"])${placeholder}\\1`);
    if (!pattern.test(source)) {
        throw new Error(
            `${SERVICE_WORKER_ASSET} is missing the ${placeholder} placeholder`
        );
    }
    return source.replace(pattern, () => value);
}

function injectManifest(source, { precacheUrls, cdnUrls, buildId }) {
    let result = replacePlaceholder(
        source,
        '__PRECACHE_ASSETS__',
        JSON.stringify(precacheUrls)
    );
    result = replacePlaceholder(
        result,
        '__CDN_PRECACHE__',
        JSON.stringify(cdnUrls)
    );
    return replacePlaceholder(result, '__BUILD_ID__', JSON.stringify(buildId));
}

module.exports = {
    SERVICE_WORKER_ASSET,
    SHELL_ASSET,
    BUILD_INFO_ASSET,
    isPrecachedAsset,
    precacheUrlsFromAssets,
    vendorUrlsFromHtml,
    pinnedUrlsFromAssets,
    computeBuildId,
    injectManifest
};
