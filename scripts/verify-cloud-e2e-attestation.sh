#!/bin/bash

# Release gate for the cloud-collab Playwright suite. That suite runs once, in
# editor CI (ci.yml), and uploads `cloud-e2e-trio` only when every shard passed.
# A release does not rerun it. It waits for the CI run on the editor commit,
# then checks the attested website and collab commits match the ones deploying.
# Usage: verify-cloud-e2e-attestation.sh <editor_sha> <website_sha> <collab_sha>

set -euo pipefail

cd "$(dirname "$0")/.."

EDITOR_SHA="${1:?editor sha}"
WEBSITE_SHA="${2:?website sha}"
COLLAB_SHA="${3:?collab sha}"

bash scripts/wait-for-green-ci.sh "" "$EDITOR_SHA" ci.yml

RUN_ID=$(gh run list --workflow=ci.yml --commit="$EDITOR_SHA" --limit 20 \
    --json databaseId,event,conclusion \
    --jq '[.[] | select(.event=="push" and .conclusion=="success")] | sort_by(.databaseId) | last | .databaseId')
if [ -z "$RUN_ID" ] || [ "$RUN_ID" = "null" ]; then
    echo "No successful CI push run found for $EDITOR_SHA"
    exit 1
fi

WORK=$(mktemp -d)
gh run download "$RUN_ID" --name cloud-e2e-trio --dir "$WORK"
cat "$WORK/cloud-e2e-trio.json"

TESTED_WEBSITE=$(jq -r '.website' "$WORK/cloud-e2e-trio.json")
TESTED_COLLAB=$(jq -r '.collab' "$WORK/cloud-e2e-trio.json")

if [ "$TESTED_WEBSITE" != "$WEBSITE_SHA" ] || [ "$TESTED_COLLAB" != "$COLLAB_SHA" ]; then
    echo "The cloud-collab e2e in CI run $RUN_ID tested a different trio:"
    echo "  website tested $TESTED_WEBSITE, deploying $WEBSITE_SHA"
    echo "  collab  tested $TESTED_COLLAB, deploying $COLLAB_SHA"
    echo "Rerun the editor CI so it tests the current website and collab:"
    echo "  gh run rerun $RUN_ID"
    exit 1
fi

echo "cloud-collab e2e verified for the deploying trio."
