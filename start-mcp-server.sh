#!/bin/bash
# Start the MCP server for development monitoring
# This script starts the MCP server which captures console logs and runtime data
# from the webapp for AI-assisted debugging

set -e

cd "$(dirname "$0")/mcp-server"

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "Installing MCP server dependencies..."
    npm install
fi

# Check if build exists
if [ ! -d "build" ]; then
    echo "Building MCP server..."
    npm run build
fi

echo "Starting MCP server on ws://localhost:9876..."
echo "Connect your webapp with: cd webapp && npm run dev"
echo ""

npm run dev
