#!/bin/bash
# Regenerate babelfont.d.ts from babelfont-rs
#
# This script extracts TypeScript type definitions from the official babelfont-ts
# package maintained within the babelfont-rs repository.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBAPP_DIR="$SCRIPT_DIR/webapp"
OUTPUT_FILE="$WEBAPP_DIR/js/babelfont.d.ts"
PIN_FILE="$SCRIPT_DIR/.babelfont-rs-ref"
DEFAULT_REPO_URL="https://github.com/simoncozens/babelfont-rs.git"

echo "🔄 Regenerating TypeScript definitions from babelfont-ts"
echo "========================================================="
echo ""

echo "📋 Step 1/3: Resolving local babelfont-rs clone..."
DEFAULT_LOCAL_BABELFONT_RS_DIR="$SCRIPT_DIR/../babelfont-rs"
BABELFONT_RS_DIR="${BABELFONT_RS_DIR:-$DEFAULT_LOCAL_BABELFONT_RS_DIR}"
TEMP_DIR=""
PINNED_REPO_URL=""
PINNED_COMMIT=""
USE_PINNED_CHECKOUT="false"

cleanup() {
    if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
        rm -rf "$TEMP_DIR"
    fi
}
trap cleanup EXIT

if [ -f "$PIN_FILE" ]; then
    PINNED_REPO_URL=$(grep '^repo=' "$PIN_FILE" | tail -1 | cut -d'=' -f2-)
    PINNED_COMMIT=$(grep '^commit=' "$PIN_FILE" | tail -1 | cut -d'=' -f2-)

    if [ -z "$PINNED_COMMIT" ]; then
        PINNED_COMMIT=$(tr -d '[:space:]' < "$PIN_FILE")
    fi

    if [ -z "$PINNED_REPO_URL" ]; then
        PINNED_REPO_URL="$DEFAULT_REPO_URL"
    fi
fi

if [ -d "$BABELFONT_RS_DIR/.git" ]; then
    LOCAL_COMMIT_FULL=$(git -C "$BABELFONT_RS_DIR" rev-parse HEAD)
    LOCAL_COMMIT_SHORT=$(git -C "$BABELFONT_RS_DIR" rev-parse --short HEAD)
    LOCAL_REPO_URL=$(git -C "$BABELFONT_RS_DIR" remote get-url origin 2>/dev/null || true)

    if [ -n "$PINNED_COMMIT" ] && [ "$LOCAL_COMMIT_FULL" != "$PINNED_COMMIT" ]; then
        USE_PINNED_CHECKOUT="true"
        echo "ℹ️  Local clone commit $LOCAL_COMMIT_SHORT does not match pinned commit ${PINNED_COMMIT:0:7}; using pinned checkout"
    fi

    if [ "$USE_PINNED_CHECKOUT" = "false" ] && [ -n "$PINNED_REPO_URL" ] && [ -n "$LOCAL_REPO_URL" ] && [ "$LOCAL_REPO_URL" != "$PINNED_REPO_URL" ]; then
        USE_PINNED_CHECKOUT="true"
        echo "ℹ️  Local clone repo $LOCAL_REPO_URL does not match pinned repo $PINNED_REPO_URL; using pinned checkout"
    fi

    if [ "$USE_PINNED_CHECKOUT" = "false" ]; then
        COMMIT="$LOCAL_COMMIT_SHORT"
        echo "✅ Using local babelfont-rs at $BABELFONT_RS_DIR@$COMMIT"
    fi
else
    USE_PINNED_CHECKOUT="true"
    if [ ! -f "$PIN_FILE" ]; then
        echo "❌ No local babelfont-rs clone found and no pin file at $PIN_FILE"
        echo "   Either clone babelfont-rs next to this repo, or add a pinned commit SHA to $PIN_FILE"
        exit 1
    fi
fi

if [ "$USE_PINNED_CHECKOUT" = "true" ]; then
    if [ -z "$PINNED_COMMIT" ]; then
        echo "❌ Pin file is empty: $PIN_FILE"
        exit 1
    fi

    if [ -z "$PINNED_REPO_URL" ]; then
        PINNED_REPO_URL="$DEFAULT_REPO_URL"
    fi

    echo "⬇️  Cloning pinned babelfont-rs from $PINNED_REPO_URL@$PINNED_COMMIT..."
    TEMP_DIR=$(mktemp -d)
    BABELFONT_RS_DIR="$TEMP_DIR/babelfont-rs"
    git clone --quiet "$PINNED_REPO_URL" "$BABELFONT_RS_DIR"
    if ! git -C "$BABELFONT_RS_DIR" checkout --quiet "$PINNED_COMMIT"; then
        echo "❌ Failed to checkout pinned commit $PINNED_COMMIT from $PIN_FILE"
        exit 1
    fi
    COMMIT=$(git -C "$BABELFONT_RS_DIR" rev-parse --short HEAD)
    echo "✅ Using pinned babelfont-rs at $BABELFONT_RS_DIR@$COMMIT"
fi
echo ""

# Extract types from babelfont-ts/src/underlying.ts
echo "⚙️  Step 2/3: Extracting TypeScript definitions from babelfont-ts..."
UNDERLYING_FILE="$BABELFONT_RS_DIR/babelfont-ts/src/underlying.ts"

if [ ! -f "$UNDERLYING_FILE" ]; then
    echo "❌ underlying.ts not found at $UNDERLYING_FILE"
    cd "$SCRIPT_DIR"
    exit 1
fi

# Copy underlying.ts and convert to .d.ts format
# Replace imports with simple types and wrap in Babelfont namespace
{
    echo "// AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY."
    echo "// Update regenerate-types.sh or companion extension types instead."
    echo "//"
    echo "// Type definitions for babelfont"
    echo "// Project: https://github.com/simoncozens/babelfont-rs"
    echo "// Definitions extracted from babelfont-ts@$COMMIT"
    echo ""
    echo "export namespace Babelfont {"
    
    # Process underlying.ts:
    # - Remove imports
    # - Preserve upstream interfaces for declaration merging in babelfont-extensions.d.ts
    # - Preserve fonttypes branded coordinate types
    # - Fix Shape type to match actual serde serialization format
    # - Keep everything else as-is
    sed '/^import /d' "$UNDERLYING_FILE" | \
    sed '/^\/\*$/,/^\*\/$/d' | \
    sed 's/^export interface /    export interface /g' | \
    sed 's/^export enum /    export enum /g' | \
    sed 's/^export type /    export type /g' | \
    sed 's/^}/    }/g' | \
    awk 'NF || !f{f=NF; print}' | \
    # Shape is serde(untagged) - babelfont-rs outputs Component | Path (unwrapped)
    # TypeScript types should match actual output format
    cat
    
    # LayerType uses serde(tag="type", content="master") - typeshare generates correctly
    
    echo "}"
} > "$OUTPUT_FILE"

echo "✅ Generated TypeScript definitions"
echo ""

echo "📝 Step 3/3: Installing new type definitions..."

# Apply compatibility patches used in this codebase
echo "🔧 Applying compatibility patches..."
# Make DecomposedAffine fields optional (babelfont-rs outputs them with defaults)
perl -i -pe '
    $in_decomposed = 1 if /^    export (type|interface) DecomposedAffine(?: =)? \{/;
    if ($in_decomposed) {
        s/translation: \[number, number\];/translation?: [number, number];/;
        s/scale: \[number, number\];/scale?: [number, number];/;
        s/rotation: number;/rotation?: number;/;
        s/skew: \[number, number\];/skew?: [number, number];/;
    }
    $in_decomposed = 0 if $in_decomposed && /^    \}/;
' "$OUTPUT_FILE"
# Glyph cloud identity is editor-owned; babelfont-rs typeshare does not emit it.
perl -i -pe '
    $in_glyph = 1 if /^    export interface Glyph \{/;
    if ($in_glyph && /format_specific\?: Record<string, any>;/ && !$added_glyph_id) {
        $_ .= "        /** Immutable cloud/CRDT glyph id */\n        id?: string;\n";
        $added_glyph_id = 1;
    }
    $in_glyph = 0 if $in_glyph && /^    \}/;
' "$OUTPUT_FILE"
# Format with prettier
echo "🎨 Formatting with prettier..."
cd "$WEBAPP_DIR"
npx prettier --write "js/babelfont.d.ts"

cd "$SCRIPT_DIR"

echo "✅ Type definitions regenerated successfully!"
echo ""
echo "File: $OUTPUT_FILE"
echo "From: babelfont-rs at $BABELFONT_RS_DIR@$COMMIT (babelfont-ts/src/underlying.ts)"
echo ""
echo "Next steps:"
echo "  1. Review changes: git diff webapp/js/babelfont.d.ts"
echo "  2. Update babelfont-model.ts to match new types if needed"
echo "  3. Run TypeScript check: cd webapp && npx tsc --noEmit"
echo ""
