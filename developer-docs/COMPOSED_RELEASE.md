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

## How to cut preview

From a clean editor `main` (no uncommitted files):

```bash
./previewrelease.sh
```

Or Actions → **Preview Release**. You do not need to wait for CI locally. The workflow:

1. Checks out the `main` SHA it was dispatched on.
2. Waits for a successful editor `ci.yml` **push** run on **that SHA** (up to 90 minutes). If that run fails or is cancelled, it refuses to publish.
3. Freezes editor / website / collab SHAs (`main`, or `WEBSITE_SHA` / `COLLAB_SHA` if those repo variables are set).
4. Runs cloud-collab Playwright e2e on the frozen trio.
5. Deploys **validator → compactor → room → website Pages**, then a **real-email signup gate** against the live website origin, then **editor Pages**.
6. Tags all three repos with the preview version (`v0.0.N-pre.DATE`, monotonic N; DATE is the UTC day of the cut).
7. Publishes the GitHub prerelease with Unreleased changelog notes plus `trio.json`.

It does not rewrite `CHANGELOG.md`. Push website and collab `main` first if those SHAs should be in this cutover; editor does not wait for sibling CI.

## How to cut production

```bash
./release.sh vX.Y.Z
```

That still bumps the editor version, extracts notes from `CHANGELOG.md`, commits, and pushes tag `vX.Y.Z`. The **Release** workflow certifies that editor tag (not a `-pre.` tag), then the same composed cutover deploys **production** workers and Pages and tags website + collab with `vX.Y.Z`.

## Preview vs production hosts

| Role | Preview | Production |
| --- | --- | --- |
| Editor Pages | `editorpreview` → https://preview.editor.counterpunch.space | `editor` → https://editor.counterpunch.space |
| Website Pages | `websitepreview` → https://preview.counterpunch.space | `website` → https://counterpunch.space |
| Room | `room-preview` → https://preview.rooms.counterpunch.space | `room` |
| Validator / compactor | `validator-preview` / `compactor-preview` | `validator` / `compactor` |
| Room R2 | `fonts-room-state-preview` | `fonts-room-state` |

Website preview must point `ROOM_WORKER_URL` at the preview room origin. JWT `AUTH_TOKEN_SECRET`, `CLOUD_*` website↔room tokens, and validator/compactor shared HMAC tokens live in the **Cloudflare dashboard**. Cutover does not re-upload them from GitHub.

## Pages deploy in GitHub Actions

Composed cutover deploys Pages with `cloudflare/wrangler-action` (`pages deploy … --project-name=…`). Do not use `cloudflare/pages-action`; GitHub can no longer resolve it.

## Editor Actions secrets

- `CLOUD_E2E_PAT` — GitHub PAT with contents **read + write** on private `website` and `collab` (checkout + sibling tags). Read-only is not enough.
- `CLOUDFLARE_API_TOKEN` — one token Wrangler uses for Workers **and** Pages on both preview and production. It must include:
  - Account: Workers Scripts Edit, Workers R2 Storage Edit, Cloudflare Pages Edit, **D1 Edit** (signup gate deletes the plus-address user from `context_users`)
  - Zone `counterpunch.space`: Workers Routes Edit (needed to attach `preview.rooms.counterpunch.space` / production room hostname). Account-only Workers Scripts is enough for `*.workers.dev` (validator/compactor) and fails on zone Worker routes with `No access to the specified resource`. DNS Edit is not required for that routes call.
- `CLOUDFLARE_ACCOUNT_ID`
- `SIGNUP_E2E_IMAP_USER` — Gmail address used only for the cutover magic-link gate (`…@gmail.com`)
- `SIGNUP_E2E_IMAP_PASS` — Google **App Password** for that mailbox (not the Google account password)

This is not the same as `CLOUD_E2E_PAT`. The PAT never talks to Cloudflare. Missing IMAP secrets fail the cutover closed (no silent skip).

## Real-email signup gate

After website Pages deploy and before editor Pages, cutover `POST`s `/api/auth/request-login` to `https://preview.counterpunch.space` or `https://counterpunch.space`, polls Gmail IMAP for the Resend mail, `GET`s `/api/auth/verify`, then deletes the `+cp-e2e-{run_id}` user from shared D1 `context_users`. Local cloud-collab e2e still uses `AUTH_TOKEN_ALLOW_INSECURE_LOCAL_FALLBACK`; this gate is not in `ci.yml`.

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
