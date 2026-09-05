import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    CLOUD_COLLAB_PERSIST_ROOT,
    CLOUD_COLLAB_PID_FILE
} from './ensure-cloud-collab-stack.mjs';

function killPid(pid) {
    try {
        process.kill(pid, 'SIGTERM');
    } catch {
        // already gone
    }
}

export async function teardownCloudCollabStack() {
    let spawned = [];
    if (fs.existsSync(CLOUD_COLLAB_PID_FILE)) {
        try {
            const state = JSON.parse(
                fs.readFileSync(CLOUD_COLLAB_PID_FILE, 'utf8')
            );
            spawned = state.spawned || [];
            for (const entry of spawned) {
                if (entry?.pid) {
                    killPid(entry.pid);
                }
            }
        } catch {
            // ignore corrupt pid file
        }
    }

    if (!spawned.length) {
        return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    if (process.env.CLOUD_COLLAB_KEEP_LOGS !== '1') {
        fs.rmSync(CLOUD_COLLAB_PERSIST_ROOT, { recursive: true, force: true });
    }
}

const isMain =
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
    teardownCloudCollabStack().catch((error) => {
        console.error('[teardown-cloud-collab-stack]', error);
        process.exit(1);
    });
}
