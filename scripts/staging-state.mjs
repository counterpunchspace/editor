#!/usr/bin/env node
/**
 * Staging CI bookkeeping (website route /api/dev/staging-state).
 *
 *   begin   Claim staging for this run. If the run before did not finish
 *           clean (cancelled, crashed, or left data behind), wipe the cloud
 *           data and test accounts first. If a run that is still going holds
 *           staging, wait for it.
 *   finish  Delete this run's test accounts and fonts, ask every room in the
 *           ledger whether it still holds data, count leftover rows and
 *           stored objects, and fail on anything left. Staging is marked
 *           clean only when nothing is.
 *
 * Needs E2E_OPERATOR_TOKEN, GITHUB_RUN_ID, GITHUB_REPOSITORY and GITHUB_TOKEN.
 */

const website = (
  process.env.CLOUD_COLLAB_WEBSITE_URL || "https://staging.counterpunch.space"
).replace(/\/$/, "");
const operator = String(process.env.E2E_OPERATOR_TOKEN || "").trim();
const runId = String(process.env.GITHUB_RUN_ID || "").trim();
const repository = String(process.env.GITHUB_REPOSITORY || "").trim();
const githubToken = String(process.env.GITHUB_TOKEN || "").trim();
const command = process.argv[2];

const WAIT_FOR_OTHER_RUN_MS = 100 * 60 * 1000;
const POLL_MS = Number(process.env.STAGING_STATE_POLL_MS || 30000);
const githubApi = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
const MAX_STEPS = 2000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!operator) fail("E2E_OPERATOR_TOKEN is required");
if (!runId) fail("GITHUB_RUN_ID is required");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(path, body) {
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetch(`${website}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${operator}`,
          Origin: "https://staging.editor.counterpunch.space",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (attempt >= 4) throw error;
      await sleep(Math.min(3000, POLL_MS) * attempt);
      continue;
    }
    const json = await response.json().catch(() => ({}));
    // The staging edge drops a request now and then; every action is safe
    // to repeat.
    if (response.status >= 500 && attempt < 4) {
      await sleep(3000 * attempt);
      continue;
    }
    if (!response.ok || json.ok === false) {
      fail(`${path} ${body.action || ""} ${response.status}: ${JSON.stringify(json)}`);
    }
    return json;
  }
}

const state = (action, extra = {}) =>
  post("/api/dev/staging-state", { action, runId, ...extra });

async function runStillGoing(otherRunId) {
  if (!repository || !githubToken) return false;
  const response = await fetch(
    `${githubApi}/repos/${repository}/actions/runs/${encodeURIComponent(otherRunId)}`,
    {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (!response.ok) return false;
  const run = await response.json();
  return run.status !== "completed";
}

async function sweepTestAccounts() {
  for (let pass = 1; pass <= MAX_STEPS; pass += 1) {
    const body = await post("/api/dev/local-cloud-cleanup", {
      sweepTestUsers: true,
      allAges: true,
    });
    if (!body.more) return body;
  }
  fail("Test account cleanup did not finish");
}

async function begin() {
  const started = Date.now();
  let current = await state("status");
  while (
    current.state === "in_use" &&
    current.runId &&
    current.runId !== runId &&
    (await runStillGoing(current.runId))
  ) {
    if (Date.now() - started > WAIT_FOR_OTHER_RUN_MS) {
      fail(`Run ${current.runId} still holds staging after 100 minutes`);
    }
    console.log(`Run ${current.runId} is using staging; waiting.`);
    await sleep(POLL_MS);
    current = await state("status");
  }
  const { previous } = await state("claim");
  if (previous.state === "clean") {
    console.log(`Staging is clean (left by run ${previous.runId}).`);
    return;
  }
  console.log(
    `Staging was ${previous.state}${previous.runId ? ` (run ${previous.runId})` : ""}; wiping cloud data first.`,
  );
  let rooms = 0;
  let objects = 0;
  for (let step = 1; step <= MAX_STEPS; step += 1) {
    const result = await state("wipe");
    rooms += Number(result.rooms || 0);
    objects += Number(result.objects || 0);
    if (!result.more) break;
    if (step === MAX_STEPS) fail("The staging wipe did not finish");
  }
  const swept = await sweepTestAccounts();
  console.log(
    `Wiped ${rooms} rooms, ${objects} stored objects, every cloud font, and ${swept.found || 0} test accounts.`,
  );
}

async function finish() {
  const swept = await sweepTestAccounts();
  console.log(`Removed ${swept.found || 0} test accounts and their fonts.`);
  const leaks = [];
  let after = "";
  let checked = 0;
  for (let step = 1; step <= MAX_STEPS; step += 1) {
    const result = await state("check", { after });
    leaks.push(...result.leaks);
    checked += Number(result.checked || 0);
    after = result.after || after;
    if (!result.more) break;
    if (step === MAX_STEPS) fail("The room leak check did not finish");
  }
  const result = await state("finish", { roomLeaks: leaks.length });
  console.log(`Checked ${checked} rooms.`);
  if (result.clean) {
    console.log("Staging is clean.");
    return;
  }
  console.error("Data was left on staging after this run:");
  if (leaks.length) {
    console.error(`${leaks.length} rooms still hold data:`);
    for (const leak of leaks.slice(0, 50)) {
      console.error(`  ${leak.roomId} ${JSON.stringify({ tables: leak.tables, keys: leak.keys, alarm: leak.alarm })}`);
    }
  }
  console.error(`Leftover rows and objects: ${JSON.stringify(result.leftovers)}`);
  console.error("The next staging run wipes this before it starts.");
  process.exit(1);
}

if (command === "begin") await begin();
else if (command === "finish") await finish();
else fail("Usage: staging-state.mjs begin|finish");
