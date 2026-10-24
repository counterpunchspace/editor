#!/usr/bin/env node
/**
 * Production may only ship what a preview cutover already shipped.
 *
 *   node scripts/check-preview-first.mjs [<release-commit>]
 *
 * Loads trio.json from the newest GitHub prerelease and checks that its
 * editor commit is an ancestor of the release commit (default HEAD) and that
 * the commits in between only touch version files. Prints the preview trio
 * and writes preview_tag, preview_editor_sha, website_sha and collab_sha to
 * $GITHUB_OUTPUT when it is set.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Files release.sh rewrites when it turns a preview into a release. */
export const VERSION_ONLY_PATHS = [
  "webapp/coi-serviceworker.js",
  "API.md",
  "documentation/python/06-python-api.md",
  "CHANGELOG.md",
];

export function nonVersionChanges(changedPaths) {
  return changedPaths.filter((file) => !VERSION_ONLY_PATHS.includes(file));
}

export function newestPrerelease(releases) {
  return (
    [...releases]
      .filter((release) => release.isPrerelease && !release.isDraft)
      .sort((left, right) =>
        String(right.publishedAt).localeCompare(String(left.publishedAt)),
      )[0] ?? null
  );
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function main() {
  const releaseCommit = run("git", ["rev-parse", process.argv[2] || "HEAD"]);
  const releases = JSON.parse(
    run("gh", ["api", "repos/{owner}/{repo}/releases?per_page=50"]),
  ).map((release) => ({
    tagName: release.tag_name,
    isPrerelease: release.prerelease,
    isDraft: release.draft,
    publishedAt: release.published_at,
  }));
  const prerelease = newestPrerelease(releases);
  if (!prerelease) {
    throw new Error("No GitHub prerelease found. Cut a preview release first.");
  }
  const dir = mkdtempSync(path.join(tmpdir(), "preview-trio-"));
  run("gh", [
    "release",
    "download",
    prerelease.tagName,
    "--pattern",
    "trio.json",
    "--dir",
    dir,
  ]);
  const trio = JSON.parse(readFileSync(path.join(dir, "trio.json"), "utf8"));
  for (const key of ["editor", "website", "collab"]) {
    if (!/^[0-9a-f]{40}$/.test(trio[key] ?? "")) {
      throw new Error(`${prerelease.tagName} trio.json has no ${key} commit`);
    }
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", trio.editor, releaseCommit]);
  } catch {
    throw new Error(
      `Preview ${prerelease.tagName} editor ${trio.editor} is not an ancestor of ${releaseCommit}. Cut a new preview release first.`,
    );
  }
  const changed = run("git", [
    "diff",
    "--name-only",
    trio.editor,
    releaseCommit,
  ])
    .split("\n")
    .filter(Boolean);
  const unexpected = nonVersionChanges(changed);
  if (unexpected.length) {
    const shown = unexpected.slice(0, 20).join("\n  ");
    const more =
      unexpected.length > 20 ? `\n  … ${unexpected.length - 20} more` : "";
    throw new Error(
      `Editor changed since preview ${prerelease.tagName} beyond version files:\n  ${shown}${more}\nCut a new preview release first.`,
    );
  }
  console.log(
    `Preview ${prerelease.tagName} shipped editor ${trio.editor}, website ${trio.website}, collab ${trio.collab}.`,
  );
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `preview_tag=${prerelease.tagName}`,
        `preview_editor_sha=${trio.editor}`,
        `website_sha=${trio.website}`,
        `collab_sha=${trio.collab}`,
        "",
      ].join("\n"),
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
