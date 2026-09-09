# Composed collab/website/editor releases

The editor is one of three independently deployed collaboration pieces (collab workers, website control plane, this editor). A green editor CI run does **not** prove that combination is safe. Protocol, schema, cloud WAL, and recovery changes can pass here and still fail against a different website or room worker.

The known-good trio lives in the website repo as `PINNED_REVISIONS.json`. Ordinary green `webapp` tests do not require a pin bump. Bump those hashes only when declaring a new **production** collab/website/editor set. The website copy of this note is `docs/composed-release.md`.

## What this repo does today

- `./release.sh` tags this repo and GitHub Actions deploys that tag to Cloudflare Pages. That path does not require matching collab/website SHAs.
- Preview cuts (`./previewrelease.sh`) are the same: editor-only.
- The `cloud-collab-e2e` CI job checkouts website and collab from `WEBSITE_SHA` / `COLLAB_SHA` repo variables, or `main` if those are empty. It does not read `PINNED_REVISIONS.json`.
- Collab still deploys every green `main` push. Website CI pins one hardcoded collab SHA and does not pin this editor.

There is no promote job that checks out one exact trio, runs composed certification, and then deploys those three revisions in cutover order.

## Recommendation

Do this before opening cloud collaboration beyond an internal cohort. Keep it lightweight; do not build a certification platform.

1. Keep CI, preview, and `./previewrelease.sh` independent so day-to-day editor work stays cheap.
2. Stop treating an editor tag deploy as a production collaboration release by itself.
3. Add one **manually triggered promote** workflow (owned by any of the three repos) with collab, website, and editor SHA inputs.
4. Check out those exact revisions, run composed tests including `npm run test:cloud-collab` and the integrity gates in the collab alpha cutover docs, and fail closed.
5. If green, deploy in documented order (website control plane, validator, compactor, room, **then** this editor) and write an immutable artifact that records the trio.
6. Add cryptographic attestations later only if independent deploys keep bypassing the gate.

This slows production hotfixes and requires coordinated SHAs. That cost is worth it for alpha cutover. It is not needed for local `npm run serve` or an internal-only prototype.
