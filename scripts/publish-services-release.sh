#!/bin/bash

# Publish a services release (website and collab only) on the website repo,
# with trio.json attached. Editors read the editor repo's releases to offer
# updates, so services releases never go there.
# Reads release-notes.md and trio.json from the current directory.
# A rerun edits the existing release instead of failing.
# Usage: publish-services-release.sh <owner/website> <tag> <website_sha> prerelease|release

set -euo pipefail

REPO="${1:?website repo}"
TAG="${2:?tag}"
WEBSITE_SHA="${3:?website sha}"
KIND="${4:?prerelease or release}"

case "$KIND" in
    prerelease) KIND_FLAG=(--prerelease) ;;
    release) KIND_FLAG=(--prerelease=false --latest) ;;
    *)
        echo "Kind must be prerelease or release, got $KIND"
        exit 1
        ;;
esac

if [ ! -f trio.json ]; then
    echo "trio.json is missing"
    exit 1
fi

NOTES=$(mktemp)
if [ -f release-notes.md ]; then
    cat release-notes.md > "$NOTES"
fi
printf '\n\n## Deployed trio\n\n```json\n' >> "$NOTES"
cat trio.json >> "$NOTES"
printf '\n```\n' >> "$NOTES"

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    gh release edit "$TAG" --repo "$REPO" --title "$TAG" --notes-file "$NOTES" "${KIND_FLAG[@]}"
    gh release upload "$TAG" --repo "$REPO" trio.json --clobber
else
    gh release create "$TAG" --repo "$REPO" \
        --target "$WEBSITE_SHA" \
        --title "$TAG" \
        --notes-file "$NOTES" \
        "${KIND_FLAG[@]}" \
        trio.json
fi
echo "Published $TAG on $REPO."
