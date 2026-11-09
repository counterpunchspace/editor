'use strict';

// Third-party browser libraries the editor loads as plain <script> and
// <link> tags. They come from npm (exact versions in package.json) and ship
// with the app under a version-pinned path, `vendor/<package>@<version>/`,
// so the editor never depends on a CDN.

const fs = require('fs');
const path = require('path');

const NODE_MODULES = path.resolve(__dirname, '..', 'node_modules');

/** Files (or whole folders, ending in `/`) each package ships. */
const VENDOR_LIBRARIES = {
    'jquery': ['dist/jquery.min.js'],
    'jquery.terminal': [
        'js/jquery.terminal.min.js',
        'js/unix_formatting.js',
        'css/jquery.terminal.min.css'
    ],
    // hb.js loads hb.wasm from its own folder.
    'harfbuzzjs': ['hb.js', 'hbjs.js', 'hb.wasm'],
    // Ace loads modes, themes and extensions on demand from its folder.
    'ace-builds': ['src-min-noconflict/'],
    'diff': ['dist/diff.min.js'],
    'diff2html': [
        'bundles/js/diff2html-ui.min.js',
        'bundles/css/diff2html.min.css'
    ],
    'marked': ['marked.min.js']
};

function packageDir(name) {
    return path.join(NODE_MODULES, name);
}

function packageVersion(name) {
    return JSON.parse(
        fs.readFileSync(path.join(packageDir(name), 'package.json'), 'utf8')
    ).version;
}

/** `vendor/<package>@<version>` for a vendored package. */
function vendorDir(name) {
    if (!(name in VENDOR_LIBRARIES)) {
        throw new Error(`${name} is not a vendored library`);
    }
    return `vendor/${name}@${packageVersion(name)}`;
}

/** Page-relative URL of one vendored file, for index.html. */
function vendorUrl(name, file) {
    const files = VENDOR_LIBRARIES[name] || [];
    const shipped = files.some((entry) =>
        entry.endsWith('/') ? file.startsWith(entry) : entry === file
    );
    if (!shipped) {
        throw new Error(`${name}/${file} is not a vendored file`);
    }
    return `${vendorDir(name)}/${file}`;
}

/** copy-webpack-plugin patterns for every vendored file. */
function vendorCopyPatterns() {
    return Object.entries(VENDOR_LIBRARIES).flatMap(([name, files]) =>
        files.map((file) => ({
            from: path.join(packageDir(name), file),
            to: `${vendorDir(name)}/${file}`,
            toType: file.endsWith('/') ? 'dir' : 'file',
            // Ship upstream bytes; never re-minify third-party code.
            info: { minimized: true },
            globOptions: { ignore: ['**/*.map'] }
        }))
    );
}

module.exports = {
    VENDOR_LIBRARIES,
    vendorDir,
    vendorUrl,
    vendorCopyPatterns
};
