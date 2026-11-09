#!/usr/bin/env node
/**
 * After cloud-collab e2e on staging: delete test users and their rooms, then
 * fail if that sweep could not finish or anything is still left.
 *
 * The website keeps accounts created in the last two hours. A newer editor
 * run can be seeding while this job, from the previous run, is still sweeping.
 *
 * The website route only accepts this from the staging operator token.
 */

const website = (
  process.env.CLOUD_COLLAB_WEBSITE_URL || "https://staging.counterpunch.space"
).replace(/\/$/, "");
const token = String(process.env.E2E_OPERATOR_TOKEN || "").trim();

if (!token) {
  console.error("E2E_OPERATOR_TOKEN is required");
  process.exit(1);
}

// A large font is purged over several calls; the website answers
// `more: true` until every room and object is gone.
let found = 0;
for (let pass = 1; ; pass += 1) {
  const response = await fetch(`${website}/api/dev/local-cloud-cleanup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      Origin: "https://staging.editor.counterpunch.space",
    },
    body: JSON.stringify({ sweepTestUsers: true }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    console.error(
      `Staging e2e cleanup ${response.status}: ${JSON.stringify(body)}`,
    );
    process.exit(1);
  }
  found = Math.max(found, Number(body.found || 0));
  if (!body.more) break;
  if (pass >= 500) {
    console.error("Staging e2e cleanup did not finish after 500 calls");
    process.exit(1);
  }
  console.log(`Staging e2e cleanup: pass ${pass} done, more to purge.`);
}

if (found > 0) {
  console.log(`Staging e2e leftover check: removed ${found} test users.`);
} else {
  console.log("Staging e2e leftover check: nothing left.");
}
