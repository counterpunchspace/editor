#!/usr/bin/env node
/**
 * Does a stack serve the expected commits?
 *
 *   node scripts/wait-for-stack.mjs --editor <origin> --website <origin> \
 *     --expect-editor <sha> --expect-website <sha> --expect-collab <sha> \
 *     [--expect-version <tag>] (--check | --wait <seconds>)
 *
 * Reads the editor's /build-info.json and the website's /api/health?ai=1, which
 * also reports the D1 schema, whether the Assistant's OpenRouter key works,
 * and the deep health of the room it is wired to (room, validator and
 * compactor commits).
 *
 * --check asks once, prints match=true|false and exits 0 either way.
 * --wait polls until everything matches and exits 1 on timeout.
 * Either mode writes match=… to $GITHUB_OUTPUT when it is set.
 */

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const POLL_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Every reason the observed stack differs from the expected one. Empty when
 * it matches. Expected values left empty are not checked.
 */
export function stackMismatches(observed, expected) {
  const problems = [];
  const compare = (label, actual, wanted) => {
    if (wanted && actual !== wanted) {
      problems.push(`${label} is ${actual ?? "missing"}, expected ${wanted}`);
    }
  };
  const editor = observed.editor;
  const website = observed.website;
  if (editor?.error) {
    problems.push(`editor build-info: ${editor.error}`);
  } else {
    compare("editor commit", editor?.commit, expected.editor);
    compare("editor version", editor?.version, expected.version);
  }
  if (website?.error) {
    problems.push(`website health: ${website.error}`);
    return problems;
  }
  compare("website commit", website?.commit, expected.website);
  if (website?.schema?.ok !== true) {
    problems.push(
      `website schema: ${website?.schema?.reason ?? "not reported"}`,
    );
  }
  if (website?.ai?.ok !== true) {
    problems.push(`website AI: ${website?.ai?.reason ?? "not reported"}`);
  }
  const room = website?.room;
  if (!room || room.ok !== true) {
    problems.push(`room health: ${room?.reason ?? "not ok"}`);
  }
  compare("room commit", room?.commit, expected.collab);
  compare("validator commit", room?.validator?.commit, expected.collab);
  compare("compactor commit", room?.compactor?.commit, expected.collab);
  return problems;
}

export function parseArgs(argv) {
  const options = { mode: null, waitSeconds: 0 };
  const valueFlags = {
    "--editor": "editorOrigin",
    "--website": "websiteOrigin",
    "--expect-editor": "editor",
    "--expect-website": "website",
    "--expect-collab": "collab",
    "--expect-version": "version",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--check") {
      options.mode = "check";
    } else if (flag === "--wait") {
      options.mode = "wait";
      options.waitSeconds = Number(argv[++index]);
    } else if (valueFlags[flag]) {
      options[valueFlags[flag]] = argv[++index] ?? "";
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  if (!options.mode) {
    throw new Error("pass --check or --wait <seconds>");
  }
  if (
    options.mode === "wait" &&
    !(Number.isFinite(options.waitSeconds) && options.waitSeconds > 0)
  ) {
    throw new Error("--wait needs a positive number of seconds");
  }
  if (!options.editorOrigin || !options.websiteOrigin) {
    throw new Error("--editor and --website are required");
  }
  return options;
}

async function fetchJson(url) {
  const busted = new URL(url);
  busted.searchParams.set("t", String(Date.now()));
  try {
    const response = await fetch(busted, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { error: `HTTP ${response.status}` };
    }
    return await response.json();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function observe(options) {
  const [editor, website] = await Promise.all([
    fetchJson(`${options.editorOrigin.replace(/\/$/, "")}/build-info.json`),
    fetchJson(`${options.websiteOrigin.replace(/\/$/, "")}/api/health?ai=1`),
  ]);
  return { editor, website };
}

function report(match) {
  console.log(`match=${match}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `match=${match}\n`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const deadline = Date.now() + options.waitSeconds * 1000;
  for (;;) {
    const problems = stackMismatches(await observe(options), options);
    if (!problems.length) {
      console.log(
        `${options.editorOrigin} and ${options.websiteOrigin} serve the expected commits.`,
      );
      report(true);
      return;
    }
    for (const problem of problems) {
      console.log(`  ${problem}`);
    }
    if (options.mode === "check") {
      report(false);
      return;
    }
    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      report(false);
      console.error(
        `Timed out after ${options.waitSeconds}s waiting for the expected commits.`,
      );
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
}
