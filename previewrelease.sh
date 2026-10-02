#!/bin/bash

# Push main and start the preview-release workflow, then watch it with
# ci-watch.sh until it finishes. The workflow itself waits for green editor CI
# on HEAD, then composed-cutover (preview workers + websitepreview +
# editorpreview), tags the trio, and attaches trio.json to the GitHub
# prerelease. See developer-docs/COMPOSED_RELEASE.md.
# Usage: ./previewrelease.sh

set -e

cd "$(dirname "$0")"

if ! command -v gh >/dev/null 2>&1; then
    echo "Error: GitHub CLI (gh) is required to start the preview release"
    exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
    echo "Error: preview releases must be cut from main (currently on $CURRENT_BRANCH)"
    exit 1
fi

if ! git diff --quiet --exit-code || ! git diff --cached --quiet --exit-code; then
    echo "Error: uncommitted changes. Commit or stash before cutting a preview release."
    exit 1
fi

EDITOR_DIR="$(pwd)"
# Runs created before this are an earlier attempt on the same SHA.
WATCH_SINCE=$(date +%s)

echo "Fetching origin/main and tags..."
git fetch origin main --tags

if ! git merge-base --is-ancestor origin/main HEAD; then
    echo "Error: local main is behind or has diverged from origin/main"
    exit 1
fi

if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    echo "Pushing unpushed main commits..."
    git push origin main
else
    echo "main is already up to date with origin/main"
fi

echo "Starting Preview Release workflow on main..."
gh workflow run preview-release.yml --ref main

echo ""
echo "Preview Release started. Watching until it finishes..."
# Sibling CI waits inside the workflow can run 90 minutes each.
: "${CI_WATCH_TIMEOUT:=21600}"
export CI_WATCH_TIMEOUT
exec "$EDITOR_DIR/ci-watch.sh" --since "$WATCH_SINCE" "$EDITOR_DIR"
