#!/usr/bin/env node
/**
 * Proves that two editor commits build the same app, so tests that passed on
 * one need not run again on the other.
 *
 *   node scripts/same-build.mjs <tested-commit> <candidate-commit>
 *     Writes same_build=true|false to $GITHUB_OUTPUT (and prints why).
 *
 *   node scripts/same-build.mjs --green-ancestor <commit>
 *     Walks first-parent ancestors while they build the same app as <commit>
 *     and looks for one with a green ci.yml run on main whose cloud-e2e
 *     attestation names the website and collab commits CI would test now
 *     (WEBSITE_REPOSITORY/WEBSITE_REF, COLLAB_REPOSITORY/COLLAB_REF, read with
 *     SIBLING_TOKEN). Writes skip=true|false and tested_sha to $GITHUB_OUTPUT.
 *
 * Only the files release.sh rewrites may differ, and only in their version
 * strings. Any other difference, or any error, means "not proven": the
 * tests run.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { VERSION_ONLY_PATHS } from "./check-preview-first.mjs";

const MAX_ANCESTORS = 20;

/**
 * Masks the version strings release.sh writes. Builds overwrite the service
 * worker versions from the build tag, and the API docs only carry a
 * "**Version:**" header line. CHANGELOG.md is not shipped or tested.
 */
export function maskVersion(path, text) {
  if (text === null) return null;
  if (path === "CHANGELOG.md") return "";
  if (path === "webapp/coi-serviceworker.js") {
    return text.replace(/^(const (?:DISPLAY_)?VERSION = )'[^']*';$/gm, "$1'';");
  }
  if (path === "API.md" || path === "documentation/python/06-python-api.md") {
    return text.replace(/^\*\*Version:\*\* [^\n]*\n\n/gm, "");
  }
  return text;
}

/**
 * Lists why two commits are not the same build. `read(sha, path)` returns the
 * file text, or null when the file does not exist at that commit.
 */
export function buildDifferences(changedPaths, tested, candidate, read) {
  const reasons = [];
  for (const path of changedPaths) {
    if (!VERSION_ONLY_PATHS.includes(path)) {
      reasons.push(`${path} changed`);
      continue;
    }
    if (maskVersion(path, read(tested, path)) !== maskVersion(path, read(candidate, path))) {
      reasons.push(`${path} changed beyond its version string`);
    }
  }
  return reasons;
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readAt(sha, path) {
  try {
    return git(["show", `${sha}:${path}`]);
  } catch {
    return null;
  }
}

export function sameBuild(tested, candidate) {
  const changed = git(["diff", "--name-only", "--no-renames", tested, candidate])
    .split("\n")
    .filter(Boolean);
  return buildDifferences(changed, tested, candidate, readAt);
}

/** Successful main push or dispatch runs, newest first (as in verify-cloud-e2e-attestation.sh). */
export function successfulMainRuns(runs) {
  return [...runs]
    .filter(
      (run) =>
        (run.event === "push" || run.event === "workflow_dispatch") &&
        run.headBranch === "main" &&
        run.status === "completed" &&
        run.conclusion === "success",
    )
    .sort((left, right) => right.databaseId - left.databaseId);
}

function gh(args, token) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    env: token ? { ...process.env, GH_TOKEN: token } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The commits CI would test against: vars.*_SHA, or sibling main. */
function siblingShas() {
  const token = process.env.SIBLING_TOKEN || undefined;
  const resolve = (repo, ref) =>
    gh(["api", `repos/${repo}/commits/${ref || "main"}`, "--jq", ".sha"], token).trim();
  return {
    website: resolve(process.env.WEBSITE_REPOSITORY, process.env.WEBSITE_REF),
    collab: resolve(process.env.COLLAB_REPOSITORY, process.env.COLLAB_REF),
  };
}

/**
 * A green CI run on `sha` whose cloud-e2e attestation names these sibling
 * commits. Runs that skipped their tests publish no attestation.
 */
function greenRunWithSiblings(sha, siblings) {
  const runs = JSON.parse(
    gh([
      "run",
      "list",
      "--workflow=ci.yml",
      `--commit=${sha}`,
      "--limit",
      "20",
      "--json",
      "databaseId,status,conclusion,event,headBranch",
    ]),
  );
  for (const run of successfulMainRuns(runs)) {
    const dir = mkdtempSync(path.join(tmpdir(), "cloud-e2e-trio-"));
    try {
      gh(["run", "download", String(run.databaseId), "--name", "cloud-e2e-trio", "--dir", dir]);
    } catch {
      continue;
    }
    const trio = JSON.parse(readFileSync(path.join(dir, "cloud-e2e-trio.json"), "utf8"));
    if (trio.website === siblings.website && trio.collab === siblings.collab) {
      return run.databaseId;
    }
    console.log(
      `CI run ${run.databaseId} tested website ${trio.website} and collab ${trio.collab}, not ${siblings.website} and ${siblings.collab}.`,
    );
  }
  return null;
}

function output(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  }
}

function findGreenAncestor(commit) {
  const head = git(["rev-parse", commit]).trim();
  const siblings = siblingShas();
  const ancestors = git([
    "rev-list",
    "--first-parent",
    `--max-count=${MAX_ANCESTORS}`,
    `${head}~1`,
  ])
    .split("\n")
    .filter(Boolean);
  for (const ancestor of ancestors) {
    const reasons = sameBuild(ancestor, head);
    if (reasons.length) {
      console.log(`${ancestor} is a different build: ${reasons.join("; ")}`);
      break;
    }
    const runId = greenRunWithSiblings(ancestor, siblings);
    if (runId) {
      console.log(
        `${head} builds the same app as ${ancestor}. CI run ${runId} passed it with website ${siblings.website} and collab ${siblings.collab}.`,
      );
      output({ skip: "true", tested_sha: ancestor });
      return;
    }
    console.log(`${ancestor} is the same build but has no green CI with these siblings; looking further back.`);
  }
  output({ skip: "false", tested_sha: "" });
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--green-ancestor" && args[1]) {
    try {
      findGreenAncestor(args[1]);
    } catch (error) {
      console.log(`Could not prove an earlier green build: ${error.message || error}`);
      output({ skip: "false", tested_sha: "" });
    }
    return;
  }
  if (args.length === 2) {
    const [tested, candidate] = args;
    let reasons;
    try {
      reasons = sameBuild(tested, candidate);
    } catch (error) {
      reasons = [`git failed: ${error.message || error}`];
    }
    if (reasons.length) {
      console.log(`${candidate} is a different build from ${tested}:\n  ${reasons.join("\n  ")}`);
    } else {
      console.log(`${candidate} builds the same app as ${tested}.`);
    }
    output({ same_build: reasons.length ? "false" : "true" });
    return;
  }
  console.error(
    "Usage: same-build.mjs <tested-commit> <candidate-commit>\n       same-build.mjs --green-ancestor <commit>",
  );
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
