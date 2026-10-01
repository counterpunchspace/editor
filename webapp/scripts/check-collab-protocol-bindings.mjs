/**
 * Exact-compare editor copies of collab protocol bindings against codegen.
 *
 * Runs collab/packages/protocol/scripts/check-bindings.mjs into a temp dir,
 * then byte-compares each required editor file after stripping an optional
 * leading `// @ts-nocheck` line (needed so generated JS-shaped modules typecheck).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const editorRoot = path.resolve(here, '../..');
const workspaceRoot = path.resolve(editorRoot, '..');
const checkBindings = path.join(
    workspaceRoot,
    'collab/collab/packages/protocol/scripts/check-bindings.mjs'
);
const editorOut = path.join(editorRoot, 'webapp/js/generated');

const REQUIRED = [
    'collab-protocol-limits.ts',
    'collab-protocol-capabilities.ts',
    'collab-protocol-durability-contract.ts',
    'collab-protocol-pack.ts',
    'collab-protocol-pack-grant.ts',
    'collab-protocol-timing-safe.ts'
];

function stripTsNocheck(source) {
    return source.replace(/^\/\/ @ts-nocheck\r?\n/, '');
}

if (!fs.existsSync(checkBindings)) {
    console.error(`protocol check-bindings missing: ${checkBindings}`);
    process.exit(1);
}

const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'collab-protocol-check-')
);
const websiteOut = path.join(tmpRoot, 'website');
const expectedOut = path.join(tmpRoot, 'editor');
fs.mkdirSync(websiteOut, { recursive: true });
fs.mkdirSync(expectedOut, { recursive: true });

const result = spawnSync(process.execPath, [checkBindings], {
    cwd: path.dirname(checkBindings),
    env: {
        ...process.env,
        COLLAB_PROTOCOL_EDITOR_OUT: expectedOut,
        COLLAB_PROTOCOL_WEBSITE_OUT: websiteOut
    },
    encoding: 'utf8'
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.exit(result.status ?? 1);
}

let failed = false;
for (const name of REQUIRED) {
    const actualPath = path.join(editorOut, name);
    const expectedPath = path.join(expectedOut, name);
    if (!fs.existsSync(actualPath)) {
        console.error(`missing generated binding: ${actualPath}`);
        failed = true;
        continue;
    }
    if (!fs.existsSync(expectedPath)) {
        console.error(`codegen did not emit: ${expectedPath}`);
        failed = true;
        continue;
    }
    const actual = stripTsNocheck(fs.readFileSync(actualPath, 'utf8'));
    const expected = fs.readFileSync(expectedPath, 'utf8');
    if (actual !== expected) {
        console.error(`generated binding drift: ${name}`);
        failed = true;
    }
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

if (failed) {
    console.error(
        'Re-run: COLLAB_PROTOCOL_EDITOR_OUT=webapp/js/generated COLLAB_PROTOCOL_WEBSITE_OUT=/tmp/… node ../collab/collab/packages/protocol/scripts/check-bindings.mjs'
    );
    process.exit(1);
}

console.log(`collab protocol bindings match: ${editorOut}`);
