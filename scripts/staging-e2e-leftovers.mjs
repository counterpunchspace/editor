#!/usr/bin/env node
/**
 * After cloud-collab e2e on staging: delete test users and their rooms, then
 * fail if that sweep found anything or could not finish.
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
const found = Number(body.found || 0);
if (!response.ok || body.ok === false || found > 0) {
  console.error(
    `Staging e2e cleanup ${response.status}: ${JSON.stringify(body)}`,
  );
  process.exit(1);
}

console.log("Staging e2e leftover check: nothing left.");
