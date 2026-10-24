#!/usr/bin/env node
/**
 * Record what a composed cutover is about to replace, and put it back.
 *
 *   node scripts/cutover-snapshot.mjs snapshot preview|production <file>
 *   node scripts/cutover-snapshot.mjs rollback <file>
 *
 * snapshot writes the live version of every Worker the cutover deploys and
 * the live production deployment of both Pages projects. rollback deploys
 * those versions at 100% and rolls the Pages projects back to them, then
 * prints a summary. Entries with no previous version (a Worker deployed for
 * the first time) are left as they are. D1 is not touched: schema changes
 * only ever add tables and columns.
 *
 * Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and
 * CUTOVER_DEPLOYS_PLUGINS=1 when this cutover deploys the plugins Worker.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const API = "https://api.cloudflare.com/client/v4";

/** Worker scripts and Pages projects one cutover deploys. */
export function cutoverResources(target, { deploysPlugins }) {
  if (target !== "preview" && target !== "production") {
    throw new Error("target must be preview or production");
  }
  const suffix = target === "preview" ? "-preview" : "";
  const workers = [`validator${suffix}`, `compactor${suffix}`, `room${suffix}`];
  if (deploysPlugins) {
    workers.push("plugins");
  }
  if (target === "production") {
    workers.push("website-cloud-cron");
  }
  const pages =
    target === "preview"
      ? ["websitepreview", "editorpreview"]
      : ["website", "editor"];
  return { workers, pages };
}

/** The version serving most traffic in the newest deployment, or null. */
export function liveWorkerVersion(deployments) {
  const newest = [...(deployments ?? [])].sort((left, right) =>
    String(right.created_on).localeCompare(String(left.created_on)),
  )[0];
  const versions = [...(newest?.versions ?? [])].sort(
    (left, right) => Number(right.percentage) - Number(left.percentage),
  );
  return versions[0]?.version_id ?? null;
}

async function cloudflare(method, path, body) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) {
    throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
  }
  const response = await fetch(`${API}/accounts/${account}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok && payload.success === true, payload };
}

function isMissingScript(payload) {
  return (payload.errors ?? []).some((error) => error.code === 10007);
}

async function snapshot(target, file) {
  const { workers, pages } = cutoverResources(target, {
    deploysPlugins: process.env.CUTOVER_DEPLOYS_PLUGINS === "1",
  });
  const result = { target, takenAt: new Date().toISOString(), workers: {}, pages: {} };
  for (const script of workers) {
    const { ok, payload } = await cloudflare(
      "GET",
      `/workers/scripts/${script}/deployments`,
    );
    if (!ok && !isMissingScript(payload)) {
      throw new Error(`${script}: ${JSON.stringify(payload.errors)}`);
    }
    result.workers[script] = ok
      ? liveWorkerVersion(payload.result?.deployments)
      : null;
  }
  for (const project of pages) {
    const { ok, payload } = await cloudflare("GET", `/pages/projects/${project}`);
    if (!ok) {
      throw new Error(`${project}: ${JSON.stringify(payload.errors)}`);
    }
    result.pages[project] = payload.result?.canonical_deployment?.id ?? null;
  }
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}

async function rollback(file) {
  const saved = JSON.parse(readFileSync(file, "utf8"));
  const lines = [`## Rolled back ${saved.target} to ${saved.takenAt}`, ""];
  let failed = false;
  const record = (name, outcome) => {
    lines.push(`- ${name}: ${outcome}`);
    console.log(`${name}: ${outcome}`);
  };
  for (const [script, versionId] of Object.entries(saved.workers)) {
    if (!versionId) {
      record(script, "no previous version, left as deployed");
      continue;
    }
    const { ok, payload } = await cloudflare(
      "POST",
      `/workers/scripts/${script}/deployments`,
      {
        strategy: "percentage",
        versions: [{ version_id: versionId, percentage: 100 }],
        annotations: { "workers/message": "Composed cutover rollback" },
      },
    );
    failed ||= !ok;
    record(script, ok ? `restored ${versionId}` : `FAILED ${JSON.stringify(payload.errors)}`);
  }
  for (const [project, deploymentId] of Object.entries(saved.pages)) {
    if (!deploymentId) {
      record(project, "no previous deployment, left as deployed");
      continue;
    }
    const { ok, payload } = await cloudflare(
      "POST",
      `/pages/projects/${project}/deployments/${deploymentId}/rollback`,
    );
    failed ||= !ok;
    record(project, ok ? `restored ${deploymentId}` : `FAILED ${JSON.stringify(payload.errors)}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }
  if (failed) {
    throw new Error("rollback did not restore everything");
  }
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "snapshot" && args.length === 2) {
    await snapshot(args[0], args[1]);
  } else if (mode === "rollback" && args.length === 1) {
    await rollback(args[0]);
  } else {
    throw new Error(
      "usage: cutover-snapshot.mjs snapshot <target> <file> | rollback <file>",
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
