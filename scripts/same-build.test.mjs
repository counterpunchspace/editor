import assert from "node:assert/strict";
import test from "node:test";

import { buildDifferences, maskVersion, successfulMainRuns } from "./same-build.mjs";

const SW = "webapp/coi-serviceworker.js";

function reader(files) {
  return (sha, path) => files[sha]?.[path] ?? null;
}

test("a release commit that only bumps versions is the same build", () => {
  const read = reader({
    preview: {
      [SW]: "const VERSION = 'v0.2';\nconst DISPLAY_VERSION = 'v0.2';\nself.x = 1;\n",
      "API.md": "# Font Object Model API Documentation\n\n*Auto-generated*\n",
      "CHANGELOG.md": "# Unreleased\n\n- Thing\n",
    },
    release: {
      [SW]: "const VERSION = 'v0.3';\nconst DISPLAY_VERSION = 'v0.3';\nself.x = 1;\n",
      "API.md":
        "# Font Object Model API Documentation\n\n**Version:** v0.3\n\n*Auto-generated*\n",
      "CHANGELOG.md": "# Unreleased\n\n# v0.3\n\n- Thing\n",
    },
  });
  assert.deepEqual(
    buildDifferences([SW, "API.md", "CHANGELOG.md"], "preview", "release", read),
    [],
  );
});

test("code changes in a version file are a different build", () => {
  const read = reader({
    a: { [SW]: "const VERSION = 'v0.2';\nself.x = 1;\n" },
    b: { [SW]: "const VERSION = 'v0.3';\nself.x = 2;\n" },
  });
  assert.deepEqual(buildDifferences([SW], "a", "b", read), [
    `${SW} changed beyond its version string`,
  ]);
});

test("regenerated API docs content is a different build", () => {
  const read = reader({
    a: { "API.md": "# Docs\n\nOld text\n" },
    b: { "API.md": "# Docs\n\n**Version:** v0.3\n\nNew text\n" },
  });
  assert.equal(buildDifferences(["API.md"], "a", "b", read).length, 1);
});

test("any other changed file is a different build", () => {
  assert.deepEqual(buildDifferences(["webapp/js/app.ts"], "a", "b", reader({})), [
    "webapp/js/app.ts changed",
  ]);
});

test("a version file that appears or disappears is a different build", () => {
  const read = reader({ b: { [SW]: "const VERSION = 'v1';\n" } });
  assert.equal(buildDifferences([SW], "a", "b", read).length, 1);
  assert.equal(maskVersion("CHANGELOG.md", null), null);
});

test("only successful main push or dispatch runs count, newest first", () => {
  const runs = [
    { databaseId: 1, event: "push", headBranch: "main", status: "completed", conclusion: "success" },
    { databaseId: 2, event: "workflow_dispatch", headBranch: "main", status: "completed", conclusion: "success" },
    { databaseId: 3, event: "workflow_dispatch", headBranch: "main", status: "completed", conclusion: "failure" },
    { databaseId: 4, event: "pull_request", headBranch: "main", status: "completed", conclusion: "success" },
    { databaseId: 5, event: "push", headBranch: "feature", status: "completed", conclusion: "success" },
    { databaseId: 6, event: "push", headBranch: "main", status: "in_progress", conclusion: "" },
  ];
  assert.deepEqual(
    successfulMainRuns(runs).map((run) => run.databaseId),
    [2, 1],
  );
});
