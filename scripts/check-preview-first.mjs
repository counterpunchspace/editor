#!/usr/bin/env node
/**
 * Production may only ship what a preview cutover already shipped.
 *
 *   node scripts/check-preview-first.mjs [<release-commit>]
 *   node scripts/check-preview-first.mjs --services
 *
 * Previews are the editor repo's prereleases, plus services previews
 * (<version>+s.N, website and collab only) on the website repo. The website
 * and collab commits come from the newest preview of either kind, so a
 * release never ships older ones than preview already runs.
 *
 * A full release also checks that the newest editor prerelease's editor
 * commit is an ancestor of the release commit (default HEAD) and that the
 * commits in between only touch version files. --services skips the editor:
 * a services release keeps the editor production serves.
 *
 * Prints the preview trio and writes preview_tag, preview_editor_sha (full
 * release only), website_sha and collab_sha to $GITHUB_OUTPUT when it is set.
 * Website repo: WEBSITE_REPOSITORY (default counterpunchspace/website), read
 * with WEBSITE_GH_TOKEN when set.
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

/** Services releases are tagged <editor version>+s.N. */
export function isServicesTag(tag) {
  return /\+s\.[1-9]\d*$/.test(String(tag ?? ""));
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

function run(command, args, env) {
  return execFileSync(command, args, {
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
}

function listReleases(repo, env) {
  return JSON.parse(
    run("gh", ["api", `repos/${repo}/releases?per_page=50`], env),
  ).map((release) => ({
    repo,
    env,
    tagName: release.tag_name,
    isPrerelease: release.prerelease,
    isDraft: release.draft,
    publishedAt: release.published_at,
  }));
}

function loadTrio(release) {
  const dir = mkdtempSync(path.join(tmpdir(), "preview-trio-"));
  run(
    "gh",
    [
      "release",
      "download",
      release.tagName,
      "--repo",
      release.repo,
      "--pattern",
      "trio.json",
      "--dir",
      dir,
    ],
    release.env,
  );
  const trio = JSON.parse(readFileSync(path.join(dir, "trio.json"), "utf8"));
  for (const key of ["editor", "website", "collab"]) {
    if (!/^[0-9a-f]{40}$/.test(trio[key] ?? "")) {
      throw new Error(`${release.tagName} trio.json has no ${key} commit`);
    }
  }
  return trio;
}

function main() {
  const services = process.argv[2] === "--services";
  const editorRepo = run("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ]);
  const websiteRepo =
    process.env.WEBSITE_REPOSITORY || "counterpunchspace/website";
  const websiteEnv = process.env.WEBSITE_GH_TOKEN
    ? { GH_TOKEN: process.env.WEBSITE_GH_TOKEN }
    : undefined;

  const editorPreview = newestPrerelease(listReleases(editorRepo));
  const servicesPreview = newestPrerelease(
    listReleases(websiteRepo, websiteEnv).filter((release) =>
      isServicesTag(release.tagName),
    ),
  );
  const newest = newestPrerelease(
    [editorPreview, servicesPreview].filter(Boolean),
  );
  if (!newest || (!services && !editorPreview)) {
    throw new Error("No GitHub prerelease found. Cut a preview release first.");
  }
  const siblings = loadTrio(newest);
  const outputs = [
    `preview_tag=${newest.tagName}`,
    `website_sha=${siblings.website}`,
    `collab_sha=${siblings.collab}`,
  ];

  if (services) {
    console.log(
      `Preview ${newest.tagName} shipped website ${siblings.website}, collab ${siblings.collab}.`,
    );
  } else {
    const releaseCommit = run("git", ["rev-parse", process.argv[2] || "HEAD"]);
    const trio = newest === editorPreview ? siblings : loadTrio(editorPreview);
    try {
      execFileSync("git", [
        "merge-base",
        "--is-ancestor",
        trio.editor,
        releaseCommit,
      ]);
    } catch {
      throw new Error(
        `Preview ${editorPreview.tagName} editor ${trio.editor} is not an ancestor of ${releaseCommit}. Cut a new preview release first.`,
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
        `Editor changed since preview ${editorPreview.tagName} beyond version files:\n  ${shown}${more}\nCut a new preview release first.`,
      );
    }
    console.log(
      `Preview ${editorPreview.tagName} shipped editor ${trio.editor}; preview ${newest.tagName} shipped website ${siblings.website}, collab ${siblings.collab}.`,
    );
    outputs.push(`preview_editor_sha=${trio.editor}`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, [...outputs, ""].join("\n"));
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
