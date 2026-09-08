import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    CLOUD_COLLAB_PERSIST_ROOT,
    CLOUD_COLLAB_PID_FILE,
    stopCloudCollabPorts
} from './ensure-cloud-collab-stack.mjs';

export async function teardownCloudCollabStack() {
    if (process.env.CLOUD_COLLAB_KEEP_STACK === '1') {
        return [];
    }
    let spawned = [];
    if (fs.existsSync(CLOUD_COLLAB_PID_FILE)) {
        try {
            spawned =
                JSON.parse(fs.readFileSync(CLOUD_COLLAB_PID_FILE, 'utf8'))
                    .spawned || [];
        } catch {
            spawned = [];
        }
    }
    await stopCloudCollabPorts();
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.rmSync(CLOUD_COLLAB_PERSIST_ROOT, { recursive: true, force: true });
    return spawned;
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
