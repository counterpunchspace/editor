/**
 * Select the Playwright tests for one CI job.
 *
 *   node scripts/ci-shard.mjs --project chromium --group path-editing
 *   node scripts/ci-shard.mjs --project cloud-collab --shards 10 --index 3
 *
 * `--group` prints the spec files of a named group and fails unless the groups
 * partition the project's spec files. `--shards` prints one `file:line` filter
 * per line for a duration-balanced shard and fails unless the bins partition
 * the test list.
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

// Named file groups, one CI job each, so a job name says what it covers.
// Cloud jobs share one staging stack. Groups are split so each job stays under
// 10 minutes. The marketplace test stays alone. If more groups start causing
// staging transport errors, cap the cloud matrix with max-parallel: 6.
const GROUPS = {
    'chromium': {
        'language-packs': ['tests/latin-language-pack.spec.ts'],
        'linked-windows': ['tests/linked-window-editing-compile.spec.ts'],
        'startup-and-files': [
            'tests/basic-interaction.spec.ts',
            'tests/open-path-startup.spec.ts',
            'tests/multiline-text.spec.ts',
            'tests/cloud-wal-idb.spec.ts',
            'tests/compilation-lane-benchmark.spec.ts'
        ],
        'path-editing': [
            'tests/open-close-path.spec.ts',
            'tests/outline-editor-gaps.spec.ts',
            'tests/path-context-menu-fuzz.spec.ts',
            'tests/boolean-subtraction.spec.ts'
        ],
        'anchors-and-components': [
            'tests/automatic-adieresis-anchor-browser.spec.ts',
            'tests/anchor-drag-no-shape-corruption.spec.ts',
            'tests/glyph-selection-restore.spec.ts',
            'tests/keyboard-after-drag-handoff.spec.ts'
        ],
        'python-sync-compile': [
            'tests/change-bridge-cross-window.spec.ts',
            'tests/feature-subset-fustat.spec.ts',
            'tests/python-model-mapping-access.spec.ts',
            'tests/python-node-history-fustat.spec.ts'
        ]
    },
    'cloud-collab': {
        'marketplace': ['tests/plugin-marketplace.spec.ts'],
        'offline-edits': ['tests/cloud-collab-reliability-offline.spec.ts'],
        'offline-reload': ['tests/cloud-collab-offline-reload.spec.ts'],
        'catalog': ['tests/cloud-collab-reliability-catalog.spec.ts'],
        'integrity': ['tests/cloud-collab-p0-integrity.spec.ts'],
        'lifecycle': ['tests/cloud-collab-lifecycle.spec.ts'],
        'quota': ['tests/cloud-collab-quota.spec.ts'],
        'deletion': ['tests/cloud-collab-deletion.spec.ts'],
        'deletion-glyph': ['tests/cloud-collab-deletion-glyph.spec.ts'],
        'sparse-closure': [
            'tests/cloud-collab-sparse-closure.spec.ts',
            'tests/cloud-collab-master-topology.spec.ts'
        ],
        'three-window-sync': ['tests/cloud-collab-three-window-sync.spec.ts'],
        'three-window-relay': ['tests/cloud-collab-three-window-relay.spec.ts'],
        'reconnect': ['tests/cloud-collab-three-window-reconnect.spec.ts']
    }
};

function groupFiles(project, group) {
    const groups = GROUPS[project];
    if (!groups) {
        throw new Error(
            `No groups for project "${project}". Expected ${Object.keys(GROUPS).join(', ')}`
        );
    }
    const files = groups[group];
    if (!files) {
        throw new Error(
            `Unknown ${project} group "${group}". Expected ${Object.keys(groups).join(', ')}`
        );
    }
    const listed = new Set(listTests(project).map((test) => test.file));
    const assigned = new Map();
    for (const [name, members] of Object.entries(groups)) {
        for (const file of members) {
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
            throw new Error(`${file} is not in a ${project} group`);
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
    if (!project) {
        throw new Error('--group needs --project');
    }
    for (const file of groupFiles(project, group)) {
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
