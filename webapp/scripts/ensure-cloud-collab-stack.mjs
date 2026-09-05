import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const webappRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
);
const editorRoot = path.resolve(webappRoot, '..');

export const CLOUD_COLLAB_PERSIST_ROOT = path.join(
    webappRoot,
    '.cloud-collab-e2e-wrangler'
);
export const CLOUD_COLLAB_PID_FILE = path.join(
    CLOUD_COLLAB_PERSIST_ROOT,
    'pids.json'
);

export function resolveWebsiteRoot() {
    if (process.env.WEBSITE_ROOT) {
        return path.resolve(process.env.WEBSITE_ROOT);
    }
    const siblings = [
        path.resolve(editorRoot, '..', 'website'),
        path.resolve(editorRoot, '_cloud_e2e', 'website'),
        path.resolve(webappRoot, '..', '..', 'website')
    ];
    return siblings.find((candidate) =>
        fs.existsSync(path.join(candidate, 'package.json'))
    );
}

export function resolveCollabRoot() {
    if (process.env.COLLAB_ROOT) {
        return path.resolve(process.env.COLLAB_ROOT);
    }
    const siblings = [
        path.resolve(editorRoot, '..', 'collab', 'collab'),
        path.resolve(editorRoot, '..', 'collab'),
        path.resolve(editorRoot, '_cloud_e2e', 'collab', 'collab'),
        path.resolve(editorRoot, '_cloud_e2e', 'collab'),
        path.resolve(webappRoot, '..', '..', 'collab', 'collab')
    ];
    return siblings.find((candidate) =>
        fs.existsSync(path.join(candidate, 'workers', 'room', 'wrangler.toml'))
    );
}

export function isPortOpen(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host });
        socket.once('connect', () => {
            socket.end();
            resolve(true);
        });
        socket.once('error', () => resolve(false));
    });
}

export async function waitForPort(port, label, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isPortOpen(port)) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for ${label} on port ${port}`);
}

function spawnLogged(command, args, options) {
    const child = spawn(command, args, {
        ...options,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const logPath = options.logPath;
    const stream = fs.createWriteStream(logPath, { flags: 'a' });
    child.stdout?.pipe(stream);
    child.stderr?.pipe(stream);
    child.on('exit', () => stream.end());
    return child;
}

export function localCloudEnv() {
    return {
        ...process.env,
        LOCAL_DEV: 'true',
        LOCAL_CLOUD_DEV_ENABLED: 'true',
        AUTH_TOKEN_ALLOW_INSECURE_LOCAL_FALLBACK: 'true',
        EDITOR_ALLOWED_ORIGINS: 'https://localhost:8000,http://localhost:9000',
        WEBSITE_ALLOWED_ORIGINS:
            'https://localhost:8000,http://localhost:9000,https://localhost:8788',
        MAGIC_LINK_SECRET:
            process.env.MAGIC_LINK_SECRET || 'e2e-cloud-collab-magic',
        ROOM_WORKER_URL: 'http://localhost:8787'
    };
}

export async function ensureCloudCollabStack() {
    const persistRoot = CLOUD_COLLAB_PERSIST_ROOT;
    fs.mkdirSync(path.join(persistRoot, 'website'), { recursive: true });
    fs.mkdirSync(path.join(persistRoot, 'collab'), { recursive: true });

    const websiteRoot = resolveWebsiteRoot();
    const collabRoot = resolveCollabRoot();
    if (!websiteRoot) {
        throw new Error(
            'WEBSITE_ROOT not found. Set WEBSITE_ROOT to the website repo.'
        );
    }
    if (!collabRoot) {
        throw new Error(
            'COLLAB_ROOT not found. Set COLLAB_ROOT to the collab repo (workers/room).'
        );
    }

    const websiteUp = await isPortOpen(8788);
    const roomUp = await isPortOpen(8787);
    const spawned = [];

    if (!websiteUp) {
        const certScript = path.join(
            websiteRoot,
            'scripts',
            'ensure-local-https-cert.mjs'
        );
        if (fs.existsSync(certScript)) {
            await new Promise((resolve, reject) => {
                const child = spawn(process.execPath, [certScript], {
                    cwd: websiteRoot,
                    stdio: 'inherit'
                });
                child.on('exit', (code) =>
                    code === 0
                        ? resolve()
                        : reject(
                              new Error(
                                  `ensure-local-https-cert exited ${code}`
                              )
                          )
                );
            });
        }

        const websitePersist = path.join(persistRoot, 'website');
        const websiteWrangler = path.join(
            websiteRoot,
            'node_modules',
            '.bin',
            'wrangler'
        );
        if (!fs.existsSync(websiteWrangler)) {
            throw new Error(`wrangler not found at ${websiteWrangler}`);
        }
        const child = spawnLogged(
            websiteWrangler,
            [
                'pages',
                'dev',
                'webapp',
                '--persist-to',
                websitePersist,
                '--local-protocol',
                'https',
                '--https-key-path',
                '.local-certs/localhost-key.pem',
                '--https-cert-path',
                '.local-certs/localhost.pem',
                '--port',
                '8788',
                '--binding',
                'LOCAL_CLOUD_DEV_ENABLED=true',
                '--binding',
                'AUTH_TOKEN_ALLOW_INSECURE_LOCAL_FALLBACK=true',
                '--binding',
                'EDITOR_ALLOWED_ORIGINS=https://localhost:8000,http://localhost:9000',
                '--binding',
                'WEBSITE_ALLOWED_ORIGINS=https://localhost:8000,http://localhost:9000,https://localhost:8788',
                '--binding',
                'ROOM_WORKER_URL=http://localhost:8787',
                '--binding',
                'MAGIC_LINK_SECRET=e2e-cloud-collab-magic'
            ],
            {
                cwd: websiteRoot,
                env: localCloudEnv(),
                logPath: path.join(persistRoot, 'website.log')
            }
        );
        spawned.push({ name: 'website', pid: child.pid });
    }

    if (!roomUp) {
        const collabPersist = path.join(persistRoot, 'collab');
        const collabWrangler = path.join(
            collabRoot,
            'node_modules',
            '.bin',
            'wrangler'
        );
        if (!fs.existsSync(collabWrangler)) {
            throw new Error(`wrangler not found at ${collabWrangler}`);
        }
        const child = spawnLogged(
            collabWrangler,
            [
                'dev',
                '--persist-to',
                collabPersist,
                '-c',
                'workers/room/wrangler.toml',
                '-c',
                'workers/compactor/wrangler.toml',
                '-c',
                'workers/validator/wrangler.toml'
            ],
            {
                cwd: collabRoot,
                env: localCloudEnv(),
                logPath: path.join(persistRoot, 'collab.log')
            }
        );
        spawned.push({ name: 'collab', pid: child.pid });
    } else {
        console.log(
            '[ensure-cloud-collab-stack] reusing existing collab worker on port 8787'
        );
    }

    if (websiteUp) {
        console.log(
            '[ensure-cloud-collab-stack] reusing existing website worker on port 8788'
        );
    }

    fs.writeFileSync(
        CLOUD_COLLAB_PID_FILE,
        JSON.stringify(
            {
                spawned,
                reusedWebsite: websiteUp,
                reusedRoom: roomUp,
                websiteRoot,
                collabRoot
            },
            null,
            2
        )
    );

    if (!websiteUp) {
        await waitForPort(8788, 'website');
    }
    if (!roomUp) {
        await waitForPort(8787, 'collab room');
    }
}

const isMain =
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
    ensureCloudCollabStack().catch((error) => {
        console.error('[ensure-cloud-collab-stack]', error);
        process.exit(1);
    });
}
