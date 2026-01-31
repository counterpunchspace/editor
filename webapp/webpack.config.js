const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const UnusedWebpackPlugin = require('unused-webpack-plugin');
const { execSync } = require('child_process');

module.exports = {
    mode: 'development',
    entry: {
        'bootstrap': './js/bootstrap.ts',
        'fontc-worker': './js/fontc-worker.ts',
        'glyph-overview': './js/glyph-overview.ts'
    },
    output: {
        path: path.resolve(__dirname, 'build'),
        filename: 'js/[name].js',
        clean: true
    },
    plugins: [
        new UnusedWebpackPlugin({
            directories: [path.join(__dirname, 'js')],
            exclude: ['*.test.js', '*.d.ts'],
            root: __dirname
        }),
        new HtmlWebpackPlugin({
            template: './index.html',
            inject: 'body',
            chunks: ['bootstrap']
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
                { from: '_headers', to: '_headers' },
                {
                    from: 'js/chat-session-manager.js',
                    to: 'js/chat-session-manager.js'
                },
                {
                    from: 'js/translations.js',
                    to: 'js/translations.js'
                },
                {
                    from: 'js/overview-view.js',
                    to: 'js/overview-view.js'
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
    devServer: {
        static: [
            {
                directory: path.join(__dirname, 'build')
            },
            {
                directory: __dirname,
                publicPath: '/'
            }
        ],
        port: 8000,
        server: 'https',
        hot: process.env.PLAYWRIGHT_TEST !== 'true',
        liveReload: process.env.PLAYWRIGHT_TEST !== 'true',
        client: {
            overlay: process.env.PLAYWRIGHT_TEST !== 'true',
            webSocketURL: {
                hostname: 'localhost',
                pathname: '/ws',
                port: 8000,
                protocol: 'wss'
            },
            // Disable reconnect during tests to prevent reload loops
            reconnect: process.env.PLAYWRIGHT_TEST !== 'true'
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
