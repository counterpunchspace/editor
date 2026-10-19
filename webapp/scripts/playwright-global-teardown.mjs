import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import formatSnapshotJson from './format-snapshot-json.mjs';
import { teardownCloudCollabStack } from './teardown-cloud-collab-stack.mjs';

// The wasm-pack action renames its binary from /tmp into ~/.cargo/bin.
// On the Ubuntu 26.04 runners those are different filesystems, so the
// rename fails. Point bin at a directory on /tmp before Rust setup runs.
function placeCargoBinOnTmp() {
    if (!process.env.GITHUB_ACTIONS) return;
    const shard = process.argv.find((arg) => arg.startsWith('--shard=')) || '';
    if (!shard.startsWith('--shard=1/')) return;
    const tmpBin = path.join(os.tmpdir(), 'cargo-bin');
    fs.mkdirSync(tmpBin, { recursive: true });
    const cargoHome = path.join(os.homedir(), '.cargo');
    fs.mkdirSync(cargoHome, { recursive: true });
    const bin = path.join(cargoHome, 'bin');
    let existing = null;
    try {
        existing = fs.lstatSync(bin);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (existing?.isSymbolicLink()) return;
    if (existing) {
        fs.cpSync(bin, tmpBin, { recursive: true });
        fs.rmSync(bin, { recursive: true, force: true });
    }
    fs.symlinkSync(tmpBin, bin);
}

export default async function playwrightGlobalTeardown() {
    try {
        if (process.env.CLOUD_COLLAB_E2E === '1') {
            await teardownCloudCollabStack();
        }
        await formatSnapshotJson();
    } finally {
        placeCargoBinOnTmp();
    }
}
