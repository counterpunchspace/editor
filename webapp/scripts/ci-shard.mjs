/**
 * Pack Playwright tests into duration-balanced shards.
 *
 *   node scripts/ci-shard.mjs --project cloud-collab --shards 10 --index 3
 *
 * Prints one `file:line` filter per line for that shard. Every invocation
 * bins the full project and fails unless the bins partition the list.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webappRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
);
const DEFAULT_SECONDS = 180;

function argValue(name) {
    const flag = `--${name}`;
    const index = process.argv.indexOf(flag);
    if (index === -1) {
        const prefixed = process.argv.find((arg) => arg.startsWith(`${flag}=`));
        return prefixed ? prefixed.slice(flag.length + 1) : '';
    }
    return process.argv[index + 1] || '';
}

function relativeSpec(file) {
    const normalized = String(file || '').replaceAll('\\', '/');
    const marker = normalized.lastIndexOf('/tests/');
    if (marker >= 0) return normalized.slice(marker + 1);
    const base = normalized.split('/').pop();
    return base.startsWith('tests/') ? base : `tests/${base}`;
}

function isFileSuiteTitle(title, file) {
    if (!title || !file) return !title;
    const base = String(file).replaceAll('\\', '/').split('/').pop();
    return title === file || title === base;
}

function collectTests(suite, titles, inheritedFile, project, out) {
    const file = suite.file || inheritedFile;
    const nextTitles = isFileSuiteTitle(suite.title, file)
        ? titles
        : [...titles, suite.title];
    for (const spec of suite.specs || []) {
        const specFile = spec.file || file;
        const projects = (spec.tests || []).map((test) => test.projectName);
        if (projects.length && !projects.includes(project)) continue;
        const titlePath = [...nextTitles, spec.title].filter(Boolean);
        out.push({
            file: relativeSpec(specFile),
            line: spec.line,
            key: `${relativeSpec(specFile)} › ${titlePath.join(' › ')}`
        });
    }
    for (const child of suite.suites || []) {
        collectTests(child, nextTitles, file, project, out);
    }
}

function listTests(project) {
    // With an output file set, the JSON reporter writes there instead of stdout.
    const env = { ...process.env };
    delete env.PLAYWRIGHT_JSON_OUTPUT_NAME;
    delete env.PLAYWRIGHT_JSON_OUTPUT_FILE;
    delete env.PLAYWRIGHT_JSON_OUTPUT_DIR;
    const result = spawnSync(
        'npx',
        [
            'playwright',
            'test',
            '--list',
            '--reporter=json',
            `--project=${project}`
        ],
        { cwd: webappRoot, encoding: 'utf8', env }
    );
    if (result.status !== 0) {
        throw new Error(
            result.stderr || result.stdout || 'playwright --list failed'
        );
    }
    const report = JSON.parse(result.stdout);
    const tests = [];
    for (const suite of report.suites || []) {
        collectTests(suite, [], suite.file, project, tests);
    }
    if (!tests.length) {
        throw new Error(`No tests listed for project ${project}`);
    }
    return tests;
}

function pack(tests, shardCount) {
    const bins = Array.from({ length: shardCount }, () => ({
        tests: [],
        total: 0
    }));
    const sorted = [...tests].sort(
        (a, b) => b.seconds - a.seconds || a.key.localeCompare(b.key)
    );
    for (const test of sorted) {
        let best = 0;
        for (let index = 1; index < bins.length; index += 1) {
            if (bins[index].total < bins[best].total) best = index;
        }
        bins[best].tests.push(test);
        bins[best].total += test.seconds;
    }
    const placed = bins.flatMap((bin) => bin.tests.map((test) => test.key));
    const unique = new Set(placed);
    if (placed.length !== tests.length || unique.size !== tests.length) {
        throw new Error(
            `Shard bins do not partition the ${tests.length} listed tests`
        );
    }
    return bins;
}

// Cloud jobs share one staging editor. Duration packing into 10 shards put
// too many browsers on it at once, and page loads never finished. These groups
// are the sets that already passed together, with the marketplace test alone.
const CLOUD_GROUPS = {
    'marketplace': ['tests/plugin-marketplace.spec.ts'],
    'reliability': ['tests/cloud-collab-reliability.spec.ts'],
    'seed-lifecycle': [
        'tests/cloud-collab-deletion.spec.ts',
        'tests/cloud-collab-lifecycle.spec.ts',
        'tests/cloud-collab-offline-reload.spec.ts'
    ],
    'quota-integrity': [
        'tests/cloud-collab-quota.spec.ts',
        'tests/cloud-collab-p0-integrity.spec.ts'
    ],
    'three-window': [
        'tests/cloud-collab-three-window-sync.spec.ts',
        'tests/cloud-collab-three-window-relay.spec.ts',
        'tests/cloud-collab-three-window-reconnect.spec.ts',
        'tests/cloud-collab-sparse-closure.spec.ts'
    ]
};

function cloudGroupFiles(group) {
    const files = CLOUD_GROUPS[group];
    if (!files) {
        throw new Error(
            `Unknown cloud group "${group}". Expected ${Object.keys(CLOUD_GROUPS).join(', ')}`
        );
    }
    const listed = new Set(listTests('cloud-collab').map((test) => test.file));
    const assigned = new Map();
    for (const [name, groupFiles] of Object.entries(CLOUD_GROUPS)) {
        for (const file of groupFiles) {
            if (assigned.has(file)) {
                throw new Error(
                    `${file} is in both ${assigned.get(file)} and ${name}`
                );
            }
            assigned.set(file, name);
        }
    }
    for (const file of listed) {
        if (!assigned.has(file)) {
            throw new Error(`${file} is not in a cloud group`);
        }
    }
    for (const file of assigned.keys()) {
        if (!listed.has(file)) {
            throw new Error(`${file} is grouped but not listed`);
        }
    }
    return files;
}

const project = argValue('project');
const group = argValue('group');
if (group) {
    if (project && project !== 'cloud-collab') {
        throw new Error('--group is only for the cloud-collab project');
    }
    for (const file of cloudGroupFiles(group)) {
        process.stdout.write(`${file}\n`);
    }
    process.exit(0);
}

const shardCount = Number(argValue('shards'));
const index = Number(argValue('index'));
if (!project || !Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error(
        'Usage: ci-shard.mjs --project <name> --shards <n> --index <1-based>'
    );
}
if (!Number.isInteger(index) || index < 1 || index > shardCount) {
    throw new Error(`--index must be from 1 to ${shardCount}`);
}

const durations = JSON.parse(
    fs.readFileSync(path.join(webappRoot, 'tests/ci-durations.json'), 'utf8')
);
const tests = listTests(project).map((test) => {
    if (!Number.isFinite(durations[test.key])) {
        console.error(
            `ci-shard: no duration for ${test.key}; using ${DEFAULT_SECONDS}s`
        );
    }
    return {
        ...test,
        seconds: Number.isFinite(durations[test.key])
            ? durations[test.key]
            : DEFAULT_SECONDS
    };
});
const bins = pack(tests, shardCount);
const chosen = bins[index - 1];
if (!chosen.tests.length) {
    throw new Error(`Shard ${index} of ${shardCount} for ${project} is empty`);
}
for (const test of chosen.tests) {
    process.stdout.write(`${test.file}:${test.line}\n`);
}
