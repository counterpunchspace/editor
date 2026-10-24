import assert from "node:assert/strict";
import test from "node:test";

import { cutoverResources, liveWorkerVersion } from "./cutover-snapshot.mjs";

test("preview snapshots the preview Workers and Pages projects", () => {
  assert.deepEqual(cutoverResources("preview", { deploysPlugins: false }), {
    workers: ["validator-preview", "compactor-preview", "room-preview"],
    pages: ["websitepreview", "editorpreview"],
  });
});

test("production adds the cron Worker, and plugins only when deployed", () => {
  assert.deepEqual(cutoverResources("production", { deploysPlugins: true }), {
    workers: ["validator", "compactor", "room", "plugins", "website-cloud-cron"],
    pages: ["website", "editor"],
  });
  assert.throws(() => cutoverResources("staging", {}), /preview or production/);
});

test("the live version is the main version of the newest deployment", () => {
  assert.equal(
    liveWorkerVersion([
      {
        created_on: "2026-10-01T00:00:00Z",
        versions: [{ version_id: "old", percentage: 100 }],
      },
      {
        created_on: "2026-10-02T00:00:00Z",
        versions: [
          { version_id: "canary", percentage: 10 },
          { version_id: "main", percentage: 90 },
        ],
      },
    ]),
    "main",
  );
  assert.equal(liveWorkerVersion([]), null);
  assert.equal(liveWorkerVersion(undefined), null);
});
