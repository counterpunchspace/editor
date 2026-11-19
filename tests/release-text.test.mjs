import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../scripts/release-text.sh");

function releasesFile(text) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "release-text-")), "RELEASES.txt");
  writeFileSync(file, text);
  return file;
}

function run(args, file) {
  const result = spawnSync("bash", [SCRIPT, ...args, file], { encoding: "utf8" });
  return { status: result.status, out: result.stdout };
}

const RELEASES = `# v0.4.1

Fixes.

# v0.4.0

Beta.

## User-facing changes

- Launcher

# v0.3.0

Alpha.
`;

test("a minor release prints its own text without a heading", () => {
  assert.deepEqual(run(["v0.4.0"], releasesFile(RELEASES)), {
    status: 0,
    out: "Beta.\n\n## User-facing changes\n\n- Launcher\n",
  });
});

test("a patch release with text prints its whole minor release, newest first, under headings", () => {
  assert.deepEqual(run(["v0.4.1"], releasesFile(RELEASES)), {
    status: 0,
    out: "# v0.4.1\n\nFixes.\n\n# v0.4.0\n\nBeta.\n\n## User-facing changes\n\n- Launcher\n",
  });
});

test("a release without a section of its own has no text", () => {
  assert.equal(run(["v0.4.2"], releasesFile(RELEASES)).status, 1);
  assert.equal(run(["v0.5.0"], releasesFile(RELEASES)).status, 1);
});

test("a patch release without text takes over the newest section of its minor release", () => {
  assert.deepEqual(run(["--inherit", "v0.4.2"], releasesFile(RELEASES)), {
    status: 0,
    out: "v0.4.1\n",
  });
  assert.deepEqual(run(["--inherit", "v0.4.1"], releasesFile(RELEASES.replace("# v0.4.1\n\nFixes.\n\n", ""))), {
    status: 0,
    out: "v0.4.0\n",
  });
});

test("a minor release, or a patch of a minor release with no text, inherits nothing", () => {
  assert.equal(run(["--inherit", "v0.5.0"], releasesFile(RELEASES)).status, 1);
  assert.equal(run(["--inherit", "v0.5.1"], releasesFile(RELEASES)).status, 1);
});
