#!/bin/bash

# Cut a production release of what the newest preview shipped.
# Usage: ./release.sh <version-tag> [--dry-run]
# Example: ./release.sh v1.2.3
#
# Sets the version in the service worker and API docs, turns "# Unreleased" in
# CHANGELOG.md into the version section, pushes main, then starts release.yml
# and watches it with ci-watch.sh. The workflow creates the tags in all three
# repos only after the production smoke test passed. A rerun with the same
# version reuses the version and changelog commits.
# --dry-run commits nothing and runs the release workflow up to its preflight
# checks. See developer-docs/COMPOSED_RELEASE.md.

set -euo pipefail

cd "$(dirname "$0")"
EDITOR_DIR="$(pwd)"
WORKSPACE="$(cd "$EDITOR_DIR/.." && pwd)"

VERSION_TAG="${1:-}"
DRY_RUN=0
[ "${2:-}" = "--dry-run" ] && DRY_RUN=1

if [ -z "$VERSION_TAG" ]; then
    echo "Error: Version tag required"
    echo "Usage: ./release.sh <version-tag> [--dry-run]"
    echo "Example: ./release.sh v1.2.3"
    exit 1
fi
if ! [[ "$VERSION_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: Version tag must look like v1.2.3"
    exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
    echo "Error: GitHub CLI (gh) is required to start the release"
    exit 1
fi

SERVICE_WORKER_FILE="webapp/coi-serviceworker.js"
CHANGELOG_FILE="CHANGELOG.md"
API_MD_FILE="API.md"
HANDBOOK_API_FILE="documentation/python/06-python-api.md"

# Same checks as push.sh, but nothing may be left to push in the siblings:
# the release ships the website and collab commits the preview shipped.
for entry in "editor:$EDITOR_DIR" "website:$WORKSPACE/website" "collab:$WORKSPACE/collab/collab"; do
    name="${entry%%:*}"
    dir="${entry#*:}"
    branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD)
    if [ "$branch" != "main" ]; then
        echo "Error: $name is on '$branch', expected main"
        exit 1
    fi
    if [ -n "$(git -C "$dir" status --porcelain)" ]; then
        echo "Error: $name has uncommitted changes. Commit or stash first."
        exit 1
    fi
    git -C "$dir" fetch --quiet origin main --tags
    behind=$(git -C "$dir" rev-list --count HEAD..origin/main)
    if [ "$behind" -gt 0 ]; then
        echo "Error: $name is $behind commit(s) behind origin/main. Pull first."
        exit 1
    fi
    if [ "$name" != "editor" ] && [ "$(git -C "$dir" rev-list --count origin/main..HEAD)" -gt 0 ]; then
        echo "Error: $name has unpushed commits. Push them and cut a preview first."
        exit 1
    fi
done

existing=$(git ls-remote origin "refs/tags/${VERSION_TAG}" "refs/tags/${VERSION_TAG}^{}" | tail -1 | cut -f1)
if [ -n "$existing" ]; then
    echo "Error: tag $VERSION_TAG already exists on $existing"
    exit 1
fi

echo "Checking that the newest preview shipped this editor..."
node scripts/check-preview-first.mjs HEAD

# Runs created before this are an earlier attempt on the same SHA.
WATCH_SINCE=$(date +%s)
: "${CI_WATCH_TIMEOUT:=21600}"
export CI_WATCH_TIMEOUT

if [ "$DRY_RUN" -eq 1 ]; then
    if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
        echo "Error: a dry run needs main pushed, since it commits nothing"
        exit 1
    fi
    echo "Dry run: committing nothing and starting release.yml up to the preflight checks..."
    gh workflow run release.yml --ref main -f version="$VERSION_TAG" -f dry_run=true
    exec "$EDITOR_DIR/ci-watch.sh" --since "$WATCH_SINCE" "$EDITOR_DIR"
fi

echo "Preparing release $VERSION_TAG..."
sed_inplace() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "$@"
    else
        sed -i "$@"
    fi
}

sed_inplace "s/const VERSION = '[^']*'/const VERSION = '$VERSION_TAG'/" "$SERVICE_WORKER_FILE"
sed_inplace "s/const DISPLAY_VERSION = '[^']*'/const DISPLAY_VERSION = '$VERSION_TAG'/" "$SERVICE_WORKER_FILE"
node scripts/generate-api-docs.mjs "$VERSION_TAG"
git add "$SERVICE_WORKER_FILE" "$API_MD_FILE" "$HANDBOOK_API_FILE"
if ! git diff --cached --quiet; then
    git commit -m "Update version to $VERSION_TAG in API docs and service worker"
fi

if grep -qE "^# $VERSION_TAG( |$)" "$CHANGELOG_FILE"; then
    echo "CHANGELOG already has '# $VERSION_TAG'; reusing it"
elif grep -q "^# Unreleased" "$CHANGELOG_FILE"; then
    sed_inplace "s/^# Unreleased/# $VERSION_TAG/" "$CHANGELOG_FILE"
    sed_inplace '1s/^/# Unreleased\n\n- **Add items here** for the next release (Replace this comment)\n\n/' "$CHANGELOG_FILE"
    git add "$CHANGELOG_FILE"
    git commit -m "Update CHANGELOG for release $VERSION_TAG"
else
    echo "Error: CHANGELOG.md has neither '# Unreleased' nor '# $VERSION_TAG'"
    exit 1
fi

echo "Release notes:"
echo "----------------------------------------"
awk "/^# $VERSION_TAG/ {flag=1; next} /^# / {flag=0} flag {print}" "$CHANGELOG_FILE"
echo "----------------------------------------"

if [ -n "$(git status --porcelain)" ]; then
    echo "Error: the version update left uncommitted changes:"
    git status --porcelain | head -10
    exit 1
fi

git push origin main
echo "Starting release.yml for $VERSION_TAG..."
gh workflow run release.yml --ref main -f version="$VERSION_TAG"

echo ""
echo "Release $VERSION_TAG started. Watching CI and the Release workflow until they finish..."
echo "The release will be at: https://github.com/counterpunchspace/editor/releases/tag/$VERSION_TAG"
exec "$EDITOR_DIR/ci-watch.sh" --since "$WATCH_SINCE" "$EDITOR_DIR"
