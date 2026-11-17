#!/bin/bash

# Print the release text for a production tag from RELEASES.txt: the lines
# under "# <tag>" up to the next "# " heading, without leading and trailing
# blank lines. Exits 1 when the tag has no section or the section is empty.
# Usage: scripts/release-text.sh v1.2.3 [RELEASES.txt]

set -euo pipefail

TAG="${1:?Usage: scripts/release-text.sh <tag> [file]}"
FILE="${2:-RELEASES.txt}"

if [ ! -f "$FILE" ]; then
    echo "Error: $FILE not found" >&2
    exit 1
fi

TEXT=$(awk -v tag="# $TAG" '
    /^# / { if (found) exit; if ($0 == tag) { found = 1; next } }
    found { print }
' "$FILE" | sed -e '/./,$!d')

if [ -z "${TEXT//[[:space:]]/}" ]; then
    echo "Error: $FILE has no text under '# $TAG'" >&2
    exit 1
fi
printf '%s\n' "$TEXT"
