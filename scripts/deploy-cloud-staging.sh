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
    # The repo root has no wrangler, so npx fetches one. npm sometimes skips
    # workerd's platform binary, which leaves a broken npx cache.
    deploy() { npx wrangler pages deploy ./webapp/build --project-name=editorstaging --branch main --commit-dirty=true; }
    deploy || { rm -rf "$(npm config get cache)/_npx"; deploy; }
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

echo "Staging collab $(git -C "$COLLAB_ROOT" rev-parse --short HEAD) website $(git -C "$WEBSITE_ROOT" rev-parse --short HEAD)"

deploy_worker "$COLLAB_ROOT/workers/validator"
deploy_worker "$COLLAB_ROOT/workers/compactor"
deploy_worker "$COLLAB_ROOT/workers/room"

(
  cd "$WEBSITE_ROOT"
  npx wrangler d1 execute context_users_staging --remote --yes --file=schema.sql --config wrangler.websitestaging.toml
  D1_DATABASE=context_users_staging WRANGLER_CONFIG=wrangler.websitestaging.toml node scripts/ensure-receipt-columns.mjs
  (
    cd "$WEBSITE_ROOT/plugins-worker"
    npm install --omit=dev
    # The image build is not reproducible, so every deploy would push a new
    # digest and roll every container onto it; the first preflights then wait
    # minutes for the pull. Roll out only when the container sources change.
    container_tag="container-$(find Dockerfile container -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)"
    deployed_tag=$(npx wrangler versions list --env staging --json 2>/dev/null |
      node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{const v=JSON.parse(s);process.stdout.write(v[v.length-1]?.annotations?.["workers/tag"]||"")}catch{}})' || true)
    rollout=()
    if [ "$deployed_tag" = "$container_tag" ]; then
      echo "Preflight container sources unchanged ($container_tag); skipping the container rollout."
      rollout=(--containers-rollout=none)
    fi
    set +e
    deploy_output=$(npx wrangler deploy --env staging --tag "$container_tag" "${rollout[@]}" 2>&1)
    deploy_code=$?
    set -e
    printf '%s\n' "$deploy_output"
    if [ "$deploy_code" -ne 0 ]; then
      if printf '%s\n' "$deploy_output" | grep -q "containers/me"; then
        echo "Warning: plugins-staging was not deployed. The Cloudflare API token cannot access Containers."
      else
        exit "$deploy_code"
      fi
    fi
  )
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
