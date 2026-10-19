/**
 * Blend a CI run's Playwright JSON reports into tests/ci-durations.json.
 *
 *   node scripts/ci-durations-refresh.mjs <github-run-id>
 *
 * Downloads playwright-timings-* artifacts. A passing attempt's seconds are
 * averaged with the stored value. Tests that did not pass are left unchanged.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const editorRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
);
const durationsPath = path.join(editorRoot, "webapp/tests/ci-durations.json");
const runId = process.argv[2];
if (!/^\d+$/.test(runId || "")) {
    throw new Error("Usage: ci-durations-refresh.mjs <github-run-id>");
}

const dest = mkdtempSync(path.join(tmpdir(), "ci-durations-"));
const download = spawnSync(
    "gh",
    [
        "run",
        "download",
        runId,
        "--repo",
        "counterpunchspace/editor",
        "--pattern",
        "playwright-timings-*",
        "--dir",
        dest,
    ],
    { encoding: "utf8" },
);
if (download.status !== 0) {
    throw new Error(
        download.stderr || download.stdout || "gh run download failed",
    );
}

function relativeSpec(file) {
    const normalized = String(file || "").replaceAll("\\", "/");
    const marker = normalized.lastIndexOf("/tests/");
    if (marker >= 0) return normalized.slice(marker + 1);
    const base = normalized.split("/").pop();
    return base.startsWith("tests/") ? base : `tests/${base}`;
}

function isFileSuiteTitle(title, file) {
    if (!title || !file) return !title;
    const base = String(file).replaceAll("\\", "/").split("/").pop();
    return title === file || title === base;
}

function collect(suite, titles, inheritedFile, found) {
    const file = suite.file || inheritedFile;
    const nextTitles = isFileSuiteTitle(suite.title, file)
        ? titles
        : [...titles, suite.title];
    for (const spec of suite.specs || []) {
        const specFile = spec.file || file;
        const titlePath = [...nextTitles, spec.title].filter(Boolean);
        const key = `${relativeSpec(specFile)} › ${titlePath.join(" › ")}`;
        for (const test of spec.tests || []) {
            const passed = (test.results || []).find(
                (result) => result.status === "passed",
            );
            if (!passed || !Number.isFinite(passed.duration)) continue;
            found.set(key, Math.max(1, Math.round(passed.duration / 1000)));
        }
    }
    for (const child of suite.suites || []) {
        collect(child, nextTitles, file, found);
    }
}

function jsonFiles(dir) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...jsonFiles(full));
        else if (entry.name.endsWith(".json")) found.push(full);
    }
    return found;
}

const measured = new Map();
const files = jsonFiles(dest);
if (!files.length) {
    throw new Error(`No JSON reports downloaded for run ${runId}`);
}
for (const file of files) {
    const report = JSON.parse(readFileSync(file, "utf8"));
    for (const suite of report.suites || []) {
        collect(suite, [], suite.file, measured);
    }
}

const stored = JSON.parse(readFileSync(durationsPath, "utf8"));
let updated = 0;
for (const [key, seconds] of measured) {
    stored[key] = Number.isFinite(stored[key])
        ? Math.max(1, Math.round((stored[key] + seconds) / 2))
        : seconds;
    updated += 1;
}
const sorted = Object.fromEntries(
    Object.entries(stored).sort(([a], [b]) => a.localeCompare(b)),
);
writeFileSync(durationsPath, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(
    `Updated ${updated} durations from run ${runId} (${files.length} reports).`,
);
