#!/usr/bin/env bash
# Deploy the frozen trio to the staging Workers and Pages projects.
# Product hostnames are not touched.
#
#   deploy-cloud-staging.sh site     workers, staging D1 schema, websitestaging
#   deploy-cloud-staging.sh editor   editorstaging
#
# site runs before the magic-link check. editor runs after that check passes.
# Compactor's Durable Object binding names the script room-staging, so that
# script has to exist before the first compactor deploy.
# Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
set -euo pipefail

PHASE="${1:-site}"
EDITOR_ROOT="${EDITOR_ROOT:-}"
WEBSITE_ROOT="${WEBSITE_ROOT:-}"
COLLAB_ROOT="${COLLAB_ROOT:-}"
COMMIT_SHA="${COMMIT_SHA:-}"

if [ "$PHASE" != "site" ] && [ "$PHASE" != "editor" ]; then
  echo "usage: deploy-cloud-staging.sh [site|editor]" >&2
  exit 1
fi

export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

if [ "$PHASE" = "editor" ]; then
  if [ -z "$EDITOR_ROOT" ]; then
    echo "EDITOR_ROOT is required" >&2
    exit 1
  fi
  if [ ! -d "$EDITOR_ROOT/webapp/build" ]; then
    echo "Missing $EDITOR_ROOT/webapp/build. Build the editor first." >&2
    exit 1
  fi
  (
    cd "$EDITOR_ROOT"
    npx wrangler pages deploy ./webapp/build --project-name=editorstaging --branch main --commit-dirty=true
  )
  exit 0
fi

if [ -z "$WEBSITE_ROOT" ] || [ -z "$COLLAB_ROOT" ]; then
  echo "WEBSITE_ROOT and COLLAB_ROOT are required" >&2
  exit 1
fi
if [ ! -d "$WEBSITE_ROOT/dist" ]; then
  echo "Missing $WEBSITE_ROOT/dist. Build the website first." >&2
  exit 1
fi

deploy_worker() {
  local dir="$1"
  (
    cd "$dir"
    npx wrangler deploy --env staging --var "COMMIT_SHA:${COMMIT_SHA:-unknown}"
  )
}

deploy_worker "$COLLAB_ROOT/workers/validator"
deploy_worker "$COLLAB_ROOT/workers/compactor"
deploy_worker "$COLLAB_ROOT/workers/room"

(
  cd "$WEBSITE_ROOT"
  npx wrangler d1 execute context_users_staging --remote --yes --file=schema.sql --config wrangler.websitestaging.toml
  # Hide every wrangler config. pages deploy would otherwise upload
  # production context_users from wrangler.toml, or replace dashboard
  # secrets from a file that does not contain them.
  moved=()
  restore_configs() {
    local entry name bak
    for entry in "${moved[@]}"; do
      name="${entry%%|*}"
      bak="${entry#*|}"
      if [ -f "$bak" ]; then
        mv "$bak" "$name"
      fi
    done
  }
  trap restore_configs EXIT
  for name in wrangler.toml wrangler.websitestaging.toml wrangler.websitepreview.toml; do
    if [ -f "$name" ]; then
      mv "$name" "$name.staging-bak"
      moved+=("$name|$name.staging-bak")
    fi
  done
  npx wrangler pages deploy dist --project-name=websitestaging --branch main --commit-dirty=true
)
