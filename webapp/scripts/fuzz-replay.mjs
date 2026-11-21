#!/usr/bin/env node
/**
 * Replay a cloud fuzz seed locally, the way the nightly runs it: against a
 * production build, not the dev server (which drops lazy chunks after a
 * rebuild), with the local website and room stack.
 *
 *   npm run fuzz:replay -- --seed 538333895 [--stop-at 29] [--steps 40]
 *                          [--no-build] [--port 9100]
 *
 * Builds into the system temp folder, serves it over https with the
 * isolation headers the editor needs (an http page would not send the
 * website's session cookie), and runs tests/cloud-collab-fuzz.spec.ts. On a
 * failure every window's collaboration trace is in test-results.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webappRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
);
const workRoot = path.join(os.tmpdir(), 'counterpunch-fuzz-replay');
const buildDir = path.join(workRoot, 'build');
const certDir = path.join(workRoot, 'cert');

function parseArgs(argv) {
    const options = { build: true, port: 9100 };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = () => {
            const next = argv[++index];
            if (next === undefined) {
                throw new Error(`${arg} needs a value`);
            }
            return next;
        };
        if (arg === '--seed') options.seed = value();
        else if (arg === '--stop-at') options.stopAt = value();
        else if (arg === '--steps') options.steps = value();
        else if (arg === '--port') options.port = Number(value());
        else if (arg === '--no-build') options.build = false;
        else throw new Error(`Unknown option ${arg}`);
    }
    if (!options.seed) {
        throw new Error('--seed is required (the number the nightly names)');
    }
    return options;
}

function build() {
    console.log(`[fuzz-replay] building into ${buildDir}`);
    fs.rmSync(buildDir, { recursive: true, force: true });
    const result = spawnSync('npx', ['webpack', '--output-path', buildDir], {
        cwd: webappRoot,
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'production' }
    });
    if (result.status !== 0) {
        throw new Error('webpack build failed');
    }
}

function ensureCert() {
    const cert = path.join(certDir, 'cert.pem');
    const key = path.join(certDir, 'key.pem');
    if (!fs.existsSync(cert) || !fs.existsSync(key)) {
        fs.mkdirSync(certDir, { recursive: true });
        execFileSync(
            'openssl',
            [
                'req',
                '-x509',
                '-newkey',
                'rsa:2048',
                '-sha256',
                '-nodes',
                '-days',
                '30',
                '-keyout',
                key,
                '-out',
                cert,
                '-subj',
                '/CN=localhost'
            ],
            { stdio: 'ignore' }
        );
    }
    return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
}

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.whl': 'application/zip',
    '.zip': 'application/zip',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json'
};

function serve(port) {
    const root = path.resolve(buildDir);
    const server = https.createServer(ensureCert(), (request, response) => {
        const url = new URL(request.url, 'https://localhost');
        let file = path.join(root, decodeURIComponent(url.pathname));
        if (!file.startsWith(root)) {
            response.writeHead(403).end();
            return;
        }
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
            file = path.join(file, 'index.html');
        }
        if (!fs.existsSync(file)) {
            file = path.join(root, 'index.html');
        }
        response.writeHead(200, {
            'Content-Type':
                CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
            // The editor needs SharedArrayBuffer, like the dev server gives it.
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Cache-Control': 'no-store'
        });
        fs.createReadStream(file).pipe(response);
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => resolve(server));
    });
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.build || !fs.existsSync(path.join(buildDir, 'index.html'))) {
        build();
    }
    const server = await serve(options.port);
    const editorUrl = `https://localhost:${options.port}`;
    console.log(
        `[fuzz-replay] seed ${options.seed} against ${editorUrl}${options.stopAt ? `, stop at ${options.stopAt}` : ''}`
    );
    const child = spawn(
        'npx',
        [
            'playwright',
            'test',
            '--project=cloud-collab-fuzz',
            '--reporter=list'
        ],
        {
            cwd: webappRoot,
            stdio: 'inherit',
            env: {
                ...process.env,
                CLOUD_COLLAB_FUZZ: '1',
                CLOUD_COLLAB_E2E: '1',
                CLOUD_E2E_EDITOR_URL: editorUrl,
                FUZZ_SEED: String(options.seed),
                ...(options.stopAt
                    ? { FUZZ_STOP_AT: String(options.stopAt) }
                    : {}),
                ...(options.steps ? { FUZZ_STEPS: String(options.steps) } : {})
            }
        }
    );
    const code = await new Promise((resolve) => child.on('exit', resolve));
    server.close();
    process.exit(code ?? 1);
}

main().catch((error) => {
    console.error(`[fuzz-replay] ${error.message}`);
    process.exit(1);
});
