import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, stackMismatches, stackWarnings } from "./wait-for-stack.mjs";

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
      ai: { ok: true },
      config: {
        ok: true,
        failed: [],
        checks: { stripe: { ok: true }, pluginsWorker: { ok: true } },
      },
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
  stack.website.ai = { ok: false, reason: "OPENROUTER_API_KEY is not set" };
  stack.website.room = { ok: false, reason: "status-503" };
  assert.deepEqual(stackMismatches(stack, expected), [
    "editor build-info: HTTP 404",
    "website schema: missing tables x",
    "website AI: OPENROUTER_API_KEY is not set",
    "room health: status-503",
    "room commit is missing, expected collab-sha",
    "validator commit is missing, expected collab-sha",
    "compactor commit is missing, expected collab-sha",
  ]);
});

test("a website that does not report AI health is not ready", () => {
  const stack = healthyStack();
  delete stack.website.ai;
  assert.deepEqual(stackMismatches(stack, expected), [
    "website AI: not reported",
  ]);
});

test("a thin AI route warns without blocking the release", () => {
  const stack = healthyStack();
  stack.website.ai = {
    ok: true,
    route: {
      ok: true,
      model: "deepseek/deepseek-v4.1-flash-1017",
      providers: ["morph/fp8"],
      warnings: ["only 1 endpoint(s) passed; the Assistant falls back to Luna more often"],
    },
  };
  assert.deepEqual(stackMismatches(stack, expected), []);
  assert.deepEqual(stackWarnings(stack), [
    "AI route: deepseek/deepseek-v4.1-flash-1017 on morph/fp8",
    "AI route: only 1 endpoint(s) passed; the Assistant falls back to Luna more often",
  ]);
  assert.deepEqual(stackWarnings(healthyStack()), []);
});

test("each failed secret or binding check is named", () => {
  const stack = healthyStack();
  stack.website.config = {
    ok: false,
    failed: ["stripe", "pluginsWorker"],
    checks: {
      stripe: { ok: false, reason: "missing STRIPE_PUBLISHABLE_KEY" },
      pluginsWorker: { ok: false, reason: "plugins Worker: openrouter" },
      githubApp: { ok: true },
    },
  };
  assert.deepEqual(stackMismatches(stack, expected), [
    "website config stripe: missing STRIPE_PUBLISHABLE_KEY",
    "website config pluginsWorker: plugins Worker: openrouter",
  ]);
});

test("a website that does not report its config checks is not ready", () => {
  const stack = healthyStack();
  delete stack.website.config;
  assert.deepEqual(stackMismatches(stack, expected), [
    "website config: not reported",
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
