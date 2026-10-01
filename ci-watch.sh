#!/bin/bash

# Watch GitHub CI for pushed commits, once a minute, until everything is green
# or something is red.
#
# Exit 0: every run for every commit succeeded.
# Exit 1: a run or job failed (failed job, step and error lines are printed).
# Exit 2: gave up waiting (no CI run appeared, or the 3 hour limit passed).
#
# Usage: ./ci-watch.sh                     # HEAD of collab, website and editor
#        ./ci-watch.sh <dir>[:<sha>] ...   # specific repos (sha defaults to HEAD)
# Env:   CI_WATCH_INTERVAL (seconds, default 60), CI_WATCH_TIMEOUT (default 10800)

set -uo pipefail

EDITOR_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="$(cd "$EDITOR_DIR/.." && pwd)"
INTERVAL="${CI_WATCH_INTERVAL:-60}"
TIMEOUT="${CI_WATCH_TIMEOUT:-10800}"
NO_RUN_GRACE=600

for tool in gh jq; do
    command -v "$tool" >/dev/null 2>&1 || { echo "Error: $tool is required"; exit 2; }
done

ARGS=("$@")
if [ "${#ARGS[@]}" -eq 0 ]; then
    ARGS=("$WORKSPACE/collab/collab" "$WORKSPACE/website" "$EDITOR_DIR")
fi

# Parallel arrays: label, GitHub repo, commit sha.
LABELS=()
REPOS=()
SHAS=()
for arg in "${ARGS[@]}"; do
    dir="${arg%%:*}"
    sha=""
    [ "$arg" != "$dir" ] && sha="${arg#*:}"
    [ -z "$sha" ] && sha=$(git -C "$dir" rev-parse HEAD)
    repo=$(cd "$dir" && gh repo view --json nameWithOwner --jq .nameWithOwner)
    LABELS+=("$(basename "$repo")")
    REPOS+=("$repo")
    SHAS+=("$sha")
done

is_red() {
    case "$1" in
        failure|cancelled|timed_out|startup_failure|action_required) return 0 ;;
        *) return 1 ;;
    esac
}

# Print what is wrong with a failed run: job, step, error lines, and the URL.
report_failure() {
    local repo="$1" run_id="$2" run_url="$3"
    echo ""
    echo "RED: $run_url"
    local jobs
    jobs=$(gh run view "$run_id" --repo "$repo" --json jobs 2>/dev/null) || jobs='{"jobs":[]}'
    echo "$jobs" | jq -r '.jobs[] | select(.conclusion=="failure" or .conclusion=="cancelled" or .conclusion=="timed_out") | "\(.databaseId)\t\(.name)\t\(.url)"' |
        while IFS=$'\t' read -r job_id job_name job_url; do
            local step
            step=$(echo "$jobs" | jq -r --arg id "$job_id" '.jobs[] | select((.databaseId|tostring)==$id) | [.steps[] | select(.conclusion=="failure")][0].name // "unknown step"')
            echo "  job:  $job_name"
            echo "  step: $step"
            local log
            log=$(gh api "repos/$repo/actions/jobs/$job_id/logs" 2>/dev/null) || log=""
            if [ -n "$log" ]; then
                echo "  errors (last lines matching error/fail):"
                echo "$log" | sed -E 's/^[0-9T:.Z-]+ //' |
                    grep -E '##\[error\]|Error:|error TS|✘|FAIL |Expected|Received|failed' |
                    grep -v 'Node.js 20 is deprecated' | tail -n 15 | cut -c1-240 | sed 's/^/    /'
            else
                echo "  (no log available yet; check the job page)"
            fi
            echo "  link: $job_url"
        done
}

START=$SECONDS
echo "Watching CI every ${INTERVAL}s:"
for i in "${!LABELS[@]}"; do
    echo "  ${LABELS[$i]} ${SHAS[$i]:0:8}"
done

while true; do
    all_done=1
    echo ""
    echo "[$(date +%H:%M:%S)] elapsed $(((SECONDS - START) / 60))m"

    for i in "${!LABELS[@]}"; do
        label="${LABELS[$i]}"
        repo="${REPOS[$i]}"
        sha="${SHAS[$i]}"

        runs=$(gh run list --repo "$repo" --commit "$sha" --limit 30 \
            --json databaseId,workflowName,status,conclusion,url,event 2>/dev/null) || runs="[]"
        runs=$(echo "$runs" | jq '[.[] | select(.event=="push")]')
        count=$(echo "$runs" | jq 'length')

        if [ "$count" -eq 0 ]; then
            echo "  $label: no CI run for ${sha:0:8} yet"
            all_done=0
            if [ $((SECONDS - START)) -gt "$NO_RUN_GRACE" ]; then
                echo "Error: $label has no CI run after $((NO_RUN_GRACE / 60)) minutes."
                echo "Check: https://github.com/$repo/actions"
                exit 2
            fi
            continue
        fi

        while IFS=$'\t' read -r run_id name status conclusion url; do
            jobs=$(gh run view "$run_id" --repo "$repo" --json jobs 2>/dev/null) || jobs='{"jobs":[]}'
            summary=$(echo "$jobs" | jq -r '[.jobs[] | (if .status=="completed" then .conclusion else .status end)] | group_by(.) | map("\(length) \(.[0])") | join(", ")')
            echo "  $label / $name: $status${conclusion:+ ($conclusion)}${summary:+ [$summary]}"

            job_red=$(echo "$jobs" | jq '[.jobs[] | select(.conclusion=="failure" or .conclusion=="timed_out")] | length')
            if is_red "$conclusion" || [ "${job_red:-0}" -gt 0 ]; then
                report_failure "$repo" "$run_id" "$url"
                exit 1
            fi
            [ "$status" != "completed" ] && all_done=0
        done < <(echo "$runs" | jq -r '.[] | [.databaseId, .workflowName, .status, (.conclusion // ""), .url] | @tsv')
    done

    if [ "$all_done" -eq 1 ]; then
        echo ""
        echo "GREEN: all CI runs succeeded."
        exit 0
    fi

    if [ $((SECONDS - START)) -gt "$TIMEOUT" ]; then
        echo "Error: still running after $((TIMEOUT / 60)) minutes. Check GitHub."
        exit 2
    fi
    sleep "$INTERVAL"
done
