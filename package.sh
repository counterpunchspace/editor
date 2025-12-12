#!/bin/bash

# Script to update the version number in coi-serviceworker.js
# This forces cache invalidation for all users when deployed
# Usage: ./package.sh <version>
# Example: ./package.sh v0.1.1a

if [ -z "$1" ]; then
    echo "Error: Version required"
    echo "Usage: ./package.sh <version>"
    echo "Example: ./package.sh v0.1.1a"
    exit 1
fi

NEW_VERSION="$1"

# Validate version format (must start with 'v')
if ! echo "$NEW_VERSION" | grep -qE '^v'; then
    echo "Error: Version must start with 'v' (e.g., v0.1.1a)"
    exit 1
fi

SERVICE_WORKER_FILE="webapp/coi-serviceworker.js"

# Check if service worker file exists
if [ ! -f "$SERVICE_WORKER_FILE" ]; then
    echo "Error: $SERVICE_WORKER_FILE not found"
    exit 1
fi

# Extract current version
CURRENT_VERSION=$(grep "const VERSION = " "$SERVICE_WORKER_FILE" | sed -E "s/.*'([^']+)'.*/\1/")

if [ -z "$CURRENT_VERSION" ]; then
    echo "Error: Could not extract current version from $SERVICE_WORKER_FILE"
    exit 1
fi

echo "Current version: $CURRENT_VERSION"
echo "New version: $NEW_VERSION"

# Update the version in the service worker file
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    sed -i '' "s/const VERSION = '[^']*'/const VERSION = '$NEW_VERSION'/" "$SERVICE_WORKER_FILE"
else
    # Linux
    sed -i "s/const VERSION = '[^']*'/const VERSION = '$NEW_VERSION'/" "$SERVICE_WORKER_FILE"
fi

echo "✅ Version updated successfully in $SERVICE_WORKER_FILE"
echo ""
echo "Changes made:"
git diff "$SERVICE_WORKER_FILE" | grep "const VERSION"
