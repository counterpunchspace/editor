#!/bin/bash

# Release gate for the cloud-collab Playwright suite. That suite runs in
# editor CI (ci.yml), and uploads `cloud-e2e-trio` only when every shard passed.
# A release does not rerun it. This waits until no CI run on main is still
# running for the editor commit, then accepts the newest successful run
# (push or push.sh's workflow_dispatch) whose attestation names exactly the
# website and collab commits being deployed.
# Usage: verify-cloud-e2e-attestation.sh <editor_sha> <website_sha> <collab_sha>

set -euo pipefail

cd "$(dirname "$0")/.."

EDITOR_SHA="${1:?editor sha}"
WEBSITE_SHA="${2:?website sha}"
COLLAB_SHA="${3:?collab sha}"
DEADLINE=$((SECONDS + 5400))

main_runs() {
    gh run list --workflow=ci.yml --commit="$EDITOR_SHA" --limit 20 \
        --json databaseId,status,conclusion,event,headBranch \
        --jq '[.[] | select((.event=="push" or .event=="workflow_dispatch") and .headBranch=="main")] | sort_by(.databaseId) | reverse'
}

while :; do
    runs=$(main_runs)
    running=$(printf '%s\n' "$runs" | jq -r '[.[] | select(.status!="completed")][0].databaseId // empty')
    if [ -z "$running" ]; then
        break
    fi
    if [ "$SECONDS" -ge "$DEADLINE" ]; then
        echo "Timed out waiting for CI run $running on $EDITOR_SHA"
        exit 1
    fi
    echo "CI run $running on $EDITOR_SHA is still running; watching it..."
    gh run watch "$running" >/dev/null 2>&1 || true
done

successful=$(printf '%s\n' "$runs" | jq -r '.[] | select(.conclusion=="success") | .databaseId')
if [ -z "$successful" ]; then
    echo "No successful CI run on main for $EDITOR_SHA"
    exit 1
fi

for run_id in $successful; do
    work=$(mktemp -d)
    if ! gh run download "$run_id" --name cloud-e2e-trio --dir "$work" >/dev/null 2>&1; then
        echo "CI run $run_id has no cloud-e2e-trio attestation"
        continue
    fi
    tested_website=$(jq -r '.website' "$work/cloud-e2e-trio.json")
    tested_collab=$(jq -r '.collab' "$work/cloud-e2e-trio.json")
    if [ "$tested_website" = "$WEBSITE_SHA" ] && [ "$tested_collab" = "$COLLAB_SHA" ]; then
        cat "$work/cloud-e2e-trio.json"
        echo "cloud-collab e2e verified for the deploying trio by CI run $run_id."
        exit 0
    fi
    echo "CI run $run_id tested website $tested_website and collab $tested_collab"
done

echo "No successful CI run on $EDITOR_SHA tested website $WEBSITE_SHA and collab $COLLAB_SHA."
echo "Run push.sh, or start ci.yml on main, so CI tests the current website and collab."
exit 1
