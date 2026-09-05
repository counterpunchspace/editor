import { ensureCloudCollabStack } from './ensure-cloud-collab-stack.mjs';

export default async function cloudCollabGlobalSetup() {
    await ensureCloudCollabStack();
}
