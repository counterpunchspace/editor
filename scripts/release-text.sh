#!/bin/bash

# Print the release text for a production tag from RELEASES.txt. A section
# is the lines under "# <tag>" up to the next "# " heading, without leading
# and trailing blank lines.
#
# The text of vX.Y.Z is its own section followed by every older section of
# vX.Y below it, in file order. A lone section prints as it is; several
# print each under its "# vX.Y.N" heading, so a patch release shows its own
# changes on top of the ones its minor release already had.
# Exits 1 when the tag has no section or its section is empty.
#
# --inherit prints the heading a patch release without a section of its own
# takes over: the newest section of the same minor release, older than the
# tag. release.sh renames it to the tag. Exits 1 when there is none.
#
# Usage: scripts/release-text.sh v1.2.3 [RELEASES.txt]
#        scripts/release-text.sh --inherit v1.2.3 [RELEASES.txt]

set -euo pipefail

MODE=text
if [ "${1:-}" = "--inherit" ]; then
    MODE=inherit
    shift
fi
TAG="${1:?Usage: scripts/release-text.sh [--inherit] <tag> [file]}"
FILE="${2:-RELEASES.txt}"

if [ ! -f "$FILE" ]; then
    echo "Error: $FILE not found" >&2
    exit 1
fi
if ! [[ "$TAG" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "Error: $TAG does not look like v1.2.3" >&2
    exit 1
fi
MINOR="v${BASH_REMATCH[1]}.${BASH_REMATCH[2]}."
PATCH="${BASH_REMATCH[3]}"

if [ "$MODE" = "inherit" ]; then
    SOURCE=$(awk -v minor="$MINOR" -v patch="$PATCH" '
        /^# / {
            heading = substr($0, 3)
            if (index(heading, minor) == 1) {
                rest = substr(heading, length(minor) + 1)
                if (rest ~ /^[0-9]+$/ && rest + 0 < patch + 0) { print heading; exit }
            }
        }
    ' "$FILE")
    if [ -z "$SOURCE" ]; then
        echo "Error: $FILE has no section of ${MINOR}x older than $TAG" >&2
        exit 1
    fi
    printf '%s\n' "$SOURCE"
    exit 0
fi

# Sections are separated by the record separator byte: "heading\ntext\036".
SECTIONS=$(awk -v tag="$TAG" -v minor="$MINOR" -v patch="$PATCH" '
    function flush() {
        if (current != "") {
            sub(/^\n+/, "", body)
            sub(/\n+$/, "", body)
            printf "%s\n%s\036", current, body
        }
        current = ""
        body = ""
    }
    /^# / {
        flush()
        heading = substr($0, 3)
        if (heading == tag) { started = 1; current = heading; next }
        if (started && index(heading, minor) == 1) {
            rest = substr(heading, length(minor) + 1)
            if (rest ~ /^[0-9]+$/ && rest + 0 < patch + 0) current = heading
        }
        next
    }
    current != "" { body = body $0 "\n" }
    END { flush() }
' "$FILE")

FIRST="${SECTIONS%%$'\036'*}"
FIRST_TEXT="${FIRST#*$'\n'}"
if [ -z "$SECTIONS" ] || [ "${FIRST%%$'\n'*}" != "$TAG" ] || [ -z "${FIRST_TEXT//[[:space:]]/}" ]; then
    echo "Error: $FILE has no text under '# $TAG'" >&2
    exit 1
fi

COUNT=$(printf '%s' "$SECTIONS" | tr -cd '\036' | wc -c | tr -d ' ')
if [ "$COUNT" -eq 1 ]; then
    printf '%s\n' "$FIRST_TEXT"
    exit 0
fi

OUTPUT=""
REST="$SECTIONS"
while [ -n "$REST" ]; do
    SECTION="${REST%%$'\036'*}"
    REST="${REST#*$'\036'}"
    HEADING="${SECTION%%$'\n'*}"
    BODY="${SECTION#*$'\n'}"
    [ -n "${BODY//[[:space:]]/}" ] || continue
    [ -z "$OUTPUT" ] || OUTPUT+=$'\n\n'
    OUTPUT+="# $HEADING"$'\n\n'"$BODY"
done
printf '%s\n' "$OUTPUT"
