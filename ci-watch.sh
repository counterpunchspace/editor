#!/bin/bash

# Watch GitHub CI for pushed commits with a live overview that redraws in place
# every 5 seconds, until everything is green or something is red.
#
# Exit 0: every run for every commit succeeded.
# Exit 1: a run or job failed (failed job, step and error lines are printed).
# Exit 2: gave up waiting (no CI run appeared, or the 3 hour limit passed).
#
# Usage: ./ci-watch.sh                     # HEAD of collab, website and editor
#        ./ci-watch.sh <dir>[:<sha>] ...   # specific repos (sha defaults to HEAD)
# Env:   CI_WATCH_INTERVAL (seconds, default 5), CI_WATCH_TIMEOUT (default 10800)

set -uo pipefail

EDITOR_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="$(cd "$EDITOR_DIR/.." && pwd)"
INTERVAL="${CI_WATCH_INTERVAL:-5}"
TIMEOUT="${CI_WATCH_TIMEOUT:-10800}"
NO_RUN_GRACE=600

for tool in gh jq; do
    command -v "$tool" >/dev/null 2>&1 || { echo "Error: $tool is required"; exit 2; }
done

# Colors and in-place redraw only on a terminal.
if [ -t 1 ]; then
    TTY=1
    RESET=$'\033[0m'; BOLD=$'\033[1m'; DIM=$'\033[2m'
    GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; GRAY=$'\033[90m'; CYAN=$'\033[36m'
else
    TTY=0
    RESET=""; BOLD=""; DIM=""; GREEN=""; RED=""; YELLOW=""; GRAY=""; CYAN=""
fi
COLS=$(tput cols 2>/dev/null || echo 100)
[ "$COLS" -gt 120 ] && COLS=120

ARGS=("$@")
if [ "${#ARGS[@]}" -eq 0 ]; then
    ARGS=("$WORKSPACE/collab/collab" "$WORKSPACE/website" "$EDITOR_DIR")
fi

DIRS=(); LABELS=(); REPOS=(); SHAS=(); MSGS=()
for arg in "${ARGS[@]}"; do
    dir="${arg%%:*}"
    sha=""
    [ "$arg" != "$dir" ] && sha="${arg#*:}"
    [ -z "$sha" ] && sha=$(git -C "$dir" rev-parse HEAD)
    repo=$(cd "$dir" && gh repo view --json nameWithOwner --jq .nameWithOwner)
    DIRS+=("$dir")
    LABELS+=("$(basename "$repo")")
    REPOS+=("$repo")
    SHAS+=("$sha")
    MSGS+=("$(git -C "$dir" log -1 --format=%s "$sha" 2>/dev/null)")
done

cleanup() { [ "$TTY" -eq 1 ] && printf '\033[?25h'; }
trap cleanup EXIT
[ "$TTY" -eq 1 ] && printf '\033[?25l'

icon() {
    case "$1" in
        success) printf '%s✓%s' "$GREEN" "$RESET" ;;
        failure|timed_out|startup_failure) printf '%s✗%s' "$RED" "$RESET" ;;
        cancelled) printf '%s⊘%s' "$GRAY" "$RESET" ;;
        skipped|neutral) printf '%s–%s' "$GRAY" "$RESET" ;;
        running|in_progress) printf '%s●%s' "$YELLOW" "$RESET" ;;
        *) printf '%s○%s' "$GRAY" "$RESET" ;;
    esac
}

# Pad or cut plain text to a width.
fit() { printf '%-*.*s' "$2" "$2" "$1"; }

# Normalize GitHub status+conclusion to one state word.
STATE_JQ='(if .status=="completed" then (.conclusion // "unknown") elif .status=="in_progress" then "running" else "queued" end)'
DUR_JQ='def dur: (if . == null or . < 0 then "" elif . >= 3600 then "\(. / 3600 | floor)h \((. % 3600) / 60 | floor)m" elif . >= 60 then "\(. / 60 | floor)m \(. % 60 | floor)s" else "\(. | floor)s" end);'

PREV_LINES=0
START=$SECONDS
RUN_URLS=()
DONE_STREAK=0

print_urls() {
    [ "${#RUN_URLS[@]}" -gt 0 ] || return 0
    echo
    echo "${BOLD}Runs${RESET}"
    local u
    for u in "${RUN_URLS[@]}"; do echo "  ${CYAN}$u${RESET}"; done
}

report_failure() {
    local repo="$1" run_id="$2" run_url="$3"
    local jobs
    jobs=$(gh run view "$run_id" --repo "$repo" --json jobs 2>/dev/null) || jobs='{"jobs":[]}'
    echo ""
    echo "${RED}${BOLD}RED${RESET} $run_url"
    echo "$jobs" | jq -r '.jobs[] | select(.conclusion=="failure" or .conclusion=="timed_out" or .conclusion=="cancelled") | "\(.databaseId)\t\(.name)\t\(.url)"' |
        while IFS=$'\t' read -r job_id job_name job_url; do
            local step
            step=$(echo "$jobs" | jq -r --arg id "$job_id" '.jobs[] | select((.databaseId|tostring)==$id) | [.steps[] | select(.conclusion=="failure")][0].name // "unknown step"')
            echo ""
            echo "  ${BOLD}job${RESET}   $job_name"
            echo "  ${BOLD}step${RESET}  $step"
            local log
            log=$(gh api "repos/$repo/actions/jobs/$job_id/logs" 2>/dev/null) || log=""
            if [ -n "$log" ]; then
                echo "  ${BOLD}errors${RESET}"
                echo "$log" | sed -E 's/^[0-9T:.Z-]+ //' |
                    grep -E '##\[error\]|Error:|error TS|✘|FAIL |Expected|Received|failed' |
                    grep -v 'Node.js 20 is deprecated' | tail -n 15 | cut -c1-200 | sed "s/^/    ${DIM}|${RESET} /"
            else
                echo "  ${DIM}(no log available yet; check the job page)${RESET}"
            fi
            echo "  ${BOLD}link${RESET}  ${CYAN}$job_url${RESET}"
        done
}

while true; do
    FRAME=()
    ALL_DONE=1
    RED_REPO=""; RED_RUN=""; RED_URL=""
    NO_RUN_REPO=""
    RUN_URLS=()

    FRAME+=("${BOLD}CI${RESET}  ${DIM}updated $(date +%H:%M:%S) · elapsed $(((SECONDS - START) / 60))m · every ${INTERVAL}s · Ctrl-C to stop${RESET}")
    FRAME+=("")

    for i in "${!LABELS[@]}"; do
        label="${LABELS[$i]}"; repo="${REPOS[$i]}"; sha="${SHAS[$i]}"; msg="${MSGS[$i]}"
        FRAME+=("${BOLD}${label}${RESET}  ${CYAN}${sha:0:7}${RESET}  $(fit "$msg" $((COLS - ${#label} - 14)) | sed 's/ *$//')")

        runs=$(gh run list --repo "$repo" --commit "$sha" --limit 30 \
            --json databaseId,workflowName,status,conclusion,url,event,createdAt,updatedAt 2>/dev/null) || runs="[]"
        runs=$(echo "$runs" | jq '[.[] | select(.event=="push")] | sort_by(.databaseId)')

        if [ "$(echo "$runs" | jq length)" -eq 0 ]; then
            FRAME+=("  $(icon queued) ${GRAY}waiting for a CI run to start...${RESET}")
            FRAME+=("")
            ALL_DONE=0
            NO_RUN_REPO="$label"
            continue
        fi

        while IFS=$'\t' read -r run_id name state dur url; do
            [ "$state" = "running" -o "$state" = "queued" ] && ALL_DONE=0
            RUN_URLS+=("$url")
            FRAME+=("  $(icon "$state") ${BOLD}$(fit "$name" 28)${RESET} ${GRAY}$(fit "$state" 12)${RESET} ${dur}")

            jobs=$(gh run view "$run_id" --repo "$repo" --json jobs 2>/dev/null) || jobs='{"jobs":[]}'
            total=$(echo "$jobs" | jq '.jobs | length')
            n=0
            while IFS=$'\t' read -r jstate jname jdur jstep; do
                n=$((n + 1))
                case "$jstate" in running|queued) ALL_DONE=0 ;; esac
                branch="├─"; [ "$n" -eq "$total" ] && branch="└─"
                detail=""
                [ -n "$jstep" ] && detail="  ${DIM}$jstep${RESET}"
                [ "$jstate" = "failure" ] && detail="  ${RED}$jstep${RESET}"
                FRAME+=("  ${GRAY}${branch}${RESET} $(icon "$jstate") $(fit "$jname" 30) ${GRAY}$(fit "$jdur" 8)${RESET}${detail}")
                if [ "$jstate" = "failure" -o "$jstate" = "timed_out" ] && [ -z "$RED_RUN" ]; then
                    RED_REPO="$repo"; RED_RUN="$run_id"; RED_URL="$url"
                fi
            done < <(echo "$jobs" | jq -r "$DUR_JQ"'
                .jobs[] | [
                  '"$STATE_JQ"',
                  .name,
                  ((if .startedAt then ((if .completedAt and .completedAt != "0001-01-01T00:00:00Z" then (.completedAt | fromdateiso8601) else now end) - (.startedAt | fromdateiso8601)) else null end) | dur),
                  (if .status=="in_progress" then ([.steps[] | select(.status=="in_progress")][0].name // "")
                   elif .conclusion=="failure" then ([.steps[] | select(.conclusion=="failure")][0].name // "")
                   else "" end)
                ] | @tsv')

            if [ "$state" = "failure" -o "$state" = "timed_out" -o "$state" = "cancelled" ] && [ -z "$RED_RUN" ]; then
                RED_REPO="$repo"; RED_RUN="$run_id"; RED_URL="$url"
            fi
        done < <(echo "$runs" | jq -r "$DUR_JQ"'
            .[] | [.databaseId, .workflowName, '"$STATE_JQ"',
              (((if .status=="completed" then (.updatedAt | fromdateiso8601) else now end) - (.createdAt | fromdateiso8601)) | dur),
              .url] | @tsv')
        FRAME+=("")
    done

    # Draw the frame in place.
    if [ "$TTY" -eq 1 ] && [ "$PREV_LINES" -gt 0 ]; then
        printf '\033[%dA\033[J' "$PREV_LINES"
    fi
    for line in "${FRAME[@]}"; do
        printf '%s\n' "$line"
    done
    PREV_LINES=${#FRAME[@]}

    if [ -n "$RED_RUN" ]; then
        report_failure "$RED_REPO" "$RED_RUN" "$RED_URL"
        print_urls
        exit 1
    fi

    if [ -n "$NO_RUN_REPO" ] && [ $((SECONDS - START)) -gt "$NO_RUN_GRACE" ]; then
        echo "${RED}Error:${RESET} $NO_RUN_REPO has no CI run after $((NO_RUN_GRACE / 60)) minutes."
        echo "Check: https://github.com/counterpunchspace/$NO_RUN_REPO/actions"
        print_urls
        exit 2
    fi

    # Green only counts after two consecutive complete polls, so runs or
    # jobs that appear late cannot be missed.
    if [ "$ALL_DONE" -eq 1 ]; then DONE_STREAK=$((DONE_STREAK + 1)); else DONE_STREAK=0; fi
    if [ "$DONE_STREAK" -ge 2 ]; then
        echo "${GREEN}${BOLD}GREEN${RESET} all CI runs succeeded."
        print_urls
        exit 0
    fi

    if [ $((SECONDS - START)) -gt "$TIMEOUT" ]; then
        echo "${RED}Error:${RESET} still running after $((TIMEOUT / 60)) minutes. Check GitHub."
        print_urls
        exit 2
    fi
    sleep "$INTERVAL"
done
