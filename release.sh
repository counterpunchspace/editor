#!/bin/bash

# Script to prepare a release
# Usage: ./release.sh <version-tag>
# Example: ./release.sh v1.2.3

set -e

if [ -z "$1" ]; then
    echo "Error: Version tag required"
    echo "Usage: ./release.sh <version-tag>"
    echo "Example: ./release.sh v1.2.3"
    exit 1
fi

VERSION_TAG="$1"
SERVICE_WORKER_FILE="webapp/coi-serviceworker.js"
CHANGELOG_FILE="CHANGELOG.md"
RELEASE_NOTES_FILE="release-notes.md"

# Validate version tag format (v followed by number)
if ! echo "$VERSION_TAG" | grep -qE '^v[0-9]+'; then
    echo "Error: Version tag must start with 'v' followed by a number (e.g., v1, v10, v1.2.3)"
    exit 1
fi

# Check if required files exist
if [ ! -f "$SERVICE_WORKER_FILE" ]; then
    echo "Error: $SERVICE_WORKER_FILE not found"
    exit 1
fi

if [ ! -f "$CHANGELOG_FILE" ]; then
    echo "Error: $CHANGELOG_FILE not found"
    exit 1
fi

echo "Preparing release $VERSION_TAG..."

# Update version in service worker
echo "Updating version in $SERVICE_WORKER_FILE..."
CURRENT_VERSION=$(grep "const VERSION = " "$SERVICE_WORKER_FILE" | sed -E "s/.*'([^']+)'.*/\1/")
echo "  Current version: $CURRENT_VERSION"
echo "  New version: $VERSION_TAG"

# Use sed to replace the VERSION constant
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    sed -i '' "s/const VERSION = '[^']*'/const VERSION = '$VERSION_TAG'/" "$SERVICE_WORKER_FILE"
else
    # Linux
    sed -i "s/const VERSION = '[^']*'/const VERSION = '$VERSION_TAG'/" "$SERVICE_WORKER_FILE"
fi

echo "✅ Version updated in $SERVICE_WORKER_FILE"

# Check if CHANGELOG already has this version (from previous failed attempt)
CHANGELOG_ALREADY_UPDATED=false
if grep -q "^# $VERSION_TAG" "$CHANGELOG_FILE"; then
    echo "Note: CHANGELOG already contains '# $VERSION_TAG' - will reuse existing release notes"
    CHANGELOG_ALREADY_UPDATED=true
    # Extract from the existing version section (not "# Unreleased")
    awk "/^# $VERSION_TAG/ {flag=1; next} /^# / {flag=0} flag {print}" "$CHANGELOG_FILE" > "$RELEASE_NOTES_FILE"
else
    # Extract from "# Unreleased" section (first time release)
    awk '/^# / {if (++count == 2) exit} count == 1 && !/^# / {print}' "$CHANGELOG_FILE" > "$RELEASE_NOTES_FILE"
fi

# Extract changelog section
echo "Extracting release notes from $CHANGELOG_FILE..."

# Trim leading/trailing whitespace
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    sed -i '' -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$RELEASE_NOTES_FILE"
else
    # Linux
    sed -i -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$RELEASE_NOTES_FILE"
fi

echo "✅ Release notes extracted to $RELEASE_NOTES_FILE"
echo ""
echo "Release notes content:"
echo "----------------------------------------"
cat "$RELEASE_NOTES_FILE"
echo "----------------------------------------"
echo ""

# Update CHANGELOG.md - replace "# Unreleased" with version tag
echo "Updating CHANGELOG.md..."
if [ "$CHANGELOG_ALREADY_UPDATED" = true ]; then
    echo "  CHANGELOG already has '# $VERSION_TAG' - skipping update"
    CHANGELOG_UPDATED=false
elif grep -q "^# Unreleased" "$CHANGELOG_FILE"; then
    echo "  Replacing '# Unreleased' with '# $VERSION_TAG'"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        sed -i '' "s/^# Unreleased/# $VERSION_TAG/" "$CHANGELOG_FILE"
    else
        # Linux
        sed -i "s/^# Unreleased/# $VERSION_TAG/" "$CHANGELOG_FILE"
    fi
    
    # Add new "# Unreleased" section at the top
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        sed -i '' '1s/^/# Unreleased\n\n- **Add items here** for the next release (Replace this comment)\n\n/' "$CHANGELOG_FILE"
    else
        # Linux
        sed -i '1s/^/# Unreleased\n\n- **Add items here** for the next release (Replace this comment)\n\n/' "$CHANGELOG_FILE"
    fi
    echo "✅ CHANGELOG.md updated"
    CHANGELOG_UPDATED=true
else
    echo "  Warning: '# Unreleased' not found - CHANGELOG may be in invalid format"
    CHANGELOG_UPDATED=false
fi
echo ""

# Check for uncommitted changes (other than the version update and changelog we just made)
if ! git diff --quiet --exit-code -- . ':!webapp/coi-serviceworker.js' ':!CHANGELOG.md'; then
    echo "Warning: You have uncommitted changes besides the version update."
    read -p "Do you want to continue and commit everything? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Release cancelled."
        # Revert version change
        git checkout -- "$SERVICE_WORKER_FILE"
        # Revert changelog only if we updated it
        if [ "$CHANGELOG_UPDATED" = true ]; then
            git checkout -- "$CHANGELOG_FILE"
        fi
        rm -f "$RELEASE_NOTES_FILE"
        exit 1
    fi
fi

# Check if tag already exists
if git rev-parse "$VERSION_TAG" >/dev/null 2>&1; then
    echo "Warning: Tag $VERSION_TAG already exists"
    read -p "Do you want to delete and recreate it? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Deleting local tag..."
        git tag -d "$VERSION_TAG"
        echo "Deleting remote tag..."
        git push origin ":refs/tags/$VERSION_TAG" 2>/dev/null || echo "Remote tag already deleted or doesn't exist"
        echo "✅ Tag deleted, will recreate"
    else
        echo "Release cancelled."
        # Revert version change
        git checkout -- "$SERVICE_WORKER_FILE"
        # Revert changelog only if we updated it
        if [ "$CHANGELOG_UPDATED" = true ]; then
            git checkout -- "$CHANGELOG_FILE"
        fi
        rm -f "$RELEASE_NOTES_FILE"
        exit 1
    fi
fi

# Commit the version change
echo ""
echo "Committing version update..."
git add "$SERVICE_WORKER_FILE"

# Only add CHANGELOG if we updated it (not already updated from previous attempt)
if [ "$CHANGELOG_UPDATED" = true ]; then
    git add "$CHANGELOG_FILE"
    git commit -m "Release $VERSION_TAG"
elif git diff --cached --quiet; then
    echo "  No changes to commit (files already up to date)"
else
    git commit -m "Release $VERSION_TAG (CHANGELOG already updated)"
fi

# Create and push tag
echo "Creating tag $VERSION_TAG..."
git tag "$VERSION_TAG"

echo ""
echo "Pushing to GitHub..."
git push origin main
git push origin "$VERSION_TAG" --force

echo ""
echo "✅ Release $VERSION_TAG complete!"
echo "🚀 GitHub Actions will now:"
echo "   - Wait for CI checks to pass"
echo "   - Create a GitHub Release with changelog"
echo "   - Deploy to GitHub Pages"
echo "   - Users will see update notification within 10 minutes"
echo ""
echo "View your release at: https://github.com/yanone/context/releases/tag/$VERSION_TAG"

# Clean up release notes file
rm -f "$RELEASE_NOTES_FILE"
