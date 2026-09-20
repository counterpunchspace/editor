# Composed collab/website/editor releases

Cloud collaboration is three repos. A green editor CI run does not prove a website or room worker is safe with that editor.

The known-good trio is the matching git **tag** on all three repos plus `trio.json` attached to the editor GitHub release (and the `trio-preview` / `trio-production` workflow artifact). There is no pin file in git.

## How to cut a release

Preview: from editor `main`, `./previewrelease.sh` (or Actions → Preview Release). That waits for green editor CI, freezes editor/website/collab SHAs, runs `cloud-collab` e2e, then deploys **validator → compactor → room → websitepreview → editorpreview**, tags all three repos with the preview version, and publishes the prerelease.

Production: `./release.sh vX.Y.Z` still tags editor and runs Release. That job certifies the editor, then the same composed cutover deploys **production** `validator` / `compactor` / `room` / `website` / `editor` and tags website + collab with `vX.Y.Z`.

Do not `git push` website or collab `main` to ship Cloudflare. Those repos only run tests on `main`. Emergency production deploys exist as `workflow_dispatch` with confirm text `deploy-production`.

## Editor Actions secrets

- `CLOUD_E2E_PAT` — contents **read + write** on private `website` and `collab` (checkout, tags). Read-only is not enough.
- `CLOUDFLARE_API_TOKEN` — Workers **and** Pages on both preview and production (`room`, `room-preview`, `website`, `websitepreview`, `editor`, `editorpreview`, validator/compactor).
- `CLOUDFLARE_ACCOUNT_ID`

Worker JWT and `CLOUD_*` / shared tokens stay in the Cloudflare dashboard. Cutover does not re-upload them from GitHub.

Optional repo variables: `WEBSITE_REPOSITORY`, `COLLAB_REPOSITORY`, `WEBSITE_SHA`, `COLLAB_SHA` (freeze those refs instead of `main`).
