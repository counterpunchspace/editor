const path = require('path');
const fs = require('fs');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const UnusedWebpackPlugin = require('unused-webpack-plugin');
const webpack = require('webpack');
const { execSync } = require('child_process');

class GenerateDocsManifestPlugin {
    apply(compiler) {
        const generate = () => {
            execSync('node ../scripts/generate-documentation-manifest.mjs', {
                cwd: __dirname,
                stdio: 'inherit'
            });
        };
        const documentationSourcesChanged = (watchingCompiler) => {
            const changed = new Set([
                ...(watchingCompiler.modifiedFiles || []),
                ...(watchingCompiler.removedFiles || [])
            ]);
            if (changed.size === 0) {
                return true;
            }
            for (const file of changed) {
                const normalized = String(file).replace(/\\/g, '/');
                if (
                    normalized.includes('/documentation/') &&
                    !normalized.endsWith('/documentation/manifest.json')
                ) {
                    return true;
                }
            }
            return false;
        };

        compiler.hooks.beforeRun.tap('GenerateDocsManifestPlugin', generate);
        compiler.hooks.watchRun.tap(
            'GenerateDocsManifestPlugin',
            (watchingCompiler) => {
                if (documentationSourcesChanged(watchingCompiler)) {
                    generate();
                }
            }
        );
    }
}

// Get version from environment variable, package.json, or default to development
const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')
);
const EDITOR_VERSION =
    process.env.EDITOR_VERSION || packageJson.version + '-dev';

// Read dev server port from worktree-config.json (always present, set by
// worktree/create or defaults to 8000 in the main checkout).
const WORKTREE_CONFIG_PATH = path.join(__dirname, 'worktree-config.json');
let worktreeConfig;
try {
    worktreeConfig = JSON.parse(fs.readFileSync(WORKTREE_CONFIG_PATH, 'utf8'));
} catch (_e) {
    console.error(
        `[Worktree] Missing or invalid ${WORKTREE_CONFIG_PATH}, defaulting to 8000`
    );
    worktreeConfig = { port: 8000 };
}
const DEV_PORT = worktreeConfig.port;
const LOCAL_HTTPS_CERTIFICATE_DIRECTORY = path.join(__dirname, '.local-certs');
const LOCAL_HTTPS_CERTIFICATE_PATH = path.join(
    LOCAL_HTTPS_CERTIFICATE_DIRECTORY,
    'localhost.pem'
);
const LOCAL_HTTPS_KEY_PATH = path.join(
    LOCAL_HTTPS_CERTIFICATE_DIRECTORY,
    'localhost-key.pem'
);
const LOCAL_HTTPS_OPTIONS =
    fs.existsSync(LOCAL_HTTPS_CERTIFICATE_PATH) &&
    fs.existsSync(LOCAL_HTTPS_KEY_PATH)
        ? {
              cert: fs.readFileSync(LOCAL_HTTPS_CERTIFICATE_PATH),
              key: fs.readFileSync(LOCAL_HTTPS_KEY_PATH)
          }
        : undefined;

const resolveGitCommit = () => {
    if (process.env.BUILD_HASH_FULL) {
        return process.env.BUILD_HASH_FULL;
    }

    try {
        return execSync('git rev-parse HEAD', {
            cwd: path.resolve(__dirname, '..'),
            stdio: ['ignore', 'pipe', 'ignore']
        })
            .toString()
            .trim();
    } catch (_error) {
        return 'dev-unknown';
    }
};

const BUILD_HASH_FULL = resolveGitCommit();
const BUILD_HASH_SHORT =
    process.env.BUILD_HASH_SHORT || BUILD_HASH_FULL.substring(0, 12);

const isProductionBuild = process.env.NODE_ENV === 'production';

module.exports = {
    mode: isProductionBuild ? 'production' : 'development',
    devtool: 'source-map',
    optimization: {
        // Minify even in `webpack serve` so the ~1.2MB development bundle is
        // not parsed/eval'd as a giant unminified script on every reload.
        minimize: true
    },
    entry: {
        'bootstrap': './js/bootstrap.ts',
        'fontc-worker': './js/fontc-worker.ts',
        'glyph-overview': './js/glyph-overview.ts',
        'find-glyph-dialog': './js/find-glyph-dialog.ts',
        'translations': './js/translations.ts',
        'overview-view': './js/overview-view.ts'
    },
    output: {
        path: path.resolve(__dirname, 'build'),
        filename: 'js/[name].js',
        clean: true
    },
    plugins: [
        new UnusedWebpackPlugin({
            directories: [path.join(__dirname, 'js')],
            exclude: [
                '*.test.js',
                '*.d.ts',
                'change-bridge*.ts',
                'change-log.ts',
                'window-sync.ts',
                'window-buttons.ts',
                'ui/property-slider-widget.ts'
            ],
            root: __dirname
        }),
        new GenerateDocsManifestPlugin(),
        new HtmlWebpackPlugin({
            template: './index.html',
            inject: 'body',
            scriptLoading: 'blocking',
            chunks: ['bootstrap']
        }),
        new webpack.DefinePlugin({
            'process.env.EDITOR_VERSION': JSON.stringify(EDITOR_VERSION),
            'process.env.BUILD_HASH_FULL': JSON.stringify(BUILD_HASH_FULL),
            'process.env.BUILD_HASH_SHORT': JSON.stringify(BUILD_HASH_SHORT)
        }),
        new CopyWebpackPlugin({
            patterns: [
                { from: 'css', to: 'css' },
                { from: 'assets', to: 'assets' },
                { from: 'wasm-dist', to: 'wasm-dist' },
                { from: 'coi-serviceworker.js', to: 'coi-serviceworker.js' },
                {
                    from: 'font-destination-bridge.html',
                    to: 'font-destination-bridge.html'
                },
                { from: 'manifest.json', to: 'manifest.json' },
                { from: 'examples', to: 'examples' },
                { from: 'py', to: 'py' },
                { from: 'wheels', to: 'wheels' },
                { from: 'data', to: 'data' },
                { from: '_headers', to: '_headers' },
                {
                    from: 'worktree-config.json',
                    to: 'worktree-config.json',
                    noErrorOnMissing: true
                },
                // Handbook documentation for the Agent's tool execution
                {
                    from: path.resolve(__dirname, '../documentation'),
                    to: 'handbook'
                },
                // API.md for the Agent's python_api_docs tool
                {
                    from: path.resolve(__dirname, '../API.md'),
                    to: 'API.md',
                    noErrorOnMissing: true
                }
            ]
        })
    ],
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: 'ts-loader',
                exclude: /node_modules/
            },
            {
                test: /\.js$/,
                exclude: /node_modules/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        presets: ['@babel/preset-env']
                    }
                }
            },
            {
                test: /\.css$/,
                use: ['style-loader', 'css-loader']
            }
        ]
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.js']
    },
    watchOptions: {
        ignored: ['**/documentation/manifest.json', '**/webapp/build/**']
    },
    devServer: {
        static: [
            {
                directory: path.join(__dirname, 'build'),
                // Don't watch the build directory - it's webpack's own output
                watch: false
            }
        ],
        port: DEV_PORT,
        server: {
            type: 'https',
            options: LOCAL_HTTPS_OPTIONS
        },
        hot: false,
        liveReload: false,
        client: {
            // The webpack runtime overlay touches `window`, which breaks
            // worker-executed bundles and any shared entry loaded outside the
            // browser main thread.
            overlay: false,
            webSocketURL: {
                hostname: 'localhost',
                pathname: '/ws',
                port: DEV_PORT,
                protocol: 'wss'
            }
        },
        headers: {
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Resource-Policy': 'cross-origin'
        },
        devMiddleware: {
            writeToDisk: true
        },
        setupMiddlewares: (middlewares, devServer) => {
            // Watch tokens.json and regenerate tokens.css on change
            const chokidar = require('chokidar');
            const tokensPath = path.join(__dirname, 'css/tokens.json');
            const watcher = chokidar.watch(tokensPath);

            watcher.on('change', () => {
                console.log('[Tokens] tokens.json changed, regenerating...');
                try {
                    execSync('node scripts/generate-css-tokens.js', {
                        cwd: __dirname,
                        stdio: 'inherit'
                    });
                } catch (e) {
                    console.error('[Tokens] Failed to regenerate:', e.message);
                }
            });

            // Cleanup on server shutdown
            process.on('SIGINT', async () => {
                console.log('\n[Webpack] Shutting down gracefully...');
                await watcher.close();
                process.exit(0);
            });

            return middlewares;
        }
    }
};
