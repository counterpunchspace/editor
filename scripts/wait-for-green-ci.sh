#!/bin/bash

# Wait until a workflow has a successful push run for a commit.
# No args: this editor repo, ci.yml, HEAD (Preview Release, before cutover).
# Args: <owner/repo> <sha> <workflow-file>

set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v gh >/dev/null 2>&1; then
    echo "Error: GitHub CLI (gh) is required"
    exit 1
fi

REPO="${1:-}"
COMMIT_SHA="${2:-}"
WORKFLOW="${3:-ci.yml}"

if [ -z "$COMMIT_SHA" ]; then
    COMMIT_SHA=$(git rev-parse HEAD)
fi

LABEL="${REPO:-editor}"
DEADLINE=$((SECONDS + 5400))

echo "Waiting for a green $WORKFLOW push run on $LABEL $COMMIT_SHA"

latest_push_run() {
    local -a args
    args=(run list --workflow="$WORKFLOW" --commit="$COMMIT_SHA" --limit 20 --json databaseId,status,conclusion,event)
    if [ -n "$REPO" ]; then
        args+=(--repo "$REPO")
    fi
    gh "${args[@]}" --jq '[.[] | select(.event=="push")] | sort_by(.databaseId) | last // empty'
}

watch_run() {
    if [ -n "$REPO" ]; then
        gh run watch "$1" --repo "$REPO" --exit-status
    else
        gh run watch "$1" --exit-status
    fi
}

while [ "$SECONDS" -lt "$DEADLINE" ]; do
    run_json=$(latest_push_run)
    if [ -z "$run_json" ] || [ "$run_json" = "null" ]; then
        echo "No CI push run yet for $LABEL; retrying in 20s..."
        sleep 20
        continue
    fi

    run_id=$(printf '%s\n' "$run_json" | jq -r '.databaseId')
    status=$(printf '%s\n' "$run_json" | jq -r '.status')
    conclusion=$(printf '%s\n' "$run_json" | jq -r '.conclusion // empty')

    echo "$LABEL CI run $run_id status=$status conclusion=${conclusion:-<none>}"

    if [ "$status" = "completed" ]; then
        if [ "$conclusion" = "success" ]; then
            echo "CI is green for $LABEL $COMMIT_SHA"
            exit 0
        fi
        echo "Error: $LABEL CI run $run_id concluded $conclusion; refusing to publish"
        exit 1
    fi

    echo "$LABEL CI still running; watching run $run_id..."
    watch_status=0
    watch_run "$run_id" || watch_status=$?
    if [ "$watch_status" -eq 0 ]; then
        echo "CI is green for $LABEL $COMMIT_SHA"
        exit 0
    fi
    echo "Error: $LABEL CI run $run_id did not succeed; refusing to publish"
    exit 1
done

echo "Error: timed out waiting for a green $WORKFLOW push run on $LABEL $COMMIT_SHA"
exit 1
