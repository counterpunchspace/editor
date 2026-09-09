import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';

const webappRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
);
const editorRoot = path.resolve(webappRoot, '..');

export const CLOUD_COLLAB_STACK_ROOT = path.join(
    webappRoot,
    '.cloud-collab-e2e-wrangler'
);
export const CLOUD_COLLAB_RUN_ID =
    process.env.CLOUD_COLLAB_RUN_ID || String(process.pid);
export const CLOUD_COLLAB_PERSIST_ROOT = path.join(
    CLOUD_COLLAB_STACK_ROOT,
    CLOUD_COLLAB_RUN_ID
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

const REQUIRED_ROOM_CAPABILITIES = {
    durableWal: 1,
    certifiedGeneration: 1,
    packetEnvelope: 1,
    glyphTombstones: 1,
    glyphQuotaReservation: 1
};

function allowInsecureLocalTls() {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

async function probeJsonHealth(url) {
    try {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(2500)
        });
        if (!response.ok) {
            return null;
        }
        return await response.json();
    } catch {
        return null;
    }
}

async function probeHttpOk(url) {
    try {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(2500)
        });
        return response.ok;
    } catch {
        return false;
    }
}

function pidAlive(pid) {
    if (!pid) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function killPid(pid, signal = 'SIGTERM') {
    if (!pid) {
        return;
    }
    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            /* already gone */
        }
    }
}

function pidsListeningOnPort(port) {
    try {
        const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
            encoding: 'utf8'
        }).trim();
        if (!out) {
            return [];
        }
        return [...new Set(out.split(/\s+/).map(Number).filter(Boolean))];
    } catch {
        return [];
    }
}

function killSpawnedFromPidFile(pidFile) {
    if (!fs.existsSync(pidFile)) {
        return [];
    }
    try {
        const state = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
        const spawned = state.spawned || [];
        for (const item of spawned) {
            killPid(item?.pid);
        }
        return spawned;
    } catch {
        return [];
    }
}

async function stopTrackedStacks() {
    if (!fs.existsSync(CLOUD_COLLAB_STACK_ROOT)) {
        return;
    }
    const runs = fs.readdirSync(CLOUD_COLLAB_STACK_ROOT, {
        withFileTypes: true
    });
    for (const entry of runs) {
        if (!entry.isDirectory()) {
            continue;
        }
        killSpawnedFromPidFile(
            path.join(CLOUD_COLLAB_STACK_ROOT, entry.name, 'pids.json')
        );
    }
}

async function waitForPortClosed(port, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!(await isPortOpen(port))) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}

async function stopListenersOnPort(port) {
    for (const pid of pidsListeningOnPort(port)) {
        killPid(pid, 'SIGTERM');
    }
    await waitForPortClosed(port, 15000);
    if (await isPortOpen(port)) {
        for (const pid of pidsListeningOnPort(port)) {
            killPid(pid, 'SIGKILL');
        }
        await waitForPortClosed(port, 5000);
    }
}

export async function stopCloudCollabPorts() {
    await stopTrackedStacks();
    await stopListenersOnPort(8787);
    await stopListenersOnPort(8788);
}

function ownedPidFileLive(persistRoot) {
    const pidFile = path.join(persistRoot, 'pids.json');
    if (!fs.existsSync(pidFile)) {
        return false;
    }
    try {
        const state = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
        const spawned = state.spawned || [];
        if (!spawned.length) {
            return false;
        }
        return spawned.every((item) => pidAlive(item?.pid));
    } catch {
        return false;
    }
}

async function stackIdentityMatches() {
    const roomHealth = await probeJsonHealth('http://127.0.0.1:8787/health');
    if (
        !roomHealth?.ok ||
        roomHealth.service !== 'room' ||
        roomHealth.protocol !== 'p5'
    ) {
        return false;
    }
    const capabilities = roomHealth.capabilities || {};
    for (const [name, version] of Object.entries(REQUIRED_ROOM_CAPABILITIES)) {
        if (Number(capabilities[name]) !== Number(version)) {
            return false;
        }
    }
    return probeHttpOk('https://localhost:8788/');
}

function spawnLogged(command, args, options) {
    const { logPath, ...spawnOptions } = options;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const logFd = fs.openSync(logPath, 'a');
    try {
        const child = spawn(command, args, {
            ...spawnOptions,
            detached: true,
            stdio: ['ignore', logFd, logFd]
        });
        return child;
    } finally {
        fs.closeSync(logFd);
    }
}

export function localCloudEnv() {
    return {
        ...process.env,
        LOCAL_DEV: 'true',
        LOCAL_CLOUD_DEV_ENABLED: 'true',
        AUTH_TOKEN_ALLOW_INSECURE_LOCAL_FALLBACK: 'true',
        AUTH_TOKEN_SECRET:
            process.env.AUTH_TOKEN_SECRET ||
            'counterpunch-local-dev-auth-token-secret',
        EDITOR_ALLOWED_ORIGINS: 'https://localhost:8000,http://localhost:9000',
        WEBSITE_ALLOWED_ORIGINS:
            'https://localhost:8000,http://localhost:9000,https://localhost:8788',
        MAGIC_LINK_SECRET:
            process.env.MAGIC_LINK_SECRET || 'e2e-cloud-collab-magic',
        ROOM_WORKER_URL: 'http://localhost:8787',
        WEBSITE_CONTROL_URL: 'https://localhost:8788',
        CLOUD_ROOM_LIMITS_SERVICE_TOKEN: 'e2e-p0-limits',
        VALIDATOR_SHARED_TOKEN: 'e2e-p0-validator',
        COMPACTOR_SHARED_TOKEN: 'e2e-p0-compactor'
    };
}

export async function ensureCloudCollabStack() {
    allowInsecureLocalTls();
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
    const canReuse =
        websiteUp &&
        roomUp &&
        ownedPidFileLive(persistRoot) &&
        (await stackIdentityMatches());
    if ((websiteUp || roomUp) && !canReuse) {
        await stopCloudCollabPorts();
    }

    const spawned = [];
    const children = [];
    const websiteStillUp = canReuse && (await isPortOpen(8788));
    const roomStillUp = canReuse && (await isPortOpen(8787));

    if (!websiteStillUp) {
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
                'AUTH_TOKEN_SECRET=counterpunch-local-dev-auth-token-secret',
                '--binding',
                'EDITOR_ALLOWED_ORIGINS=https://localhost:8000,http://localhost:9000',
                '--binding',
                'WEBSITE_ALLOWED_ORIGINS=https://localhost:8000,http://localhost:9000,https://localhost:8788',
                '--binding',
                'ROOM_WORKER_URL=http://localhost:8787',
                '--binding',
                'MAGIC_LINK_SECRET=e2e-cloud-collab-magic',
                '--binding',
                'CLOUD_ROOM_LIMITS_SERVICE_TOKEN=e2e-p0-limits'
            ],
            {
                cwd: websiteRoot,
                env: localCloudEnv(),
                logPath: path.join(persistRoot, 'website.log')
            }
        );
        spawned.push({ name: 'website', pid: child.pid });
        children.push(child);
    }

    if (!roomStillUp) {
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
                'workers/validator/wrangler.toml',
                '--var',
                'VALIDATOR_SHARED_TOKEN:e2e-p0-validator',
                '--var',
                'COMPACTOR_SHARED_TOKEN:e2e-p0-compactor',
                '--var',
                'CLOUD_ROOM_LIMITS_SERVICE_TOKEN:e2e-p0-limits',
                '--var',
                'WEBSITE_CONTROL_URL:https://localhost:8788',
                '--var',
                'EDITOR_ALLOWED_ORIGINS:https://localhost:8000,http://localhost:9000',
                '--var',
                'AUTH_TOKEN_SECRET:counterpunch-local-dev-auth-token-secret'
            ],
            {
                cwd: collabRoot,
                env: localCloudEnv(),
                logPath: path.join(persistRoot, 'collab.log')
            }
        );
        spawned.push({ name: 'collab', pid: child.pid });
        children.push(child);
    } else {
        console.log(
            '[ensure-cloud-collab-stack] reusing healthy collab worker on port 8787'
        );
    }

    if (websiteStillUp) {
        console.log(
            '[ensure-cloud-collab-stack] reusing healthy website worker on port 8788'
        );
    }

    if (canReuse && fs.existsSync(CLOUD_COLLAB_PID_FILE)) {
        try {
            const previous = JSON.parse(
                fs.readFileSync(CLOUD_COLLAB_PID_FILE, 'utf8')
            );
            for (const item of previous.spawned || []) {
                if (item?.pid && !spawned.some((row) => row.pid === item.pid)) {
                    spawned.push(item);
                }
            }
        } catch {
            /* ignore corrupt pid files */
        }
    }

    fs.writeFileSync(
        CLOUD_COLLAB_PID_FILE,
        JSON.stringify(
            {
                spawned,
                reusedWebsite: websiteStillUp,
                reusedRoom: roomStillUp,
                websiteRoot,
                collabRoot
            },
            null,
            2
        )
    );

    if (!websiteStillUp) {
        await waitForPort(8788, 'website');
    }
    if (!roomStillUp) {
        await waitForPort(8787, 'collab room');
    }
    const identityDeadline = Date.now() + 120000;
    while (Date.now() < identityDeadline) {
        if (await stackIdentityMatches()) {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!(await stackIdentityMatches())) {
        throw new Error(
            'Cloud collab stack started but health/protocol identity did not match'
        );
    }
    for (const child of children) {
        child.unref();
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
