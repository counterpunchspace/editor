# Composed collab/website/editor releases

Cloud collaboration is three repos: **editor**, **website**, and **collab**. A green editor CI run does not prove that website Pages or the room workers are safe with that editor.

There is **no pin file** in git (`PINNED_REVISIONS.json` is gone). The known-good trio is:

1. A **matching git tag** on all three repos.
2. **`trio.json`** attached to the editor GitHub release (and uploaded as the `trio-preview` / `trio-production` workflow artifact).

```json
{
  "environment": "preview",
  "tag": "v0.0.12-pre.20260921",
  "editor": "<full sha>",
  "website": "<full sha>",
  "collab": "<full sha>"
}
```

## Who deploys Cloudflare

Editor **Preview Release** and **Release** own preview and production Cloudflare. Website and collab `main` only run tests. Pushing those repos does not ship Pages or Workers.

Emergency production deploys exist as `workflow_dispatch` with confirm text `deploy-production` on the website and collab CI workflows. Do not use those for a normal trio cut.

## What reports which commit

Every service reports what it runs, so the cutover can tell when a deploy reached the edge:

- Editor: `/build-info.json` returns `{ commit, version }`. The service worker never caches it.
- Website: `/api/health` returns its `commit`, the D1 `schema` check and `room`, the `?deep=1` health of its `ROOM_WORKER_URL`.
- Room: `/health` returns `commit`; `?deep=1` adds the validator's and compactor's commit through the service bindings.

`scripts/wait-for-stack.mjs` reads both URLs and compares them with the expected commits. `--check` looks once and prints `match=true|false`; `--wait <seconds>` polls until everything matches.

## The cutover

Preview Release and Release both call `.github/workflows/composed-cutover.yml`:

1. **freeze:** records the editor, website and collab commits (`trio.json`).
2. **sibling-ci:** waits for green website and collab `deploy.yml` push runs on those commits.
3. **verify-e2e:** waits until no editor CI run on `main` is still running for the editor commit, then needs a successful one (push, or `push.sh`'s workflow_dispatch) whose `cloud-e2e-trio` names exactly the frozen website and collab commits. Production checks the preview's editor commit instead (see below).
4. **tested-build:** `scripts/same-build.mjs` checks that the frozen editor commit builds the same app as the commit `verify-e2e` accepted (see "Same build" below). If it does, CI already passed the suite on that build with exactly these website and collab commits, so the staging redeploy and suite are skipped. A preview always skips here, since it ships the tested commit itself.
5. Otherwise **staging-deploy** puts the trio on staging and waits until staging reports it, **staging-e2e** runs the full cloud-collab suite, and **staging-check** removes the suite's data and fails if staging changed during the run.
6. **preflight:** builds the website and the editor (version already injected), bundles the website functions, runs `wrangler deploy --dry-run` for validator, compactor, room, plugins and cron, and checks the target's secret names. Its builds are what the deploy job ships. A dry run stops here.
7. **deploy:** records the live Worker versions and Pages deployments (`scripts/cutover-snapshot.mjs`, artifact `cutover-snapshot-<target>`), then deploys validator, compactor, the room (followed by a pairing check on its `workers.dev` URL), the D1 schema, website, plugins, cron (production only) and editor.
8. **smoke:** waits up to 3 minutes until the real domains report the new commits and version, then signs in real accounts and runs the smoke test (see below).
9. **rollback:** runs only if deploy or smoke failed, and restores everything in the snapshot. D1 stays as it is.
10. **tag:** tags all three repos after the smoke test passed. A tag that already points at the deployed commit is kept; one that points elsewhere fails the job.

The GitHub prerelease or release is published after that, and only if the whole cutover succeeded. Rerunning that job edits the existing release instead of failing.

## How to cut preview

From a clean editor `main` (no uncommitted files):

```bash
./previewrelease.sh            # or --dry-run to stop after preflight
```

Or Actions → **Preview Release**. The script pushes unpushed `main` commits, starts the workflow and watches it with `ci-watch.sh` until it finishes. You can start it before editor CI is green: the workflow waits for it. The version is `v0.0.N-pre.DATE` (monotonic N; DATE is the UTC day of the cut). A rolled-back preview creates no tag, so the next run reuses the same N. Notes are the Unreleased changelog diff since the previous preview; `CHANGELOG.md` is not rewritten.

Push website and collab `main` first (`push.sh` does) if those commits should be in this cutover.

To rehearse the rollback, start Preview Release by hand with `smoke_expect_editor` set to any wrong commit. The post-deploy wait then times out and the rollback job restores the snapshot.

## How to cut production

Production may only ship what a preview already shipped:

```bash
./release.sh vX.Y.Z            # or --dry-run
```

`release.sh` refuses unless editor, website and collab are on a clean `main` that is not behind `origin/main`, website and collab have nothing unpushed, the tag does not exist yet, and `scripts/check-preview-first.mjs` passes. That check loads `trio.json` from the newest GitHub prerelease, and requires its editor commit to be an ancestor of `HEAD` with only version files changed since (`webapp/coi-serviceworker.js`, `API.md`, `documentation/python/06-python-api.md`, `CHANGELOG.md`).

It then sets the version, turns `# Unreleased` into `# vX.Y.Z`, commits, pushes `main` and starts **Release** with `gh workflow run release.yml -f version=vX.Y.Z`. A rerun with the same version reuses those commits. `--dry-run` commits nothing and starts Release with `dry_run=true`.

The Release workflow repeats the version and preview-first checks, then runs the cutover against the preview's website and collab commits. Its `verify-e2e` uses the CI results of the preview's editor commit, since the release commit only changes versions. Editor CI on the release commit and the cutover's staging suite are skipped when the release commit is the same build as the preview's (see below).

## Same build

Work that already passed is not repeated. `scripts/same-build.mjs` proves that two editor commits build the same app: every changed file is one release.sh rewrites, and each is identical once its version string is masked (`VERSION` and `DISPLAY_VERSION` in `webapp/coi-serviceworker.js`, which every build overwrites anyway; the `**Version:**` line in `API.md` and `documentation/python/06-python-api.md`). `CHANGELOG.md` is neither shipped nor tested. Anything else, including API docs that were regenerated with new text, is a different build, and the tests run.

- **Editor CI** (`ci.yml`, job `tested-build`): on a push to `main`, it walks back the first-parent history while the commits are the same build. If one has a successful CI run whose `cloud-e2e-trio` names the website and collab commits CI would test now, the test, Playwright and staging jobs are skipped. The signatory check still runs. `workflow_dispatch` runs (from `push.sh` after sibling pushes) never skip.
- **Cutover** (`tested-build`, step 4 above): skips the staging redeploy and suite for the same build as the attested commit.

Keep `API.md` and the Python API handbook page current on `main` (`npm run generate-api-docs`). Otherwise the release commit regenerates them with new text, and production repeats the tests.

After the first successful production cutover, set the editor repository variable `PLUGINS_WORKER_LOCKED=production` so later preview cutovers do not roll that Worker back.

## Smoke accounts

`website/scripts/e2e-product-sessions.mjs` signs in `<local>+cp-e2e-<run>-<role>@gmail.com` with the sign-in code from the real mail (IMAP secrets below) and writes a Playwright storage state per role. Its `cleanup` mode always runs afterwards: it deletes the fonts those users own through the website (the same purge the app runs), then their D1 rows and the sign-in mail, and fails if any asset row or R2 object is left. Every delete is guarded by the plus-address check.

- **Preview** (`cloud-collab-preview` project, `tests/cloud-collab-preview-smoke.spec.ts`): an owner on the free trial saves a font, invites the invitee, the invitee accepts, and a nudge syncs between both browsers. Then the owner deletes the font.
- **Production** (`cloud-collab-product-smoke` project): one account loads the editor signed in without page errors. `wait-for-stack.mjs` already checked every commit, the schema and the room wiring.

Neither project is part of `npm run test:cloud-collab`, and neither retries: a second attempt would find the first one's font.

## Rules for changes that ship through the cutover

A rollback restores code, not data. So:

- D1 changes only add tables and columns. Never rename or drop in the same release that stops using them.
- Room storage, Durable Object storage and R2 layouts stay readable by the previous release.
- A Durable Object migration (new class, rename, delete) cannot be rolled back by redeploying the previous version. Ship it in a release of its own, preview it, and expect a manual fix if it has to be undone.

- Collaboration envelopes stay under the room's 64 KiB metadata cap. The shared fit function lives in the collab protocol package (`metadata-budget.js`, generated into `webapp/js/generated/collab-protocol-metadata-budget.ts`); the editor fits in `cloud-envelope-budget.ts` before persisting or sending, and the room fits what older editors send. Changing the fit steps changes what peers see, so keep every step one that receivers converge on (see `webapp/tests/cloud-envelope-budget.test.js`).

## Preview vs production hosts

| Role | Staging | Preview | Production |
| --- | --- | --- | --- |
| Editor Pages | `editorstaging` → https://staging.editor.counterpunch.space | `editorpreview` → https://preview.editor.counterpunch.space | `editor` → https://editor.counterpunch.space |
| Website Pages | `websitestaging` → https://staging.counterpunch.space | `websitepreview` → https://preview.counterpunch.space | `website` → https://counterpunch.space |
| Room | `room-staging` → https://staging.rooms.counterpunch.space | `room-preview` → https://preview.rooms.counterpunch.space | `room` |
| Validator / compactor | `validator-staging` / `compactor-staging` | `validator-preview` / `compactor-preview` | `validator` / `compactor` |
| Room R2 | `fonts-room-state-staging` | `fonts-room-state-preview` | `fonts-room-state` |
| D1 | `context_users_staging` | shared `context_users` | shared `context_users` |

Staging is public and exists to run the cloud-collab suite. It does not serve customers. `push.sh` deploys it and runs the suite. Preview Release and Release deploy the frozen SHAs there again and rerun the suite, unless staging still serves exactly those commits.

Proxied DNS on `counterpunch.space` (the deploy token cannot edit DNS):

- `staging` CNAME `websitestaging-58q.pages.dev`
- `staging.editor` CNAME `editorstaging.pages.dev`
- `staging.rooms` proxied the same way as `preview.rooms`, so the worker route `staging.rooms.counterpunch.space/*` receives traffic

Website preview must point `ROOM_WORKER_URL` at the preview room origin. JWT `AUTH_TOKEN_SECRET`, `CLOUD_*` website↔room tokens, and validator/compactor shared HMAC tokens live in the **Cloudflare dashboard**. Cutover does not re-upload them from GitHub.

## Pages deploy in GitHub Actions

Composed cutover deploys Pages with `cloudflare/wrangler-action` (`pages deploy … --project-name=…`). Do not use `cloudflare/pages-action`; GitHub can no longer resolve it.

## Editor Actions secrets

- `CLOUD_E2E_PAT` — GitHub PAT with contents **read + write** on private `website` and `collab` (checkout + sibling tags), and **Actions: Read** on those repos so cutover can require a green push run on the frozen SHAs. Contents read-only is not enough.
- `CLOUDFLARE_API_TOKEN` — one token Wrangler uses for Workers **and** Pages on both preview and production. It must include:
  - Account: Workers Scripts Edit (also used to read and restore Worker deployments for the rollback), Workers R2 Storage Edit (the smoke cleanup lists the room bucket), Cloudflare Pages Edit (Pages rollback), **D1 Edit** (cutover applies `schema.sql` to `context_users`, and the smoke cleanup deletes the plus-address users from that database)
  - Zone `counterpunch.space`: Workers Routes Edit (needed to attach `preview.rooms.counterpunch.space` / production room hostname). Account-only Workers Scripts is enough for `*.workers.dev` (validator/compactor) and fails on zone Worker routes with `No access to the specified resource`. DNS Edit is not required for that routes call.
- `CLOUDFLARE_ACCOUNT_ID`
- `SIGNUP_E2E_IMAP_USER` — Gmail address used only for the staging signup check and the smoke accounts (`…@gmail.com`)
- `SIGNUP_E2E_IMAP_PASS` — Google **App Password** for that mailbox (not the Google account password)
- `E2E_OPERATOR_TOKEN` — same value as the `websitestaging` Pages secret. Push CI and both cutovers send it as `Authorization` on the staging dev routes. It is not set on preview or production.

This is not the same as `CLOUD_E2E_PAT`. The PAT never talks to Cloudflare. Missing IMAP secrets fail the cutover closed (no silent skip).

## Real-email sign-in on staging

Sign-in uses six-digit codes sent by email. Push CI and the cutover's staging deploy check it twice with real mail (IMAP secrets below, `SIGNUP_E2E_D1_NAME=context_users_staging`):

- **Before the staging editor deploy**, `website/scripts/e2e-login-code-signup.mjs` signs up `+cp-e2e-{run_id}`: it reads the code from the inbox, checks that a wrong code is refused with tries left, signs in on the website, then asks for a second code from the staging editor origin and checks that the editor gets a working session token. It deletes the user and the mail.
- **After the staging editor deploy**, the `sign-in-live` Playwright project (`tests/sign-in-live.spec.ts`) signs in through the real UI: `+cp-e2e-{run_id}-website` on the website login page (a wrong code, then the pasted code), and `+cp-e2e-{run_id}-editor` from the editor's Cloud tab (resend, a wrong code, then the first code). The editor must sign in without a reload, keep the open font, and a second editor tab must follow. `e2e-login-code-signup.mjs cleanup --roles website,editor` always runs afterwards.

The project never retries: a second attempt would hit the resend cooldown and the account's wrong-code budget. On preview and production the smoke accounts sign in the same way. Local `npm run test:cloud-collab` still uses `AUTH_TOKEN_ALLOW_INSECURE_LOCAL_FALLBACK`.

## Staging secrets you set once

Copy each value from the preview resource in parentheses. The same name on two resources must be the same string. Generate `E2E_OPERATOR_TOKEN` and put it only on `websitestaging` and in the editor repo Actions secret `E2E_OPERATOR_TOKEN`.

- `validator-staging` (from `validator-preview`): `VALIDATOR_SHARED_TOKEN`
- `compactor-staging` (from `compactor-preview`): `COMPACTOR_SHARED_TOKEN`
- `room-staging` (from `room-preview`): `AUTH_TOKEN_SECRET`, `VALIDATOR_SHARED_TOKEN`, `COMPACTOR_SHARED_TOKEN`, `CLOUD_AUTHORIZE_SERVICE_TOKEN`, `CLOUD_ATTEST_SERVICE_TOKEN`, `CLOUD_ROOM_LIMITS_SERVICE_TOKEN`, `CLOUD_SHARD_OPS_SERVICE_TOKEN`, `ROOM_STATUS_SERVICE_TOKEN`
- `websitestaging` (from `websitepreview`): `RESEND_API_KEY`, `AUTH_TOKEN_SECRET`, `CLOUD_AUTHORIZE_SERVICE_TOKEN`, `CLOUD_ATTEST_SERVICE_TOKEN`, `CLOUD_ROOM_LIMITS_SERVICE_TOKEN`, `CLOUD_SHARD_OPS_SERVICE_TOKEN`, `COMPACTOR_SHARED_TOKEN`, `ROOM_STATUS_SERVICE_TOKEN`, plus the new `E2E_OPERATOR_TOKEN`
- `editorstaging`: none

Do not set `AUTH_TOKEN_ALLOW_INSECURE_LOCAL_FALLBACK` or `LOCAL_CLOUD_DEV_ENABLED` on staging. Leave Stripe, OpenRouter, `GITHUB_PLUGIN_CATALOG_TOKEN`, `ROOM_LOG_SERVICE_TOKEN`, and `ROOM_COMPACTOR_SERVICE_TOKEN` unset there.

### Operator setup (once, before the first cutover that includes this step)

1. Create a Gmail account used only for this gate.
2. [Google Account security](https://myaccount.google.com/security): turn on **2-Step Verification**.
3. Gmail → Settings → **See all settings** → **Forwarding and POP/IMAP** → **Enable IMAP** → Save.
4. [App passwords](https://myaccount.google.com/apppasswords): app **Mail**, device **Other** named `github-cutover`. Copy the 16-character password (shown once).
5. From another mailbox, send mail to `{local}+cp-e2e-probe@gmail.com` and confirm it arrives. If it bounces, stop.
6. Editor repo → Settings → Secrets → Actions: `SIGNUP_E2E_IMAP_USER`, `SIGNUP_E2E_IMAP_PASS` (App Password). Never store the Google password.
7. Same Cloudflare API token as `CLOUDFLARE_API_TOKEN`: add **Account → D1 → Edit**. The GitHub secret value does not change unless you rotate the token.
8. Cloudflare → Workers & Pages → **`websitepreview`** → Settings → Variables and secrets (production for that project): `RESEND_API_KEY` and `AUTH_TOKEN_SECRET`, copied from project **`website`**. Preview does not inherit production Pages secrets. Do not paste them into git or chat.

If Gmail blocks IMAP from GitHub-hosted IPs, the signup step fails and no trio tag is created. Switch the poller to Gmail API only then.

Optional repo variables: `WEBSITE_REPOSITORY`, `COLLAB_REPOSITORY`, `WEBSITE_SHA`, `COLLAB_SHA`.

## Sibling docs

- Website: `docs/composed-release.md`
- Collab: `docs/composed-release.md`
