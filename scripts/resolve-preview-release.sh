#!/bin/bash

# Resolve preview tag and Unreleased notes.
# Does not create a GitHub tag or release.
# When GITHUB_OUTPUT is set, writes TAG, COMMIT_SHA, COMMIT_SHORT.
# Always writes release-notes.md in the repo root.
#
# Tag: v0.0.N-pre.DATE (N monotonic across days; DATE is the UTC day of this cut).

set -e

cd "$(dirname "$0")/.."

CHANGELOG_FILE="CHANGELOG.md"
RELEASE_NOTES_FILE="release-notes.md"

DATE=$(date -u +"%Y%m%d")
COMMIT_SHA=$(git rev-parse HEAD)
COMMIT_SHORT=$(git rev-parse --short HEAD)

git fetch origin --tags --force >/dev/null 2>&1 || true

TAG=""
PREV_TAG=""
NEXT_N=""
while IFS= read -r line; do
    case "$line" in
        TAG=*) TAG=${line#TAG=} ;;
        PREV_TAG=*) PREV_TAG=${line#PREV_TAG=} ;;
        NEXT_N=*) NEXT_N=${line#NEXT_N=} ;;
    esac
done < <(
    git tag -l 'v0.0.*-pre.*' 'v0.0.*-preview.*' |
        node scripts/preview-version.mjs --date="$DATE"
)

if [ -z "$TAG" ]; then
    echo "Error: could not resolve next preview version"
    exit 1
fi

if git ls-remote --exit-code --tags origin "refs/tags/${TAG}" >/dev/null 2>&1; then
    echo "Error: remote tag $TAG already exists"
    exit 1
fi

echo "Previous preview: ${PREV_TAG:-<none>}"
echo "Next tag: $TAG"

OLD_CHANGELOG=$(mktemp)
cleanup() {
    rm -f "$OLD_CHANGELOG"
}
trap cleanup EXIT

if [ -n "$PREV_TAG" ]; then
    git show "${PREV_TAG}:CHANGELOG.md" > "$OLD_CHANGELOG"
else
    # Services tags (<version>+s.N) point at a release's editor commit.
    STABLE_TAG=$(git tag -l 'v*' | grep -vE 'preview|-pre\.|\+s\.' | sort -V | tail -1 || true)
    if [ -n "$STABLE_TAG" ]; then
        echo "First preview notes vs last stable tag $STABLE_TAG"
        git show "${STABLE_TAG}:CHANGELOG.md" > "$OLD_CHANGELOG"
    else
        : > "$OLD_CHANGELOG"
    fi
fi

node scripts/unreleased-changelog-diff.mjs "$OLD_CHANGELOG" "$CHANGELOG_FILE" \
    > "$RELEASE_NOTES_FILE"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "TAG=$TAG" >> "$GITHUB_OUTPUT"
    echo "COMMIT_SHA=$COMMIT_SHA" >> "$GITHUB_OUTPUT"
    echo "COMMIT_SHORT=$COMMIT_SHORT" >> "$GITHUB_OUTPUT"
fi
