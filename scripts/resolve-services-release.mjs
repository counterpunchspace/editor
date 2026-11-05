#!/usr/bin/env node
/**
 * Tag for a services release: website and collab ship, the editor stays.
 *
 *   node scripts/resolve-services-release.mjs preview|production
 *
 * Reads the live editor's /build-info.json on the target, then picks the next
 * free <editor version>+s.N tag among the editor repo's remote tags (the
 * cutover puts the same tag on all three repos). Prints the result and writes
 * tag, editor_sha and editor_version to $GITHUB_OUTPUT when it is set.
 *
 * Example: production editor v0.4.0 with v0.4.0+s.1 already tagged gives
 * v0.4.0+s.2.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const EDITOR_ORIGINS = {
  preview: "https://preview.editor.counterpunch.space",
  production: "https://editor.counterpunch.space",
};

/** Commit and version from a /build-info.json body, or an error. */
export function parseBuildInfo(text, origin) {
  let info;
  try {
    info = JSON.parse(text);
  } catch {
    throw new Error(
      `${origin}/build-info.json is not JSON. The live editor predates build-info.json; ship a full release first.`,
    );
  }
  const commit = String(info?.commit ?? "");
  const version = String(info?.version ?? "");
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`${origin}/build-info.json has no full commit: ${text}`);
  }
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(
      `${origin}/build-info.json version "${version}" is not a release version`,
    );
  }
  return { commit, version };
}

/** The next <version>+s.N tag, given every tag name that exists. */
export function nextServicesTag(version, tagNames) {
  const prefix = `${version}+s.`;
  let highest = 0;
  for (const name of tagNames) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const n = name.slice(prefix.length);
    if (/^[1-9]\d*$/.test(n)) {
      highest = Math.max(highest, Number(n));
    }
  }
  return `${prefix}${highest + 1}`;
}

/** Tag names from `git ls-remote --tags` output. */
export function tagNamesFromLsRemote(output) {
  return output
    .split("\n")
    .map((line) => line.split("\t")[1] ?? "")
    .filter((ref) => ref.startsWith("refs/tags/"))
    .map((ref) => ref.slice("refs/tags/".length).replace(/\^\{\}$/, ""));
}

async function main() {
  const target = process.argv[2];
  const origin = EDITOR_ORIGINS[target];
  if (!origin) {
    throw new Error("usage: resolve-services-release.mjs preview|production");
  }
  const response = await fetch(`${origin}/build-info.json?t=${Date.now()}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`${origin}/build-info.json returned ${response.status}`);
  }
  const { commit, version } = parseBuildInfo(await response.text(), origin);
  const tags = tagNamesFromLsRemote(
    execFileSync("git", ["ls-remote", "--tags", "origin"], { encoding: "utf8" }),
  );
  const tag = nextServicesTag(version, tags);
  console.log(`Live ${target} editor: ${version} at ${commit}`);
  console.log(`Services release tag: ${tag}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `tag=${tag}\neditor_sha=${commit}\neditor_version=${version}\n`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
