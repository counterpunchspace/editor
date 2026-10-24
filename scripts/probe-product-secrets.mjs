#!/usr/bin/env node
/**
 * Product secret check before a hostname cutover.
 *
 *   node scripts/probe-product-secrets.mjs check-names preview|production
 *   node scripts/probe-product-secrets.mjs deploy-room preview|production
 *
 * check-names fails if a required secret is missing. It does not deploy.
 * deploy-room deploys the room, then POSTs /internal/cutover-pairing on its
 * workers.dev URL and exits non-zero if pairing fails, so the cutover rolls
 * back.
 * Collab root: COLLAB_ROOT. Never prints secret values.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";

const mode = process.argv[2];
const target = process.argv[3];
if (!["check-names", "deploy-room"].includes(mode)) {
  throw new Error("mode must be check-names or deploy-room");
}
if (target !== "preview" && target !== "production") {
  throw new Error("target must be preview or production");
}

const collabRoot = process.env.COLLAB_ROOT;
if (!collabRoot) {
  throw new Error("COLLAB_ROOT is required");
}

const websiteProject = target === "preview" ? "websitepreview" : "website";
const workerEnv = target === "preview" ? "preview" : "";

const WEBSITE_SECRETS = [
  "RESEND_API_KEY",
  "AUTH_TOKEN_SECRET",
  "CLOUD_AUTHORIZE_SERVICE_TOKEN",
  "CLOUD_ATTEST_SERVICE_TOKEN",
  "CLOUD_ROOM_LIMITS_SERVICE_TOKEN",
  "CLOUD_SHARD_OPS_SERVICE_TOKEN",
  "COMPACTOR_SHARED_TOKEN",
  "ROOM_STATUS_SERVICE_TOKEN",
];
const ROOM_SECRETS = [
  "AUTH_TOKEN_SECRET",
  "VALIDATOR_SHARED_TOKEN",
  "COMPACTOR_SHARED_TOKEN",
  "CLOUD_AUTHORIZE_SERVICE_TOKEN",
  "CLOUD_ATTEST_SERVICE_TOKEN",
  "CLOUD_ROOM_LIMITS_SERVICE_TOKEN",
  "CLOUD_SHARD_OPS_SERVICE_TOKEN",
  "ROOM_STATUS_SERVICE_TOKEN",
];

function wrangler(args, cwd) {
  return execFileSync("npx", ["wrangler", ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
}

function secretNamesFromList(output) {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const names = new Set();
  const jsonStart = trimmed.search(/[\[{]/);
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart));
      const rows = Array.isArray(parsed)
        ? parsed
        : parsed?.secrets || parsed?.result || [];
      for (const row of rows) {
        const name = typeof row === "string" ? row : row?.name;
        if (name) names.add(name);
      }
    } catch {
      // Pages secret list is a banner plus "- NAME: Value Encrypted" lines.
    }
  }
  for (const match of trimmed.matchAll(/"name"\s*:\s*"([^"]+)"/g)) {
    names.add(match[1]);
  }
  for (const match of trimmed.matchAll(/^\s*-\s+([A-Z0-9_]+)\s*:/gm)) {
    names.add(match[1]);
  }
  return [...names];
}

function assertNames(label, actual, required) {
  const have = new Set(actual);
  const missing = required.filter((name) => !have.has(name));
  if (missing.length) {
    throw new Error(`${label} is missing secrets: ${missing.join(", ")}`);
  }
  console.log(`${label}: required secrets are present`);
}

function workerArgs(extra) {
  return workerEnv ? ["--env", workerEnv, ...extra] : extra;
}

function checkNames() {
  const problems = [];
  const note = (label, actual, required) => {
    try {
      assertNames(label, actual, required);
    } catch (error) {
      problems.push(error.message);
    }
  };
  const websiteOut = wrangler(
    ["pages", "secret", "list", "--project-name", websiteProject],
    collabRoot,
  );
  note(websiteProject, secretNamesFromList(websiteOut), WEBSITE_SECRETS);

  const checks = [
    ["workers/room", ROOM_SECRETS],
    ["workers/validator", ["VALIDATOR_SHARED_TOKEN"]],
    ["workers/compactor", ["COMPACTOR_SHARED_TOKEN"]],
  ];
  for (const [dir, required] of checks) {
    const cwd = path.join(collabRoot, dir);
    const output = wrangler(["secret", "list", ...workerArgs([])], cwd);
    note(`${dir} (${target})`, secretNamesFromList(output), required);
  }
  if (problems.length) {
    throw new Error(problems.join("\n"));
  }
}

function workersDevUrlFromDeployOutput(output) {
  return output.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i)?.[0] ?? null;
}

function deployRoom() {
  const roomDir = path.join(collabRoot, "workers/room");
  const commit = process.env.COMMIT_SHA || "unknown";
  const deployed = wrangler(
    ["deploy", ...workerArgs(["--var", `COMMIT_SHA:${commit}`])],
    roomDir,
  );
  process.stdout.write(deployed);
  const workersDevUrl = workersDevUrlFromDeployOutput(deployed);
  if (!workersDevUrl) {
    throw new Error("wrangler deploy did not report a workers.dev URL");
  }
  const probe = execFileSync(
    "curl",
    [
      "--fail-with-body",
      "--silent",
      "--show-error",
      "--max-time",
      "60",
      "--retry",
      "5",
      "--retry-all-errors",
      "--retry-delay",
      "5",
      "-X",
      "POST",
      `${workersDevUrl}/internal/cutover-pairing`,
    ],
    { encoding: "utf8" },
  );
  const body = JSON.parse(probe);
  if (body?.ok !== true) {
    throw new Error(`cutover pairing failed: ${probe}`);
  }
  console.log("cutover pairing ok");
}

if (mode === "check-names") {
  checkNames();
} else {
  deployRoom();
}
