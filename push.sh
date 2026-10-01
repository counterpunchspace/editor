#!/bin/bash

# Push collab, website and editor (in that order) when they have unpushed commits.
# Siblings go first so the editor CI, which runs the cloud-collab e2e against
# their main, tests what you just pushed.
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

if [ "$DRY_RUN" -eq 1 ]; then
    echo "Dry run: nothing pushed."
    exit 0
fi

for entry in "${TO_PUSH[@]}"; do
    name="${entry%%:*}"
    dir="${entry#*:}"
    echo "Pushing $name..."
    git -C "$dir" push origin main
done

echo ""
echo "Pushed. Watching CI (the editor run includes the cloud-collab e2e)..."
WATCH_ARGS=()
for entry in "${TO_PUSH[@]}"; do
    WATCH_ARGS+=("${entry#*:}")
done
exec "$EDITOR_DIR/ci-watch.sh" "${WATCH_ARGS[@]}"
