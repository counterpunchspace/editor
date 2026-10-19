import formatSnapshotJson from './format-snapshot-json.mjs';
import { teardownCloudCollabStack } from './teardown-cloud-collab-stack.mjs';

export default async function playwrightGlobalTeardown() {
    if (process.env.CLOUD_COLLAB_E2E === '1') {
        await teardownCloudCollabStack();
    }
    await formatSnapshotJson();
}
