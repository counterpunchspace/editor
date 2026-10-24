import assert from "node:assert/strict";
import test from "node:test";

import { newestPrerelease, nonVersionChanges } from "./check-preview-first.mjs";

test("only version files may change between preview and release", () => {
  assert.deepEqual(
    nonVersionChanges([
      "CHANGELOG.md",
      "webapp/coi-serviceworker.js",
      "API.md",
      "documentation/python/06-python-api.md",
    ]),
    [],
  );
  assert.deepEqual(
    nonVersionChanges(["CHANGELOG.md", "webapp/js/change-log.ts"]),
    ["webapp/js/change-log.ts"],
  );
});

test("the newest published prerelease is chosen", () => {
  const releases = [
    { tagName: "v0.3", isPrerelease: false, isDraft: false, publishedAt: "2026-10-20T00:00:00Z" },
    { tagName: "v0.0.7-pre.1", isPrerelease: true, isDraft: false, publishedAt: "2026-10-10T00:00:00Z" },
    { tagName: "v0.0.8-pre.1", isPrerelease: true, isDraft: false, publishedAt: "2026-10-12T00:00:00Z" },
    { tagName: "draft", isPrerelease: true, isDraft: true, publishedAt: "2026-10-22T00:00:00Z" },
  ];
  assert.equal(newestPrerelease(releases).tagName, "v0.0.8-pre.1");
  assert.equal(newestPrerelease([]), null);
});
