#!/bin/bash

# Push collab, website and editor (in that order) when they have unpushed commits.
# Siblings go first so the editor CI, which deploys staging and runs the
# cloud-collab e2e against those hostnames, tests what you just pushed.
# If the editor itself has nothing to push, this starts that same CI on
# editor main so the website and collab you just pushed still get deployed.
# Afterwards it runs ci-watch.sh and exits with its status (0 green, 1 red).
# Usage: ./push.sh [--dry-run]

set -euo pipefail

EDITOR_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="$(cd "$EDITOR_DIR/.." && pwd)"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

REPOS=(
    "collab:$WORKSPACE/collab/collab"
    "website:$WORKSPACE/website"
    "editor:$EDITOR_DIR"
)

# Check every repo before pushing any, so a problem in the last one does not
# leave the trio half pushed.
TO_PUSH=()
for entry in "${REPOS[@]}"; do
    name="${entry%%:*}"
    dir="${entry#*:}"

    branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD)
    if [ "$branch" != "main" ]; then
        echo "Error: $name is on '$branch', expected main"
        exit 1
    fi
    dirty=$(git -C "$dir" status --porcelain)
    if [ -n "$dirty" ]; then
        echo "Error: $name has uncommitted changes (unstaged, staged or untracked). Commit first:"
        echo "$dirty" | head -10 | sed 's/^/    /'
        [ "$(echo "$dirty" | wc -l)" -gt 10 ] && echo "    ..."
        exit 1
    fi

    git -C "$dir" fetch --quiet origin main
    ahead=$(git -C "$dir" rev-list --count origin/main..HEAD)
    behind=$(git -C "$dir" rev-list --count HEAD..origin/main)
    if [ "$behind" -gt 0 ]; then
        echo "Error: $name is $behind commit(s) behind origin/main (ahead $ahead). Pull or rebase first."
        exit 1
    fi

    if [ "$ahead" -gt 0 ]; then
        echo "$name: $ahead commit(s) to push"
        git -C "$dir" log --oneline origin/main..HEAD | sed 's/^/    /'
        TO_PUSH+=("$entry")
    else
        echo "$name: up to date"
    fi
done

if [ "${#TO_PUSH[@]}" -eq 0 ]; then
    echo "Nothing to push."
    exit 0
fi

EDITOR_PUSHED=0
for entry in "${TO_PUSH[@]}"; do
    [ "${entry%%:*}" = "editor" ] && EDITOR_PUSHED=1
done

if [ "$DRY_RUN" -eq 1 ]; then
    echo "Dry run: nothing pushed."
    if [ "$EDITOR_PUSHED" -eq 0 ]; then
        echo "Dry run: would start the editor CI so staging deploys."
    fi
    exit 0
fi

# Captured before the pushes so a run that starts immediately is still inside
# ci-watch's grace window. --since also keeps a workflow_dispatch visible.
WATCH_SINCE=$(date +%s)

for entry in "${TO_PUSH[@]}"; do
    name="${entry%%:*}"
    dir="${entry#*:}"
    echo "Pushing $name..."
    git -C "$dir" push origin main
done

if [ "$EDITOR_PUSHED" -eq 0 ]; then
    echo "Editor has no new commit. Starting its CI so staging deploys."
    (cd "$EDITOR_DIR" && gh workflow run ci.yml --ref main)
fi

echo ""
echo "Pushed. Watching CI (the editor run deploys staging and runs the cloud-collab e2e)..."
WATCH_ARGS=(--since "$WATCH_SINCE")
for entry in "${TO_PUSH[@]}"; do
    WATCH_ARGS+=("${entry#*:}")
done
if [ "$EDITOR_PUSHED" -eq 0 ]; then
    WATCH_ARGS+=("$EDITOR_DIR")
fi
exec "$EDITOR_DIR/ci-watch.sh" "${WATCH_ARGS[@]}"
