const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const entryPoints = {
    'ai-assistant': './js/ai-assistant.js',
    'auto-compile-manager': './js/auto-compile-manager.js',
    'bidi-js': './js/bidi-js.js',
    'cache-manager': './js/cache-manager.js',
    'compile-button': './js/compile-button.js',
    'design': './js/design.js',
    'example-loader': './js/example-loader.js',
    'file-browser': './js/file-browser.js',
    'font-compilation': './js/font-compilation.js',
    'font-dropdown': './js/font-dropdown.js',
    'font-interpolation': './js/font-interpolation.ts',
    'font-manager': './js/font-manager.js',
    'fontc-worker': './js/fontc-worker.ts',
    'fonteditor': './js/fonteditor.js',
    'glyph-canvas': './js/glyph-canvas.js',
    'keyboard-navigation': './js/keyboard-navigation.js',
    'layer-data-normalizer': './js/layer-data-normalizer.js',
    'loading-animation': './js/loading-animation.js',
    'matplotlib-handler': './js/matplotlib-handler.js',
    'memory-monitor': './js/memory-monitor.js',
    'pyodide-official-console': './js/pyodide-official-console.js',
    'python-execution-wrapper': './js/python-execution-wrapper.js',
    'python-ui-sync': './js/python-ui-sync.js',
    'resizer': './js/resizer.js',
    'save-button': './js/save-button.js',
    'script-editor': './js/script-editor.js',
    'settings': './js/settings.js',
    'sound-preloader': './js/sound-preloader.js',
    'tab-lifecycle': './js/tab-lifecycle.js',
    'theme-switcher': './js/theme-switcher.js',
    'view-settings': './js/view-settings.js'
};

module.exports = {
    mode: 'development',
    entry: entryPoints,
    output: {
        path: path.resolve(__dirname, 'build'),
        filename: 'js/[name].js',
        clean: true
    },
    plugins: [
        new HtmlWebpackPlugin({
            template: './index.html',
            inject: false
        }),
        new CopyWebpackPlugin({
            patterns: [
                { from: 'css', to: 'css' },
                { from: 'assets', to: 'assets' },
                { from: 'wasm-dist', to: 'wasm-dist' },
                { from: 'coi-serviceworker.js', to: 'coi-serviceworker.js' },
                { from: 'manifest.json', to: 'manifest.json' },
                { from: 'examples', to: 'examples' },
                { from: 'py', to: 'py' },
                { from: 'wheels', to: 'wheels' },
                { from: '_headers', to: '_headers' }
            ]
        })
    ],
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: 'ts-loader',
                exclude: /node_modules/
            }
        ]
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.js']
    },
    devServer: {
        static: {
            directory: path.join(__dirname, 'build')
        },
        port: 8000,
        headers: {
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Resource-Policy': 'cross-origin'
        }
    }
};
