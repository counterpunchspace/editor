import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, stackMismatches } from "./wait-for-stack.mjs";

const expected = {
  editor: "editor-sha",
  website: "website-sha",
  collab: "collab-sha",
  version: "v1.2.3",
};

function healthyStack() {
  return {
    editor: { commit: "editor-sha", version: "v1.2.3" },
    website: {
      ok: true,
      commit: "website-sha",
      schema: { ok: true },
      room: {
        ok: true,
        commit: "collab-sha",
        validator: { ok: true, commit: "collab-sha" },
        compactor: { ok: true, commit: "collab-sha" },
      },
    },
  };
}

test("a stack serving every expected commit matches", () => {
  assert.deepEqual(stackMismatches(healthyStack(), expected), []);
});

test("an old room behind the website is reported", () => {
  const stack = healthyStack();
  stack.website.room.compactor.commit = "old-sha";
  assert.deepEqual(stackMismatches(stack, expected), [
    "compactor commit is old-sha, expected collab-sha",
  ]);
});

test("schema, room and fetch failures are reported", () => {
  const stack = healthyStack();
  stack.editor = { error: "HTTP 404" };
  stack.website.schema = { ok: false, reason: "missing tables x" };
  stack.website.room = { ok: false, reason: "status-503" };
  assert.deepEqual(stackMismatches(stack, expected), [
    "editor build-info: HTTP 404",
    "website schema: missing tables x",
    "room health: status-503",
    "room commit is missing, expected collab-sha",
    "validator commit is missing, expected collab-sha",
    "compactor commit is missing, expected collab-sha",
  ]);
});

test("an unexpected version is reported only when one is expected", () => {
  const stack = healthyStack();
  stack.editor.version = "v1.2.2";
  assert.equal(stackMismatches(stack, expected).length, 1);
  assert.deepEqual(
    stackMismatches(stack, { ...expected, version: undefined }),
    [],
  );
});

test("arguments need a mode, both origins and a positive wait", () => {
  const base = ["--editor", "https://e", "--website", "https://w"];
  assert.deepEqual(parseArgs([...base, "--expect-collab", "c", "--check"]), {
    mode: "check",
    waitSeconds: 0,
    editorOrigin: "https://e",
    websiteOrigin: "https://w",
    collab: "c",
  });
  assert.throws(() => parseArgs(base), /--check or --wait/);
  assert.throws(() => parseArgs([...base, "--wait", "0"]), /positive/);
  assert.throws(() => parseArgs(["--check"]), /--editor and --website/);
});
