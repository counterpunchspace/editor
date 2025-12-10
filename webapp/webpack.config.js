const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
    mode: 'development',
    entry: {
        'bootstrap': './js/bootstrap.ts',
        'fontc-worker': './js/fontc-worker.ts'
    },
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
        server: 'https',
        headers: {
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Resource-Policy': 'cross-origin'
        }
    }
};
